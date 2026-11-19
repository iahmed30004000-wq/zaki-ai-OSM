import { approveDifference, differenceSchema } from '@/lib/stock-transfers';
import { transferAction } from '@/lib/stock-transfer-door';

/**
 * POST /api/inventory/transfers/:id/difference (inventory.difference_approve) — { type: 'LOSS' | 'DAMAGE', reason }
 *
 * A transfer received short leaves the missing units on the road until this approval: a THIRD person — neither the
 * sender nor the receiver, by this door or any replay of it — says why, and the units leave the store as a loss or as
 * damage. Nothing is posted to a profit, a wallet or an expense.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return transferAction(req, params, {
    key: 'inventory.difference_approve',
    schema: differenceSchema,
    audit: 'STOCK_TRANSFER_DIFFERENCE_APPROVED',
    run: (tx, p) =>
      approveDifference(tx, {
        companyId: p.companyId,
        storeId: p.storeId,
        transferId: p.transferId,
        approvedById: p.userId,
        body: p.body,
        mayUse: p.mayUse,
      }),
  });
}
