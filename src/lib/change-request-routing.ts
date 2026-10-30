import type { SessionUser } from '@/types/auth';
import { can } from './authorization';
import { PRICE_KEY_REQUIRED_AR } from './change-request-fields';

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
