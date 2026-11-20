import { rejectExit, rejectSchema } from '@/lib/stock-exits';
import { exitAction } from '@/lib/stock-exit-door';
import { requirePermission } from '@/lib/authorization';

/**
 * POST /api/inventory/exits/:id/reject (inventory.exit_approve) — { reason }
 *
 * A DIFFERENT person than the one who asked says no, with a reason. The units the request held are free again; the
 * shelf and the ledger are not touched, and nothing is deleted.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return exitAction(req, params, {
    gate: () => requirePermission('inventory.exit_approve'),
    schema: rejectSchema,
    audit: 'STOCK_EXIT_REJECTED',
    run: (tx, p) =>
      rejectExit(tx, { companyId: p.companyId, storeId: p.storeId, exitId: p.exitId, decidedById: p.userId, mayUse: p.mayUse, body: p.body }),
  });
}
