import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CHANGE-REQUEST DESK AND THE DECISION ASK THEIR KEYS (perm-plan PR-7).
 *
 *   · seeing the WHOLE desk is `control.change_requests_view` — not `control.change_requests`, and not four role NAMES;
 *   · deciding at the packing table is `ops.decide_changes` — not `ops.ship`, and not the name WAREHOUSE;
 *   · APPROVING a request that moves a price, a discount, a quantity or a product needs `orders.change_price` BESIDES the
 *     right to decide at that stage — at every stage (the desk, the packing table, the agent holding the order) and also when
 *     the raiser would decide it herself as she raises it. Rejecting never needs it, and neither does any other field;
 *   · the people TOLD are the holders of `control.change_requests`, and only they.
 *
 * Through the REAL engine. The migration gave each of these keys to everybody who passed the old door, so the people of
 * these tests are the people AFTER the deploy; what is held here is what a person WITHOUT the key meets.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, createNotification, assertOrderAccess, current } = vi.hoisted(() => ({
  db: {
    orderChangeRequest: { findMany: vi.fn(async () => []), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(async () => ({})) },
    user: { findMany: vi.fn(async () => []) },
    order: { findFirst: vi.fn() },
    orderNote: { create: vi.fn(async () => ({})) },
    shippingBatch: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  createNotification: vi.fn(async () => 1),
  assertOrderAccess: vi.fn(),
  current: { user: null as unknown as SessionUser },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a), assertOrderReadable: vi.fn() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { GET as deskGET } from './change-requests/route';
import { PATCH as decidePATCH } from './change-requests/[id]/route';
import { POST as raisePOST } from '../orders/[id]/change-requests/route';

async function person(roleKeys: string[], role = 'CUSTOM', id = 'u1'): Promise<SessionUser> {
  const base = { id, email: 'u@x', name: 'سارة', role, roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => [],
    })
  );
}

async function as(roleKeys: string[], role = 'CUSTOM') {
  current.user = await person(roleKeys, role);
  requireContext.mockResolvedValue({
    user: current.user, companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Amman' },
  });
}

const REQ_ID = '11111111-2222-4333-8444-555555555555';
const params = { params: Promise.resolve({ id: REQ_ID }) };
const json = (b: unknown, method = 'PATCH') => new Request('http://x/api', { method, body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
    orderChangeRequest: { update: vi.fn(async ({ data }: { data: object }) => ({ id: REQ_ID, changes: {}, ...data })) },
    orderNote: { create: vi.fn() },
  }));
});

// ───────────────────────────── the desk ─────────────────────────────

describe('who sees the WHOLE desk', () => {
  const asked = () => (db.orderChangeRequest.findMany.mock.calls.at(-1) as unknown as [{ where: Record<string, unknown> }])[0].where;
  const seesAll = () => !('OR' in asked());
  const read = () => deskGET(new Request('http://x/api/control/change-requests?status=PENDING'));

  it('who holds the view key sees every request', async () => {
    await as(['control.change_requests_view', 'control.change_requests']);
    expect((await read()).status).toBe(200);
    expect(seesAll()).toBe(true);
  });

  it('NEGATIVE: the DECISION key alone no longer shows the whole desk — her own and the ones on orders in her hands', async () => {
    await as(['control.change_requests']);
    await read();
    expect(seesAll()).toBe(false);
    expect(JSON.stringify(asked())).toContain('requestedById');
  });

  it('NEGATIVE: the four role NAMES stopped counting — a MANAGER with the key unticked sees only hers, until the migration’s key says otherwise', async () => {
    for (const role of ['COMPANY_ADMIN', 'MANAGER', 'CONFIRMATION_SUPERVISOR']) {
      await as([], role);
      await read();
      expect(seesAll(), role).toBe(false);
    }
    // …and the same people WITH the key (what the migration gave them) see all of it
    for (const role of ['COMPANY_ADMIN', 'MANAGER', 'CONFIRMATION_SUPERVISOR']) {
      await as(['control.change_requests_view'], role);
      await read();
      expect(seesAll(), role).toBe(true);
    }
  });

  it('the owner (SUPER_ADMIN) sees everything without a row', async () => {
    await as([], 'SUPER_ADMIN');
    current.user = await person([], 'SUPER_ADMIN');
    await read();
    expect(seesAll()).toBe(true);
  });

  it('every row says whether the reader lacks the price key for it — and only a row that moves a figure can say yes', async () => {
    db.orderChangeRequest.findMany.mockResolvedValue([
      row({ id: 'a', changes: { quantity: { from: 2, to: 3 } } }),
      row({ id: 'b', changes: { customerNotes: { from: 'x', to: 'y' } } }),
      row({ id: 'c', changes: { discountAmount: { from: 0, to: 5 } } }),
      row({ id: 'd', changes: {} }),
    ] as never);
    await as(['control.change_requests_view']);
    const without = (await (await read()).json()).requests as Array<{ id: string; needsPriceKey: boolean }>;
    expect(without.map((r) => [r.id, r.needsPriceKey])).toEqual([['a', true], ['b', false], ['c', true], ['d', false]]);
    await as(['control.change_requests_view', 'orders.change_price']);
    const withKey = (await (await read()).json()).requests as Array<{ id: string; needsPriceKey: boolean }>;
    expect(withKey.every((r) => r.needsPriceKey === false)).toBe(true);
  });
});

