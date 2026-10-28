import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «إلزامي» IS MEANT AT THE DOOR.
 *
 * The owner was asked, 28/10, whether a field the shop marked «إلزامي» and the visitor left blank should (أ) refuse
 * the order and tell the visitor «اكتب …», or (ب) take it as before. His answer, verbatim:
 * «انطيني الصلاحية شو الي يظهر بالشيك اوت الي بينطلب والترتيب دراخ اند دروب» — (أ). It is his written word for the
 * one fixed blocker this changes, «order creation changed».
 *
 * So `createPublicOrder` — the one engine behind every public door — refuses a blank second number or note that the
 * shop's LIVE «الدفع» requires, after the schema and BEFORE ANY WRITE. What is held here is that refusal and,
 * just as much, everything it must not touch: a shop that never ticked anything, a field the shop hid, a value an
 * older page sent for a hidden field, the four a parcel needs (still the schema's, in its words), and the
 * one-order-per-phone slot that a refused attempt must not burn.
 */

const { db, tx, spies } = vi.hoisted(() => {
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
    orderChannel: { findFirst: vi.fn(async () => null) },
    store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
    productionBatch: { findMany: vi.fn(async () => []) },
    landingPageRecommendation: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  const spies = {
    findOrCreateCustomer: vi.fn(async () => ({ id: 'cust-1', firstOrderDate: null })),
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
vi.mock('@/lib/order-ref', () => ({ orderRefFields: vi.fn(async () => ({ orderNumber: 'ORD-88' })) }));
vi.mock('@/lib/blacklist', () => ({ isBlocked: (...a: unknown[]) => spies.isBlocked(...(a as [])), NEUTRAL_REFUSAL: 'x' }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => spies.notify(...a), afterResponse: (w: () => Promise<unknown>) => { void w(); } }));

import { createPublicOrder, type SellingSurface } from './public-order';
import { ORDER_VALIDATION_ERROR_BODY } from './landing-order-schema';
import { DEFAULT_STORE_THEME, checkoutRules, parseStoreTheme, type StoreTheme } from './store-theme';

let scope = 0;
/** One door, as a route builds it — with the shop's «الدفع» resolved from a stored LIVE theme. */
const surface = (checkout: SellingSurface['checkout'] = null): SellingSurface => ({
  companyId: 'c1',
  store: {
    id: 'store-a',
    countryId: 'jo',
    country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 },
  },
  products: [{ id: 'p1', name: 'كريم', image: null, basePrice: 10 }],
  landingPage: null,
  source: 'Store',
  campaignId: null,
  // A fresh scope per call unless a test asks for the same one: the one-order-per-phone guard is real.
  dedupeScope: `asks-${scope++}`,
  notice: { title: 'طلب', message: (n: string) => n },
  checkout,
});
/** The rules a route hands over for a store whose stored theme says this. */
const rulesFor = (over: Partial<NonNullable<StoreTheme['checkout']>>) =>
  checkoutRules(parseStoreTheme(JSON.stringify({ ...DEFAULT_STORE_THEME, checkout: { ...DEFAULT_STORE_THEME.checkout!, ...over } })));

const body = (over: Record<string, unknown> = {}) => ({
  full_name: 'زبون تجريبي',
  phone: '0790000000',
  address: 'شارع الاختبار، بناية ٣',
  city: 'عمّان',
  ...over,
});

/** Every write the engine can make — none may happen for a refusal. */
const nothingWritten = () => {
  expect(spies.findOrCreateCustomer, 'انكتب زبون').not.toHaveBeenCalled();
  expect(db.$transaction, 'انفتحت عملية كتابة').not.toHaveBeenCalled();
  expect(tx.order.create, 'انكتب طلب').not.toHaveBeenCalled();
  expect(tx.orderItem.createMany).not.toHaveBeenCalled();
  expect(tx.orderActivity.create, 'انكتب سجل').not.toHaveBeenCalled();
  expect(spies.emitAppEvent, 'طلع حدث للتطبيقات').not.toHaveBeenCalled();
  expect(spies.notify, 'طلع إشعار').not.toHaveBeenCalled();
  expect(spies.queueConversions, 'طلع حدث للإعلانات').not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a required second number, left blank', () => {
  it('is refused with the shop’s «اكتب رقم هاتف بديل», in the door’s usual shape — and nothing is written', async () => {
    const r = await createPublicOrder(surface(rulesFor({ required: ['altPhone'] })), body({ alt_phone: '' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ...ORDER_VALIDATION_ERROR_BODY, fieldErrors: { alt_phone: 'اكتب رقم هاتف بديل' } });
    nothingWritten();
  });

  it('missing altogether, or only spaces, is blank too', async () => {
    for (const sent of [body(), body({ alt_phone: '    ' })]) {
      const r = await createPublicOrder(surface(rulesFor({ required: ['altPhone'] })), sent);
      expect(r.ok, JSON.stringify(sent)).toBe(false);
    }
    nothingWritten();
  });

  it('and filled in, the order is taken — the second number on the customer as before', async () => {
    const r = await createPublicOrder(surface(rulesFor({ required: ['altPhone'] })), body({ alt_phone: '0791111111' }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect((spies.findOrCreateCustomer.mock.calls[0] as unknown[])[1]).toMatchObject({ altPhone: expect.stringContaining('791111111') });
  });
});

describe('a required note, left blank', () => {
  it('is refused with «اكتب ملاحظتك» — and nothing is written', async () => {
    const r = await createPublicOrder(surface(rulesFor({ required: ['note'] })), body({ notes: '' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.body.fieldErrors).toEqual({ notes: 'اكتب ملاحظتك' });
    nothingWritten();
  });

  it('both required, both blank — both said at once', async () => {
    const r = await createPublicOrder(surface(rulesFor({ required: ['altPhone', 'note'] })), body());
    expect(!r.ok && r.body.fieldErrors).toEqual({ alt_phone: 'اكتب رقم هاتف بديل', notes: 'اكتب ملاحظتك' });
    nothingWritten();
  });

  it('and written, it reaches the order as the customer’s note', async () => {
    const r = await createPublicOrder(surface(rulesFor({ required: ['note'] })), body({ notes: 'بعد العصر' }));
    expect(r.ok).toBe(true);
    expect(tx.order.create.mock.calls[0][0].data.customerNotes).toBe('بعد العصر');
  });
});

describe('NEGATIVE: what the rule must not touch', () => {
  it('a shop that ticked nothing — blank is an answer, and the order is taken as today', async () => {
    const r = await createPublicOrder(surface(rulesFor({})), body({ alt_phone: '', notes: '' }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(tx.order.create).toHaveBeenCalledTimes(1);
  });

  it('a door that hands in no rules — exactly as before «الدفع» could require anything', async () => {
    for (const checkout of [null, undefined]) {
      vi.clearAllMocks();
      const r = await createPublicOrder(surface(checkout), body());
      expect(r.ok, String(checkout)).toBe(true);
      expect(tx.order.create).toHaveBeenCalledTimes(1);
    }
  });

  it('a field the shop HID is never required, whatever its tick says', async () => {
    const rules = rulesFor({ required: ['altPhone', 'note'], hidden: ['altPhone', 'note'] });
    expect(rules!.required).toEqual(['name', 'phone', 'region', 'address']);
    const r = await createPublicOrder(surface(rules), body());
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('and a value an older page still sends for a hidden field is taken, as today', async () => {
    const r = await createPublicOrder(
      surface(rulesFor({ hidden: ['altPhone', 'note'] })),
      body({ alt_phone: '0791111111', notes: 'من صفحة قديمة' })
    );
    expect(r.ok).toBe(true);
    expect((spies.findOrCreateCustomer.mock.calls[0] as unknown[])[1]).toMatchObject({ altPhone: expect.stringContaining('791111111') });
    expect(tx.order.create.mock.calls[0][0].data.customerNotes).toBe('من صفحة قديمة');
  });

  it('the four a parcel needs keep the schema’s own checks and words — a stored hidden «phone» changes nothing', async () => {
    const rules = rulesFor({ hidden: ['phone', 'address'], required: ['altPhone'] });
    expect(rules!.required).toEqual(['name', 'phone', 'altPhone', 'region', 'address']);
    const r = await createPublicOrder(surface(rules), body({ phone: '', alt_phone: '0791111111' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The schema's refusal, in its own words — not a «اكتب …» of this rule's.
    expect(r.body.fieldErrors).toHaveProperty('phone');
    expect(r.body.fieldErrors).not.toHaveProperty('alt_phone');
    nothingWritten();
  });

  it('a refused attempt does not burn the one-order-per-phone slot — the corrected one goes through', async () => {
    const door = surface(rulesFor({ required: ['altPhone'] }));
    const refused = await createPublicOrder(door, body());
    expect(refused.ok).toBe(false);
    const corrected = await createPublicOrder(door, body({ alt_phone: '0791111111' }));
    expect(corrected.ok, JSON.stringify(corrected)).toBe(true);
    // And the slot is real: the same phone through the same door again IS a duplicate.
    const again = await createPublicOrder(door, body({ alt_phone: '0791111111' }));
    expect(!again.ok && again.status).toBe(429);
  });
});

describe('where the refusal sits in the engine', () => {
  it('after the schema, and before the first write and the duplicate guard', async () => {
    const { repoFile, stripComments } = await import('./guard-source');
    const src = stripComments(repoFile('src/lib/public-order.ts'));
    const body = src.slice(src.indexOf('export async function createPublicOrder('));
    const asked = body.search(/blankRequired\(surface\.checkout\?\.required/);
    expect(asked, 'الباب ما بيسأل «الدفع»').toBeGreaterThan(body.search(/\.safeParse\(raw\)/));
    for (const write of [/rateLimit\(`pub_order_dup/, /findOrCreateCustomer\(/, /db\.\$transaction\(/, /notify\(\{/, /emitAppEvent\(/]) {
      expect(asked, String(write)).toBeLessThan(body.search(write));
    }
  });
});
