import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { rateOf } from '@/lib/order-state';
import { benchExcludedAr, realStoresHere } from '@/lib/test-store';
import { dnaLineAr, readDna, whyNoDna, type DnaProduct } from '@/lib/product-dna';

/**
 * GET /api/growth/bench — the test bench's own results, and the shop's DNA.
 *
 * «منتج تيست … جدولُ النتائج، لوحةٌ خاصّة، أرقامٌ لا تدخل أيَّ حسبة». The
 * numbers are refused everywhere else in this product; this is the one door
 * built to read them, which is why `benchOnly()` is named in
 * `test-store.ts` beside the filter that excludes them — both halves of the
 * rule in one file rather than one half here and one half there.
 *
 * ── AND THE DNA READING IS OF THE REAL SHOP, NOT OF THE BENCH ──
 *
 * «إنشاءُ منتج من DNA منتجاتك الناجحة». The pattern is read from the
 * products that SOLD — which are the real stores' — because that is the
 * whole question: what did the ones that worked have in common, so the next
 * thing on the bench can have it too. Reading the bench's own products
 * would be asking the experiment what the answer is.
 *
 * It writes nothing. Everything here is a count.
 */
export async function GET() {
  try {
    const { companyId, country } = await requireContext();
    await requirePermission('growth.intelligence');

    /*
     * THE BENCH STORES. Plural on purpose: a shop may run one bench per
     * country, and a reading that assumed one would silently show the first.
     */
    const benches = await db.store.findMany({
      where: { companyId, isTest: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    /*
     * EVERY PRODUCT ON THE BENCH, AND WHAT HAPPENED TO IT.
     *
     * Grouped rather than counted per product: fifty niche products is
     * fifty round trips the other way, and the owner's own brief says
     * «٥٠ منتجاً بنيتشات».
     */
    const benchIds = benches.map((b) => b.id);
    const products = benchIds.length
      ? await db.product.findMany({
          where: { companyId, storeId: { in: benchIds } },
          select: {
            id: true, name: true, sku: true, basePrice: true, storeId: true,
            createdAt: true, category: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
        })
      : [];

    const grouped = benchIds.length
      ? await db.order.groupBy({
          by: ['productId', 'shippingStatus'],
          where: { companyId, storeId: { in: benchIds } },
          _count: { _all: true },
        })
      : [];

    const tally = new Map<string, { orders: number; delivered: number; returned: number }>();
    for (const row of grouped) {
      if (!row.productId) continue;
      const t = tally.get(row.productId) ?? { orders: 0, delivered: 0, returned: 0 };
      t.orders += row._count._all;
      if (row.shippingStatus === 'DELIVERED' || row.shippingStatus === 'PARTIALLY_DELIVERED') {
        t.delivered += row._count._all;
      }
      if (row.shippingStatus === 'RETURNED' || row.shippingStatus === 'RETURN_REQUESTED') {
        t.returned += row._count._all;
      }
      tally.set(row.productId, t);
    }

    const byId = new Map(benches.map((b) => [b.id, b.name]));
    const results = products.map((p) => {
      const t = tally.get(p.id) ?? { orders: 0, delivered: 0, returned: 0 };
      const decided = t.delivered + t.returned;
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        bench: p.storeId ? byId.get(p.storeId) ?? null : null,
        price: Number(p.basePrice ?? 0),
        category: p.category?.name ?? null,
        triedAt: p.createdAt,
        orders: t.orders,
        delivered: t.delivered,
        returned: t.returned,
        /*
         * OUT OF WHAT THE BENCH FINISHED WITH, the same denominator
         * `couriers/score` uses: a parcel still in a van is not a verdict on
         * a product either. Null below the first decision rather than 0%,
         * because «0%» about a product tried yesterday is a lie.
         */
        deliveryRate: rateOf(t.delivered, decided),
        decided,
      };
    });

    /*
     * THE SHOP'S OWN PATTERN — read from the REAL stores, and refused below
     * the floor. Measured when this was written: one product in this
     * company has ever been ordered, so the reading answers nothing and
     * says the count. See product-dna.ts.
     */
    const realProducts = await db.product.findMany({
      where: { companyId, OR: [{ storeId: null }, { store: realStoresHere() }] },
      select: {
        id: true, name: true, basePrice: true, attributes: true,
        category: { select: { name: true } },
      },
    });
    const realDelivered = await db.order.groupBy({
      by: ['productId'],
      where: { companyId, store: realStoresHere(), shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] } },
      _count: { _all: true },
    });
    const deliveredOf = new Map(realDelivered.map((r) => [r.productId, r._count._all]));

    const dnaInput: DnaProduct[] = realProducts.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category?.name ?? null,
      price: Number(p.basePrice ?? 0),
      delivered: deliveredOf.get(p.id) ?? 0,
      attributes: (p.attributes ?? null) as Record<string, unknown> | null,
    }));
    const dna = readDna(dnaInput);

    return NextResponse.json({
      currency: country.currencyCode,
      benches,
      results,
      /*
       * AND WHAT THE BUSINESS'S FIGURES LEFT OUT, said in words. A total
       * that silently differs from the orders list is a total somebody
       * spends an afternoon on.
       */
      excluded: benchExcludedAr(results.reduce((n, r) => n + r.orders, 0)),
      dna: {
        sellers: dna.sellers,
        minSellers: dna.minSellers,
        traits: dna.traits?.map((t) => ({ ...t, line: dnaLineAr(t) })) ?? null,
        whyNot: whyNoDna(dna),
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
