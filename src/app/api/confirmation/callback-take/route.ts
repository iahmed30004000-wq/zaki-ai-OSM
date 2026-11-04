import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { orderVisibilityWhere } from '@/lib/rbac';
import { rateLimit } from '@/lib/rate-limit';
import {
  CALLBACK_MESSAGES,
  CALLBACK_SEARCHES_PER_WINDOW,
  CALLBACK_SEARCH_WINDOW_MS,
  searchOnTheLine,
  takeOnTheLine,
} from '@/lib/customer-on-the-line';

/**
 * «الزبون على الخط» — `customer-on-the-line.ts` holds the rule; this door asks who is calling and says the answer.
 *
 *   GET  ?phone=…        the orders of that number in her store and in her `orders.view` envelope — at most ten, no name, phone
 *                        or address on them — each with whether she may take it and, if not, why. Counted per person.
 *   POST { orderId }     take one, if it is a released retry (see the rule). The pull's write, reason `CUSTOMER_CALLED_BACK`.
 *
 * Both ask the three keys an agent works with: `confirmation.pull` (she is somebody the queue gives orders to),
 * `confirmation.work` (she works what she holds) and `orders.view` (the search reads orders, inside her envelope).
 */

const QUEUE_BUSY_MESSAGE = 'الطابور مشغول لحظة — جرّبي مرة تانية';

async function asked() {
  const ctx = await requireContext();
  await requirePermission('confirmation.pull');
  await requirePermission('confirmation.work');
  await requirePermission('orders.view');
  return ctx;
}

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await asked();
    const phone = (new URL(req.url).searchParams.get('phone') ?? '').slice(0, 40);

    const limit = rateLimit(`callback-search:${user.id}`, CALLBACK_SEARCHES_PER_WINDOW, CALLBACK_SEARCH_WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: CALLBACK_MESSAGES.SEARCH_LIMIT, errorAr: CALLBACK_MESSAGES.SEARCH_LIMIT, code: 'SEARCH_LIMIT' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
      );
    }

    const orders = await searchOnTheLine(db, {
      scope: { companyId, storeId },
      userId: user.id,
      phone,
      countryCode: country.code,
      visibility: orderVisibilityWhere(user),
    });
    if (orders === null) {
      return NextResponse.json(
        { error: CALLBACK_MESSAGES.PHONE_TOO_SHORT, errorAr: CALLBACK_MESSAGES.PHONE_TOO_SHORT, code: 'PHONE_TOO_SHORT' },
        { status: 400 }
      );
    }
    return NextResponse.json({ orders });
  } catch (error) {
    return apiErrorResponse(error);
  }
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
