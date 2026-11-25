import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { logAudit } from '@/lib/audit';
import { designData, designSchema, freeSlugFor, newPublicId, SLUG_TAKEN, slugTaken } from '@/lib/product-verify';

/**
 * GET/POST/PATCH/DELETE /api/settings/product-verify-pages — «باركود المنتجات», the owner's own designs of each
 * product's public page. Read on `settings.view`; every write on `settings.edit` — the same two keys as «رموز الأصالة».
 *
 *   GET                       the company's products (capped) and every page it has, with each page's old slugs
 *   GET ?suggest=<productId>  a free short link for that product (`/v/<slug>`), before its page exists
 *   POST  { productId, …design }   create the page of one product (one per product)
 *   PATCH { id, …design }          change it; a changed slug keeps the old one as a permanent redirect
 *   DELETE { id }                  remove it (its link and every printed barcode of it stop opening)
 *
 * THE SHORT LINK NEVER MISLEADS A PRINTED BARCODE. A slug is unique across every page AND every slug any page once
 * had (`slugTaken`): another product can never take a slug a barcode was printed with, and the page that had it may
 * take it back.
 */

const CAP = 500;

export async function GET(req: Request) {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');

    const suggestFor = new URL(req.url).searchParams.get('suggest');
    if (suggestFor) {
      const product = await db.product.findFirst({
        where: { id: suggestFor, companyId },
        select: { name: true, nameEn: true, sku: true },
      });
      if (!product) return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
      return NextResponse.json({ slug: await freeSlugFor(product) });
    }

    const [products, pages] = await Promise.all([
      db.product.findMany({
        where: { companyId },
        orderBy: { name: 'asc' },
        take: CAP,
        select: { id: true, name: true, nameEn: true, sku: true, image: true, status: true, store: { select: { logo: true } } },
      }),
      db.productVerifyPage.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        include: { oldSlugs: { select: { slug: true }, orderBy: { createdAt: 'desc' } } },
      }),
    ]);
    return NextResponse.json({ products, pages }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const createSchema = z.object({ productId: z.string().trim().min(1, 'اختار المنتج').max(100) });
const idSchema = z.object({ id: z.string().trim().min(1, 'حدّد الصفحة').max(100) });

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.edit');

    const body = await req.json().catch(() => null);
    const who = createSchema.safeParse(body);
    if (!who.success) return NextResponse.json({ error: zodMessage(who.error) }, { status: 400 });
    const parsed = designSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });

    const product = await db.product.findFirst({
      where: { id: who.data.productId, companyId },
      select: { id: true, name: true, nameEn: true, sku: true },
    });
    if (!product) return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });

    const existing = await db.productVerifyPage.findUnique({ where: { productId: product.id }, select: { id: true } });
    if (existing) return NextResponse.json({ error: 'لهالمنتج صفحة من قبل — عدّلها بدل ما تعمل وحدة جديدة' }, { status: 409 });

    let slug = parsed.data.slug;
    if (slug) {
      if (await slugTaken(slug)) return NextResponse.json({ error: SLUG_TAKEN }, { status: 409 });
    } else {
      slug = await freeSlugFor(product);
    }

    const row = await db.productVerifyPage.create({
      data: {
        ...designData(parsed.data),
        companyId,
        productId: product.id,
        publicId: newPublicId(),
        slug,
        createdById: user.id,
      },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PRODUCT_VERIFY_PAGE_CREATED',
      entity: 'ProductVerifyPage',
      entityId: row.id,
      newData: { productId: product.id, slug: row.slug, active: row.active },
    });

    return NextResponse.json({ page: { ...row, oldSlugs: [] } }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.edit');

    const body = await req.json().catch(() => null);
    const which = idSchema.safeParse(body);
    if (!which.success) return NextResponse.json({ error: zodMessage(which.error) }, { status: 400 });
    const parsed = designSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });

    const page = await db.productVerifyPage.findFirst({
      where: { id: which.data.id, companyId },
      select: { id: true, slug: true, active: true },
    });
    if (!page) return NextResponse.json({ error: 'الصفحة غير موجودة' }, { status: 404 });

    const data = designData(parsed.data);
    const newSlug = parsed.data.slug && parsed.data.slug !== page.slug ? parsed.data.slug : null;
    if (newSlug && (await slugTaken(newSlug, page.id))) {
      return NextResponse.json({ error: SLUG_TAKEN }, { status: 409 });
    }

    const row = await db.$transaction(async (tx) => {
      if (newSlug) {
        // The old slug stays this page's for ever — a printed barcode carries it — and redirects to the new one.
        await tx.productVerifyPageSlug.upsert({
          where: { slug: page.slug },
          create: { slug: page.slug, pageId: page.id },
          update: {},
        });
        // Taking back a slug this page once had: it is current again, so it is no longer an old one.
        await tx.productVerifyPageSlug.deleteMany({ where: { slug: newSlug, pageId: page.id } });
      }
      return tx.productVerifyPage.update({
        where: { id: page.id },
        data: { ...data, ...(newSlug ? { slug: newSlug } : {}) },
        include: { oldSlugs: { select: { slug: true }, orderBy: { createdAt: 'desc' } } },
      });
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PRODUCT_VERIFY_PAGE_UPDATED',
      entity: 'ProductVerifyPage',
      entityId: page.id,
      previousData: { slug: page.slug, active: page.active },
      newData: { slug: row.slug, active: row.active, fields: Object.keys(data) },
    });

    return NextResponse.json({ page: row });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.edit');

    const which = idSchema.safeParse(await req.json().catch(() => null));
    if (!which.success) return NextResponse.json({ error: zodMessage(which.error) }, { status: 400 });

    const page = await db.productVerifyPage.findFirst({
      where: { id: which.data.id, companyId },
      select: { id: true, slug: true, productId: true },
    });
    if (!page) return NextResponse.json({ error: 'الصفحة غير موجودة' }, { status: 404 });

    await db.productVerifyPage.delete({ where: { id: page.id } });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'PRODUCT_VERIFY_PAGE_DELETED',
      entity: 'ProductVerifyPage',
      entityId: page.id,
      previousData: { slug: page.slug, productId: page.productId },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
