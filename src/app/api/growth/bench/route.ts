import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { rateOf } from '@/lib/order-state';
import { benchExcludedAr, realStoresHere } from '@/lib/test-store';
import { dnaLineAr, readDna, whyNoDna, type DnaProduct } from '@/lib/product-dna';
import { localDay } from '@/lib/eod-report';
import { logAudit } from '@/lib/audit';
import { judgeBenchProduct, type BenchOrderDay } from '@/lib/bench-verdict';
import { addSpend, correctSpend, liveSpend, voidSpend, BenchRefused } from '@/lib/bench-spend';
import { benchProduct, changeBenchSpend, readBenchBook, saveBenchRules } from '@/lib/bench-book';

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
 * The GET writes nothing. Everything here is a count.
 *
 * ── AND THE VERDICT (18/11) ──
 *
 * Each product also carries its test: spend to date, orders, confirmed,
 * the confirmation rate, cost per order and per confirmed order, the day of
 * the test, and the verdict by the owner's rules (src/lib/bench-verdict.ts —
 * every number is computed there, none here). The POST writes the two things
 * the verdict needs from a person: a product's rules, and its spend by day.
 * Both stay in the company's settings (src/lib/bench-book.ts); nothing here
 * touches an order, the books or a commission.
 */
export async function GET() {
  try {
    const { companyId, country } = await requireContext();
    await requirePermission('growth.intelligence');

    /*
     * THE BENCH STORES. Plural on purpose: a shop may run one bench per
     * country, and a reading that assumed one would silently show the first.
     */
    const benchRows = await db.store.findMany({
      where: { companyId, isTest: true },
      select: { id: true, name: true, country: { select: { currencyCode: true, minorUnit: true, timezone: true } } },
      orderBy: { name: 'asc' },
    });
    const benches = benchRows.map((b) => ({ id: b.id, name: b.name }));
    // Each bench's own money and day: «currency = the store's currency», «day = the store's day».
    const placeOf = new Map(benchRows.map((b) => [b.id, b.country]));

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

    /*
     * THE VERDICT'S INPUTS: each order's store day and whether it was
     * CONFIRMED — nothing about shipping, because a bench order stops at
     * confirmation. Three columns per order, bench stores only.
     */
    const dated = benchIds.length
      ? await db.order.findMany({
          where: { companyId, storeId: { in: benchIds } },
          select: { productId: true, storeId: true, createdAt: true, confirmationStatus: true },
        })
      : [];
    const now = new Date();
    const ordersOf = new Map<string, BenchOrderDay[]>();
    for (const o of dated) {
      const place = o.productId && o.storeId ? placeOf.get(o.storeId) : undefined;
      if (!o.productId || !place) continue;
      const list = ordersOf.get(o.productId) ?? [];
      list.push({ day: localDay(o.createdAt, place.timezone), confirmed: o.confirmationStatus === 'CONFIRMED' });
      ordersOf.set(o.productId, list);
    }
    const book = await readBenchBook(companyId);

    const byId = new Map(benches.map((b) => [b.id, b.name]));
    const results = products.map((p) => {
      const t = tally.get(p.id) ?? { orders: 0, delivered: 0, returned: 0 };
      const decided = t.delivered + t.returned;
      const place = (p.storeId && placeOf.get(p.storeId)) || { currencyCode: country.currencyCode, minorUnit: country.minorUnit, timezone: country.timezone };
      const { rules, custom } = book.rulesOf(p.id);
      const entries = book.spendOf(p.id);
      const { figures, verdict } = judgeBenchProduct({
        today: localDay(now, place.timezone),
        minorUnit: place.minorUnit,
        rules,
        orders: ordersOf.get(p.id) ?? [],
        spend: liveSpend(entries),
      });
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
        /*
         * THE TEST: its period's figures, the rules they were judged by
         * (so a verdict after a mid-test edit says which numbers it used),
         * the verdict, and the hand-written spend with its voided lines.
         */
        currency: place.currencyCode,
        minorUnit: place.minorUnit,
        today: localDay(now, place.timezone),
        test: figures,
        rules,
        customRules: custom,
        verdict,
        spendEntries: [...entries].sort((a, b) => (a.day === b.day ? a.at.localeCompare(b.at) : b.day.localeCompare(a.day))),
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

/**
 * POST /api/growth/bench — the owner's numbers for one bench product.
 *
 *   { action: 'rules',   productId, rules }            rules = null → back to the defaults
 *   { action: 'spend',   productId, day, amount }      one live entry per day
 *   { action: 'correct', productId, entryId, amount, reason? }  void + new entry, same day
 *   { action: 'void',    productId, entryId, reason }  never deleted
 *
 * The same key the screen already needs to be read (`growth.intelligence`):
 * whoever reads the verdict sets the numbers it is judged by. No new key.
 */
export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('growth.intelligence');

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new BenchRefused('الطلب فاضي.');
    const product = await benchProduct(companyId, body.productId);
    const today = localDay(new Date(), product.timezone);
    const at = new Date().toISOString();

    if (body.action === 'rules') {
      const before = (await readBenchBook(companyId)).rulesOf(product.id);
      const saved = await saveBenchRules(companyId, product.id, body.rules === null ? null : body.rules ?? {});
      await logAudit({
        companyId,
        userId: user.id,
        action: 'BENCH_RULES_UPDATED',
        entity: 'Product',
        entityId: product.id,
        previousData: { ...before.rules },
        newData: saved ? { ...saved } : { reset: true },
      });
      return NextResponse.json({ ok: true });
    }

    const base = { byId: user.id, at, today, minorUnit: product.minorUnit };
    let change: Parameters<typeof changeBenchSpend>[2];
    if (body.action === 'spend') {
      change = (list) => addSpend(list, { ...base, id: crypto.randomUUID(), day: body.day, amount: body.amount });
    } else if (body.action === 'correct') {
      change = (list) =>
        correctSpend(list, { ...base, entryId: String(body.entryId ?? ''), newId: crypto.randomUUID(), amount: body.amount, reason: body.reason });
    } else if (body.action === 'void') {
      change = (list) => voidSpend(list, { entryId: String(body.entryId ?? ''), reason: body.reason, byId: user.id, at });
    } else {
      throw new BenchRefused('طلب مش معروف.');
    }

    await changeBenchSpend(companyId, product.id, change);
    await logAudit({
      companyId,
      userId: user.id,
      action: `BENCH_SPEND_${String(body.action).toUpperCase()}`,
      entity: 'Product',
      entityId: product.id,
      newData: { day: body.day ?? null, amount: body.amount ?? null, entryId: body.entryId ?? null, reason: body.reason ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof BenchRefused) {
      return NextResponse.json({ error: error.message, errorAr: error.message }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
