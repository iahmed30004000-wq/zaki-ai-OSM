/**
 * POST /api/telegram/upsell-products/seed — «أضف الأسماء الجاهزة» (telegram.manage).
 *
 * The names of the owner's two briefs (10/11, `SEED_ALIASES`): the three upsell names and the four old names. Each is added to
 * the SELECTED store only when its catalogue product is found there — by its exact NAME, folded, among the store's ACTIVE
 * products — and only when the store has no row of that name yet (an existing row is never touched). The prices are dollars,
 * so a store whose currency is not USD gets nothing. Answers `{ created, existing, missing }`, `missing` naming what could
 * not be matched so the owner adds it by hand. Audited once per created row. No migration ever seeds these.
 */
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { SEED_ALIASES } from '@/lib/telegram/aliases';
import { foldOfferText } from '@/lib/telegram/offer-text';
import { storeOf } from '@/lib/telegram/alias-store';

export async function POST() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('telegram.manage');
    const store = await storeOf(companyId, storeId);
    if (!store) return NextResponse.json({ error: 'المتجر مش موجود' }, { status: 404 });
    if (store.country.currencyCode.trim().toUpperCase() !== 'USD') {
      return NextResponse.json({
        created: [],
        existing: [],
        missing: SEED_ALIASES.map((s) => ({ incomingName: s.incomingName, productName: s.productName, why: 'عملة المتجر مش دولار' })),
      });
    }

    const [products, rows] = await Promise.all([
      db.product.findMany({ where: { companyId, storeId, status: 'ACTIVE' }, select: { id: true, name: true } }),
      db.telegramUpsellProduct.findMany({ where: { companyId, storeId }, select: { foldedName: true } }),
    ]);
    const have = new Set(rows.map((r) => r.foldedName));
    const created: string[] = [];
    const existing: string[] = [];
    const missing: Array<{ incomingName: string; productName: string; why: string }> = [];

    for (const seed of SEED_ALIASES) {
      const foldedName = foldOfferText(seed.incomingName);
      if (have.has(foldedName)) {
        existing.push(seed.incomingName);
        continue;
      }
      const matches = products.filter((p) => foldOfferText(p.name) === foldOfferText(seed.productName));
      if (matches.length !== 1) {
        missing.push({
          incomingName: seed.incomingName,
          productName: seed.productName,
          why: matches.length ? 'أكتر من منتج بهالاسم' : 'ما في منتج فعّال بهالاسم بالمتجر',
        });
        continue;
      }
      const offerAliases =
        seed.kind === 'RENAMED' ? (seed.offerAliases ?? []).map((o) => ({ ...o, foldedName: foldOfferText(o.name) })) : null;
      try {
        const row = await db.telegramUpsellProduct.create({
          data: {
            companyId,
            storeId,
            kind: seed.kind,
            incomingName: seed.incomingName,
            foldedName,
            productId: matches[0].id,
            extraUnits: seed.kind === 'UPSELL' ? seed.extraUnits ?? null : null,
            linePrice: seed.kind === 'UPSELL' ? seed.linePrice ?? null : null,
            offerAliases: offerAliases ?? Prisma.DbNull,
            isActive: true,
          },
          select: { id: true },
        });
        have.add(foldedName);
        created.push(seed.incomingName);
        await logAudit({
          companyId,
          userId: user.id,
          action: 'TELEGRAM_ALIAS_CREATED',
          entity: 'TelegramUpsellProduct',
          entityId: row.id,
          newData: { storeId, seeded: true, kind: seed.kind, incomingName: seed.incomingName, productName: matches[0].name },
        });
      } catch (e) {
        // Two presses at once: the other one wrote it.
        if ((e as { code?: string })?.code === 'P2002') {
          existing.push(seed.incomingName);
          continue;
        }
        throw e;
      }
    }
    return NextResponse.json({ created, existing, missing });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
