'use client';

import React, { useEffect, useRef, useState } from 'react';
import { addDays, addMonths, format, isAfter, isBefore, isSameDay, startOfMonth, startOfWeek } from 'date-fns';
import { ar } from 'date-fns/locale';
import { RiArrowLeftSLine, RiArrowRightSLine, RiCalendar2Line, RiCloseLine } from '@remixicon/react';
import { startOfLocalDay } from '@/lib/local-day';

/**
 * Picking a span of days, in Arabic.
 *
 * Two native date inputs put the browser's own picker on screen: Latin
 * month names, a left-to-right grid and a layout nobody here reads. And
 * they asked the wrong question — the answer is almost always "the last
 * week" or "this month", not a pair of exact dates, so those come first and
 * the grid is there for the times they are not enough.
 */

export interface Range {
  from: string;
  to: string;
}

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

/* ═══════════════════ THE ONE DATE BOX (R2c, plan 17/11) ═══════════════════
 *
 * The options, in the order the strip reads. `custom` is «تاريخ محدد» — the month grid under the strip, not a button.
 * The strip a screen gets when it says nothing is the SIX that every screen has always had (today · yesterday · 7 days · 30 days · this
 * month · a picked span): the five call sites open exactly as they did. The plan's FIVE (no «هذا الشهر») is `FIVE_OPTIONS`, for the
 * screens that adopt it one by one.
 */
export type DateOption = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

export const DATE_OPTION_LABELS: Record<DateOption, string> = {
  today: 'اليوم',
  yesterday: 'أمس',
  '7d': 'آخر 7 أيام',
  '30d': 'آخر 30 يوم',
  month: 'هذا الشهر',
  custom: 'تاريخ محدد',
};

export const ALL_OPTIONS: readonly DateOption[] = ['today', 'yesterday', '7d', '30d', 'month', 'custom'];
/** The plan's five: اليوم · أمس · آخر 7 أيام · آخر 30 يوم · تاريخ محدد. */
export const FIVE_OPTIONS: readonly DateOption[] = ['today', 'yesterday', '7d', '30d', 'custom'];

/** The options that are a ready range (everything but the picked span). */
export type PresetOption = Exclude<DateOption, 'custom'>;

/**
 * WHAT EACH DOOR DOES WITH A SPAN THAT IS TOO LONG — as data, so a screen can say it in its own words and never hard-code the number.
 * `analytics` (`getDateRange`, `MAX_WINDOW_DAYS`) cuts the start silently; `dailySeries` (`MAX_SERIES_DAYS`) refuses. Both numbers are
 * pinned against their source files by the test beside this one. The profit, the campaigns and the orders doors have no limit of their own.
 */
