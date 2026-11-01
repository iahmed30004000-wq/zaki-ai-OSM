import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PUBLIC ORDER DOOR — what it does when the write fails, what it writes, and what it answers with.
 *
 * ط40 the second press after a 500 · ط41 the number's retry · ط42 Latin digits · ط23 the add-on window ·
 * ط45 a suggestion at nothing · ط46 an order worth nothing · ط47 the address typed this time.
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — the owner, for every open question of this change: each was settled the
 * way that is safest for the money and does the least harm, and written in the PR.
 */

const { db, tx } = vi.hoisted(() => {
  const tx: any = {
    order: { create: vi.fn(async ({ data }: any) => ({ ...data, id: 'o-new' })) },
    orderItem: { createMany: vi.fn(async () => ({ count: 0 })) },
    customer: { update: vi.fn() },
    orderActivity: { create: vi.fn() },
    landingPage: { update: vi.fn() },
  };
  const db: any = {
    region: { findMany: vi.fn(async () => [{ id: 'r1', name: 'عمّان' }]) },
    offer: { findMany: vi.fn(async () => []) },
    order: { groupBy: vi.fn(async () => []) },
    orderChannel: { findFirst: vi.fn(async () => null) },
    store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
    productionBatch: { findMany: vi.fn(async () => []) },
    // No fixed cost for any product here: the order's cost is what the batches say.
    productFixedCost: { findMany: async () => [] },
    company: { findUnique: vi.fn(async () => ({ settings: null })) },
    landingPageRecommendation: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { db, tx };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/customer-identity', () => ({
  findOrCreateCustomer: vi.fn(async () => ({ id: 'cust-1', firstOrderDate: null, fullName: 'زبون تجريبي', city: 'عمّان' })),
}));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: vi.fn(async () => ({ orderNumber: 'ORD-77', merchantRef: 'ORD-77' })) }));
vi.mock('@/lib/blacklist', () => ({ isBlocked: vi.fn(async () => false), NEUTRAL_REFUSAL: 'x' }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn(), afterResponse: (w: () => Promise<unknown>) => { void w(); } }));

import { createPublicOrder } from './public-order';
import { findOrCreateCustomer } from '@/lib/customer-identity';
import { orderRefFields } from '@/lib/order-ref';
import { ADDON_TOKEN_MINUTES } from './landing-pages';
import { repoFile, stripComments } from './guard-source';

const PRODUCT = { id: 'p-1', name: 'شامبو', image: null, basePrice: 25 };

let scope = 0;
const surface = (over: Record<string, unknown> = {}, product = PRODUCT) => ({
  companyId: 'c1',
  store: { id: 'store-a', countryId: 'jo', country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 } },
  products: [product],
  landingPage: { id: 'lp1', name: 'الصفحة', slug: 'summer' },
  source: 'Landing Page',
  campaignId: null,
  dedupeScope: `after-the-write-${scope++}`,
  notice: { title: 'طلب', message: (n: string) => n },
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  full_name: 'زبون تجريبي',
  phone: '0790000000',
  address: 'شارع الاختبار، بناية ٣',
  city: 'عمّان',
  ...over,
});

const created = () => tx.order.create.mock.calls.at(-1)![0].data;

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: any) => fn(tx));
  tx.order.create.mockImplementation(async ({ data }: any) => ({ ...data, id: 'o-new' }));
  db.company.findUnique.mockImplementation(async () => ({ settings: null }));
  db.landingPageRecommendation.findMany.mockImplementation(async () => []);
  db.offer.findMany.mockImplementation(async () => []);
  vi.mocked(findOrCreateCustomer).mockImplementation(async () => ({ id: 'cust-1', firstOrderDate: null, fullName: 'زبون تجريبي', city: 'عمّان' }) as never);
  vi.mocked(orderRefFields).mockImplementation(async () => ({ orderNumber: 'ORD-77', merchantRef: 'ORD-77' }));
});

