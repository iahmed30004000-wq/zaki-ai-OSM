import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext, listAccessibleStores } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { forgetHost } from '@/lib/landing-domain';
import { publicPath } from '@/lib/public-address';
import { openRefusal, openWarnings, storefrontFacts, refusalToOpen } from '@/lib/storefront-rules';
import { BENCH_STORE_CANNOT_OPEN_AR } from '@/lib/test-store';

/**
 * SINGLE PRODUCT STORES — WHICH ARE LIVE, WHAT THEY SHOW, AND WHAT THEY SELL.
 *
 * A Single Product store is a store whose front is one of its landing pages.
 * This screen picks that page, opens and closes the store, and says what is
 * still missing. Everything else about the store — its name, domain, logo,
 * support phone — is edited in its own panel under «البلدان والمتاجر»; a
 * second editor for the same fields is a second place for them to disagree.
 *
 * Deliberately NOT filtered to the selected store: "which of my shops are
 * live?" cannot be asked from inside one of them. ACCESS bounds it instead —
 * the same UserStoreAccess rows the store switcher obeys.
 *
 * The numbers count what the store's own address sold: orders through its
 * front page, or through its product page before a front page was picked.
 */

/** What `source` an order from a storefront product page carries. */
const STOREFRONT_SOURCE = 'Store';

export async function GET() {
  try {
    const { user, companyId, countryId, storeId: currentStoreId } = await requireContext();
    await requirePermission('geo.manage').catch(async () => requirePermission('reports.view'));

    const accessible = (await listAccessibleStores(user, companyId, countryId)) ?? [];
    const ids = accessible.map((s) => s.id);
    if (ids.length === 0) return NextResponse.json({ stores: [] });

    const stores = await db.store.findMany({
      where: { id: { in: ids }, companyId, type: 'SINGLE_PRODUCT' },
      select: {
        id: true, name: true, slug: true, logo: true, type: true, status: true, companyId: true,
        storefrontEnabled: true, tagline: true, supportPhone: true, domain: true, domainVerifiedAt: true, landingPageId: true,
        // Switching INTO this store needs its country: the selection is a
        // country and a store together, never a store alone.
        countryId: true,
        country: { select: { currencyCode: true } },
        landingPages: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, name: true, slug: true, isPublished: true, domain: true, productId: true, product: { select: { name: true } } },
        },
      },
      orderBy: { name: 'asc' },
    });

    const list = await Promise.all(
      stores.map(async (s) => {
        // What the store's own address sold: its front page's orders, and its
        // product page's from before a front page was picked.
        const sold = {
          companyId,
          storeId: s.id,
          OR: [{ source: STOREFRONT_SOURCE }, ...(s.landingPageId ? [{ landingPageId: s.landingPageId }] : [])],
        };
        const [facts, orders, money] = await Promise.all([
          storefrontFacts(s),
          db.order.count({ where: sold }),
          // The same revenue every other screen means: collected where known.
          db.order.aggregate({
            where: { ...sold, shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] } },
            _sum: { collectedAmount: true, totalAmount: true },
          }),
        ]);
        const refusal = openRefusal(facts);
        const front = s.landingPages.find((p) => p.id === s.landingPageId) ?? null;
        /**
         * EVERY PAGE THIS STORE HAS — none hidden.
         *
         * This used to drop any page with no product, on the reasoning that
         * such a page cannot sell. What a seller saw was «ليش ما بظهر
         * صفحات الهبوط»: pages they had made, missing from the one screen
         * that picks a front, with nothing saying why.
         *
         * A page that cannot sell is not a page to hide, it is a page to
         * LABEL — the option says «(بلا منتج)» and picking it produces a
         * refusal that names the reason. Hiding it removed the fact and
         * left the seller to conclude the feature was broken.
         */
        const pages = s.landingPages.map(({ productId: _p, ...page }) => page);
        return {
          id: s.id,
          name: s.name,
          slug: s.slug,
          logo: s.logo,
          status: s.status,
          live: s.storefrontEnabled,
          tagline: s.tagline,
          domain: s.domain,
          // WITHOUT THIS the card could not tell a connected domain from a
          // WORKING one, so «انسخ الرابط» handed out `https://<domain>` for a
          // hostname nobody had looked up. The address rule
          // (src/lib/public-address.ts) needs the stamp, not just the name.
          domainVerifiedAt: s.domainVerifiedAt,
          currency: s.country.currencyCode,
          countryId: s.countryId,
          path: publicPath({ kind: 'store', slug: s.slug }),
          /** Pages and the editor are read through the selected store. */
          current: s.id === currentStoreId,
          frontPage: front ? (({ productId: _p, ...page }) => page)(front) : null,
          pages,
          orders,
          revenue: Number((Number(money._sum.collectedAmount ?? 0) || Number(money._sum.totalAmount ?? 0)).toFixed(2)),
          // What stops it opening, and what would merely make it better.
          refusal,
          warnings: openWarnings(s),
        };
      })
    );

    return NextResponse.json({ stores: list });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

const patchSchema = z.union([
  z.object({ storeId: z.string().uuid(), live: z.boolean() }).strict(),
  /** The front page, or null to un-pick it. */
  z.object({ storeId: z.string().uuid(), landingPageId: z.string().uuid().nullable() }).strict(),
]);

