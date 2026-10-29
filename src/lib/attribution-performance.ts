import { CONFIRMATION_REFUSED, DELIVERED_SHIPPING, rateOf } from './order-state';
import { db } from './db';
import { notSuperseded } from './superseded';

/**
 * WHO BROUGHT THE BUSINESS, AND WHAT BECAME OF IT.
 *
 * Two questions with one shape. A moderator brings orders in; a channel is
 * the door they came through. Both are judged the same way, so they share
 * one query and one table rather than growing two reports that slowly stop
 * agreeing about what "delivered" means.
 *
 * The number that matters is the LAST one, not the first. Anyone can bring
 * a hundred orders; what the business keeps is what was delivered and
 * collected. So a row reads left to right as the funnel actually runs —
 * brought, confirmed, delivered, collected — and the rates are computed
 * from the step before, never from the top:
 *
 *   confirmation rate = confirmed ÷ decided   (still being worked is neither)
 *   delivery rate     = delivered ÷ confirmed (an order never confirmed
 *                       was never the courier's to deliver)
 *
 * Revenue is the SAME definition the profit screen uses: what was actually
 * collected where we know it, and the order total where we do not. A second
 * formula here is how two screens end up disagreeing about one week.
 */

// The three definitions live in order-state.ts, beside the state machine —
// this file held the correct copy of each, which is exactly why they had to
// stop being copies.
const DELIVERED = [...DELIVERED_SHIPPING];
const CONFIRMED_ONWARDS = ['CONFIRMED'];
const REFUSED = [...CONFIRMATION_REFUSED];

export interface AttributionRow {
  id: string;
  name: string;
  /** Extra label — a moderator's role, a channel's kind. */
  kind: string | null;
  brought: number;
  confirmed: number;
  rejected: number;
  decided: number;
  delivered: number;
  returned: number;
  confirmationRate: number | null;
  deliveryRate: number | null;
  revenue: number;
  /** What one brought order is worth on average, after everything. */
  revenuePerOrder: number | null;
}

/**
 * The totals line of an attribution table.
 *
 * Its rates are NOT the average of the rows' rates, and they are not the
 * UI's to work out: the screen recomputed both denominators from the row
 * list, so a change to what "decided" means here would leave the total
 * saying something its own rows no longer said. Frontend code computing a
 * displayed rate is also what the contract forbids.
 */
export function attributionTotals(rows: AttributionRow[]): AttributionRow {
  const sum = (pick: (r: AttributionRow) => number) => rows.reduce((t, r) => t + pick(r), 0);
  const confirmed = sum((r) => r.confirmed);
  const delivered = sum((r) => r.delivered);
  const decided = sum((r) => r.decided);
  const brought = sum((r) => r.brought);
  const revenue = Number(sum((r) => r.revenue).toFixed(2));
  return {
    id: '—',
    name: 'الإجمالي',
    kind: null,
    brought,
    confirmed,
    rejected: sum((r) => r.rejected),
    decided,
    delivered,
    returned: sum((r) => r.returned),
    confirmationRate: rateOf(confirmed, decided),
    deliveryRate: rateOf(delivered, confirmed),
    revenue,
    revenuePerOrder: brought > 0 ? Number((revenue / brought).toFixed(2)) : null,
  };
}

interface Scope {
  companyId: string;
  storeId: string;
  start?: Date;
  end?: Date;
}

type GroupKey = 'moderatorId' | 'channelId' | 'campaignId';

