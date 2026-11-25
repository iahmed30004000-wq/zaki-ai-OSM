import { Prisma } from '@prisma/client';
import { requirePermission } from '@/lib/authorization';
import { pressSchema, submitCount } from '@/lib/stock-counts';
import { countAction } from '@/lib/stock-count-door';
import { TX_OPTIONS } from '@/lib/stock-transfer-door';

/**
 * POST /api/inventory/counts/:id/submit (inventory.count) — no body
 *
 * The keeper is done: every line answered, and the expected figure of each line is FROZEN on it, all read in ONE
 * snapshot (REPEATABLE READ — a delivery committing half way is seen by every read or by none). The answer stays blind
 * for a keeper without `inventory.count_approve`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return countAction(req, params, {
    gate: () => requirePermission('inventory.count'),
    schema: pressSchema,
    audit: 'STOCK_COUNT_SUBMITTED',
    txOptions: { ...TX_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    run: (tx, p) => submitCount(tx, { companyId: p.companyId, storeId: p.storeId, countId: p.countId, userId: p.userId, mayUse: p.mayUse }),
  });
}