describe('ط40 — the second press after a failure', () => {
  it('a write that threw gives the slot back: the second press is a real second try, not «تم استلام طلبك»', async () => {
    const s = surface();
    db.$transaction.mockRejectedValueOnce(new Error('connection lost'));
    await expect(createPublicOrder(s as never, body())).rejects.toThrow('connection lost');

    const again = await createPublicOrder(s as never, body());
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(tx.order.create).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: an order that WAS saved keeps the slot — the second press within five minutes is still refused', async () => {
    const s = surface();
    expect((await createPublicOrder(s as never, body())).ok).toBe(true);
    const second = await createPublicOrder(s as never, body());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(429);
    expect(tx.order.create).toHaveBeenCalledTimes(1);
  });

  it('a customer that could not be created gives it back too', async () => {
    const s = surface();
    vi.mocked(findOrCreateCustomer).mockRejectedValueOnce(new Error('db down'));
    await expect(createPublicOrder(s as never, body())).rejects.toThrow('db down');
    expect((await createPublicOrder(s as never, body())).ok).toBe(true);
  });

  it('NEGATIVE: a refusal BEFORE the slot (a blocked field) takes nothing and gives nothing', async () => {
    const s = surface();
    const bad = await createPublicOrder(s as never, body({ phone: '12' }));
    expect(bad.ok).toBe(false);
    expect((await createPublicOrder(s as never, body())).ok).toBe(true);
  });
});

