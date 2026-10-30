import type { Prisma } from '@prisma/client';
import type { db as Db } from '../db';
import { AGES, ageOf, daysWaitedOf, type Age } from '../age-piles';
import { DEAD_CONFIRMATION, TRACKING_ACK_ACTION, trackingAlert, type TrackingAlert } from './alert';
import { MATCHES, byUrgency, expectsBarcode, matchesChip, notLate, type ChipKey, type ConditionKey, type TrackingFacts } from './priority';
import { NOBODY, TASKS } from './filters';
import { transitOf } from '../transit';

/**
 * THE PARCELS UNDER FOLLOW-UP — ALL OF THEM, READ ONCE, AND EVERY NUMBER COUNTED OVER THE SAME ROWS.
 *
 * «متابعة الشحن — صفحات + فلاتر + بحث». The screen held the two hundred oldest parcels and counted its seven chips and
 * its «late» badge over those, sorted them in the browser and drew them all. A chip said what two hundred rows said,
 * not what the shop held, and there was no second page.
 *
 * What the chips need is not in one column — `late` is a threshold per (courier, governorate) against the shipping
 * date; an alert is a cancellation log, an applied change and an acknowledgement — so the work cannot be done by a
 * `where` without a raw query. It is done here instead, over a LEAN read of every parcel the question matches (a dozen
 * small columns each), with the SAME pure functions the rows are drawn from (`transitStatus`, `trackingAlert`,
 * `MATCHES`, `byUrgency`). The rich read — the lines, the settlement figures — is made only for the page that is
 * returned (`ids`), by the door.
 *
 * ── ONE READ, EVERY NUMBER IN AGREEMENT ──
 *
 *   L0  what the question (scope + state + search) brought back
 *   L1  L0 narrowed by the company, the governorate and the age  — the list the chips and the «late» badge describe
 *   L2  L1 narrowed by the chip, sorted worst-first               — the pages
 *
 * The dropdowns' numbers are counted over L0 (a company's number is how many parcels it holds under this state and
 * search, not how many survive the other dropdowns); the chips' over L1; the page is cut from L2.
 *
 * ── NO SILENT CAP ──
 *
 * The read is bounded (`LEAN_CAP`) so one request can never ask the database for everything it has ever shipped; when
 * the bound is reached `capped` says so and the screen tells the person, instead of drawing a list that looks whole.
 */

type Client = Pick<
  typeof Db,
  'order' | 'orderStatusLog' | 'orderChangeRequest' | 'orderActivity' | 'deliveryFee' | 'deliveryProvider' | 'region'
>;
type Where = Prisma.OrderWhereInput;

/** More parcels than any shop has under follow-up at once — and a bound, so that a request is always finite. */
export const LEAN_CAP = 20_000;

/** The oldest shipment first — the one waiting longest is the work — nulls last, and the id ends the order so a page never repeats a row. */
export const TRACKING_ORDER_BY: Prisma.OrderOrderByWithRelationInput[] = [
  { shippedAt: { sort: 'asc', nulls: 'last' } },
  { createdAt: 'desc' },
  { id: 'asc' },
];

/** What the chips, the lateness and the alerts need of a parcel — and nothing else. */
export const LEAN_SELECT = {
  id: true,
  shippingStatus: true,
  settlementStatus: true,
  trackingNumber: true,
  shippedAt: true,
  // The journey's end: either date stops the clock, and a parcel that ended is neither late nor unbarcoded nor an alert.
  deliveredAt: true,
  returnedAt: true,
  deliveryProviderId: true,
  regionId: true,
  // An alert is about the ORDER: it may be dead while its parcel still moves.
  confirmationStatus: true,
  updatedAt: true,
} as const;

export interface LeanParcel {
  id: string;
  shippingStatus: string;
  settlementStatus: string;
  trackingNumber: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  deliveryProviderId: string | null;
  regionId: string | null;
  confirmationStatus: string;
  updatedAt: Date;
}

/** A parcel with what the chips read of it. */
export interface Judged extends TrackingFacts {
  id: string;
  parcel: LeanParcel;
  alert: { kind: TrackingAlert['kind']; acknowledged: boolean } | null;
}

