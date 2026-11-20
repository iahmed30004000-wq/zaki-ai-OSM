import { requirePermission } from '@/lib/authorization';
import { approveCount, pressSchema } from '@/lib/stock-counts';
import { countAction } from '@/lib/stock-count-door';

/**
 * POST /api/inventory/counts/:id/approve (inventory.count_approve) — no body
 *
 * A DIFFERENT person than everybody who opened, counted or submitted the sheet applies each line's difference
 * (counted − frozen expected) in the sheet's warehouse, by the recount's own arithmetic: a surplus at the cost of the
 * newest batch that holds units (refused when there is none or it was never costed), a shortfall drawn oldest first.
 * One ledger line per product, MANUAL_ADJUSTMENT, carrying the sheet's id. Nothing is posted to a profit, a wallet or an
 * expense.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return countAction(req, params, {
    gate: () => requirePermission('inventory.count_approve'),
    schema: pressSchema,
    audit: 'STOCK_COUNT_APPROVED',
    run: (tx, p) => approveCount(tx, { companyId: p.companyId, storeId: p.storeId, countId: p.countId, userId: p.userId, mayUse: p.mayUse }),
  });
}
