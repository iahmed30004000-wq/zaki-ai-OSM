import type { Prisma } from '@prisma/client';
import type { db as Db } from '../db';
import { AGES, ageOf, daysWaitedOf, type Age } from '../age-piles';
import { DEAD_CONFIRMATION, TRACKING_ACK_ACTION, trackingAlert, type TrackingAlert } from './alert';
import { DIFFERENCE_CHIP, MATCHES, byDifference, byUrgency, expectsBarcode, hasDifference, matchesChip, notLate, type ChipKey, type ConditionKey, type TrackingFacts } from './priority';
import { readDifferences, type DifferenceLean } from './difference';
import { NOBODY, TASKS } from './filters';
import { transitOf } from '../transit';
import { COURIER_SAID, SAID_STATUSES, type SaidStatus } from '../couriers/courier-said';
import { courierSaidAgainst, type CourierSaid, type CourierSaidRow } from '../couriers/courier-said-read';

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
 *   L1  L0 narrowed by the company, the governorate, the age and the company's word — the list the chips and the «late» badge describe
 *   L2  L1 narrowed by the chip, sorted worst-first               — the pages
 *
 * The dropdowns' numbers are counted over L0 (a company's number is how many parcels it holds under this state and
 * search, not how many survive the other dropdowns); the chips' over L1; the page is cut from L2.
 *
 * ── THE COMPANY'S WORD, READ WITH THE REST ──
 *
 * The poll keeps what the company says about a parcel as a COURIER_SAID line (`couriers/courier-said`); a parcel our own
 * state still shows on the road may have been "delivered" for days. The newest line of each parcel is read ONCE, in the
 * same grouped read as the applied changes — one query over the ids the list holds, never one per row — and judged here
 * (`couriers/courier-said-read`), so the dropdown's numbers, the filter and the chip drawn on the row are the same
 * answer. It is a FIELD of the row and a question the list can be narrowed by; it is never an input of the chips or of
 * the ranking, and it changes no state.
 *
 * Because it only decorates, it is the ONE read of the list that may fail quietly: while nobody asked for the word, a
 * failed read draws the list without words (as if the poll had never written a line) and says so once in the log; when
 * the person asked for it (`said`), the error goes through — see `readSaidLines`.
 *
 * ── THE DIFFERENCE AT MATCHING, READ WITH THE REST — ONLY FOR WHOEVER MAY SEE THE COURIER'S MONEY ──
 *
 * «واذا المطابقة رجعت في فرق حط جنبو علامة … او اعمل قائمة» (the owner, 13/11). A parcel whose newest statement line
 * disagreed with our figure carries a difference (`parcel-tracking/difference.ts` says which row, and why); it is found in
 * two grouped reads over EVERY parcel the list holds — never one per row — so the chip «فيه فرق», the filter behind it and
 * the mark on a row are one answer, counted over the same L1 as the other chips. It is asked for (`differences`) only by
 * a door whose person holds the money sight: without it nothing is read and nothing is counted. And it is read hard — a
 * failure fails the list, as every other read here does: a mark that silently vanishes reads as «no difference».
 *
 * ── THE COMPANY IS NAMED IN EVERY READ OF THE ACTIVITY TABLE ──
 *
 * `order_activities` has one index that starts with an order, and it starts with the company: `(companyId, orderId)`.
 * PostgreSQL 16 cannot skip the first column, so a read that says `orderId IN (…)` for up to `LEAN_CAP` ids and never
 * names the company cannot use it. Both reads of that table here carry `companyId` — handed in by the door, never
 * parsed out of `where`. It only tells the database what it needs: an order id belongs to one company, so no row the
 * read returned before is dropped.
 *
 * ── NO SILENT CAP ──
 *
 * The read is bounded (`LEAN_CAP`) so one request can never ask the database for everything it has ever shipped; when
 * the bound is reached `capped` says so and the screen tells the person, instead of drawing a list that looks whole.
 */

type Client = Pick<
  typeof Db,
  'order' | 'orderStatusLog' | 'orderChangeRequest' | 'orderActivity' | 'deliveryFee' | 'deliveryProvider' | 'region' | 'settlementMatch'
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
  /** What the company's newest line says when it disagrees with the parcel's own state — shown and filterable, never ranked. */
  said: CourierSaid | null;
  /** The parcel's difference at matching — which match row, whether it is answered, whether its statement is closed; null for none. */
  difference: DifferenceLean | null;
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
  /** Over L0: how many parcels the company's word puts in each of its five kinds; a parcel whose word agrees with its state, or with none, is in no kind. */
  said: Record<SaidStatus, number>;
  /**
   * Of L1: how many parcels carry a difference at matching, answered or not — the «فيه فرق» chip, and exactly the rows it
   * brings. Absent when the door did not ask for differences (a person without the money sight): there is no number to give.
   */
  difference?: number;
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
  /** The company's word for the parcels ON THIS PAGE that have one to show — the server puts it on their rows. */
  courierSaid: ReadonlyMap<string, CourierSaid>;
  /** The difference of the parcels ON THIS PAGE that carry one — which match row; the door reads those rows whole. */
  differences: ReadonlyMap<string, DifferenceLean>;
}

export const NO_COURIER_AR = 'بلا شركة شحن';
export const NO_REGION_AR = 'بلا محافظة';

const countBy = <K extends string | null>(rows: readonly { key: K }[]) => {
  const m = new Map<K, number>();
  for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + 1);
  return m;
};

/** One COURIER_SAID line, with the parcel it is about. */
type SaidLine = CourierSaidRow & { orderId: string };

