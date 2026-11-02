import type { SessionUser } from '@/types/auth';
import { can } from './authorization';
import { PRICE_KEY_REQUIRED_AR } from './change-request-fields';
import { EDIT_CONFIRMED_KEY } from './edit-confirmed-key';
import { editWindowOpen } from './edit-confirmed-window';

/**
 * WHO DECIDES A CHANGE REQUEST.
 *
 * It depends on how far the order has travelled, because the only person
 * who can answer "can this still be changed?" is the person currently
 * holding it.
 *
 *   NOT YET CONFIRMED, and somebody has it — the agent holding it decides.
 *   She is on the phone with the customer; a moderator wanting to change a
 *   quantity is asking HER whether it is too late, and routing that to a
 *   supervisor who has never spoken to this customer adds a wait and
 *   subtracts the only informed opinion.
 *
 *   CONFIRMED AND STILL IN THE WAREHOUSE — the warehouse decides too. The
 *   question at this stage is «can what goes in the box still change?»,
 *   and the only person who knows is the one standing at the packing
 *   table. Asked for in as many words: «مين بشوفه؟ المالك، السوبر أدمن،
 *   والمسؤول عن المخزن» — and «بس في حالة إنشاء شحنة وما انترحّل للشحن».
 *
 *   ONCE THE COURIER HAS TAKEN IT — the supervisor alone. The order is
 *   on a van and the question is now whether the courier can still be
 *   reached, which is neither the agent's authority nor the warehouse's.
 *
 *   THE LINE IS THE HANDOVER, NOT THE PRINTER. This first used
 *   `hasLeftWarehouse` — which starts at the printed waybill — and that
 *   is the wrong line for THIS question: a label coming off the printer
 *   commits the goods, but the box is still three feet away and can still
 *   be opened. «بحالة ما انضغط على زر سلّمت الشركة… ولما يوافق يقدر يعدل
 *   حقيقة عشان تظهر بالطباعة» — the approval is what the reprint shows.
 *   So the line is `handedToCourier`, and the two questions keep their
 *   two answers.
 *
 *   CONFIRMED, NOT IN A BATCH, AND THE HOLDER HAS THE KEY — she decides too
 *   (2/11). The owner: «بدي التعديل التأجيل أو الالغاء … أضيفهم كصلاحية انو
 *   يقدرو يعدلو ع الطلب لغاية مرحلة الشحنة. مجرد ما الشحنة اتوزعت ع شركة شحن
 *   ودخلت باتش ما بقدرو يعدلو، بصير يقدمو طلب تعديل». So the agent HOLDING a
 *   confirmed order, who holds `orders.edit_confirmed`, answers «can this still
 *   be changed?» herself for as long as the order is on no trolley and the
 *   courier has not taken it — she is on the phone with the customer and the
 *   packing table has not touched the box. This ADDS a decider; it removes
 *   none: the warehouse and the supervisors decide exactly when they did. The
 *   window ends at BATCH ENTRY (`inBatch`), which is earlier than the seal and
 *   earlier than the handover. See edit-confirmed-window.ts, which holds the
 *   predicate once for this file and for the screens.
 *
 * A supervisor may decide either way. The agent might be off shift, the
 * request might be urgent, and an escalation path that stops working
 * because one person went home is not a path.
 *
 * Nobody decides their own request. That rule lives in the route and is
 * older than this file; it is named here only so the two are read together.
 */

/** Confirmation is the line: after it, the order belongs to operations. */
export const BEFORE_OPERATIONS = ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'];

export interface RoutingSource {
  confirmationStatus: string;
  /** The agent who pulled it from the pool, if anyone still holds it. */
  claimedById: string | null;
  /**
   * Has the courier actually taken it — «انضغط زر سلّمت الشركة»?
   * `handedToCourier`, computed by the caller. NOT `hasLeftWarehouse`:
   * a printed label commits the goods but leaves the box openable.
   *
   * Absent reads as «taken», which is the safe way round: a caller that
   * has not been taught to pass it denies the warehouse rather than
   * granting it on a parcel already in a van.
   */
  handedToCourier?: boolean;
  /**
   * Is the order on a trolley (`shippingBatchId` set) — the line the holder's own window ends at (`orders.edit_confirmed`)?
   *
   * Absent reads as «in a batch», the same safe way round as `handedToCourier`: a caller that has not been taught to pass it
   * simply does not open the window. Only the callers that load the order's batch say anything else.
   */
  inBatch?: boolean;
}

export type Decider =
  /** The agent holding the order, plus any supervisor. */
  | { kind: 'HOLDING_AGENT'; userId: string }
  /** The packing table, plus any supervisor. */
  | { kind: 'WAREHOUSE' }
  /** Supervisors only. */
  | { kind: 'SUPERVISOR' };

export function deciderFor(order: RoutingSource): Decider {
  if (BEFORE_OPERATIONS.includes(order.confirmationStatus) && order.claimedById) {
    return { kind: 'HOLDING_AGENT', userId: order.claimedById };
  }
  // Confirmed and the courier has not taken it: the box can still be
  // opened, so the person who would open it may answer.
  if (!BEFORE_OPERATIONS.includes(order.confirmationStatus) && order.handedToCourier === false) {
    return { kind: 'WAREHOUSE' };
  }
  return { kind: 'SUPERVISOR' };
}

