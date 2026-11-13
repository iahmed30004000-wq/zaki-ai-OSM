import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DOOR HANDS THE COURIER ITS SCORE.
 *
 * `couriers/score.ts` is guarded on its own arithmetic in
 * `a-courier-is-judged-on-what-it-finished`. What that cannot see is the
 * JOIN: an engine proved correct and a caller that never calls it ships a
 * screen with no score on it, and every test still passes. That exact hole
 * was found by mutation twice in this repository already — once on `Rows`
 * and its tracking screen, once here before this file existed.
 *
 * So what is asserted below is what the ROUTE does:
 *
 *   the counts it asks the database for, including the settled one the old
 *   shape never counted at all;
 *
 *   that `delivered` is handed over as LANDED and not added to anything —
 *   `whereDelivered()` is already DELIVERED + PARTIALLY_DELIVERED, so
 *   counting it twice would put the delivery rate over 100%;
 *
 *   that speed is read against the FASTEST courier in the shop, which is
 *   why the scoring happens after the fan-out and not inside it;
 *
 *   and that «may collection be scored at all» is answered once for the
 *   shop rather than per courier.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can } = vi.hoisted(() => ({
  db: { deliveryProvider: { findMany: vi.fn() }, order: { groupBy: vi.fn(), findMany: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a) }));

import { GET } from './route';

/** One courier's finished record, as the database would answer it. */
interface Record_ {
  assigned: number;
  shipped: number;
  landed: number;
  failed: number;
  returned: number;
  settled: number;
  /** Hours each sampled delivery took. Empty = no durations at all. */
  hours: number[];
  /** Of `returned`: how many are still «RETURN_REQUESTED» (the courier was asked to bring it back) — they count as returned too. */
  returnRequested?: number;
  /** Settled orders that did NOT land (a returned parcel the books closed): they are not the courier's collection. */
  settledNotLanded?: number;
}

const T0 = new Date('2026-09-01T00:00:00.000Z').getTime();

/**
 * A world of couriers. The door asks the database ONE grouped question — courier × shipping status × settlement status
 * (13/11: it used to start seven queries for each courier at once, which took the whole pool) — and reads every count from the
 * answer. The fake answers it from the `where` it was handed, not from call order, so a mutation that asks about another courier
 * reports nothing under this one's name. The fixtures must be CONSISTENT (shipped ≥ landed + failed + returned, assigned ≥ shipped):
 * a grouped answer cannot say a courier finished more than it shipped.
 */
function world(records: Record<string, Record_>) {
  db.deliveryProvider.findMany.mockResolvedValue(
    Object.keys(records).map((id) => ({ id, name: id, code: id, isActive: true }))
  );
  db.order.groupBy.mockImplementation(async ({ where }: any) => {
    const ids: string[] = where.deliveryProviderId.in;
    const out: { deliveryProviderId: string; shippingStatus: string; settlementStatus: string; _count: { _all: number } }[] = [];
    for (const id of ids) {
      const r = records[id];
      if (!r) continue;
      const add = (shippingStatus: string, settlementStatus: string, n: number) => {
        if (n > 0) out.push({ deliveryProviderId: id, shippingStatus, settlementStatus, _count: { _all: n } });
      };
      const unsettled = r.landed - r.settled;
      // A partial delivery is landed too (`whereDelivered()` is DELIVERED + PARTIALLY_DELIVERED).
      const partial = Math.min(2, unsettled);
      add('DELIVERED', 'SETTLED', r.settled);
      add('DELIVERED', 'PENDING', unsettled - partial);
      add('PARTIALLY_DELIVERED', 'PENDING', partial);
      add('FAILED_DELIVERY', 'PENDING', r.failed);
      const requested = Math.min(r.returnRequested ?? 0, r.returned);
      add('RETURNED', 'PENDING', r.returned - requested - (r.settledNotLanded ?? 0));
      add('RETURN_REQUESTED', 'PENDING', requested);
      add('RETURNED', 'SETTLED', r.settledNotLanded ?? 0);
      add('SHIPPED', 'PENDING', r.shipped - r.landed - r.failed - r.returned);
      add('NOT_READY', 'PENDING', r.assigned - r.shipped);
    }
    return out;
  });
  db.order.findMany.mockImplementation(async ({ where }: any) => {
    const r = records[where.deliveryProviderId];
    return (r?.hours ?? []).map((h) => ({ shippedAt: new Date(T0), deliveredAt: new Date(T0 + h * 3_600_000) }));
  });
}

const ask = () =>
  GET(new Request('http://localhost/api/orders/shipping/performance')).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

const of = (body: any, id: string) => body.providers.find((p: any) => p.provider.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', role: 'MANAGER' }, companyId: 'c1', storeId: 's1' });
  can.mockReturnValue(true);
});

