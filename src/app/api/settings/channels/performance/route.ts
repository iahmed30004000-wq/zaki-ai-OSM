import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { getDateRange } from '@/lib/analytics';
import { channelPerformance } from '@/lib/attribution-performance';
import { DELIVERED_SHIPPING, whereDelivered } from '@/lib/order-state';
import { DOOR_FAILED_SHIPPING, DOOR_RETURNED_SHIPPING, doorOutcome } from '@/lib/cod-vitals';
import {
  collectionTrust,
  MIN_CONFIRMED,
  scoreChannel,
  unattributedShare,
  whyNoScore,
  type ChannelScore,
} from '@/lib/channel-score';

/**
 * GET /api/settings/channels/performance — which door brings money that lands.
 *
 * A SEPARATE ROUTE FROM THE CHANNEL LIST, and that is the whole reason it
 * exists. `GET /api/settings/channels` is read by every order-intake form to
 * fill a dropdown, and it is deliberately open to anyone who may create an
 * order. Hanging eight aggregates off it would make every order form wait for
 * a report, and would hand performance figures to a data-entry clerk who is
 * only allowed to see a list of names. So the names stay there, fast and
 * open, and the numbers live here behind `reports.view`.
 *
 * NOTHING HERE COUNTS ORDERS THAT `channelPerformance` ALREADY COUNTS. That
 * function is the shared attribution engine — the same one the performance
 * screen's moderator and channel tables read — and it already returns
 * brought, confirmed, decided, delivered, returned, the two rates and the
 * revenue, computed with the same revenue definition as the profit screen. A
 * second aggregation here would be a second definition of «delivered», and
 * two screens would start disagreeing about one week.
 *
 * What is added is only what it does not carry:
 *
 *   FAILED deliveries per channel, so a return rate can be taken out of what
 *   the door actually FINISHED with. `doorOutcome` owns that denominator — the
 *   same function the dashboard's company-wide return rate uses — so a
 *   channel's 21% and the shop's 22% are the same arithmetic on different
 *   rows and can never drift apart.
 *
 *   COLLECTED per channel, and shop-wide, so the score can say out loud that
 *   this band is unmeasurable rather than scoring every door zero.
 *
 *   THE ORDERS WITH NO CHANNEL, because every share on the screen is a share
 *   of a total, and a total that silently omits a bucket makes every other
 *   row look bigger than it is.
 */

/** Cash in hand. The two spellings the settlement model uses for it. */
const COLLECTED_SETTLEMENT = ['SETTLED', 'COLLECTED'] as const;

export interface ChannelPerformanceRow {
  id: string;
  name: string;
  kind: string | null;
  isActive: boolean;
  brought: number;
  confirmed: number;
  decided: number;
  delivered: number;
  returned: number;
  failed: number;
  /** Parcels the door has finished with — the return rate's denominator. */
  doorDecided: number;
  collected: number;
  confirmationRate: number | null;
  deliveryRate: number | null;
  returnRate: number | null;
  revenue: number;
  /** What one DELIVERED order from this door is worth. */
  deliveredValue: number | null;
  score: ChannelScore;
  whyNoScore: string | null;
}

