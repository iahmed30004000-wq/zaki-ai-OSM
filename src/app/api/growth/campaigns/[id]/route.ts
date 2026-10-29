import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { inStore } from '@/lib/store-filter';
import { productConflict } from '@/lib/campaigns';
import { campaignPatchSchema, datesMakeSense } from '@/lib/campaigns';
import { zodMessage } from '@/lib/zod-message';
import { z } from 'zod';
import { isManualAccount } from '@/lib/ads/manual';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Editing a campaign, and retiring one.
 *
 * The CODE is not editable. It is stamped on every order the campaign
 * brought, and changing it would leave the orders pointing at a campaign
 * whose link no longer produces them — the spend and the returns would
 * describe two different things. A campaign that needs a new code is a new
 * campaign, which is also the truth of what happened.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('reports.view');
    const { id } = await ctx.params;

    const existing = await db.campaign.findFirst({
      where: { id, ...inStore(companyId, storeId) },
      // `landingPageId` and `productId` are read because the product rule
      // is measured on the state AFTER the merge, not on the input — a
      // PATCH that changes only the page still changes which product the
      // campaign advertises.
      select: {
        id: true, name: true, spend: true, status: true, code: true, platform: true,
        landingPageId: true, productId: true,
      },
    });
    if (!existing) return NextResponse.json({ error: 'الحملة غير موجودة' }, { status: 404 });

    const body = await req.json().catch(() => null);

    // Linking to a remote campaign is its own edit, handled before the rest:
    // it is the only field whose value must be checked against an account
    // this store actually owns.
    if (body && 'adAccountId' in body) {
      const link = z
        .object({
          adAccountId: z.string().uuid().nullable(),
          externalId: z.string().trim().max(64).nullable().optional(),
        })
        .safeParse(body);
      if (!link.success) return NextResponse.json({ error: 'بيانات الربط غير صالحة' }, { status: 400 });

      if (link.data.adAccountId) {
        const account = await db.adAccount.findFirst({
          where: { id: link.data.adAccountId, ...inStore(companyId, storeId) },
          select: { id: true, status: true, platform: true },
        });
        // An account of another store would attach this campaign's spend to
        // somebody else's money.
        if (!account) return NextResponse.json({ error: 'الحساب الإعلاني غير موجود' }, { status: 400 });

        /*
         * A MANUAL ACCOUNT IS A PLACE TO PUT A CAMPAIGN, NOT A SOURCE FOR ITS
         * SPEND. So it takes no remote id — there is no platform behind it for
         * the id to point into, and a campaign carrying one would wait for a
         * sync that can never come — and it takes only campaigns of its own
         * platform, because grouping a TikTok campaign under a Meta account is
         * a typo that would put one platform's spend in the other's column.
         *
         * Only for manual accounts: a connected account's link has always
         * been loose about the campaign's platform, and tightening that here
         * would be a behaviour change nobody asked for.
         */
        if (isManualAccount(account)) {
          if (link.data.externalId) {
            return NextResponse.json({ error: 'الحساب يدوي — لا ربط له بحملة في المنصة' }, { status: 400 });
          }
          if (account.platform !== existing.platform) {
            return NextResponse.json({ error: 'منصة الحساب غير منصة الحملة' }, { status: 400 });
          }
        }
      }

      const linked = Boolean(link.data.adAccountId && link.data.externalId);
      await db.campaign.update({
        where: { id: existing.id },
        data: {
          adAccountId: link.data.adAccountId,
          externalId: link.data.externalId ?? null,
          // Unlinking returns the spend to the seller's hands; it does not
          // erase what was pulled, which was real money.
          spendSource: linked ? 'SYNCED' : 'MANUAL',
        },
      });
      return NextResponse.json({ success: true, linked });
    }

    // `campaignPatchSchema`, not `campaignInputSchema...partial()`: the
    // merge below is correct code and was being fed a schema that lied. A
    // field omitted by the caller now arrives omitted, so `!== undefined`
    // means what it says. See the schema for the measurement.
    const parsed = campaignPatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;

    if (input.startDate && !datesMakeSense(input.startDate, input.endDate ?? null)) {
      return NextResponse.json({ error: 'تاريخ الانتهاء قبل تاريخ البدء' }, { status: 400 });
    }

    /*
     * THE PRODUCT RULE IS MEASURED ON THE STATE AFTER THE MERGE.
     *
     * This is the trap in a partial PATCH that a per-field `!== undefined`
     * cannot see: a body carrying only `{ landingPageId }` changes which
     * product the campaign advertises, and a body carrying only
     * `{ productId }` has to be judged against the page ALREADY on the row.
     * Reading the input alone answers neither.
     *
     * So the effective values are worked out first — the caller's where
     * they said something, the row's where they did not — and everything
     * below is judged on those.
     */
    const nextPageId =
      input.landingPageId !== undefined ? (input.landingPageId ?? null) : existing.landingPageId;
    const nextProductId =
      input.productId !== undefined ? (input.productId ?? null) : existing.productId;

    let pageProduct: { id: string; name: string } | null = null;
    if (nextPageId) {
      const lp = await db.landingPage.findFirst({
        where: { id: nextPageId, ...inStore(companyId, storeId) },
        select: { id: true, product: { select: { id: true, name: true } } },
      });
      if (!lp) return NextResponse.json({ error: 'صفحة الهبوط غير موجودة في هذا المتجر' }, { status: 400 });
      pageProduct = lp.product ?? null;
    }

    // A product id from a browser: another store's product is a REAL
    // product, so the foreign key would take it and the campaign would be
    // reported against something it never advertised.
    let chosenProduct: { id: string; name: string } | null = null;
    if (nextProductId) {
      const prod = await db.product.findFirst({
        where: { id: nextProductId, ...inStore(companyId, storeId) },
        select: { id: true, name: true },
      });
      if (!prod) return NextResponse.json({ error: 'المنتج غير موجود في هذا المتجر' }, { status: 400 });
      chosenProduct = prod;
    }

    const clash = productConflict(chosenProduct?.id, pageProduct?.id, {
      chosen: chosenProduct?.name,
      page: pageProduct?.name,
    });
    if (clash) return NextResponse.json({ error: clash, code: 'PRODUCT_CONFLICT' }, { status: 400 });

    /*
     * AND THE COLUMN IS WRITTEN WHENEVER EITHER SIDE MOVED, not only when
     * `productId` was sent. Linking a page to a campaign that had an
     * explicit product must clear that column — otherwise the row keeps a
     * stale second answer that `campaignProductId` then ignores forever,
     * and the next person to read the row sees a product the campaign is
     * not advertising.
     */
    const scopeMoved = input.landingPageId !== undefined || input.productId !== undefined;

    const updated = await db.campaign.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.landingPageId !== undefined ? { landingPageId: input.landingPageId ?? null } : {}),
        ...(scopeMoved ? { productId: pageProduct ? null : (chosenProduct?.id ?? null) } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.endDate !== undefined ? { endDate: input.endDate ?? null } : {}),
        ...(input.spend !== undefined ? { spend: input.spend } : {}),
        ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
      },
      select: { id: true, name: true, spend: true, status: true, productId: true },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'CAMPAIGN_UPDATED',
      entity: 'Campaign',
      entityId: existing.id,
      // The spend is the number somebody will be asked about later.
      previousData: { name: existing.name, spend: Number(existing.spend), status: existing.status },
      newData: { name: updated.name, spend: Number(updated.spend), status: updated.status },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

