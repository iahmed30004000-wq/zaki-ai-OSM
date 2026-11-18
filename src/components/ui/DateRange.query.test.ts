import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ALL_OPTIONS,
  FIVE_OPTIONS,
  WINDOW_LIMITS,
  dayKeyIn,
  initialRange,
  isRealDay,
  overLimit,
  periodOf,
  presetRange,
  spanDays,
  todayRange,
  toQuery,
  validRange,
  type DateOption,
  type Range,
} from './DateRange';

/**
 * DEFINITION OF DONE — the date box's arithmetic and its query strings (R2c, plan 17/11).
 * What must work: the five options (and the six every screen has always had) are ranges of the STORE's days; `toQuery` turns a range into
 * the shape each family of doors reads — `startDate=&endDate=`, `from=&to=`, `period=` — and says «no window» when the pair is not real.
 * The limits some doors put on a span are exported as data and pinned to the doors' own source. Edge cases: month, year and leap-day
 * boundaries; the evening hours in which the store's day and the UTC day differ; the nights the clock changes.
 * Blockers: no money, no door changed — a range is two days the screens already sent.
 */

const utc = (y: number, m: number, d: number, h = 12, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min));

describe('the options', () => {
  it('the six every screen has always had are the default; the plan`s five are the same without «هذا الشهر»', () => {
    expect(ALL_OPTIONS).toEqual(['today', 'yesterday', '7d', '30d', 'month', 'custom']);
    expect(FIVE_OPTIONS).toEqual(['today', 'yesterday', '7d', '30d', 'custom']);
  });
});

