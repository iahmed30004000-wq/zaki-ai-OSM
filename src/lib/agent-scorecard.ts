import type { Prisma } from '@prisma/client';
import { businessMinutesBetween, zonedParts, type BusinessCalendar } from './business-calendar';
import { DELIVERED_SHIPPING, RETURNED_SHIPPING } from './order-state';
import { NOT_A_CALL } from './no-answer-rounds';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE AGENT SCORECARD (Confirmation Center v2, step G1) — one row per agent per day (or week), read-only.
 *
 * The numbers the planner asked for, each with the BASE it stands on (a rate with a zero base is «—», never 0%) and its «قاعدة الاحتساب» — the sentence that says exactly
 * what was counted. Nothing here writes, nothing here is money: the commission arithmetic (`commission-*.ts`) and the existing team figures (`team-performance.ts`,
 * `performance-metrics.ts`) are NOT touched and NOT reused — this is a separate reading with its own definitions (UNIQUE ORDERS, per day), so the two never disagree by
 * accident: where they differ the rule below says why.
 *
 * Never a ranking: rows are by day, then by name. Agents and counts only — no customer field is read.
 *
 * `winback` (step F1) credits the REACTIVATING agent: of the winback offers she made that day (the existing `WINBACK_OFFERED` line, whose author is the person who pressed the offer), how many became a CONFIRMED order by the time of the reading. A read of the audit line and of the new order — nothing here writes money, an order or a commission.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** A delivered-or-returned rate looks only at confirmations at least this old: before that most of them are still on the road. */
export const DELIVERY_MATURITY_DAYS = 7;
/** A claim let go within this long is a «quick» release. */
export const QUICK_RELEASE_MS = 60_000;

export type Grain = 'day' | 'week';

export interface Ratio {
  /** The part. */
  of: number;
  /** The base. */
  base: number;
  /** The part over the base as a whole percent; null when the base is zero. */
  rate: number | null;
}

export interface ScoreRow {
  /** The local day (grain day) or the Saturday of the local week (grain week), YYYY-MM-DD. */
  bucket: string;
  userId: string;
  name: string;
  claims: number;
  confirmed: number;
  rejected: number;
  confirmationRate: Ratio;
  medianFirstAttemptMinutes: number | null;
  firstAttempts: number;
  quickNoAnswer: Ratio;
  attempts: number;
  upsell: Ratio;
  delivery: Ratio & { delivered: number; returned: number };
  /** Offers she made (the base) and how many of their new orders are confirmed by now (the part). */
  winback: Ratio;
}

export const SCORECARD_RULES: Record<string, string> = {
  claims: 'عدد الطلبات المختلفة اللي سحبتها الموظفة بهاليوم (الطلب اللي انسحب مرتين بنفس اليوم مرة وحدة).',
  confirmed: 'عدد الطلبات المختلفة اللي أكّدتها بهاليوم؛ وإذا أكّدت طلب ثم رفضتو بنفس اليوم بينحسب بآخر قرار.',
  confirmationRate: 'المؤكَّدة ÷ (المؤكَّدة + المرفوضة) على الطلبات المختلفة اللي قرّرت فيها بهاليوم. بدون قرارات = «—».',
  medianFirstAttempt: 'وسيط الدقائق (دقائق دوام) من سحب الطلب لأول سطر اتصال سجّلتو عليه (ضغطة «اتصل» أو نتيجة). الطلب اللي ما انسجّل عليه اتصال ما بينحسب.',
  quickNoAnswer: 'من الطلبات اللي سحبتها: كم واحد رجّعتو للطابور خلال أقل من دقيقة من السحب. بدون سحبات = «—».',
  attempts: 'عدد سطور المحاولة اللي سجّلتها فعلاً (اتصال أو نتيجة)؛ ضغطة «اتصل» ورسالة الواتساب ما بينعدّوا.',
  upsell: 'من الطلبات المختلفة اللي أكّدتها: كم واحد أضافت عليه بنفسها منتج بعد الاستقبال. بدون تأكيدات = «—».',
  delivery: `المسلَّمة ÷ (المسلَّمة + المرتجعة) من الطلبات اللي أكّدتها وصار عليها ${DELIVERY_MATURITY_DAYS} أيام أو أكتر؛ اللي لسا بالطريق ما بتنحسب بأي طرف. بدون مسلَّم ومرتجع = «—».`,
  winback: 'من عروض الاسترجاع اللي قدّمتها هاليوم (العرض بينحسب للي ضغطت عليه): كم واحد صار طلب مؤكَّد لحد وقت القراءة. بدون عروض = «—». التأكيد بينحسب للي قدّمت العرض مش للي أكّد الطلب الجديد.',
};

