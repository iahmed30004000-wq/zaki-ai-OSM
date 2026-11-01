import type { Prisma } from '@prisma/client';
import { db } from './db';
import { businessMinutesBetween, type BusinessCalendar } from './business-calendar';
import { rejectionNeedsConversation } from './confirmation-workflow';
import { notHeldForOthersWhere, reservedForOthersWhere, reservedForWhere } from './order-reservation';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * CONFIRMATION QUEUE — agents never see a list, they pull the next order.
 *
 * Priority: postponed orders due within the lead days first, then the oldest
 * waiting order. An agent cannot pull while holding an order they have not
 * tried to contact yet, and a claim with no attempt is auto-released after
 * 90 BUSINESS minutes (frozen outside work hours and on weekends).
 */

/** Caps from the contract. */
export const CLAIM_CAPS = { withoutAttempt: 40, total: 300 } as const;
/** A claim with zero logged attempts expires after this many business minutes. */
export const AUTO_RELEASE_BUSINESS_MINUTES = 90;
/** How far ahead a postponed order becomes actionable. */
export const POSTPONE_LEAD_DAYS = 2;

/**
 * ════════════════════════════════════════════════════════════════════════
 * AN ORDER AN AGENT TYPES IS HERS FROM THE MOMENT SHE TYPES IT.
 *
 * Every staff-created order went into the pull queue as an unclaimed NEW
 * order — including one an agent had just taken over the phone, with the
 * customer still on the line. She then had to pull it back out, and could
 * draw somebody else's instead; meanwhile a colleague could pull hers and
 * ring a customer who had already given their order.
 *
 * ── WHO, BY PERMISSION AND NEVER BY ROLE NAME ──
 *
 * Whoever works a queue and does not supervise one: `confirmation.work`
 * without `confirmation.supervise`. A custom role is judged by what it
 * holds, which is the whole point of the permission engine — a company
 * that builds its own «موظف تأكيد» under another name gets this too, and
 * a supervisor who happens to hold `confirmation.work` does not, because
 * her entries belong to whoever is free.
 *
 * ── AND THE CAP STILL BINDS ──
 *
 * 300 is the ceiling on what one person may hold. An entry that would
 * cross it goes to the queue instead, and the screen says so — silently
 * handing her a 121st order would make the cap a suggestion.
 * ════════════════════════════════════════════════════════════════════════
 */
export const MANUAL_ENTRY_REASON = 'MANUAL_ENTRY';

/** Said to the agent when her own entry had to go to the queue. */
export const ENTRY_CAP_FULL_MESSAGE = `وصلت للحد (${CLAIM_CAPS.total}) — الطلب راح للطابور`;

