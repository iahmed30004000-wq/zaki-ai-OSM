import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * «السلات المهجورة» ON THE STAFF SIDE — who sees a cart, who works it, and what each press writes. The keys are the
 * orders' own (`orders.view` and its scope, the contact and edit keys, `orders.assign`, `orders.create`), read by the REAL
 * authorization engine from grants attached to the session, as `getCurrentUser` attaches them.
 */

const h = vi.hoisted(() => ({
  db: {
    abandonedCart: { findFirst: vi.fn(), update: vi.fn(), count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    abandonedCartActivity: { create: vi.fn() },
    user: { findFirst: vi.fn(), findMany: vi.fn() },
    order: { findFirst: vi.fn(), findMany: vi.fn() },
    customer: { findMany: vi.fn() },
    company: { findUnique: vi.fn() },
    product: { findMany: vi.fn() },
  },
  logAudit: vi.fn(),
  requireContext: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => h.requireContext(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));

import { actOnCart, cartPowers, cartVisibilityWhere, convertCart, ordersBehindCarts } from './abandoned-carts';
import { cartPhoneKey, cartPhoneShown, retentionDaysOf } from './abandoned-cart-rules';
import { canAccessRoute, findRoute } from './route-registry';
import { can } from './authorization';
import { GET as listCarts } from '@/app/api/abandoned-carts/route';
import { GET as cartSummary } from '@/app/api/abandoned-carts/summary/route';
import { GET as readCart } from '@/app/api/abandoned-carts/[id]/route';

type Grants = Record<string, { scope: string }>;
const person = (id: string, grants: Grants): SessionUser =>
  ({
    id,
    name: id,
    email: `${id}@x.test`,
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    companyId: 'c1',
    permissions: [],
    effectiveGrants: { fullAccess: false, grants },
  }) as unknown as SessionUser;

const ALL = { scope: 'ALL_COMPANY' };
const supervisor = person('sup', { 'orders.view': ALL, 'orders.edit': ALL, 'orders.assign': ALL, 'orders.create': ALL, 'orders.note': ALL });
const agent = person('huda', { 'orders.view': { scope: 'ASSIGNED' }, 'orders.contact_log': ALL, 'orders.create': ALL });
const typist = person('sami', { 'orders.view': { scope: 'OWN' } });
const warehouse = person('wh', { 'ops.prepare': ALL });
const reader = person('ro', { 'orders.view': ALL });

const CTX = { companyId: 'c1', storeId: 's1', countryId: 'jo', country: { code: 'JO', timezone: 'Asia/Amman' } };
const cart = (over: Record<string, unknown> = {}) => ({ id: 'cart1', status: 'NEW', assignedToId: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  h.db.abandonedCart.update.mockResolvedValue({});
  h.db.abandonedCartActivity.create.mockResolvedValue({});
});

describe('who sees a cart — the orders’ own key and scope', () => {
  it('«كل الشركة» sees every cart; «المسندة إليه» hers and the unassigned; «طلباتي المنشأة» his own', () => {
    expect(cartVisibilityWhere(supervisor)).toEqual({});
    expect(cartVisibilityWhere(agent)).toEqual({ OR: [{ assignedToId: 'huda' }, { assignedToId: null }] });
    expect(cartVisibilityWhere(typist)).toEqual({ assignedToId: 'sami' });
  });

  it('a role that does not see the orders does not see the carts: no envelope, no menu line, 403 at every door', async () => {
    expect(cartVisibilityWhere(warehouse)).toBeNull();
    expect(canAccessRoute(warehouse, findRoute('/abandoned-carts')!, can)).toBe(false);
    expect(canAccessRoute(agent, findRoute('/abandoned-carts')!, can)).toBe(true);

    h.requireContext.mockResolvedValue({ ...CTX, user: warehouse });
    expect((await listCarts(new Request('https://x.test/api/abandoned-carts'))).status).toBe(403);
    expect((await cartSummary()).status).toBe(403);
    expect((await readCart(new Request('https://x.test/api/abandoned-carts/cart1'), { params: Promise.resolve({ id: 'cart1' }) })).status).toBe(404);
    // Refused before anything was read.
    expect(h.db.abandonedCart.groupBy).not.toHaveBeenCalled();
    expect(h.db.abandonedCart.count).not.toHaveBeenCalled();
    expect(h.db.abandonedCart.findFirst).not.toHaveBeenCalled();
  });

  it('the list asks the database under the person’s envelope and the store', async () => {
    h.requireContext.mockResolvedValue({ ...CTX, user: agent });
    h.db.abandonedCart.groupBy.mockResolvedValue([]);
    h.db.abandonedCart.findMany.mockResolvedValue([]);
    h.db.user.findMany.mockResolvedValue([]);
    const res = await listCarts(new Request('https://x.test/api/abandoned-carts?status=NEW'));
    expect(res.status).toBe(200);
    const where = h.db.abandonedCart.groupBy.mock.calls[0][0].where;
    expect(where.companyId).toBe('c1');
    expect(where.AND[0]).toEqual({ OR: [{ assignedToId: 'huda' }, { assignedToId: null }] });
    expect(JSON.stringify(where.AND[1])).toContain('"storeId":"s1"');
    // An agent without `orders.assign` is not handed the list of colleagues.
    expect(h.db.user.findMany).not.toHaveBeenCalled();
  });
});

describe('who works it', () => {
  it('the presses follow the order keys', () => {
    expect(cartPowers(supervisor)).toEqual({ work: true, note: true, assign: true, convert: true, settings: false });
    expect(cartPowers(agent)).toMatchObject({ work: true, note: true, assign: false, convert: true });
    expect(cartPowers(reader)).toEqual({ work: false, note: false, assign: false, convert: false, settings: false });
  });

  it('a reader may look and not press: 403, nothing written', async () => {
    const r = await actOnCart(reader, 'c1', cart(), { action: 'no_answer' });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(h.db.abandonedCart.update).not.toHaveBeenCalled();
  });
});

describe('what each press writes', () => {
  it('«ما رد» adds an attempt every time, writes its line and the audit row in her name, and the cart becomes hers', async () => {
    const r = await actOnCart(agent, 'c1', cart(), { action: 'no_answer' });
    expect(r).toEqual({ ok: true, status: 'NO_ANSWER' });
    const data = h.db.abandonedCart.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'NO_ANSWER', attempts: { increment: 1 }, assignedToId: 'huda' });
    expect(data.activities.create).toMatchObject({ userId: 'huda', action: 'NO_ANSWER', fromStatus: 'NEW', toStatus: 'NO_ANSWER' });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'huda', action: 'ABANDONED_CART_STATUS', entity: 'AbandonedCart' }));
  });

  it('another status counts no attempt and leaves somebody else’s cart with them', async () => {
    await actOnCart(supervisor, 'c1', cart({ assignedToId: 'huda' }), { action: 'status', status: 'CONTACTED' });
    const data = h.db.abandonedCart.update.mock.calls[0][0].data;
    expect(data.status).toBe('CONTACTED');
    expect(data.attempts).toBeUndefined();
    expect(data.assignedToId).toBeUndefined();
  });

  it('CONVERTED and RECOVERED are not picked by hand, and a closed cart does not move', async () => {
    expect(await actOnCart(supervisor, 'c1', cart(), { action: 'status', status: 'CONVERTED' })).toMatchObject({ ok: false, status: 400 });
    expect(await actOnCart(supervisor, 'c1', cart({ status: 'RECOVERED' }), { action: 'status', status: 'NEW' })).toMatchObject({ ok: false, status: 409 });
    expect(h.db.abandonedCart.update).not.toHaveBeenCalled();
  });

  it('a note, a follow-up date, an assignment — each a history line; the assignment needs orders.assign and a colleague', async () => {
    await actOnCart(agent, 'c1', cart(), { action: 'note', text: 'قال اتصلوا بعد العصر' });
    expect(h.db.abandonedCartActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'NOTE', userId: 'huda', note: 'قال اتصلوا بعد العصر' }) });

    const at = new Date('2026-11-16T14:00:00.000Z');
    await actOnCart(agent, 'c1', cart(), { action: 'follow_up', at });
    expect(h.db.abandonedCart.update.mock.calls.at(-1)![0].data.nextFollowUpAt).toEqual(at);

    expect(await actOnCart(agent, 'c1', cart(), { action: 'assign', userId: 'huda' })).toMatchObject({ ok: false, status: 403 });
    h.db.user.findFirst.mockResolvedValueOnce(null);
    expect(await actOnCart(supervisor, 'c1', cart(), { action: 'assign', userId: 'stranger' })).toMatchObject({ ok: false, status: 400 });
    h.db.user.findFirst.mockResolvedValueOnce({ id: 'huda' });
    expect(await actOnCart(supervisor, 'c1', cart(), { action: 'assign', userId: 'huda' })).toMatchObject({ ok: true });
    expect(h.db.user.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ companyId: 'c1', status: 'ACTIVE' }) }));
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ABANDONED_CART_ASSIGNED', userId: 'sup' }));
  });
});

