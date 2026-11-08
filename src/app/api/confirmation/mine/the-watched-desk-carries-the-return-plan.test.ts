import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the desk door tells the screen what «أرجِع «لا يرد» للطابور» WOULD do, and only to who may press it.
 *
 * The screen draws the button and its question from `returnPile` ({ eligible, limit, thisPress, remainingAfter }) and never
 * counts: «the screen renders and sends; it never decides». The number comes from the very filter the press uses
 * (`returnablePileWhere`), asked of HER claim in THIS store and company.
 *
 *  1. On a colleague’s desk, for a viewer who holds `orders.unlock` (the owner; a manager): `returnPile` is there.
 *  2. Not for a watcher without that key — and then the count is not even asked.
 *  3. Not on her own desk, whoever she is (the owner included): the plan belongs to the watched desk alone.
 *  4. Everything else the door answers is as it was (the keys of her own desk are pinned in the neighbour test).
 *
 * Through the REAL permission engine, as the neighbour test does. Blockers: no money, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;

const { state, db, resolveAudience } = vi.hoisted(() => {
  const state = {
    user: null as unknown as SessionUser,
    wheres: [] as Row[],
    orders: [] as Row[],
    /** What the press’s own filter would find on her desk. */
    returnable: 0,
    /** The store’s country: its work hours and weekend are the calendar «on the phone» and «just taken» are counted on. */
    country: { id: 'co1', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  };
  const pick = (where: Row) => state.orders.filter((o) => o.claimedById === where.claimedById && o.storeId === where.storeId);
  const isThePilesFilter = (where: Row) => !!(where.contactAttempts as { some?: unknown } | undefined)?.some;
  const db = {
    order: {
      findMany: vi.fn(async (q: { where: Row }) => {
        state.wheres.push(q.where);
        return pick(q.where);
      }),
      count: vi.fn(async (q: { where: Row }) => {
        state.wheres.push(q.where);
        return isThePilesFilter(q.where) ? state.returnable : pick(q.where).length;
      }),
    },
    orderContactAttempt: { groupBy: vi.fn(async () => []) },
  };
  const resolveAudience = vi.fn(
    async (q: { companyId: string; storeId: string; audience: { userIds?: string[] } }) =>
      [{ id: 'sara', name: 'سارة' }]
        .filter((p) => (q.audience.userIds ?? []).includes(p.id))
        .map((p) => ({ ...p, role: 'CONFIRMATION_AGENT', status: 'ACTIVE', companyId: q.companyId, permissions: [] }))
  );
  return { state, db, resolveAudience };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: state.user,
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: state.country,
  }),
}));
vi.mock('@/lib/auth', () => ({ requireAuth: async () => state.user }));
vi.mock('@/lib/notification-audience', () => ({ resolveAudience }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/customer-risk', () => ({ customerRisk: async () => null, customerRiskMany: async () => new Map() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import * as mineRoute from '@/app/api/confirmation/mine/route';
import { pileCutoffs, returnablePileWhere } from '@/lib/return-no-answer-pile';

async function person(id: string, role: string, keys: string[], scope: Record<string, string> = {}): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: scope[k] ?? 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const order = (id: string, claimedById: string): Row => ({
  id, orderNumber: id, claimedById, storeId: 's1', confirmationStatus: 'NO_ANSWER', version: 1,
  customer: { id: `cu-${id}`, fullName: 'زبون', phone: '0999', rawPhone: '0999', city: 'دمشق', address: 'شارع', totalOrders: 1 },
  items: [], addOns: [], _count: { contactAttempts: 2, notes: 0 },
});

const mine = (qs = '') => mineRoute.GET(new Request(`http://x/api/confirmation/mine${qs}`));
/** The questions the door asked with the press’s own filter. */
const pileCounts = () => db.order.count.mock.calls.filter(([q]) => !!(q.where.contactAttempts as { some?: unknown } | undefined)?.some);

const MANAGER = ['team.monitor', 'orders.view', 'orders.unlock'];

beforeEach(() => {
  vi.clearAllMocks();
  state.wheres = [];
  state.returnable = 0;
  state.orders = [order('O-SARA-1', 'sara'), order('O-SARA-2', 'sara'), order('O-ME-1', 'owner')];
});

describe('the plan rides on a colleague’s desk', () => {
  it('the owner watching Sara: a plan from the press’s own filter, asked of HER claim in THIS store and company', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    state.returnable = 479;
    const body = await (await mine('?agent=sara')).json();
    expect(body.returnPile).toEqual({ eligible: 479, limit: 200, thisPress: 200, remainingAfter: 279 });
    expect(pileCounts()).toHaveLength(1);
    const where = pileCounts()[0][0].where;
    expect(where).toMatchObject({ companyId: 'c1', storeId: 's1', claimedById: 'sara', shippingStatus: 'NOT_READY' });
    // …and it still says whose desk it is, in exactly the shape it had
    expect(body.viewing).toEqual({ id: 'sara', name: 'سارة', readOnly: true });
  });

  it('a manager with the watching keys AND «تجاوز أقفال التحرير» gets it too, for a small pile', async () => {
    state.user = await person('manager', 'MANAGER', MANAGER);
    state.returnable = 12;
    const body = await (await mine('?agent=sara')).json();
    expect(body.returnPile).toEqual({ eligible: 12, limit: 200, thisPress: 12, remainingAfter: 0 });
  });

  it('a pile with nothing in it is a plan of zero, not an absence (the screen shows a disabled button and says why)', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    state.returnable = 0;
    expect((await (await mine('?agent=sara')).json()).returnPile).toEqual({ eligible: 0, limit: 200, thisPress: 0, remainingAfter: 0 });
  });
});

