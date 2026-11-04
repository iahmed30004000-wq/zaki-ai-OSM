import type { Prisma } from '@prisma/client';
import { db } from './db';
import { canonicalPhone, phoneKeys, phoneKeysAnyStore } from './phone-rules';
import { CONFIRMATION_STATUS_AR, NO_ANSWER_RESULTS } from './confirmation-workflow';
import {
  OPEN_CONFIRMATION,
  PULL_TRANSACTION_OPTIONS,
  capRefusal,
  capRoom,
  ownedCounts,
  type QueueScope,
} from './confirmation-queue';
import { heldFor, notHeldForOthersWhere, reservedMessage } from './order-reservation';
import { holdTwinsForPuller, lockCustomerForPull } from './twins-follow-the-pull';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الزبون على الخط» — THE CUSTOMER CALLED BACK, AND THE AGENT WHO PICKED UP MAY TAKE HIS ORDER (the owner, 4/11).
 *
 * An agent rang a customer, nobody answered, and the order went back to the shared pool (a no-answer round let it go, or she gave
 * it back). Then the customer rang the company back. The agent who picked up could not take his order: she is bound by
 * `mustHoldToWork`, the claim-by-number door answers her `USE_THE_PULL`, and the pull never targets one order. So the customer was
 * told «رح نرجعلك» while his order sat in the pool.
 *
 * ── WHAT SHE MAY TAKE THIS WAY, AND NOTHING ELSE ──
 *
 * An order that is a RELEASED RETRY: nobody holds it, it is still at the confirmation desk (`OPEN_CONFIRMATION`), it was never
 * shipped (NOT_READY, no batch, no tracking number, no label), it is not held for a colleague (`notHeldForOthersWhere`), it carries
 * at least one no-answer (`NO_ANSWER_RESULTS`), and nobody has REACHED the customer since it last went back to the pool. Every
 * other case keeps today's rule:
 *
 *   · a brand-new order nobody rang yet is the pull's (the 1/11 rule stands: she never picks the good ones out of the pool);
 *   · an order a colleague holds is hers — «الطلب مع <name>», and no take;
 *   · a decided, cancelled or shipped order is not at the desk any more (a cancelled one: a new order, or «الاسترجاع»);
 *   · the 300 cap binds (`capRefusal`), exactly as at the pull.
 *
 * It works whether «نظام الجولات» is on or off: what matters is that the order is a released retry, not which release made it one.
 *
 * ── THE WRITE IS THE PULL'S ──
 *
 * The same claim fields (`claimedById`, `claimedAt`, `currentOwnerId`, IN_PROGRESS), under the same customer lock
 * (`lockCustomerForPull`) and the same conditional `updateMany`, and his other waiting orders follow her (`holdTwinsForPuller`).
 * The claim history says how she got it: `CUSTOMER_CALLED_BACK`, named in Arabic on the order's timeline.
 *
 * ── NO CALL IS RECORDED FOR HER ──
 *
 * Every result in `CONTACT_RESULTS` is a result of a call WE made: `ANSWERED` is what the answer rate counts as «our call was
 * picked up» (`no-answer-watch.ts`, `outcomeOf`), and an inbound call filed under it would raise that rate with calls nobody
 * dialled. None fits «he rang us», so nothing extra is written: the order already carries its attempts (the contact-first rule
 * is met), and she records what the customer said the ordinary way — «تأكيد», «تأجيل», «ألغِ». The take itself is on the
 * timeline.
 *
 * ── THE SEARCH IS NARROW ON PURPOSE ──
 *
 * A whole number, matched exactly on the stored forms (`phoneKeys`), never a prefix; at most `CALLBACK_SEARCH_LIMIT` orders; inside
 * her own `orders.view` envelope; and the cards carry no name, phone or address — the order number, the product, the governorate,
 * the status and who holds it. The route counts her searches (`CALLBACK_SEARCHES_PER_WINDOW`).
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The claim history's reason for a take of this kind. The timeline names it (`order-timeline.ts`). */
export const CUSTOMER_CALLED_BACK_REASON = 'CUSTOMER_CALLED_BACK';