const ratio = (of: number, base: number): Ratio => ({ of, base, rate: base > 0 ? Math.round((of / base) * 100) : null });

/** The median of a list of numbers, or null when there is none. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The bucket a moment falls in: its local day, or the Saturday of its local week. */
export function bucketOf(at: Date, grain: Grain, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  if (grain === 'day') return day;
  const anchor = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const back = (anchor.getUTCDay() + 1) % 7; // Saturday = 0 — the commission module's own week (`currentSpan('WEEKLY')`): one calendar, not two
  anchor.setUTCDate(anchor.getUTCDate() - back);
  return anchor.toISOString().slice(0, 10);
}

export interface ScoreInputs {
  now: Date;
  grain: Grain;
  calendar: BusinessCalendar;
  names: ReadonlyMap<string, string>;
  claims: readonly { userId: string; orderId: string; at: Date }[];
  releases: readonly { userId: string; orderId: string; at: Date }[];
  decisions: readonly { userId: string; orderId: string; value: 'CONFIRMED' | 'REJECTED'; at: Date }[];
  attempts: readonly { userId: string; orderId: string; result: string; at: Date }[];
  upsold: ReadonlySet<string>;
  confirmations: readonly { userId: string; orderId: string; at: Date; shippingStatus: string }[];
  /** The winback offers she made, and whether the order each one made is confirmed by now. */
  winbackOffers: readonly { userId: string; at: Date; confirmed: boolean }[];
}

interface Cell {
  claims: Set<string>;
  quick: Set<string>;
  decided: Map<string, 'CONFIRMED' | 'REJECTED'>;
  firstAttemptMinutes: number[];
  attempts: number;
  delivered: number;
  returned: number;
  offered: number;
  reactivated: number;
}

