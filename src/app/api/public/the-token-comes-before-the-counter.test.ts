import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ط4 — THE TOKEN IS CHECKED BEFORE THE ORDER'S COUNTER.
 *
 * Both add-on doors counted attempts per ORDER NUMBER, before looking at the token. The order number is the one thing a
 * stranger can know, so a handful of requests with no token at all spent the real customer's allowance and the
 * customer was told «محاولات كثيرة» about their own order. The token now answers first (401, counting nothing against
 * the order), the order's counter is keyed on the order the token PROVES, and a coarse counter per address stands in
 * front — only for an address we can tell apart.
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: 30 requests per address per ten minutes, the order's own limits
 * (5 and 3 in thirty minutes) unchanged.
 */

const { db, addPostOrderOffer } = vi.hoisted(() => ({
  db: { order: { findFirst: vi.fn(async () => null) }, landingPageRecommendation: { findFirst: vi.fn() }, $transaction: vi.fn() },
  addPostOrderOffer: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
// A token is «valid-<orderId>-<padding>»: anything else is a stranger's guess.
vi.mock('@/lib/landing-pages', () => ({
  verifyAddonToken: async (t: string) => {
    const m = /^valid-([a-z0-9]+)-/.exec(t);
    return m ? { orderId: m[1], orderNumber: 'ORD-2026-0001' } : null;
  },
}));
vi.mock('@/lib/post-order-offer', async (orig) => ({
  ...(await orig<typeof import('@/lib/post-order-offer')>()),
  addPostOrderOffer: (...a: unknown[]) => addPostOrderOffer(...a),
  postOrderOfferSettings: async () => ({ windowMinutes: 15 }),
}));

import { POST as addProduct } from './landing-pages/[slug]/orders/[orderNumber]/add-product/route';
import { POST as postOrderOffer } from './orders/[orderNumber]/post-order-offer/route';

const NUMBER = 'ORD-2026-0001';
const pad = 'x'.repeat(30);
const REC = '11111111-2222-4333-8444-555555555555';

const rec = (token: string, ip?: string) =>
  addProduct(
    new Request(`http://x/api/public/landing-pages/kamaa/orders/${NUMBER}/add-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
      body: JSON.stringify({ token, recommendationId: REC }),
    }),
    { params: Promise.resolve({ slug: 'kamaa', orderNumber: NUMBER }) }
  );

const offer = (token: string, ip?: string) =>
  postOrderOffer(
    new Request(`http://x/api/public/orders/${NUMBER}/post-order-offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
      body: JSON.stringify({ token, offerId: REC }),
    }),
    { params: Promise.resolve({ orderNumber: NUMBER }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  db.order.findFirst.mockResolvedValue(null);
  addPostOrderOffer.mockResolvedValue({
    ok: true, orderNumber: NUMBER, addOn: { id: 'a', productName: 'x', quantity: 1, price: 1, total: 1 }, newTotal: 2, currency: 'JOD',
  });
});

afterEach(() => {
  delete process.env.TRUST_PROXY;
});

describe('the recommendation door', () => {
  it('five requests with NO valid token spend nothing of the customer\'s — the real token is then accepted', async () => {
    for (let i = 0; i < 6; i++) expect((await rec(`stranger-${i}-${pad}`)).status).toBe(401);
    const real = await rec(`valid-orderaa-${pad}`);
    // Past the counter and the token; the order is not in this fake database, which is its own answer (404).
    expect(real.status).toBe(404);
  });

  it('NEGATIVE: the token\'s owner who keeps pressing IS stopped, after five', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await rec(`valid-orderbb-${pad}`)).status);
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('NEGATIVE: one customer\'s limit is not another\'s — the counter is on the order the token proves', async () => {
    for (let i = 0; i < 6; i++) await rec(`valid-ordercc-${pad}`);
    expect((await rec(`valid-orderdd-${pad}`)).status).not.toBe(429);
  });

  it('a known address that grinds is stopped at thirty — before its token is even looked at', async () => {
    process.env.TRUST_PROXY = 'true';
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await rec(`stranger-${i}-${pad}`, '203.0.113.7')).status);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('NEGATIVE: with no address to tell visitors apart, no stranger can use the shared bucket as a switch', async () => {
    delete process.env.TRUST_PROXY;
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await rec(`stranger-${i}-${pad}`)).status);
    expect(statuses.every((s) => s === 401)).toBe(true);
  });
});

describe('the offer-after-the-order door', () => {
  it('three requests with NO valid token spend nothing of the customer\'s three', async () => {
    for (let i = 0; i < 5; i++) expect((await offer(`stranger-${i}-${pad}`)).status).toBe(401);
    expect(addPostOrderOffer).not.toHaveBeenCalled();
    expect((await offer(`valid-orderee-${pad}`)).status).toBe(200);
  });

  it('NEGATIVE: the token\'s owner is stopped after three', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await offer(`valid-orderff-${pad}`)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('a known address that grinds is stopped at thirty', async () => {
    process.env.TRUST_PROXY = 'true';
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await offer(`stranger-${i}-${pad}`, '203.0.113.8')).status);
    expect(statuses[29]).toBe(401);
    expect(statuses[30]).toBe(429);
  });
});
