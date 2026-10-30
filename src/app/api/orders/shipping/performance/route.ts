import { SHIPPING_GONE, rateOf, whereDelivered } from '@/lib/order-state';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { courierRates, courierCollectionTrust, scoreCourier, whyNoCourierScore } from '@/lib/couriers/score';


/**
 * GET /api/orders/shipping/performance?providerId=
 *
 * Company-isolated provider metrics. Metric definitions (no misleading math):
 *   assigned            = orders currently/have-been bound to the provider
 *   shipped             = reached SHIPPED or later
 *   delivered           = shippingStatus DELIVERED
 *   failed              = shippingStatus FAILED_DELIVERY
 *   returned            = shippingStatus RETURNED
 *   successRate         = delivered / (delivered + failed + returned)
 *   avgDeliveryHours    = avg(deliveredAt - shippedAt) over delivered orders
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    const { searchParams } = new URL(req.url);
    const providerId = searchParams.get('providerId')?.trim();

    // Access gate: canonical permission checks (role bypass replaced by the
    // scope engine — management roles hold orders.change_status anyway)
    if (!can(user, 'reports.view') && !can(user, 'finance.view') && !can(user, 'orders.change_status')) {
      return NextResponse.json({ error: 'Forbidden', errorAr: 'هذا الإجراء ليس من صلاحياتك. راجع مدير النظام إن كان من عملك.' }, { status: 403 });
    }

    const providers = await db.deliveryProvider.findMany({
      where: { companyId, ...(providerId ? { id: providerId } : {}) },
      select: { id: true, name: true, code: true, isActive: true },
    });

    const results = await Promise.all(
      providers.map(async (p) => {
        const base = { companyId, storeId, deliveryProviderId: p.id };
        const [assigned, shipped, delivered, failed, returned, settled] = await Promise.all([
          db.order.count({ where: base }),
          db.order.count({ where: { ...base, shippingStatus: { in: [...SHIPPING_GONE] } } }),
          // A partial delivery counted in none of the three terms below, so
          // it fell out of the denominator too: every rate was computed over
          // a silently smaller population than "what this courier finished",
          // and a courier who got most of the parcel to the door scored
          // nothing for it.
          db.order.count({ where: { ...base, ...whereDelivered() } }),
          db.order.count({ where: { ...base, shippingStatus: 'FAILED_DELIVERY' } }),
          db.order.count({ where: { ...base, shippingStatus: { in: ['RETURN_REQUESTED', 'RETURNED'] } } }),
          /*
           * AND WHETHER THE MONEY CAME BACK, which is the band the old
           * shape had no number for at all. Out of what LANDED, counted
           * here rather than derived in a browser: it is money.
           */
          db.order.count({ where: { ...base, ...whereDelivered(), settlementStatus: 'SETTLED' } }),
        ]);

        const decided = delivered + failed + returned;
        const successRate = rateOf(delivered, decided);
        const failureRate = rateOf(failed, decided);
        const returnRate = rateOf(returned, decided);

        // avg delivery time over recent delivered orders (bounded sample)
        const sample = await db.order.findMany({
          where: { ...base, ...whereDelivered(), shippedAt: { not: null }, deliveredAt: { not: null } },
          select: { shippedAt: true, deliveredAt: true },
          orderBy: { deliveredAt: 'desc' },
          take: 300,
        });
        const avgDeliveryHours =
          sample.length > 0
            ? Number(
                (
                  sample.reduce(
                    (acc, o) => acc + (new Date(o.deliveredAt!).getTime() - new Date(o.shippedAt!).getTime()),
                    0
                  ) / sample.length / (60 * 60 * 1000)
                ).toFixed(1)
              )
            : null;

        /*
         * NO SCORE YET — ON PURPOSE.
         *
         * The speed band reads each courier against the FASTEST in the
         * same shop, and that reference does not exist inside a
         * per-courier fan-out. Scoring here and again below would be the
         * same arithmetic run twice with the first answer thrown away, so
         * this stage returns the counts and the scoring happens once,
         * after, where the reference is known.
         */
        return {
          provider: p,
          metrics: { assigned, shipped, delivered, failed, returned, settled, successRate, failureRate, returnRate, avgDeliveryHours },
        };
      })
    );

    /*
     * SPEED, RE-SCORED ONCE EVERY COURIER IS KNOWN.
     *
     * «Fast» has no absolute meaning — two days to a village is excellent
     * and two days across one city is not — so the band reads each courier
     * against the FASTEST in the same shop. That reference cannot exist
     * inside the per-courier fan-out above, so the fan-out returns counts
     * only and the scoring happens here, once, with ONE scoring function.
     *
     * `metrics.delivered` is `whereDelivered()` — partial deliveries
     * included — so it IS `landed`. Said here because the field is named
     * `delivered` and the band is not.
     *
     * MEASURED: every delivery on this database has a gap of zero or one
     * second between shipping and delivery, so `fastest` is 0 here, the
     * band answers null for every courier, and the row reads «out of 90»
     * with the missing ten points named. It starts scoring by itself the
     * day a real duration lands.
     */
    /*
     * WHETHER «COLLECTED» MAY BE SCORED AT ALL — asked BEFORE anything is
     * scored, because the answer decides whether a band exists.
     *
     * A fact about the settlement process, not about any one carrier: if
     * nobody in this shop has ever settled a statement, then no courier's
     * collection rate means anything, and three couriers each scoring zero
     * would rank them by a tie and call it a finding. The gate is the same
     * `trustOf` the channel engine uses for the identical band.
     */
    const landedAll = results.reduce((n, r) => n + r.metrics.delivered, 0);
    const settledAll = results.reduce((n, r) => n + r.metrics.settled, 0);
    const collection = courierCollectionTrust(settledAll, landedAll);
    const scoreCollection = collection.level !== 'WITHHELD';

    const hours = results
      .map((r) => r.metrics.avgDeliveryHours)
      .filter((h): h is number => typeof h === 'number' && h > 0);
    const fastest = hours.length > 0 ? Math.min(...hours) : null;
    const scored = results.map((r) => {
      const rates = courierRates({
        landed: r.metrics.delivered,
        failed: r.metrics.failed,
        returned: r.metrics.returned,
        settled: r.metrics.settled,
      });
      const score = scoreCourier(
        {
          ...rates.input,
          // Withheld for the whole shop, or not scored at all. Leaving the
          // rate in while the screen says it is out of the score is two
          // answers to one question — and the screen's sentence («يُحسب كل
          // سكور من 80 لا من 100») would be a figure the engine disagrees
          // with on the same row.
          collection_rate: scoreCollection ? rates.input.collection_rate : { value: null },
          speed: { value: r.metrics.avgDeliveryHours, reference: fastest },
        },
        { sample: rates.decided }
      );
      return { ...r, score, whyNoScore: whyNoCourierScore(score) };
    });

    return NextResponse.json({ providers: scored, collection });
  } catch (error: any) {
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 400 });
  }
}