export interface TrackingListFacts {
  /** «الكل N» — the list the chips describe (L1). */
  total: number;
  /** Each chip's parcels, counted over L1; a chip nobody is in is a zero. */
  tasks: Record<ConditionKey, number>;
  /** Of L1: how many are past their region's threshold — the badge. */
  lateCount: number;
  /** Of L1: how many are on the road and inside their time — the «غير متأخرة» chip. */
  notLate: number;
  /** Over L0, biggest first; «none» is a parcel with no company on it. */
  couriers: { id: string; name: string; count: number }[];
  /** Over L0, biggest first; «none» is a parcel with no governorate. */
  regions: { id: string; name: string; count: number }[];
  /** Over L0: whole days since it shipped, in the four piles; a parcel with no shipping date is in none. */
  ages: Record<Age, number>;
}

export interface TrackingList {
  /** The page's parcels, worst first — in the order the door must hand them back. */
  ids: string[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  facts: TrackingListFacts;
  /** True when L0 hit `LEAN_CAP`: the list is the first `LEAN_CAP` parcels, and says so. */
  capped: boolean;
}

export const NO_COURIER_AR = 'بلا شركة شحن';
export const NO_REGION_AR = 'بلا محافظة';

const countBy = <K extends string | null>(rows: readonly { key: K }[]) => {
  const m = new Map<K, number>();
  for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + 1);
  return m;
};

