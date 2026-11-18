import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { authorize } from '@/lib/authorization';
import { inStore } from '@/lib/store-filter';
import { zodMessage } from '@/lib/zod-message';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import {
  MAX_COMBINATIONS,
  MAX_OPTIONS,
  MAX_VALUES,
  VARIANT_SELECT,
  freeOfVariants,
  labelFor,
  parseVariantOptions,
  valuesOf,
} from '@/lib/product-variants';

/**
 * /api/products/[id]/variants — A PRODUCT'S OPTIONS AND COMBINATIONS (the owner, 2026-11-18).
 *
 *   GET  → { options, combinations: [{ id, values, label, sku, priceDelta, onHand, held, free, status }] }
 *   PUT  { options, combinations: [{ values, sku?, priceDelta, onHand, active }] } → the same, saved.
 *
 * WHO — reading is `products.view`; saving is `products.edit`, and a change of any combination's price delta also needs
 * `products.change_price`, as a change of the base price does on the product's own PATCH.
 *
 * WHAT — the options are written to `Product.variantOptions`; each combination is matched to its row by its values (so
 * an id stays the same while the seller edits a count or a delta, and old orders keep pointing at it). A combination
 * that is no longer in the list is ARCHIVED, never deleted: an order may name it. Saving no options at all turns the
 * product back into one without variants (every combination archived) — sold exactly as before.
 *
 * `onHand` is the counted number on the shelf for that combination; `held` is what confirmed orders hold of it, and
 * `free` what is left to promise. The product's batches are not touched here: they stay the ledger of the product.
 */

const valueSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(40),
  swatch: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});
const optionSchema = z.object({
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(40),
  values: z.array(valueSchema).min(1).max(MAX_VALUES),
});
const comboSchema = z.object({
  values: z.array(z.string().trim().min(1).max(40)).min(1).max(MAX_OPTIONS),
  sku: z.string().trim().max(80).nullable().optional(),
  priceDelta: z.number().finite().min(-1_000_000).max(1_000_000),
  onHand: z.number().int().min(0).max(10_000_000),
  active: z.boolean().optional().default(true),
});
const body = z.object({
  options: z.array(optionSchema).max(MAX_OPTIONS),
  combinations: z.array(comboSchema).max(MAX_COMBINATIONS),
});

async function productOf(id: string) {
  const { user, companyId, storeId } = await requireContext();
  const product = await db.product.findFirst({
    where: { id, ...inStore(companyId, storeId) },
    select: { id: true, companyId: true, storeId: true, categoryId: true, name: true, basePrice: true, variantOptions: true },
  });
  if (!product || product.companyId !== companyId) return { user, companyId, product: null };
  return { user, companyId, product };
}

