import { NextResponse } from 'next/server';
import { refreshLandingPages } from '@/lib/landing-cache';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiError } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { validateSlug, clampStoredHtml, conversionRate } from '@/lib/landing-pages';
import { draftState, publishContent } from '@/lib/landing-draft';
import { activeOffersFor } from '@/lib/offers';
import { shownPageProductIds } from '@/lib/storefront';
import { validateDomain, forgetHost, dashboardHosts } from '@/lib/landing-domain';
import { zodMessage } from '@/lib/zod-message';
import { standDownRedirectsTo, suggestSlugRedirect } from '@/lib/store-redirects';
import { familyOf } from '@/lib/selling-blocks';
import { parseStoreTheme } from '@/lib/store-theme';

interface Ctx {
  params: Promise<{ id: string }>;
}

async function loadLandingPage(id: string, companyId: string, storeId: string) {
  // Tenant isolation: id + companyId in the WHERE — company B can never read company A's page
  return db.landingPage.findFirst({ where: { id, companyId, storeId } });
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('landing_pages.view');
    const { id } = await ctx.params;

    const lp = await db.landingPage.findFirst({
      where: { id, companyId, storeId },
      include: {
        product: { select: { id: true, name: true, basePrice: true, image: true, status: true } },
        creator: { select: { id: true, name: true } },
        // The editor's preview must price in the SAME currency the published
        // page does, or it is a preview of a page that does not exist — and
        // that is the country's currency, not the company's. The page is
        // read through the selected store, so it always has one.
        // And the store's identity, which the footer block shows.
        store: { select: { name: true, logo: true, supportPhone: true, theme: true, country: { select: { currencyCode: true, minorUnit: true } } } },
      },
    });
    if (!lp) return NextResponse.json({ error: 'صفحة الهبوط غير موجودة' }, { status: 404 });

    /**
     * THE EDITOR OPENS ON THE DRAFT, NOT ON WHAT VISITORS ARE READING.
     *
     * Otherwise «حفظ كمسودة» would not survive a reload: the seller saves,
     * reloads, and their work is gone from the screen while sitting in the
     * column. Worse, the publish would then promote a draft the editor was
     * not showing — publishing something nobody had looked at.
     *
     * Overlaid field by field, so a draft that touched only the sections
     * still shows the live html beside them.
     */
    /**
     * THE OFFERS THE PUBLISHED PAGE SHOWS, NOT A SECOND COUNT OF THEM.
     *
     * The editor used to list offers through `/api/offers` and draw its
     * preview and its «بعد الطلب» count from that list — every row,
     * including a stopped one, a finished one and the post-order one — so it
     * showed and counted bundles the page does not. `activeOffersFor` is the
     * single question the visitor's page asks, in the store's own currency
     * (`minorUnit`), so the editor now reads the same answer. Both fields
     * are additions: a window that ignores them is unchanged.
     */
    const minorUnit = lp.store?.country?.minorUnit ?? 2;
    const [state, offers] = await Promise.all([
      draftState(lp.id),
      lp.productId ? activeOffersFor(db, companyId, lp.productId, minorUnit) : Promise.resolve([]),
    ]);
    return NextResponse.json({
      landingPage: {
        ...lp,
        ...(state.draft ?? {}),
        htmlContent: clampStoredHtml(state.draft?.htmlContent ?? lp.htmlContent),
        conversionRate: conversionRate(lp.viewsCount, lp.ordersCount),
      },
      // «تعديلات غير منشورة» · «الرجوع للنسخة السابقة» · «نُشرت في».
      hasUnpublished: state.hasUnpublished,
      canRevert: state.canRevert,
      publishedAt: state.publishedAt,
      // The fingerprint of what this response shows. A window sends it back
      // with its save and its publish, so one that is behind is refused
      // instead of erasing the newer work (409).
      base: state.base,
      offers,
      minorUnit,
      // The store's family (عيادة · عطّار · ترند), the same one the published page wears — so the editor's preview
      // draws the page the visitor will see, not the family-less one.
      family: familyOf(parseStoreTheme(lp.store?.theme).template),
    });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    const { id } = await ctx.params;

    const schema = z.object({
      name: z.string().trim().min(2).max(100).optional(),
      slug: z.string().trim().toLowerCase().max(60).optional(),
      productId: z.string().min(10).max(64).optional().nullable(),
      isPublished: z.boolean().optional(),
      /**
       * Listed in its store's own front, or reachable by its link alone.
       *
       * Separate from `isPublished` on purpose: publishing is what makes a
       * page exist for the public, and a campaign page is published and
       * deliberately NOT in the shop window. The storefront demands both.
       */
      showInStore: z.boolean().optional(),
      // '' clears the domain; the page goes back to /lp/<slug> only.
      domain: z.string().trim().max(253).optional().nullable(),
      /**
       * THE WINDOW SAYS IT WILL ASK THE SELLER, so it may be told «no».
       *
       * Without this flag a press that makes a page the store's first shelf
       * page goes through exactly as it always did — the editor in use today
       * has no question to show for a refusal, and a publish that used to
       * work must not start failing. A window that has the question sends
       * `true` and gets the 409 `STORE_NOT_SWITCHED` to turn into it. It
       * asks for nothing by itself: never an edit, never a permission.
       */
      askBeforeSwitchingStore: z.boolean().optional(),
    });
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    // A body that names nothing asked for nothing: it used to pass every
    // check (no field, so no permission) and write an empty update.
    const { askBeforeSwitchingStore, ...edits } = parsed.data;
    if (Object.values(edits).every((v) => v === undefined)) {
      return NextResponse.json({ error: 'لم يُرسل أي تعديل' }, { status: 400 });
    }

    const lp = await loadLandingPage(id, companyId, storeId);
    if (!lp) return NextResponse.json({ error: 'صفحة الهبوط غير موجودة' }, { status: 404 });

    // Publish/unpublish is a distinct permission from editing
    if (parsed.data.isPublished !== undefined) {
      await requirePermission('landing_pages.publish');
    }
    // `showInStore` too: it changes the live shop window, and alone in a body
    // it asked for nothing — any signed-in member of the store could switch
    // a twelve-product shelf to one. Same key as «اعرض كل الصفحات المنشورة».
    const needsEdit =
      parsed.data.name !== undefined ||
      parsed.data.slug !== undefined ||
      parsed.data.productId !== undefined ||
      parsed.data.domain !== undefined ||
      parsed.data.showInStore !== undefined;
    if (needsEdit) await requirePermission('landing_pages.edit');

    // A page that is a Single Product store's front answers at the store's
    // address. What would break that address is refused here, where the
    // seller is — not discovered by a customer following an ad.
    const front = await db.store.findFirst({
      where: { landingPageId: lp.id },
      select: { name: true, storefrontEnabled: true },
    });
    if (front?.storefrontEnabled && parsed.data.isPublished === false) {
      return NextResponse.json(
        { error: `هذه الصفحة واجهة متجر «${front.name}» المفتوح — أغلق المتجر أولاً أو اختر له صفحة أخرى` },
        { status: 409 }
      );
    }
    if (front?.storefrontEnabled && parsed.data.productId === null) {
      return NextResponse.json(
        { error: `هذه الصفحة واجهة متجر «${front.name}» — بلا منتج لن يبيع المتجر شيئاً` },
        { status: 409 }
      );
    }
    if (front && parsed.data.domain) {
      return NextResponse.json(
        { error: `هذه الصفحة واجهة متجر «${front.name}» — نطاقها هو نطاق المتجر، ويُضبط من إعدادات المتجر` },
        { status: 409 }
      );
    }

    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();
    if (parsed.data.slug !== undefined) {
      const slugCheck = validateSlug(parsed.data.slug);
      if (!slugCheck.valid) return NextResponse.json({ error: slugCheck.error }, { status: 400 });
      // One public space for every company — see the create route.
      if (parsed.data.slug !== lp.slug) {
        const taken = await db.landingPage.findFirst({ where: { slug: parsed.data.slug, id: { not: lp.id } }, select: { id: true } });
        if (taken) return NextResponse.json({ error: 'هذا الرابط (slug) مستخدم بالفعل — اختر رابطاً آخر' }, { status: 409 });
      }
      data.slug = parsed.data.slug;
    }
    if (parsed.data.productId !== undefined) {
      // Checked when it CHANGES: the editor sends the whole form, and a page
      // bound before this rule would otherwise be unable to save anything.
      if (parsed.data.productId && parsed.data.productId !== lp.productId) {
        // THIS store's product. A page in one store selling another store's
        // product booked the order against the wrong shop's stock.
        const product = await db.product.findFirst({ where: { id: parsed.data.productId, companyId, storeId: lp.storeId } });
        if (!product) return NextResponse.json({ error: 'المنتج ليس من منتجات هذا المتجر' }, { status: 404 });
      }
      data.productId = parsed.data.productId;
    }
    if (parsed.data.isPublished !== undefined) data.isPublished = parsed.data.isPublished;
    if (parsed.data.showInStore !== undefined) data.showInStore = parsed.data.showInStore;

    /**
     * THE FIRST PAGE THAT FEEDS THE SHELF IS THE OWNER'S PRESS, NOT THIS ONE.
     *
     * The catalogue switches the moment a store has one published, shown page
     * that sells a product (`shownPageProductIds`), and from then on the
     * shop window is only what its pages sell. «اعرض كل الصفحات المنشورة»
     * flips every page in one `updateMany` so the shelf is never empty in
     * between; a single toggle here — showing a published page, publishing a
     * shown one, or giving a shown one its product — would switch the store
     * with ONE page and take a twelve-product shop down to one.
     *
     * So when this change would make the page the first of its kind and the
     * store has not switched, it is refused and the sentence names the press.
     * A store that already switched takes the change as before.
     *
     * ONLY FOR A WINDOW THAT ASKED (`askBeforeSwitchingStore: true`). The
     * editor in use has no question to show, and refusing it would break a
     * publish that works today; it keeps the old behaviour until the new
     * editor, which sends the flag, replaces it.
     */
    const feedsShelf = (shown: boolean, published: boolean, product: string | null) => shown && published && !!product;
    const willFeed = feedsShelf(
      parsed.data.showInStore ?? lp.showInStore,
      parsed.data.isPublished ?? lp.isPublished,
      parsed.data.productId !== undefined ? parsed.data.productId : lp.productId
    );
    if (askBeforeSwitchingStore === true && willFeed && !feedsShelf(lp.showInStore, lp.isPublished, lp.productId)) {
      if ((await shownPageProductIds(companyId, storeId)).size === 0) {
        return NextResponse.json(
          {
            error: 'هذا يبدّل واجهة المتجر كلها إلى صفحاته فقط — استعمل زر «اعرض كل الصفحات المنشورة» ليظهر كل شيء معاً',
            code: 'STORE_NOT_SWITCHED',
          },
          { status: 409 }
        );
      }
    }

    // ── Custom domain ──
    if (parsed.data.domain !== undefined) {
      const raw = parsed.data.domain?.trim() ?? '';
      if (!raw) {
        data.domain = null;
        data.domainVerifiedAt = null;
      } else {
        const check = validateDomain(raw, dashboardHosts(req));
        if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
        // Unique across companies, so a clash is somebody else's claim and
        // saying which company holds it would leak who our customers are.
        // Checked against STORES too: the proxy answers a landing page first,
        // so a page claiming a store's host silently took the store over.
        // And the host answers with /lp/<slug>: a slug another page also
        // holds (from before slugs were unique everywhere) would show the
        // older of the two — perhaps another company's — at this domain.
        const slug = typeof data.slug === 'string' ? data.slug : lp.slug;
        const [taken, store, sharedSlug] = await Promise.all([
          db.landingPage.findFirst({ where: { domain: check.domain, id: { not: lp.id } }, select: { id: true } }),
          db.store.findFirst({ where: { domain: check.domain }, select: { id: true } }),
          db.landingPage.findFirst({ where: { slug, id: { not: lp.id } }, select: { id: true } }),
        ]);
        if (taken || store) {
          return NextResponse.json({ error: 'هذا النطاق مستخدم بالفعل' }, { status: 409 });
        }
        if (sharedSlug) {
          return NextResponse.json(
            { error: 'رابط هذه الصفحة (slug) مستخدم في صفحة أخرى — غيّره أولاً ثم اربط النطاق' },
            { status: 409 }
          );
        }
        data.domain = check.domain;
        // A DIFFERENT host is not the host somebody proved. The mark is wiped
        // only when the host changes: the screen sends the whole form on
        // every save, and saving the same domain again must keep it.
        if (check.domain !== lp.domain) data.domainVerifiedAt = null;
      }
      // The proxy caches host → page for a minute; a domain is changed at the
      // exact moment somebody is waiting to see whether it works.
      forgetHost(lp.domain);
      forgetHost(typeof data.domain === 'string' ? data.domain : null);
    }

    // A page no longer carries its own pixel. The two columns that held one
    // are still in the table (migrations only add) but nothing reads them:
    // every pixel lives in tracking_pixels, managed on /settings/tracking,
    // with "landing pages only" as its scope when that is what is wanted.

    try {
      const updated = await db.landingPage.update({ where: { id: lp.id }, data });
      // What a seller's host serves is remembered for a minute (landing-
      // domain.ts): its own page by slug, and a store's host every published
      // page of the store. A new slug or a publish change must count at once.
      if (updated.slug !== lp.slug || updated.isPublished !== lp.isPublished) await forgetPageHosts(lp);

      /**
       * GOING LIVE STAMPS THE PUBLISH AND PROMOTES ANY DRAFT.
       *
       * A page being published for the first time has its content in the
       * live columns already — the editor saves before it flips the flag,
       * and a page that is not yet published has no audience to protect, so
       * that save went straight through. There is nothing to promote and
       * `publishContent` only records the moment.
       *
       * A page that was taken down with a draft still sitting in it DOES
       * have something to promote, and it is the same thing the editor shows
       * (the GET above opens on the draft) — so the press publishes what the
       * seller is looking at, which is the only version of this that is not
       * a surprise.
       */
      const goingLive = parsed.data.isPublished === true && !lp.isPublished;
      if (goingLive) await publishContent(lp.id);
      // Whatever changed — the name, the slug, published or taken down, the product — the cached page is rebuilt now:
      // under both slugs, so an old address stops showing the page the moment it moves.
      await refreshLandingPages({ slugs: [lp.slug, updated.slug] });

      if (updated.slug !== lp.slug) {
        // ── The advertisement is still pointing at the old address ──
        // Every click on it is already paid for. Suggest the redirect, and
        // let the seller decide: a slug changed to get AWAY from a campaign
        // must not forward, and only they know which case this is.
        await suggestSlugRedirect({
          companyId,
          storeId: lp.storeId,
          oldSlug: lp.slug,
          newSlug: updated.slug,
        });
        // A LIVE PAGE ALWAYS BEATS A REDIRECT. If this page has just taken a
        // slug that some old redirect forwards away from, that redirect would
        // shadow the page it now names — the address would answer with
        // somewhere else. Stand it down rather than let it win.
        await standDownRedirectsTo(updated.slug);
      } else if (goingLive) {
        // The same rule at the other moment it can bite: a page published for
        // the FIRST time under a slug that a redirect (a seller's, perhaps
        // another company's, made while the address was free) still forwards
        // away from. The page is live now; the redirect would shadow it.
        await standDownRedirectsTo(updated.slug);
      }
      await logAudit({
        companyId,
        userId: user.id,
        action: parsed.data.isPublished !== undefined ? 'LANDING_PAGE_PUBLISH_CHANGED' : 'LANDING_PAGE_UPDATED',
        entity: 'LandingPage',
        entityId: lp.id,
        newData: { name: updated.name, slug: updated.slug, isPublished: updated.isPublished, productId: updated.productId },
      });
      // Going live from here promotes the draft, so the window cannot guess
      // what is now unpublished or what its next save must be based on: it
      // is told by the row. Only that press pays the read; taking a page
      // down or any other edit changes neither.
      const state = goingLive ? await draftState(lp.id) : null;
      return NextResponse.json({
        success: true,
        landingPage: updated,
        ...(state
          ? { hasUnpublished: state.hasUnpublished, canRevert: state.canRevert, publishedAt: state.publishedAt, base: state.base }
          : {}),
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        // Two unique keys reach here now; naming the wrong one sends the
        // seller to change a field that was never the problem.
        const onDomain = Array.isArray(e?.meta?.target)
          ? e.meta.target.includes('domain')
          : String(e?.meta?.target ?? '').includes('domain');
        return NextResponse.json(
          { error: onDomain ? 'هذا النطاق مستخدم بالفعل' : 'هذا الرابط (slug) مستخدم بالفعل في شركتك' },
          { status: 409 }
        );
      }
      throw e;
    }
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}

/** Forget the hosts that serve this page: its own domain and its store's. */
async function forgetPageHosts(lp: { domain: string | null; storeId: string | null }) {
  forgetHost(lp.domain);
  if (!lp.storeId) return;
  const store = await db.store.findFirst({ where: { id: lp.storeId }, select: { domain: true } });
  forgetHost(store?.domain);
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('landing_pages.delete');
    const { id } = await ctx.params;

    const lp = await loadLandingPage(id, companyId, storeId);
    if (!lp) return NextResponse.json({ error: 'صفحة الهبوط غير موجودة' }, { status: 404 });

    // Deleting an open store's front would leave its address answering 404
    // to every ad pointing at it.
    const front = await db.store.findFirst({
      where: { landingPageId: lp.id, storefrontEnabled: true },
      select: { name: true },
    });
    if (front) {
      return NextResponse.json(
        { error: `هذه الصفحة واجهة متجر «${front.name}» المفتوح — أغلق المتجر أولاً أو اختر له صفحة أخرى` },
        { status: 409 }
      );
    }

    await db.landingPage.delete({ where: { id: lp.id } });
    // A deleted page must stop being served from the cache at once, not a minute later.
    await refreshLandingPages({ slugs: [lp.slug] });
    await forgetPageHosts(lp);
    await logAudit({
      companyId,
      userId: user.id,
      action: 'LANDING_PAGE_DELETED',
      entity: 'LandingPage',
      entityId: lp.id,
      newData: { name: lp.name, slug: lp.slug },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}