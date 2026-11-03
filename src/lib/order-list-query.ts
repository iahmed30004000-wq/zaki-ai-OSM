import type { SessionUser } from '@/types/auth';
import { can, getPermissionScope } from '@/lib/authorization';
import { applyQueueFilter } from '@/lib/rbac';
import { ordersWhere } from '@/lib/order-filters';

/**
 * THE ORDERS LIST'S WHOLE QUESTION — the filters AND the person's envelope — WRITTEN ONCE.
 *
 * `GET /api/orders` asked it inline. The counts above the list and the cards beside them (`GET /api/orders/summary`) must
 * ask exactly the same question, or a chip says «مؤكد (40)» to an agent whose list, pressed, shows 12: the counts would be a
 * window onto orders she cannot open. `orderVisibilityWhere` is the read permission as well as the list filter, so the
 * envelope is not something a second door may re-spell — it takes it from here, and the test that holds the two doors to the
 * same rows is `the-counts-are-the-rows-she-can-open.test.ts`.
 *
 * What it does, in order — the same order the list always did it in:
 *   · `from`/`to` become the created-at range (the whole closing day included);
 *   · `ordersWhere` builds every filter (src/lib/order-filters.ts);
 *   · the tenant goes around it;
 *   · `applyQueueFilter` wraps it with the queue asked for — except `available`, the one queue that WIDENS, which is the
 *     supervisor's or whoever sees every order anyway.
 */
export type OrderListQuery = { ok: true; where: Record<string, any> } | { ok: false; error: string };

export function orderListQuery(
  ctx: { user: SessionUser; companyId: string; storeId: string },
  searchParams: URLSearchParams
): OrderListQuery {
  const { user, companyId, storeId } = ctx;
  const from = searchParams.get('from')?.trim();
  const to = searchParams.get('to')?.trim();
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (from) createdAt.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) createdAt.lte = new Date(`${to}T23:59:59.999Z`);

  const built = ordersWhere(searchParams, { createdAt });
  if (!built.ok) return { ok: false, error: built.error };
  const whereClause: any = { companyId, storeId, ...built.where };

  /*
   * EXCEPT THE ONE QUEUE THAT WIDENS.
   *
   * `available` is the unclaimed pool, the only queue that ADDS orders the
   * person's own envelope leaves out. The arrows door already refuses it
   * (orders/[id]/route.ts); this door honoured it, so an agent who typed
   * `?queue=available&limit=500` got the whole pool with names, phones and
   * addresses — the list the confirmation queue gives her only as a count.
   * It is the supervisor's, or someone who sees every order anyway.
   */
  const queue = searchParams.get('queue');
  const mayAskPool = can(user, 'confirmation.supervise') || getPermissionScope(user, 'orders.view')?.scope === 'ALL_COMPANY';
  return { ok: true, where: applyQueueFilter(user, whereClause, queue === 'available' && !mayAskPool ? null : queue) };
}
