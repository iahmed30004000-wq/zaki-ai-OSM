import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { refreshLandingPages } from '@/lib/landing-cache';
import { cartBarApplies, parseStoreTheme, storeThemeSchema } from '@/lib/store-theme';

/**
 * THE LOOK OF THE STORE THAT IS SELECTED.
 *
 * One store, one theme, one editor. The store id is never taken from the
 * body: it is the store the session is in, the same one every order and
 * every stock movement is filed under — so a request cannot repaint a shop
 * the person is not working in by naming its id.
 *
 * `geo.manage` is about which stores EXIST. Painting one is `storefront.*`,
 * so a designer can lay out the shop without being able to open or close
 * it, and a manager who opens stores is not thereby a designer.
 */

const select = {
  id: true, name: true, type: true, theme: true, logo: true, favicon: true,
  themeDraft: true, themePublishedAt: true, themePrevious: true,
} as const;

export async function GET() {
  try {
    const { storeId, companyId } = await requireContext();
    await requirePermission('storefront.view');

    const store = await db.store.findFirst({ where: { id: storeId!, companyId }, select });
    if (!store) return NextResponse.json({ error: 'المتجر غير موجود' }, { status: 404 });

    return NextResponse.json({
      store: {
        id: store.id,
        name: store.name,
        type: store.type,
        // The logo and the favicon are the store's IDENTITY, edited in
        // «البلدان والمتاجر». They are returned so the screen can show what
        // is already set and link to it — never so it can offer a second
        // control for the same field.
        logo: store.logo,
        favicon: store.favicon,
        cartBarApplies: cartBarApplies(store.type),
      },
      /**
       * THE DRAFT IS WHAT THE EDITOR EDITS.
       *
       * `theme` is what every live page paints from. A shop that has never
       * been edited has no draft, and then the draft IS the live one — so
       * the screen opens on what the shop looks like, which is the only
       * sensible starting point.
       */
      theme: parseStoreTheme(store.themeDraft ?? store.theme),
      live: parseStoreTheme(store.theme),
      // What «نشر» would change, so the confirmation can say it — the same
      // shape the home page's own publish already answers with.
      hasUnpublished: (store.themeDraft ?? store.theme) !== store.theme,
      publishedAt: store.themePublishedAt,
      // One step back exists only after a publish that replaced something.
      canRevert: Boolean(store.themePrevious),
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, storeId, companyId } = await requireContext();
    await requirePermission('storefront.manage');

    const before = await db.store.findFirst({ where: { id: storeId!, companyId }, select });
    if (!before) return NextResponse.json({ error: 'المتجر غير موجود' }, { status: 404 });

    const body = await req.json().catch(() => null);
    const parsed = storeThemeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error), errorAr: zodMessage(parsed.error) }, { status: 400 });
    }

    // A Single Product store has no cart, so it has no cart bar to
    // configure. The tab is absent from the screen; this is why hiding it
    // was not the enforcement.
    const theme = { ...parsed.data };
    if (!cartBarApplies(before.type)) delete (theme as { cartBar?: unknown }).cartBar;

    /**
     * THE DRAFT, NEVER WHAT IS LIVE.
     *
     * This wrote `theme` directly, so a seller moving a colour repainted
     * the shop for every customer standing in it — while the home page
     * beside it had had a draft and a deliberate publish since the day it
     * was written. «مسودة · نشر بتأكيد» is one sentence in the brief and
     * it was true of half the screen.
     */
    await db.store.update({ where: { id: before.id }, data: { themeDraft: JSON.stringify(theme) } });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'STORE_THEME_DRAFT_SAVED',
      entity: 'Store',
      entityId: before.id,
      previousData: { draft: before.themeDraft },
      newData: { draft: JSON.stringify(theme) },
    });

    return NextResponse.json({ theme: parseStoreTheme(JSON.stringify(theme)), hasUnpublished: JSON.stringify(theme) !== before.theme });
  } catch (e) {
    return apiErrorResponse(e);
  }
}


/**
 * PUBLISH — the one act a customer feels, and the only one that needs a
 * second person's permission.
 *
 * `storefront.publish`, not `storefront.manage`: the same split the home
 * page already makes. A designer may lay the shop out all day; putting it
 * in front of customers is somebody who decides it goes out.
 *
 * What was live is kept, once. «رجوع للنسخة السابقة بضغطة» is a step back
 * and not a history — a seller who regrets a publish wants the thing they
 * had a minute ago. A version list is a different feature and would be a
 * different column.
 */
export async function POST() {
  try {
    const { user, storeId, companyId } = await requireContext();
    await requirePermission('storefront.publish');

    const store = await db.store.findFirst({ where: { id: storeId!, companyId }, select });
    if (!store) return NextResponse.json({ error: 'المتجر غير موجود' }, { status: 404 });

    const draft = store.themeDraft ?? store.theme;
    if (draft === store.theme) {
      return NextResponse.json({ error: 'لا تغييرات غير منشورة', code: 'NOTHING_TO_PUBLISH' }, { status: 409 });
    }

    await db.store.update({
      where: { id: store.id },
      data: { theme: draft, themePrevious: store.theme, themePublishedAt: new Date() },
    });
    // Every landing page of this store just changed too — its order form asks what «الدفع» says, and wears the
    // store's family. The cached ones are rebuilt now, not in a minute. Never throws: the publish above is written.
    await refreshLandingPages({ storeId: store.id, companyId });

    await logAudit({
      companyId, userId: user.id, action: 'STORE_THEME_PUBLISHED',
      entity: 'Store', entityId: store.id,
      previousData: { theme: store.theme },
      newData: { theme: draft },
    });

    return NextResponse.json({ theme: parseStoreTheme(draft), hasUnpublished: false, canRevert: true });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

/**
 * ONE STEP BACK, IN ONE PRESS.
 *
 * It restores what was live before the last publish, and makes the thing
 * being undone the next step back — so a seller who reverts by mistake
 * presses it again and is where they were. Anything else would be a trap
 * dressed as an undo.
 *
 * The DRAFT is restored with it. A revert that put the old look live and
 * left the regretted one sitting in the editor would publish it again the
 * next time anybody pressed «نشر».
 *
 * It is a publish — a customer feels it — so it is `storefront.publish`.
 */
export async function PUT() {
  try {
    const { user, storeId, companyId } = await requireContext();
    await requirePermission('storefront.publish');

    const store = await db.store.findFirst({ where: { id: storeId!, companyId }, select });
    if (!store) return NextResponse.json({ error: 'المتجر غير موجود' }, { status: 404 });
    if (!store.themePrevious) {
      return NextResponse.json({ error: 'لا نسخة سابقة لهذا المتجر', code: 'NO_PREVIOUS' }, { status: 409 });
    }

    await db.store.update({
      where: { id: store.id },
      data: {
        theme: store.themePrevious,
        themeDraft: store.themePrevious,
        themePrevious: store.theme,
        themePublishedAt: new Date(),
      },
    });
    // A step back is a publish, so the store's landing pages are rebuilt with it — the same as above.
    await refreshLandingPages({ storeId: store.id, companyId });

    await logAudit({
      companyId, userId: user.id, action: 'STORE_THEME_REVERTED',
      entity: 'Store', entityId: store.id,
      previousData: { theme: store.theme },
      newData: { theme: store.themePrevious },
    });

    return NextResponse.json({
      theme: parseStoreTheme(store.themePrevious),
      hasUnpublished: false,
      canRevert: true,
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
