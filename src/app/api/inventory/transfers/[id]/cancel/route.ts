import { cancelSchema, cancelTransfer } from '@/lib/stock-transfers';
import { transferAction } from '@/lib/stock-transfer-door';
import { requirePermission } from '@/lib/authorization';

/**
 * POST /api/inventory/transfers/:id/cancel (inventory.transfer) — { reason }
 *
 * Before any receipt only: the units on the road go back to the source warehouse, with a reversing line in the ledger.
 * Nothing is deleted. After a receipt the only way back is a transfer the other way.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return transferAction(req, params, {
    gate: () => requirePermission('inventory.transfer'),
    schema: cancelSchema,
    audit: 'STOCK_TRANSFER_CANCELLED',
    run: (tx, p) =>
      cancelTransfer(tx, {
        companyId: p.companyId,
        storeId: p.storeId,
        transferId: p.transferId,
        cancelledById: p.userId,
        body: p.body,
        mayUse: p.mayUse,
      }),
  });
}
