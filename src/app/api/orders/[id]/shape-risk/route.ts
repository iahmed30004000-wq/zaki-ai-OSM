import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { apiErrorResponse } from '@/lib/api-error';
import { DELIVERED_SHIPPING, RETURNED_SHIPPING } from '@/lib/order-state';
import {
  shapeRisk,
  MIN_LEVER_SHIPMENTS,
  type SegmentOutcome,
  type ShapeInput,
} from '@/lib/order-shape-risk';

/**
 * GET /api/orders/:id/shape-risk — why this shape of order comes back.
 *
 * ── WHY THERE IS A ROUTE AT ALL ──
 *
 * The courier's statements say 29.8% of what this shop ships comes back
 * (1353 of 4543 parcels, 23/08→26/09/2026). The order screens never said
 * it, so the one moment it is still cheap to change — an agent on the phone,
 * before a waybill exists — passed in silence. This answers, for the order
 * in front of her: which parts of it come back more often than the rest of
 * the shop, and which of those parts she can still change.
 *
 * ── ONE COUNT, NOT ONE PER DIMENSION ──
 *
 * Two `groupBy` calls over `[productId, quantity, regionId]` — one for every
 * concluded parcel, one for the ones that came back — and the dimensions are
 * summed out of that in memory. Six separate grouped queries would count the
 * same orders six times and could disagree with each other between them.
 *
 * `shipments` is DELIVERED ∪ RETURNED, which is what a courier statement
 * counts: a parcel still out with him has no outcome yet, and putting it in
 * the denominator makes every rate look better than it is while the week is
 * young.
 *
 * ── AND THE BIGGEST LEVER IN THE DATA IS NOT HERE ──
 *
 * Cash comes back 31.2% of the time (4338 parcels) and شام كاش came back 0
 * times out of 195. **The order has no column for how it will be paid**, so
 * the system cannot tell those apart, cannot measure it, and cannot offer
 * it. That is reported as a missing capability with its measured prize
 * attached, rather than guessed at — see `paymentUnmeasured` below.
 */

type Row = { productId: string | null; quantity: number | null; regionId: string | null; _count: { _all: number } };

const add = (m: Map<string, SegmentOutcome>, key: string, n: number) => {
  const cur = m.get(key) ?? { shipments: 0, returned: 0 };
  cur.shipments += n;
  m.set(key, cur);
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    // The order through the same envelope the window opened it with: an agent
    // asked about orders outside her own by id, and got this card for any of them.
    // The window opens through the work door now, so this card does too.
    const access = await assertOrderReadable(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: ORDER_NOT_FOUND, errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }

    const order = await db.order.findFirst({
      where: { id, companyId, ...(storeId ? { storeId } : {}) },
      select: {
        id: true,
        orderNumber: true,
        productId: true,
        quantity: true,
        regionId: true,
        region: { select: { name: true } },
        productNameSnapshot: true,
        product: { select: { name: true } },
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });

    const base = { companyId, ...(storeId ? { storeId } : {}) };
    const by = ['productId', 'quantity', 'regionId'] as const;
    const [concluded, returned] = await Promise.all([
      db.order.groupBy({
        by: [...by],
        where: { ...base, shippingStatus: { in: [...DELIVERED_SHIPPING, ...RETURNED_SHIPPING] } },
        _count: { _all: true },
      }) as unknown as Promise<Row[]>,
      db.order.groupBy({
        by: [...by],
        where: { ...base, shippingStatus: { in: [...RETURNED_SHIPPING] } },
        _count: { _all: true },
      }) as unknown as Promise<Row[]>,
    ]);

    const products = new Map<string, SegmentOutcome>();
    const units = new Map<string, SegmentOutcome>();
    const regions = new Map<string, SegmentOutcome>();
    const shop: SegmentOutcome = { shipments: 0, returned: 0 };

    for (const r of concluded) {
      const n = r._count._all;
      shop.shipments += n;
      if (r.productId) add(products, r.productId, n);
      if (r.quantity !== null) add(units, String(r.quantity), n);
      if (r.regionId) add(regions, r.regionId, n);
    }
    // The returned rows are a SUBSET of the concluded ones, so their counts
    // go to `returned` only — never to `shipments`, which would count every
    // returned parcel twice and halve every rate in the answer.
    for (const r of returned) {
      const n = r._count._all;
      shop.returned += n;
      if (r.productId) {
        const cur = products.get(r.productId);
        if (cur) cur.returned += n;
      }
      if (r.quantity !== null) {
        const cur = units.get(String(r.quantity));
        if (cur) cur.returned += n;
      }
      if (r.regionId) {
        const cur = regions.get(r.regionId);
        if (cur) cur.returned += n;
      }
    }

    const unitLabel = (q: string) => (q === '1' ? 'قطعة واحدة' : q === '2' ? 'قطعتان' : `${q} قطع`);
    const shape: ShapeInput = {};

    if (order.productId && products.has(order.productId)) {
      shape.product = {
        label: order.product?.name ?? order.productNameSnapshot ?? 'هذا المنتج',
        outcome: products.get(order.productId)!,
      };
    }
    if (order.quantity !== null && units.has(String(order.quantity))) {
      const mine = String(order.quantity);
      shape.units = {
        label: unitLabel(mine),
        outcome: units.get(mine)!,
        // Every other quantity the shop has actually shipped enough of to
        // advise from. Sorted so the biggest bundle is offered first when
        // two are equally good.
        alternatives: [...units.entries()]
          .filter(([q, o]) => q !== mine && o.shipments >= MIN_LEVER_SHIPMENTS)
          .sort((a, b) => Number(b[0]) - Number(a[0]))
          .map(([q, outcome]) => ({ label: unitLabel(q), outcome })),
      };
    }
    if (order.regionId && regions.has(order.regionId)) {
      shape.region = {
        label: order.region?.name ?? 'هذه المحافظة',
        outcome: regions.get(order.regionId)!,
      };
    }

    const risk = shapeRisk(shape, shop);

    return NextResponse.json({
      orderNumber: order.orderNumber,
      ...risk,
      /**
       * THE LEVER THE SYSTEM CANNOT PULL YET, with what it is worth.
       *
       * Stated as a capability gap rather than left out, because leaving it
       * out is how the biggest number in the courier's file stays invisible
       * for another month.
       */
      paymentUnmeasured: {
        why: 'الطلب لا يسجّل طريقة الدفع، فلا يمكن قياسها ولا عرضها كخيار',
        measuredElsewhere: 'في كشوف الشحن: كاش يرجع 31.2% من 4338 شحنة، وشام كاش لم يرجع منه ولا واحد من 195',
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
