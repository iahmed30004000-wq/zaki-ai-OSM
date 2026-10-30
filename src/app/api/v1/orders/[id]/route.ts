import { db } from '@/lib/db';
import { requireSystemToken } from '@/lib/v1/system-token';
import { V1_CODE, V1Fault, requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import { isoWithOffset } from '@/lib/v1/shape';
import { raisedBySystem } from '@/lib/v1/order-origin';

/**
 * GET /api/v1/orders/{id} — «where has this got to?»
 *
 * Four fields and no more: the number, the two statuses that move, and when
 * they last moved. The calling system is following up a conversation, not
 * running a dashboard — and a status read is the one call a replies system
 * makes most often, so it stays one row and one query.
 *
 * ── THE TENANT IS THE TOKEN'S, AND THE 404 IS DELIBERATE ──
 *
 * `companyId` is in the WHERE, from the token. An id belonging to another
 * company answers 404 and not 403: 403 would confirm that the id exists
 * somewhere, which is an existence oracle over every order in the product
 * for anyone holding any valid key.
 *
 * ── AND ONLY AN ORDER THIS SYSTEM RAISED (PR-13) ──
 *
 * The same 404 answers an order of the company that the calling system did not create through this door — see
 * `raisedBySystem`. The request, the answer and the headers are exactly what they were; only the WHERE narrowed.
 *
 * ── AND NOTHING ABOUT THE CUSTOMER IS IN IT ──
 *
 * No name, no phone, no address, no total. A status endpoint that carried
 * the customer would put contact details into every poll of a loop the
 * seller set to run every minute.
 */

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'orders.read');
    const { id } = await params;

    const order = await db.order.findFirst({
      where: { id, companyId: caller.companyId, ...raisedBySystem(caller.system) },
      select: {
        id: true,
        orderNumber: true,
        confirmationStatus: true,
        shippingStatus: true,
        updatedAt: true,
        store: { select: { country: { select: { timezone: true } } } },
      },
    });
    if (!order) {
      throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such order');
    }

    return v1Ok(requestId, {
      order_id: order.id,
      order_number: order.orderNumber,
      status: order.confirmationStatus,
      shipping_status: order.shippingStatus,
      // With the offset, in the zone the order happened in — «ISO 8601
      // بإزاحة المنطقة». A bare `Z` reads three hours early to anybody in
      // Amman putting two logs side by side.
      updated_at: isoWithOffset(order.updatedAt, order.store?.country?.timezone ?? 'UTC'),
    });
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