const row = (over: Record<string, unknown>) => ({
  id: 'x', requestedById: 'other', status: 'PENDING', intent: 'EDIT', changes: {}, slaDueAt: null, appliedAt: null,
  order: { id: 'o1', orderNumber: 'JO-1', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', version: 1, shippedAt: null, labelPrintedAt: null, shippingBatch: null, customer: { fullName: 'س', phone: '1' } },
  ...over,
});

// ───────────────────────────── the decision ─────────────────────────────

describe('deciding a request', () => {
  const pending = (over: Record<string, unknown> = {}, orderOver: Record<string, unknown> = {}) => {
    const r = row({ id: REQ_ID, ...over });
    db.orderChangeRequest.findFirst.mockResolvedValue({ ...r, orderId: 'o1', order: { ...r.order, claimedById: null, ...orderOver } });
  };
  const approve = () => decidePATCH(json({ decision: 'APPROVED' }), params);
  const reject = () => decidePATCH(json({ decision: 'REJECTED', note: 'مستحيل' }), params);
  const MONEY = { quantity: { from: 2, to: 3 } };
  const NOT_MONEY = { customerNotes: { from: 'a', to: 'b' } };

  it('THE DESK: approves a request that moves a figure only with the price key', async () => {
    pending({ changes: MONEY });
    await as(['control.change_requests']);
    const res = await approve();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PRICE_KEY_REQUIRED');
    expect(db.$transaction).not.toHaveBeenCalled();
    await as(['control.change_requests', 'orders.change_price']);
    expect((await approve()).status).toBe(200);
  });

  it('REJECTING never needs it — refusing a figure changes none', async () => {
    pending({ changes: MONEY });
    await as(['control.change_requests']);
    expect((await reject()).status).toBe(200);
  });

  it('a request that moves nothing of the kind never needs it', async () => {
    pending({ changes: NOT_MONEY });
    await as(['control.change_requests']);
    expect((await approve()).status).toBe(200);
  });

  it('every money field counts: the price, the discount, the quantity and the product', async () => {
    await as(['control.change_requests']);
    for (const field of ['sellingPrice', 'discountAmount', 'quantity', 'productId']) {
      pending({ changes: { [field]: { from: 1, to: 2 } } });
      const res = await approve();
      expect(res.status, field).toBe(403);
      expect((await res.json()).code, field).toBe('PRICE_KEY_REQUIRED');
    }
    // and the fields that move no figure do not
    for (const field of ['customerName', 'customerPhone', 'customerAltPhone', 'customerAddress', 'regionId', 'customerNotes']) {
      pending({ changes: { [field]: { from: 'a', to: 'b' } } });
      expect((await approve()).status, field).toBe(200);
    }
  });

  it('THE AGENT HOLDING THE ORDER: the same rule, on an order not yet confirmed', async () => {
    pending({ changes: MONEY }, { confirmationStatus: 'IN_PROGRESS', claimedById: 'u1' });
    await as([]); // she holds the order and nothing else
    const res = await approve();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PRICE_KEY_REQUIRED');
    await as(['orders.change_price']);
    expect((await approve()).status).toBe(200);
    // NEGATIVE: somebody else’s order is still not hers, price key or not
    pending({ changes: MONEY }, { confirmationStatus: 'IN_PROGRESS', claimedById: 'someone-else' });
    const other = await approve();
    expect(other.status).toBe(403);
    expect((await other.json()).code).toBe('NOT_THE_DECIDER');
  });

  it('THE PACKING TABLE: the decide key, and the price key for a figure — and neither the old key nor the old name opens it', async () => {
    pending({ changes: NOT_MONEY }, { confirmationStatus: 'CONFIRMED' });
    await as(['ops.decide_changes']);
    expect((await approve()).status).toBe(200);
    // a figure needs the price key too
    pending({ changes: MONEY }, { confirmationStatus: 'CONFIRMED' });
    const res = await approve();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PRICE_KEY_REQUIRED');
    await as(['ops.decide_changes', 'orders.change_price']);
    expect((await approve()).status).toBe(200);
    // NEGATIVE: the old packing key alone
    pending({ changes: NOT_MONEY }, { confirmationStatus: 'CONFIRMED' });
    await as(['ops.ship', 'orders.change_price']);
    const old = await approve();
    expect(old.status).toBe(403);
    expect((await old.json()).code).toBe('NOT_THE_DECIDER');
    // NEGATIVE: the name WAREHOUSE with no key decides nothing
    await as([], 'WAREHOUSE');
    const named = await approve();
    expect(named.status).toBe(403);
    expect((await named.json()).code).toBe('NOT_THE_DECIDER');
  });

  it('NEGATIVE: the packing table does not decide once the courier has the parcel — the key or not', async () => {
    pending({ changes: NOT_MONEY }, { confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', shippedAt: new Date() });
    await as(['ops.decide_changes', 'orders.change_price']);
    const res = await approve();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_THE_DECIDER');
  });

  it('NEGATIVE: nobody approves their own request — with every key there is', async () => {
    pending({ changes: MONEY, requestedById: 'u1' });
    await as(['control.change_requests', 'orders.change_price', 'ops.decide_changes']);
    const res = await approve();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SELF_APPROVAL');
  });
});

// ───────────────────────────── raising one ─────────────────────────────

describe('raising a request: it decides itself only when its raiser may', () => {
  const order = { id: 'o1', companyId: 'c1', storeId: 's1', orderNumber: 'JO-1', confirmationStatus: 'IN_PROGRESS', claimedById: 'u1', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null };
  const raise = (changes: Record<string, unknown>) =>
    raisePOST(json({ changes, reason: 'الزبون طلب تعديلاً' }, 'POST'), { params: Promise.resolve({ id: 'o1' }) });

  beforeEach(() => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order });
    db.orderChangeRequest.findFirst.mockResolvedValue(null);
    db.orderChangeRequest.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'cr1', ...data }));
    db.order.findFirst.mockResolvedValue({
      quantity: 2, productId: 'p1', sellingPrice: 20, discountAmount: 0, customerNotes: null, regionId: null, deliveryAddress: null,
      customer: { fullName: 'أحمد', phone: '0791234567', altPhone: null, address: 'عمان', city: 'عمان' },
    });
  });

  it('a figure, by a raiser who holds the order AND the price key: decided as she raises it', async () => {
    await as(['orders.request_change', 'orders.change_price']);
    const res = await raise({ quantity: { to: 3 } });
    expect(res.status).toBe(201);
    expect((await res.json()).readyToApply).toBe(true);
    expect(db.orderChangeRequest.update).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: the same figure by a raiser without the price key waits for somebody who holds it — and the answer says so', async () => {
    await as(['orders.request_change']);
    const res = await raise({ quantity: { to: 3 } });
    expect(res.status).toBe(201);
    expect((await res.json()).readyToApply).toBe(false);
    expect(db.orderChangeRequest.update, 'بتَّ في سعرٍ بلا مفتاحه').not.toHaveBeenCalled();
  });

  it('a request that moves no figure is decided as before, price key or not', async () => {
    await as(['orders.request_change']);
    const res = await raise({ customerNotes: { to: 'ملاحظة' } });
    expect((await res.json()).readyToApply).toBe(true);
    expect(db.orderChangeRequest.update).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: somebody else’s order still waits, with every key', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...order, claimedById: 'someone-else' } });
    await as(['orders.request_change', 'orders.change_price']);
    expect((await (await raise({ quantity: { to: 3 } })).json()).readyToApply).toBe(false);
  });
});