/**
 * What the packing table holds: the permission that names it, `ops.decide_changes` (PR-7).
 *
 * It was `ops.ship` OR the role name `WAREHOUSE`. The migration 20261030140000_confirmation_split_keys gave the key to
 * every holder of `ops.ship` and every person whose role is `WAREHOUSE`, so the same people stand at the table the day
 * after — and from then on the owner can untick one of them without touching the rest.
 */
function isWarehouse(user: SessionUser): boolean {
  return can(user, 'ops.decide_changes');
}

export interface RoutingVerdict {
  allowed: boolean;
  decider: Decider;
  /** Why not, in Arabic, for a refusal somebody can act on. */
  reason?: string;
  /** Set when the only thing missing is the price key, so a caller can say that instead of «not the decider». */
  code?: 'PRICE_KEY_REQUIRED';
  /**
   * WHICH RULE ALLOWED IT, when it was the holder's own window (`orders.edit_confirmed`) and no earlier rule: the raising route
   * writes a decision note that says so. Absent for every other decider — a supervisor or the packing table keeps its verdict
   * and its sentence exactly as before. (The two doors that carry out a cancel or a hold ask `holdsTheWindow`, not this.)
   */
  via?: 'EDIT_CONFIRMED';
}

/**
 * THE ROLES THAT DECIDED BY NAME, AND WHY THE NAME STOPPED COUNTING.
 *
 * Four role names could once decide a change request whatever their permissions, and a list of names is incomplete the
 * day it is written. `control.change_requests` decides everything now; the four names (and the one the packing table
 * read) live only in `confirmation-split-keys.ts`, as the list the migration gave a key to.
 */

/**
 * A supervisor by authority, and no longer by job title.
 *
 * `SUPER_ADMIN` is not special-cased here either: it holds every
 * permission in this system, so it holds this one.
 */
function isSupervisor(user: SessionUser): boolean {
  return can(user, 'control.change_requests');
}

/**
 * THE HOLDER'S OWN WINDOW, AS A QUESTION ABOUT A PERSON AND AN ORDER (`orders.edit_confirmed`, 2/11).
 *
 * The key AND the order — she holds it, it is confirmed, it is on no trolley and the courier has not taken it
 * (`editWindowOpen`, edit-confirmed-window.ts). Asked by `mayDecide` (last, so it only ever adds a decider) and by the two doors
 * that carry out a cancellation or a hold on a request she decided herself, so a door never has to guess WHICH rule let her:
 * a person who is also a warehouse hand is a decider by that rule first, and her window is open all the same.
 */
export function holdsTheWindow(user: SessionUser, order: RoutingSource): boolean {
  return (
    can(user, EDIT_CONFIRMED_KEY) &&
    editWindowOpen({
      userId: user.id,
      confirmationStatus: order.confirmationStatus,
      claimedById: order.claimedById,
      inBatch: order.inBatch,
      handedToCourier: order.handedToCourier,
    })
  );
}

/**
 * `money` — the request asks for a price, a discount, a quantity or a product. Deciding it then needs `orders.change_price`
 * BESIDES the right to decide at this stage (PR-7): the desk, the packing table and the agent holding the order all passed
 * on the day it shipped, because the migration gave the key to every one of them, so no stage loses its decision — and from
 * then on the owner can keep the final say on a figure to whoever he chooses. The scope is not compared: the key is asked
 * as «do you hold it», as the stage keys are.
 */
export function mayDecide(user: SessionUser, order: RoutingSource, opts: { money?: boolean } = {}): RoutingVerdict {
  const decider = deciderFor(order);
  const priceMissing = opts.money === true && !can(user, 'orders.change_price');
  const refusedForPrice: RoutingVerdict = { allowed: false, decider, reason: PRICE_KEY_REQUIRED_AR, code: 'PRICE_KEY_REQUIRED' };

  // Always available, so an escalation path never depends on one person
  // being at their desk.
  if (isSupervisor(user)) return priceMissing ? refusedForPrice : { allowed: true, decider };

  if (decider.kind === 'HOLDING_AGENT' && decider.userId === user.id) {
    return priceMissing ? refusedForPrice : { allowed: true, decider };
  }

  if (decider.kind === 'WAREHOUSE' && isWarehouse(user)) {
    return priceMissing ? refusedForPrice : { allowed: true, decider };
  }

  /*
   * THE HOLDER'S OWN WINDOW (`orders.edit_confirmed`, 2/11), placed LAST so it only ever ADDS a decider: everybody the three
   * branches above let through is let through by them, with the verdict they always gave. What is left is the agent who holds a
   * CONFIRMED order, holds the key, and has an order that is on no trolley and not with the courier. The money rule is the
   * one above, unchanged: a request that moves a figure also needs `orders.change_price`.
   */
  if (holdsTheWindow(user, order)) {
    return priceMissing
      ? refusedForPrice
      : { allowed: true, decider: { kind: 'HOLDING_AGENT', userId: user.id }, via: 'EDIT_CONFIRMED' };
  }

  return {
    allowed: false,
    decider,
    reason:
      decider.kind === 'HOLDING_AGENT'
        ? 'هذا الطلب بيد موظف التأكيد الذي يعمل عليه — هو أو المشرف يبتّ في التعديل.'
        : decider.kind === 'WAREHOUSE'
          ? 'الطلب في المستودع — المسؤول عن المخزن أو المشرف يبتّ في التعديل.'
          : 'الطرد سُلّم لشركة الشحن — المشرف وحده يبتّ في التعديل، ويكون بمراسلتهم.',
  };
}
