/**
 * PATCH /api/telegram/upsell-products/[id] — change one name of the selected store, or switch it off/on (telegram.manage).
 *
 *   · `{ isActive }` alone switches it; anything else is the whole form again (`aliasInputSchema`), validated as a new one is;
 *   · only a row of THIS company and THIS store (404 otherwise); the product must be ACTIVE in the store; the folded name must
 *     not be another row's (409);
 *   · there is no DELETE: a name is switched off, never removed (the owner: «Never delete»);
 *   · audited, with what it was and what it became.
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

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('telegram.manage');
    const store = await storeOf(companyId, storeId);
    if (!store) return NextResponse.json({ error: 'المتجر مش موجود' }, { status: 404 });

    const before = await db.telegramUpsellProduct.findFirst({ where: { id, companyId, storeId }, select: ROW_SELECT });
    if (!before) return NextResponse.json({ error: 'الاسم مش موجود' }, { status: 404 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'البيانات مش صحيحة' }, { status: 400 });

    let data: Prisma.TelegramUpsellProductUncheckedUpdateManyInput;
    if (Object.keys(body).length === 1 && typeof body.isActive === 'boolean') {
      data = { isActive: body.isActive };
    } else {
      const parsed = aliasInputSchema(store.country.minorUnit).safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
      const product = await activeProductOf(companyId, storeId, parsed.data.productId);
      if (!product) return NextResponse.json({ error: 'المنتج مش فعّال بهالمتجر' }, { status: 400 });
      const columns = aliasColumns(parsed.data);
      const taken = await db.telegramUpsellProduct.findFirst({
        where: { companyId, storeId, foldedName: columns.foldedName, id: { not: id } },
        select: { id: true },
      });
      if (taken) return NextResponse.json({ error: 'هالاسم موجود بالقائمة لاسم تاني' }, { status: 409 });
      data = { ...columns, offerAliases: columns.offerAliases ?? Prisma.DbNull, ...(parsed.data.isActive === undefined ? {} : { isActive: parsed.data.isActive }) };
    }

    const written = await db.telegramUpsellProduct.updateMany({ where: { id, companyId, storeId }, data });
    if (written.count !== 1) return NextResponse.json({ error: 'الاسم مش موجود' }, { status: 404 });
    const after = await db.telegramUpsellProduct.findFirst({ where: { id, companyId, storeId }, select: ROW_SELECT });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'isActive' in data && Object.keys(data).length === 1 ? (data.isActive ? 'TELEGRAM_ALIAS_ENABLED' : 'TELEGRAM_ALIAS_DISABLED') : 'TELEGRAM_ALIAS_UPDATED',
      entity: 'TelegramUpsellProduct',
      entityId: id,
      previousData: view(before),
      newData: after ? view(after) : data,
    });
    return NextResponse.json({ row: after ? view(after) : null });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
