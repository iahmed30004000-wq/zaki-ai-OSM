import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A LANDING ORDER MAY COME WITHOUT A CITY — at the standalone landing door, and nowhere else.
 *
 * The owner, 15/11: a Zaki page may hide the city list and ask for «العنوان» only. Asked whether the OMS should then
 * refuse the order or take it, he chose to take it: no region, and the team picks it on the confirmation call (the
 * confirmation door already refuses a «yes» without one, `REGION_REQUIRED`, and the card draws the field).
 *
 * What is held here:
 *   · with `cityOptional` (only `v1/landing-door.ts` sets it) a blank, missing or null city is taken: the order has
 *     `regionId: null`, the customer `city: ''`, and its history says why, in Arabic;
 *   · a city that IS written must still be the country's — a typo is a 400 with `fieldErrors.city`, in the same
 *     words as before, and nothing is written;
 *   · every other door (no `cityOptional`) still refuses a blank city, exactly as it did;
 *   · the address stays required, and a city that is given still finds its region and writes no extra line.
 */

const { db, tx, spies } = vi.hoisted(() => {
  const tx: any = {
    order: { create: vi.fn(async ({ data }: any) => ({ ...data, id: 'o-new', createdAt: new Date() })) },
    orderItem: { createMany: vi.fn(async () => ({ count: 0 })) },
    customer: { update: vi.fn() },
    orderActivity: { create: vi.fn() },
    landingPage: { update: vi.fn() },
  };
  const db: any = {
    region: { findMany: vi.fn(async () => [{ id: 'r1', name: 'عمّان' }, { id: 'r2', name: 'إربد' }]) },
    offer: { findMany: vi.fn(async () => []) },
    order: { findMany: vi.fn(async () => []) },
    orderActivity: { create: vi.fn() },
    orderChannel: { findFirst: vi.fn(async () => null) },
    store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
    productionBatch: { findMany: vi.fn(async () => []) },
    productFixedCost: { findMany: async () => [] },
    landingPageRecommendation: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  const spies = {
    findOrCreateCustomer: vi.fn(async () => ({ id: 'cust-1', firstOrderDate: null, fullName: 'زبون تجريبي', city: '' })),
    emitAppEvent: vi.fn(),
    notify: vi.fn(),
    queueConversions: vi.fn(),
    isBlocked: vi.fn(async () => false),
  };
  return { db, tx, spies };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => spies.emitAppEvent(...a) }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: (...a: unknown[]) => spies.queueConversions(...a) }));
vi.mock('@/lib/customer-identity', () => ({
  findOrCreateCustomer: (...a: unknown[]) => spies.findOrCreateCustomer(...(a as [])),
}));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: vi.fn(async () => ({ orderNumber: 'ORD-91' })) }));
vi.mock('@/lib/blacklist', () => ({ isBlocked: (...a: unknown[]) => spies.isBlocked(...(a as [])), NEUTRAL_REFUSAL: 'x' }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => spies.notify(...a), afterResponse: (w: () => Promise<unknown>) => { void w(); } }));

import { createPublicOrder, type SellingSurface } from './public-order';
import { ARRIVED_WITHOUT_REGION_ACTION, buildPublicOrderSchema } from './landing-order-schema';

let scope = 0;
const surface = (cityOptional?: boolean): SellingSurface => ({
  companyId: 'c1',
  store: { id: 'store-a', countryId: 'jo', country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 } },
  products: [{ id: 'p1', name: 'كريم', image: null, basePrice: 10 }],
  landingPage: null,
  source: 'LANDING_PAGE',
  campaignId: null,
  dedupeScope: `no-city-${scope++}`,
  notice: { title: 'طلب', message: (n: string) => n },
  ...(cityOptional === undefined ? {} : { cityOptional }),
});

const body = (over: Record<string, unknown> = {}) => ({
  full_name: 'زبون تجريبي',
  phone: '0790000000',
  address: 'شارع الاختبار، بناية ٣',
  city: '',
  ...over,
});

const activities = () => tx.orderActivity.create.mock.calls.map((c: any[]) => c[0].data.action);

