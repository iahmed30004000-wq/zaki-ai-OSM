import { db } from '../db';
import { productCosts } from '../product-cost';
import { reservedElsewhere } from '../reservation';
import { MAX_WINDOW_DAYS, stockHealth } from '../stock-health';
import { DAY_MS, deliveredPerProduct, ledgerDepthDays } from '../stock-ledger';
import { inStore } from '../store-filter';
import { V1_CODE, V1Fault } from './door';
import { amountString } from './shape';
import type { SystemCaller } from './system-token';

/**
 * THE PRODUCT FIGURES THE MEDIA BUYER ASKS FOR — `?fields=…` on the catalogue.
 *
 * Every figure is one this system already computes for its own screens, read
 * through the same function, and where there is no single source the answer
 * is null and the PR says why. Nothing here is a new formula:
 *
 *   unit_cost_usd  `productCosts(...).average` — the weighted cost of what is
 *                  still on the shelf, the figure the inventory screen
 *                  estimates an unshipped order's cost from. Only when the
 *                  store keeps its books in dollars: there is no exchange
 *                  rate table here, and converting a lira cost at a rate
 *                  somebody typed into this file would be inventing money.
 *   stock_days     `stockHealth(...).coverDays` — «تكفي كم يوم» exactly as
 *                  the inventory screen prints it, from the same facts.
 *   (17/11, media-buyer PR-B) stock_units · daily_sales_7d · and stock_days WHEN the inventory screen has no answer:
 *       stock_units    what can still be promised: on the shelf minus what open orders hold, never below zero; null when the product never had a batch.
 *       daily_sales_7d units SHIPPED in the last seven days (quantity plus gift units, orders whose shippedAt is in the window) ÷ 7, two decimals.
 *       stock_days     the screen's own figure first; only when it has none, stock_units ÷ daily_sales_7d (never replacing a figure the screen gives).
 *
 *   delivery_fee   null. The fee is per COURIER per REGION (`DeliveryFee`),
 *   return_fee     not per product; any one figure would be a choice of
 *                  courier and city nobody made.
 *   cod_fee_pct    null. No courier, store or company here carries a COD
 *                  percentage at all.
 *
 * ── AND THEY ARE BEHIND THEIR OWN SCOPE ──
 *
 * The catalogue was built «بلا تكلفة ولا مخزون رقمي حساس» for the replies
 * system, and that stays true for it: asking for any of these without
 * `products.costs.read` is refused, not quietly answered.
 */

/** The optional fields the catalogue may be asked for. Anything else in `fields` is ignored. */
export const PRODUCT_FIELDS = [
  'aliases',
  'unit_cost_usd',
  'price_options',
  'stock_days',
  'stock_units',
  'daily_sales_7d',
  'delivery_fee',
  'return_fee',
  'cod_fee_pct',
] as const;
export type ProductField = (typeof PRODUCT_FIELDS)[number];

/** The ones that say what a thing costs or how long the shelf lasts. */
export const COST_FIELDS: ReadonlySet<ProductField> = new Set<ProductField>([
  'unit_cost_usd',
  'stock_days',
  'stock_units',
  'daily_sales_7d',
  'delivery_fee',
  'return_fee',
  'cod_fee_pct',
]);

/** `?fields=code,name,aliases` → the optional ones named. `code` and `name` are always sent. */
export function readFields(raw: string | null): Set<ProductField> {
  const out = new Set<ProductField>();
  for (const part of (raw ?? '').split(',')) {
    const f = part.trim();
    if ((PRODUCT_FIELDS as readonly string[]).includes(f)) out.add(f as ProductField);
  }
  return out;
}

/** Refuses a cost field to a key that was not granted `products.costs.read`. */
export function requireCostScope(caller: SystemCaller, wanted: Set<ProductField>): void {
  const asked = [...wanted].filter((f) => COST_FIELDS.has(f));
  if (asked.length > 0 && !caller.scopes.includes('products.costs.read')) {
    throw new V1Fault(403, V1_CODE.SCOPE_MISSING, 'The token lacks the scope products.costs.read', {
      required: 'products.costs.read',
      fields: asked,
    });
  }
}

export interface FigureProduct {
  id: string;
  storeId: string | null;
  currency: string;
  minorUnit: number;
}

export interface Figures {
  unit_cost_usd?: string | null;
  stock_days?: number | null;
  stock_units?: number | null;
  daily_sales_7d?: string | null;
  delivery_fee?: null;
  return_fee?: null;
  cod_fee_pct?: null;
}

/** The window of `daily_sales_7d`: units shipped in this many days, divided by it. */
export const SALES_WINDOW_DAYS = 7;

/**
 * Units SHIPPED per product since a moment, for one store — the lines of orders whose `shippedAt` is in the window (quantity plus gift units: gift units
 * leave the same shelf). Read only. An order that shipped and came back still counted when it left: the shelf was emptied.
 */
