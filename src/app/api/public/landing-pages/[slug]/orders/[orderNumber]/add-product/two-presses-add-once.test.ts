import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ط44 + ط45 — A SUGGESTION IS ADDED ONCE, AND NEVER AT NOTHING.
 *
 * Two presses at the same moment both read the order, both passed the gate, both wrote: the total grew by the
 * suggestion twice. The order's row is now locked first (an UPDATE holds it until the transaction ends); the second
 * press waits, re-reads the order as it is now, and finds the add-on the first one wrote. A suggestion priced at 0 was
 * added at 0 and shipped free; it is refused.
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: the repeat is answered as a SUCCESS carrying what is already on the
 * order (the customer pressed twice, or the reply was lost), with the current total.
 */

const { db, tx, order } = vi.hoisted(() => {
  const order = {
    id: 'o1', companyId: 'c1', orderNumber: 'ORD-2026-0001', status: 'NEW', confirmationStatus: 'NEW',
    createdAt: new Date(Date.now() - 60_000), totalAmount: 25, _count: { contactAttempts: 0 },
    landingPage: { id: 'lp1', name: 'الصفحة', slug: 'kamaa', isPublished: true }, store: { country: { minorUnit: 2 } },
  };
  const calls: string[] = [];
  const tx = {
    calls,
    orderAddOn: {
      findFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
      create: vi.fn(async () => { calls.push('create'); return { id: 'a1', productName: 'شامبو', price: 11, quantity: 1 }; }),
    },
    order: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        calls.push(args.data.version ? 'lock' : 'money');
        return { orderNumber: 'ORD-2026-0001', totalAmount: 36 };
      }),
      findFirst: vi.fn(async (): Promise<unknown> => ({ ...order })),
    },
    landingPage: { update: vi.fn(async () => ({})) },
    orderActivity: { create: vi.fn(async () => ({})) },
  };
  return {
    tx, order,
    db: {
      order: { findFirst: vi.fn() },
      landingPageRecommendation: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});
vi.mock('@/lib/db', () => ({ db }));
// A fresh order id per call, so the door's per-order counter (five in thirty minutes) never decides these tests.
let presses = 0;
vi.mock('@/lib/landing-pages', () => ({ verifyAddonToken: async () => ({ orderId: `press-${++presses}`, orderNumber: 'ORD-2026-0001' }) }));
vi.mock('@/lib/post-order-offer', async (orig) => ({
  ...(await orig<typeof import('@/lib/post-order-offer')>()),
  postOrderOfferSettings: async () => ({ windowMinutes: 15 }),
}));

import { POST } from './route';

const add = () =>
  POST(
    new Request('http://x/api/public/landing-pages/kamaa/orders/ORD-2026-0001/add-product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'x'.repeat(40), recommendationId: '11111111-2222-4333-8444-555555555555' }),
    }),
    { params: Promise.resolve({ slug: 'kamaa', orderNumber: 'ORD-2026-0001' }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  tx.calls.length = 0;
  db.order.findFirst.mockResolvedValue({ ...order });
  tx.order.findFirst.mockResolvedValue({ ...order });
  tx.orderAddOn.findFirst.mockResolvedValue(null);
  db.landingPageRecommendation.findFirst.mockResolvedValue({
    id: 'r1', product: { id: 'p2', name: 'شامبو', basePrice: 11, image: null, status: 'ACTIVE' },
  });
});

describe('ط44 — the order is locked before anything is decided', () => {
  it('the lock comes first, the money last', async () => {
    const res = await add();
    expect(res.status).toBe(200);
    expect(tx.calls).toEqual(['lock', 'create', 'money']);
  });

  it('the second press finds the add-on the first wrote and is answered with it — nothing is written twice', async () => {
    tx.orderAddOn.findFirst.mockResolvedValue({ id: 'a1', productName: 'شامبو', price: 11, quantity: 1 });
    const res = await add();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, alreadyAdded: true, newTotal: 25, addOn: { id: 'a1', productName: 'شامبو' } });
    expect(tx.orderAddOn.create).not.toHaveBeenCalled();
    expect(tx.calls).toEqual(['lock']);
    expect(tx.landingPage.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a DIFFERENT suggestion is a different add-on — it is written (the lookup is for the same product)', async () => {
    await add();
    expect(tx.orderAddOn.findFirst.mock.calls[0][0]).toMatchObject({
      where: { orderId: 'o1', productId: 'p2', landingPageId: 'lp1', offerId: null },
    });
    expect(tx.orderAddOn.create).toHaveBeenCalledTimes(1);
  });

  it('an order confirmed between the first read and the lock is refused — read again under the lock', async () => {
    tx.order.findFirst.mockResolvedValue({ ...order, confirmationStatus: 'CONFIRMED' });
    const res = await add();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_NEW');
    expect(tx.orderAddOn.create).not.toHaveBeenCalled();
    expect(tx.calls).toEqual(['lock']);
  });

  it('and one called about in that gap is refused too', async () => {
    tx.order.findFirst.mockResolvedValue({ ...order, _count: { contactAttempts: 1 } });
    const res = await add();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONTACTED');
  });
});

describe('ط45 — a suggestion at nothing', () => {
  it('is refused with the sentence for a product that is not available, and nothing is written', async () => {
    db.landingPageRecommendation.findFirst.mockResolvedValue({
      id: 'r1', product: { id: 'p2', name: 'هدية', basePrice: 0, image: null, status: 'ACTIVE' },
    });
    const res = await add();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('غير متاح');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('NEGATIVE: at 11 it is added', async () => {
    expect((await add()).status).toBe(200);
    expect(tx.orderAddOn.create).toHaveBeenCalledTimes(1);
  });
});
