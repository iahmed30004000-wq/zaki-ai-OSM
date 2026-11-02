/**
 * «طلباتي المنشأة» — DID THIS PERSON ENTER THE ORDER, BY EITHER RECORD OF IT.
 *
 * `moderatorId` is the old record and names the responsible moderator, which is not always who typed it: a person holding
 * `orders.assign` who types an order and names nobody leaves it null (responsible-moderator.ts). `createdById` is who TYPED
 * it, written on every staff creation door. The read and the list of the OWN scope have asked both since the column
 * existed (`orderVisibilityWhere`); the write doors asked only the first, so an order in his list, that opened, answered
 * «غير موجود» to his edit. One predicate, read by `authorize` (authorization.ts) and by both write doors in rbac.ts, so the three cannot
 * drift again. Its own file because tests replace authorization.ts with a stub and the doors must keep it.
 * Nothing was backfilled: an old order has only `moderatorId`, and it still answers through it.
 */
export function enteredBy(order: { createdById?: string | null; moderatorId?: string | null }, userId: string): boolean {
  return (!!order.createdById && order.createdById === userId) || (!!order.moderatorId && order.moderatorId === userId);
}