export async function shippedPerProduct(companyId: string, storeId: string, since: Date): Promise<Map<string, number>> {
  const lines = await db.orderItem.findMany({
    where: { order: { ...inStore(companyId, storeId), shippedAt: { gte: since } } },
    select: { productId: true, quantity: true, freeQuantity: true },
  });
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.productId, (out.get(l.productId) ?? 0) + l.quantity + l.freeQuantity);
  return out;
}

/** One decimal, the precision the inventory screen states a cover in. */
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The cost figures for each product, only the ones asked for. */
export async function productFigures(
  companyId: string,
  products: FigureProduct[],
  wanted: Set<ProductField>,
  now: Date = new Date()
): Promise<Map<string, Figures>> {
  const out = new Map<string, Figures>(products.map((p) => [p.id, {}]));
  if (products.length === 0) return out;
  const ids = products.map((p) => p.id);

  if (wanted.has('unit_cost_usd')) {
    const costs = await productCosts(db, companyId, ids);
    for (const p of products) {
      const c = costs.get(p.id);
      // No costed stock is «unknown», not «free».
      out.get(p.id)!.unit_cost_usd =
        p.currency === 'USD' && c && c.batchCount > 0 ? amountString(c.average, p.minorUnit) : null;
    }
  }

  if (wanted.has('stock_days') || wanted.has('stock_units') || wanted.has('daily_sales_7d')) {
    const batches = await db.productionBatch.findMany({
      where: { companyId, productId: { in: ids } },
      select: { productId: true, quantityRemaining: true, productionDate: true },
    });
    const since = new Date(now.getTime() - MAX_WINDOW_DAYS * DAY_MS);
    const weekAgo = new Date(now.getTime() - SALES_WINDOW_DAYS * DAY_MS);
    // What shipped in the last seven days, read once per store (only when a figure that needs it was asked for).
    const shipped = new Map<string, Awaited<ReturnType<typeof shippedPerProduct>>>();
    // The delivery record is the STORE's, read once per store.
    const ledger = new Map<string, { days: number; delivered: Awaited<ReturnType<typeof deliveredPerProduct>> }>();
    for (const storeId of new Set(products.map((p) => p.storeId).filter((s): s is string => !!s))) {
      const [days, delivered] = await Promise.all([
        ledgerDepthDays(companyId, storeId, now),
        deliveredPerProduct(companyId, storeId, since),
      ]);
      ledger.set(storeId, { days, delivered });
      if (wanted.has('stock_days') || wanted.has('daily_sales_7d')) shipped.set(storeId, await shippedPerProduct(companyId, storeId, weekAgo));
    }

    for (const p of products) {
      const mine = batches.filter((b) => b.productId === p.id);
      const store = p.storeId ? ledger.get(p.storeId) : undefined;
      const sales = store?.delivered.get(p.id);
      const firstStocked = mine.reduce<Date | null>(
        (oldest, b) => (oldest === null || b.productionDate < oldest ? b.productionDate : oldest),
        null
      );
      const health = stockHealth(
        {
          onHand: mine.reduce((sum, b) => sum + b.quantityRemaining, 0),
          reserved: await reservedElsewhere(db, companyId, p.id, undefined, p.storeId),
          batchCount: mine.length,
          deliveredUnits: sales?.units ?? 0,
          deliveredLines: sales?.lines ?? 0,
          ledgerDays: store?.days ?? 0,
          daysSinceLastSale: sales ? Math.max(0, (now.getTime() - sales.lastAt.getTime()) / DAY_MS) : null,
          daysStocked: firstStocked ? Math.max(0, (now.getTime() - firstStocked.getTime()) / DAY_MS) : null,
        },
        MAX_WINDOW_DAYS
      );
      const units = mine.length === 0 ? null : Math.max(0, health.available);
      const perDay = p.storeId && shipped.has(p.storeId) ? (shipped.get(p.storeId)!.get(p.id) ?? 0) / SALES_WINDOW_DAYS : null;
      const f = out.get(p.id)!;
      if (wanted.has('stock_units')) f.stock_units = units;
      if (wanted.has('daily_sales_7d')) f.daily_sales_7d = perDay === null ? null : perDay.toFixed(2);
      if (wanted.has('stock_days')) {
        // The inventory screen's own answer first; the contract's division only where that screen has none.
        f.stock_days =
          health.coverDays !== null
            ? round1(health.coverDays)
            : units !== null && perDay !== null && perDay > 0
              ? round1(units / perDay)
              : null;
      }
    }
  }

  for (const p of products) {
    const f = out.get(p.id)!;
    if (wanted.has('delivery_fee')) f.delivery_fee = null;
    if (wanted.has('return_fee')) f.return_fee = null;
    if (wanted.has('cod_fee_pct')) f.cod_fee_pct = null;
  }
  return out;
}
