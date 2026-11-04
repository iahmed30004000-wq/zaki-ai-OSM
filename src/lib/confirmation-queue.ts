import type { Prisma } from '@prisma/client';
import { db } from './db';
import { businessMinutesBetween, type BusinessCalendar } from './business-calendar';
import { rejectionNeedsConversation } from './confirmation-workflow';
import { notHeldForOthersWhere, reservedForOthersWhere, reservedForWhere } from './order-reservation';
import { holdTwinsForPuller, lockCustomerForPull } from './twins-follow-the-pull';
import { NO_ANSWER_RESULTS } from './confirmation-workflow';
import {
  releaseCutoffs,
  roundsOn,
  roundsReleaseReason,
  workClock,
  type RoundsSwitch,
} from './no-answer-rounds';
import { roundsSwitch } from './no-answer-rounds-switch';

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
 * not by its id»). So for every account that works a queue, every decision and every logged call goes through the order she HOLDS.
 *
 * NOT BOUND: whoever holds a key to TAKE any order (`orders.unlock`, the override of «استلمه أنا») or to GIVE any order away
 * (`orders.assign`): binding them would gain nothing — they can take or hand over the order in one press — and would cost a manager's
 * day the moment she opened an order nobody had pulled. The owner holds every key.
 *
 * ⚠️ `confirmation.supervise` IS NOT AN EXEMPTION, and the first version of this rule made it one (`keepsOwnEntry`'s test). Measured
 * on the live site, 1/11, read-only (`GET /api/roles`, then every account's effective keys): the role CONFIRMATION_AGENT — all seven active
 * accounts, the one the incident came from — each holds `confirmation.supervise` and `confirmation.reassign` besides
 * `confirmation.work`, `confirmation.pull`, `orders.confirm` and `orders.view` for the whole company, and none holds `orders.unlock`
 * or `orders.assign`. That key gates what a person SEES (the whole queue, the win-back list, the notifications), not what she may
 * take. A rule that excused it would have excused every agent it was written for and stopped nobody; the unit tests, which hand the
 * door keys by hand, could not have said so. `the-live-agent-is-refused-by-the-real-engine.test.ts` holds the measured list.
 *
 * ── THE DOORS THAT ASK IT (the independent review of #154, 2/11, closed the rest) ──
 *
 *   · the confirmation door and the contact-attempts door (#154), and with them the two that sat beside them: the call log
 *     (`POST /api/orders/[id]/call-logs`) and the entry issue (`POST /api/confirmation/issues`) — each answers `NOT_HELD` before it
 *     writes a row. The entry issue also refuses an order past the confirmation desk, for everybody (see that door);
 *   · the transfer door asks the other side of the same rule: who may be HANDED an order (`mayBeHandedAnOrder`);
 *   · the claim-by-number door (`POST /api/orders/[id]/claim`) is not «hold it first» — taking is the point — so it refuses her
 *     altogether and sends her to the pull (`claimByNumberMessage`, code `USE_THE_PULL`). Nothing on screen ever called it for her
 *     (`useOrderOwnership.claim` has no caller). The owner («استلمه أنا»), a manager and a moderator keep it exactly as it was.
 *
 * The pull (`/api/confirmation/pull`, «طلباتي») is therefore the ONLY way an order reaches an agent's hands out of the queue. The other
 * two are not a taking: a hand-over to her (`/api/orders/[id]/transfer`, by whoever assigns or by the colleague who holds it) and an
 * order she typed herself (`keepsOwnEntry`).
 *
 * ⚠️ The rule turns itself off for an account the day the owner ticks `orders.unlock` or `orders.assign` on its role — silently, and
 * the tests cannot see it (their key lists are pictures of one day). The pre-deploy report lists exactly who is NOT bound today
 * (`scripts/permission-predeploy-report.sql`, the last section): read it before and after touching those two boxes.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function mustHoldToWork(holds: (permission: string) => boolean): boolean {
  return holds('confirmation.work') && !holds('orders.unlock') && !holds('orders.assign');
}

/** Said by the door and by the screen, in the same words. */
export const NOT_HELD_MESSAGE = 'اسحب الطلب أولاً — لا يمكن العمل على طلب ليس بين يديك';

/** The code the claim-by-number door answers an agent with — not `NOT_HELD`: she holds nothing yet, and taking is not what is refused. */
export const USE_THE_PULL_CODE = 'USE_THE_PULL';

/**
 * What the claim-by-number door says to an agent. The way to an order is the pull, so that is what it names — and only when she HAS
 * the pull: for an account that works orders but cannot pull (`confirmation.pull` unticked), a sentence that sends her to a button
 * she does not have is the same lie the order sheet used to tell (RV568).
 */
export function claimByNumberMessage(holds: (permission: string) => boolean): string {
  return holds('confirmation.pull')
    ? 'ما بينسحب طلب برقمه — اضغط «اسحب الطلب التالي» وبيجيك الطلب اللي دوره'
    : 'ما بينسحب طلب برقمه — وما عندك صلاحية سحب الطلبات؛ بيوصلك الطلب لما المشرف يحوّله إلك';
}

/**
 * MAY THIS ACCOUNT BE HANDED AN ORDER TO WORK? (the transfer door, both its list and its acceptance)
 *
 * «Can work» was one key — `confirmation.work` — and the supervisor template holds it: it works a queue to WATCH it, with no pull,
 * no `orders.confirm` and no `orders.contact_log`. An order handed to her could be neither confirmed nor rung. What the order needs
 * in the hands that get it is what the doors above ask of her: to work it (`confirmation.work`), to be a person the queue gives
 * orders to (`confirmation.pull`), and to decide it (`orders.confirm`, the first thing the confirmation door asks of every action).
 */
export function mayBeHandedAnOrder(holds: (permission: string) => boolean): boolean {
  return holds('confirmation.work') && holds('confirmation.pull') && holds('orders.confirm');
}

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

/** The sentence the sheet prints under «الطلب مو بين يديك», and which of the three cases below it is. */
export interface PullFirstNotice {
  kind: 'HELD_BY_COLLEAGUE' | 'PULL' | 'NOT_YOURS';
  text: string;
}

/**
 * WHAT THE SHEET SAYS TO AN AGENT ON AN ORDER SHE MAY NOT WORK — IN THE WORDS THAT ARE TRUE FOR THAT ORDER (RV568).
 *
 * One sentence said «اسحبه من اسحب التالي» to everyone, and it was wrong twice: when a COLLEAGUE holds the order the pull will never
 * give it to her, and when she holds no `confirmation.pull` there is no button to press. Three cases, then:
 *
 *   · a colleague holds it            ⇒ «الطلب مع <name>» — and no instruction to pull (it is hers, not the queue's);
 *   · nobody holds it, she may pull   ⇒ today's sentence, word for word;
 *   · nobody holds it, she may not    ⇒ it is not hers, and no instruction to press a button she does not have.
 *
 * `null` when the sheet owes her nothing (`agentMustPullFirst` is false). The title above the text — «الطلب مو بين يديك» — is the sheet's.
 * The name is the holder's, as `GET /api/orders/[id]` sends it (`claimer`); a row that did not carry it says «موظف تاني».
 *
 * (An order held FOR a colleague — a returning customer's, `reservedFor` — is still read as «nobody holds it»: BACKLOG RV585.)
 */
export function pullFirstNotice(args: {
  holds: (permission: string) => boolean;
  userId?: string | null;
  order: { claimedById?: string | null; confirmationStatus: string; claimer?: { name?: string | null } | null };
}): PullFirstNotice | null {
  if (!agentMustPullFirst(args)) return null;
  if (args.order.claimedById) {
    const who = args.order.claimer?.name?.trim() || 'موظف تاني';
    return { kind: 'HELD_BY_COLLEAGUE', text: `الطلب مع ${who} — ما بتتصل ولا بتأكّد على طلب مع غيرك.` };
  }
  if (!args.holds('confirmation.pull')) {
    return { kind: 'NOT_YOURS', text: 'الطلب مو إلك — ما عندك صلاحية سحب الطلبات، فبتشتغل على اللي بيتحوّل لك بس.' };
  }
  return { kind: 'PULL', text: `${NOT_HELD_MESSAGE}. اسحبه من «اسحب التالي» أو افتحه من «طلباتي»، وبعدها اتصل وأكّد.` };
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الزبون على الخط — أكّده الآن» FOR AN AGENT WHO IS BOUND (the owner, 2/11: «بنات التأكيد و المشرفة يظهرلهم انشاء طلب
 * وتحت في خيار انو طلب مؤكد»).
 *
 * The live agents hold `confirmation.supervise`, so `keepsOwnEntry` sends what they type to the pool — and the confirmation door
 * then refuses them `NOT_HELD`, because they are bound by `mustHoldToWork`. Neither rule is loosened here. Instead, when she ticks
 * the box and may confirm, the order she has just typed is HERS — the same kind of claim an agent without supervise gets for every
 * entry (`MANUAL_ENTRY`), under the same 300 cap. An account the hold rule does not bind (whoever holds `orders.unlock` or
 * `orders.assign`, or works no queue) is not given a claim it does not need: the confirmation door never asked it to hold.
 *
 * And the contact-first rule (`needsContactFirst`) is met by the truth, not by an exemption: the customer was on the line, so the
 * creation door writes that one call (`CONFIRM_NOW_NOTE`) in the same transaction — and only when the order really is hers.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function claimsOwnEntry(holds: (permission: string) => boolean, confirmNow: boolean): boolean {
  return keepsOwnEntry(holds) || (confirmNow && mustHoldToWork(holds));
}

/**
 * MAY THIS PERSON BE OFFERED «أكّده الآن» AT ALL? Asked by the form (the box) and by the door (`mayConfirmNow`), in the same words,
 * so nobody is shown a box that can never confirm.
 *
 * She must be allowed to confirm (`orders.confirm`, the confirmation door's first question). And ONLY when the hold rule binds her
 * (`mustHoldToWork`) — the one case the creation door writes a call in her name — must she also be allowed to record a call
 * (`orders.contact_log`, the key that guards exactly that row). Somebody it does not bind — a manager, a moderator, the owner —
 * keeps today's one-step confirm with `orders.confirm` alone: no call is written for her and none is asked of her (RV686).
 */
export function offersConfirmNow(holds: (permission: string) => boolean): boolean {
  return holds('orders.confirm') && (!mustHoldToWork(holds) || holds('orders.contact_log'));
}

/** The door's version: the same question, and a file never confirms — an import row carrying the flag is an ordinary row. */
export function mayConfirmNow(holds: (permission: string) => boolean, viaImport: boolean): boolean {
  return !viaImport && offersConfirmNow(holds);
}

/** The call the creation door records when the customer was on the line — PHONE, ANSWERED, and this note. */
export const CONFIRM_NOW_NOTE = 'الزبون كان على الخط وقت إدخال الطلب — أكّده الآن';

export type ConfirmNowReadiness =
  | { ready: true }
  | { ready: false; code: 'CAP_FULL' | 'MAY_NOT_CONFIRM' | 'REGION_REQUIRED'; reason: string };

/** Said when «أكّده الآن» was ticked by somebody the door may not honour it for. */
export const MAY_NOT_CONFIRM_NOW_MESSAGE = 'ما عندك صلاحية «تغيير حالة التأكيد» — أو «تسجيل نتيجة الاتصال» وإنتِ بتشتغلي على اللي بإيدك بس';

/**
 * WILL THE CONFIRMATION DOOR SAY YES TO WHAT WAS JUST MADE? Answered by the creation door, so the form never makes a call it
 * already knows will be refused, and says «انعمل ولكن ما اتأكد» with the reason instead.
 */
export function confirmNowReadiness(args: {
  wanted: boolean;
  holds: (permission: string) => boolean;
  userId: string;
  entry: EntryOwnership;
  regionId: string | null;
}): ConfirmNowReadiness {
  if (!args.wanted) return { ready: false, code: 'MAY_NOT_CONFIRM', reason: MAY_NOT_CONFIRM_NOW_MESSAGE };
  if (mustHoldToWork(args.holds) && args.entry.claimedById !== args.userId) {
    return { ready: false, code: 'CAP_FULL', reason: ENTRY_CAP_FULL_MESSAGE };
  }
  if (needsRegionFirst({ regionId: args.regionId })) return { ready: false, code: 'REGION_REQUIRED', reason: REGION_REQUIRED_MESSAGE };
  return { ready: true };
}

/**
 * THE CALL, RECORDED — inside the transaction that writes the order, and only when the order is hers (a colleague who pulls an
 * order the cap sent to the pool must still ring). The order is new, so this is its first attempt.
 */
export async function recordConfirmNowAttempt(
  tx: Tx,
  args: { companyId: string; orderId: string; user: { id: string; role: string } }
): Promise<void> {
  await tx.orderContactAttempt.create({
    data: {
      companyId: args.companyId,
      orderId: args.orderId,
      employeeId: args.user.id,
      employeeRole: args.user.role,
      attemptNumber: 1,
      contactMethod: 'PHONE',
      result: 'ANSWERED',
      note: CONFIRM_NOW_NOTE,
    },
  });
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
  /** «الزبون على الخط — أكّده الآن», already weighed by `mayConfirmNow`. Absent = false: the AI-intake door never sends it. */
  confirmNow?: boolean;
}): EntryOwnership {
  const unclaimed: EntryOwnership = {
    claimedById: null,
    claimedAt: null,
    currentOwnerId: null,
    capFull: false,
  };
  if (!claimsOwnEntry(args.holds, args.confirmNow === true)) return unclaimed;
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

/**
 * Open, and takeable without waiting for a date: every open status but POSTPONED, which comes back on its day
 * (`duePostponedWhere`). Derived from `OPEN_CONFIRMATION` and never typed out, so a status added to the open list is added here
 * too, and a decided one (CONFIRMED · REJECTED · CANCELLED) can never be in it.
 */
export const READY_CONFIRMATION = OPEN_CONFIRMATION.filter((status) => status !== 'POSTPONED');

export interface QueueScope {
  companyId: string;
  storeId: string;
}

export interface OwnedCounts {
  /** In her hands: claimed by her, still open. */
  total: number;
  /**
   * HELD FOR HER AND NOT YET PULLED (RV706) — a returning customer's order (`reserve-returning-customers.ts`) or a twin of one
   * she pulled (`twins-follow-the-pull.ts`). They count toward the 300 (`capLoad`). Optional so the pure refusal rules can still
   * be tested with a bare count literal; absent is none.
   */
  heldForHer?: number;
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

/** What this agent currently holds in the confirmation stage — in her hands, and held for her. */
export async function ownedCounts(tx: Tx, scope: QueueScope, userId: string, now: Date = new Date()): Promise<OwnedCounts> {
  const untouchedWhere = heldWithoutAttemptWhere(scope, userId);
  const [total, withoutAttempt, untouched, heldForHer] = await Promise.all([
    tx.order.count({
      where: { ...scope, claimedById: userId, confirmationStatus: { in: OPEN_CONFIRMATION } },
    }),
    tx.order.count({ where: untouchedWhere }),
    tx.order.findFirst({
      where: untouchedWhere,
      orderBy: { claimedAt: 'asc' },
      select: { id: true, orderNumber: true },
    }),
    // The very set «اسحب التالي» gives her first (`heldForHerWhere`), so the cap counts exactly what the pull would hand her.
    tx.order.count({ where: heldForHerWhere(scope, userId, now) }),
  ]);
  return { total, heldForHer: heldForHer ?? 0, withoutAttempt, untouched: untouched ?? null };
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE 300 COUNTS WHAT IS HELD FOR HER TOO (RV706 — the owner, 3/11: «اه»).
 *
 * The cap used to count only what was in her hands, and a hold (a returning customer's order, a twin of the one she pulled) took
 * only the room left after it — so across pulls and the scheduler's runs her name could stand on more than 300 orders. Now the
 * load is in her hands + held for her, and every place the cap is asked reads it from here and nowhere else:
 *
 *   · the pull's refusal and the claim-by-id door (`pullRefusal` / `capRefusal`);
 *   · her own entry and «أكّده الآن» (`entryOwnership`'s `heldTotal` is `capLoad`);
 *   · the room a hold may take — the twins at the pull and the returning-customer job (`capRoom`).
 *
 * ── AT THE CAP, WHAT IS HELD FOR HER IS STILL HERS TO TAKE ──
 *
 * Pulling an order held for her moves it from «held» to «in her hands»: the load does not grow. So at the cap she is refused
 * anything NEW, and the pull still gives her what is held for her (it gives that first anyway). Refusing that too would leave
 * an agent with nothing in her hands and 300 held for her unable to work any of them for a day. In her hands alone at 300, she
 * is refused everything, as before.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function capLoad(counts: OwnedCounts): number {
  return counts.total + (counts.heldForHer ?? 0);
}

/** How many more orders may carry her name — in her hands or held for her. Never negative. */
export function capRoom(counts: OwnedCounts): number {
  return Math.max(0, CLAIM_CAPS.total - capLoad(counts));
}

/** The cap's sentence. When holds are part of the load it says so, and says they count. */
export function capFullMessage(counts: OwnedCounts): string {
  const held = counts.heldForHer ?? 0;
  if (held <= 0) return `بلغت الحد الأقصى (${CLAIM_CAPS.total} طلب لديك).`;
  return `بلغت الحد الأقصى (${CLAIM_CAPS.total} طلب): ${counts.total} بين يديك و${held} محجوز لك — المحجوز لك بينعدّ من الحد. خلّص من اللي بإيدك أو اسحب المحجوز لك.`;
}

/**
 * MAY SHE TAKE ONE MORE? `takesHeldForHer` is true when what she is about to take is one of the orders held for her (it is
 * already counted). In her hands at 300 is a refusal whatever she takes; at 300 with holds, only something new is refused.
 */
export function capRefusal(counts: OwnedCounts, takesHeldForHer: boolean): PullRefusal | null {
  const full = counts.total >= CLAIM_CAPS.total || (!takesHeldForHer && capLoad(counts) >= CLAIM_CAPS.total);
  return full ? { code: 'CAP_TOTAL', message: capFullMessage(counts) } : null;
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
 *
 * The total cap counts what is held for her (`capLoad`, RV706). `takesHeldForHer` says whether what she is about to take is one
 * of those: by default it is whenever she has any, because «اسحب التالي» gives them first — and the pull, at the cap, gives her
 * nothing else (`pullNextOrder`). The claim-by-id door says it of the very order asked for.
 */
export function pullRefusal(counts: OwnedCounts, takesHeldForHer: boolean = (counts.heldForHer ?? 0) > 0): PullRefusal | null {
  const cap = capRefusal(counts, takesHeldForHer);
  if (cap) return cap;
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
export async function releaseStaleClaims(
  tx: Tx,
  scope: QueueScope,
  cal: BusinessCalendar,
  now = new Date(),
  /** «نظام الجولات»: the switch when the caller already read it (the pull reads it before its transaction), and how many it may let go. */
  opts: { rounds?: RoundsSwitch; roundsLimit?: number } = {}
) {
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
  // «نظام الجولات» (R1) — only with the owner's switch ON; OFF, the lines above are the whole rule, as they always were.
  return expired.length + (await releaseNoAnswerRounds(tx, scope, cal, now, opts));
}

/**
 * The rounds release alone (R1) — what `releaseStaleClaims` runs after the ninety-minute release. The five-minute job calls it in
 * a transaction of its own, so a pass that runs out of time can never roll back the ninety-minute releases with it.
 */
export async function releaseNoAnswerRounds(
  tx: Tx,
  scope: QueueScope,
  cal: BusinessCalendar,
  now = new Date(),
  opts: { rounds?: RoundsSwitch; roundsLimit?: number } = {}
): Promise<number> {
  const rounds = opts.rounds ?? (await roundsSwitch(tx, scope.companyId));
  if (!roundsOn(rounds)) return 0;
  return releaseByRounds(tx, scope, cal, now, rounds, opts.roundsLimit ?? ROUNDS_RELEASE_LIMIT);
}

/** How many orders one pass of the rounds release may let go — the same bound as the ninety-minute release above. */
export const ROUNDS_RELEASE_LIMIT = 200;
/** Inside the pull's own transaction, fewer: the pull must stay under its timeout (`PULL_TRANSACTION_OPTIONS`). The job and the queue screen take the rest. */
export const PULL_ROUNDS_RELEASE_LIMIT = 25;
/** Held orders read per pass. A pass that reads a full page carries on from there next time, so every held order is read in turn. */
export const ROUNDS_SCAN_PAGE = 500;
const roundsScanCursor = new Map<string, string>();

/**
 * R1 — LET GO WHAT NOBODY ANSWERED FOR THREE WORKING HOURS (`no-answer-rounds.ts`).
 *
 * Linear and bounded: the two cut-offs are placed ONCE for the pass, the database narrows to the held orders that can
 * qualify (a no-answer since the switch went on and three working hours old, or nothing logged for ninety working minutes),
 * one page of them is read with their attempts, and each is one pure verdict. The writes are the ninety-minute release's,
 * line for line, with their own reason in the claim history — and the customer's other orders held for her are let go in
 * the same step, so whoever takes the order next takes him whole (`twins-follow-the-pull.ts`).
 */
async function releaseByRounds(
  tx: Tx,
  scope: QueueScope,
  cal: BusinessCalendar,
  now: Date,
  sw: RoundsSwitch & { enabledAt: Date },
  limit: number
): Promise<number> {
  const clock = workClock(cal);
  const cut = releaseCutoffs(now, clock);
  // Switched on less than ninety working minutes ago: nothing logged since can be old enough yet (the round cut-off is earlier still).
  if (sw.enabledAt.getTime() > cut.repull.getTime()) return 0;

  const key = `${scope.companyId}:${scope.storeId}`;
  const cursor = roundsScanCursor.get(key);
  const rows = await tx.order.findMany({
    where: {
      ...scope,
      claimedById: { not: null },
      claimedAt: { not: null, lte: cut.repull },
      confirmationStatus: { in: OPEN_CONFIRMATION },
      // Never shipped — the contact door's own reading of «still ours to move».
      shippingStatus: 'NOT_READY',
      shippingBatchId: null,
      trackingNumber: null,
      labelPrintedAt: null,
      // No attempt at all is the ninety-minute rule's, above.
      contactAttempts: { some: {} },
      AND: [
        // A date ahead — a postponement, a callback he asked for — keeps it with her.
        { OR: [{ postponedUntil: null }, { postponedUntil: { lte: now } }] },
        { OR: [{ nextFollowUpAt: null }, { nextFollowUpAt: { lte: now } }] },
        {
          OR: [
            { contactAttempts: { some: { result: { in: [...NO_ANSWER_RESULTS] }, createdAt: { gte: sw.enabledAt, lte: cut.round } } } },
            { contactAttempts: { none: { createdAt: { gt: cut.repull } } } },
          ],
        },
      ],
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take: ROUNDS_SCAN_PAGE,
    select: {
      id: true,
      claimedAt: true,
      claimedById: true,
      companyId: true,
      customerId: true,
      postponedUntil: true,
      nextFollowUpAt: true,
      contactAttempts: { select: { createdAt: true, result: true, attemptNumber: true, employeeId: true } },
    },
  });
  if (rows.length < ROUNDS_SCAN_PAGE) roundsScanCursor.delete(key);
  else roundsScanCursor.set(key, rows[rows.length - 1].id);

  let released = 0;
  for (const order of rows) {
    if (released >= limit) break;
    const reason = roundsReleaseReason(
      {
        claimedAt: order.claimedAt!,
        claimedById: order.claimedById,
        postponedUntil: order.postponedUntil,
        nextFollowUpAt: order.nextFollowUpAt,
      },
      order.contactAttempts,
      sw,
      cut,
      now
    );
    if (!reason) continue;
    const done = await tx.order.updateMany({
      // Still hers, still the same claim, still open and not shipping — a press between the read and here wins.
      where: {
        id: order.id,
        claimedById: order.claimedById,
        claimedAt: order.claimedAt,
        confirmationStatus: { in: OPEN_CONFIRMATION },
        shippingStatus: 'NOT_READY',
      },
      // Exactly what the ninety-minute release writes.
      data: { claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null },
    });
    if (done.count !== 1) continue;
    await tx.orderClaimHistory.create({
      data: { companyId: order.companyId, orderId: order.id, userId: order.claimedById!, action: 'RELEASED', reason },
    });
    // His other orders held for her go back too: one customer, one agent.
    if (order.customerId) {
      await tx.order.updateMany({
        where: {
          companyId: scope.companyId,
          storeId: scope.storeId,
          customerId: order.customerId,
          id: { not: order.id },
          claimedById: null,
          confirmationStatus: 'NEW',
          shippingStatus: 'NOT_READY',
          claimHistory: { none: {} },
          assignedToId: order.claimedById,
        },
        data: { assignedToId: null, assignedAt: null, version: { increment: 1 } },
      });
    }
    released++;
  }
  return released;
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
    /*
     * ORD-2026-1166 (1/11): rejected as a duplicate at 12:18, pulled from the queue at 13:50, confirmed, cancelled before the
     * shipment at 15:54, and pulled again at 15:56 and the next day. This key used to be `{ not: 'POSTPONED' }`, and a later
     * key in an object REPLACES the one spread before it — so the `in: OPEN_CONFIRMATION` of `claimableWhere` was thrown away
     * and the pool was every unclaimed NOT_READY order that was not postponed: rejected, cancelled and confirmed ones included,
     * and the oldest first. It narrows the open list now, never widens it.
     */
    confirmationStatus: { in: READY_CONFIRMATION },
    // For an agent: not what is held for a colleague — the POSITIVE form (`notHeldForOthersWhere`), because `NOT (…)` over nullable
    // columns drops a released order that kept its name. Without `forUserId` it is the whole pool, as the supervisor reads it.
    ...(forUserId ? { AND: [notHeldForOthersWhere(forUserId, now)] } : {}),
  };
}

/**
 * HELD FOR HER, AND TAKEABLE — the set «اسحب التالي» gives her first, and the set the cap counts as held for her (`ownedCounts`).
 * One filter for both, so the count and the pick cannot disagree.
 */
export function heldForHerWhere(scope: QueueScope, userId: string, now: Date) {
  return { ...claimableWhere(scope), ...reservedForWhere(userId, now) };
}

/** The oldest order held for her, or null. */
export async function pickHeldForHer(tx: Tx, scope: QueueScope, userId: string, now: Date): Promise<string | null> {
  const mine = await tx.order.findFirst({
    where: heldForHerWhere(scope, userId, now),
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return mine?.id ?? null;
}

/**
 * The next order to work on: a postponed one that is due within the lead
 * days, otherwise the oldest waiting order.
 */
export async function pickNextCandidate(
  tx: Tx,
  scope: QueueScope,
  now = new Date(),
  forUserId?: string,
  /** The caller already asked `pickHeldForHer` and found none (the pull does, to know whether the cap grows). */
  opts: { heldForHerAsked?: boolean; rounds?: RoundsSwitch } = {}
) {
  // THE ORDER HELD FOR HER COMES FIRST: the customer is a returning one and she is the person he spoke to.
  if (forUserId && !opts.heldForHerAsked) {
    const mine = await pickHeldForHer(tx, scope, forUserId, now);
    if (mine) return mine;
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

  // «نظام الجولات» (R4), with the switch ON only: an order nobody has rung yet comes before one that was rung already.
  if (roundsOn(opts.rounds)) {
    const neverRung = await tx.order.findFirst({
      where: { ...readyToPullWhere(scope, forUserId, now), contactAttempts: { none: {} } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (neverRung) return neverRung.id;
  }

  const oldest = await tx.order.findFirst({
    where: readyToPullWhere(scope, forUserId, now),
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return oldest?.id ?? null;
}

/**
 * HOW LONG A PULL MAY WAIT, AND HOW LONG IT MAY RUN (RV711).
 *
 * Prisma's defaults are 2 s to get a connection and 5 s for the whole interactive transaction. Since the pull takes the
 * customer's lock (`lockCustomerForPull`), it can wait behind a colleague's WHOLE pull of the same customer: up to five
 * attempts, then up to `MAX_TWINS_HELD` hold updates and as many history rows — about 130 statements — and behind more than
 * one colleague on a busy morning. Five seconds left no margin; past it the pull failed with P2028 and the agent read
 * «حدث خطأ داخلي».
 *
 * Not the 20 s / 30 s the statement doors use: the screen gives up on its own request after 15 s (`REQUEST_TIMEOUT_MS` in
 * `api-client.ts`). A transaction allowed to run past that would end after nobody is listening — she would read «انتهت مهلة
 * الطلب» and could not tell whether the order was hers. Both bounds together stay under the screen's wait, so a pull that runs
 * out of time reaches her as the route's «الطابور مشغول» sentence instead.
 */
export const PULL_TRANSACTION_OPTIONS = { maxWait: 3_000, timeout: 10_000 } as const;

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
 * order — the loser simply takes the next one. And never the same CUSTOMER:
 * the claim waits on a per-customer lock, and the winner's claim holds his
 * other waiting orders for her (`twins-follow-the-pull.ts`).
 */
export async function pullNextOrder(
  scope: QueueScope,
  user: { id: string; role: string },
  cal: BusinessCalendar,
  now = new Date()
): Promise<PullResult> {
  // «نظام الجولات»: read before the transaction (a cached read), so the pull never waits on a second connection for it.
  const rounds = await roundsSwitch(db, scope.companyId);
  return db.$transaction(async (tx) => {
    const released = await releaseStaleClaims(tx, scope, cal, now, { rounds, roundsLimit: PULL_ROUNDS_RELEASE_LIMIT });

    const counts = await ownedCounts(tx, scope, user.id, now);
    const refusal = pullRefusal(counts);
    if (refusal) return { ok: false, refusal, released };
    // AT THE CAP WITH HOLDS (RV706): only an order held for her — it is already counted, so taking it does not grow the load.
    const atCap = capLoad(counts) >= CLAIM_CAPS.total;

    for (let attempt = 0; attempt < 5; attempt++) {
      const hers = await pickHeldForHer(tx, scope, user.id, now);
      const candidate = hers ?? (atCap ? null : await pickNextCandidate(tx, scope, now, user.id, { heldForHerAsked: true, rounds }));
      if (!candidate) {
        // At the cap and nothing held for her is left to take (a hold let go between the count and here): the cap's sentence.
        if (atCap) return { ok: false, released, refusal: capRefusal(counts, false)! };
        return {
          ok: false,
          released,
          waiting: 0,
          refusal: { code: 'QUEUE_EMPTY', message: 'لا توجد طلبات بانتظار التأكيد الآن.' },
        };
      }

      // Whose order it is, read by its id: the customer is the lock's key and his other orders' owner; the number is what
      // their history names.
      const picked = await tx.order.findFirst({ where: { id: candidate }, select: { customerId: true, orderNumber: true } });
      // ONE CUSTOMER, ONE AGENT (`twins-follow-the-pull.ts`): wait here while a colleague is taking one of his orders, so that
      // when the claim below runs, his other orders are already held for her and this pull moves on to somebody else's.
      if (picked?.customerId) await lockCustomerForPull(tx, picked.customerId);

      const taken = await tx.order.updateMany({
        // «Not held for somebody else» is asked again at the write: the hold may have been made between the pick and here.
        // And «still open, still not shipping» too: an order decided by hand between the pick and here (a manager's yes, a
        // cancel) is not turned back into IN_PROGRESS by this write.
        where: {
          id: candidate,
          claimedById: null,
          confirmationStatus: { in: OPEN_CONFIRMATION },
          shippingStatus: 'NOT_READY',
          AND: [notHeldForOthersWhere(user.id, now)],
        },
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
      // His other orders that are still waiting and nobody's come to her, never more than the cap leaves room for (RV706): the room
      // is counted before this pull over what is in her hands AND held for her; an order taken from the pool adds one, an order
      // that was held for her only moves from one to the other.
      await holdTwinsForPuller(tx, {
        scope,
        customerId: picked?.customerId,
        pulled: { id: candidate, orderNumber: picked?.orderNumber },
        agentId: user.id,
        room: capRoom(counts) - (hers ? 0 : 1),
        now,
      });
      return { ok: true, orderId: candidate, released };
    }
    return { ok: false, released, refusal: { code: 'QUEUE_EMPTY', message: 'تعذر سحب طلب، حاول مجدداً.' } };
  }, PULL_TRANSACTION_OPTIONS);
}
