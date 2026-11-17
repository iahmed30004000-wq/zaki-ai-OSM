import type { Prisma } from '@prisma/client';
import { zonedParts } from './business-calendar';
import { NO_ANSWER_RESULTS } from './confirmation-workflow';
import type { db } from './db';
import { backlogShare, type ShareInputs } from './queue-priority';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE WEEKLY RECALIBRATION (Confirmation Center v2, step D2): the share of the backlog, the answer rate by hour and the arrival curve, recomputed from the last 14 days and set beside the
 * 14 days before — said in an Arabic note with its rule. READ-ONLY: it changes no number the pull uses (the share still comes from `queue-priority-share.ts`, and the cadence's times are the
 * owner's rulings of 15/11). It is for the owner and the supervisors to SEE where the data moved — «اليوم ≈ 47%» one week and «≈ 37%» the next is a reason to look, not a setting to be rewritten
 * behind their backs. Computed when asked and kept 30 minutes per store in this process: no table, no job.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const RECAL_DAYS = 14;
/** An hour with fewer attempts than this has no rate: three calls are not a rate. */
export const RECAL_MIN_SAMPLES = 20;
const REACHED = ['ANSWERED', 'CONFIRMED', 'REJECTED', 'CALLBACK_REQUESTED'];
const ROW_CAP = 50_000;
const CACHE_MS = 30 * 60_000;

export interface HourRate {
  hour: number;
  reached: number;
  noAnswer: number;
  /** Percent reached, or null with fewer than `RECAL_MIN_SAMPLES` attempts. */
  rate: number | null;
}

export interface WindowReading {
  share: number;
  inputs: ShareInputs;
  hours: HourRate[];
  /** Orders created in each local hour, 0..23. */
  arrivals: number[];
}

export interface Recalibration {
  current: WindowReading;
  previous: WindowReading;
  note: string;
}

export function hourlyRates(attempts: ReadonlyArray<{ createdAt: Date; result: string }>, timeZone: string): HourRate[] {
  const rows: HourRate[] = Array.from({ length: 24 }, (_, hour) => ({ hour, reached: 0, noAnswer: 0, rate: null }));
  for (const a of attempts) {
    const hour = zonedParts(a.createdAt, timeZone).hour;
    if (REACHED.includes(a.result)) rows[hour].reached++;
    else if ((NO_ANSWER_RESULTS as readonly string[]).includes(a.result)) rows[hour].noAnswer++;
  }
  for (const r of rows) {
    const n = r.reached + r.noAnswer;
    r.rate = n >= RECAL_MIN_SAMPLES ? Math.round((r.reached / n) * 100) : null;
  }
  return rows;
}

export function arrivalCurve(createdAts: ReadonlyArray<Date>, timeZone: string): number[] {
  const out = Array.from({ length: 24 }, () => 0);
  for (const at of createdAts) out[zonedParts(at, timeZone).hour]++;
  return out;
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** The note, in the planner's words: what moved and by how much, and how every figure is counted. */
export function recalibrationNote(current: WindowReading, previous: WindowReading): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const moved = Math.round((current.share - previous.share) * 100);
  const parts = [
    `نسبة المتأخر هلأ ${pct(current.share)} ${moved === 0 ? '(ما تغيّرت عن الفترة اللي قبلها)' : `(${moved > 0 ? 'زادت' : 'نقصت'} ${Math.abs(moved)} نقطة عن ${pct(previous.share)})`}.`,
  ];
  const rated = current.hours.filter((h) => h.rate !== null) as Array<HourRate & { rate: number }>;
  if (rated.length >= 2) {
    const best = rated.reduce((a, b) => (b.rate > a.rate ? b : a));
    const worst = rated.reduce((a, b) => (b.rate < a.rate ? b : a));
    parts.push(`أحسن ساعة للرد ${hh(best.hour)} (${best.rate}% بيردّوا) وأسوأ ساعة ${hh(worst.hour)} (${worst.rate}%).`);
  } else {
    parts.push('ما في محاولات كافية لحساب أحسن ساعة للرد.');
  }
  const total = current.arrivals.reduce((s, n) => s + n, 0);
  if (total > 0) {
    const peak = current.arrivals.reduce((best, n, h) => (n > current.arrivals[best] ? h : best), 0);
    parts.push(`أكتر ساعة بيوصل فيها طلبات ${hh(peak)} (${Math.round((current.arrivals[peak] / total) * 100)}% من الطلبات).`);
  }
  parts.push(
    `قاعدة الاحتساب: آخر ${RECAL_DAYS} يوم مقابل الـ${RECAL_DAYS} يوم اللي قبلها. النسبة = (طلبات صارت «لا يرد» أول مرة بالفترة) ÷ (زبائن فريدين جدد + هالطلبات)، محصورة 25%–50%، بدون إضافة المخزون القديم. ` +
      `نسبة الرد بالساعة = (ردّ ÷ (ردّ + لا يرد)) من محاولات الاتصال، وما بتنحسب لساعة فيها أقل من ${RECAL_MIN_SAMPLES} محاولة. هاد عرض بس: ما بيغيّر أي رقم بالسحب.`
  );
  return parts.join(' ');
}

async function readWindow(client: Client, scope: { companyId: string; storeId: string }, from: Date, to: Date, timeZone: string): Promise<WindowReading> {
  const noAnswer = { result: { in: [...NO_ANSWER_RESULTS] } };
  const [customers, backlogEntered, attempts, orders] = await Promise.all([
    client.order.findMany({ where: { ...scope, createdAt: { gte: from, lt: to }, replacesOrderId: null }, distinct: ['customerId'], select: { customerId: true }, take: ROW_CAP }),
    // «Became backlog in the window»: its FIRST «لا يرد» is inside it — the very rule the share of the pull uses, over this window.
    client.order.count({ where: { ...scope, contactAttempts: { some: { ...noAnswer, createdAt: { gte: from, lt: to } }, none: { ...noAnswer, createdAt: { lt: from } } } } }),
    client.orderContactAttempt.findMany({ where: { companyId: scope.companyId, order: { storeId: scope.storeId }, createdAt: { gte: from, lt: to }, result: { in: [...REACHED, ...NO_ANSWER_RESULTS] } }, select: { createdAt: true, result: true }, take: ROW_CAP }),
    client.order.findMany({ where: { ...scope, createdAt: { gte: from, lt: to }, replacesOrderId: null }, select: { createdAt: true }, take: ROW_CAP }),
  ]);
  const inputs: ShareInputs = { newUnique: customers.length, backlogEntered, staleStock: 0 };
  return { share: backlogShare(inputs).share, inputs, hours: hourlyRates(attempts, timeZone), arrivals: arrivalCurve(orders.map((o) => o.createdAt), timeZone) };
}

const cache = new Map<string, { value: Recalibration; at: number }>();

/** The recalibration of this store — cached 30 minutes; null when a read fails (the board then simply leaves it out). */
export async function readRecalibration(client: Client, scope: { companyId: string; storeId: string }, timeZone: string, now: Date): Promise<Recalibration | null> {
  const key = `${scope.companyId}:${scope.storeId}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.value;
  try {
    const day = 86_400_000;
    const mid = new Date(now.getTime() - RECAL_DAYS * day);
    const start = new Date(now.getTime() - 2 * RECAL_DAYS * day);
    const [current, previous] = await Promise.all([readWindow(client, scope, mid, now, timeZone), readWindow(client, scope, start, mid, timeZone)]);
    const value = { current, previous, note: recalibrationNote(current, previous) };
    cache.set(key, { value, at: now.getTime() });
    return value;
  } catch {
    return null;
  }
}