describe('«حوّل لطلب» — the tie to an order the order door already made', () => {
  it('CONVERTED, linked, a history line and an audit row in the person’s name', async () => {
    h.db.order.findFirst.mockResolvedValue({ id: 'o1', orderNumber: 'JO-2026-0100' });
    const r = await convertCart(agent, { companyId: 'c1', storeId: 's1' }, cart({ status: 'NO_ANSWER' }), 'o1');
    expect(r).toEqual({ ok: true, status: 'CONVERTED', orderNumber: 'JO-2026-0100' });
    expect(h.db.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'o1', companyId: 'c1', storeId: 's1' } }));
    expect(h.db.abandonedCart.update.mock.calls[0][0].data).toMatchObject({ status: 'CONVERTED', orderId: 'o1' });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ABANDONED_CART_CONVERTED', userId: 'huda' }));
  });

  it('refuses another store’s order, a closed cart, and a person who may not create orders', async () => {
    h.db.order.findFirst.mockResolvedValue(null);
    expect(await convertCart(agent, { companyId: 'c1', storeId: 's1' }, cart(), 'elsewhere')).toMatchObject({ ok: false, status: 404 });
    expect(await convertCart(agent, { companyId: 'c1', storeId: 's1' }, cart({ status: 'CONVERTED' }), 'o1')).toMatchObject({ ok: false, status: 409 });
    expect(await convertCart(reader, { companyId: 'c1', storeId: 's1' }, cart(), 'o1')).toMatchObject({ ok: false, status: 403 });
    expect(h.db.abandonedCart.update).not.toHaveBeenCalled();
  });
});

