import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PASTED ORDER NAMES ITS MODERATOR BY A KEY, NOT BY A ROLE NAME (perm-plan PR-6, D10 / RV150).
 *
 * The AI intake's confirm step wrote `p.moderatorId || (user.role === 'MODERATOR' ? user.id : null)` — the same rule the
 * manual door had, and anybody holding `orders.create` could name any colleague with it. Both doors now ask
 * `responsibleModerator` (the owner's rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي»):
 *
 *   · nobody named → the typist owns it unless she holds `orders.assign`;
 *   · yourself named → yours;
 *   · somebody else named → only with `orders.assign`; otherwise a 403 BEFORE a customer is written.
 *
 * The money of the pasted order is `a-confirmed-payload-is-still-a-payload`'s business and is not touched here.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, activeBlock, findOrCreateCustomer, orderRefFields, productCost, resolveRegionId, keys } = vi.hoisted(() => ({
  db: {
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
    user: { findFirst: vi.fn() },
    order: { create: vi.fn() },
    orderItem: { create: vi.fn() },
    customer: { update: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  activeBlock: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  orderRefFields: vi.fn(),
  productCost: vi.fn(),
  resolveRegionId: vi.fn(),
  keys: { held: new Set<string>() },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => keys.held.has(k),
  getPermissionScope: () => null,
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/customer-identity', () => ({ findOrCreateCustomer: (...a: unknown[]) => findOrCreateCustomer(...a) }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: (...a: unknown[]) => orderRefFields(...a) }));
vi.mock('@/lib/product-cost', () => ({ productCost: (...a: unknown[]) => productCost(...a) }));
vi.mock('@/lib/regions', () => ({ resolveRegionId: (...a: unknown[]) => resolveRegionId(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/offers', () => ({ activeOffersFor: vi.fn(async () => []) }));
vi.mock('@/lib/order-parser', () => ({ parseOrderText: vi.fn(), matchProduct: vi.fn(), normalizeArabic: (s: string) => s }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));

import { POST } from './route';

const PRODUCT_ID = 'prod-000000001';
const COLLEAGUE = 'colleague-0000001';
const GOOD = { customerName: 'سارة علي', phone: '0791234567', address: 'عمّان', governorate: 'عمّان', productId: PRODUCT_ID, quantity: 2, finalPrice: 25_000 };

const confirm = (parsed: Record<string, unknown> = {}) =>
  POST(new Request('http://x/api/orders/ai-intake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, parsed: { ...GOOD, ...parsed } }) }));
const created = (): Record<string, any> | undefined => db.order.create.mock.calls[0]?.[0]?.data;

beforeEach(() => {
  vi.clearAllMocks();
  keys.held = new Set(['orders.create']);
  requireContext.mockResolvedValue({
    user: { id: 'u1-0000000001', name: 'هدى', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1', storeId: 's1', countryId: 'co1',
    country: { id: 'co1', code: 'JO', minorUnit: 2, currencyCode: 'JOD', orderPrefix: 'ORD' },
  });
  requirePermission.mockResolvedValue(undefined);
  activeBlock.mockResolvedValue(null);
  findOrCreateCustomer.mockResolvedValue({ id: 'cu1', city: 'عمّان', firstOrderDate: null });
  db.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, name: 'كريم مرطّب', image: null, basePrice: 14, batches: [] });
  db.user.findFirst.mockResolvedValue({ id: COLLEAGUE });
  db.$transaction.mockImplementation(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn));
  productCost.mockResolvedValue({ average: 7 });
  orderRefFields.mockResolvedValue({ orderNumber: 'ORD-2026-0001' });
  resolveRegionId.mockResolvedValue('r1');
  db.order.create.mockImplementation(async (args: { data: object }) => ({ id: 'o1', ...args.data }));
  db.orderItem.create.mockResolvedValue({});
  db.customer.update.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
});

describe('nobody named', () => {
  it('a typist without orders.assign owns what she pastes — whatever her role is called', async () => {
    const res = await confirm();
    expect(res.status).toBe(200);
    expect(created()!.moderatorId).toBe('u1-0000000001');
    expect(created()!.createdById).toBe('u1-0000000001');
    expect(db.user.findFirst, 'لا بحث عن نفسها').not.toHaveBeenCalled();
  });

  it('a person who hands orders out leaves it unowned', async () => {
    keys.held.add('orders.assign');
    expect((await confirm()).status).toBe(200);
    expect(created()!.moderatorId).toBeNull();
  });
});

describe('somebody named', () => {
  it('yourself: yours, with no lookup', async () => {
    expect((await confirm({ moderatorId: 'u1-0000000001' })).status).toBe(200);
    expect(created()!.moderatorId).toBe('u1-0000000001');
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });

  it('a colleague, by who holds orders.assign: checked to be of THIS company, then written', async () => {
    keys.held.add('orders.assign');
    expect((await confirm({ moderatorId: COLLEAGUE })).status).toBe(200);
    expect(created()!.moderatorId).toBe(COLLEAGUE);
    expect(db.user.findFirst).toHaveBeenCalledWith({ where: { id: COLLEAGUE, companyId: 'c1' } });
  });

  it('NEGATIVE: a colleague, by who does NOT hold orders.assign: 403 with its code — and no customer, no order, no line written', async () => {
    const res = await confirm({ moderatorId: COLLEAGUE });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('MODERATOR_FORBIDDEN');
    expect(findOrCreateCustomer, 'كُتب زبون قبل الرفض').not.toHaveBeenCalled();
    expect(db.order.create).not.toHaveBeenCalled();
    expect(db.orderItem.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a colleague who is not in this company is still refused for who holds the key (404, as before)', async () => {
    keys.held.add('orders.assign');
    db.user.findFirst.mockResolvedValue(null);
    expect((await confirm({ moderatorId: COLLEAGUE })).status).toBe(404);
    expect(db.order.create).not.toHaveBeenCalled();
  });
});
