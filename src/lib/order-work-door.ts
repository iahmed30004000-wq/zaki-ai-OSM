import type { SessionUser } from '@/types/auth';
import { can } from './authorization';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE DOOR OF THE ORDER SHE HOLDS.
 *
 * «كموظف تأكيد ماتقدر تسحب او تعدل على طلب الا اذا كانت ظاهرة عندك كل
 * الطلبات اللي بالموقع..»
 *
 * Every single-order door used to ask `orders.view` — the key of the
 * «الطلبات» LIST — and then that key's scope. So the only way to let an
 * agent work the order she had just pulled was to hand her a list:
 * «المسندة إليه», or the «كل الشركة» both permission screens default to.
 * Unticking «عرض الطلبات» answered 403 at every door, and «طلباتي المنشأة»
 * never matched a pulled order at all. The pull went through, the call
 * could not be recorded, every button stayed locked under «اتصل بالزبون
 * أول», and the next pull was refused until the ninety-minute release.
 *
 * This is the second door, and it is NAMED rather than slipped into what
 * `'orders.view'` means: a call site passes `ORDER_WORK_DOOR` in place of
 * the permission, to `assertOrderAccess` or `assertOrderReadable`, and
 * `the-order-she-holds.test.ts` lists every call site allowed to. One that
 * was not reviewed fails the suite.
 *
 *   WHO COMES IN — `orders.view` (exactly as before) OR `confirmation.work`.
 *   WHAT OPENS  — the orders.view scope's own orders, exactly as before,
 *                 OR the order she holds now (`heldOrderWhere`, rbac.ts),
 *                 in the company and the store she is standing in.
 *
 * It is the same predicate «طلباتي» lists (`claimedById` = her), so what
 * her desk shows is what opens — and nothing more: no colleague's order, no
 * order of the pool she has not pulled, no list. The pull stays the only
 * way into the pool. The lists (`orderListWhere`, `applyQueueFilter`) and
 * the read envelope (`orderVisibilityWhere`) are not touched by this file.
 *
 * Shipping, delivery attempts, finance and transfer stay on `'orders.view'`:
 * none of them is a door she works an order through.
 * ═══════════════════════════════════════════════════════════════════════
 */
export const ORDER_WORK_DOOR = 'door:the-order-she-holds' as const;
export type OrderWorkDoor = typeof ORDER_WORK_DOOR;

/**
 * May this person come through the door at all — before any order is read.
 *
 * Either key, never a role name: a company that builds its own «موظف
 * تأكيد» under another name gets the same door. Neither key is the same
 * refusal the old door gave, «لا تملك صلاحية «عرض الطلبات»».
 */
export function mayEnterOrderWorkDoor(user: SessionUser): boolean {
  return can(user, 'orders.view') || can(user, 'confirmation.work');
}
