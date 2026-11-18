/**
 * ONE SPAN OF DAYS ACROSS THE FOUR REPORT TABS — «مدة وحدة بتضل لما أتنقّل بين التقارير».
 *
 * The performance board, the campaigns, the test bench and the intelligence tab each held their own window, so moving from
 * one to the next silently went back to «اليوم». The range now has ONE home, in this order:
 *
 *   1. the address (`?from=YYYY-MM-DD&to=YYYY-MM-DD`) — a link someone sent wins over everything;
 *   2. ONE `sessionStorage` key, written on every change by the screen that changed it;
 *   3. today.
 *
 * Pure: no database, no React, no `'use client'` module. Every touch of the storage is inside try/catch — a private window,
 * blocked site data or a preview can make the accessor itself throw — and a refused storage simply means «today».
 *
 * A screen whose door takes no window does not draw a picker; it keeps the stored range untouched and says so.
 */

export interface ReportRange {
  from: string;
  to: string;
}

/** Where the range came from. `today` means nothing was stored — a screen with its own «today» keeps its own form of it. */
export type ReportRangeSource = 'url' | 'storage' | 'today';

/** The one key. Session-scoped on purpose: a new tab of the browser starts from today, a tab moving between reports keeps it. */
export const REPORT_RANGE_KEY = 'reports.range';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function realDay(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DAY.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Two real days, `from` not after `to`. Anything else is not a range and is never stored or sent. */
export function isReportRange(r: unknown): r is ReportRange {
  if (!r || typeof r !== 'object') return false;
  const { from, to } = r as Record<string, unknown>;
  return realDay(from) && realDay(to) && (from as string) <= (to as string);
}

/** The store's day (or the browser's when no zone is given), as `YYYY-MM-DD`. */
export function todayKey(now: Date = new Date(), timeZone?: string): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      return `${get('year')}-${get('month')}-${get('day')}`;
    } catch {
      /* an unknown zone falls back to the browser's day */
    }
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The range in an address's query string, or null when it carries none (or a broken one). */
export function rangeFromSearch(search: string): ReportRange | null {
  try {
    const q = new URLSearchParams(search);
    const r = { from: q.get('from') ?? '', to: q.get('to') ?? '' };
    return isReportRange(r) ? r : null;
  } catch {
    return null;
  }
}

/** A getter, not the object: reading `window.sessionStorage` is itself what throws when the browser refuses it. */
export type StorageGetter = () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null | undefined;

/** The browser's session storage, or null — never a throw. */
export const sessionStore: StorageGetter = () => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

/** What the storage holds, or null — a refused storage, an empty key or a broken value all read as nothing. */
export function readStoredRange(storage: StorageGetter = sessionStore): ReportRange | null {
  try {
    const raw = storage()?.getItem(REPORT_RANGE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as unknown;
    return isReportRange(r) ? { from: r.from, to: r.to } : null;
  } catch {
    return null;
  }
}

/** The address first, then the storage, then today. */
export function readReportRange(
  search: string,
  storage: StorageGetter = sessionStore,
  now: Date = new Date(),
  timeZone?: string,
): { range: ReportRange; source: ReportRangeSource } {
  const fromUrl = rangeFromSearch(search);
  if (fromUrl) return { range: fromUrl, source: 'url' };
  const stored = readStoredRange(storage);
  if (stored) return { range: stored, source: 'storage' };
  const today = todayKey(now, timeZone);
  return { range: { from: today, to: today }, source: 'today' };
}

/**
 * Write the range a screen just changed to. Not a range (null, empty, broken) → the key is REMOVED: the next tab opens on today
 * rather than on a span the person already left. Returns whether the storage took it.
 */
export function writeReportRange(range: ReportRange | null, storage: StorageGetter = sessionStore): boolean {
  try {
    const s = storage();
    if (!s) return false;
    if (range && isReportRange(range)) s.setItem(REPORT_RANGE_KEY, JSON.stringify({ from: range.from, to: range.to }));
    else s.removeItem(REPORT_RANGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * The same query string with its `from`/`to` set to the new range (or removed). Only used when the address ALREADY carried a
 * range: left as it was, a reload would reopen on the old span, because the address wins over the storage.
 */
export function searchWithRange(search: string, range: ReportRange | null): string {
  const q = new URLSearchParams(search);
  if (range && isReportRange(range)) {
    q.set('from', range.from);
    q.set('to', range.to);
  } else {
    q.delete('from');
    q.delete('to');
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
