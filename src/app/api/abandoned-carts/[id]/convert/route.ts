import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { convertCart, findVisibleCart } from '@/lib/abandoned-carts';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/abandoned-carts/:id/convert `{ orderId }` — «حوّل لطلب», the second half.
 *
 * The order itself was made a moment ago by the ordinary order door (`POST /api/orders`, from the «طلب سريع جديد» form
 * filled from this cart): its validation, blacklist, pricing, history and notice, untouched. This only ties the cart to
 * that order — CONVERTED, with a history line and an audit row in the person's name. See `convertCart`.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const { id } = await ctx.params;
    const cart = await findVisibleCart(user, { companyId, storeId, countryCode: country.code }, id);
    if (!cart) return NextResponse.json({ error: 'السلة غير موجودة.' }, { status: 404 });

    const parsed = z.object({ orderId: z.string().min(1).max(64) }).safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'رقم الطلب ناقص.' }, { status: 400 });

    const done = await convertCart(user, { companyId, storeId }, cart, parsed.data.orderId);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
    return NextResponse.json({ ok: true, status: done.status, orderNumber: done.orderNumber });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
