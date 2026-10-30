import { NextResponse } from 'next/server';
import { apiErrorResponse, forbiddenAr } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireAuth, requireCompanyTenant } from '@/lib/auth';
import { can } from '@/lib/authorization';
import { z } from 'zod';
import { logAudit } from '@/lib/audit';

const nameSchema = z.object({
  name: z.string().trim().min(2, 'اسم التصنيف قصير جداً').max(60, 'اسم التصنيف طويل جداً'),
  nameEn: z.string().trim().max(60).optional().nullable(),
});

/**
 * CATEGORIES — and why there were none.
 *
 * This file read them and nothing wrote them: the comment here said «Phase
 * 6 adds full CRUD» and Phase 6 never came. Measured on the dev database:
 * 114 products, 0 categories, 0 products categorised.
 *
 * That is not a cosmetic gap. `products.list` narrows by `categoryId` for
 * anyone whose permission is scoped to categories — so «this person sees
 * only the skincare line» is a setting the permissions screen offers, the
 * service enforces, and NOBODY COULD EVER CONFIGURE, because the list it
 * picks from is always empty. A capability that cannot be reached is
 * indistinguishable from a broken one.
 *
 * Writing was gated on `products.edit` rather than a key of its own, and the
 * gate never read the SCOPE of that grant — so someone who could edit only
 * the skincare line could rename and delete every shelf in the company.
 * Since PR-11 it asks `categories.manage`, and the migration
 * 20261030180000_categories_campaign_keys gave that key to whoever held the
 * product edit «كل الشركة» (and to nobody who held it narrower: D1m).
 * Reading stays on the three keys it always took, plus the new one —
 * whoever may name the shelves must be able to see them.
 */
export async function GET() {
  try {
    const user = await requireAuth();
    if (!can(user, 'categories.view') && !can(user, 'categories.manage') && !can(user, 'roles.edit') && !can(user, 'users.edit')) {
      return NextResponse.json(
        { error: 'Forbidden: missing required permission categories.view', errorAr: forbiddenAr('Forbidden: missing required permission categories.view') },
        { status: 403 }
      );
    }
    /*
     * ── THE OWNER'S OWN ACCOUNT HAS NO COMPANY ON IT ──
     *
     * A SUPER_ADMIN is a PLATFORM account: `user.companyId` is null, and he
     * works inside a company through the context selector. This line read
     * that null as «belongs to no company» and answered with an empty
     * list — so the owner opened «التصنيفات», saw nothing, pressed add, and
     * was told «لا شركة في السياق». The capability existed and he was the
     * one person who could not reach it.
     *
     * `requireCompanyTenant()` is the answer the rest of the system already
     * uses for this: it resolves the platform's company for a SUPER_ADMIN
     * and the user's own for everybody else. Nothing widens — a user with
     * no company and no SUPER_ADMIN role still throws there.
     */
    const { companyId } = await requireCompanyTenant();
    const categories = await db.category.findMany({
      where: { companyId },
      select: { id: true, name: true, nameEn: true },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json({ categories });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}

/** Whoever holds «إدارة التصنيفات» may name the shelves. */
async function editor() {
  const user = await requireAuth();
  if (!can(user, 'categories.manage')) {
    return { error: NextResponse.json({ error: 'Forbidden: missing categories.manage', errorAr: forbiddenAr('Forbidden: missing required permission categories.manage') }, { status: 403 }) };
  }
  // Same reason as the note in GET: the owner's account carries no company,
  // and `user.companyId` alone refused every write to the one person who
  // may make them.
  const { companyId } = await requireCompanyTenant();
  return { user, companyId };
}

/** POST /api/categories — create one. */
export async function POST(req: Request) {
  try {
    const gate = await editor();
    if ('error' in gate) return gate.error;
    const parsed = nameSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'اسم غير صالح' }, { status: 400 });
    }

    // `@@unique([companyId, name])` already forbids a duplicate; saying so
    // plainly beats a constraint error a person cannot read.
    const clash = await db.category.findFirst({
      where: { companyId: gate.companyId, name: parsed.data.name },
      select: { id: true },
    });
    if (clash) return NextResponse.json({ error: 'يوجد تصنيف بهذا الاسم' }, { status: 409 });

    const category = await db.category.create({
      data: { companyId: gate.companyId, name: parsed.data.name, nameEn: parsed.data.nameEn || null },
      select: { id: true, name: true, nameEn: true },
    });
    await logAudit({
      companyId: gate.companyId, userId: gate.user.id, action: 'CATEGORY_CREATED',
      entity: 'Category', entityId: category.id, newData: { name: category.name },
    });
    return NextResponse.json({ category }, { status: 201 });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}

/** PATCH /api/categories?id= — rename one. */
export async function PATCH(req: Request) {
  try {
    const gate = await editor();
    if ('error' in gate) return gate.error;
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'المعرّف مطلوب' }, { status: 400 });
    const parsed = nameSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'اسم غير صالح' }, { status: 400 });
    }

    const before = await db.category.findFirst({
      where: { id, companyId: gate.companyId },
      select: { id: true, name: true },
    });
    if (!before) return NextResponse.json({ error: 'لا تصنيف بهذا المعرّف' }, { status: 404 });

    const category = await db.category.update({
      where: { id },
      data: { name: parsed.data.name, nameEn: parsed.data.nameEn || null },
      select: { id: true, name: true, nameEn: true },
    });
    await logAudit({
      companyId: gate.companyId, userId: gate.user.id, action: 'CATEGORY_RENAMED',
      entity: 'Category', entityId: id,
      previousData: { name: before.name }, newData: { name: category.name },
    });
    return NextResponse.json({ category });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}

/**
 * DELETE /api/categories?id= — only an empty one.
 *
 * Refused while products still point at it, and the count is in the
 * message. Detaching them silently would be the quiet kind of damage:
 * anyone whose permission is scoped to categories would stop seeing
 * those products, with nothing on any screen explaining why.
 */
export async function DELETE(req: Request) {
  try {
    const gate = await editor();
    if ('error' in gate) return gate.error;
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'المعرّف مطلوب' }, { status: 400 });

    const category = await db.category.findFirst({
      where: { id, companyId: gate.companyId },
      select: { id: true, name: true, _count: { select: { products: true } } },
    });
    if (!category) return NextResponse.json({ error: 'لا تصنيف بهذا المعرّف' }, { status: 404 });
    if (category._count.products > 0) {
      return NextResponse.json(
        { error: `${category._count.products} منتجاً في هذا التصنيف — انقلها أوّلاً` },
        { status: 409 }
      );
    }

    await db.category.delete({ where: { id } });
    await logAudit({
      companyId: gate.companyId, userId: gate.user.id, action: 'CATEGORY_DELETED',
      entity: 'Category', entityId: id, previousData: { name: category.name },
    });
    return NextResponse.json({ deleted: true });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}