describe('Ⅰ · the score reaches the screen', () => {
  it('a courier that finished enough parcels carries a number and its bands', async () => {
    // أرامكس as measured: 23 landed (19 + 4 partial), 0 failed, 3 returned,
    // 12 settled, and no real durations.
    world({ aramex: { assigned: 26, shipped: 26, landed: 23, failed: 0, returned: 3, settled: 12, hours: [] } });
    const { status, body } = await ask();
    expect(status).toBe(200);
    const a = of(body, 'aramex');
    expect(a.score, 'البابُ لا يُمرِّرُ سكوراً أصلاً').toBeTruthy();
    expect(a.score.total).toBe(74);
    expect(a.score.possible, 'السرعةُ غيرُ المقاسةِ بقيت في «من»').toBe(90);
    expect(a.score.bands.find((b: any) => b.key === 'delivery_rate').value).toBe(88);
    expect(a.whyNoScore).toBeNull();
  });

  it('and the settled count is really asked for — the old shape never did', async () => {
    world({ aramex: { assigned: 26, shipped: 26, landed: 23, failed: 0, returned: 3, settled: 12, hours: [] } });
    await ask();
    // The grouped question carries the settlement status: that is how the settled count reaches the score (it is one column of the one answer).
    const asked = db.order.groupBy.mock.calls.find((c) => (c[0]?.by ?? []).includes('settlementStatus'));
    expect(asked, 'لا أحدَ يَسألُ عن المسوّى، فبندُ التحصيلِ مبنيٌّ على لا شيء').toBeTruthy();
    expect(of((await ask()).body, 'aramex').metrics.settled).toBe(12);
  });

  it('and `delivered` is handed over as LANDED, not added to a partial count', async () => {
    /*
     * `whereDelivered()` is DELIVERED + PARTIALLY_DELIVERED already. Add a
     * second partial count to it and the delivery rate goes over 100 — a
     * number somebody has to debug on a live screen.
     */
    world({ aramex: { assigned: 26, shipped: 26, landed: 26, failed: 0, returned: 0, settled: 0, hours: [] } });
    const a = of((await ask()).body, 'aramex');
    expect(a.score.bands.find((b: any) => b.key === 'delivery_rate').value).toBe(100);
    expect(a.score.bands.find((b: any) => b.key === 'delivery_rate').value).toBeLessThanOrEqual(100);
  });

  it('and a courier with nothing reads a sentence rather than a zero', async () => {
    world({
      aramex: { assigned: 26, shipped: 26, landed: 23, failed: 0, returned: 3, settled: 12, hours: [] },
      basha: { assigned: 0, shipped: 0, landed: 0, failed: 0, returned: 0, settled: 0, hours: [] },
    });
    const { body } = await ask();
    expect(of(body, 'basha').score.total, 'صفرٌ يُرتِّبُ مَن لم يُجرَّبْ تحتَ مَن يَفشل').toBeNull();
    expect(of(body, 'basha').whyNoScore).toContain('لم يُسلَّم إليه');
  });
});

describe('Ⅱ · speed is read against the fastest in the same shop', () => {
  it('so it cannot be scored inside the per-courier fan-out', async () => {
    /*
     * Two couriers, one twice as slow. The fast one takes the band and the
     * slow one takes half — which is only possible once BOTH averages are
     * known, and is the whole reason the scoring happens after the fan-out.
     */
    world({
      fast: { assigned: 20, shipped: 20, landed: 20, failed: 0, returned: 0, settled: 0, hours: Array(20).fill(24) },
      slow: { assigned: 20, shipped: 20, landed: 20, failed: 0, returned: 0, settled: 0, hours: Array(20).fill(48) },
    });
    const { body } = await ask();
    const band = (id: string) => of(body, id).score.bands.find((b: any) => b.key === 'speed');
    expect(band('fast').points, 'الأسرعُ لم يَأخذِ البند').toBe(10);
    expect(band('slow').points, 'السرعةُ قُيِّمت بلا مرجعٍ من المتجر').toBe(5);
  });

  it('and a shop whose every delivery took no time at all scores speed for nobody', async () => {
    // THE MEASURED STATE of this database: every gap is zero or one second.
    world({ aramex: { assigned: 26, shipped: 26, landed: 23, failed: 0, returned: 3, settled: 12, hours: [] } });
    const { body } = await ask();
    expect(of(body, 'aramex').score.bands.find((b: any) => b.key === 'speed').points).toBeNull();
  });
});

