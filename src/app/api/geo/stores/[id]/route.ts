import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { firstIssue, storeDeleteSchema, storeUpdateSchema } from '@/lib/geo-schemas';
import { standingStoreId } from '@/lib/geo-context';
import { blockersSentence, storeBlockers } from '@/lib/geo-removal';
import { validateDomain, forgetHost, dashboardHosts } from '@/lib/landing-domain';
import { refusalToOpen } from '@/lib/storefront-rules';
import { BENCH_STORE_CANNOT_OPEN_AR, BENCH_STORE_IS_OPEN_AR, LAST_REAL_STORE_AR, isBenchCheckViolation, realStoresHere } from '@/lib/test-store';

/**
 *   PATCH  /api/geo/stores/:id (geo.manage). countryId is immutable.
 *   DELETE /api/geo/stores/:id (geo.manage). Only a store with nothing entered
 *          on it, and only with its name typed — see `geo-removal.ts`.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');

    const parsed = storeUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });

    const before = await db.store.findFirst({ where: { id, companyId } });
    if (!before) return NextResponse.json({ error: 'المتجر غير موجود' }, { status: 404 });

    if (parsed.data.slug && parsed.data.slug !== before.slug) {
      // One public space for every company — see the create route.
      const clash = await db.store.findFirst({ where: { slug: parsed.data.slug, id: { not: id } }, select: { id: true } });
      if (clash) return NextResponse.json({ error: 'هذا المعرّف مستخدم لمتجر آخر' }, { status: 409 });
    }

    // ── The custom domain is NOT written here ──
    //
    // It has one editor: PATCH /api/store/domain, which clears
    // `domainVerifiedAt` whenever the address changes and sets it again
    // only after a real DNS lookup. Writing it here moved the address and
    // left the old verification standing — the dashboard showed a tick for
    // a host nobody had checked, and the customer met an error page.
    //
    // The schema drops it and `.strict()` refuses a body that carries one,
    // so a form still sending it fails loudly instead of half-working.
    const data: Record<string, unknown> = { ...parsed.data };

    // The theme is NOT written here. It has one editor
    // (PATCH /api/store/theme), and `.strict()` on the schema means a body
    // that carries one is refused rather than quietly ignored.

    // ── The storefront, as it would be after this save ──
    // A store with many products has no front page: turning a Single Product
    // store into one lets go of its page.
    const type = parsed.data.type ?? before.type;
    if (type !== 'SINGLE_PRODUCT' && before.landingPageId) data.landingPageId = null;
    const after = {
      id: before.id,
      companyId,
      slug: parsed.data.slug ?? before.slug,
      type,
      status: parsed.data.status ?? before.status,
      landingPageId: type === 'SINGLE_PRODUCT' ? before.landingPageId : null,
    };
    const live = parsed.data.storefrontEnabled ?? before.storefrontEnabled;

    // ── The switch «منصّة تجريب», as it would be after this save ──
    // A bench is never open to visitors. The database holds that with a CHECK
    // (`stores_test_bench_is_not_public`), and a CHECK answers a form with a generic
    // save error — so the two questions are asked HERE, in words, and the CHECK
    // stays the last line. Closing the storefront in the same save is allowed.
    const bench = parsed.data.isTest ?? before.isTest;
    if (bench && live) {
      return NextResponse.json(
        {
          error: parsed.data.storefrontEnabled === true ? BENCH_STORE_CANNOT_OPEN_AR : BENCH_STORE_IS_OPEN_AR,
          code: parsed.data.storefrontEnabled === true ? 'BENCH_CANNOT_OPEN' : 'BENCH_STORE_IS_OPEN',
        },
        { status: 409 }
      );
    }
    // The company keeps at least one real store: the bench learns from real
    // ones (its DNA panel) and every report is about them.
    if (parsed.data.isTest === true && !before.isTest) {
      const otherReal = await db.store.count({ where: { companyId, id: { not: id }, ...realStoresHere() } });
      if (otherReal === 0) return NextResponse.json({ error: LAST_REAL_STORE_AR, code: 'LAST_REAL_STORE' }, { status: 409 });
    }
    // The same rule as the Single Product screen — checked whenever this save
    // is what makes an open storefront (opened, re-typed, or un-paused).
    // Closing or pausing is always allowed.
    const opens =
      live && after.status === 'ACTIVE' &&
      (!before.storefrontEnabled || type !== before.type || before.status !== 'ACTIVE');
    if (opens) {
      const refusal = await refusalToOpen(after);
      if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });
    }

    let store;
    try {
      store = await db.store.update({ where: { id }, data });
    } catch (error) {
      // A save that raced past the two questions above (the storefront opened
      // between them and this write): the CHECK refused it, and the person
      // reads the same sentence either way.
      if (isBenchCheckViolation(error)) {
        return NextResponse.json({ error: BENCH_STORE_IS_OPEN_AR, code: 'BENCH_STORE_IS_OPEN' }, { status: 409 });
      }
      throw error;
    }
    await logAudit({
      companyId,
      userId: user.id,
      action: 'STORE_UPDATED',
      entity: 'Store',
      entityId: id,
      previousData: before,
      newData: store,
    });
    return NextResponse.json({ store });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Delete a store — the owner's «بدي زر لحذف المتجر اذا ما كان مدخل عليه اشي».
 *
 * Three keys, in this order, and every one is a refusal rather than a warning:
 *
 *   1. the permission (`geo.manage`) and the tenant — as every route here;
 *   2. the store's own name, typed — a finger that meant the pause button
 *      beside it cannot also type a name;
 *   3. NOTHING ENTERED ON IT, asked INSIDE the transaction that deletes, at
 *      the strictest isolation, so an order that arrives between the question
 *      and the delete makes this fail instead of vanishing with the shop.
 *      What «nothing entered» means is written once, in `geo-removal.ts`; the
 *      settings screen asks the same function to draw its button.
 *
 * What goes with the store is only what the person did not enter as
 * business: the three skeleton pages it was created with while they are still
 * the skeleton, the system's notifications about it, and its look. Orders,
 * customers, products, wallets and the rest stop it (409, with the list and
 * the counts) — an order is never deleted to make room for this.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('geo.manage');

    const parsed = storeDeleteSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error), code: 'CONFIRM_REQUIRED' }, { status: 400 });

    const store = await db.store.findFirst({ where: { id, companyId } });
    if (!store) return NextResponse.json({ error: 'المتجر غير موجود' }, { status: 404 });

    if (parsed.data.confirm.trim() !== store.name.trim()) {
      return NextResponse.json({ error: 'الاسم غير مطابق — اكتب اسم المتجر كما هو', code: 'CONFIRM_MISMATCH' }, { status: 400 });
    }

    const standing = await standingStoreId(user.id);
    const refused = await db.$transaction(
      async (tx) => {
        const why = (await storeBlockers(tx, [store], { companyId, selectedStoreId: standing })).get(id) ?? [];
        if (why.length > 0) return why;
        await tx.store.delete({ where: { id } });
        return null;
      },
      // Twenty-six counts, one after another on the one connection a transaction has: the default five seconds is a guess about the tables.
      { isolationLevel: 'Serializable', timeout: 20_000 }
    );
    if (refused) {
      return NextResponse.json(
        { error: blockersSentence('المتجر', refused), code: 'STORE_IN_USE', blockers: refused },
        { status: 409 }
      );
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: 'STORE_DELETED',
      entity: 'Store',
      entityId: id,
      previousData: store,
      newData: null,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