const nothingWritten = () => {
  expect(spies.findOrCreateCustomer, 'انكتب زبون').not.toHaveBeenCalled();
  expect(db.$transaction, 'انفتحت عملية كتابة').not.toHaveBeenCalled();
  expect(tx.order.create, 'انكتب طلب').not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('at the landing door (cityOptional), a blank city is taken', () => {
  it.each([
    ['empty', body({ city: '' })],
    ['only spaces', body({ city: '   ' })],
    ['missing', (({ city: _c, ...rest }) => rest)(body())],
    ['null', body({ city: null })],
  ])('%s ⇒ an order with no region, the customer’s city blank, and the history saying why', async (_name, sent) => {
    const r = await createPublicOrder(surface(true), sent);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(tx.order.create.mock.calls[0][0].data.regionId).toBeNull();
    expect(tx.order.create.mock.calls[0][0].data.deliveryAddress).toBe('شارع الاختبار، بناية ٣');
    expect((spies.findOrCreateCustomer.mock.calls[0] as unknown[])[1]).toMatchObject({ city: '' });
    expect(activities()).toEqual(['ORDER_CREATED', ARRIVED_WITHOUT_REGION_ACTION]);
    const line = tx.orderActivity.create.mock.calls[1][0].data;
    expect(line).toMatchObject({ companyId: 'c1', orderId: 'o-new', userId: null });
  });

  it('the history line reads in Arabic on the order’s timeline', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./order-timeline.ts', import.meta.url), 'utf8');
    expect(src).toContain("[ARRIVED_WITHOUT_REGION_ACTION]: 'الطلب وصل من صفحة الهبوط بدون مدينة — حدّد المنطقة وقت التأكيد'");
  });

  it('a city that is written still finds its region, and no extra line is written', async () => {
    const r = await createPublicOrder(surface(true), body({ city: 'إربد' }));
    expect(r.ok).toBe(true);
    expect(tx.order.create.mock.calls[0][0].data.regionId).toBe('r2');
    expect(activities()).toEqual(['ORDER_CREATED']);
  });

  it('a city that is written and is not the country’s is still a 400 on `city`, in the same words — nothing written', async () => {
    for (const city of ['Paris', 'عمان الغربية الجديدة', 'ع']) {
      const r = await createPublicOrder(surface(true), body({ city }));
      expect(r.ok, city).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(400);
      expect(r.body.fieldErrors).toHaveProperty('city');
      expect(String((r.body.fieldErrors as Record<string, string>).city)).toMatch(/المدينة/);
    }
    nothingWritten();
  });

  it('the address stays required', async () => {
    const r = await createPublicOrder(surface(true), body({ address: '' }));
    expect(!r.ok && r.body.fieldErrors).toHaveProperty('address');
    nothingWritten();
  });
});

describe('NEGATIVE: every other door still asks for the city', () => {
  it.each([[undefined], [false]])('cityOptional %s ⇒ a blank city is a 400 on `city`, and nothing is written', async (flag) => {
    for (const sent of [body({ city: '' }), (({ city: _c, ...rest }) => rest)(body())]) {
      const r = await createPublicOrder(surface(flag as boolean | undefined), sent);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(400);
      expect(r.body.fieldErrors).toHaveProperty('city');
    }
    nothingWritten();
  });

  it('the schema says the same words for a typo with or without the option', () => {
    const locale = { countryCode: 'JO', regions: ['عمّان'] };
    const words = (cityOptional: boolean) => {
      const r = buildPublicOrderSchema({ ...locale, cityOptional }).safeParse(body({ city: 'Paris' }));
      return r.success ? null : r.error.issues.find((i) => i.path[0] === 'city')?.message;
    };
    expect(words(false)).toBe('يرجى اختيار المدينة من القائمة.');
    expect(words(true)).toBe(words(false));
  });

  it('only the landing door sets the option', async () => {
    const { repoFile, stripComments } = await import('./guard-source');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          if (/cityOptional:\s*true/.test(stripComments(fs.readFileSync(p, 'utf8')))) hits.push(path.relative(process.cwd(), p).replace(/\\/g, '/'));
        }
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(hits).toEqual(['src/lib/v1/landing-door.ts']);
    expect(repoFile('src/lib/v1/landing-door.ts')).toContain('cityOptional: true');
  });
});
