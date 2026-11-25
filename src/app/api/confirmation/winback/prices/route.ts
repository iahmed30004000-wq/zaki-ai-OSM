import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { readWinbackPrices, saveWinbackPrice, validateWinbackPrice } from '@/lib/winback-prices';

/**
 * GET/PUT /api/confirmation/winback/prices — «أسعار الاسترجاع»: the win-back price of each product (`winback-prices.ts`).
 *
 * GET (the offer's box): the store's products, each with its price or none, the currency a new price starts in (the store country's),
 * and whether this person may change them. PUT (`offers.rules` — the box of the win-back rule beside it, the owner's and the admin's):
 * one product at a time, set or removed; refused in Arabic, never clamped; written down with before and after. Nothing is prefilled:
 * a product nobody priced is not offered by the bulk run.
 */
export async function GET() {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('confirmation.winback');
    const [products, prices] = await Promise.all([
      db.product.findMany({
        where: { companyId, status: 'ACTIVE', ...(storeId ? { OR: [{ storeId }, { storeId: null }] } : {}) },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 300,
      }),
      readWinbackPrices(companyId),
    ]);
    return NextResponse.json({
      canEdit: can(user, 'offers.rules'),
      currency: country?.currencyCode ?? 'USD',
      products: products.map((p) => ({ id: p.id, name: p.name, price: prices[p.id] ?? null })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('offers.rules');

    const parsed = validateWinbackPrice(await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr, errorAr: parsed.errorAr, code: parsed.code }, { status: 400 });

    const product = await db.product.findFirst({ where: { id: parsed.productId, companyId }, select: { id: true } });
    if (!product) return NextResponse.json({ error: 'المنتج مش موجود', errorAr: 'المنتج مش موجود', code: 'PRODUCT' }, { status: 404 });

    const before = (await readWinbackPrices(companyId))[parsed.productId] ?? null;
    const saved = await saveWinbackPrice(companyId, parsed.productId, parsed.price);
    await logAudit({
      companyId,
      userId: user.id,
      action: 'WINBACK_PRICE_UPDATED',
      entity: 'Product',
      entityId: parsed.productId,
      previousData: { price: before },
      newData: { price: saved[parsed.productId] ?? null },
    });
    return NextResponse.json({ productId: parsed.productId, price: saved[parsed.productId] ?? null });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
