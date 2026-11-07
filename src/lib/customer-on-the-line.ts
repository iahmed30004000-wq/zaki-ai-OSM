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
import { RELEASE_NOTICE_LINK } from './auto-release';

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
 * 1. An order that is a RELEASED RETRY: nobody holds it, it is still at the confirmation desk (`OPEN_CONFIRMATION`), it was never
 * shipped (NOT_READY, no batch, no tracking number, no label), it is not held for a colleague (`notHeldForOthersWhere`), it carries
 * at least one no-answer (`NO_ANSWER_RESULTS`), and nobody has REACHED the customer since it last went back to the pool.
 *
 * 2. (the owner, 7/11) An order a COLLEAGUE PULLED AND HAS NOT STARTED ON. The order went back to the pool after a «لا يرد», another
 * agent pulled it, and the customer rang the FIRST agent: she could not find it (a colleague's order is outside the live agents'
 * `orders.view` envelope) and, once found, could not take it. She may now, when all of this is true:
 *
 *   · another agent holds it, and NO contact attempt of ANY kind by ANYBODY was logged at or after that agent's `claimedAt` — not a
 *     call, not a message, not a no-answer, not even `OPENED` (the dialler pressed): she pulled it and has done nothing on it. An
 *     attempt exactly AT `claimedAt` counts as started (`>=`);
 *   · it is still at the desk, never shipped, and carries at least one no-answer — so a brand-new order nobody rang stays the pull's;
 *   · the cap and the customer's lock bind as for any take (below). Where nobody can say WHEN the colleague pulled it (`claimedAt`
 *     empty), nobody can say she has done nothing since: it stays with her.
 *
 * Every other case keeps today's rule:
 *
 *   · a brand-new order nobody rang yet is the pull's (the 1/11 rule stands: she never picks the good ones out of the pool);
 *   · an order a colleague holds and HAS STARTED ON stays hers — «الطلب مع <name> وهي بدأت عليه», and no take;
 *   · a decided, cancelled or shipped order is not at the desk any more (a cancelled one: a new order, or «الاسترجاع»);
 *   · the 300 cap binds (`capRefusal`), exactly as at the pull.
 *
 * It works whether «نظام الجولات» is on or off: what matters is that the order is a released retry (or a colleague's untouched pull
 * of one), not which release made it one.
 *
 * ── THE WRITE IS THE PULL'S ──
 *
 * The same claim fields (`claimedById`, `claimedAt`, `currentOwnerId`, IN_PROGRESS), under the same customer lock
 * (`lockCustomerForPull`) and the same conditional `updateMany`, and his other waiting orders follow her (`holdTwinsForPuller`).
 * The claim history says how she got it: `CUSTOMER_CALLED_BACK`, named in Arabic on the order's timeline.
 *
 * TAKEN FROM A COLLEAGUE, the one write is guarded on the claim she READ — the holder, that holder's `claimedAt` (equality: the
 * optimistic guard), still open, never shipped, and `contactAttempts: none since claimedAt` — so a colleague who re-pulled it, an
 * attempt logged between the read and the write, a third agent's claim or a shipment each leave the order where it was and say so
 * (`TAKEN_MEANWHILE`, or «الطلب مع <name>»). It writes, in the same transaction: a `RELEASED` line for the colleague
 * (`TAKEN_ON_THE_LINE`, `{ automatic: false, takenBy }` — nobody released it, and the timeline says who took it), the `CLAIMED`
 * line for her (`CUSTOMER_CALLED_BACK`, with `fromUserId`), the status-log note naming the colleague, and ONE notification to the
 * colleague. And the claim she takes from must be the one she SAW before she waited at the customer's lock: if it changed hands
 * meanwhile, nothing is taken (two agents pressing at once: the first takes it, the second is told who has it).
 *
 * THE ORDER IS HANDED OVER WHOLE, as the transfer door hands one over (review of #216): the same update writes her name on it
 * (`assignedToId`, `assignedAt` — the colleague's name would keep it in her ASSIGNED envelope) and clears the editing lock the
 * colleague held (`lockedById`, `lockedAt`, `lockExpiresAt` — else the confirmation door answers the taker 423 `ORDER_LOCKED`); and
 * the customer's other NEW orders held for the colleague are let go the way `releaseByRounds` lets a holder's go, so that
 * `holdTwinsForPuller` holds them for the taker inside her cap room. All of it in the one transaction. An order out of the pool
 * has none of that to hand over, and its write is the pull's, field for field.
 *
 * WHAT THE WORDS MAY SAY: the system knows what is LOGGED, not what was dialled. Every sentence here says «ما سجّلت عليه شي»
 * (nothing is logged on it), never that she did not call — a call nobody logged, or her own no-answer before a re-pull, would make
 * that false.
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
 * her own `orders.view` envelope OR an unanswered order still at the desk, whoever holds it (`unansweredAtTheDeskWhere`); and the
 * cards carry no name, phone or address — the order number, the product, the governorate, the status and who holds it. The route
 * counts her searches (`CALLBACK_SEARCHES_PER_WINDOW`).
 *
 * WHY WIDENING THE READ FOR THIS ONE DOOR IS SAFE (7/11): what she is shown beyond her envelope is a card of an order whose customer's
 * EXACT NUMBER she is holding the line with (seven digits at least, a prefix finds nothing), at most ten of them, twenty searches
 * every ten minutes, and each card is the order number, the product, the governorate, the status and a colleague's name — the first
 * four she would read on the pull's own card and the name she already reads on «الطلب مع <name>». Nothing of the customer — no name,
 * no phone, no address — is selected, so none can be returned. The WRITE is not widened by this: `callbackTakeWhere` is exactly
 * what it was, and a colleague's order is written only through `callbackTakeFromColleagueWhere`, which asks for more, not less.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The claim history's reason for a take of this kind. The timeline names it (`order-timeline.ts`). */
export const CUSTOMER_CALLED_BACK_REASON = 'CUSTOMER_CALLED_BACK';
/**
 * The RELEASED line a take from a colleague writes for the one it was taken FROM: her `userId` (the column cannot be empty), this
 * reason, and `{ automatic: false, takenBy }` in the metadata — nobody released it, and the timeline names who took it.
 */
export const TAKEN_ON_THE_LINE_REASON = 'TAKEN_ON_THE_LINE';

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

/** The colleague an order is taken from: who holds it, and since when (the claim the take is guarded on). */
export interface TakenFrom {
  id: string;
  name: string | null;
  claimedAt: Date;
}

/** `fromColleague` is set only when a colleague holds the order and has done nothing on it: the take is theirs to lose. */
export type CallbackVerdict = { ok: true; fromColleague?: TakenFrom } | { ok: false; code: CallbackCode; message: string };

export const CALLBACK_MESSAGES = {
  ALREADY_YOURS: 'الطلب بإيدك أصلاً — افتحيه وكمّلي مع الزبون',
  NEVER_CALLED: 'هالطلب ما حدا اتصل فيه لسا — بيوصل بالسحب «اسحب الطلب التالي»، مش على الخط',
  COLLEAGUE_NEVER_CALLED: 'هالطلب ما حدا اتصل فيه لسا — بيضل معها، مش على الخط',
  REACHED_SINCE_RELEASE: 'في حدا حكى مع الزبون بعد ما رجع الطلب للطابور — ما بينسحب على الخط، بيوصل بالسحب',
  NOT_FOUND: 'ما لقينا هالطلب بمتجرك',
  TAKEN_MEANWHILE: 'الطلب تغيّر هلأ — دوري على الرقم مرة تانية',
  PHONE_TOO_SHORT: `اكتبي رقم الزبون كامل (${CALLBACK_MIN_DIGITS} أرقام على الأقل)`,
  SEARCH_LIMIT: 'دورتي كتير بوقت قصير — استني شوي وجرّبي',
} as const;

/** The colleague's name as the cards and sentences print it — «موظفة تانية» when the account has none. */
function colleagueWord(name?: string | null): string {
  return name?.trim() || 'موظفة تانية';
}

/** A colleague holds it, and the sentence says no more than that (nobody can say whether she has started). */
export function heldByColleagueMessage(name?: string | null): string {
  return `الطلب مع ${colleagueWord(name)} — ما بتاخديه، حوّلي الزبون إلها أو للمشرفة`;
}

/** A colleague holds it and HAS started on it: something was logged on it since she pulled it. */
export function colleagueStartedMessage(name?: string | null): string {
  return `الطلب مع ${colleagueWord(name)} وهي بدأت عليه — حوّلي الزبون إلها أو للمشرفة`;
}

/**
 * A colleague holds it and NOTHING IS LOGGED on it since she pulled it, but the take is refused all the same — `why` is the sentence
 * that says for what. It says what the system KNOWS («ما سجّلت عليه شي»), never that she did not call: a call nobody logged, or her own
 * earlier no-answer before she pulled it again, would make that a lie (review of #216).
 */
export function colleagueNotStartedMessage(name: string | null | undefined, why: string): string {
  return `الطلب مع ${colleagueWord(name)} ولسا ما سجّلت عليه شي. ${why}`;
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
  /** When the holder pulled it — what "since she pulled it" is counted from. Empty when nobody recorded it. */
  claimedAt?: Date | string | null;
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

const hasNoAnswer = (attempts: CallbackFacts['attempts']): boolean =>
  attempts.some((a) => (NO_ANSWER_RESULTS as readonly string[]).includes(a.result));

/**
 * A COLLEAGUE HOLDS IT (the owner, 7/11): hers to lose only if she pulled it and has done NOTHING on it. Every refusal here is
 * `HELD_BY_COLLEAGUE` and says which of the two it is — «وهي بدأت عليه», or «ولسا ما سجّلت عليه شي» with what else stops the take.
 * "Started" is any attempt AT or after her `claimedAt` — a call, a message, a no-answer, an answer, a dialler opened — by anybody.
 */
function colleagueVerdict(holderId: string, f: CallbackFacts): CallbackVerdict {
  const refuse = (message: string): CallbackVerdict => ({ ok: false, code: 'HELD_BY_COLLEAGUE', message });
  const claimedAt = f.claimedAt ? new Date(f.claimedAt) : null;
  // Nobody can say she has done nothing since a moment nobody recorded: it stays with her.
  if (!claimedAt || Number.isNaN(claimedAt.getTime())) return refuse(heldByColleagueMessage(f.claimerName));
  if (f.attempts.some((a) => new Date(a.createdAt).getTime() >= claimedAt.getTime())) {
    return refuse(colleagueStartedMessage(f.claimerName));
  }
  const shipped = !neverShipped(f);
  if (shipped || !OPEN_CONFIRMATION.includes(f.confirmationStatus)) {
    return refuse(colleagueNotStartedMessage(f.claimerName, closedMessage(f.confirmationStatus, shipped)));
  }
  if (!hasNoAnswer(f.attempts)) {
    return refuse(colleagueNotStartedMessage(f.claimerName, CALLBACK_MESSAGES.COLLEAGUE_NEVER_CALLED));
  }
  return { ok: true, fromColleague: { id: holderId, name: f.claimerName ?? null, claimedAt } };
}

/**
 * MAY SHE TAKE IT ON THE LINE? Pure: the search draws its button from this, and the take asks it again under the customer's lock.
 * The order of the questions is the order of what is true first: hers, a colleague's, past the desk, held, never rung, reached.
 */
export function callbackVerdict(userId: string, f: CallbackFacts): CallbackVerdict {
  if (f.claimedById === userId) return { ok: false, code: 'ALREADY_YOURS', message: CALLBACK_MESSAGES.ALREADY_YOURS };
  if (f.claimedById) return colleagueVerdict(f.claimedById, f);
  const shipped = !neverShipped(f);
  if (shipped || !OPEN_CONFIRMATION.includes(f.confirmationStatus)) {
    return { ok: false, code: 'CLOSED', message: closedMessage(f.confirmationStatus, shipped) };
  }
  if (f.heldFor && f.heldFor.id !== userId) {
    return { ok: false, code: 'RESERVED_FOR_COLLEAGUE', message: reservedMessage(f.heldFor.name) };
  }
  if (!hasNoAnswer(f.attempts)) return { ok: false, code: 'NEVER_CALLED', message: CALLBACK_MESSAGES.NEVER_CALLED };
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
  // When the holder pulled it: the moment "has she started?" is counted from (and the write's optimistic guard).
  claimedAt: true,
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
  claimedAt: Date | null;
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
    claimedAt: row.claimedAt,
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
  /**
   * The colleague she would take it FROM, by name — set only on a card that is takeable while a colleague holds it
   * («عند X ولسا ما سجّلت عليه شي — بتنسحب منها»). A name already on the card as `holder`; no new fact about the customer.
   */
  fromColleague: string | null;
  code: CallbackCode | null;
  message: string | null;
}

/**
 * THE SEARCH. `visibility` is her `orders.view` envelope (`orderVisibilityWhere`), passed in so this file never narrows it; it is
 * ORed with `unansweredAtTheDeskWhere` (see there for why that is safe). Returns null when the number is too short to search.
 */
export async function searchOnTheLine(
  tx: Tx,
  args: { scope: QueueScope; userId: string; phone: string; countryCode?: string | null; visibility: Record<string, unknown>; now?: Date }
): Promise<CallbackCard[] | null> {
  const keys = phoneSearchKeys(args.phone, args.countryCode);
  if (keys.length === 0) return null;
  const now = args.now ?? new Date();
  const rows = await tx.order.findMany({
    where: { ...args.scope, customer: { phone: { in: keys } }, AND: [onTheLineReadable(args.visibility)] },
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
          ? colleagueWord(facts.claimerName)
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
      fromColleague: verdict.ok && verdict.fromColleague ? colleagueWord(verdict.fromColleague.name) : null,
      code: verdict.ok ? null : verdict.code,
      message: verdict.ok ? null : verdict.message,
    };
  });
}

/** Still at the confirmation desk, and never shipped — the clauses of a take that say nothing about attempts or about who holds it. */
function openAndNeverShippedWhere() {
  return {
    confirmationStatus: { in: OPEN_CONFIRMATION },
    shippingStatus: 'NOT_READY',
    shippingBatchId: null,
    trackingNumber: null,
    labelPrintedAt: null,
  };
}

/** At least one attempt where nobody was reached (`NO_ANSWER_RESULTS`) — the evidence that somebody rang and the customer is calling back. */
const someNoAnswerWhere = () => ({ contactAttempts: { some: { result: { in: [...NO_ANSWER_RESULTS] } } } });

/**
 * AN UNANSWERED ORDER STILL AT THE DESK, whoever holds it or nobody — what the search and the take may READ beyond her envelope
 * (the owner, 7/11). At the desk (`OPEN_CONFIRMATION`), never shipped, and at least one no-answer on it.
 *
 * WHY THE ENVELOPE IS WIDENED BY THIS (review of #197, then 7/11): the live agents hold `orders.view` at ASSIGNED, and that envelope
 * admits a pool order only while it is NEW and UNSIGNED, and a colleague's order not at all (`orderVisibilityWhere`, rbac.ts). A round
 * release and the ninety-minute release leave the order IN_PROGRESS / NO_ANSWER; and once a colleague pulls it, the customer who rings
 * the FIRST agent finds nothing — the search answered nobody, as if he had no order.
 *
 * WHY THAT IS SAFE FOR THIS DOOR, AND ONLY THIS DOOR: she reads an order only through the EXACT number of its customer, which she is
 * holding the line with (seven digits at least, never a prefix), at most ten cards, twenty searches every ten minutes; and a card is
 * the order number, the product, the governorate, the status and the holder's name — no customer field is selected, so none can be
 * returned. `orderVisibilityWhere` and every other door's envelope stay as they were (the pull's `GET /api/orders/:id` still 404s a
 * colleague's order), and the WRITE is not widened (`callbackTakeWhere` / `callbackTakeFromColleagueWhere` below).
 */
export function unansweredAtTheDeskWhere() {
  return { ...openAndNeverShippedWhere(), ...someNoAnswerWhere() };
}

/**
 * A RELEASED RETRY, as a database filter — every clause of the verdict a database can say. It is the write's own guard
 * (`callbackTakeWhere`) and the unheld half of `unansweredAtTheDeskWhere`: nobody holds it, and it is not held for a colleague.
 */
export function releasedRetryWhere(userId: string, now: Date) {
  return {
    claimedById: null,
    ...unansweredAtTheDeskWhere(),
    AND: [notHeldForOthersWhere(userId, now)],
  };
}

/** The write's own guard: this order, and a released retry at the moment of the write. Strict — the colleague's write has its own. */
export function callbackTakeWhere(orderId: string, userId: string, now: Date) {
  return { id: orderId, ...releasedRetryWhere(userId, now) };
}

/**
 * THE WRITE'S GUARD WHEN A COLLEAGUE HOLDS IT — the claim she READ, and nothing since. This order; held by THAT colleague (`holder.id`)
 * since THAT moment (`claimedAt` equality: a colleague who let it go and pulled it again has made a new claim, and this is not it);
 * still at the desk and never shipped; and no contact attempt of any kind at or after `claimedAt` (`gte`: one logged in the same
 * instant is a start), so an attempt that lands between her read and her write is not overwritten. The no-answer it needs is asked
 * again as well: the verdict said so, and a write that does not repeat what it was granted for is a guess.
 */
export function callbackTakeFromColleagueWhere(orderId: string, holder: { id: string; claimedAt: Date }) {
  return {
    id: orderId,
    claimedById: holder.id,
    claimedAt: holder.claimedAt,
    ...openAndNeverShippedWhere(),
    contactAttempts: { none: { createdAt: { gte: holder.claimedAt } } },
    AND: [someNoAnswerWhere()],
  };
}

/** What she may read here: her own envelope, or an unanswered order at the desk (see `unansweredAtTheDeskWhere`). */
export function onTheLineReadable(visibility: Record<string, unknown>) {
  return { OR: [visibility, unansweredAtTheDeskWhere()] };
}

/** The one notification the colleague gets when an order is taken from her — the shape of the release notice (`auto-release.ts`). */
export function takenFromYouNotice(v: { companyId: string; storeId: string; holderId: string; orderNumber: string }) {
  return {
    companyId: v.companyId,
    storeId: v.storeId,
    userId: v.holderId,
    title: `انسحب ${v.orderNumber} منك`,
    // What the system knows, not what she did: nothing was logged on it since she pulled it (a call nobody logged would make
    // "you had not called" a lie).
    message: `الطلب ${v.orderNumber} انسحب منك: الزبون اتصل بزميلتك وما كنتِ سجّلتِ عليه شي`,
    type: 'SYSTEM_ALERT',
    link: RELEASE_NOTICE_LINK,
  };
}

/** The same instant, whatever the two are written as (a Date from the database, a stored timestamp). Two empty values are the same. */
function sameInstant(a: Date | string | null | undefined, b: Date | string | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return new Date(a).getTime() === new Date(b).getTime();
}

export type TakeOutcome =
  | { ok: true; orderId: string; orderNumber: string; alreadyYours?: boolean }
  | { ok: false; code: CallbackCode | 'NOT_FOUND' | 'CAP_TOTAL' | 'TAKEN_MEANWHILE'; message: string; heldBy?: string | null };

/**
 * TAKE IT. One transaction: her envelope, the customer's lock, the verdict asked again, the cap, the guarded claim, the history,
 * and his other waiting orders — the pull's own steps, in the pull's own order (`pullNextOrder`).
 *
 * Taken from a colleague (the owner, 7/11), the same steps with three differences: the claim she takes from must be the one she saw
 * before she waited at the lock; the write is `callbackTakeFromColleagueWhere` (the claim she read, nothing logged since); and the
 * colleague gets a `RELEASED` line, a name in the status note and ONE notification, all in this transaction.
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
    // Who holds it, and since when, is read here too: a take from a colleague is a take of THAT claim (see below).
    const seen = await tx.order.findFirst({
      where: { id: orderId, ...scope, AND: [onTheLineReadable(args.visibility)] },
      select: { id: true, customerId: true, claimedById: true, claimedAt: true },
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

    /*
     * THE CLAIM SHE TAKES FROM IS THE ONE SHE SAW. Waiting at the customer's lock is waiting for a colleague's pull or take of him
     * to commit; what is read after it may be somebody else's claim, or the same colleague's claim made again. Taking from THAT
     * would be taking from whoever happened to hold it last: two agents pressing at once on the same order would pass it back and
     * forth, the second taking from the first before the first had said a word. So: the claim moved since the first read ⇒ nothing
     * is taken. A different holder is named (as the pull names the one who beat it); the same colleague's new claim is «look again».
     */
    const from = verdict.fromColleague ?? null;
    if (from && (seen.claimedById !== row.claimedById || !sameInstant(seen.claimedAt, row.claimedAt))) {
      if (seen.claimedById === row.claimedById) return { ok: false, code: 'TAKEN_MEANWHILE', message: CALLBACK_MESSAGES.TAKEN_MEANWHILE };
      return { ok: false, code: 'HELD_BY_COLLEAGUE', message: heldByColleagueMessage(row.claimer?.name), heldBy: row.claimer?.name ?? null };
    }

    const counts = await ownedCounts(tx, scope, user.id, now);
    const cap = capRefusal(counts, false);
    if (cap) return { ok: false, code: 'CAP_TOTAL', message: cap.message };

    const taken = await tx.order.updateMany({
      where: { ...(from ? callbackTakeFromColleagueWhere(orderId, from) : callbackTakeWhere(orderId, user.id, now)), ...scope },
      data: {
        claimedById: user.id,
        claimedAt: now,
        currentOwnerId: user.id,
        confirmationStatus: 'IN_PROGRESS',
        status: 'IN_PROGRESS',
        version: { increment: 1 },
        /*
         * FROM A COLLEAGUE THE ORDER IS HANDED OVER WHOLE, as the transfer door hands one over (review of #216): it carries HER name
         * now (`assignedToId` — the colleague's name on it kept it in her ASSIGNED envelope, so she could still open an order that
         * is no longer hers), and the editing lock the colleague held goes with her (while it stands the confirmation door answers
         * the taker 423 `ORDER_LOCKED`, and the colleague's open form keeps renewing it). An order out of the pool has neither.
         */
        ...(from ? { assignedToId: user.id, assignedAt: now, lockedById: null, lockedAt: null, lockExpiresAt: null } : {}),
      },
    });
    if (taken.count !== 1) {
      // A colleague (or a manager's press) got there between the read and the write: say who, if anybody holds it now.
      if (from) {
        const fresh = await tx.order.findFirst({ where: { id: orderId, ...scope }, select: CALLBACK_FACTS_SELECT });
        if (fresh?.claimedById && fresh.claimedById !== user.id) {
          // The colleague I meant to take it from pulled it again: that is not the claim I read — look again.
          if (fresh.claimedById === from.id && !sameInstant(fresh.claimedAt, from.claimedAt)) {
            return { ok: false, code: 'TAKEN_MEANWHILE', message: CALLBACK_MESSAGES.TAKEN_MEANWHILE };
          }
          // The same claim and a write that missed (she has started since I read, or it left the desk), or another agent's claim:
          // the sentence that is true now, and her name.
          const again = callbackVerdict(user.id, factsOf(fresh as unknown as FactsRow, now));
          const name = fresh.claimer?.name ?? null;
          return { ok: false, code: 'HELD_BY_COLLEAGUE', message: again.ok ? heldByColleagueMessage(name) : again.message, heldBy: name };
        }
        return { ok: false, code: 'TAKEN_MEANWHILE', message: CALLBACK_MESSAGES.TAKEN_MEANWHILE };
      }
      const fresh = await tx.order.findFirst({ where: { id: orderId }, select: { claimedById: true, claimer: { select: { name: true } } } });
      if (fresh?.claimedById && fresh.claimedById !== user.id) {
        return { ok: false, code: 'HELD_BY_COLLEAGUE', message: heldByColleagueMessage(fresh.claimer?.name), heldBy: fresh.claimer?.name ?? null };
      }
      return { ok: false, code: 'TAKEN_MEANWHILE', message: CALLBACK_MESSAGES.TAKEN_MEANWHILE };
    }

    if (from) {
      // The colleague's side of the same moment: nobody released it, and the line says who took it (`order-timeline.ts` reads both).
      await tx.orderClaimHistory.create({
        data: {
          companyId: scope.companyId,
          orderId,
          userId: from.id,
          action: 'RELEASED',
          reason: TAKEN_ON_THE_LINE_REASON,
          metadata: JSON.stringify({ automatic: false, takenBy: user.id }),
        },
      });
    }
    await tx.orderClaimHistory.create({
      data: {
        companyId: scope.companyId,
        orderId,
        userId: user.id,
        action: 'CLAIMED',
        reason: CUSTOMER_CALLED_BACK_REASON,
        metadata: JSON.stringify({ role: user.role, ...(from ? { fromUserId: from.id } : {}) }),
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
        note: from ? `الزبون اتصل — أخدته على الخط من ${colleagueWord(from.name)}` : 'الزبون اتصل — أخدته على الخط',
      },
    });
    // She is told in the same transaction: a take that is rolled back tells nobody, and one that commits is never silent.
    if (from) {
      await tx.notification.create({
        data: takenFromYouNotice({ companyId: scope.companyId, storeId: scope.storeId, holderId: from.id, orderNumber: row.orderNumber }),
      });
      /*
       * HIS OTHER ORDERS HELD FOR HER GO BACK, so that the next step holds them for the taker — one customer, one agent. The pull
       * holds only unnamed twins (`twinsToHoldWhere`: `assignedToId` empty), and the customer who sent his order twice has exactly
       * that: a NEW twin named for the colleague. The same write `releaseByRounds` makes when it lets a holder's order go, bounded
       * the same way (his, NEW, never claimed, never shipped, named for HER and nobody else). Held again inside the taker's cap room.
       */
      if (seen.customerId) {
        await tx.order.updateMany({
          where: {
            companyId: scope.companyId,
            storeId: scope.storeId,
            customerId: seen.customerId,
            id: { not: orderId },
            claimedById: null,
            confirmationStatus: 'NEW',
            shippingStatus: 'NOT_READY',
            claimHistory: { none: {} },
            assignedToId: from.id,
          },
          data: { assignedToId: null, assignedAt: null, version: { increment: 1 } },
        });
      }
    }
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
