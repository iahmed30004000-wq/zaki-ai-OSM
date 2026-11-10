/**
 * /api/telegram/upsell-products — «أسماء المنتجات (الأب سيل والأسماء القديمة)» of the SELECTED store.
 *
 *   GET  (telegram.view)   → `{ rows, products, currency }`: every name, on or off; the store's ACTIVE products for the select;
 *                             the store's currency and its decimals.
 *   POST (telegram.manage) → one new name: `{ kind, incomingName, productId, extraUnits?, linePrice?, offerAliases?, isActive? }`.
 *
 * The match key (`foldedName`) is computed here, never taken from the client, and is unique per store across both kinds (409).
 * A name may only point at an ACTIVE product of this store. There is no DELETE anywhere: a name is switched off
 * (`PATCH /[id]` with `isActive: false`), so a message read again later still finds out what it was. Every write is audited.
 */
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { aliasColumns, aliasInputSchema } from '@/lib/telegram/aliases';
import { ROW_SELECT, activeProductOf, firstIssue, storeOf, view } from '@/lib/telegram/alias-store';

export async function GET() {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('telegram.view');
    const store = await storeOf(companyId, storeId);
    if (!store) return NextResponse.json({ error: 'المتجر مش موجود' }, { status: 404 });

    const [rows, products] = await Promise.all([
      db.telegramUpsellProduct.findMany({
        where: { companyId, storeId },
        orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }],
        select: ROW_SELECT,
      }),
      db.product.findMany({
        where: { companyId, storeId, status: 'ACTIVE' },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
    ]);
    return NextResponse.json({ rows: rows.map(view), products, currency: store.country });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('telegram.manage');
    const store = await storeOf(companyId, storeId);
    if (!store) return NextResponse.json({ error: 'المتجر مش موجود' }, { status: 404 });

    const parsed = aliasInputSchema(store.country.minorUnit).safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    const product = await activeProductOf(companyId, storeId, parsed.data.productId);
    if (!product) return NextResponse.json({ error: 'المنتج مش فعّال بهالمتجر' }, { status: 400 });

    const columns = aliasColumns(parsed.data);
    const taken = await db.telegramUpsellProduct.findFirst({ where: { companyId, storeId, foldedName: columns.foldedName }, select: { id: true } });
    if (taken) return NextResponse.json({ error: 'هالاسم موجود بالقائمة — عدّله بدل ما تضيفه مرة تانية' }, { status: 409 });

    let row;
    try {
      row = await db.telegramUpsellProduct.create({
        data: {
          companyId,
          storeId,
          ...columns,
          offerAliases: columns.offerAliases ?? Prisma.DbNull,
          isActive: parsed.data.isActive ?? true,
        },
        select: ROW_SELECT,
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        return NextResponse.json({ error: 'هالاسم موجود بالقائمة — عدّله بدل ما تضيفه مرة تانية' }, { status: 409 });
      }
      throw e;
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: 'TELEGRAM_ALIAS_CREATED',
      entity: 'TelegramUpsellProduct',
      entityId: row.id,
      newData: { storeId, ...columns, productName: product.name, isActive: row.isActive },
    });
    return NextResponse.json({ row: view(row) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