describe('Ⅲ · «may collection be scored» is one answer for the shop', () => {
  it('and it is sent once, not per courier', async () => {
    /*
     * Two couriers, 30 of 40 settled across the shop — over the 50% bar
     * `trustOf` puts under every figure it lets through, so the band is
     * scored for both and the shop carries one verdict.
     */
    world({
      a: { assigned: 20, shipped: 20, landed: 20, failed: 0, returned: 0, settled: 20, hours: [] },
      b: { assigned: 20, shipped: 20, landed: 20, failed: 0, returned: 0, settled: 10, hours: [] },
    });
    const { body } = await ask();
    expect(body.collection, 'لا جوابَ على «هل يُقاسُ التحصيل»').toBeTruthy();
    expect(body.collection.level).not.toBe('WITHHELD');
    expect(of(body, 'b').score.bands.find((x: any) => x.key === 'collection_rate').points).toBe(10);
  });

  it('and a shop that has never settled anything says so', async () => {
    world({ a: { assigned: 20, shipped: 20, landed: 20, failed: 0, returned: 0, settled: 0, hours: [] } });
    const { body } = await ask();
    expect(body.collection.level).toBe('WITHHELD');
  });

  it('and a withheld verdict takes the band OUT of the score, not to zero', async () => {
    /*
     * THE INCONSISTENCY THIS CATCHES, and it was a real one: the route
     * returned the verdict and the screen printed «التحصيل خارج السكور …
     * يُحسب كل سكور من 80» while the engine went on scoring the band. Two
     * answers to one question, on the same row.
     *
     * Out of the score means out of the «من» too: the missing points name
     * themselves, where a zero would silently cost 20.
     *
     * TWO bands are missing on this fixture, not one — collection is
     * withheld and there are no durations either — so «من» is 70 and not
     * 80. Written out because getting it wrong is exactly what a screen
     * printing a hard-coded «من 80» would do.
     */
    world({ a: { assigned: 20, shipped: 20, landed: 20, failed: 0, returned: 0, settled: 0, hours: [] } });
    const { body } = await ask();
    const band = of(body, 'a').score.bands.find((x: any) => x.key === 'collection_rate');
    expect(band.points, 'التحصيلُ مَحجوبٌ وقد أُعطيَ صفراً — خصمٌ صامتٌ قدرُه 20').toBeNull();
    // delivery 35 + return 20 + failure 15 — collection and speed both out.
    expect(of(body, 'a').score.possible, 'بندٌ محجوبٌ بقيَ في «من»').toBe(70);
    expect(of(body, 'a').score.total).toBe(70);
  });

  it('and a shop just over the bar scores it', async () => {
    // 11 of 20 is 55% — over the 50% bar, so it is scored rather than
    // withheld. Named because the bar is where an off-by-one would live.
    world({ a: { assigned: 20, shipped: 20, landed: 20, failed: 0, returned: 0, settled: 11, hours: [] } });
    const { body } = await ask();
    expect(body.collection.level).not.toBe('WITHHELD');
    expect(of(body, 'a').score.bands.find((x: any) => x.key === 'collection_rate').points).toBe(11);
  });
});

describe('Ⅲ·ب · the grouped answer is read the way the six counts were', () => {
  it('a settled order that did NOT land is not this courier’s collection — settled is counted out of what landed only', async () => {
    world({ a: { assigned: 30, shipped: 30, landed: 20, failed: 0, returned: 10, settled: 8, settledNotLanded: 5, hours: [] } });
    const m = of((await ask()).body, 'a').metrics;
    expect(m.settled, 'a settled RETURNED order was added to the courier’s collection').toBe(8);
    expect(m.returned).toBe(10);
  });

  it('a parcel the courier was asked to bring back (RETURN_REQUESTED) is returned too', async () => {
    world({ a: { assigned: 30, shipped: 30, landed: 20, failed: 0, returned: 10, returnRequested: 4, settled: 0, hours: [] } });
    expect(of((await ask()).body, 'a').metrics.returned).toBe(10);
  });

  it('the one grouped question is asked of THIS company and THIS store, for the couriers it lists — and nothing else is counted one by one', async () => {
    world({ a: { assigned: 20, shipped: 20, landed: 20, failed: 0, returned: 0, settled: 0, hours: [] }, b: { assigned: 5, shipped: 5, landed: 5, failed: 0, returned: 0, settled: 0, hours: [] } });
    await ask();
    expect(db.order.groupBy).toHaveBeenCalledTimes(1);
    const where = db.order.groupBy.mock.calls[0][0].where;
    expect(where).toMatchObject({ companyId: 'c1', storeId: 's1', deliveryProviderId: { in: ['a', 'b'] } });
    expect(db.order.groupBy.mock.calls[0][0].by).toEqual(['deliveryProviderId', 'shippingStatus', 'settlementStatus']);
  });
});

describe('Ⅳ · the raw counts stay beside the score', () => {
  it('because a number nobody can check is a number nobody believes', async () => {
    // 22 landed + 1 failed + 3 returned = the 26 it shipped (a grouped answer cannot say a courier finished more than it shipped).
    world({ aramex: { assigned: 26, shipped: 26, landed: 22, failed: 1, returned: 3, settled: 12, hours: [] } });
    const m = of((await ask()).body, 'aramex').metrics;
    for (const key of ['assigned', 'shipped', 'delivered', 'failed', 'returned', 'settled']) {
      expect(m, `«${key}» اختفى من الأرقام الخام`).toHaveProperty(key);
    }
    expect(m.assigned).toBe(26);
    expect(m.returned).toBe(3);
    // every count is exactly what the one grouped answer says (the old shape asked for each count apart)
    expect(m).toMatchObject({ assigned: 26, shipped: 26, delivered: 22, failed: 1, returned: 3, settled: 12 });
  });
});
