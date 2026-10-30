import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { inStore } from '@/lib/store-filter';
import { campaignWindow } from '@/lib/campaign-window';
import { campaignInsights, duplicatesOf } from '@/lib/campaign-insights';
import { campaignPerformance } from '@/lib/attribution-performance';
import {
  campaignInputSchema,
  campaignResult,
  campaignLink,
  generateCampaignCode,
  datesMakeSense,
  wasRunning,
  productConflict,
} from '@/lib/campaigns';
import { zodMessage } from '@/lib/zod-message';
import { publicOrigin } from '@/lib/passkey';

/**
 * PAID CAMPAIGNS, AND WHAT CAME BACK FROM THEM.
 *
 * The list is two halves joined by the campaign id. The spend is what the
 * seller typed; everything else — orders, confirmations, deliveries, money
 * collected — is measured by the same attribution engine the moderator and
 * channel reports use, so the word "revenue" means one thing across every
 * screen in the system.
 *
 * Per store, like everything a store owns: a campaign runs for one shop,
 * and its spend must never be divided by another shop's orders.
 */

export async function GET(req: Request) {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('campaigns.view');

    const q = new URL(req.url).searchParams;
    const { start, end } = campaignWindow(q);

    const [campaigns, rows] = await Promise.all([
      db.campaign.findMany({
        where: inStore(companyId, storeId),
        orderBy: [{ sortOrder: 'asc' }, { status: 'asc' }, { startDate: 'desc' }],
        include: {
          landingPage: {
            select: {
              id: true, name: true, slug: true,
              // The page's product IS the campaign's product when there is
              // a page — see `campaignProductId`.
              product: { select: { id: true, name: true } },
            },
          },
          product: { select: { id: true, name: true } },
          adAccount: { select: { id: true, accountName: true, accountId: true, status: true } },
        },
      }),
      campaignPerformance({ companyId, storeId: storeId ?? '', start, end }),
    ]);

    const byId = new Map(rows.map((r) => [r.id, r]));
    const orderOf = new Map(campaigns.map((c) => [c.id, c.sortOrder]));
    const store = storeId
      ? await db.store.findFirst({ where: { id: storeId, companyId }, select: { slug: true } })
      : null;
    // The PUBLIC address (APP_URL, or a trusted proxy's host) — not the request's: behind the proxy that is the
    // container's own «0.0.0.0:3000», and an advert carrying it opens nothing.
    const origin = publicOrigin(req);

    const list = campaigns.map((c) => {
      const row = byId.get(c.id) ?? null;
      const spend = Number(c.spend);
      return {
        id: c.id,
        name: c.name,
        platform: c.platform,
        code: c.code,
        status: c.status,
        // Where the spend came from, said out loud. A number a person typed
        // and a number a machine pulled deserve to be told apart — not
        // least so nobody wonders why one of them changed overnight.
        spendSource: c.spendSource,
        adAccount: c.adAccount,
        externalId: c.externalId,
        lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
        startDate: c.startDate.toISOString(),
        endDate: c.endDate?.toISOString() ?? null,
        notes: c.notes,
        landingPage: { id: c.landingPage?.id, name: c.landingPage?.name, slug: c.landingPage?.slug },
        /*
         * THE PRODUCT, ANSWERED ONCE AND SENT AS ONE FIELD.
         *
         * The screen is given the ANSWER, not the two sources to work it
         * out from. A browser deciding this would be a second copy of
         * `campaignProductId` — and the first screen to round the
         * precedence differently would print a different product from the
         * export beside it.
         *
         * `productId` goes too, because the FORM needs to know what is
         * stored on the row in order to offer it back; `product` is what
         * the row MEANS.
         */
        product: c.landingPage?.product ?? c.product ?? null,
        productId: c.productId,
        link: campaignLink(
          origin,
          c.code,
          c.landingPage ? { kind: 'lp', slug: c.landingPage.slug } : { kind: 'store', slug: store?.slug ?? '' }
        ),
        // A campaign showing zero can then say WHY: no orders, or not even
        // running in the window being read.
        ranInWindow: wasRunning(c, start, end),
        funnel: row
          ? {
              brought: row.brought,
              confirmed: row.confirmed,
              rejected: row.rejected,
              delivered: row.delivered,
              returned: row.returned,
              confirmationRate: row.confirmationRate,
              deliveryRate: row.deliveryRate,
            }
          : { brought: 0, confirmed: 0, rejected: 0, delivered: 0, returned: 0, confirmationRate: null, deliveryRate: null },
        money: campaignResult(spend, row),
      };
    });

    // What the shop actually spent and made in the window, so the header is
    // not the seller adding up the column themselves.
    const totals = list.reduce(
      (t, c) => ({
        spend: t.spend + c.money.spend,
        revenue: t.revenue + c.money.revenue,
        brought: t.brought + c.funnel.brought,
        delivered: t.delivered + c.funnel.delivered,
      }),
      { spend: 0, revenue: 0, brought: 0, delivered: 0 }
    );

    // «حذف المكرر»: a hand-typed campaign whose twin the platform sent, and the cards at the top — both worked out
    // here, from the figures above, so the screen draws answers and adds up nothing.
    const duplicates = duplicatesOf(list.map((c) => ({ id: c.id, name: c.name, externalId: c.externalId })));
    const insights = campaignInsights(
      list.map((c) => ({ id: c.id, name: c.name, externalId: c.externalId, hasProduct: !!c.product, money: c.money, funnel: c.funnel })),
      duplicates
    );

    return NextResponse.json({
      campaigns: list.map((c) => ({ ...c, sortOrder: orderOf.get(c.id) ?? 0, duplicateOf: duplicates.get(c.id) ?? null })),
      insights,
      totals: {
        ...campaignResult(totals.spend, { revenue: totals.revenue, brought: totals.brought, delivered: totals.delivered }),
        brought: totals.brought,
        delivered: totals.delivered,
      },
      currency: country.currencyCode,
      // So the screen can offer to link a campaign without a second request.
      adAccounts: await db.adAccount.findMany({
        where: inStore(companyId, storeId),
        select: { id: true, platform: true, accountId: true, accountName: true, status: true },
      }),
      window: { start: start?.toISOString() ?? null, end: end?.toISOString() ?? null },
      definitions: {
        revenue: 'المحصَّل فعلاً حيث نعرفه، وإجمالي الطلب حيث لا نعرفه — نفس تعريف شاشة الأرباح',
        net: 'الإيراد ناقص الإنفاق الإعلاني فقط. ليس الربح: كلفة البضاعة والتوصيل والعمولة ليست هنا',
        roas: 'كم دولاراً عاد مقابل كل دولار أُنفق',
        costPerDelivered: 'كم كلّف الإعلان مقابل طلب واحد وصل فعلاً',
      },
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('campaigns.manage');
    if (!storeId) {
      return NextResponse.json({ error: 'اختر متجراً أولاً — الحملة تخص متجراً بعينه' }, { status: 400 });
    }

    const parsed = campaignInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;

    if (!datesMakeSense(input.startDate, input.endDate ?? null)) {
      return NextResponse.json({ error: 'تاريخ الانتهاء قبل تاريخ البدء' }, { status: 400 });
    }

    // A page from another store would put this campaign's link on somebody
    // else's shop.
    //
    // The page's own product is read here as well, because it is what
    // decides whether the chosen product contradicts it.
    let pageProduct: { id: string; name: string } | null = null;
    if (input.landingPageId) {
      const lp = await db.landingPage.findFirst({
        where: { id: input.landingPageId, ...inStore(companyId, storeId) },
        select: { id: true, product: { select: { id: true, name: true } } },
      });
      if (!lp) return NextResponse.json({ error: 'صفحة الهبوط غير موجودة في هذا المتجر' }, { status: 400 });
      pageProduct = lp.product ?? null;
    }

    /*
     * THE PRODUCT, AND THE CONTRADICTION REFUSED RATHER THAN RESOLVED.
     *
     * A product id from a browser: looked up WITH the store, because
     * another store's product is a REAL product and the foreign key would
     * take it — and the campaign would then be reported against something
     * it never advertised.
     *
     * And if the linked page sells something else, that is somebody having
     * made a mistake, almost always by changing the page after choosing the
     * product. `campaignProductId` would quietly answer the PAGE's product
     * and the screen would print it beside a dropdown reading the other —
     * which teaches a person that the screen lies.
     */
    let chosenProduct: { id: string; name: string } | null = null;
    if (input.productId) {
      const prod = await db.product.findFirst({
        where: { id: input.productId, ...inStore(companyId, storeId) },
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

    // A seller may name the code; otherwise one is made. Either way it must
    // be free — a reused code would move old orders onto new spend.
    let code = input.code ?? generateCampaignCode();
    for (let attempt = 0; attempt < 8; attempt++) {
      const taken = await db.campaign.findFirst({
        where: { companyId, storeId, code },
        select: { id: true },
      });
      if (!taken) break;
      if (input.code) {
        return NextResponse.json({ error: `الرمز «${code}» مستخدم في حملة أخرى` }, { status: 400 });
      }
      code = generateCampaignCode();
    }

    const created = await db.campaign.create({
      data: {
        companyId,
        storeId,
        name: input.name,
        platform: input.platform,
        code,
        landingPageId: input.landingPageId ?? null,
        /*
         * STORED ONLY WHEN IT ADDS SOMETHING. With a page linked, the
         * product is already derivable from it and `campaignProductId`
         * reads it there — so writing it here too would be the second copy
         * this column exists specifically not to be.
         */
        productId: pageProduct ? null : (chosenProduct?.id ?? null),
        status: input.status,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        spend: input.spend,
        notes: input.notes ?? null,
        createdById: user.id,
      },
      select: { id: true, name: true, code: true },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'CAMPAIGN_CREATED',
      entity: 'Campaign',
      entityId: created.id,
      newData: { name: created.name, code: created.code, platform: input.platform, spend: input.spend },
    });

    return NextResponse.json({ success: true, campaign: created });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