async function attribution(scope: Scope, key: GroupKey): Promise<AttributionRow[]> {
  const { companyId, storeId, start, end } = scope;
  const when = start || end ? { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } : undefined;
  const base = {
    companyId,
    storeId,
    [key]: { not: null },
    ...(when ? { createdAt: when } : {}),
    /*
     * ONE SALE IS ONE ORDER. A replacement now carries the campaign, the door
     * and the moderator of the order it replaced, so counting both would
     * bring the same customer twice — once as a sale and once as a return.
     * The replaced order is left out; the replacement is the sale, and fails
     * on its own account if it does. The money below reads delivered orders
     * only, and a replaced order is never one.
     */
    ...notSuperseded,
  } as Record<string, unknown>;

  const by = [key] as ['moderatorId'] | ['channelId'] | ['campaignId'];

  const [brought, confirmed, rejected, delivered, returned, collected, uncollected] = await Promise.all([
    db.order.groupBy({ by, where: base, _count: { _all: true } }),
    db.order.groupBy({ by, where: { ...base, confirmationStatus: { in: CONFIRMED_ONWARDS } }, _count: { _all: true } }),
    db.order.groupBy({ by, where: { ...base, confirmationStatus: { in: REFUSED } }, _count: { _all: true } }),
    db.order.groupBy({ by, where: { ...base, shippingStatus: { in: DELIVERED } }, _count: { _all: true } }),
    db.order.groupBy({ by, where: { ...base, shippingStatus: { in: ['RETURNED', 'RETURN_REQUESTED'] } }, _count: { _all: true } }),
    // The same two-part revenue the profit screen uses.
    db.order.groupBy({
      by,
      where: { ...base, shippingStatus: { in: DELIVERED }, collectedAmount: { not: null } },
      _sum: { collectedAmount: true },
    }),
    db.order.groupBy({
      by,
      where: { ...base, shippingStatus: { in: DELIVERED }, collectedAmount: null },
      _sum: { totalAmount: true },
    }),
  ]);

  const idOf = (row: Record<string, unknown>) => row[key] as string | null;
  const ids = [...new Set(brought.map(idOf).filter(Boolean) as string[])];
  if (ids.length === 0) return [];

  const names =
    key === 'moderatorId'
      ? new Map(
          (await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, role: true } })).map(
            (u) => [u.id, { name: u.name, kind: u.role as string | null }]
          )
        )
      : key === 'campaignId'
        ? new Map(
            (
              await db.campaign.findMany({
                // Scoped to the store as well as the company: a campaign
                // belongs to one shop, and a name resolved wider than the
                // rows it labels is a name from somebody else's screen.
                where: { id: { in: ids }, companyId, storeId },
                select: { id: true, name: true, platform: true },
              })
            ).map((c) => [c.id, { name: c.name, kind: c.platform as string | null }])
          )
        : new Map(
            (
              await db.orderChannel.findMany({
                where: { id: { in: ids }, companyId },
                select: { id: true, name: true, kind: true },
              })
            ).map((c) => [c.id, { name: c.name, kind: c.kind as string | null }])
          );

  const count = (rows: typeof brought, id: string) =>
    (rows.find((r) => idOf(r as never) === id) as { _count?: { _all: number } } | undefined)?._count?._all ?? 0;

  const rows = ids.map((id) => {
    const who = names.get(id);
    const ok = count(confirmed, id);
    const no = count(rejected, id);
    const decided = ok + no;
    const got = count(delivered, id);
    const total = count(brought, id);
    const revenue =
      Number(
        (collected.find((r) => idOf(r as never) === id) as { _sum?: { collectedAmount: number | null } } | undefined)
          ?._sum?.collectedAmount ?? 0
      ) +
      Number(
        (uncollected.find((r) => idOf(r as never) === id) as { _sum?: { totalAmount: number | null } } | undefined)
          ?._sum?.totalAmount ?? 0
      );

    return {
      id,
      name: who?.name ?? '—',
      kind: who?.kind ?? null,
      brought: total,
      confirmed: ok,
      rejected: no,
      decided,
      delivered: got,
      returned: count(returned, id),
      confirmationRate: rateOf(ok, decided),
      // Out of what was confirmed: an order never confirmed was never the
      // courier's to deliver, and counting it against delivery blames the
      // wrong step.
      deliveryRate: rateOf(got, ok),
      revenue: Number(revenue.toFixed(2)),
      revenuePerOrder: total > 0 ? Number((revenue / total).toFixed(2)) : null,
    };
  });

  // What the business kept, biggest first.
  return rows.sort((a, b) => b.revenue - a.revenue || b.brought - a.brought);
}

/**
 * Orders credited to each paid campaign.
 *
 * The same engine as the other two, on purpose. A campaign report that
 * computed its own revenue would be a third definition of the word, and
 * three definitions is how a seller ends up with three screens disagreeing
 * about one week. What a campaign adds — spend, and therefore ROAS — is not
 * here: this counts what happened, and money that left for an ad platform
 * is not something this system witnessed.
 */
export function campaignPerformance(scope: Scope): Promise<AttributionRow[]> {
  return attribution(scope, 'campaignId');
}

/** Orders credited to each moderator who entered them. */
export function moderatorPerformance(scope: Scope): Promise<AttributionRow[]> {
  return attribution(scope, 'moderatorId');
}

/** Orders credited to the door they came through. */
export function channelPerformance(scope: Scope): Promise<AttributionRow[]> {
  return attribution(scope, 'channelId');
}
