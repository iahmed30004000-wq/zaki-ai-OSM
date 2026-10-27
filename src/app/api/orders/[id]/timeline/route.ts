import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { apiErrorResponse } from '@/lib/api-error';
import { orderTimeline } from '@/lib/order-timeline';
import { deriveCoreState, getZone, type StateSource } from '@/lib/order-state';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';

/**
 * GET /api/orders/:id/timeline — the merged history of one order, plus its
 * derived state, so a screen can never show a status that disagrees with
 * the events below it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    // The order window's history — open to the order she holds (order-work-door.ts).
    const access = await assertOrderReadable(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const order = access.order as StateSource & { orderNumber: string };

    const events = await orderTimeline(db, id);
    const state = deriveCoreState(order);

    return NextResponse.json({
      orderNumber: order.orderNumber,
      state,
      zone: getZone(state),
      count: events.length,
      events,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