/** The pure tally: the rows for every (bucket, agent) that did anything. */
export function tallyScorecard(i: ScoreInputs): ScoreRow[] {
  const tz = i.calendar.timezone;
  const cells = new Map<string, { bucket: string; userId: string; cell: Cell }>();
  const cellOf = (at: Date, userId: string): Cell => {
    const bucket = bucketOf(at, i.grain, tz);
    const key = `${bucket}|${userId}`;
    let hit = cells.get(key);
    if (!hit) {
      hit = { bucket, userId, cell: { claims: new Set(), quick: new Set(), decided: new Map(), firstAttemptMinutes: [], attempts: 0, delivered: 0, returned: 0, offered: 0, reactivated: 0 } };
      cells.set(key, hit);
    }
    return hit.cell;
  };

  // claims, and the claims let go inside a minute — the release has to be hers, on the same order, after the claim and within the minute
  const claimedAt = new Map<string, Date[]>(); // `${user}|${order}` → claim times, oldest first
  for (const c of [...i.claims].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    cellOf(c.at, c.userId).claims.add(c.orderId);
    const k = `${c.userId}|${c.orderId}`;
    claimedAt.set(k, [...(claimedAt.get(k) ?? []), c.at]);
  }
  for (const r of i.releases) {
    const claim = [...(claimedAt.get(`${r.userId}|${r.orderId}`) ?? [])].reverse().find((t) => t.getTime() <= r.at.getTime());
    if (claim && r.at.getTime() - claim.getTime() < QUICK_RELEASE_MS) cellOf(claim, r.userId).quick.add(r.orderId);
  }

  // decisions: the LAST one per (day, agent, order) stands
  for (const d of [...i.decisions].sort((a, b) => a.at.getTime() - b.at.getTime())) cellOf(d.at, d.userId).decided.set(d.orderId, d.value);

  // attempts logged (calls and results, not the press and not a message), and the time from a claim to her first line on that order
  const byOrder = new Map<string, { userId: string; at: Date }[]>();
  for (const a of i.attempts) {
    if (!NOT_A_CALL.includes(a.result)) cellOf(a.at, a.userId).attempts += 1;
    const k = `${a.userId}|${a.orderId}`;
    byOrder.set(k, [...(byOrder.get(k) ?? []), { userId: a.userId, at: a.at }]);
  }
  for (const [k, times] of claimedAt) {
    const lines = (byOrder.get(k) ?? []).map((l) => l.at).sort((x, y) => x.getTime() - y.getTime());
    for (const t0 of times) {
      const first = lines.find((l) => l.getTime() >= t0.getTime());
      if (first) cellOf(t0, k.split('|')[0]).firstAttemptMinutes.push(businessMinutesBetween(t0, first, i.calendar));
    }
  }

  // delivery: only confirmations old enough to have a verdict
  const mature = i.now.getTime() - DELIVERY_MATURITY_DAYS * 86_400_000;
  for (const c of i.confirmations) {
    if (c.at.getTime() > mature) continue;
    const cell = cellOf(c.at, c.userId);
    if ((DELIVERED_SHIPPING as readonly string[]).includes(c.shippingStatus)) cell.delivered += 1;
    else if ((RETURNED_SHIPPING as readonly string[]).includes(c.shippingStatus)) cell.returned += 1;
  }

  for (const o of i.winbackOffers) {
    const cell = cellOf(o.at, o.userId);
    cell.offered += 1;
    if (o.confirmed) cell.reactivated += 1;
  }

  const rows: ScoreRow[] = [];
  for (const { bucket, userId, cell } of cells.values()) {
    const decided = [...cell.decided.entries()];
    const confirmedIds = decided.filter(([, v]) => v === 'CONFIRMED').map(([id]) => id);
    const rejected = decided.length - confirmedIds.length;
    const upsoldCount = confirmedIds.filter((id) => i.upsold.has(`${userId}|${id}`)).length;
    rows.push({
      bucket,
      userId,
      name: i.names.get(userId) ?? '—',
      claims: cell.claims.size,
      confirmed: confirmedIds.length,
      rejected,
      confirmationRate: ratio(confirmedIds.length, confirmedIds.length + rejected),
      medianFirstAttemptMinutes: medianOf(cell.firstAttemptMinutes),
      firstAttempts: cell.firstAttemptMinutes.length,
      quickNoAnswer: ratio(cell.quick.size, cell.claims.size),
      attempts: cell.attempts,
      upsell: ratio(upsoldCount, confirmedIds.length),
      delivery: { ...ratio(cell.delivered, cell.delivered + cell.returned), delivered: cell.delivered, returned: cell.returned },
      winback: ratio(cell.reactivated, cell.offered),
    });
  }
  // by bucket (newest first), then by name — never by a score
  return rows.sort((a, b) => (a.bucket === b.bucket ? a.name.localeCompare(b.name, 'ar') : a.bucket < b.bucket ? 1 : -1));
}

export interface ScorecardScope {
  companyId: string;
  storeId: string;
  start: Date;
  end: Date;
  calendar: BusinessCalendar;
  grain: Grain;
}