describe('who is TOLD about a request after confirmation', () => {
  const order = { id: 'o1', companyId: 'c1', storeId: 's1', orderNumber: 'JO-1', confirmationStatus: 'CONFIRMED', claimedById: null, shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null };

  it('the holders of the decision key — a permission and nothing else, no list of role names', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order });
    db.orderChangeRequest.findFirst.mockResolvedValue(null);
    db.orderChangeRequest.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'cr1', ...data }));
    db.order.findFirst.mockResolvedValue({
      quantity: 2, productId: 'p1', sellingPrice: 20, discountAmount: 0, customerNotes: null, regionId: null, deliveryAddress: null,
      customer: { fullName: 'أحمد', phone: '0791234567', altPhone: null, address: 'عمان', city: 'عمان' },
    });
    await as(['orders.request_change']);
    await raisePOST(json({ changes: { quantity: { to: 3 } }, reason: 'الزبون طلب ثلاثة' }, 'POST'), { params: Promise.resolve({ id: 'o1' }) });
    await vi.waitFor(() => expect(createNotification).toHaveBeenCalledTimes(1));
    const audience = (createNotification.mock.calls[0] as unknown as [{ audience: Record<string, unknown> }])[0].audience;
    expect(audience).toEqual({ permission: 'control.change_requests' });
    expect(audience).not.toHaveProperty('roles');
  });
});
