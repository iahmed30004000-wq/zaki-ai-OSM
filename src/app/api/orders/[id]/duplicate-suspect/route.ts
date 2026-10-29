import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { apiErrorResponse } from '@/lib/api-error';
import { TWIN_ACTION, TWIN_WINDOW_MS, twinsFromMetadata } from '@/lib/recent-twin-order';

/**
 * GET /api/orders/:id/duplicate-suspect — did this customer ask for the same product minutes before?
 *
 * The flag was written once, when the order was created (`flagRecentTwins`, called by every door that takes an order
 * for a customer). This only reads it back for the confirmation window, through the same envelope the window itself
 * opens the order with — so a reader sees the notice on exactly the orders she may open.
 *
 * It answers with the OTHER orders' numbers and nothing else: no ids, no names, no phone. The number is what a person
 * on the phone says out loud, and the order list is where she opens it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    const access = await assertOrderReadable(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: ORDER_NOT_FOUND, errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }

    const flag = await db.orderActivity.findFirst({
      where: { orderId: id, companyId, action: TWIN_ACTION },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    const twins = twinsFromMetadata(flag?.metadata).map((t) => ({ orderNumber: t.orderNumber }));

    return NextResponse.json({ suspect: twins.length > 0, twins, windowMinutes: TWIN_WINDOW_MS / 60_000 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