/** Does this account keep the orders it enters? */
export function keepsOwnEntry(holds: (permission: string) => boolean): boolean {
  return holds('confirmation.work') && !holds('confirmation.supervise');
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN AGENT WORKS ONLY THE ORDER SHE HOLDS (the owner, 1/11).
 *
 * Twenty orders were found confirmed by one agent straight from the orders list: she opened an order nobody held, rang, pressed
 * «تأكيد» — and it was recorded confirmed with NO holder: «لم يستلمه أحد بعد — متاح في الطابور» beside a confirmed status, and a
 * path that said the confirmation stage «لم يمر بها». The door asked only `orders.confirm`, and that key is scoped to the whole
 * company for the shipped agent, so "her order" was every order she could open.
 *
 * `confirmation.work` is «العمل على طلباتي» (see `heldOrderWhere` in rbac.ts: «an order nobody holds is reached by pulling it,
 * not by its id»). So for the account that works a queue and does not supervise one — `keepsOwnEntry`'s test, asked about a
 * different thing — every decision and every logged call goes through the order she HOLDS.
 *
 * NOT BOUND: whoever supervises (`confirmation.supervise`), and whoever holds a key to TAKE any order (`orders.unlock`, the override
 * of «استلمه أنا») or to GIVE any order away (`orders.assign`): binding them would gain nothing — they can take or hand over the order
 * in one press — and would cost a manager's day the moment she opened an order nobody had pulled. The owner holds every key.
 *
 * The pull stays what puts an order in her hands (`/api/confirmation/pull`, «طلباتي»); there is no «claim by id» for an agent.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function mustHoldToWork(holds: (permission: string) => boolean): boolean {
  return keepsOwnEntry(holds) && !holds('orders.unlock') && !holds('orders.assign');
}

/** Said by the door and by the screen, in the same words. */
export const NOT_HELD_MESSAGE = 'اسحب الطلب أولاً — لا يمكن العمل على طلب ليس بين يديك';

/**
 * Does the sheet owe this person «اسحبه أولاً» instead of the call and confirm buttons? An agent, on an order that is still waiting
 * to be decided and is not in her hands. Asked by the screen only so that it never draws a panel whose every press the door refuses
 * (`NOT_HELD`); the door asks `mustHoldToWork` itself and is the enforcement.
 */
export function agentMustPullFirst(args: {
  holds: (permission: string) => boolean;
  userId?: string | null;
  order: { claimedById?: string | null; confirmationStatus: string };
}): boolean {
  return mustHoldToWork(args.holds) && args.order.claimedById !== args.userId && OPEN_CONFIRMATION.includes(args.order.confirmationStatus);
}

export interface EntryOwnership {
  /** Null when the order goes to the pull queue, as every entry used to. */
  claimedById: string | null;
  claimedAt: Date | null;
  currentOwnerId: string | null;
  /** True only when it was HER entry that the cap pushed into the queue. */
  capFull: boolean;
}

/**
 * Who owns an order at the moment it is entered.
 *
 * Pure: the caller supplies the permission test and how many the user
 * already holds, so the rule can be asked about every case without a
 * database — and so the two creation routes cannot answer it differently.
 */
export function entryOwnership(args: {
  userId: string;
  holds: (permission: string) => boolean;
  /** `ownedCounts(...).total`, read only when the rule needs it. */
  heldTotal: number;
  now: Date;
}): EntryOwnership {
  const unclaimed: EntryOwnership = {
    claimedById: null,
    claimedAt: null,
    currentOwnerId: null,
    capFull: false,
  };
  if (!keepsOwnEntry(args.holds)) return unclaimed;
  if (args.heldTotal >= CLAIM_CAPS.total) return { ...unclaimed, capFull: true };
  return {
    claimedById: args.userId,
    claimedAt: args.now,
    currentOwnerId: args.userId,
    capFull: false,
  };
}

/**
 * RECORD THE CLAIM AN ENTRY CREATED — ONE WRITER, BOTH DOORS.
 *
 * Called inside the transaction that writes the order, so an order can
 * never exist as hers with no row saying how she got it. The first version
 * of this lived inline in the quick-entry door, and the AI intake claimed
 * orders with no history at all — which is the shape of every rule in this
 * file that has ever been half-applied.
 *
 * `MANUAL_ENTRY` tells it apart from a pull: the auto-release, the caps and
 * the transfer screen all read this history, and «she typed it» is a
 * different fact from «she drew it from the queue».
 *
 * Does nothing when the entry went to the queue — there is no claim to
 * record.
 */
export async function recordEntryClaim(
  tx: Tx,
  args: { companyId: string; orderId: string; ownership: EntryOwnership }
): Promise<void> {
  if (!args.ownership.claimedById) return;
  await tx.orderClaimHistory.create({
    data: {
      companyId: args.companyId,
      orderId: args.orderId,
      userId: args.ownership.claimedById,
      action: 'CLAIMED',
      reason: MANUAL_ENTRY_REASON,
    },
  });
}

/** Statuses that still belong to the confirmation stage. */
export const OPEN_CONFIRMATION = ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'];

export interface QueueScope {
  companyId: string;
  storeId: string;
}

export interface OwnedCounts {
  total: number;
  withoutAttempt: number;
  /**
   * THE ORDER THE REFUSAL IS ABOUT.
   *
   * «سجّل محاولة اتصال على طلبك الحالي قبل سحب طلب جديد» named no order and
   * linked nowhere, and the agent could not reach the one it meant: a
   * postponed claim is hidden from «طلباتي» until its date, and «الطلبات
   * المؤجلة» listed it with no contact buttons. The order was held, unusable
   * and unreachable, and the only way out was the ninety-business-minute
   * release. So the count carries the order with it, and the refusal opens it.
   *
   * The oldest first: it is the one that has been stuck longest, and it is
   * the one the auto-release will take away first.
   */
  /* Optional so the pure refusal rules can still be tested with a bare
     count literal — `ownedCounts` always supplies it. */
  untouched?: { id: string; orderNumber: string } | null;
}

/**
 * HELD BY SOMEBODY, AND NOBODY HAS TRIED TO RING THE CUSTOMER YET.
 *
 * This is the predicate the pull gate refuses on — see `pullRefusal` and
 * `CONTACT_FIRST_MESSAGE`. It is lifted out of `ownedCounts` because the
 * palette's opening summary asks the SAME question twice over: an agent
 * asks it about her own desk, and an owner asks it about the store. Two
 * copies of this `where` would be two definitions of «بلا محاولة اتصال»,
 * and the one on the summary would be the one nobody tested.
 *
 * `holderId` absent means «whoever is holding it» — the store-wide
 * question. It is NOT «unclaimed»: an order nobody has taken has nobody
 * to chase, and `claimedById: { not: null }` says so.
 */
export function heldWithoutAttemptWhere(scope: QueueScope, holderId?: string) {
  return {
    ...scope,
    claimedById: holderId ?? { not: null },
    confirmationStatus: { in: OPEN_CONFIRMATION },
    contactAttempts: { none: {} },
  };
}

/** What this agent currently holds in the confirmation stage. */
export async function ownedCounts(tx: Tx, scope: QueueScope, userId: string): Promise<OwnedCounts> {
  const untouchedWhere = heldWithoutAttemptWhere(scope, userId);
  const [total, withoutAttempt, untouched] = await Promise.all([
    tx.order.count({
      where: { ...scope, claimedById: userId, confirmationStatus: { in: OPEN_CONFIRMATION } },
    }),
    tx.order.count({ where: untouchedWhere }),
    tx.order.findFirst({
      where: untouchedWhere,
      orderBy: { claimedAt: 'asc' },
      select: { id: true, orderNumber: true },
    }),
  ]);
  return { total, withoutAttempt, untouched: untouched ?? null };
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CONTACT COMES FIRST — AND IT IS THE HOLDER WHO IS BOUND.
 *
 * The owner's rule: the agent speaks to the customer before deciding
 * anything about their order. What happened instead was measured on this
 * installation — an agent pulled an order, pressed «تأجيل» without
 * contacting anybody, and then could not pull again, because the pull gate
 * counts held orders with no attempt. The order was postponed, so it was
 * hidden from his own list; the pull screen named no order; and nothing
 * released it for ninety business minutes. One press cost him an hour and a
 * half of work.
 *
 * Two halves of one rule, and this is the half the server keeps: deciding
 * on an order you HOLD requires having tried to reach the customer.
 *
 * ── WHY THE HOLDER AND NOT EVERYONE ──
 *
 * A supervisor cancelling a fake order, or the owner closing something from
 * a report, never pulled anything and is not working a queue — binding them
 * would be asking a manager to ring a customer before correcting a record.
 * The rule exists to stop an agent from disposing of orders without working
 * them, so it binds exactly the person the queue handed the order to.
 *
 * ── WHAT COUNTS AS AN ATTEMPT ──
 *
 * Any `OrderContactAttempt`: a call that was answered, a call that was not,
 * an SMS, a WhatsApp message. «لا يرد» counts — it is a real attempt and
 * three of them are already a documented outcome. The agent is not being
 * asked to succeed, only to try.
 * ═══════════════════════════════════════════════════════════════════════
 */
/*
 * AND `edit` JOINED THEM, because it was the way around all four.
 *
 * «افتح وعدّل» was open from the first second: an agent who had rung
 * nobody could open the order, change the quantity, the price or the
 * address, and save — while «تأكيد» and «تأجيل» and «ألغِ» were still
 * locked behind the same rule. The owner's words: it opens after a contact
 * attempt too.
 *
 * «رقم خطأ» unlocks it, as it unlocks the others: it IS an attempt, and it
 * is exactly the finding that most often makes an edit the right next
 * move.
 */
export const CONTACT_FIRST_ACTIONS = ['confirm', 'reject', 'cancel', 'schedule_follow_up', 'edit'] as const;
export type ContactFirstAction = (typeof CONTACT_FIRST_ACTIONS)[number];

export function needsContactFirst(args: {
  action: string;
  /** Does the person acting hold this order? */
  isHolder: boolean;
  /** Does the order carry at least one contact attempt? */
  hasAttempt: boolean;
  /**
   * Does this request SCHEDULE a follow-up — carries a `nextFollowUpAt`? (RV5)
   *
   * `contact_result` is the recording of the attempt itself, so on its own it is never bound. But the same action,
   * handed a date, ALSO postpones the order — and that is `schedule_follow_up` by another name, which hides the order
   * and keeps the claim. The screen always writes the attempt first (`ConfirmationActions.submitAction`), so an honest
   * caller is never stopped; a bare call to the API with a date and no attempt on the order was the way around.
   */
  schedulesFollowUp?: boolean;
  /**
   * The reason a `reject` carries. A closing for a reason that needs no word with the customer (a duplicate,
   * a wrong number, outside the service area) is not bound — see `NO_CONVERSATION_REJECTION_REASONS`.
   * Absent or unknown, `reject` stays bound exactly as before.
   */
  rejectionReason?: string | null;
}): boolean {
  if (!args.isHolder) return false;
  if (args.hasAttempt) return false;
  if (args.action === 'contact_result' && args.schedulesFollowUp === true) return true;
  if (args.action === 'reject' && !rejectionNeedsConversation(args.rejectionReason)) return false;
  return (CONTACT_FIRST_ACTIONS as readonly string[]).includes(args.action);
}

/** The one sentence the server and the screen both say. */
export const CONTACT_FIRST_MESSAGE = 'اتصل بالزبون أول — أو اكبس «لا يرد»';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * NO ORDER IS CONFIRMED WITHOUT ITS GOVERNORATE.
 *
 * The owner: «المفروض ما يسمح لموظفة التأكيد تأكّد غير لما تحدد المحافظة». Measured on this installation: an order
 * confirmed with no `regionId`, and the shipment screen answering «لم تُحدَّد المحافظة — لا يمكن حساب أجرة التوصيل».
 * The delivery fee, the late threshold and the courier's price list are all keyed on the governorate, so an order
 * without one cannot be priced or sent; `NO_REGION` caught it only when the shipment was created, days after the
 * agent had said yes. The question is asked where the yes is given.
 *
 * ── A DEFINITION OF «NO GOVERNORATE» THAT CANNOT BE FOOLED ──
 *
 * `regionId` and nothing else. `Customer.city` is free text a customer or a form typed — «سكاكة الجوف» is a town, not
 * a row in the fee table — so a written city never counts as a governorate.
 *
 * ── IT BINDS EVERYONE ──
 *
 * Unlike the contact-first rule, this is not about the person acting: a supervisor, a holder of `orders.unlock` and a
 * SUPER_ADMIN are all refused, because the missing governorate is a fact about the ORDER and the shipment screen
 * cannot price it whoever pressed the button. The only way through is to set the governorate.
 *
 * Asked ONLY about confirming. Rejecting, postponing, following up and cancelling never needed a fee.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function needsRegionFirst(order: { regionId?: string | null }): boolean {
  return typeof order.regionId !== 'string' || order.regionId.trim() === '';
}

/** The one sentence the server and the screen both say about it. */
export const REGION_REQUIRED_MESSAGE = 'حدّد المحافظة أولاً — أجرة التوصيل مبنية عليها ولا يُؤكَّد طلب بلا محافظة';

export type PullRefusal =
  | { code: 'NOT_YOUR_DESK'; message: string }
  /** Carries the order it is about, so the screen can open it. */
  | { code: 'UNTOUCHED_ORDER'; message: string; orderId: string | null; orderNumber: string | null }
  | { code: 'CAP_WITHOUT_ATTEMPT'; message: string }
  | { code: 'CAP_TOTAL'; message: string }
  | { code: 'QUEUE_EMPTY'; message: string };

/**
 * May this agent pull another order?
 *
 * The operational rule is the strict one: finish contacting what you hold
 * before taking more. The two caps are the absolute ceilings that also bound
 * bulk assignment paths.
 */
export function pullRefusal(counts: OwnedCounts): PullRefusal | null {
  if (counts.total >= CLAIM_CAPS.total) {
    return { code: 'CAP_TOTAL', message: `بلغت الحد الأقصى (${CLAIM_CAPS.total} طلب لديك).` };
  }
  if (counts.withoutAttempt >= CLAIM_CAPS.withoutAttempt) {
    return {
      code: 'CAP_WITHOUT_ATTEMPT',
      message: `لديك ${counts.withoutAttempt} طلباً بلا محاولة اتصال — الحد ${CLAIM_CAPS.withoutAttempt}.`,
    };
  }
  if (counts.withoutAttempt > 0) {
    /*
     * NAMED, AND REACHABLE. The message used to say «طلبك الحالي» and point
     * at nothing — see `OwnedCounts.untouched`. The id travels with the
     * refusal so the screen can open that order where its contact buttons
     * are, including when it is postponed and hidden from «طلباتي».
     */
    return {
      code: 'UNTOUCHED_ORDER',
      message: counts.untouched
        ? `سجّل محاولة اتصال على الطلب ${counts.untouched.orderNumber} قبل سحب طلب جديد.`
        : 'سجّل محاولة اتصال على طلبك الحالي قبل سحب طلب جديد.',
      orderId: counts.untouched?.id ?? null,
      orderNumber: counts.untouched?.orderNumber ?? null,
    };
  }
  return null;
}

/**
 * WHETHER THIS ACCOUNT MAY PULL AT ALL, BEFORE ASKING WHETHER IT MAY PULL NOW.
 *
 * `pullRefusal` answers the operational question — have you finished with
 * what you hold — and it is the whole answer for an agent. It is not the
 * whole answer for a supervisor.
 *
 * Measured on this database: COMPANY_ADMIN, MANAGER and CONFIRMATION_SUPERVISOR
 * hold `confirmation.supervise` and NOT `confirmation.pull` — three of the
 * nineteen accounts. All three reach `/confirmation/queue`, because the route
 * admits either key so a supervisor can watch the pool. The screen then drew
 * «اسحب الطلب التالي» enabled for them, on the strength of a `canPull` that
 * had only ever been asked about caps, and `POST /api/confirmation/pull`
 * answers `confirmation.pull` with a 403. A button whose every press is
 * refused is a broken button, and hiding it in the browser is not the fix
 * either: the server is the one that knows, so the server says so.
 *
 * Pure, and the authority refusal comes FIRST — telling a supervisor to
 * «سجّل محاولة اتصال» before pulling would be advice about a thing she is
 * never going to be allowed to do.
 */
export function pullPermission(mayPull: boolean, counts: OwnedCounts): PullRefusal | null {
  if (!mayPull) {
    return {
      code: 'NOT_YOUR_DESK',
      message: 'السحب من عمل موظّف التأكيد — هذه الشاشة للإشراف على الطابور لا للعمل عليه.',
    };
  }
  return pullRefusal(counts);
}

/**
 * Release claims that were never worked on. Runs before every pull so the
 * pool self-heals even before the scheduler stage ships.
 */
export async function releaseStaleClaims(tx: Tx, scope: QueueScope, cal: BusinessCalendar, now = new Date()) {
  const stale = await tx.order.findMany({
    where: {
      ...scope,
      claimedById: { not: null },
      confirmationStatus: { in: OPEN_CONFIRMATION },
      contactAttempts: { none: {} },
      claimedAt: { not: null },
    },
    select: { id: true, claimedAt: true, claimedById: true, companyId: true },
    take: 200,
  });

  const expired = stale.filter(
    (o) => businessMinutesBetween(new Date(o.claimedAt!), now, cal) >= AUTO_RELEASE_BUSINESS_MINUTES
  );
  for (const order of expired) {
    await tx.order.updateMany({
      where: { id: order.id, claimedById: order.claimedById },
      // `assignedAt: null` as well: an order she let go of unworked is the shared queue's, not held for her a second time.
      data: { claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null },
    });
    await tx.orderClaimHistory.create({
      data: {
        companyId: order.companyId,
        orderId: order.id,
        userId: order.claimedById!,
        action: 'RELEASED',
        reason: `AUTO_RELEASE_${AUTO_RELEASE_BUSINESS_MINUTES}_BUSINESS_MINUTES`,
      },
    });
  }
  return expired.length;
}

/** How many orders are waiting to be pulled (the agent's only queue number). */
export async function waitingCount(tx: Tx, scope: QueueScope, now = new Date(), forUserId?: string) {
  // Exactly the set `pickNextCandidate` draws from — see the note there.
  const [due, ready] = await Promise.all([
    tx.order.count({ where: duePostponedWhere(scope, now) }),
    tx.order.count({ where: readyToPullWhere(scope, forUserId, now) }),
  ]);
  return due + ready;
}

/**
 * THE ORDERS SHE CAN SEE AND CANNOT TAKE: held for a colleague who worked the customer last.
 *
 * Said apart from the number that promises a pull — «بانتظارك» counts what she may take, and this counts what is in the
 * queue and is somebody else's, so the first number is never a button that answers «لا توجد طلبات».
 */
export async function reservedForColleaguesCount(tx: Tx, scope: QueueScope, userId: string, now = new Date()) {
  return tx.order.count({ where: { ...claimableWhere(scope), ...reservedForOthersWhere(userId, now) } });
}

/**
 * Waiting on a date that has not arrived — real work, and none of it
 * takeable today. Counted separately so the screen can say so instead of
 * hiding it inside a number that promises a pull.
 */
export async function postponedNotDueCount(tx: Tx, scope: QueueScope, now = new Date()) {
  const leadEnd = new Date(now.getTime() + POSTPONE_LEAD_DAYS * 24 * 60 * 60 * 1000);
  return tx.order.count({
    where: {
      ...claimableWhere(scope),
      confirmationStatus: 'POSTPONED',
      // The complement of `duePostponedWhere`, date by date (RV79): the postponement date decides when it exists, and the
      // follow-up date only when it does not. An order with neither stays here, as it always did — it is not takeable.
      OR: [
        { postponedUntil: { gt: leadEnd } },
        { postponedUntil: null, OR: [{ nextFollowUpAt: { gt: leadEnd } }, { nextFollowUpAt: null }] },
      ],
    },
  });
}

/**
 * How many of ONE moderator's orders are still waiting to be confirmed.
 *
 * A moderator brings orders in and then has no way to know what became of
 * them without asking somebody. This is the answer as a number — and only a
 * number. The pool itself stays closed to them (confirmation.pull is not
 * theirs, and the queue route refuses them with 403); what they may know is
 * how many of their OWN are still open, never which order is whose to call.
 *
 * "Waiting" means exactly what it means for the pool — the same open states,
 * not yet shipping — whether or not an agent has already picked it up. From
 * the moderator's side an order an agent is on is still not confirmed.
 */
export async function awaitingConfirmationCount(tx: Tx, scope: QueueScope, moderatorId: string) {
  return tx.order.count({
    where: {
      ...scope,
      moderatorId,
      confirmationStatus: { in: OPEN_CONFIRMATION },
      shippingStatus: 'NOT_READY',
    },
  });
}

function claimableWhere(scope: QueueScope) {
  return {
    ...scope,
    claimedById: null,
    confirmationStatus: { in: OPEN_CONFIRMATION },
    shippingStatus: 'NOT_READY',
  };
}

/**
 * THE TWO HALVES OF «TAKEABLE NOW», WRITTEN ONCE.
 *
 * A postponed order that is not yet due is waiting, and must NOT be handed
 * to anybody: the customer asked to be called on Thursday. The picker has
 * always honoured that. The COUNTER did not — it counted every unclaimed
 * open order — so a pool holding nothing but far-off postponements showed
 * «٣ طلبات بانتظار التأكيد» above a live button that answered «لا توجد
 * طلبات» every time it was pressed.
 *
 * That is the shape of «بعدين ببطل أقدر أسحب أي طلب»: a number that
 * promises work and a button that never yields any. Both read these two
 * predicates now, so they cannot disagree.
 */
export function duePostponedWhere(scope: QueueScope, now: Date) {
  const leadEnd = new Date(now.getTime() + POSTPONE_LEAD_DAYS * 24 * 60 * 60 * 1000);
  return {
    ...claimableWhere(scope),
    confirmationStatus: 'POSTPONED',
    // THE SCREEN'S READING OF «WHEN» (RV79): `postponedUntil ?? nextFollowUpAt`. The postponement date decides when there
    // is one; the follow-up date counts only for an order that has none. Either date alone made the counter and the
    // «اسحب» button call due an order the postponed list showed with a far date. `postponed-filters.ts` reads it the same way.
    OR: [{ postponedUntil: { lte: leadEnd } }, { postponedUntil: null, nextFollowUpAt: { lte: leadEnd } }],
  };
}

export function readyToPullWhere(scope: QueueScope, forUserId?: string, now: Date = new Date()) {
  return {
    ...claimableWhere(scope),
    confirmationStatus: { not: 'POSTPONED' },
    // For an agent: not what is held for a colleague — the POSITIVE form (`notHeldForOthersWhere`), because `NOT (…)` over nullable
    // columns drops a released order that kept its name. Without `forUserId` it is the whole pool, as the supervisor reads it.
    ...(forUserId ? { AND: [notHeldForOthersWhere(forUserId, now)] } : {}),
  };
}

/**
 * The next order to work on: a postponed one that is due within the lead
 * days, otherwise the oldest waiting order.
 */
export async function pickNextCandidate(tx: Tx, scope: QueueScope, now = new Date(), forUserId?: string) {
  // THE ORDER HELD FOR HER COMES FIRST: the customer is a returning one and she is the person he spoke to.
  if (forUserId) {
    const mine = await tx.order.findFirst({
      where: { ...claimableWhere(scope), ...reservedForWhere(forUserId, now) },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (mine) return mine.id;
  }

  // The same two predicates the counter uses — kept as two queries only
  // because they are ordered differently: a promise by its date, and
  // everything else by its age.
  const duePostponed = await tx.order.findFirst({
    where: duePostponedWhere(scope, now),
    orderBy: [{ postponedUntil: 'asc' }, { nextFollowUpAt: 'asc' }],
    select: { id: true },
  });
  if (duePostponed) return duePostponed.id;

  const oldest = await tx.order.findFirst({
    where: readyToPullWhere(scope, forUserId, now),
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return oldest?.id ?? null;
}

export interface PullResult {
  ok: boolean;
  orderId?: string;
  refusal?: PullRefusal;
  released?: number;
  waiting?: number;
}

/**
 * Pull the next order for this agent. The claim is taken with a conditional
 * update, so two agents pulling at the same instant can never get the same
 * order — the loser simply takes the next one.
 */
export async function pullNextOrder(
  scope: QueueScope,
  user: { id: string; role: string },
  cal: BusinessCalendar,
  now = new Date()
): Promise<PullResult> {
  return db.$transaction(async (tx) => {
    const released = await releaseStaleClaims(tx, scope, cal, now);

    const counts = await ownedCounts(tx, scope, user.id);
    const refusal = pullRefusal(counts);
    if (refusal) return { ok: false, refusal, released };

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await pickNextCandidate(tx, scope, now, user.id);
      if (!candidate) {
        return {
          ok: false,
          released,
          waiting: 0,
          refusal: { code: 'QUEUE_EMPTY', message: 'لا توجد طلبات بانتظار التأكيد الآن.' },
        };
      }

      const taken = await tx.order.updateMany({
        // «Not held for somebody else» is asked again at the write: the hold may have been made between the pick and here.
        where: { id: candidate, claimedById: null, AND: [notHeldForOthersWhere(user.id, now)] },
        data: {
          claimedById: user.id,
          claimedAt: now,
          currentOwnerId: user.id,
          confirmationStatus: 'IN_PROGRESS',
          status: 'IN_PROGRESS',
          version: { increment: 1 },
        },
      });
      if (taken.count !== 1) continue; // someone else won the race — try the next one

      await tx.orderClaimHistory.create({
        data: {
          companyId: scope.companyId,
          orderId: candidate,
          userId: user.id,
          action: 'CLAIMED',
          reason: 'PULL_NEXT',
          metadata: JSON.stringify({ role: user.role }),
        },
      });
      await tx.orderStatusLog.create({
        data: {
          companyId: scope.companyId,
          orderId: candidate,
          statusType: 'CONFIRMATION',
          previousValue: null,
          newValue: 'IN_PROGRESS',
          changedById: user.id,
          changedByRole: user.role,
          note: 'سحب من الطابور',
        },
      });
      return { ok: true, orderId: candidate, released };
    }
    return { ok: false, released, refusal: { code: 'QUEUE_EMPTY', message: 'تعذر سحب طلب، حاول مجدداً.' } };
  });
}
