import { NextResponse } from 'next/server';
import { requireSystemToken } from '@/lib/v1/system-token';
import { V1_CODE, V1Fault, requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import { ORDER_NUMBER_RE } from '@/lib/order-ref';
import { readChatOrder } from '@/lib/v1/landing-chat';

interface Ctx {
  params: Promise<{ orderNumber: string }>;
}

/**
 * GET /api/v1/landing/orders/:orderNumber?token=… — the order as the confirmation chat reads it (`ChatOrder`).
 *
 * The landing key holds `products.read` and `orders.create`, and no `orders.read`: the customer's `addonToken` is what
 * proves this order, and `orders.create` is the scope the key that placed it already holds.
 */
export async function GET(req: Request, ctx: Ctx) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'orders.create');
    const orderNumber = decodeURIComponent((await ctx.params).orderNumber);
    if (!ORDER_NUMBER_RE.test(orderNumber)) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such order');
    const token = new URL(req.url).searchParams.get('token') ?? '';

    const result = await readChatOrder(caller.companyId, orderNumber, token);
    if (!result.ok) {
      return NextResponse.json(result.body, { status: result.status, headers: { 'X-Request-Id': requestId } });
    }
    return v1Ok(requestId, result.body);
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