/** At most this many orders for one number. */
export const CALLBACK_SEARCH_LIMIT = 10;
/** Searches one person may make in one window — enough for a morning of callbacks, too few to walk a phone book. */
export const CALLBACK_SEARCHES_PER_WINDOW = 20;
export const CALLBACK_SEARCH_WINDOW_MS = 10 * 60_000;
/** Fewer digits than this is not a phone number — and a short one would match too much. */
export const CALLBACK_MIN_DIGITS = 7;

/** The results that mean somebody spoke to the customer. Anything else (no answer, a wrong number, a dialler opened, a message) did not. */
export const REACHED_RESULTS = ['ANSWERED', 'CALLBACK_REQUESTED', 'CONFIRMED', 'REJECTED'] as const;

export type CallbackCode =
  | 'ALREADY_YOURS'
  | 'HELD_BY_COLLEAGUE'
  | 'CLOSED'
  | 'RESERVED_FOR_COLLEAGUE'
  | 'NEVER_CALLED'
  | 'REACHED_SINCE_RELEASE';

export type CallbackVerdict = { ok: true } | { ok: false; code: CallbackCode; message: string };

export const CALLBACK_MESSAGES = {
  ALREADY_YOURS: 'الطلب بإيدك أصلاً — افتحيه وكمّلي مع الزبون',
  NEVER_CALLED: 'هالطلب ما حدا اتصل فيه لسا — بيوصل بالسحب «اسحب الطلب التالي»، مش على الخط',
  REACHED_SINCE_RELEASE: 'في حدا حكى مع الزبون بعد ما رجع الطلب للطابور — ما بينسحب على الخط، بيوصل بالسحب',
  NOT_FOUND: 'ما لقينا هالطلب بمتجرك',
  TAKEN_MEANWHILE: 'الطلب تغيّر هلأ — دوري على الرقم مرة تانية',
  PHONE_TOO_SHORT: `اكتبي رقم الزبون كامل (${CALLBACK_MIN_DIGITS} أرقام على الأقل)`,
  SEARCH_LIMIT: 'دورتي كتير بوقت قصير — استني شوي وجرّبي',
} as const;

export function heldByColleagueMessage(name?: string | null): string {
  return `الطلب مع ${name?.trim() || 'موظفة تانية'} — ما بتاخديه، حوّلي الزبون إلها أو للمشرفة`;
}

export function closedMessage(confirmationStatus: string, shipped: boolean): string {
  if (shipped) return 'الطلب طلع للشحن — ما بينسحب على الخط';
  if (confirmationStatus === 'CANCELLED') return 'الطلب ملغى — اعملي طلب جديد أو من «الاسترجاع»';
  const label = (CONFIRMATION_STATUS_AR as Record<string, string>)[confirmationStatus] ?? confirmationStatus;
  return `الطلب خلص من التأكيد (${label}) — ما بينسحب على الخط`;
}

/** What one order is, as far as this rule asks. */
export interface CallbackFacts {
  claimedById: string | null;
  claimerName?: string | null;
  confirmationStatus: string;
  shippingStatus: string;
  shippingBatchId?: string | null;
  trackingNumber?: string | null;
  labelPrintedAt?: Date | string | null;
  /** Whom it is held for right now (a returning customer's, a twin's) — `heldFor`'s answer, or null. */
  heldFor?: { id: string; name: string } | null;
  attempts: { result: string; createdAt: Date | string }[];
  /** When it last went back to the pool (the latest RELEASED in its claim history), or null. */
  lastReleasedAt?: Date | string | null;
}

export function neverShipped(f: Pick<CallbackFacts, 'shippingStatus' | 'shippingBatchId' | 'trackingNumber' | 'labelPrintedAt'>): boolean {
  return f.shippingStatus === 'NOT_READY' && !f.shippingBatchId && !f.trackingNumber && !f.labelPrintedAt;
}

/**
 * MAY SHE TAKE IT ON THE LINE? Pure: the search draws its button from this, and the take asks it again under the customer's lock.
 * The order of the questions is the order of what is true first: hers, a colleague's, past the desk, held, never rung, reached.
 */