describe('the count is what a press would take — the press’s own filter, on the store’s working calendar', () => {
  const NOW = new Date('2026-11-08T12:00:00.000Z'); // Sunday 15:00 in Amman
  const asked = async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    await mine('?agent=sara');
    return pileCounts()[0][0].where;
  };

  it('the very filter, with the cut-offs of the store’s calendar at the moment of the read: an order on a call, or just taken, is not in the number', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      const where = await asked();
      expect(where).toEqual(returnablePileWhere({ companyId: 'c1', storeId: 's1' }, 'sara', NOW, pileCutoffs(NOW, state.country)));
      // the two edges themselves, so a different clock cannot hide behind the helper: a quarter of an hour, and ninety minutes
      expect(pileCutoffs(NOW, state.country)).toEqual({ quiet: new Date('2026-11-08T11:45:00.000Z'), held: new Date('2026-11-08T10:30:00.000Z') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('and it is the STORE’S calendar: another weekend gives other edges in the same question', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const mineCountry = state.country;
    try {
      state.country = { ...mineCountry, weekendDays: [0, 6] };
      const where = await asked();
      expect(where).toEqual(returnablePileWhere({ companyId: 'c1', storeId: 's1' }, 'sara', NOW, pileCutoffs(NOW, state.country)));
      expect(where).not.toEqual(returnablePileWhere({ companyId: 'c1', storeId: 's1' }, 'sara', NOW, pileCutoffs(NOW, mineCountry)));
    } finally {
      state.country = mineCountry;
      vi.useRealTimers();
    }
  });
});

describe('and only there, and only for who may press it', () => {
  it('NEGATIVE: a watcher WITHOUT «تجاوز أقفال التحرير» reads the desk and gets no plan — the count is not even asked', async () => {
    state.user = await person('lead', 'MANAGER', ['team.monitor', 'orders.view']);
    state.returnable = 479;
    const res = await mine('?agent=sara');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('returnPile');
    expect(body.viewing).toEqual({ id: 'sara', name: 'سارة', readOnly: true });
    expect(pileCounts()).toHaveLength(0);
  });

  it('NEGATIVE: the owner on HIS OWN desk gets no plan, with or without `?agent=` naming himself', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    state.returnable = 479;
    for (const qs of ['', '?agent=owner', '?agent=']) {
      const body = await (await mine(qs)).json();
      expect(body, qs).not.toHaveProperty('returnPile');
      expect(body, qs).not.toHaveProperty('viewing');
    }
    expect(pileCounts()).toHaveLength(0);
  });

  it('NEGATIVE: a manager’s own desk, the same', async () => {
    state.user = await person('manager', 'MANAGER', [...MANAGER, 'confirmation.work']);
    state.returnable = 5;
    const body = await (await mine()).json();
    expect(body).not.toHaveProperty('returnPile');
    expect(pileCounts()).toHaveLength(0);
  });

  it('NEGATIVE: a holder of «تجاوز أقفال التحرير» who may not watch is refused the desk itself — so no plan leaks', async () => {
    state.user = await person('boss', 'MANAGER', ['orders.unlock', 'orders.view']);
    state.returnable = 479;
    const res = await mine('?agent=sara');
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty('returnPile');
    expect(pileCounts()).toHaveLength(0);
  });
});