describe('ط41 — the number collides, and the retry runs the whole transaction again', () => {
  it('a P2002 on the insert rolls the transaction back and the NEXT attempt asks for the next number', async () => {
    tx.order.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    const r = await createPublicOrder(surface() as never, body());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // Two transactions, not two loops inside one: a failed statement aborts a Postgres transaction.
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(vi.mocked(orderRefFields).mock.calls.map((c) => c[3])).toEqual([0, 1]);
  });

  it('NEGATIVE: five collisions in a row stop, and the slot is given back', async () => {
    const s = surface();
    tx.order.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(createPublicOrder(s as never, body())).rejects.toThrow();
    expect(db.$transaction).toHaveBeenCalledTimes(5);
    tx.order.create.mockImplementation(async ({ data }: any) => ({ ...data, id: 'o-new' }));
    expect((await createPublicOrder(s as never, body())).ok).toBe(true);
  });

  it('NEGATIVE: any other error is not retried', async () => {
    tx.order.create.mockRejectedValueOnce(new Error('boom'));
    await expect(createPublicOrder(surface() as never, body())).rejects.toThrow('boom');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('ط42 — the phone is stored in Latin digits', () => {
  it('«٠٧٩٠٠٠٠٠٠٠» reaches the customer row as «0790000000»', async () => {
    await createPublicOrder(surface() as never, body({ phone: '٠٧٩٠٠٠٠٠٠٠' }));
    expect(vi.mocked(findOrCreateCustomer).mock.calls[0][1]).toMatchObject({ rawPhone: '0790000000' });
  });

  it('NEGATIVE: an international form and its plus sign are kept as typed', async () => {
    await createPublicOrder(surface() as never, body({ phone: '+962790000000' }));
    expect(vi.mocked(findOrCreateCustomer).mock.calls[0][1]).toMatchObject({ rawPhone: '+962790000000' });
  });
});

describe('ط46 — an order worth nothing is not taken', () => {
  it('a product at 0 with no offer is refused, and nothing is written or taken', async () => {
    const s = surface({}, { ...PRODUCT, basePrice: 0 });
    const r = await createPublicOrder(s as never, body());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toContain('غير متاح للطلب');
    }
    expect(vi.mocked(findOrCreateCustomer)).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
    // The slot was never taken: the same visitor, the same phone, at a price, is not told «already received».
    const fixed = await createPublicOrder({ ...s, products: [{ ...PRODUCT, basePrice: 12 }] } as never, body());
    expect(fixed.ok).toBe(true);
  });

  it('NEGATIVE: a product at 12 makes the order', async () => {
    const r = await createPublicOrder(surface({}, { ...PRODUCT, basePrice: 12 }) as never, body());
    expect(r.ok).toBe(true);
    expect(created().totalAmount).toBe(12);
  });
});

describe('ط47 — the address typed THIS time travels with the order', () => {
  it('is written on the order itself, whatever the customer row says', async () => {
    await createPublicOrder(surface() as never, body({ address: 'شارع جديد، بناية ٩' }));
    expect(created().deliveryAddress).toBe('شارع جديد، بناية ٩');
  });

  it('a returning customer who typed another name or city leaves the typed pair in the order\'s first entry', async () => {
    vi.mocked(findOrCreateCustomer).mockResolvedValueOnce({ id: 'cust-1', firstOrderDate: null, fullName: 'اسم قديم', city: 'إربد' } as never);
    await createPublicOrder(surface() as never, body());
    const meta = JSON.parse(tx.orderActivity.create.mock.calls[0][0].data.metadata);
    expect(meta.typed).toEqual({ name: 'زبون تجريبي', city: 'عمّان' });
  });

  it('NEGATIVE: a new customer (or one who typed the same) has no difference to record', async () => {
    await createPublicOrder(surface() as never, body());
    const meta = JSON.parse(tx.orderActivity.create.mock.calls[0][0].data.metadata);
    expect(meta.typed).toBeUndefined();
  });
});

describe('ط45 — a suggestion with no price is not offered, and a failed read does not fail the order', () => {
  const rec = (id: string, basePrice: number, name = 'منتج') => ({ id, product: { id: `p-${id}`, name, basePrice, image: null } });

  it('keeps the priced ones and drops the one at 0 and the one with no name', async () => {
    db.landingPageRecommendation.findMany.mockResolvedValue([rec('r0', 0), rec('r11', 11), rec('rx', 9, '')]);
    const r = await createPublicOrder(surface() as never, body());
    expect(r.ok && (r.body.recommendations as { id: string }[]).map((x) => x.id)).toEqual(['r11']);
  });

  it('a read that throws is an empty list — the order is already saved and the thank-you screen still comes', async () => {
    db.landingPageRecommendation.findMany.mockRejectedValue(new Error('query failed'));
    const r = await createPublicOrder(surface() as never, body());
    expect(r.ok).toBe(true);
    expect(r.ok && r.body.recommendations).toEqual([]);
    expect(r.ok && r.body.orderNumber).toBe('ORD-77');
  });
});

describe('ط23 — the window the thank-you screen is told is the one that closes first', () => {
  const settings = (windowMinutes: number) => ({ settings: JSON.stringify({ postOrderOffer: { windowMinutes } }) });
  const recs = [{ id: 'r1', product: { id: 'p-2', name: 'منتج', basePrice: 11, image: null } }];

  it('a seller window of 60 is told as 30 — the link dies at thirty', async () => {
    db.company.findUnique.mockResolvedValue(settings(60));
    db.landingPageRecommendation.findMany.mockResolvedValue(recs);
    const r = await createPublicOrder(surface() as never, body());
    expect(r.ok && r.body.postOrderWindowMinutes).toBe(30);
  });

  it('suggestions with no offer are told the seller\'s own number, 5 — not the default fifteen', async () => {
    db.company.findUnique.mockResolvedValue(settings(5));
    db.landingPageRecommendation.findMany.mockResolvedValue(recs);
    const r = await createPublicOrder(surface() as never, body());
    expect(r.ok && r.body.postOrderWindowMinutes).toBe(5);
  });

  it('NEGATIVE: with nothing to add the default fifteen is what is said, and the settings are not even read', async () => {
    db.company.findUnique.mockResolvedValue(settings(60));
    const r = await createPublicOrder(surface() as never, body());
    expect(r.ok && r.body.postOrderWindowMinutes).toBe(15);
    expect(db.company.findUnique).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the order row is not touched by any of it', async () => {
    db.company.findUnique.mockResolvedValue(settings(60));
    db.landingPageRecommendation.findMany.mockResolvedValue(recs);
    await createPublicOrder(surface() as never, body());
    expect(JSON.stringify(created())).not.toContain('postOrderWindow');
    expect(tx.order.create).toHaveBeenCalledTimes(1);
  });
});

describe('ط23 — one number for how long the link lives', () => {
  it('is thirty, the token signs for exactly that, and the settings card says so', () => {
    expect(ADDON_TOKEN_MINUTES).toBe(30);
    expect(stripComments(repoFile('src/lib/landing-pages.ts'))).toContain('.setExpirationTime(`${ADDON_TOKEN_MINUTES}m`)');
    expect(repoFile('src/components/settings/PostOrderOfferCard.tsx')).toContain('رابط الإضافة نفسه يعيش 30 دقيقة');
  });
});