describe('«له طلب» — the same phone, the same product, this week', () => {
  it('finds the order through the customer’s stored phone, by the order’s product or a line’s', async () => {
    h.db.customer.findMany.mockResolvedValue([{ id: 'cu1', phone: '791234567' }]);
    h.db.order.findMany.mockResolvedValue([
      { id: 'o9', orderNumber: 'JO-2026-0009', customerId: 'cu1', productId: 'other', items: [{ productId: 'p1' }] },
    ]);
    const found = await ordersBehindCarts('c1', [
      { id: 'a', status: 'NEW', phoneNormalized: '791234567', productId: 'p1' },
      { id: 'b', status: 'NEW', phoneNormalized: '791234567', productId: 'p2' },
      { id: 'c', status: 'CONVERTED', phoneNormalized: '791234567', productId: 'p1' },
    ]);
    expect(found.get('a')).toEqual({ id: 'o9', orderNumber: 'JO-2026-0009' });
    expect(found.has('b')).toBe(false);
    expect(found.has('c')).toBe(false);
    const since = h.db.order.findMany.mock.calls[0][0].where.createdAt.gte as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThan(6.9 * 86_400_000);
    expect(Date.now() - since.getTime()).toBeLessThan(7.1 * 86_400_000);
  });
});

describe('the phone, however Zaki pages wrote it', () => {
  it('international without +, local with the trunk zero, and with + all key the same as the stored customer', () => {
    expect(cartPhoneKey('962791234567', 'JO')).toBe('791234567');
    expect(cartPhoneKey('0791234567', 'JO')).toBe('791234567');
    expect(cartPhoneKey('+962 79 123 4567', 'JO')).toBe('791234567');
    expect(cartPhoneShown('791234567', 'JO')).toBe('0791234567');
  });

  it('the retention days are clamped, and default to 60', () => {
    expect(retentionDaysOf(undefined)).toBe(60);
    expect(retentionDaysOf(90)).toBe(90);
    expect(retentionDaysOf(1)).toBe(7);
    expect(retentionDaysOf(10_000)).toBe(365);
    expect(retentionDaysOf('30')).toBe(60);
  });
});