export async function readTrackingList(
  db: Client,
  input: {
    /** Scope + the state + the search, built by the door: the one question the database is asked. */
    where: Where;
    now: Date;
    task: ChipKey | null;
    courier: string | null;
    region: string | null;
    age: Age | null;
    page: number;
    limit: number;
  }
): Promise<TrackingList> {
  const read = (await db.order.findMany({
    where: input.where,
    orderBy: TRACKING_ORDER_BY,
    take: LEAN_CAP + 1,
    select: LEAN_SELECT,
  })) as unknown as LeanParcel[];
  const capped = read.length > LEAN_CAP;
  const l0 = capped ? read.slice(0, LEAN_CAP) : read;

  // ── the companies: their names for the dropdown, and whether each owes us a barcode (an API company does; a manual one never gave one) ──
  const providerIds = [...new Set(l0.map((o) => o.deliveryProviderId).filter((v): v is string => !!v))];
  const providers = providerIds.length
    ? await db.deliveryProvider.findMany({ where: { id: { in: providerIds } }, select: { id: true, name: true, apiEnabled: true, adapterCode: true } })
    : [];
  const providerOf = new Map(providers.map((p) => [p.id, p]));

  // ── the lateness: one lookup per (courier, governorate) pair, as the door has always done it ──
  const pairs = [...new Set(l0.filter((o) => o.deliveryProviderId && o.regionId).map((o) => `${o.deliveryProviderId}|${o.regionId}`))];
  const fees = pairs.length
    ? await db.deliveryFee.findMany({
        where: {
          OR: pairs.map((p) => {
            const [deliveryProviderId, regionId] = p.split('|');
            return { deliveryProviderId, regionId };
          }),
        },
        select: { deliveryProviderId: true, regionId: true, lateThresholdDays: true },
      })
    : [];
  const thresholdOf = new Map(fees.map((f) => [`${f.deliveryProviderId}|${f.regionId}`, f.lateThresholdDays]));

  // ── the alerts: a cancellation, an applied change, an acknowledgement — read for the parcels that can carry one ──
  const dead = l0.filter((o) => DEAD_CONFIRMATION.includes(o.confirmationStatus)).map((o) => o.id);
  const [cancelLogs, applied] = l0.length
    ? await Promise.all([
        dead.length
          ? db.orderStatusLog.findMany({
              where: { orderId: { in: dead }, statusType: 'CONFIRMATION', newValue: { in: [...DEAD_CONFIRMATION] } },
              orderBy: { createdAt: 'desc' },
              select: { orderId: true, createdAt: true },
            })
          : [],
        db.orderChangeRequest.findMany({
          where: { orderId: { in: l0.map((o) => o.id) }, appliedAt: { not: null } },
          orderBy: { appliedAt: 'desc' },
          select: { orderId: true, appliedAt: true },
        }),
      ])
    : [[], []];

  // Newest first above, so the first seen per order is the latest.
  const newest = <T extends { orderId: string }>(rows: T[], pick: (r: T) => Date | null) => {
    const m = new Map<string, Date>();
    for (const r of rows) if (!m.has(r.orderId)) { const d = pick(r); if (d) m.set(r.orderId, d); }
    return m;
  };
  const cancelledAt = newest(cancelLogs, (r) => r.createdAt);
  const changedAt = newest(applied, (r) => r.appliedAt);

  // An acknowledgement matters only to a parcel that has something to acknowledge.
  const candidates = l0.filter((o) => DEAD_CONFIRMATION.includes(o.confirmationStatus) || changedAt.has(o.id)).map((o) => o.id);
  const acks = candidates.length
    ? await db.orderActivity.findMany({
        where: { orderId: { in: candidates }, action: TRACKING_ACK_ACTION },
        orderBy: { createdAt: 'desc' },
        select: { orderId: true, createdAt: true },
      })
    : [];
  const ackedAt = newest(acks, (r) => r.createdAt);

  const judged: Judged[] = l0.map((o) => {
    const threshold = thresholdOf.get(`${o.deliveryProviderId}|${o.regionId}`) ?? null;
    // The same answer the page's rows are drawn from: the clock stops at the delivery or the return.
    const transit = transitOf(o, threshold ?? 0, input.now);
    const alert = trackingAlert({
      inFlight: transit.inFlight,
      confirmationStatus: o.confirmationStatus,
      // A cancelled order with no surviving status log still announces itself — its own last write is the honest approximation.
      cancelledAt: cancelledAt.get(o.id) ?? o.updatedAt,
      changeAppliedAt: changedAt.get(o.id) ?? null,
      acknowledgedAt: ackedAt.get(o.id) ?? null,
    });
    return {
      id: o.id,
      parcel: o,
      shippingStatus: o.shippingStatus,
      settlementStatus: o.settlementStatus,
      trackingNumber: o.trackingNumber,
      daysInTransit: transit.days,
      late: transit.late,
      deliveredAt: o.deliveredAt,
      returnedAt: o.returnedAt,
      barcodeExpected: expectsBarcode(o.deliveryProviderId ? providerOf.get(o.deliveryProviderId) : null),
      alert: alert && { kind: alert.kind, acknowledged: alert.acknowledged },
    };
  });

  // ── the dropdowns' numbers: over L0 ──
  const courierCounts = countBy(judged.map((j) => ({ key: j.parcel.deliveryProviderId })));
  const regionCounts = countBy(judged.map((j) => ({ key: j.parcel.regionId })));
  const ageOfParcel = (j: Judged) => ageOf(daysWaitedOf(j.parcel.shippedAt, input.now));
  const ages = Object.fromEntries(AGES.map((a) => [a, judged.filter((j) => ageOfParcel(j) === a).length])) as Record<Age, number>;

  const names = async <T extends { id: string; name: string }>(ids: string[], lookup: (ids: string[]) => Promise<T[]>) =>
    new Map((ids.length ? await lookup(ids) : []).map((r) => [r.id, r.name]));
  const courierNames = new Map(providers.map((p) => [p.id, p.name]));
  const regionNames = await names([...regionCounts.keys()].filter((k): k is string => !!k), (ids) =>
    db.region.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
  );
  const ranked = (m: Map<string | null, number>, label: (id: string) => string, none: string) =>
    [...m]
      .map(([id, count]) => ({ id: id ?? NOBODY, name: id ? label(id) : none, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar'));

  // ── L1: what the dropdowns narrow ──
  const l1 = judged.filter(
    (j) =>
      (input.courier === null || (input.courier === NOBODY ? j.parcel.deliveryProviderId === null : j.parcel.deliveryProviderId === input.courier)) &&
      (input.region === null || (input.region === NOBODY ? j.parcel.regionId === null : j.parcel.regionId === input.region)) &&
      (input.age === null || ageOfParcel(j) === input.age)
  );

  // ── the chips and the badge: over L1 ──
  const tasks = Object.fromEntries(TASKS.map((k) => [k, l1.filter(MATCHES[k]).length])) as Record<ConditionKey, number>;

  // ── L2: the chip, then worst first — `Array.sort` is stable, so equal urgency keeps the database's order, oldest first ──
  const l2 = (input.task === null ? l1 : l1.filter(matchesChip(input.task))).slice().sort(byUrgency);

  const totalPages = Math.max(1, Math.ceil(l2.length / input.limit));
  const page = Math.min(Math.max(input.page, 1), totalPages);

  return {
    ids: l2.slice((page - 1) * input.limit, page * input.limit).map((j) => j.id),
    total: l2.length,
    page,
    limit: input.limit,
    totalPages,
    facts: {
      total: l1.length,
      tasks,
      lateCount: l1.filter((j) => j.late).length,
      notLate: l1.filter(notLate).length,
      couriers: ranked(courierCounts, (id) => courierNames.get(id) ?? '—', NO_COURIER_AR),
      regions: ranked(regionCounts, (id) => regionNames.get(id) ?? '—', NO_REGION_AR),
      ages,
    },
    capped,
  };
}
