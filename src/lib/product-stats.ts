/**
 * THE FIGURES ABOVE THE PRODUCTS LIST, AND THE «المبيعات» COLUMN BESIDE EVERY ROW — ONE SUMMARY, FROM THE SERVER.
 *
 * The owner, 21/10: «بطاقات ذكية في المنتجات زي احصائيات» and «المبيعات في جدول المنتجات فش ارقام؟». Both come from one
 * finding. The column read `analytics.totalSold`, which is the sum of `ProductionBatch.quantitySold` — a counter that is
 * only moved when a delivery draws its units from a production batch. A delivery recorded before batches existed, or one
 * the courier statement closed, never touched it: measured on the local database, 14 products carry 17,664 delivered units
 * and the column showed 0 for 13 of them. A counter that is right only for the deliveries that happened to be recorded one
 * way is not «sales».
 *
 * WHAT «SOLD» IS HERE. The units a customer actually took: for every line of an order that reached the door as delivered
 * (`DELIVERED` or `PARTIALLY_DELIVERED`), `deliveredQty` where the door settled the parcel — the part of a part-delivery that
 * was kept — and otherwise `quantity + freeQuantity`, because the gift is a real unit of the same product that left the shelf
 * (the rule `stock-consumption.ts` draws by). Since the first order: a sales column is a running total, and a window would make
 * it say a different thing every month.
 *
 * Nothing here is arithmetic about MONEY except the value of the stock, which is the sum of what `product-cost.ts` already
 * says each product's stock is worth — one owner for that figure, summed and not recomputed.
 */

export interface StatsProduct {
  id: string;
  status: string;
  categoryId: string | null;
}

export interface ProductStats {
  /** Delivered units per product, since the first order. A product nobody has received is absent — the screen reads it as 0 once this answer is in. */
  unitsSold: Record<string, number>;
  totals: {
    /** Every product in the caller's catalogue scope. */
    products: number;
    /** …of which the status is «نشط». */
    active: number;
    /** …of which have no category. */
    unfiled: number;
    /** …of which hold no units on hand. */
    outOfStock: number;
    /** Units on hand, summed over the products. */
    unitsOnHand: number;
    /** Units delivered, summed over the products. */
    unitsSold: number;
    /** What the stock on hand is worth. ABSENT — not zero — for a caller who may not see what goods cost. */
    stockValue?: number;
  };
  /** The product with the most delivered units, if any was delivered at all. */
  top: { id: string; units: number } | null;
}

/**
 * What the door SENDS: the whole answer to a caller who may read the smart cards (`insights.view`), only the units per product
 * — the column in the list — to everybody else. `totals` and `top` are ABSENT then, never zero.
 */
export type ProductStatsAnswer = Pick<ProductStats, 'unitsSold'> & Partial<Pick<ProductStats, 'totals' | 'top'>>;

export function summariseProducts(input: {
  products: readonly StatsProduct[];
  /** Units on hand per product (a product with none may be absent). */
  onHand: ReadonlyMap<string, number>;
  /** Value of the stock per product, or `null` when the caller may not see cost. */
  stockValue: ReadonlyMap<string, number> | null;
  /** Delivered units per product. */
  unitsSold: ReadonlyMap<string, number>;
}): ProductStats {
  const sold: Record<string, number> = {};
  let unitsSold = 0;
  let unitsOnHand = 0;
  let value = 0;
  let active = 0;
  let unfiled = 0;
  let outOfStock = 0;
  let top: ProductStats['top'] = null;

  for (const p of input.products) {
    if (p.status === 'ACTIVE') active += 1;
    if (p.categoryId === null) unfiled += 1;

    const held = input.onHand.get(p.id) ?? 0;
    if (held <= 0) outOfStock += 1;
    else unitsOnHand += held;

    value += input.stockValue?.get(p.id) ?? 0;

    const units = input.unitsSold.get(p.id) ?? 0;
    if (units > 0) {
      sold[p.id] = units;
      unitsSold += units;
      // A tie goes to the smaller id, so two reads of the same data name the same product.
      if (top === null || units > top.units || (units === top.units && p.id < top.id)) top = { id: p.id, units };
    }
  }

  return {
    unitsSold: sold,
    totals: {
      products: input.products.length,
      active,
      unfiled,
      outOfStock,
      unitsOnHand,
      unitsSold,
      ...(input.stockValue ? { stockValue: Number(value.toFixed(3)) } : {}),
    },
    top,
  };
}
