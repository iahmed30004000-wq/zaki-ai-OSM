import type { SessionUser } from '@/types/auth';
import { userCan, userHasFullAccess } from './can';
import { EDIT_CONFIRMED_KEY } from './edit-confirmed-key';
import { handedToCourier, orderSeal } from './order-seal';
import type { ChangeIntent } from './change-request-intent';

/**
 * THE WINDOW IN WHICH A CONFIRMATION AGENT CHANGES HER OWN CONFIRMED ORDER HERSELF.
 *
 * The owner, 2/11: «بدنا نسرع شغل البنات. بدي التعديل التأجيل أو الالغاء … أضيفهم كصلاحية انو يقدرو يعدلو ع الطلب لغاية
 * مرحلة الشحنة. مجرد ما الشحنة اتوزعت ع شركة شحن ودخلت باتش ما بقدرو يعدلو، بصير يقدمو طلب تعديل. حلها بدون تعارض او مشاكل.»
 *
 * Until that day a confirmed order was read-only for the agent who confirmed it: every change was a request that sat in
 * somebody else's queue (the packing table or a supervisor), and the customer was on the phone while she waited. Now there
 * is a KEY (`orders.edit_confirmed`, a box the owner ticks) and a WINDOW. The window is shut by whichever comes first:
 *
 *   · the order enters a batch — the packing table has put it on a trolley (`shippingBatchId` is set). That is EARLIER than
 *     the seal (`order-seal.ts`: a printed waybill, a pressed trolley) and than the handover, and it is the line the owner
 *     drew: «ودخلت باتش ما بقدرو يعدلو»;
 *   · the courier has taken the parcel (`handedToCourier`) — a parcel marked shipped by hand sits in no batch at all.
 *
 * AND IT IS HERS: the window is open to the agent HOLDING the order (`claimedById`), nobody else. An agent acting on a
 * colleague's order still waits for a decision, exactly as before. The key and the holding are asked TOGETHER.
 *
 * …AND THE OWNER'S (3/11): «انتا ادخل وعدل». The one person with FULL ACCESS (SUPER_ADMIN — `fullAccess` in the permission
 * engine) has the same window on EVERY order, held or not: confirmed, on no trolley, not with the courier, and an edit still
 * stopped by the seal. Not a manager, not a supervisor, not a moderator, whatever keys they hold — full access is not a key
 * anybody can be ticked, it is the owner's role (role-names.ts reserves the name). The facts carry it as `fullAccess`, so the
 * server (`holdsTheWindow`, from the engine's grants) and the screen (`editsNow`, from the session's role) ask ONE predicate.
 *
 * WHAT THE WINDOW OPENS IS NOT A NEW DOOR. A change made inside it is still a change REQUEST — raised, decided (by her, on
 * the spot) and carried out through the doors that already do each thing (the order's own money path for an edit, `endOrder`
 * for a cancel, the hold for a postponement). The window only decides WHO MAY DECIDE: `mayDecide` (change-request-routing.ts)
 * asks it, so the self-decision of the raising route and the apply step of the order route read ONE predicate. This file is
 * that predicate, written once and client-safe, so the screens ask the same question the server answers.
 *
 * SAFE WAY ROUND, AS EVERYWHERE ELSE IN THIS AREA: a caller that does not say whether the order is in a batch, or whether the
 * courier has it, is read as «in a batch» and «taken» — the window stays shut.
 */

/** What the request's decision note says when it was applied under this window — a fact about who did what, in plain Arabic. */
export const EDIT_WINDOW_NOTE_AR =
  'طُبِّق مباشرةً — رافعه يملك «تعديل الطلب المؤكَّد قبل الدفعة» والطلب لم يدخل دفعة شحن بعد.';

/** …and when it was the OWNER's window (full access, 3/11) — the same fact, said of him. */
export const EDIT_WINDOW_OWNER_NOTE_AR = 'طُبِّق مباشرةً — المالك، والطلب لم يدخل دفعة شحن بعد.';

export interface EditWindowFacts {
  /** The person asking — the window is hers only if she holds the order. */
  userId: string;
  /** The person has FULL ACCESS (the owner): the window is his on any order, held or not. Absent reads as «no». */
  fullAccess?: boolean;
  confirmationStatus: string;
  /** The agent who holds the order. */
  claimedById: string | null | undefined;
  /** The order sits on a trolley (`shippingBatchId`). Absent reads as «in a batch». */
  inBatch?: boolean;
  /** The courier has taken the parcel. Absent reads as «taken». */
  handedToCourier?: boolean;
}

/** Is the window open for this person on this order? The key is asked beside this, never instead of it. */
export function editWindowOpen(f: EditWindowFacts): boolean {
  const hers = !!f.claimedById && f.claimedById === f.userId;
  return (
    f.confirmationStatus === 'CONFIRMED' &&
    (hers || f.fullAccess === true) &&
    f.inBatch === false &&
    f.handedToCourier === false
  );
}

/** What a screen knows of the order — every field optional, because an order a screen holds may be a partial read. */
export interface WindowOrder {
  confirmationStatus: string;
  claimedById?: string | null;
  shippingBatchId?: string | null;
  shippingBatch?: { status: string } | null;
  shippingStatus?: string | null;
  shippedAt?: Date | string | null;
  labelPrintedAt?: Date | string | null;
}

/**
 * THE SCREEN'S QUESTION: «will what I am about to send be applied at once?»
 *
 * The server is the judge and answers with `readyToApply`; this is only for the sentence the screen draws BEFORE the press
 * («بينطبق فوراً»), so it promises exactly what the server will do. It asks the same predicate (`editWindowOpen`) and the
 * same two lines `readyToApply` adds on top: an EDIT is also stopped by the seal (a printed waybill), a cancel or a
 * postponement only by the handover.
 *
 * A read that does not carry the facts (no batch field at all, no shipping status) answers false: the screen then says what it
 * always said.
 */
export function editsNow(user: SessionUser | null | undefined, order: WindowOrder, intent: ChangeIntent = 'EDIT'): boolean {
  if (!user || !userCan(user, EDIT_CONFIRMED_KEY)) return false;
  if (order.shippingStatus == null) return false;
  const batchKnown = order.shippingBatchId !== undefined || order.shippingBatch !== undefined;
  const inBatch = !batchKnown || Boolean(order.shippingBatchId) || order.shippingBatch != null;
  const handed = handedToCourier({
    shippingStatus: order.shippingStatus,
    shippedAt: order.shippedAt ?? null,
    batchStatus: order.shippingBatch?.status ?? null,
  });
  const open = editWindowOpen({
    userId: user.id,
    fullAccess: userHasFullAccess(user),
    confirmationStatus: order.confirmationStatus,
    claimedById: order.claimedById ?? null,
    inBatch,
    handedToCourier: handed,
  });
  if (!open) return false;
  if (intent !== 'EDIT') return true;
  return !orderSeal({
    shippingBatch: null,
    shippingStatus: order.shippingStatus,
    shippedAt: order.shippedAt ?? null,
    labelPrintedAt: order.labelPrintedAt ?? null,
  }).sealed;
}
