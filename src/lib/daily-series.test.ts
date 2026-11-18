import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DAYS OF THE ORDERS CHART ARE THE STORE'S DAYS, AND A QUIET DAY IS DRAWN AS QUIET (plan 17/11, R9 — `lib/daily-series.ts`).
 *
 * What is held: (1) a span is two real days in order, never longer than 92 — refused, not shortened; (2) the days are cut in the
 * STORE's clock, so an order at 22:30 UTC in Damascus belongs to the next morning; (3) each event is counted on the day it HAPPENED;
 * (4) a day with nothing is a row of zeros and is still there; (5) the counts never include a replaced order and the delivered count
 * reads the shared «delivered» definition; (6) a read that hit its row ceiling says so; (7) no figure of money is read.
 */

const { db } = vi.hoisted(() => ({ db: { order: { findMany: vi.fn() } } }));
vi.mock('@/lib/db', () => ({ db }));

import { MAX_SERIES_DAYS, dailySeries, seriesSpan } from './daily-series';
import { DELIVERED_SHIPPING } from './order-state';

const TZ = 'Asia/Damascus'; // UTC+3 all year since 2022

describe('seriesSpan — which spans are answered', () => {
  it('two real days in order: every day between them, both ends included', () => {
    const s = seriesSpan('2026-11-01', '2026-11-03', TZ);
    expect(s.ok && s.days).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });

  it('one day is a span of one', () => {
    const s = seriesSpan('2026-11-17', '2026-11-17', TZ);
    expect(s.ok && s.days).toEqual(['2026-11-17']);
  });

  it('NEGATIVE: a missing end, a day that does not exist, a backwards span and plain words are refused as invalid', () => {
    for (const [a, b] of [['2026-11-01', null], [null, '2026-11-03'], ['2026-13-40', '2026-11-03'], ['2026-11-05', '2026-11-01'], ['اليوم', 'غدا']] as const) {
      expect(seriesSpan(a, b, TZ), `${a} → ${b}`).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('NEGATIVE: 93 days is refused as too long, not shortened to 92; 92 days is answered', () => {
    expect(MAX_SERIES_DAYS).toBe(92);
    expect(seriesSpan('2026-01-01', '2026-04-03', TZ)).toEqual({ ok: false, reason: 'too-long' }); // 93 days
    const ok = seriesSpan('2026-01-01', '2026-04-02', TZ); // 92 days
    expect(ok.ok && ok.days).toHaveLength(92);
  });

  it('the window is the store’s days: Damascus’s 1 November starts at 21:00 UTC on 31 October', () => {
    const s = seriesSpan('2026-11-01', '2026-11-01', TZ);
    expect(s.ok && s.window.start.toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(s.ok && s.window.end.toISOString()).toBe('2026-11-01T21:00:00.000Z');
  });
});

describe('dailySeries — what is counted on which day', () => {
  const span = () => {
    const s = seriesSpan('2026-11-01', '2026-11-03', TZ);
    if (!s.ok) throw new Error('span');
    return s;
  };

  beforeEach(() => {
    db.order.findMany.mockReset();
  });

  /** The three reads come back in the order the function asks them: created, confirmed, delivered. */
  const reads = (created: Date[], confirmed: Date[], delivered: Date[]) => {
    db.order.findMany
      .mockResolvedValueOnce(created.map((createdAt) => ({ createdAt })))
      .mockResolvedValueOnce(confirmed.map((confirmedAt) => ({ confirmedAt })))
      .mockResolvedValueOnce(delivered.map((deliveredAt) => ({ deliveredAt })));
  };

  it('each event lands on the store’s day it happened, and the totals are the sum of the days', async () => {
    reads(
      // 22:30 UTC on 1 Nov is 01:30 on 2 Nov in Damascus.
      [new Date('2026-11-01T10:00:00Z'), new Date('2026-11-01T22:30:00Z'), new Date('2026-11-02T08:00:00Z')],
      [new Date('2026-11-02T09:00:00Z')],
      [new Date('2026-11-03T09:00:00Z'), new Date('2026-11-03T10:00:00Z')],
    );
    const out = await dailySeries({ companyId: 'c1', storeId: 's1' }, span(), TZ);
    expect(out.days).toEqual([
      { day: '2026-11-01', created: 1, confirmed: 0, delivered: 0 },
      { day: '2026-11-02', created: 2, confirmed: 1, delivered: 0 },
      { day: '2026-11-03', created: 0, confirmed: 0, delivered: 2 },
    ]);
    expect(out.totals).toEqual({ created: 3, confirmed: 1, delivered: 2 });
    expect(out.truncated).toBe(false);
  });

  it('a quiet day is a row of zeros and is not skipped; no orders at all is every day at zero', async () => {
    reads([], [], []);
    const out = await dailySeries({ companyId: 'c1', storeId: 's1' }, span(), TZ);
    expect(out.days.map((d) => d.day)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(out.days.every((d) => d.created === 0 && d.confirmed === 0 && d.delivered === 0)).toBe(true);
    expect(out.totals).toEqual({ created: 0, confirmed: 0, delivered: 0 });
  });

  it('the three reads are scoped to this company and store, exclude a replaced order, and read the shared delivered definition', async () => {
    reads([], [], []);
    await dailySeries({ companyId: 'c1', storeId: 's1' }, span(), TZ);
    expect(db.order.findMany).toHaveBeenCalledTimes(3);
    const [created, confirmed, delivered] = db.order.findMany.mock.calls.map((c) => c[0].where);
    for (const where of [created, confirmed, delivered]) {
      expect(where.companyId).toBe('c1');
      expect(where.storeId).toBe('s1');
      expect(where.NOT, 'a replaced order is not a second sale').toBeDefined();
    }
    expect(created.createdAt).toBeDefined();
    expect(confirmed.confirmedAt).toBeDefined();
    expect(delivered.deliveredAt).toBeDefined();
    expect(delivered.shippingStatus).toEqual({ in: [...DELIVERED_SHIPPING] });
  });

  it('NEGATIVE: no amount is read — every read selects one timestamp and nothing else', async () => {
    reads([], [], []);
    await dailySeries({ companyId: 'c1', storeId: 's1' }, span(), TZ);
    const selects = db.order.findMany.mock.calls.map((c) => Object.keys(c[0].select));
    expect(selects).toEqual([['createdAt'], ['confirmedAt'], ['deliveredAt']]);
  });

  it('a read that reached its row ceiling is said so — the counts are then a floor', async () => {
    db.order.findMany
      .mockResolvedValueOnce(Array.from({ length: 60_000 }, () => ({ createdAt: new Date('2026-11-02T10:00:00Z') })))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const out = await dailySeries({ companyId: 'c1', storeId: 's1' }, span(), TZ);
    expect(out.truncated).toBe(true);
  });
});
