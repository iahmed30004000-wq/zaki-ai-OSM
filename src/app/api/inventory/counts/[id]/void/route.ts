import { can, requirePermission } from '@/lib/authorization';
import { voidCount, voidSchema } from '@/lib/stock-counts';
import { countAction } from '@/lib/stock-count-door';

/**
 * POST /api/inventory/counts/:id/void (inventory.count or inventory.count_approve) — `{ reason }`
 *
 * Nothing is applied and nothing changes; the warehouse is free again. The opener may void her own sheet while it is
 * being counted; a holder of `inventory.count_approve` may void a sheet being counted or waiting for approval.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return countAction(req, params, {
    // Either key opens the door; the lib decides which sheet each may void.
    gate: (user) => (can(user, 'inventory.count_approve') ? Promise.resolve(user) : requirePermission('inventory.count')),
    schema: voidSchema,
    audit: 'STOCK_COUNT_VOIDED',
    run: (tx, p) =>
      voidCount(tx, {
        companyId: p.companyId,
        storeId: p.storeId,
        countId: p.countId,
        userId: p.userId,
        mayUse: p.mayUse,
        body: p.body,
        mayDecide: can(p.user, 'inventory.count_approve'),
      }),
  });
}