export function callbackVerdict(userId: string, f: CallbackFacts): CallbackVerdict {
  if (f.claimedById === userId) return { ok: false, code: 'ALREADY_YOURS', message: CALLBACK_MESSAGES.ALREADY_YOURS };
  if (f.claimedById) return { ok: false, code: 'HELD_BY_COLLEAGUE', message: heldByColleagueMessage(f.claimerName) };
  const shipped = !neverShipped(f);
  if (shipped || !OPEN_CONFIRMATION.includes(f.confirmationStatus)) {
    return { ok: false, code: 'CLOSED', message: closedMessage(f.confirmationStatus, shipped) };
  }
  if (f.heldFor && f.heldFor.id !== userId) {
    return { ok: false, code: 'RESERVED_FOR_COLLEAGUE', message: reservedMessage(f.heldFor.name) };
  }
  const noAnswer = f.attempts.some((a) => (NO_ANSWER_RESULTS as readonly string[]).includes(a.result));
  if (!noAnswer) return { ok: false, code: 'NEVER_CALLED', message: CALLBACK_MESSAGES.NEVER_CALLED };
  const since = f.lastReleasedAt ? new Date(f.lastReleasedAt).getTime() : null;
  const reached = f.attempts.some(
    (a) =>
      (REACHED_RESULTS as readonly string[]).includes(a.result) && (since === null || new Date(a.createdAt).getTime() > since)
  );
  if (reached) return { ok: false, code: 'REACHED_SINCE_RELEASE', message: CALLBACK_MESSAGES.REACHED_SINCE_RELEASE };
  return { ok: true };
}

/**
 * The stored forms one typed number may have — the store's own reading and the company-wide one (`phoneKeys`), so «0966…»,
 * «+963 966…» and «٠٩٦٦…» find the same customer. Empty when it is too short to be a number.
 */
export function phoneSearchKeys(raw: string, countryCode?: string | null): string[] {
  const own = canonicalPhone(raw, countryCode);
  if (own.length < CALLBACK_MIN_DIGITS) return [];
  return [...new Set([...phoneKeys(own), ...phoneKeysAnyStore(raw)])].filter((k) => k.length >= CALLBACK_MIN_DIGITS);
}

