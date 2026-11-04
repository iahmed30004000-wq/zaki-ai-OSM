import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «مساعد الاتصال» — THE READING DOOR.
 *
 *   · a token that is unknown, revoked, or whose person is not ACTIVE → 401 (the app forgets its pairing);
 *   · an order of another company, outside the work door, not held by an agent who must hold, or whose customer is
 *     not the number dialled → refused, without spelling out why;
 *   · the same reading twice is one row, unchanged;
 *   · numbers out of range → 400;
 *   · and a reading writes NOTHING on the order: no contact attempt, no state, no count.
 */

const TOKEN = ['fake', 'device', 'token', 'for', 'tests'].join('_').padEnd(43, 'k');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const { db, state, door } = vi.hoisted(() => {
  const state = {
    device: null as null | { id: string; companyId: string; userId: string; revokedAt: Date | null },
    user: null as null | { id: string; role: string; status: string; companyId: string | null },
    perms: new Set<string>(),
    orders: [] as { id: string; companyId: string; storeId: string; customerId: string; claimedById: string | null }[],
    customers: new Map<string, { phone: string; rawPhone: string }>(),
    readings: [] as Record<string, unknown>[],
    standing: true,
  };
  const door = { open: true, calls: [] as unknown[][] };
  const db = {
    callHelperDevice: {
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) =>
        state.device && where.tokenHash === (state.device as { tokenHash?: string }).tokenHash ? state.device : null
      ),
      update: vi.fn(async () => ({})),
    },
    order: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; companyId: string } }) => {
        const o = state.orders.find((x) => x.id === where.id && x.companyId === where.companyId);
        return o ? { storeId: o.storeId, store: { countryId: 'co-sy' } } : null;
      }),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    customer: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => state.customers.get(where.id) ?? null),
    },
    callHelperReading: {
      upsert: vi.fn(async ({ where, create }: { where: { deviceId_orderId_startedAt: Record<string, unknown> }; create: Record<string, unknown> }) => {
        const k = where.deviceId_orderId_startedAt;
        const found = state.readings.find(
          (r) => r.deviceId === k.deviceId && r.orderId === k.orderId && (r.startedAt as Date).getTime() === (k.startedAt as Date).getTime()
        );
        if (found) return found;
        state.readings.push(create);
        return create;
      }),
    },
    orderContactAttempt: { create: vi.fn(), createMany: vi.fn() },
    orderStatusLog: { create: vi.fn() },
  };
  return { db, state, door };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({
  sessionUserFor: async (id: string) => (state.user && state.user.id === id ? { ...state.user } : null),
  requireCompanyTenant: async () => {
    throw new Error('Unauthorized');
  },
}));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, k: string) => state.perms.has(k) }));
vi.mock('@/lib/geo-context', () => ({
  validateSelection: async () => {
    if (!state.standing) throw new Error('Forbidden: store not accessible in this country');
    return {};
  },
}));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: async (...args: unknown[]) => {
    door.calls.push(args);
    const o = state.orders.find((x) => x.id === args[0]);
    if (!o) return { allowed: false, reason: 'NOT_FOUND' };
    return door.open ? { allowed: true, order: o } : { allowed: false, reason: 'NOT_ASSIGNED' };
  },
}));

import { POST } from './route';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';

const now = Date.now();
const good = { orderId: 'ord1', phone: '963933123456', startedAt: now - 90_000, answered: true, talkSeconds: 133, ringSeconds: 6 };
const send = (body: unknown, token: string | null = TOKEN) =>
  POST(
    new Request('http://localhost/api/call-helper/reading', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  );

const nothingWrittenOnTheOrder = () => {
  expect(db.orderContactAttempt.create).not.toHaveBeenCalled();
  expect(db.orderContactAttempt.createMany).not.toHaveBeenCalled();
  expect(db.order.update).not.toHaveBeenCalled();
  expect(db.order.updateMany).not.toHaveBeenCalled();
  expect(db.orderStatusLog.create).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  state.device = { id: 'dev1', companyId: 'co1', userId: 'u1', revokedAt: null, tokenHash: sha(TOKEN) } as typeof state.device;
  state.user = { id: 'u1', role: 'CONFIRMATION_AGENT', status: 'ACTIVE', companyId: 'co1' };
  state.perms = new Set(['confirmation.work']);
  state.orders = [
    { id: 'ord1', companyId: 'co1', storeId: 's1', customerId: 'cu1', claimedById: 'u1' },
    { id: 'ord2', companyId: 'co2', storeId: 's9', customerId: 'cu2', claimedById: 'u1' },
    { id: 'ord3', companyId: 'co1', storeId: 's1', customerId: 'cu1', claimedById: 'u7' },
  ];
  state.customers = new Map([
    ['cu1', { phone: '0933123456', rawPhone: '0933 123 456' }],
    ['cu2', { phone: '0933123456', rawPhone: '0933123456' }],
  ]);
  state.readings = [];
  state.standing = true;
  door.open = true;
  door.calls = [];
});

