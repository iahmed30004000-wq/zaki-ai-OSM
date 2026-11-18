import { describe, expect, it, vi } from 'vitest';
import {
  REPORT_RANGE_KEY,
  isReportRange,
  rangeFromSearch,
  readReportRange,
  readStoredRange,
  searchWithRange,
  todayKey,
  writeReportRange,
  type StorageGetter,
} from './report-range';

/**
 * ONE SPAN OF DAYS FOR THE FOUR REPORT TABS (R14, decision 4): the address wins over the stored key, the key over today; a
 * storage that throws is «today» and never a crash; a broken value is never read back as a range.
 */

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const store = {
    getItem: vi.fn((k: string) => (map.has(k) ? map.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => void map.set(k, v)),
    removeItem: vi.fn((k: string) => void map.delete(k)),
  };
  return { store, map, get: (() => store) as StorageGetter };
}
const THROWS: StorageGetter = () => {
  throw new Error('blocked');
};
const NOW = new Date(2026, 10, 18, 12, 0, 0);
const NOV = { from: '2026-11-01', to: '2026-11-10' };

describe('isReportRange', () => {
  it('takes two real days in order', () => {
    expect(isReportRange(NOV)).toBe(true);
    expect(isReportRange({ from: '2026-11-05', to: '2026-11-05' })).toBe(true);
  });
  it('NEGATIVE: not after, not a fake day, not a half, not junk', () => {
    expect(isReportRange({ from: '2026-11-10', to: '2026-11-01' })).toBe(false);
    expect(isReportRange({ from: '2026-02-30', to: '2026-03-01' })).toBe(false);
    expect(isReportRange({ from: '2026-11-01', to: '' })).toBe(false);
    expect(isReportRange({ from: '1/11/2026', to: '2026-11-10' })).toBe(false);
    expect(isReportRange(null)).toBe(false);
    expect(isReportRange('2026-11-01')).toBe(false);
  });
});

describe('readReportRange — the address, then the key, then today', () => {
  it('the address wins over a stored range', () => {
    const m = memory({ [REPORT_RANGE_KEY]: JSON.stringify(NOV) });
    expect(readReportRange('?tab=x&from=2026-10-01&to=2026-10-31', m.get, NOW)).toEqual({
      range: { from: '2026-10-01', to: '2026-10-31' },
      source: 'url',
    });
  });

  it('the stored range wins over today', () => {
    const m = memory({ [REPORT_RANGE_KEY]: JSON.stringify(NOV) });
    expect(readReportRange('', m.get, NOW)).toEqual({ range: NOV, source: 'storage' });
  });

  it('nothing anywhere → today, and says so', () => {
    expect(readReportRange('', memory().get, NOW)).toEqual({ range: { from: '2026-11-18', to: '2026-11-18' }, source: 'today' });
  });

  it('NEGATIVE: a broken address is not a range — the stored one is used', () => {
    const m = memory({ [REPORT_RANGE_KEY]: JSON.stringify(NOV) });
    expect(readReportRange('?from=2026-10-31&to=2026-10-01', m.get, NOW).source).toBe('storage');
    expect(readReportRange('?from=2026-10-01', m.get, NOW).source).toBe('storage');
  });

  it('NEGATIVE: a storage that throws on access is today, not a crash', () => {
    expect(() => readReportRange('', THROWS, NOW)).not.toThrow();
    expect(readReportRange('', THROWS, NOW).source).toBe('today');
  });

  it('NEGATIVE: getItem throwing, a broken value or a half range is today', () => {
    const bad = { getItem: () => { throw new Error('no'); }, setItem: vi.fn(), removeItem: vi.fn() };
    expect(readReportRange('', () => bad, NOW).source).toBe('today');
    expect(readReportRange('', memory({ [REPORT_RANGE_KEY]: '{not json' }).get, NOW).source).toBe('today');
    expect(readReportRange('', memory({ [REPORT_RANGE_KEY]: JSON.stringify({ from: '2026-11-01' }) }).get, NOW).source).toBe('today');
  });

  it('the stored value is read back as just the two days, nothing else it might carry', () => {
    const m = memory({ [REPORT_RANGE_KEY]: JSON.stringify({ ...NOV, extra: 1 }) });
    expect(readStoredRange(m.get)).toEqual(NOV);
  });
});

describe('writeReportRange — written on every change', () => {
  it('stores a range under the one key, and the next reader gets it', () => {
    const m = memory();
    expect(writeReportRange(NOV, m.get)).toBe(true);
    expect(m.store.setItem).toHaveBeenCalledWith(REPORT_RANGE_KEY, JSON.stringify(NOV));
    expect(readReportRange('', m.get, NOW)).toEqual({ range: NOV, source: 'storage' });
  });

  it('NEGATIVE: null or a broken range REMOVES the key — the next tab opens on today, not on a span already left', () => {
    const m = memory({ [REPORT_RANGE_KEY]: JSON.stringify(NOV) });
    writeReportRange(null, m.get);
    expect(m.map.has(REPORT_RANGE_KEY)).toBe(false);
    m.map.set(REPORT_RANGE_KEY, JSON.stringify(NOV));
    writeReportRange({ from: '2026-11-10', to: '2026-11-01' }, m.get);
    expect(m.map.has(REPORT_RANGE_KEY)).toBe(false);
    expect(m.store.setItem).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a refused storage answers false and does not throw', () => {
    expect(writeReportRange(NOV, THROWS)).toBe(false);
    const full = { getItem: vi.fn(), setItem: () => { throw new Error('quota'); }, removeItem: vi.fn() };
    expect(writeReportRange(NOV, () => full)).toBe(false);
    expect(writeReportRange(NOV, () => null)).toBe(false);
  });
});

describe('the address and today', () => {
  it('rangeFromSearch reads from/to and nothing else', () => {
    expect(rangeFromSearch('?from=2026-11-01&to=2026-11-10')).toEqual(NOV);
    expect(rangeFromSearch('?startDate=2026-11-01&endDate=2026-11-10')).toBeNull();
  });

  it('searchWithRange keeps the other parameters, sets or removes the two days', () => {
    expect(searchWithRange('?tab=noanswer&from=2026-10-01&to=2026-10-02', NOV)).toBe('?tab=noanswer&from=2026-11-01&to=2026-11-10');
    expect(searchWithRange('?tab=noanswer&from=2026-10-01&to=2026-10-02', null)).toBe('?tab=noanswer');
    expect(searchWithRange('?from=2026-10-01&to=2026-10-02', null)).toBe('');
  });

  it('todayKey is the store’s day when a zone is given, the browser’s otherwise', () => {
    const lateUtc = new Date(Date.UTC(2026, 10, 18, 22, 30));
    expect(todayKey(lateUtc, 'Asia/Amman')).toBe('2026-11-19');
    expect(todayKey(lateUtc, 'UTC')).toBe('2026-11-18');
    expect(todayKey(NOW)).toBe('2026-11-18');
    // NEGATIVE: an unknown zone is not a crash.
    expect(todayKey(NOW, 'Not/AZone')).toBe('2026-11-18');
  });
});
