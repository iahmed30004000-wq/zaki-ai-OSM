import { approveExit, approveSchema } from '@/lib/stock-exits';
import { exitAction } from '@/lib/stock-exit-door';
import { requirePermission } from '@/lib/authorization';

/**
 * POST /api/inventory/exits/:id/approve (inventory.exit_approve) — no body
 *
 * A DIFFERENT person than the one who asked (by this door or any replay of it) lets the goods leave: drawn oldest first
 * in the exit's warehouse, each line keeping the value at cost of what left, one ledger line per product of the
 * reason's type. Nothing is posted to a profit, a wallet or an expense.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return exitAction(req, params, {
    gate: () => requirePermission('inventory.exit_approve'),
    schema: approveSchema,
    audit: 'STOCK_EXIT_APPROVED',
    run: (tx, p) =>
      approveExit(tx, { companyId: p.companyId, storeId: p.storeId, exitId: p.exitId, decidedById: p.userId, mayUse: p.mayUse }),
  });
}
