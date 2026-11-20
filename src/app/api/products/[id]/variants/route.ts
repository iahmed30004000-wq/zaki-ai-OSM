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
import {
  VariantCountRefused,
  countPlace,
  countPlacedVariants,
  countReason,
  countRefusalBody,
  placesOfVariants,
  variantsArePlaced,
} from '@/lib/variant-stock';
import { reachesWarehouse } from '@/lib/warehouses';

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
 *
 * 19/11 (W8a) — A STORE PLACED IN WAREHOUSES. A combination's count lives per warehouse (`variant-stock.ts`), so:
 *   GET  adds `placed: true` and, per combination, `places: [{ warehouseId (null = «بلا مكان»), onHand }]`.
 *   PUT  `{ …, warehouseId, reason }` is a COUNT of that warehouse: each combination's `onHand` is what the warehouse
 *        holds of it, checked by the receiving door's rule (the store's country, running, reached by the person); a
 *        changed count needs a reason, and every change is a ledger line. Without `warehouseId` the PUT may still save
 *        options, labels, prices and status, but every `onHand` it sends must be the combination's present total (a new
 *        one: 0) — a changed number without a warehouse is refused (`WAREHOUSE_REQUIRED`), never written over the places.
 * A store that is NOT placed answers and writes exactly as before: the fields above are neither read nor returned.
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
  const out = {
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
  // 19/11 (W8a): a placed store's combinations say where their pieces are. Any other store: the answer above, unchanged.
  if (!(await variantsArePlaced(db, product.storeId))) return out;
  const places = await placesOfVariants(db, rows);
  return { ...out, placed: true, combinations: out.combinations.map((c) => ({ ...c, places: places.get(c.id) ?? [] })) };
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

    const raw: unknown = await req.json().catch(() => null);
    const parsed = body.safeParse(raw);
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

    // 19/11 (W8a): a store placed in warehouses saves through its own path — the counts are a warehouse's, with a reason.
    if (await variantsArePlaced(db, product.storeId)) {
      const extra = (raw && typeof raw === 'object' ? raw : {}) as { warehouseId?: unknown; reason?: unknown };
      const counted = await savePlaced({ user, companyId, product, cleanOptions, combinations, existing, byKey, warehouseId: extra.warehouseId, reason: extra.reason });
      if (counted instanceof NextResponse) return counted;
      await logAudit({
        companyId,
        userId: user.id,
        action: 'PRODUCT_VARIANTS_SET',
        entity: 'Product',
        entityId: id,
        previousData: { options: parseVariantOptions(product.variantOptions).map((o) => o.name), combinations: existing.filter((r) => r.status === 'ACTIVE').length },
        newData: {
          options: cleanOptions.map((o) => o.name),
          combinations: combinations.filter((c) => c.active).length,
          ...(counted.warehouseId ? { count: { warehouseId: counted.warehouseId, reason: counted.reason, changed: counted.changed } } : {}),
        },
      });
      const freshPlaced = await db.product.findFirst({ where: { id }, select: { id: true, storeId: true, variantOptions: true } });
      return NextResponse.json(await view(companyId, freshPlaced ?? product));
    }

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
    if (error instanceof VariantCountRefused) return NextResponse.json(countRefusalBody(error), { status: error.status });
    return apiErrorResponse(error);
  }
}

type Combination = z.infer<typeof comboSchema>;
type ExistingRow = { id: string; onHand: number; status: string };

/**
 * THE PLACED STORE'S SAVE (W8a). The options, labels, deltas and status are written as the store-level path writes them
 * — but never `onHand`: that is `variant-stock.ts`'s alone. With a warehouse, each combination's `onHand` is that
 * warehouse's count and goes through `countPlacedVariants`; without one, a number that differs from the present total is
 * refused. Everything in ONE transaction, after the warehouse is checked under the product's stock lock.
 */
async function savePlaced(p: {
  user: Awaited<ReturnType<typeof requireContext>>['user'];
  companyId: string;
  product: { id: string; storeId: string | null };
  cleanOptions: { id: string; name: string; values: { id: string; label: string; swatch: string | null }[] }[];
  combinations: Combination[];
  existing: ExistingRow[];
  byKey: Map<string, ExistingRow>;
  warehouseId: unknown;
  reason: unknown;
}): Promise<NextResponse | { warehouseId: string | null; reason: string | null; changed: number }> {
  const named = typeof p.warehouseId === 'string' && p.warehouseId.trim().length > 0;
  const listed = p.cleanOptions.length > 0 ? p.combinations : [];
  if (!named && listed.some((c) => c.onHand !== (p.byKey.get(JSON.stringify(c.values))?.onHand ?? 0))) {
    const e = new VariantCountRefused('WAREHOUSE_REQUIRED');
    return NextResponse.json(countRefusalBody(e), { status: e.status });
  }
  const reason = countReason(p.reason);

  return db.$transaction(async (tx) => {
    // The warehouse first, under the product's stock lock (the split's order: that lock, then rows).
    const warehouseId = named
      ? await countPlace(tx, {
          companyId: p.companyId,
          storeId: p.product.storeId,
          productId: p.product.id,
          warehouseId: p.warehouseId,
          mayUse: (w) => reachesWarehouse(p.user, p.companyId, w),
        })
      : null;
    // A count that changes nothing needs no reason; one that changes a number does — asked before anything is written.
    if (warehouseId && !reason) {
      const places = await placesOfVariants(tx, p.existing);
      const inHere = (id: string) => places.get(id)?.find((x) => x.warehouseId === warehouseId)?.onHand ?? 0;
      const changes = listed.some((c) => {
        const row = p.byKey.get(JSON.stringify(c.values));
        return c.onHand !== (row ? inHere(row.id) : 0);
      });
      if (changes) throw new VariantCountRefused('REASON_REQUIRED');
    }
    await tx.product.update({
      where: { id: p.product.id },
      data: { variantOptions: p.cleanOptions.length > 0 ? JSON.stringify(p.cleanOptions) : null },
    });
    const kept = new Set<string>();
    const counts = new Map<string, number>();
    for (const [i, c] of listed.entries()) {
      const key = JSON.stringify(c.values);
      const data = {
        label: labelFor(p.cleanOptions, c.values),
        sku: c.sku?.trim() || null,
        priceDelta: c.priceDelta,
        status: c.active ? 'ACTIVE' : 'ARCHIVED',
        sortOrder: i,
      };
      const row = p.byKey.get(key);
      if (row) {
        kept.add(row.id);
        await tx.productVariant.update({ where: { id: row.id }, data });
        counts.set(row.id, c.onHand);
      } else {
        const made = await tx.productVariant.create({ data: { companyId: p.companyId, productId: p.product.id, optionValues: key, ...data }, select: { id: true } });
        counts.set(made.id, c.onHand);
      }
    }
    const gone = p.existing.filter((r) => !kept.has(r.id) && r.status !== 'ARCHIVED').map((r) => r.id);
    if (gone.length > 0) await tx.productVariant.updateMany({ where: { id: { in: gone } }, data: { status: 'ARCHIVED' } });

    if (!warehouseId) return { warehouseId: null, reason: null, changed: 0 };
    // No reason = the check above found nothing to change: nothing is counted (a delivery since then is not undone).
    if (!reason) return { warehouseId, reason: null, changed: 0 };
    const changed = await countPlacedVariants(
      tx,
      { companyId: p.companyId, storeId: p.product.storeId, userId: p.user.id },
      { warehouseId, reason, counts }
    );
    return { warehouseId, reason, changed };
  });
}