/**
 * Open or close a Single Product store, or pick its front page.
 *
 * Every rule is here, not in the screen: opening goes through the same
 * refusal the store panel uses, and a front page must be the store's own,
 * sell a product, and not carry a domain of its own — the store's address
 * and domain are the page's while it is the front.
 */
export async function PATCH(req: Request) {
  try {
    const { user, companyId, countryId } = await requireContext();
    await requirePermission('geo.manage');

    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 });
    const { storeId } = parsed.data;

    const accessible = (await listAccessibleStores(user, companyId, countryId)) ?? [];
    if (!accessible.some((s) => s.id === storeId)) {
      return NextResponse.json({ error: 'المتجر غير موجود' }, { status: 404 });
    }
    const store = await db.store.findFirst({
      where: { id: storeId, companyId },
      select: { id: true, companyId: true, name: true, slug: true, type: true, status: true, storefrontEnabled: true, landingPageId: true, domain: true, isTest: true },
    });
    if (!store) return NextResponse.json({ error: 'المتجر غير موجود' }, { status: 404 });

    // ── Open / close ──
    if ('live' in parsed.data) {
      const live = parsed.data.live;
      if (live) {
        // A bench is never open to visitors — said here in words; the database CHECK is only the last line.
        if (store.isTest) return NextResponse.json({ error: BENCH_STORE_CANNOT_OPEN_AR, code: 'BENCH_CANNOT_OPEN' }, { status: 409 });
        const refusal = await refusalToOpen(store);
        if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });
      }
      await db.store.update({ where: { id: store.id }, data: { storefrontEnabled: live } });
      forgetHost(store.domain);
      await logAudit({
        companyId,
        userId: user.id,
        action: live ? 'STOREFRONT_OPENED' : 'STOREFRONT_CLOSED',
        entity: 'Store',
        entityId: store.id,
        newData: { name: store.name, slug: store.slug, live },
      });
      return NextResponse.json({ success: true, live });
    }

    // ── The front page ──
    if (store.type !== 'SINGLE_PRODUCT') {
      return NextResponse.json({ error: 'صفحة الواجهة لمتاجر Single Product فقط' }, { status: 400 });
    }
    const pageId = parsed.data.landingPageId;

    if (pageId === null) {
      // Un-picking the page of an OPEN store would leave its address to fall
      // back to a product page that may not exist — refused while it is live.
      if (store.storefrontEnabled && (await refusalToOpen({ ...store, landingPageId: null }))) {
        return NextResponse.json({ error: 'أغلق المتجر أولاً — بلا صفحة واجهة لن يجد الزائر شيئاً' }, { status: 400 });
      }
    } else {
      const page = await db.landingPage.findFirst({
        where: { id: pageId, companyId },
        select: {
          id: true, name: true, slug: true, storeId: true, productId: true, isPublished: true, domain: true,
          frontOf: { select: { id: true } },
          product: { select: { storeId: true } },
        },
      });
      if (!page || page.storeId !== store.id) {
        return NextResponse.json({ error: 'الصفحة ليست من صفحات هذا المتجر' }, { status: 400 });
      }
      if (!page.productId) {
        return NextResponse.json({ error: 'الصفحة لا تبيع منتجاً — اختر لها منتجاً أولاً' }, { status: 400 });
      }
      // What it sells must be this store's own: another store's product is
      // another country's price and another warehouse's stock.
      if (page.product?.storeId !== store.id) {
        return NextResponse.json({ error: 'منتج الصفحة ليس من منتجات هذا المتجر' }, { status: 400 });
      }
      // The page takes its orders at /api/public/landing-pages/<slug>. A slug
      // another company's page also holds (from before slugs were unique
      // everywhere) could send this store's customers there.
      const shared = await db.landingPage.findFirst({
        where: { slug: page.slug, id: { not: page.id } },
        select: { id: true },
      });
      if (shared) {
        return NextResponse.json(
          { error: 'رابط هذه الصفحة مستخدم في صفحة أخرى — غيّر رابطها (slug) من إعدادات الصفحة ثم اخترها' },
          { status: 409 }
        );
      }
      if (page.frontOf && page.frontOf.id !== store.id) {
        return NextResponse.json({ error: 'هذه الصفحة واجهة متجر آخر' }, { status: 409 });
      }
      if (page.domain) {
        return NextResponse.json(
          { error: `للصفحة نطاقها الخاص (${page.domain}) — احذفه منها أولاً؛ نطاق المتجر يصير نطاقها` },
          { status: 400 }
        );
      }
      // An open store must stay a working link after the swap — the same
      // rule as opening it, applied to the store as it would be.
      if (store.storefrontEnabled) {
        const refusal = await refusalToOpen({ ...store, landingPageId: page.id });
        if (refusal) return NextResponse.json({ error: `المتجر مفتوح — ${refusal}` }, { status: 400 });
      }
    }

    await db.store.update({ where: { id: store.id }, data: { landingPageId: pageId } });
    forgetHost(store.domain);
    await logAudit({
      companyId,
      userId: user.id,
      action: 'STOREFRONT_PAGE_SET',
      entity: 'Store',
      entityId: store.id,
      previousData: { landingPageId: store.landingPageId },
      newData: { name: store.name, landingPageId: pageId },
    });
    return NextResponse.json({ success: true, landingPageId: pageId });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
