import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { authorize, requirePermission } from '@/lib/authorization';
import { inStore } from '@/lib/store-filter';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { updateCompanySettings } from '@/lib/company-settings';
import { PRODUCT_SHAPES, PRODUCT_SHAPES_KEY, readProductShapes, readShapeMap, type ProductShape } from '@/lib/product-shapes';

/**
 * «شكل القطعة على البوليصة» OF ONE PRODUCT (the owner, 27/11) — see `src/lib/product-shapes.ts`.
 *
 *   GET → { shape }                     key `products.view`
 *   PUT { shape: key | null } → { shape }   key `products.edit`; null goes back to the generic «قطعة»
 *
 * The product must be this store's (the filter every product door uses) and inside the grant's scope. One key of the
 * company's settings document, written under its row lock; no column and no migration. It changes a drawing and a word
 * on a printed label, and nothing about the product, its price, its stock or any order.
 */

const body = z.object({ shape: z.union([z.null(), z.enum(PRODUCT_SHAPES)]) }).strict();

interface Ctx {
  params: Promise<{ id: string }>;
}

const refuse = (status: number, code: string, errorAr: string) => NextResponse.json({ error: errorAr, errorAr, code }, { status });

/** This store's product, if the key reaches it. Outside the grant's scope reads as «not found», as the product page does. */
async function reach(id: string, key: 'products.view' | 'products.edit') {
  const { user, companyId, storeId } = await requireContext();
  await requirePermission(key);
  const product = await db.product.findFirst({
    where: { id, ...inStore(companyId, storeId) },
    select: { id: true, companyId: true, storeId: true, categoryId: true },
  });
  if (!product || product.companyId !== companyId || !authorize(user, key, product).allowed) return null;
  return { user, companyId };
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const at = await reach(id, 'products.view');
    if (!at) return refuse(404, 'PRODUCT_NOT_FOUND', 'المنتج غير موجود');
    return NextResponse.json({ shape: (await readProductShapes(db, at.companyId))[id] ?? null });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const at = await reach(id, 'products.edit');
    if (!at) return refuse(404, 'PRODUCT_NOT_FOUND', 'المنتج غير موجود');

    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'BAD_SHAPE', 'اختار شكلاً من الأشكال المعروضة.');
    const after = parsed.data.shape;

    let before: ProductShape | null = null;
    await updateCompanySettings<Record<string, ProductShape>>(at.companyId, PRODUCT_SHAPES_KEY, (current) => {
      const next = readShapeMap(current);
      before = next[id] ?? null;
      if (after === null) delete next[id];
      else next[id] = after;
      return Object.keys(next).length ? next : undefined;
    });
    if (before !== after) {
      await logAudit({
        companyId: at.companyId, userId: at.user.id, action: 'PRODUCT_SHAPE_SET', entity: 'Product', entityId: id,
        previousData: { shape: before },
        newData: { shape: after },
      });
    }
    return NextResponse.json({ shape: after });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
