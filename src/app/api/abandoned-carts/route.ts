/**
 * GET /api/abandoned-carts — «السلات المهجورة», a page at a time.
 * Query: status (one of the statuses, or nothing for all) · range (today | 7d | 30d) · productId · assignee (a user id,
 * «me» or «none») · q · page · limit.
 *
 * Answers `{ carts, pagination, facts, products, people, dialCode, may }`:
 *
 *   · the carts this person may see (`cartVisibilityWhere`, the orders' own scope) in the store being worked
 *     (`cartStoreWhere`), newest activity first, each with its phone as a person reads it and `hasOrder` — the order the
 *     same phone placed for the same product in the last seven days (`ordersBehindCarts`);
 *   · `facts` — the count per status under the same scope, range, product, assignee and search, so a tab that says 5
 *     shows 5;
 *   · `products` and `people` for the two filters (`people` only for whoever may assign: a list of colleagues is the
 *     supervisor's picture);
 *   · `dialCode` for the WhatsApp link, as the orders list sends it;
 *   · `may` — which presses this person's keys open, so the screen draws no button the door would refuse.
 */
import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { readLimit, readPage } from '@/lib/numeric-input';
import { ruleFor } from '@/lib/phone-rules';
import { zonedParts, zonedTimeToInstant } from '@/lib/business-calendar';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { CART_RANGES, CART_STATUSES, cartPhoneShown, isCartStatus, type CartRange } from '@/lib/abandoned-cart-rules';
import { cartPowers, cartSearchWhere, cartStoreWhere, cartVisibilityWhere, ordersBehindCarts } from '@/lib/abandoned-carts';

const NO_VIEW = { error: 'لا تملك صلاحية عرض الطلبات — والسلات معها.' };

/** «اليوم» from midnight in the store's own zone; «7 أيام» and «30 يوم» counted back from now. */
function rangeStart(range: string | null, now: Date, timeZone: string | null): Date | null {
  if (!range || !(range in CART_RANGES)) return null;
  const days = CART_RANGES[range as CartRange];
  if (days > 0) return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  try {
    const p = zonedParts(now, timeZone || 'UTC');
    return zonedTimeToInstant(timeZone || 'UTC', p.year, p.month, p.day, 0, 0);
  } catch {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const visible = cartVisibilityWhere(user);
    if (!visible) return NextResponse.json(NO_VIEW, { status: 403 });

    const params = new URL(req.url).searchParams;
    const status = params.get('status')?.trim() ?? '';
    const range = params.get('range');
    const productId = params.get('productId')?.trim() || null;
    const assignee = params.get('assignee')?.trim() || null;
    const q = params.get('q')?.trim().slice(0, 100) ?? '';
    const limit = readLimit(params, 25, 100);
    const now = new Date();
    const powers = cartPowers(user);

    const since = rangeStart(range, now, country.timezone);
    const filters: Prisma.AbandonedCartWhereInput[] = [visible, cartStoreWhere(storeId, country.code)];
    if (since) filters.push({ lastSeenAt: { gte: since } });
    if (productId) filters.push({ productId });
    if (assignee === 'none') filters.push({ assignedToId: null });
    else if (assignee === 'me') filters.push({ assignedToId: user.id });
    else if (assignee) filters.push({ assignedToId: assignee });
    if (q) filters.push(cartSearchWhere(q));
    const where: Prisma.AbandonedCartWhereInput = { companyId, AND: filters };

    const grouped = await db.abandonedCart.groupBy({ by: ['status'], where, _count: { _all: true } });
    const facts: Record<string, number> = { all: 0 };
    for (const s of CART_STATUSES) facts[s] = 0;
    for (const g of grouped) {
      facts[g.status] = (facts[g.status] ?? 0) + g._count._all;
      facts.all += g._count._all;
    }

    const chosen = isCartStatus(status) ? status : null;
    const total = chosen ? facts[chosen] : facts.all;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(readPage(params), totalPages);

    const rows = await db.abandonedCart.findMany({
      where: chosen ? { ...where, status: chosen } : where,
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        externalId: true,
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
        region: { select: { id: true, name: true } },
        product: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true } },
        order: { select: { id: true, orderNumber: true } },
      },
    });

    const behind = await ordersBehindCarts(companyId, rows, now);
    // Contact details left the building: the tally is the person's, as on every list that hands them out.
    await noteCustomersHandedOut({
      companyId,
      storeId,
      user,
      where: 'السلات المهجورة',
      rows: rows.map((r) => ({ phone: r.phoneNormalized })),
    });

    const productRows = await db.abandonedCart.groupBy({
      by: ['productId'],
      where: { companyId, AND: [visible, cartStoreWhere(storeId, country.code)], productId: { not: null } },
    });
    const productIds = productRows.map((p) => p.productId).filter((id): id is string => !!id);
    const products = productIds.length
      ? await db.product.findMany({ where: { companyId, id: { in: productIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
      : [];
    const people = powers.assign
      ? await db.user.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
      : [];

    return NextResponse.json({
      carts: rows.map(({ phoneNormalized, product, ...r }) => ({
        ...r,
        productName: product?.name ?? r.productName,
        phoneShown: cartPhoneShown(phoneNormalized, r.country ?? country.code) || r.phone,
        hasOrder: behind.get(r.id) ?? null,
      })),
      pagination: { total, page, limit, totalPages },
      facts,
      products,
      people,
      dialCode: ruleFor(country.code)?.dialCode ?? null,
      may: powers,
      me: user.id,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