async function view(companyId: string, product: { id: string; storeId: string | null; variantOptions: string | null }) {
  const options = parseVariantOptions(product.variantOptions);
  const rows = await db.productVariant.findMany({
    where: { companyId, productId: product.id },
    orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    select: VARIANT_SELECT,
  });
  const free = await freeOfVariants(db, { companyId, productId: product.id, rows, storeId: product.storeId });
  return {
    options,
    combinations: rows.map((r) => ({
      id: r.id,
      values: valuesOf(r),
      label: r.label,
      sku: r.sku,
      priceDelta: r.priceDelta,
      onHand: r.onHand,
      held: r.onHand - (free.get(r.id) ?? r.onHand),
      free: free.get(r.id) ?? r.onHand,
      status: r.status,
    })),
  };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { user, companyId, product } = await productOf(id);
    if (!product) return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
    if (!authorize(user, 'products.view', product).allowed) {
      return NextResponse.json({ error: 'عرض المنتجات ليس من صلاحيّاتك.' }, { status: 403 });
    }
    return NextResponse.json(await view(companyId, product));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { user, companyId, product } = await productOf(id);
    if (!product) return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
    if (!authorize(user, 'products.edit', product).allowed) {
      return NextResponse.json({ error: 'تعديل المنتج ليس من صلاحيّاتك.' }, { status: 403 });
    }

    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    const { options, combinations } = parsed.data;

    // Ids unique, every combination one known value per option, no combination twice.
    const optionIds = new Set(options.map((o) => o.id));
    if (optionIds.size !== options.length) return NextResponse.json({ error: 'اسم خيار مكرر.' }, { status: 400 });
    for (const o of options) {
      if (new Set(o.values.map((v) => v.id)).size !== o.values.length) {
        return NextResponse.json({ error: `قيمة مكررة في «${o.name}».` }, { status: 400 });
      }
    }
    const keys = new Set<string>();
    for (const c of combinations) {
      if (c.values.length !== options.length || c.values.some((v, i) => !options[i].values.some((x) => x.id === v))) {
        return NextResponse.json({ error: 'تركيبة لا تطابق الخيارات. أعد تحميل الصفحة.' }, { status: 400 });
      }
      const key = JSON.stringify(c.values);
      if (keys.has(key)) return NextResponse.json({ error: 'تركيبة مكررة.' }, { status: 400 });
      keys.add(key);
    }
    if (options.length > 0 && combinations.filter((c) => c.active).length === 0) {
      return NextResponse.json({ error: 'فعّل تركيبة واحدة على الأقل، أو احذف الخيارات.' }, { status: 400 });
    }

    const existing = await db.productVariant.findMany({ where: { companyId, productId: id }, select: VARIANT_SELECT });
    const byKey = new Map(existing.map((r) => [JSON.stringify(valuesOf(r)), r]));

    // A price delta that changes is a price change: the same key the base price asks for.
    const deltaChanged = combinations.some((c) => (byKey.get(JSON.stringify(c.values))?.priceDelta ?? 0) !== c.priceDelta);
    if (deltaChanged && !authorize(user, 'products.change_price', product).allowed) {
      return NextResponse.json({ error: 'تغيير فرق السعر ليس من صلاحيّاتك. اطلبها من مدير النظام.', code: 'PRICE_CHANGE_FORBIDDEN' }, { status: 403 });
    }

    const cleanOptions = options.map((o) => ({
      id: o.id,
      name: o.name,
      values: o.values.map((v) => ({ id: v.id, label: v.label, swatch: v.swatch ?? null })),
    }));

    await db.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: { variantOptions: cleanOptions.length > 0 ? JSON.stringify(cleanOptions) : null },
      });
      const kept = new Set<string>();
      for (const [i, c] of (cleanOptions.length > 0 ? combinations : []).entries()) {
        const key = JSON.stringify(c.values);
        const data = {
          label: labelFor(cleanOptions, c.values),
          sku: c.sku?.trim() || null,
          priceDelta: c.priceDelta,
          onHand: c.onHand,
          status: c.active ? 'ACTIVE' : 'ARCHIVED',
          sortOrder: i,
        };
        const row = byKey.get(key);
        if (row) {
          kept.add(row.id);
          await tx.productVariant.update({ where: { id: row.id }, data });
        } else {
          await tx.productVariant.create({ data: { companyId, productId: id, optionValues: key, ...data } });
        }
      }
      const gone = existing.filter((r) => !kept.has(r.id) && r.status !== 'ARCHIVED').map((r) => r.id);
      if (gone.length > 0) await tx.productVariant.updateMany({ where: { id: { in: gone } }, data: { status: 'ARCHIVED' } });
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PRODUCT_VARIANTS_SET',
      entity: 'Product',
      entityId: id,
      previousData: { options: parseVariantOptions(product.variantOptions).map((o) => o.name), combinations: existing.filter((r) => r.status === 'ACTIVE').length },
      newData: { options: cleanOptions.map((o) => o.name), combinations: combinations.filter((c) => c.active).length },
    });

    const fresh = await db.product.findFirst({ where: { id }, select: { id: true, storeId: true, variantOptions: true } });
    return NextResponse.json(await view(companyId, fresh ?? product));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