/** What the take reads about an order — the facts above, and no customer field beyond his id (the lock's key). */
export const CALLBACK_FACTS_SELECT = {
  id: true,
  customerId: true,
  orderNumber: true,
  claimedById: true,
  claimer: { select: { name: true } },
  confirmationStatus: true,
  shippingStatus: true,
  shippingBatchId: true,
  trackingNumber: true,
  labelPrintedAt: true,
  assignedToId: true,
  assignedAt: true,
  assignee: { select: { id: true, name: true, status: true } },
  contactAttempts: { select: { result: true, createdAt: true } },
  claimHistory: { where: { action: 'RELEASED' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
  _count: { select: { claimHistory: true } },
} as const;

interface FactsRow {
  claimedById: string | null;
  claimer?: { name: string | null } | null;
  confirmationStatus: string;
  shippingStatus: string;
  shippingBatchId: string | null;
  trackingNumber: string | null;
  labelPrintedAt: Date | null;
  assignedToId: string | null;
  assignedAt: Date | null;
  assignee: { id: string; name: string; status?: string | null } | null;
  contactAttempts: { result: string; createdAt: Date }[];
  claimHistory: { createdAt: Date }[];
  _count: { claimHistory: number };
}

export function factsOf(row: FactsRow, now: Date): CallbackFacts {
  return {
    claimedById: row.claimedById,
    claimerName: row.claimer?.name ?? null,
    confirmationStatus: row.confirmationStatus,
    shippingStatus: row.shippingStatus,
    shippingBatchId: row.shippingBatchId,
    trackingNumber: row.trackingNumber,
    labelPrintedAt: row.labelPrintedAt,
    heldFor: heldFor(
      {
        claimedById: row.claimedById,
        confirmationStatus: row.confirmationStatus,
        assignedToId: row.assignedToId,
        assignedAt: row.assignedAt,
        everClaimed: row._count.claimHistory > 0,
        assignee: row.assignee,
      },
      now
    ),
    attempts: row.contactAttempts,
    lastReleasedAt: row.claimHistory[0]?.createdAt ?? null,
  };
}

export interface CallbackCard {
  id: string;
  orderNumber: string;
  product: string | null;
  governorate: string | null;
  status: string;
  /** «معك» · the colleague's name · «محجوز لـ…» · «بالطابور». */
  holder: string;
  takeable: boolean;
  code: CallbackCode | null;
  message: string | null;
}

/**
 * THE SEARCH. `visibility` is her `orders.view` envelope (`orderVisibilityWhere`), passed in so this file never widens it.
 * Returns null when the number is too short to search.
 */
export async function searchOnTheLine(
  tx: Tx,
  args: { scope: QueueScope; userId: string; phone: string; countryCode?: string | null; visibility: Record<string, unknown>; now?: Date }
): Promise<CallbackCard[] | null> {
  const keys = phoneSearchKeys(args.phone, args.countryCode);
  if (keys.length === 0) return null;
  const now = args.now ?? new Date();
  const rows = await tx.order.findMany({
    where: { ...args.scope, customer: { phone: { in: keys } }, AND: [onTheLineReadable(args.visibility, args.userId, now)] },
    orderBy: { createdAt: 'desc' },
    take: CALLBACK_SEARCH_LIMIT,
    select: {
      ...CALLBACK_FACTS_SELECT,
      region: { select: { name: true } },
      items: { select: { productName: true }, take: 3 },
    },
  });
  return rows.map((row) => {
    const facts = factsOf(row as unknown as FactsRow, now);
    const verdict = callbackVerdict(args.userId, facts);
    const items = (row as { items: { productName: string }[] }).items;
    const holder =
      facts.claimedById === args.userId
        ? 'معك'
        : facts.claimedById
          ? facts.claimerName || 'موظفة تانية'
          : facts.heldFor
            ? `محجوز لـ${facts.heldFor.name}`
            : 'بالطابور';
    return {
      id: row.id,
      orderNumber: row.orderNumber,
      product: items[0] ? `${items[0].productName}${items.length > 1 ? ` +${items.length - 1}` : ''}` : null,
      governorate: (row as { region?: { name: string } | null }).region?.name ?? null,
      status: neverShipped(facts)
        ? ((CONFIRMATION_STATUS_AR as Record<string, string>)[row.confirmationStatus] ?? row.confirmationStatus)
        : 'بالشحن',
      holder,
      takeable: verdict.ok,
      code: verdict.ok ? null : verdict.code,
      message: verdict.ok ? null : verdict.message,
    };
  });
}

/**
 * A RELEASED RETRY, as a database filter — every clause of the verdict a database can say. It is the write's own guard
 * (`callbackTakeWhere`) and, ORed with her `orders.view` envelope, what the search and the take may READ.
 *
 * WHY THE ENVELOPE IS WIDENED BY EXACTLY THIS (review of #197): the live agents hold `orders.view` at ASSIGNED, and that envelope
 * admits a pool order only while it is NEW and UNSIGNED (`orderVisibilityWhere`, rbac.ts). A round release and the ninety-minute
 * release leave the order IN_PROGRESS / NO_ANSWER — the very orders this feature is for — so the search found nothing and the take
 * answered NOT_FOUND. Widening by the predicate the write already demands shows her nothing she could not take, and the cards carry
 * no customer field.
 */
export function releasedRetryWhere(userId: string, now: Date) {
  return {
    claimedById: null,
    confirmationStatus: { in: OPEN_CONFIRMATION },
    shippingStatus: 'NOT_READY',
    shippingBatchId: null,
    trackingNumber: null,
    labelPrintedAt: null,
    contactAttempts: { some: { result: { in: [...NO_ANSWER_RESULTS] } } },
    AND: [notHeldForOthersWhere(userId, now)],
  };
}

/** The write's own guard: this order, and a released retry at the moment of the write. */
export function callbackTakeWhere(orderId: string, userId: string, now: Date) {
  return { id: orderId, ...releasedRetryWhere(userId, now) };
}

/** What she may read here: her own envelope, or a released retry she could take. */
export function onTheLineReadable(visibility: Record<string, unknown>, userId: string, now: Date) {
  return { OR: [visibility, releasedRetryWhere(userId, now)] };
}

export type TakeOutcome =
  | { ok: true; orderId: string; orderNumber: string; alreadyYours?: boolean }
  | { ok: false; code: CallbackCode | 'NOT_FOUND' | 'CAP_TOTAL' | 'TAKEN_MEANWHILE'; message: string; heldBy?: string | null };

/**
 * TAKE IT. One transaction: her envelope, the customer's lock, the verdict asked again, the cap, the guarded claim, the history,
 * and his other waiting orders — the pull's own steps, in the pull's own order (`pullNextOrder`).
 */
export async function takeOnTheLine(args: {
  scope: QueueScope;
  user: { id: string; role: string };
  orderId: string;
  visibility: Record<string, unknown>;
  now?: Date;
}): Promise<TakeOutcome> {
  const { scope, user, orderId } = args;
  const now = args.now ?? new Date();
  return db.$transaction(async (tx) => {
    const seen = await tx.order.findFirst({
      where: { id: orderId, ...scope, AND: [onTheLineReadable(args.visibility, user.id, now)] },
      select: { id: true, customerId: true },
    });
    if (!seen) return { ok: false, code: 'NOT_FOUND', message: CALLBACK_MESSAGES.NOT_FOUND };

    // ONE CUSTOMER, ONE AGENT: wait while a colleague is pulling one of his orders, then read what is true after her.
    if (seen.customerId) await lockCustomerForPull(tx, seen.customerId);

    const row = await tx.order.findFirst({ where: { id: orderId, ...scope }, select: CALLBACK_FACTS_SELECT });
    if (!row) return { ok: false, code: 'NOT_FOUND', message: CALLBACK_MESSAGES.NOT_FOUND };
    const verdict = callbackVerdict(user.id, factsOf(row as unknown as FactsRow, now));
    if (!verdict.ok) {
      if (verdict.code === 'ALREADY_YOURS') return { ok: true, orderId, orderNumber: row.orderNumber, alreadyYours: true };
      return {
        ok: false,
        code: verdict.code,
        message: verdict.message,
        ...(verdict.code === 'HELD_BY_COLLEAGUE' ? { heldBy: row.claimer?.name ?? null } : {}),
      };
    }

    const counts = await ownedCounts(tx, scope, user.id, now);
    const cap = capRefusal(counts, false);
    if (cap) return { ok: false, code: 'CAP_TOTAL', message: cap.message };

    const taken = await tx.order.updateMany({
      where: { ...callbackTakeWhere(orderId, user.id, now), ...scope },
      data: {
        claimedById: user.id,
        claimedAt: now,
        currentOwnerId: user.id,
        confirmationStatus: 'IN_PROGRESS',
        status: 'IN_PROGRESS',
        version: { increment: 1 },
      },
    });
    if (taken.count !== 1) {
      // A colleague (or a manager's press) got there between the read and the write: say who, if anybody holds it now.
      const fresh = await tx.order.findFirst({ where: { id: orderId }, select: { claimedById: true, claimer: { select: { name: true } } } });
      if (fresh?.claimedById && fresh.claimedById !== user.id) {
        return { ok: false, code: 'HELD_BY_COLLEAGUE', message: heldByColleagueMessage(fresh.claimer?.name), heldBy: fresh.claimer?.name ?? null };
      }
      return { ok: false, code: 'TAKEN_MEANWHILE', message: CALLBACK_MESSAGES.TAKEN_MEANWHILE };
    }

    await tx.orderClaimHistory.create({
      data: {
        companyId: scope.companyId,
        orderId,
        userId: user.id,
        action: 'CLAIMED',
        reason: CUSTOMER_CALLED_BACK_REASON,
        metadata: JSON.stringify({ role: user.role }),
      },
    });
    await tx.orderStatusLog.create({
      data: {
        companyId: scope.companyId,
        orderId,
        statusType: 'CONFIRMATION',
        previousValue: row.confirmationStatus,
        newValue: 'IN_PROGRESS',
        changedById: user.id,
        changedByRole: user.role,
        note: 'الزبون اتصل — أخدته على الخط',
      },
    });
    // His other waiting orders follow her, never past the cap: the room before this take, minus the one just taken from the pool.
    await holdTwinsForPuller(tx, {
      scope,
      customerId: seen.customerId,
      pulled: { id: orderId, orderNumber: row.orderNumber },
      agentId: user.id,
      room: capRoom(counts) - 1,
      now,
    });
    return { ok: true, orderId, orderNumber: row.orderNumber };
  }, PULL_TRANSACTION_OPTIONS);
}