export const WINDOW_LIMITS = {
  analytics: { days: 90, over: 'clamped' },
  dailySeries: { days: 92, over: 'refused' },
} as const;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026-13-40` has the shape of a day and is not one. */
export function isRealDay(day: string): boolean {
  const m = DAY_RE.exec(day);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** A day plus or minus whole days — on the calendar, never on the clock, so a daylight-saving night cannot lose or repeat a day. */
function shiftDay(day: string, days: number): string {
  const m = DAY_RE.exec(day)!;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * The `yyyy-MM-dd` of the day a moment fell on. With a time zone (the STORE's, `country.timezone`) it is that zone's day; without one it
 * is the browser's own, as it always was. Never `toISOString().slice(0, 10)` of a moment: that is the UTC day, which for three hours of
 * every Amman evening names tomorrow.
 */
export function dayKeyIn(at: Date, timeZone?: string): string {
  if (!timeZone) return iso(at);
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return iso(at);
  }
}

/** One preset as a range of days. Null for `custom`, which is a pair the person picks. */
export function presetRange(option: DateOption, now: Date = new Date(), timeZone?: string): Range | null {
  if (option === 'custom') return null;
  const today = dayKeyIn(now, timeZone);
  switch (option) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = shiftDay(today, -1);
      return { from: y, to: y };
    }
    case '7d':
      return { from: shiftDay(today, -6), to: today };
    case '30d':
      return { from: shiftDay(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

/** THE DAY OF TODAY, as a range — what the figures screens open on (the owner, 17/11: the default is today; a screen that opens on all of history is the slow one). */
export function todayRange(now: Date = new Date(), timeZone?: string): Range {
  return presetRange('today', now, timeZone)!;
}

/** The range a screen opens on: its `initial` option, today when it says nothing. */
export function initialRange(initial: PresetOption = 'today', now: Date = new Date(), timeZone?: string): Range {
  return presetRange(initial, now, timeZone)!;
}

/** A real pair of days, `from` not after `to`. The empty pair is not valid — it means «no window» and each door has its own answer for that. */
export function validRange(range: Range): boolean {
  return isRealDay(range.from) && isRealDay(range.to) && range.from <= range.to;
}

/** How many days the range covers, both ends counted; null when it is not a valid range. */
export function spanDays(range: Range): number | null {
  if (!validRange(range)) return null;
  const a = DAY_RE.exec(range.from)!;
  const b = DAY_RE.exec(range.to)!;
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86_400_000) + 1;
}

/** True when the range is longer than a door's limit (see {@link WINDOW_LIMITS}). */
export function overLimit(range: Range, limit: { days: number }): boolean {
  const n = spanDays(range);
  return n !== null && n > limit.days;
}

/**
 * THE NAME `/api/analytics*` KNOWS A RANGE BY — only when the two mean the SAME days.
 * today, yesterday and this month are the same days on both sides. «آخر 7 أيام» here is seven days (today and the six before) while
 * the door's `7d` is today and the SEVEN before — eight days — and its `30d` is thirty-one; so those two travel as dates and never
 * as a name that would answer for a different span. Null: no name fits, send the days.
 */
export function periodOf(range: Range, now: Date = new Date(), timeZone?: string): 'today' | 'yesterday' | 'month' | null {
  for (const p of ['today', 'yesterday', 'month'] as const) {
    const r = presetRange(p, now, timeZone)!;
    if (r.from === range.from && r.to === range.to) return p;
  }
  return null;
}

/** The three shapes the doors read: `startDate=&endDate=` · `from=&to=` · `period=` (a name when one fits, the days when none does). */
export type QueryForm = 'startEnd' | 'fromTo' | 'period';

/**
 * A RANGE AS THE QUERY STRING A DOOR READS (no leading «?»).
 *
 *   startEnd  `startDate=2026-11-01&endDate=2026-11-18`  — analytics, campaigns, the scorecard, profitability
 *   fromTo    `from=2026-11-01&to=2026-11-18`            — orders, audit, the profit screen, the daily series
 *   period    `period=today` when a name means the same days, else the `startEnd` pair
 *
 * A range that is empty or not a real pair (a bad day, `from` after `to`) is NOT sent half-way: the answer is `empty` — what the screen
 * sends today for «no window» (`''`, or `period=all`…). The days are the STORE's days; `timeZone` only matters for `period`.
 */
export function toQuery(
  range: Range,
  form: QueryForm = 'startEnd',
  opts: { empty?: string; now?: Date; timeZone?: string } = {},
): string {
  const empty = opts.empty ?? '';
  if (!validRange(range)) return empty;
  if (form === 'fromTo') return `from=${range.from}&to=${range.to}`;
  if (form === 'period') {
    const p = periodOf(range, opts.now, opts.timeZone);
    if (p) return `period=${p}`;
  }
  return `startDate=${range.from}&endDate=${range.to}`;
}

const DAY_INITIALS = ['أحد', 'إثن', 'ثلا', 'أرب', 'خمي', 'جمع', 'سبت'];

export function DateRange({
  value,
  onChange,
  label = 'التاريخ',
  initial = 'today',
  options = ALL_OPTIONS,
  timeZone,
}: {
  /** The range. Left out, the box holds it itself and opens on `initial`. */
  value?: Range;
  onChange: (range: Range) => void;
  label?: string;
  /** Which preset it opens on when it holds the range itself. Default today. */
  initial?: PresetOption;
  /** A screen may offer fewer. Read in the order given; no `custom` means no month grid. */
  options?: readonly DateOption[];
  /** The store's time zone: «اليوم» is the store's day. Without it, the browser's. */
  timeZone?: string;
}) {
  const [held, setHeld] = useState<Range>(() => initialRange(initial, new Date(), timeZone));
  const current = value ?? held;
  const commit = (range: Range) => {
    setHeld(range);
    onChange(range);
  };
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfMonth((current.from && startOfLocalDay(current.from)) || new Date()));
  /** The first click of a new span; the second click closes it. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  function preset(option: DateOption) {
    const range = presetRange(option, new Date(), timeZone);
    if (range) commit(range);
    setAnchor(null);
    setOpen(false);
  }

  function pick(day: Date) {
    const picked = iso(day);
    if (!anchor) {
      setAnchor(picked);
      commit({ from: picked, to: picked });
      return;
    }
    // Clicking before the anchor turns the span around rather than refusing.
    const [from, to] = picked < anchor ? [picked, anchor] : [anchor, picked];
    commit({ from, to });
    setAnchor(null);
    setOpen(false);
  }

  // A calendar day is added to a calendar day: `first + i × 24h` repeats a day (or skips one) on the night the clock goes back.
  const first = startOfWeek(startOfMonth(month), { weekStartsOn: 0 });
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) days.push(addDays(first, i));

  const fromDay = current.from ? startOfLocalDay(current.from) : null;
  const toDay = current.to ? startOfLocalDay(current.to) : null;
  const from = fromDay;
  const to = toDay;
  const summary =
    fromDay && toDay
      ? current.from === current.to
        ? format(fromDay, 'd MMMM yyyy', { locale: ar })
        : `${format(fromDay, 'd MMM', { locale: ar })} — ${format(toDay, 'd MMM yyyy', { locale: ar })}`
      : label;

  const shown = options.filter((o): o is PresetOption => o !== 'custom');
  const withGrid = options.includes('custom');
  // The first preset that is exactly the range on show — two can coincide (the 30th of a month is both «30 يوم» and «هذا الشهر»).
  const active = shown.find((o) => {
    const r = presetRange(o, new Date(), timeZone)!;
    return r.from === current.from && r.to === current.to;
  });

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-xs text-[var(--sys-foreground)] inline-flex items-center gap-2 hover:border-[var(--sys-primary)]/50"
      >
        <RiCalendar2Line className="w-4 h-4 text-[var(--sys-muted)] shrink-0" />
        <span className="truncate flex-1 text-start">{summary}</span>
        {(current.from || current.to) && (
          <span
            role="button"
            tabIndex={0}
            aria-label="امسح التاريخ"
            onClick={(e) => {
              e.stopPropagation();
              commit({ from: '', to: '' });
              setAnchor(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                commit({ from: '', to: '' });
              }
            }}
            className="text-[var(--sys-muted)] hover:text-[var(--sys-destructive)] shrink-0"
          >
            <RiCloseLine className="w-4 h-4" />
          </span>
        )}
      </button>

      {open && (
        <div
          dir="rtl"
          className="absolute z-30 mt-1 w-[19rem] rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] shadow-overlay p-3 space-y-3"
        >
          {shown.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {shown.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => preset(o)}
                  aria-pressed={active === o}
                  className="min-h-11 md:min-h-0 inline-flex items-center px-2.5 py-1 text-xs rounded-lg border border-[var(--sys-border)] text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
                >
                  {DATE_OPTION_LABELS[o]}
                </button>
              ))}
            </div>
          )}

          {withGrid && (
            <>
              <p className="text-xs text-[var(--sys-muted)]">{DATE_OPTION_LABELS.custom}</p>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setMonth(addMonths(month, -1))}
                  className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1.5 rounded-lg text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]"
                  aria-label="الشهر السابق"
                >
                  <RiArrowRightSLine className="icon-mirror w-4 h-4" />
                </button>
                <span className="text-xs font-bold text-[var(--sys-heading)]">
                  {format(month, 'MMMM yyyy', { locale: ar })}
                </span>
                <button
                  type="button"
                  onClick={() => setMonth(addMonths(month, 1))}
                  className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1.5 rounded-lg text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]"
                  aria-label="الشهر التالي"
                >
                  <RiArrowLeftSLine className="icon-mirror w-4 h-4" />
                </button>
              </div>

              {/* The seven columns are set inline as well as by class: when the
                  stylesheet has not caught up with a newly-used utility the grid
                  collapses into one column and the month becomes a long list. */}
              <div
                className="grid grid-cols-7 gap-0.5 text-center"
                style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}
              >
                {DAY_INITIALS.map((d) => (
                  <span key={d} className="text-xs text-[var(--sys-muted)] py-1">{d}</span>
                ))}
                {days.map((day) => {
                  const outside = day.getMonth() !== month.getMonth();
                  const isFrom = from && isSameDay(day, from);
                  const isTo = to && isSameDay(day, to);
                  const inside = from && to && isAfter(day, from) && isBefore(day, to);
                  const edge = isFrom || isTo;

                  return (
                    <button
                      key={day.toISOString()}
                      type="button"
                      onClick={() => pick(day)}
                      className={`h-11 md:h-8 text-xs tabular-nums rounded-lg transition-colors ${
                        edge
                          ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] font-bold'
                          : inside
                            ? 'bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]'
                            : outside
                              ? 'text-[var(--sys-border-strong)] hover:bg-[var(--sys-surface)]'
                              : 'text-[var(--sys-foreground)] hover:bg-[var(--sys-surface)]'
                      }`}
                    >
                      {format(day, 'd')}
                    </button>
                  );
                })}
              </div>

              {anchor && (
                <p className="text-xs text-[var(--sys-primary)]">اختر يوم النهاية…</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
