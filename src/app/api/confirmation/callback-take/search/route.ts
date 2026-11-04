import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { orderVisibilityWhere } from '@/lib/rbac';
import { rateLimit } from '@/lib/rate-limit';
import { CALLBACK_MESSAGES, CALLBACK_SEARCHES_PER_WINDOW, CALLBACK_SEARCH_WINDOW_MS, searchOnTheLine } from '@/lib/customer-on-the-line';

/**
 * POST /api/confirmation/callback-take/search { phone } — «الزبون على الخط»: the orders of that number in her store, inside her
 * `orders.view` envelope or a released retry she could take (`customer-on-the-line.ts`) — at most ten, no name, phone or address on
 * them — each with whether she may take it and, if not, why. The same three keys as the take (`../route.ts`); counted per person.
 *
 * POST and not GET: the number travels in the body, so it never sits in an address, a server log or a browser history.
 */
export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('confirmation.pull');
    await requirePermission('confirmation.work');
    await requirePermission('orders.view');

    const limit = rateLimit(`callback-search:${user.id}`, CALLBACK_SEARCHES_PER_WINDOW, CALLBACK_SEARCH_WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: CALLBACK_MESSAGES.SEARCH_LIMIT, errorAr: CALLBACK_MESSAGES.SEARCH_LIMIT, code: 'SEARCH_LIMIT' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
      );
    }

    const sent = (await req.json().catch(() => ({}))) as { phone?: unknown };
    const phone = typeof sent.phone === 'string' ? sent.phone.slice(0, 40) : '';
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