describe('the token', () => {
  it('a good one: the reading is kept, through the work door', async () => {
    const res = await send(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.readings).toHaveLength(1);
    expect(state.readings[0]).toMatchObject({ companyId: 'co1', userId: 'u1', deviceId: 'dev1', orderId: 'ord1', answered: true, talkSeconds: 133, ringSeconds: 6 });
    // The number is compared, never stored.
    expect(JSON.stringify(state.readings[0])).not.toContain('933123456');
    expect(door.calls[0][2]).toEqual({ companyId: 'co1', storeId: 's1' });
    expect(door.calls[0][3]).toBe(ORDER_WORK_DOOR);
    expect(db.callHelperDevice.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'dev1' } }));
    nothingWrittenOnTheOrder();
  });

  it('none, unknown or revoked: 401', async () => {
    expect((await send(good, null)).status).toBe(401);
    expect((await send(good, 'x'.repeat(43))).status).toBe(401);
    state.device!.revokedAt = new Date();
    expect((await send(good)).status).toBe(401);
    expect(state.readings).toHaveLength(0);
  });

  it('her account no longer ACTIVE, or moved to another company: 401', async () => {
    state.user!.status = 'SUSPENDED';
    expect((await send(good)).status).toBe(401);
    state.user!.status = 'ACTIVE';
    state.user!.companyId = 'co2';
    expect((await send(good)).status).toBe(401);
    expect(state.readings).toHaveLength(0);
  });
});

describe('the order', () => {
  it('of another company: refused, and the door is never asked', async () => {
    const res = await send({ ...good, orderId: 'ord2' });
    expect(res.status).toBe(404);
    expect(door.calls).toHaveLength(0);
    expect(state.readings).toHaveLength(0);
  });

  it('in a store she may not stand in: refused', async () => {
    state.standing = false;
    expect((await send(good)).status).toBe(404);
    expect(state.readings).toHaveLength(0);
  });

  it('outside the work door: refused', async () => {
    door.open = false;
    expect((await send(good)).status).toBe(404);
    expect(state.readings).toHaveLength(0);
  });

  it('a colleague’s, for an agent who must hold what she works: refused', async () => {
    const res = await send({ ...good, orderId: 'ord3' });
    expect(res.status).toBe(403);
    expect(state.readings).toHaveLength(0);
  });

  it('whose customer is not the number dialled: refused, without saying which', async () => {
    const res = await send({ ...good, phone: '963944000111' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).not.toMatch(/رقم/);
    expect(state.readings).toHaveLength(0);
  });
});

describe('the reading itself', () => {
  it('sent twice is one row, and the first stays as it was', async () => {
    expect((await send(good)).status).toBe(200);
    expect((await send({ ...good, answered: false, talkSeconds: 0 })).status).toBe(200);
    expect(state.readings).toHaveLength(1);
    expect(state.readings[0]).toMatchObject({ answered: true, talkSeconds: 133 });
    nothingWrittenOnTheOrder();
  });

  it('with numbers out of range: 400, nothing kept', async () => {
    for (const bad of [{ talkSeconds: 4 * 3600 + 1 }, { ringSeconds: 11 * 60 }, { talkSeconds: -3 }, { startedAt: now - 25 * 3600 * 1000 }, { startedAt: now + 10 * 60_000 }]) {
      expect((await send({ ...good, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(state.readings).toHaveLength(0);
  });
});

describe('the door’s own source', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/api/call-helper/reading/route.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('names no table but its own and the device’s for a write', () => {
    expect(src).not.toMatch(/orderContactAttempt|orderStatusLog|commission|db\.order\.(update|updateMany|upsert|create)/);
    expect(src).not.toMatch(/tx\./);
  });
});
