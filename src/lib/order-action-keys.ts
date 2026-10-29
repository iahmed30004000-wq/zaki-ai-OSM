/**
 * THE ORDER ACTIONS THAT GOT A BOX EACH (perm-plan PR-6), AND THE KEY(S) EACH DOOR ASKED BEFORE.
 *
 * Seven keys. Until now their doors asked for a key that meant something wider:
 *
 *   orders.change_price       ← orders.edit           (the price, the discount and a line's price rode on «تعديل الطلبات»)
 *   orders.change_fee         ← orders.change_status  (the delivery fee rode on «تغيير حالة الشحن»)
 *   orders.cancel             ← orders.unlock         (cancelling and voiding rode on «تجاوز أقفال التحرير»)
 *   orders.note               ← orders.view | confirmation.work   (writing a note rode on the work door)
 *   orders.request_change     ← orders.view | confirmation.work   (raising a change request rode on the work door)
 *   orders.rating_link        ← orders.view           (the review link rode on «عرض الطلبات»)
 *   control.blacklist_manage  ← control.blacklist     (blocking and releasing a number rode on seeing the list)
 *
 * `from` is OR: whoever held ANY of them yesterday passed the door, so whoever held any of them holds the new key today.
 * `copyScope` is for the one key whose old door evaluated a SCOPE (orders.edit: all / mine / assigned): the new key keeps
 * the same scope, or an agent who edits only her own orders would price every order of the company.
 *
 * The migration 20261030130000_order_action_keys writes it into the database from the same list (a test reads the SQL and
 * this table side by side), and the in-code fallback in permissions-core applies it to a person with no stored role.
 *
 * `orders.cancel` is NOT also given to `ops.ship` holders (the old plan said it should): the stand-down door, which is the
 * only one that asks `ops.ship`, has not moved onto this key in this change, and giving the box to people whose door did
 * not ask for it would open the three cancel doors to them. PR-8 moves that door and adds the source then.
 */
export interface OrderActionKey {
  readonly key: string;
  readonly from: readonly string[];
  readonly copyScope: boolean;
}

export const ORDER_ACTION_KEYS_FROM: readonly OrderActionKey[] = [
  { key: 'orders.change_price', from: ['orders.edit'], copyScope: true },
  { key: 'orders.change_fee', from: ['orders.change_status'], copyScope: false },
  { key: 'orders.cancel', from: ['orders.unlock'], copyScope: false },
  { key: 'orders.note', from: ['orders.view', 'confirmation.work'], copyScope: false },
  { key: 'orders.request_change', from: ['orders.view', 'confirmation.work'], copyScope: false },
  { key: 'orders.rating_link', from: ['orders.view'], copyScope: false },
  { key: 'control.blacklist_manage', from: ['control.blacklist'], copyScope: false },
];