/**
 * Delete a campaign that brought nothing; end one that brought something.
 *
 * An order carries the campaign that brought it, and that is a record of
 * where the money came from. Deleting the campaign would blank it on every
 * one of them — the sales would survive and the reason for them would not.
 * So a campaign with orders is ENDED instead, and says so.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('reports.view');
    const { id } = await ctx.params;

    const existing = await db.campaign.findFirst({
      where: { id, ...inStore(companyId, storeId) },
      select: { id: true, name: true, code: true, _count: { select: { orders: true } } },
    });
    if (!existing) return NextResponse.json({ error: 'الحملة غير موجودة' }, { status: 404 });

    if (existing._count.orders > 0) {
      await db.campaign.update({ where: { id: existing.id }, data: { status: 'ENDED' } });
      await logAudit({
        companyId,
        userId: user.id,
        action: 'CAMPAIGN_ENDED',
        entity: 'Campaign',
        entityId: existing.id,
        newData: { name: existing.name, orders: existing._count.orders },
      });
      return NextResponse.json({
        success: true,
        ended: true,
        message: `«${existing.name}» جاءت بـ${existing._count.orders} طلباً — أُنهيت بدل حذفها، حتى تبقى الطلبات تعرف من أين جاءت.`,
      });
    }

    await db.campaign.delete({ where: { id: existing.id } });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'CAMPAIGN_DELETED',
      entity: 'Campaign',
      entityId: existing.id,
      previousData: { name: existing.name, code: existing.code },
    });

    return NextResponse.json({ success: true, ended: false });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
