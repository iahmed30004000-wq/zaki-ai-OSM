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
  db: { deliveryProvider: { findMany: vi.fn() }, order: { count: vi.fn(), findMany: vi.fn() } },
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
}

const T0 = new Date('2026-09-01T00:00:00.000Z').getTime();

/**
 * A world of couriers. `order.count` is answered by reading the `where` it
 * was handed — not by call order, because a fake that counts calls passes a
 * mutation that reorders the queries and then reports another courier's
 * numbers under this one's name.
 */
function world(records: Record<string, Record_>) {
  db.deliveryProvider.findMany.mockResolvedValue(
    Object.keys(records).map((id) => ({ id, name: id, code: id, isActive: true }))
  );
  db.order.count.mockImplementation(async ({ where }: any) => {
    const r = records[where.deliveryProviderId];
    if (!r) return 0;
    const st = where.shippingStatus;
    if (where.settlementStatus === 'SETTLED') return r.settled;
    if (!st) return r.assigned;
    const list: string[] = typeof st === 'string' ? [st] : (st.in ?? []);
    if (list.includes('PARTIALLY_DELIVERED') && list.includes('DELIVERED')) return r.landed;
    if (list.includes('FAILED_DELIVERY')) return r.failed;
    if (list.includes('RETURNED')) return r.returned;
    return r.shipped;
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
    const settledQuery = db.order.count.mock.calls.find((c) => c[0]?.where?.settlementStatus === 'SETTLED');
    expect(settledQuery, 'لا أحدَ يَسألُ عن المسوّى، فبندُ التحصيلِ مبنيٌّ على لا شيء').toBeTruthy();
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

describe('Ⅳ · the raw counts stay beside the score', () => {
  it('because a number nobody can check is a number nobody believes', async () => {
    world({ aramex: { assigned: 26, shipped: 26, landed: 23, failed: 1, returned: 3, settled: 12, hours: [] } });
    const m = of((await ask()).body, 'aramex').metrics;
    for (const key of ['assigned', 'shipped', 'delivered', 'failed', 'returned', 'settled']) {
      expect(m, `«${key}» اختفى من الأرقام الخام`).toHaveProperty(key);
    }
    expect(m.assigned).toBe(26);
    expect(m.returned).toBe(3);
  });
});
