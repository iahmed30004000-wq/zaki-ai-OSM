/**
 * /api/abandoned-carts/:id — ONE CART.
 *
 *   GET    everything about it: the data Zaki pages sent, the team's status, attempts, follow-up and assignee, the
 *          linked order, «له طلب», and the history and notes newest first — under the same scope as the list.
 *   PATCH  one press: `{ action: "status", status }` · `{ action: "no_answer" }` · `{ action: "note", text }` ·
 *          `{ action: "follow_up", at }` · `{ action: "assign", userId }`. See `actOnCart`.
 *
 * A cart this person may not see answers 404, never «exists but not yours».
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { ruleFor } from '@/lib/phone-rules';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { CART_STATUSES, cartPhoneShown } from '@/lib/abandoned-cart-rules';
import { actOnCart, cartPowers, findVisibleCart, ordersBehindCarts, type CartAction } from '@/lib/abandoned-carts';

interface Ctx {
  params: Promise<{ id: string }>;
}

const NOT_FOUND = { error: 'السلة غير موجودة.' };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const { id } = await ctx.params;
    const seen = await findVisibleCart(user, { companyId, storeId, countryCode: country.code }, id);
    if (!seen) return NextResponse.json(NOT_FOUND, { status: 404 });

    const cart = await db.abandonedCart.findFirst({
      where: { id: seen.id, companyId },
      select: {
        id: true,
        externalId: true,
        source: true,
        landingPageId: true,
        landingPageName: true,
        landingPageUrl: true,
        productId: true,
        productName: true,
        customerName: true,
        phone: true,
        phoneNormalized: true,
        city: true,
        country: true,
        firstSeenAt: true,
        lastSeenAt: true,
        status: true,
        attempts: true,
        nextFollowUpAt: true,
        createdAt: true,
        updatedAt: true,
        region: { select: { id: true, name: true } },
        product: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true } },
        order: { select: { id: true, orderNumber: true, confirmationStatus: true, createdAt: true } },
        activities: {
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: {
            id: true,
            action: true,
            fromStatus: true,
            toStatus: true,
            note: true,
            metadata: true,
            createdAt: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!cart) return NextResponse.json(NOT_FOUND, { status: 404 });

    const behind = await ordersBehindCarts(companyId, [cart]);
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'السلات المهجورة', rows: [{ phone: cart.phoneNormalized }] });
    const powers = cartPowers(user);
    const people = powers.assign
      ? await db.user.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
      : [];

    const { phoneNormalized, product, ...rest } = cart;
    return NextResponse.json({
      cart: {
        ...rest,
        productName: product?.name ?? rest.productName,
        productId: product?.id ?? null,
        phoneShown: cartPhoneShown(phoneNormalized, rest.country ?? country.code) || rest.phone,
        hasOrder: behind.get(cart.id) ?? null,
      },
      people,
      dialCode: ruleFor(country.code)?.dialCode ?? null,
      may: powers,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), status: z.enum(CART_STATUSES) }),
  z.object({ action: z.literal('no_answer') }),
  z.object({ action: z.literal('note'), text: z.string().trim().min(1).max(1000) }),
  z.object({ action: z.literal('follow_up'), at: z.string().max(64).nullable() }),
  z.object({ action: z.literal('assign'), userId: z.string().min(1).max(64).nullable() }),
]);

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const { id } = await ctx.params;
    const cart = await findVisibleCart(user, { companyId, storeId, countryCode: country.code }, id);
    if (!cart) return NextResponse.json(NOT_FOUND, { status: 404 });

    const parsed = actionSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });

    let input: CartAction;
    if (parsed.data.action === 'follow_up') {
      const at = parsed.data.at ? new Date(parsed.data.at) : null;
      if (at && Number.isNaN(at.getTime())) return NextResponse.json({ error: 'موعد المتابعة غير مقروء.' }, { status: 400 });
      input = { action: 'follow_up', at };
    } else {
      input = parsed.data as CartAction;
    }

    const done = await actOnCart(user, companyId, cart, input);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
    return NextResponse.json({ ok: true, status: done.status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