/**
 * WHAT THE COMPANY SAID, FOR EVERY PARCEL THE LIST HOLDS — one grouped read, newest first (the id ends a tie).
 *
 * The word is decoration: a badge, and a question the list can be narrowed by. It is never an input of the chips, the
 * lateness or the order. So while nobody asked for it (`asked` false), a read that times out or is locked must not take
 * the whole follow-up screen down with it: it answers no words — every parcel's `said` is null, as if the poll had never
 * written a line — and says so ONCE in the log: that the read failed, why, and over how many parcels. Never the
 * question itself: its `where` holds what the person typed in the search box, a name or a phone.
 *
 * When the person DID ask for it, the question cannot be answered without the lines. The error goes through, as it is,
 * to the door's usual error answer: an unfiltered list for a filtered question would be a wrong answer, and an empty one
 * would be a false «nobody».
 *
 * Only THIS read is soft. Every other read of the list still fails it, as it always did.
 */
async function readSaidLines(db: Client, companyId: string, ids: string[], asked: boolean): Promise<SaidLine[]> {
  try {
    return await db.orderActivity.findMany({
      where: { companyId, orderId: { in: ids }, action: COURIER_SAID },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { orderId: true, newStatus: true, metadata: true, createdAt: true },
    });
  } catch (error) {
    if (asked) throw error;
    console.error(
      '[tracking] the courier word could not be read, so the list is drawn without it:',
      error instanceof Error ? error.message : String(error),
      `(${ids.length} parcels)`
    );
    return [];
  }
}

export async function readTrackingList(
  db: Client,
  input: {
    /** The company the question is asked for — it leads the activity table's only index that starts with an order. */
    companyId: string;
    /** Scope + the state + the search, built by the door: the one question the database is asked. */
    where: Where;
    now: Date;
    task: ChipKey | null;
    courier: string | null;
    region: string | null;
    age: Age | null;
    /** What the company says about the parcel; left out it is no choice. */
    said?: SaidStatus | null;
    /**
     * Ask for the difference at matching — the door says so only for a person who holds the money sight, and names the store
     * whose statements count. Left out, nothing is read, no parcel carries one and nobody is counted.
     */
    differences?: { storeId: string } | null;
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
  const [cancelLogs, applied, saidLines, differenceOf] = l0.length
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
        // What the company said, for every parcel the list holds — the one read here that may fail quietly.
        readSaidLines(db, input.companyId, l0.map((o) => o.id), !!input.said),
        // The difference at matching, for whoever may see it: two grouped reads, and a failure is the list's.
        input.differences
          ? readDifferences(db, { companyId: input.companyId, storeId: input.differences.storeId, orderIds: l0.map((o) => o.id) })
          : new Map<string, DifferenceLean>(),
      ])
    : [[], [], [], new Map<string, DifferenceLean>()];

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
        where: { companyId: input.companyId, orderId: { in: candidates }, action: TRACKING_ACK_ACTION },
        orderBy: { createdAt: 'desc' },
        select: { orderId: true, createdAt: true },
      })
    : [];
  const ackedAt = newest(acks, (r) => r.createdAt);
  // The same pattern, keeping the whole line: the first seen per order is the company's latest word.
  const lastWord = new Map<string, SaidLine>();
  for (const line of saidLines) if (!lastWord.has(line.orderId)) lastWord.set(line.orderId, line);

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
      said: courierSaidAgainst(o.shippingStatus, lastWord.get(o.id), input.now),
      difference: differenceOf.get(o.id) ?? null,
    };
  });

  // ── the dropdowns' numbers: over L0 ──
  const courierCounts = countBy(judged.map((j) => ({ key: j.parcel.deliveryProviderId })));
  const regionCounts = countBy(judged.map((j) => ({ key: j.parcel.regionId })));
  const ageOfParcel = (j: Judged) => ageOf(daysWaitedOf(j.parcel.shippedAt, input.now));
  const ages = Object.fromEntries(AGES.map((a) => [a, judged.filter((j) => ageOfParcel(j) === a).length])) as Record<Age, number>;
  const said = Object.fromEntries(SAID_STATUSES.map((k) => [k, judged.filter((j) => j.said?.status === k).length])) as Record<SaidStatus, number>;

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
      (input.age === null || ageOfParcel(j) === input.age) &&
      (!input.said || j.said?.status === input.said)
  );

  // ── the chips and the badge: over L1 ──
  const tasks = Object.fromEntries(TASKS.map((k) => [k, l1.filter(MATCHES[k]).length])) as Record<ConditionKey, number>;

  // ── L2: the chip, then worst first — `Array.sort` is stable, so equal urgency keeps the database's order, oldest first ──
  const l2 = (input.task === null ? l1 : l1.filter(matchesChip(input.task))).slice().sort(byUrgency);
  // Inside «فيه فرق» the differences nobody has answered come first, then the answered ones, each worst first as everywhere.
  if (input.task === DIFFERENCE_CHIP) l2.sort(byDifference);

  const totalPages = Math.max(1, Math.ceil(l2.length / input.limit));
  const page = Math.min(Math.max(input.page, 1), totalPages);

  const pageRows = l2.slice((page - 1) * input.limit, page * input.limit);

  return {
    ids: pageRows.map((j) => j.id),
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
      said,
      // Only when asked: a door that did not ask (no money sight) has no number to give, and the answer is what it always was.
      ...(input.differences ? { difference: l1.filter(hasDifference).length } : {}),
    },
    capped,
    courierSaid: new Map(pageRows.flatMap((j): [string, CourierSaid][] => (j.said ? [[j.id, j.said]] : []))),
    differences: new Map(pageRows.flatMap((j): [string, DifferenceLean][] => (j.difference ? [[j.id, j.difference]] : []))),
  };
}