describe('dayKeyIn — the day a moment fell on, in the store`s own clock', () => {
  const rows: [string, Date, string | undefined, string][] = [
    ['Amman, late evening: the UTC day is still yesterday', utc(2026, 11, 17, 21, 30), 'Asia/Amman', '2026-11-18'],
    ['Amman, early morning: both agree', utc(2026, 11, 18, 5, 0), 'Asia/Amman', '2026-11-18'],
    ['UTC', utc(2026, 11, 17, 21, 30), 'UTC', '2026-11-17'],
    ['far east, the day is already tomorrow', utc(2026, 11, 17, 12, 0), 'Pacific/Kiritimati', '2026-11-18'],
    ['New York, spring forward: the last minute of the 8th', utc(2026, 3, 9, 3, 59), 'America/New_York', '2026-03-08'],
    ['New York, spring forward: the first minute of the 9th', utc(2026, 3, 9, 4, 0), 'America/New_York', '2026-03-09'],
    ['New York, fall back: the last minute of the 1st (a 25-hour day)', utc(2026, 11, 2, 4, 59), 'America/New_York', '2026-11-01'],
    ['New York, fall back: the first minute of the 2nd', utc(2026, 11, 2, 5, 0), 'America/New_York', '2026-11-02'],
    ['year end in the store, not in UTC', utc(2026, 12, 31, 22, 30), 'Asia/Amman', '2027-01-01'],
  ];
  it.each(rows)('%s', (_why, at, tz, want) => {
    expect(dayKeyIn(at, tz)).toBe(want);
  });

  it('an unknown time zone falls back to the browser`s day instead of throwing', () => {
    expect(() => dayKeyIn(utc(2026, 11, 18), 'Not/AZone')).not.toThrow();
    expect(dayKeyIn(utc(2026, 11, 18), 'Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('presetRange', () => {
  const rows: [string, DateOption, Date, string, Range][] = [
    ['today', 'today', utc(2026, 11, 18), 'UTC', { from: '2026-11-18', to: '2026-11-18' }],
    ['yesterday', 'yesterday', utc(2026, 11, 18), 'UTC', { from: '2026-11-17', to: '2026-11-17' }],
    ['yesterday over a month boundary', 'yesterday', utc(2026, 3, 1), 'UTC', { from: '2026-02-28', to: '2026-02-28' }],
    ['yesterday over a year boundary', 'yesterday', utc(2026, 1, 1), 'UTC', { from: '2025-12-31', to: '2025-12-31' }],
    ['yesterday over a leap day', 'yesterday', utc(2028, 3, 1), 'UTC', { from: '2028-02-29', to: '2028-02-29' }],
    ['7 days is seven days: today and the six before', '7d', utc(2026, 11, 18), 'UTC', { from: '2026-11-12', to: '2026-11-18' }],
    ['7 days over a month boundary', '7d', utc(2026, 3, 3), 'UTC', { from: '2026-02-25', to: '2026-03-03' }],
    ['7 days over a year boundary', '7d', utc(2026, 1, 3), 'UTC', { from: '2025-12-28', to: '2026-01-03' }],
    ['30 days is thirty days: today and the 29 before', '30d', utc(2026, 11, 18), 'UTC', { from: '2026-10-20', to: '2026-11-18' }],
    ['30 days over a year boundary', '30d', utc(2026, 1, 10), 'UTC', { from: '2025-12-12', to: '2026-01-10' }],
    ['30 days across a leap February', '30d', utc(2028, 3, 1), 'UTC', { from: '2028-02-01', to: '2028-03-01' }],
    ['this month runs from the 1st to today', 'month', utc(2026, 11, 18), 'UTC', { from: '2026-11-01', to: '2026-11-18' }],
    ['this month on the 1st is one day', 'month', utc(2026, 12, 1), 'UTC', { from: '2026-12-01', to: '2026-12-01' }],
    ['this month on the last day of the year', 'month', utc(2026, 12, 31), 'UTC', { from: '2026-12-01', to: '2026-12-31' }],
    ['the store`s «today» in the evening hours', 'today', utc(2026, 11, 17, 21, 30), 'Asia/Amman', { from: '2026-11-18', to: '2026-11-18' }],
    ['the store`s «yesterday» in the evening hours', 'yesterday', utc(2026, 11, 17, 21, 30), 'Asia/Amman', { from: '2026-11-17', to: '2026-11-17' }],
    ['the store`s «month» when its month has begun and the UTC one has not', 'month', utc(2026, 11, 30, 22, 0), 'Asia/Amman', { from: '2026-12-01', to: '2026-12-01' }],
    ['7 days across the night the clock goes back', '7d', utc(2026, 11, 3, 12), 'America/New_York', { from: '2026-10-28', to: '2026-11-03' }],
    ['7 days across the night the clock goes forward', '7d', utc(2026, 3, 10, 12), 'America/New_York', { from: '2026-03-04', to: '2026-03-10' }],
  ];
  it.each(rows)('%s', (_why, option, now, tz, want) => {
    expect(presetRange(option, now, tz)).toEqual(want);
  });

  it('«تاريخ محدد» is a pair the person picks, never a ready range', () => {
    expect(presetRange('custom', utc(2026, 11, 18), 'UTC')).toBeNull();
  });

  it('todayRange and initialRange are the same today, and default to it', () => {
    const now = utc(2026, 11, 18);
    expect(todayRange(now, 'UTC')).toEqual({ from: '2026-11-18', to: '2026-11-18' });
    expect(initialRange(undefined, now, 'UTC')).toEqual(todayRange(now, 'UTC'));
    expect(initialRange('yesterday', now, 'UTC')).toEqual({ from: '2026-11-17', to: '2026-11-17' });
    expect(initialRange('30d', now, 'UTC')).toEqual(presetRange('30d', now, 'UTC'));
  });

  it('without a time zone it is the browser`s day, as it always was', () => {
    const at = new Date(2026, 10, 18, 23, 30); // 18 Nov, late evening, on this machine
    expect(todayRange(at)).toEqual({ from: '2026-11-18', to: '2026-11-18' });
  });
});

describe('isRealDay / validRange / spanDays', () => {
  it.each([
    ['2026-11-18', true],
    ['2028-02-29', true],
    ['2026-02-29', false],
    ['2026-13-01', false],
    ['2026-02-30', false],
    ['2026-1-5', false],
    ['', false],
    ['2026-11-18T00:00:00Z', false],
  ])('isRealDay(%j) = %s', (day, want) => {
    expect(isRealDay(day)).toBe(want);
  });

  const pairs: [string, Range, boolean, number | null][] = [
    ['one day', { from: '2026-11-18', to: '2026-11-18' }, true, 1],
    ['a week', { from: '2026-11-12', to: '2026-11-18' }, true, 7],
    ['over a leap day', { from: '2028-02-28', to: '2028-03-01' }, true, 3],
    ['over a year', { from: '2025-12-31', to: '2026-01-01' }, true, 2],
    ['a whole year', { from: '2026-01-01', to: '2026-12-31' }, true, 365],
    ['backwards', { from: '2026-11-18', to: '2026-11-17' }, false, null],
    ['empty', { from: '', to: '' }, false, null],
    ['only a start', { from: '2026-11-18', to: '' }, false, null],
    ['a day that does not exist', { from: '2026-02-30', to: '2026-03-02' }, false, null],
  ];
  it.each(pairs)('%s', (_why, range, valid, days) => {
    expect(validRange(range)).toBe(valid);
    expect(spanDays(range)).toBe(days);
  });
});

describe('periodOf — a name only when the two mean the SAME days', () => {
  const now = utc(2026, 11, 18);
  it.each([
    ['today', 'today'],
    ['yesterday', 'yesterday'],
    ['month', 'month'],
    ['7d', null],
    ['30d', null],
  ] as const)('%s → %s', (option, want) => {
    expect(periodOf(presetRange(option, now, 'UTC')!, now, 'UTC')).toBe(want);
  });

  it('a picked pair that happens to be today is «today»; any other pair has no name', () => {
    expect(periodOf({ from: '2026-11-18', to: '2026-11-18' }, now, 'UTC')).toBe('today');
    expect(periodOf({ from: '2026-11-10', to: '2026-11-18' }, now, 'UTC')).toBeNull();
    expect(periodOf({ from: '', to: '' }, now, 'UTC')).toBeNull();
  });

  it('the door`s own 7d and 30d are longer than the box`s — which is why they travel as days (analytics.ts)', () => {
    const src = readFileSync('src/lib/analytics.ts', 'utf8');
    expect(src).toMatch(/d7\.setDate\(d7\.getDate\(\) - 7\)/);
    expect(src).toMatch(/d30\.setDate\(d30\.getDate\(\) - 30\)/);
    expect(spanDays(presetRange('7d', now, 'UTC')!)).toBe(7);
    expect(spanDays(presetRange('30d', now, 'UTC')!)).toBe(30);
  });
});

describe('toQuery', () => {
  const now = utc(2026, 11, 18);
  const week: Range = { from: '2026-11-12', to: '2026-11-18' };
  const rows: [string, Range, Parameters<typeof toQuery>[1], string][] = [
    ['startEnd: a span', week, 'startEnd', 'startDate=2026-11-12&endDate=2026-11-18'],
    ['startEnd is the default form', week, undefined, 'startDate=2026-11-12&endDate=2026-11-18'],
    ['fromTo: a span', week, 'fromTo', 'from=2026-11-12&to=2026-11-18'],
    ['fromTo: one day', { from: '2026-11-18', to: '2026-11-18' }, 'fromTo', 'from=2026-11-18&to=2026-11-18'],
    ['fromTo over a year end', { from: '2025-12-31', to: '2026-01-01' }, 'fromTo', 'from=2025-12-31&to=2026-01-01'],
    ['fromTo over a leap day', { from: '2028-02-28', to: '2028-03-01' }, 'fromTo', 'from=2028-02-28&to=2028-03-01'],
    ['period: today is a name', { from: '2026-11-18', to: '2026-11-18' }, 'period', 'period=today'],
    ['period: yesterday is a name', { from: '2026-11-17', to: '2026-11-17' }, 'period', 'period=yesterday'],
    ['period: this month is a name', { from: '2026-11-01', to: '2026-11-18' }, 'period', 'period=month'],
    ['period: seven days is NOT a name (the door`s is eight days) — it is the days', week, 'period', 'startDate=2026-11-12&endDate=2026-11-18'],
    ['period: thirty days is NOT a name', { from: '2026-10-20', to: '2026-11-18' }, 'period', 'startDate=2026-10-20&endDate=2026-11-18'],
    ['period: last month is not «30 days» and not this month', { from: '2026-10-01', to: '2026-10-31' }, 'period', 'startDate=2026-10-01&endDate=2026-10-31'],
    ['an empty range is no window', { from: '', to: '' }, 'startEnd', ''],
    ['an empty range is no window (fromTo)', { from: '', to: '' }, 'fromTo', ''],
    ['an empty range is no window (period)', { from: '', to: '' }, 'period', ''],
    ['half a pair is not sent half-way', { from: '2026-11-18', to: '' }, 'fromTo', ''],
    ['a pair running backwards is not sent', { from: '2026-11-18', to: '2026-11-01' }, 'startEnd', ''],
    ['a day that does not exist is not sent', { from: '2026-02-30', to: '2026-03-02' }, 'fromTo', ''],
  ];
  it.each(rows)('%s', (_why, range, form, want) => {
    expect(toQuery(range, form, { now, timeZone: 'UTC' })).toBe(want);
  });

  it('says what the screen says today for «no window» — `empty` is the caller`s word', () => {
    const none: Range = { from: '', to: '' };
    expect(toQuery(none, 'startEnd', { empty: 'period=all' })).toBe('period=all');
    expect(toQuery(none, 'period', { empty: 'period=today' })).toBe('period=today');
    expect(toQuery(none, 'fromTo', { empty: '' })).toBe('');
  });

  it('the name of a period follows the STORE`s day, not the UTC one', () => {
    const evening = utc(2026, 11, 17, 21, 30); // 18 Nov in Amman
    const amman = { from: '2026-11-18', to: '2026-11-18' };
    expect(toQuery(amman, 'period', { now: evening, timeZone: 'Asia/Amman' })).toBe('period=today');
    expect(toQuery(amman, 'period', { now: evening, timeZone: 'UTC' })).toBe('startDate=2026-11-18&endDate=2026-11-18');
  });

  it('is the shape the five screens send today (so adopting it changes no request)', () => {
    const r: Range = { from: '2026-11-01', to: '2026-11-18' };
    // PerformanceScreen / CampaignsScreen
    expect(toQuery(r, 'startEnd')).toBe(`startDate=${r.from}&endDate=${r.to}`);
    // FinanceProfitScreen (`?from=&to=` once the caller adds the «?») / OrdersScreen / AuditScreen
    expect(`?${toQuery(r, 'fromTo')}`).toBe(`?from=${r.from}&to=${r.to}`);
  });
});

describe('the limits the doors put on a span, as data', () => {
  it('are pinned to the doors` own source: 90 days clamped in analytics, 92 refused in the daily series', () => {
    const analytics = readFileSync('src/lib/analytics.ts', 'utf8');
    const series = readFileSync('src/lib/daily-series.ts', 'utf8');
    expect(analytics).toMatch(new RegExp(`const MAX_WINDOW_DAYS = ${WINDOW_LIMITS.analytics.days};`));
    expect(series).toMatch(new RegExp(`export const MAX_SERIES_DAYS = ${WINDOW_LIMITS.dailySeries.days};`));
    // …and what each does with a longer span is what the data says.
    expect(analytics).toMatch(/start = clampStart\(start\)/);
    expect(series).toMatch(/reason: 'too-long'/);
    expect(WINDOW_LIMITS.analytics.over).toBe('clamped');
    expect(WINDOW_LIMITS.dailySeries.over).toBe('refused');
  });

  it('overLimit is true only past the limit, counting both ends', () => {
    const from = '2026-01-01';
    const to = (n: number) => {
      const d = new Date(Date.UTC(2026, 0, n));
      return d.toISOString().slice(0, 10);
    };
    for (const lim of [WINDOW_LIMITS.analytics, WINDOW_LIMITS.dailySeries]) {
      expect(overLimit({ from, to: to(lim.days) }, lim), `${lim.days} days`).toBe(false);
      expect(overLimit({ from, to: to(lim.days + 1) }, lim), `${lim.days + 1} days`).toBe(true);
    }
    expect(overLimit({ from: '', to: '' }, WINDOW_LIMITS.dailySeries)).toBe(false);
  });

  it('«آخر 30 يوم» is thirty days and is not «الشهر الماضي»: no preset is a calendar month but «هذا الشهر»', () => {
    const now = utc(2026, 11, 18);
    expect(presetRange('30d', now, 'UTC')).not.toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('30d', now, 'UTC')).not.toEqual(presetRange('month', now, 'UTC'));
    expect(ALL_OPTIONS.some((o) => (o as string) === 'last_month')).toBe(false);
  });
});

describe('the file itself', () => {
  const CODE = readFileSync('src/components/ui/DateRange.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  it('never makes a local day from `toISOString().slice(0, 10)`', () => {
    expect(CODE).not.toMatch(/toISOString\(\)\s*\.slice\(/);
  });
  it('and never adds 24 hours of milliseconds to a calendar day', () => {
    expect(CODE).not.toMatch(/getTime\(\)\s*\+\s*i\s*\*/);
  });
});
