import { approveAbroad, approveSchema } from '@/lib/stock-transfers';
import { transferAction } from '@/lib/stock-transfer-door';
import { requirePermission } from '@/lib/authorization';
import { afterResponse } from '@/lib/notify';
import { announceTransferSent } from '@/lib/stock-transfer-alerts';

/**
 * POST /api/inventory/transfers/:id/approve (inventory.transfer_abroad, and the owner only) — {}
 *
 * 20/11 (W7b): «اعتمد وابعت» on a transfer to another country. The request was written AWAITING_APPROVAL and moved
 * nothing; this press — the owner's, by the engine's own full-access flag, never a person who merely holds every key —
 * draws its units out of the source and puts it on the road (`stock-transfers.approveAbroad`). The receivers of the
 * destination are told then, not before.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return transferAction(req, params, {
    gate: () => requirePermission('inventory.transfer_abroad'),
    schema: approveSchema,
    audit: 'STOCK_TRANSFER_APPROVED',
    // The goods left at this press: the destination's receivers hear it now (the source and the number of products only).
    after: (companyId, t) => afterResponse(() => announceTransferSent(companyId, t)),
    run: (tx, p) =>
      approveAbroad(tx, {
        companyId: p.companyId,
        storeId: p.storeId,
        transferId: p.transferId,
        approvedById: p.userId,
        isOwner: p.isOwner,
        mayUse: p.mayUse,
      }),
  });
}