/** The scorecard over a window: the reads, then the tally. Read-only; a person is only listed if they did something inside the window. */
export async function readScorecard(client: Client, scope: ScorecardScope, now: Date = new Date()): Promise<{ rows: ScoreRow[]; rules: Record<string, string> }> {
  const inWindow = { gte: scope.start, lt: scope.end };
  const orderScope = { companyId: scope.companyId, storeId: scope.storeId };

  const [claimRows, releaseRows, decisionRows, confirmedOrders, offerRows] = await Promise.all([
    client.orderClaimHistory.findMany({
      where: { companyId: scope.companyId, action: 'CLAIMED', createdAt: inWindow, order: { storeId: scope.storeId } },
      select: { userId: true, orderId: true, createdAt: true },
      take: 50_000,
    }),
    client.orderClaimHistory.findMany({
      where: { companyId: scope.companyId, action: 'RELEASED', createdAt: { gte: scope.start, lt: new Date(scope.end.getTime() + QUICK_RELEASE_MS) }, order: { storeId: scope.storeId } },
      select: { userId: true, orderId: true, createdAt: true },
      take: 50_000,
    }),
    client.orderStatusLog.findMany({
      where: { companyId: scope.companyId, statusType: 'CONFIRMATION', newValue: { in: ['CONFIRMED', 'REJECTED'] }, createdAt: inWindow, order: { storeId: scope.storeId } },
      select: { changedById: true, orderId: true, newValue: true, createdAt: true },
      take: 50_000,
    }),
    client.order.findMany({
      where: { ...orderScope, confirmedById: { not: null }, confirmedAt: inWindow },
      select: { id: true, confirmedById: true, confirmedAt: true, shippingStatus: true },
      take: 50_000,
    }),
    client.auditLog.findMany({
      where: { companyId: scope.companyId, action: 'WINBACK_OFFERED', userId: { not: null }, createdAt: inWindow },
      select: { userId: true, newData: true, createdAt: true },
      take: 20_000,
    }),
  ]);
  const offeredIds = offerRows.map((o) => {
    try {
      return (JSON.parse(o.newData ?? '{}') as { newOrderId?: string }).newOrderId ?? null;
    } catch {
      return null;
    }
  });
  const reactivated = new Set(
    offeredIds.some(Boolean)
      ? (await client.order.findMany({ where: { id: { in: offeredIds.filter((x): x is string => !!x) }, storeId: scope.storeId, confirmationStatus: 'CONFIRMED' }, select: { id: true } })).map((o) => o.id)
      : []
  );

  const claimedOrderIds = [...new Set(claimRows.map((c) => c.orderId))];
  const confirmedDecisionIds = [...new Set(decisionRows.filter((d) => d.newValue === 'CONFIRMED').map((d) => d.orderId))];
  const userIds = [...new Set([...claimRows.map((c) => c.userId), ...decisionRows.map((d) => d.changedById), ...confirmedOrders.map((o) => o.confirmedById!), ...offerRows.map((o) => o.userId!)])];

  const [attemptRows, upsoldLines, users] = await Promise.all([
    claimedOrderIds.length || userIds.length
      ? client.orderContactAttempt.findMany({
          where: { companyId: scope.companyId, employeeId: { in: userIds }, createdAt: { gte: scope.start, lt: scope.end }, OR: [{ orderId: { in: claimedOrderIds } }, { createdAt: inWindow }] },
          select: { employeeId: true, orderId: true, result: true, createdAt: true },
          take: 100_000,
        })
      : Promise.resolve([]),
    confirmedDecisionIds.length
      ? client.orderItem.findMany({
          where: { companyId: scope.companyId, orderId: { in: confirmedDecisionIds }, addedById: { in: userIds }, addedStage: { not: 'INTAKE' } },
          select: { orderId: true, addedById: true },
        })
      : Promise.resolve([]),
    userIds.length ? client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);

  const rows = tallyScorecard({
    now,
    grain: scope.grain,
    calendar: scope.calendar,
    names: new Map(users.map((u) => [u.id, u.name ?? '—'])),
    claims: claimRows.map((c) => ({ userId: c.userId, orderId: c.orderId, at: c.createdAt })),
    releases: releaseRows.map((r) => ({ userId: r.userId, orderId: r.orderId, at: r.createdAt })),
    decisions: decisionRows.map((d) => ({ userId: d.changedById, orderId: d.orderId, value: d.newValue as 'CONFIRMED' | 'REJECTED', at: d.createdAt })),
    attempts: attemptRows.map((a) => ({ userId: a.employeeId, orderId: a.orderId, result: a.result, at: a.createdAt })),
    upsold: new Set(upsoldLines.map((l) => `${l.addedById}|${l.orderId}`)),
    confirmations: confirmedOrders.map((o) => ({ userId: o.confirmedById!, orderId: o.id, at: o.confirmedAt!, shippingStatus: o.shippingStatus })),
    winbackOffers: offerRows.map((o, k) => ({ userId: o.userId!, at: o.createdAt, confirmed: !!offeredIds[k] && reactivated.has(offeredIds[k]!) })),
  });
  return { rows, rules: SCORECARD_RULES };
}
