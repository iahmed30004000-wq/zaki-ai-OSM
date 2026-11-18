import { roundMinor } from './money';
import { isDayKey, type BenchSpendDay } from './bench-verdict';

/**
 * THE BENCH'S SPEND, WRITTEN BY HAND — one entry per product per day.
 *
 * Entered on the bench screen for now. A later change may read the ad-spend
 * table the media buyer pulls from Meta; this does not, on purpose: the
 * owner's own numbers come first, and two sources for one day would need a
 * rule about which wins that nobody has ruled.
 *
 * NEVER DELETED — VOIDED. The same rule as an expense (`voidedAt`,
 * `voidReason`, `voidedById` on Expense): a wrong entry stays on the list,
 * marked, with who voided it and why, and leaves every figure. A correction
 * is a void and a new entry for the same day, together, so the history says
 * what was there before.
 *
 * Pure: the list comes in and a new list goes out. The caller stores it
 * under a row lock (bench-book.ts).
 */

export interface BenchSpendEntry {
  id: string;
  day: string;
  amount: number;
  at: string;
  byId: string;
  voidedAt?: string;
  voidedById?: string;
  voidReason?: string;
  /** The entry this one corrected. */
  replaces?: string;
}

export class BenchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchRefused';
  }
}

/** How many entries one product keeps — far beyond any test, and a ceiling on one settings document. */
export const MAX_ENTRIES_PER_PRODUCT = 400;

export const isLive = (e: BenchSpendEntry) => !e.voidedAt;

/** The live entries as the figures read them. */
export function liveSpend(list: readonly BenchSpendEntry[]): BenchSpendDay[] {
  return list.filter(isLive).map((e) => ({ day: e.day, amount: e.amount }));
}

/** A stored list as this build reads it — a malformed row is dropped, never thrown on. */
export function storedSpend(raw: unknown): BenchSpendEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is BenchSpendEntry =>
      !!e && typeof e === 'object' && typeof e.id === 'string' && isDayKey(e.day) && typeof e.amount === 'number' && Number.isFinite(e.amount)
  );
}

function checkAmount(raw: unknown, minorUnit: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new BenchRefused('المبلغ لازم يكون رقم، صفر أو أكتر.');
  if (n > 1_000_000) throw new BenchRefused('المبلغ كبير كتير — تأكد منه.');
  return roundMinor(n, minorUnit);
}

function checkDay(day: unknown, today: string): string {
  if (!isDayKey(day)) throw new BenchRefused('اختار يوم صحيح.');
  if (day > today) throw new BenchRefused('ما بينكتب صرف ليوم لسا ما إجا.');
  return day;
}

function checkReason(reason: unknown): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r.length < 2) throw new BenchRefused('اكتب سبب الإلغاء.');
  return r.slice(0, 200);
}

export function addSpend(
  list: readonly BenchSpendEntry[],
  p: { id: string; day: unknown; amount: unknown; today: string; byId: string; at: string; minorUnit: number }
): BenchSpendEntry[] {
  const day = checkDay(p.day, p.today);
  const amount = checkAmount(p.amount, p.minorUnit);
  if (list.some((e) => isLive(e) && e.day === day)) {
    throw new BenchRefused(`في صرف مكتوب ليوم ${day} — صحّحه بدل ما تكتب واحد تاني.`);
  }
  if (list.length >= MAX_ENTRIES_PER_PRODUCT) throw new BenchRefused('وصلت حد السطور لهالمنتج.');
  return [...list, { id: p.id, day, amount, at: p.at, byId: p.byId }];
}

export function voidSpend(
  list: readonly BenchSpendEntry[],
  p: { entryId: string; reason: unknown; byId: string; at: string }
): BenchSpendEntry[] {
  const reason = checkReason(p.reason);
  const target = list.find((e) => e.id === p.entryId);
  if (!target) throw new BenchRefused('هالسطر مش موجود.');
  if (!isLive(target)) throw new BenchRefused('هالسطر ملغى من قبل.');
  return list.map((e) => (e.id === p.entryId ? { ...e, voidedAt: p.at, voidedById: p.byId, voidReason: reason } : e));
}

/** A correction: the old entry voided and the new one written for the SAME day, in one list. */
export function correctSpend(
  list: readonly BenchSpendEntry[],
  p: { entryId: string; newId: string; amount: unknown; reason: unknown; today: string; byId: string; at: string; minorUnit: number }
): BenchSpendEntry[] {
  const target = list.find((e) => e.id === p.entryId);
  if (!target) throw new BenchRefused('هالسطر مش موجود.');
  const amount = checkAmount(p.amount, p.minorUnit);
  if (amount === target.amount) throw new BenchRefused('نفس المبلغ — ما في شي يتصحّح.');
  const reason = typeof p.reason === 'string' && p.reason.trim().length >= 2 ? p.reason : 'تصحيح المبلغ';
  const voided = voidSpend(list, { entryId: p.entryId, reason, byId: p.byId, at: p.at });
  return addSpend(voided, { id: p.newId, day: target.day, amount, today: p.today, byId: p.byId, at: p.at, minorUnit: p.minorUnit }).map(
    (e) => (e.id === p.newId ? { ...e, replaces: p.entryId } : e)
  );
}