export async function GET() {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('reports.view');

    // The same bounded window every report in this system uses for «الكل»:
    // ninety days, clamped server-side. The screen has no date picker, and
    // inventing an unbounded scan for it would be the one query that grows
    // without limit as the shop trades.
    const { start, end } = getDateRange({ period: 'all' });
    const when = start && end ? { gte: start, lte: end } : undefined;
    const base = { companyId, storeId, ...(when ? { createdAt: when } : {}) };

    const [rows, channels, failedBy, collectedBy, shopDelivered, shopCollected, total, withoutChannel] =
      await Promise.all([
        channelPerformance({ companyId, storeId, start, end }),
        db.orderChannel.findMany({
          where: { companyId },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, kind: true, isActive: true },
        }),
        db.order.groupBy({
          by: ['channelId'],
          where: { ...base, channelId: { not: null }, shippingStatus: { in: [...DOOR_FAILED_SHIPPING] } },
          _count: { _all: true },
        }),
        db.order.groupBy({
          by: ['channelId'],
          where: {
            ...base,
            channelId: { not: null },
            ...whereDelivered(),
            settlementStatus: { in: [...COLLECTED_SETTLEMENT] },
          },
          _count: { _all: true },
        }),
        db.order.count({ where: { ...base, ...whereDelivered() } }),
        db.order.count({
          where: { ...base, ...whereDelivered(), settlementStatus: { in: [...COLLECTED_SETTLEMENT] } },
        }),
        db.order.count({ where: base }),
        db.order.count({ where: { ...base, channelId: null } }),
      ]);

    const failedOf = new Map(failedBy.map((g) => [g.channelId as string, g._count._all]));
    const collectedOf = new Map(collectedBy.map((g) => [g.channelId as string, g._count._all]));
    const attributed = new Map(rows.map((r) => [r.id, r]));

    /**
     * Whether «collected» may be scored, asked ONCE for the shop.
     *
     * Measured: 0 of 119 delivered orders have ever been settled — every one
     * is still PENDING_COLLECTION. Asked per channel it would return zero
     * four times, the band would score zero four times, and the screen would
     * rank four doors by a tie and present it as a finding.
     */
    const collection = collectionTrust(shopCollected, shopDelivered);
    const scoreCollection = collection.level !== 'WITHHELD';

    // The best delivered basket in the shop, which the value band is read
    // against. Computed before any row is scored, because a reference that
    // changed while the rows were being scored would grade the first door
    // against a different shop from the last.
    const basketOf = (id: string): number | null => {
      const r = attributed.get(id);
      if (!r || r.delivered <= 0) return null;
      return Number((r.revenue / r.delivered).toFixed(2));
    };
    /**
     * AND THE CEILING IS SET BY A DOOR THAT CLEARS THE FLOOR.
     *
     * It was the maximum over EVERY channel, with no sample behind it — so
     * one delivered order at an unusual price became the bar every other
     * door was measured against, and the doors doing the real work scored a
     * fraction of what they had earned. Measured in this shop's own data
     * when the same fault was found on the products screen: the best single
     * delivered order was 50.01 and belonged to a product with two of them;
     * letting it set the reference scored the three real products 8, 9 and 9
     * out of 20 instead of 17, 20 and 20.
     *
     * A reference is a claim about what this shop can do. One order is not
     * that claim, and `MIN_CONFIRMED` is the bar the rest of this file
     * already scores against — so the ceiling now comes from the doors whose
     * rates are allowed to speak at all. If not one of them clears it, there
     * is no reference and the band withholds itself rather than inventing a
     * bar out of the loudest accident.
     */
    const eligibleBaskets = channels
      .filter((c) => (attributed.get(c.id)?.confirmed ?? 0) >= MIN_CONFIRMED)
      .map((c) => basketOf(c.id))
      // `basketOf` already answers null for a door that delivered nothing,
      // and a zero among positives cannot move a maximum — so there is no
      // `> 0` here. A condition that can never change the answer is a claim
      // no test can check.
      .filter((b): b is number => b !== null);
    const bestBasket = eligibleBaskets.length ? Math.max(...eligibleBaskets) : 0;

    const performance: ChannelPerformanceRow[] = channels.map((c) => {
      const r = attributed.get(c.id);
      const delivered = r?.delivered ?? 0;
      const returned = r?.returned ?? 0;
      const failed = failedOf.get(c.id) ?? 0;
      const door = doorOutcome({ delivered, failed, returned });
      const collected = collectedOf.get(c.id) ?? 0;
      const deliveredValue = basketOf(c.id);

      const score = scoreChannel(
        {
          delivery_rate: { value: r?.deliveryRate ?? null },
          return_rate: { value: door.returnRate },
          confirmation_rate: { value: r?.confirmationRate ?? null },
          // Handed null — not zero — when the shop has never collected
          // anything, so the band drops out of the total instead of
          // dragging every door down by the same fifteen points.
          collection_rate: { value: scoreCollection && delivered > 0 ? (collected / delivered) * 100 : null },
          delivered_value: { value: deliveredValue, reference: bestBasket },
        },
        // The denominator of the heaviest band, exactly as the people score
        // does it: a delivery rate is 35 of the 100, and gating on anything
        // looser would let the biggest band be noise.
        { sample: r?.confirmed ?? 0 }
      );

      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        isActive: c.isActive,
        brought: r?.brought ?? 0,
        confirmed: r?.confirmed ?? 0,
        decided: r?.decided ?? 0,
        delivered,
        returned,
        failed,
        doorDecided: door.decided,
        collected,
        confirmationRate: r?.confirmationRate ?? null,
        deliveryRate: r?.deliveryRate ?? null,
        returnRate: door.returnRate,
        revenue: r?.revenue ?? 0,
        deliveredValue,
        score,
        whyNoScore: whyNoScore(score),
      };
    });

    /**
     * RANKED BY THE SCORE, AND BY WHAT LANDED WHERE THERE IS NO SCORE.
     *
     * The old screen sorted by `sortOrder, name` and printed the order count
     * — so it said الشيت is 87% of the business and never mentioned that 30
     * of its parcels came back. An ungraded door sits BELOW every graded one
     * rather than at the bottom of the same list: it was not measured, which
     * is not the same as being worst, and among themselves those doors are
     * ordered by the money that actually landed.
     */
    performance.sort((a, b) => {
      if (a.score.total === null && b.score.total === null) return b.revenue - a.revenue || b.brought - a.brought;
      if (a.score.total === null) return 1;
      if (b.score.total === null) return -1;
      return b.score.total - a.score.total || b.revenue - a.revenue;
    });

    return NextResponse.json({
      channels: performance,
      shop: {
        orders: total,
        delivered: shopDelivered,
        collected: shopCollected,
        withoutChannel,
        withoutChannelShare: unattributedShare(withoutChannel, total),
        // The verdict travels with the figures it governs, so the screen
        // never has to remember which band was refused or why.
        collection,
      },
      window: { from: start?.toISOString() ?? null, to: end?.toISOString() ?? null },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
