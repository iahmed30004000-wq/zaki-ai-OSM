import { receiveSchema, receiveTransfer } from '@/lib/stock-transfers';
import { transferAction } from '@/lib/stock-transfer-door';
import { requirePermission } from '@/lib/authorization';

/**
 * POST /api/inventory/transfers/:id/receive (inventory.transfer_receive) — { lines: [{ productId, quantity }] }
 *
 * The receiver types what she COUNTED of every product (never more than was sent). Counted units get the destination's
 * warehouse; what was not counted stays on the road («مستلم بفرق») until a third person approves it. The person who
 * sent the transfer may not receive it — by this door or any replay of it (`stock-transfers.receiveTransfer`).
 *
 * 20/11 (W7b): a transfer from ANOTHER store is received here too, by a person standing in the destination store: each
 * line may carry its landed cost lines ({ kind: TRANSPORT | CUSTOMS | OTHER, amount, note }) in that store's currency, and
 * the counted units open a batch of the twin at the cost they left with plus those lines (`stock-transfer-cost.ts`).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return transferAction(req, params, {
    gate: () => requirePermission('inventory.transfer_receive'),
    schema: receiveSchema,
    audit: 'STOCK_TRANSFER_RECEIVED',
    run: (tx, p) =>
      receiveTransfer(tx, {
        companyId: p.companyId,
        storeId: p.storeId,
        transferId: p.transferId,
        receivedById: p.userId,
        body: p.body,
        mayUse: p.mayUse,
        mayReachStore: p.mayReachStore,
      }),
  });
}
