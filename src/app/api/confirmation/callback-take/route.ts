import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { orderVisibilityWhere } from '@/lib/rbac';
import { CALLBACK_MESSAGES, takeOnTheLine } from '@/lib/customer-on-the-line';

/**
 * «الزبون على الخط» — `customer-on-the-line.ts` holds the rule; this door asks who is calling and says the answer.
 *
 *   POST /search { phone }   the orders of that number (`search/route.ts`) — in the BODY, never the address: a customer's number
 *                            does not belong in a URL, a server log or a browser history.
 *   POST { orderId }         take one, if it is a released retry (see the rule). The pull's write, reason `CUSTOMER_CALLED_BACK`.
 *
 * Both ask the three keys an agent works with: `confirmation.pull` (she is somebody the queue gives orders to),
 * `confirmation.work` (she works what she holds) and `orders.view` (the search reads orders, inside her envelope).
 */

const QUEUE_BUSY_MESSAGE = 'الطابور مشغول لحظة — جرّبي مرة تانية';

/** The three keys — asked word for word by the search door too (`search/route.ts`). */
async function asked() {
  const ctx = await requireContext();
  await requirePermission('confirmation.pull');
  await requirePermission('confirmation.work');
  await requirePermission('orders.view');
  return ctx;
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await asked();
    const body = (await req.json().catch(() => ({}))) as { orderId?: unknown };
    const orderId = typeof body.orderId === 'string' ? body.orderId.trim().slice(0, 64) : '';
    if (!orderId) {
      return NextResponse.json({ error: CALLBACK_MESSAGES.NOT_FOUND, errorAr: CALLBACK_MESSAGES.NOT_FOUND, code: 'NOT_FOUND' }, { status: 404 });
    }

    const result = await takeOnTheLine({
      scope: { companyId, storeId },
      user: { id: user.id, role: user.role },
      orderId,
      visibility: orderVisibilityWhere(user),
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, errorAr: result.message, code: result.code, ...(result.heldBy !== undefined ? { heldBy: result.heldBy } : {}) },
        { status: result.code === 'NOT_FOUND' ? 404 : 409 }
      );
    }
    return NextResponse.json(result, { status: result.alreadyYours ? 200 : 201 });
  } catch (error) {
    // The customer's lock or the pool ran out of time (see the pull door): nothing was written, a second press is safe.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028') {
      return NextResponse.json(
        { error: QUEUE_BUSY_MESSAGE, errorAr: QUEUE_BUSY_MESSAGE, code: 'QUEUE_BUSY' },
        { status: 503, headers: { 'Retry-After': '1' } }
      );
    }
    return apiErrorResponse(error);
  }
}
