import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «مجرد ما يتأكد الطلب، ممنوع الأب سيل والكروس سيل — الرابط اللي معه تنتهي صلاحيته».
 *
 * A recommended product could be added for thirty minutes on the strength of its token alone, whatever had happened to
 * the order meanwhile. It now passes the gate the offer after the order passes: still new on both stages, nobody has
 * called, inside the seller's window — or nothing is written.
 */

const { db, tx } = vi.hoisted(() => {
  const tx = {
    orderAddOn: {
      create: vi.fn(async () => ({ id: 'a1', productName: 'شامبو', price: 11, quantity: 1 })),
      // The same suggestion already on the order — none, unless a test says so.
      findFirst: vi.fn(async (): Promise<unknown> => null),
    },
    order: {
      update: vi.fn(async () => ({ orderNumber: 'ORD-1', totalAmount: 25 })),
      // The order as the lock now shows it: still new, nobody has called.
      findFirst: vi.fn(async (): Promise<unknown> => ({
        status: 'NEW', confirmationStatus: 'NEW', createdAt: new Date(Date.now() - 2 * 60_000), totalAmount: 25,
        _count: { contactAttempts: 0 },
      })),
    },
    landingPage: { update: vi.fn(async () => ({})) },
    orderActivity: { create: vi.fn(async () => ({})) },
  };
  return {
    tx,
    db: {
      order: { findFirst: vi.fn() },
      landingPageRecommendation: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/landing-pages', () => ({ verifyAddonToken: async () => ({ orderId: 'o1', orderNumber: 'ORD-2026-0001' }) }));
vi.mock('@/lib/post-order-offer', async (orig) => ({
  ...(await orig<typeof import('@/lib/post-order-offer')>()),
  postOrderOfferSettings: async () => ({ windowMinutes: 15 }),
}));

import { POST } from './route';

const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', orderNumber: 'ORD-2026-0001', status: 'NEW', confirmationStatus: 'NEW',
  createdAt: new Date(Date.now() - 2 * 60_000), _count: { contactAttempts: 0 },
  landingPage: { id: 'lp1', name: 'الصفحة', slug: 'kamaa', isPublished: true }, store: { country: { minorUnit: 2 } },
  ...over,
});
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
  db.landingPageRecommendation.findFirst.mockResolvedValue({ id: 'r1', product: { id: 'p2', name: 'شامبو', basePrice: 11, image: null, status: 'ACTIVE' } });
});

describe('a recommended product after the order', () => {
  it('is added while the order is still new, nobody has called, and inside the window', async () => {
    db.order.findFirst.mockResolvedValue(order());
    const res = await add();
    expect(res.status).toBe(200);
    expect(tx.orderAddOn.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the order is confirmed', { confirmationStatus: 'CONFIRMED' }, 'NOT_NEW'],
    ['the order is already in operations', { status: 'PROCESSING' }, 'NOT_NEW'],
    ['somebody has called about it', { _count: { contactAttempts: 1 } }, 'CONTACTED'],
    ['the window has passed', { createdAt: new Date(Date.now() - 20 * 60_000) }, 'WINDOW_PASSED'],
  ])('NEGATIVE: refused once %s — the link has expired and nothing is written', async (_name, over, code) => {
    db.order.findFirst.mockResolvedValue(order(over));
    const res = await add();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(code);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.orderAddOn.create).not.toHaveBeenCalled();
  });
});
