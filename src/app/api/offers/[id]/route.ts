import { NextResponse } from 'next/server';
import { refreshLandingPages } from '@/lib/landing-cache';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { offerPatchSchema, clearOtherDefaults, clearOtherPostOrderOffers, offerEditAboveBaseRefusal } from '@/lib/offers';
import { zodMessage } from '@/lib/zod-message';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/offers/[id]   edit one bundle
 * DELETE /api/offers/[id]  retire one bundle
 *
 * Editing offers used to be possible only by creating new ones, which is why
 * a company ended up with forty-one of them. Both verbs are tenant-scoped:
 * an id from another company reads as missing, never as forbidden.
 */

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('offers.manage');
    const { id } = await ctx.params;

    // With its product's base price: the line this offer must stay under is that price × its paid pieces.
    const found = await db.offer.findFirst({
      where: { id, companyId, product: { storeId: storeId ?? '' } },
      include: { product: { select: { basePrice: true } } },
    });
    if (!found) return NextResponse.json({ error: 'العرض غير موجود' }, { status: 404 });
    // The offer's own row, without the product, is what the rules read and what the audit log keeps.
    const { product, ...existing } = found;

    // The stored row, so a partial edit is measured against the offer it
    // WILL be: `{ discount: 30 }` alone says nothing about the price it has
    // to stay under, and a rule that only sees what was sent would shut the
    // create door and leave this one open. See `offerPatchSchema`.
    const parsed = offerPatchSchema(existing).safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }
    const input = parsed.data;

    // «العرض ما بصير يكون اكثر من السعر الاساسي» — refused only for what THIS edit changes. Renaming an old offer,
    // moving it, starring it, moving its ending or switching it off always passes. See `offerEditAboveBaseRefusal`.
    const aboveBase = offerEditAboveBaseRefusal(existing, input, product.basePrice, country.minorUnit);
    if (aboveBase) return NextResponse.json(aboveBase, { status: 400 });

    /**
     * WHAT THE EDITOR SENT, AND NOTHING ELSE.
     *
     * `offerPatchSchema` now hands back exactly the fields the request
     * carried — it strips the `.default()` that `.partial()` keeps, which is
     * what used to make a reorder overwrite the quantity, the discount and
     * the default flag. So the keys of `input` ARE the edit, and spreading
     * them is the whole merge.
     *
     * Spread rather than a field-by-field list on purpose, and it closes the
     * opposite hole too: the list had eleven lines, one per column, so a
     * field added to the schema was silently NOT writable here until
     * somebody remembered a twelfth. Three fields still need a line of their
     * own because the column wants something the schema does not say:
     * a trimmed name, and `null` rather than `undefined` for the two
     * nullable columns.
     */
    const { name, compareAtPrice, endsAt, ...columns } = input;

    const offer = await db.$transaction(async (tx) => {
      const updated = await tx.offer.update({
        where: { id: existing.id },
        data: {
          ...columns,
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...('compareAtPrice' in input ? { compareAtPrice: compareAtPrice ?? null } : {}),
          ...('endsAt' in input ? { endsAt: endsAt ?? null } : {}),
        },
      });
      await clearOtherDefaults(tx, updated);
      // And exactly one offer after the order — the same rule, the same way.
      await clearOtherPostOrderOffers(tx, updated);
      return updated;
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'OFFER_UPDATED',
      entity: 'Offer',
      entityId: offer.id,
      previousData: existing,
      newData: offer,
    });

    await refreshLandingPages({ productId: offer.productId, companyId });
    return NextResponse.json({ success: true, offer });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('offers.manage');
    const { id } = await ctx.params;

    const existing = await db.offer.findFirst({ where: { id, companyId, product: { storeId: storeId ?? '' } } });
    if (!existing) return NextResponse.json({ error: 'العرض غير موجود' }, { status: 404 });

    // An offer an order was placed on is history, not configuration. Deleting
    // it would leave that order unable to say what was actually sold, so it
    // is retired instead — invisible to customers, intact for the record.
    const usedBy = await db.order.count({ where: { offerId: existing.id } });
    if (usedBy > 0) {
      const offer = await db.offer.update({
        where: { id: existing.id },
        data: { status: 'INACTIVE', isDefault: false },
      });
      await logAudit({
        companyId,
        userId: user.id,
        action: 'OFFER_RETIRED',
        entity: 'Offer',
        entityId: offer.id,
        previousData: existing,
        newData: { ...offer, reason: `linked to ${usedBy} order(s)` },
      });
      // A retired offer leaves the page as surely as a deleted one: rebuild the cached pages now.
      await refreshLandingPages({ productId: existing.productId, companyId });
      return NextResponse.json({
        success: true,
        retired: true,
        message: `العرض مرتبط بـ ${usedBy} طلب — تم إيقافه بدل حذفه حتى تبقى الطلبات قابلة للقراءة.`,
      });
    }

    await db.offer.delete({ where: { id: existing.id } });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'OFFER_DELETED',
      entity: 'Offer',
      entityId: existing.id,
      previousData: existing,
    });

    await refreshLandingPages({ productId: existing.productId, companyId });
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
