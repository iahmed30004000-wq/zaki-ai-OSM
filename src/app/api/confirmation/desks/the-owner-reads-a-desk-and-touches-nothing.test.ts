import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «شاشة موظفة» — THE DESK DOOR, READ AS SOMEBODY ELSE, THROUGH THE REAL ENGINE.
 *
 * The owner, 2/11: «مركز التأكيد ضروري اشوف انا ك مالك شاشات البنات». The desk door
 * (`GET /api/confirmation/mine`) reads `?agent=` for a watcher (desk-watch.ts) and
 * answers that agent's desk. Nothing about permissions is mocked: every person is
 * built the way a session is (`computeEffectiveGrants` → `attachGrants`) and the
 * REAL `can` / `getPermissionScope` answer. Only the database, the store-reach
 * lookup (`resolveAudience`, its own tests elsewhere) and the side effects are
 * stubbed — and the stub of the reach lookup answers by company, store and
 * status, so a door that asked the wrong question gets the wrong person back.
 *
 * The agent's keys are the LIVE ones (read on the live site on 1/11, see
 * the-live-agent-is-refused-by-the-real-engine.test.ts): she carries
 * `confirmation.supervise`, which is why the door does not open on it.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;

const { state, db, handedOut, resolveAudience } = vi.hoisted(() => {
  const state = {
    user: null as unknown as SessionUser,
    storeId: 's1',
    /** Every `where` the desk door asked of the orders table. */
    wheres: [] as Row[],
    orders: [] as Row[],
    people: [] as { id: string; name: string; companyId: string; stores: string[]; status: string; works: boolean }[],
  };
  const pick = (where: Row) => state.orders.filter((o) => o.claimedById === where.claimedById && o.storeId === where.storeId);
  const db = {
    order: {
      findMany: vi.fn(async (q: { where: Row }) => {
        state.wheres.push(q.where);
        return pick(q.where);
      }),
      count: vi.fn(async (q: { where: Row }) => {
        state.wheres.push(q.where);
        return pick(q.where).length;
      }),
      groupBy: vi.fn(async (q: { where: { claimedById: { in: string[] }; storeId: string } }) =>
        q.where.claimedById.in.map((id) => ({
          claimedById: id,
          _count: { _all: state.orders.filter((o) => o.claimedById === id && o.storeId === q.where.storeId).length },
        }))
      ),
    },
    orderContactAttempt: { groupBy: vi.fn(async () => []) },
  };
  /** The reach rule, as data: ACTIVE, this company, this store; a permission is the `works` flag. */
  const resolveAudience = vi.fn(
    async (q: { companyId: string; storeId: string; audience: { userIds?: string[]; permission?: string }; actorId?: string }) =>
      state.people
        .filter((p) => p.companyId === q.companyId && p.status === 'ACTIVE' && p.stores.includes(q.storeId))
        .filter((p) => p.id !== q.actorId)
        .filter((p) => (q.audience.userIds ?? []).includes(p.id) || (q.audience.permission === 'confirmation.work' && p.works))
        .map((p) => ({ id: p.id, name: p.name, role: 'CONFIRMATION_AGENT', status: 'ACTIVE', companyId: p.companyId, permissions: [] }))
  );
  return { state, db, handedOut: vi.fn(), resolveAudience };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: state.user,
    companyId: 'c1',
    storeId: state.storeId,
    countryId: 'co1',
    // The store's calendar too (the schema gives every country one): the owner's desk now counts what a return would take, on it.
    country: { id: 'co1', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  }),
}));
// `requirePermission` is the real one; only the session it reads is this test's.
vi.mock('@/lib/auth', () => ({ requireAuth: async () => state.user }));
vi.mock('@/lib/notification-audience', () => ({ resolveAudience }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: handedOut }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/customer-risk', () => ({ customerRisk: async () => null, customerRiskMany: async () => new Map() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import * as mineRoute from '@/app/api/confirmation/mine/route';
import * as desksRoute from '@/app/api/confirmation/desks/route';

/** CONFIRMATION_AGENT, live, 1/11: all 22 keys, every one at the whole company. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** The CONFIRMATION_SUPERVISOR template (migration 20260919205403): supervise and all orders, no team.monitor. */
const SUPERVISOR = ['confirmation.work', 'confirmation.supervise', 'confirmation.issues', 'orders.view', 'customers.view_basic', 'reports.view', 'dashboard.view'];
/** A manager the owner ticked «متابعة أداء الفريق» for, seeing every order. */
const WATCHER = ['team.monitor', 'orders.view', 'confirmation.supervise'];

async function person(id: string, role: string, keys: string[], scope: Record<string, string> = {}): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: scope[k] ?? 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const order = (id: string, claimedById: string, storeId = 's1'): Row => ({
  id, orderNumber: id, claimedById, storeId, confirmationStatus: 'IN_PROGRESS', version: 1,
  customer: { id: `cu-${id}`, fullName: 'زبون', phone: '0999', rawPhone: '0999', city: 'دمشق', address: 'شارع', totalOrders: 1 },
  items: [], addOns: [], _count: { contactAttempts: 0, notes: 0 },
});

const mine = (qs = '') => mineRoute.GET(new Request(`http://x/api/confirmation/mine${qs}`));

beforeEach(() => {
  vi.clearAllMocks();
  state.storeId = 's1';
  state.wheres = [];
  state.orders = [order('O-SARA-1', 'sara'), order('O-SARA-2', 'sara'), order('O-HIND-1', 'hind'), order('O-ME-1', 'abeer')];
  state.people = [
    { id: 'sara', name: 'سارة', companyId: 'c1', stores: ['s1'], status: 'ACTIVE', works: true },
    { id: 'hind', name: 'هند', companyId: 'c1', stores: ['s1'], status: 'ACTIVE', works: true },
    { id: 'abeer', name: 'عبير', companyId: 'c1', stores: ['s1'], status: 'ACTIVE', works: true },
    { id: 'rana', name: 'رنا', companyId: 'c1', stores: ['s2'], status: 'ACTIVE', works: true },
    { id: 'gone', name: 'منى', companyId: 'c1', stores: ['s1'], status: 'INACTIVE', works: true },
    { id: 'stranger', name: 'غريبة', companyId: 'c2', stores: ['s1'], status: 'ACTIVE', works: true },
    { id: 'mod', name: 'مودريتور', companyId: 'c1', stores: ['s1'], status: 'ACTIVE', works: false },
  ];
});

const ids = (body: { work: { id: string }[] }) => body.work.map((o) => o.id).sort();

describe('the watcher reads a colleague’s desk', () => {
  it('the owner (SUPER_ADMIN) asks for Sara’s desk and gets HER orders, marked read-only, under her name', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    const res = await mine('?agent=sara');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ids(body)).toEqual(['O-SARA-1', 'O-SARA-2']);
    expect(body.viewing).toEqual({ id: 'sara', name: 'سارة', readOnly: true });
    // Every question the door asked was asked of HER claim, in THIS store and company.
    expect(state.wheres.length).toBeGreaterThan(0);
    for (const w of state.wheres) expect(w).toMatchObject({ companyId: 'c1', storeId: 's1', claimedById: 'sara' });
  });

  it('a manager with «متابعة أداء الفريق» and every order in sight reads it too — without `confirmation.work`', async () => {
    state.user = await person('manager', 'MANAGER', WATCHER);
    const res = await mine('?agent=hind');
    expect(res.status).toBe(200);
    expect(ids(await res.json())).toEqual(['O-HIND-1']);
  });

  it('the customer data handed out is tallied against the WATCHER, under «شاشة موظفة»', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    await mine('?agent=sara');
    expect(handedOut).toHaveBeenCalledTimes(1);
    const arg = handedOut.mock.calls[0][0] as { user: SessionUser; where: string };
    expect(arg.user.id).toBe('owner');
    expect(arg.where).toBe('شاشة موظفة');
  });

  it('the reach is asked for the viewer’s company and store, about the one id asked', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    await mine('?agent=sara');
    expect(resolveAudience).toHaveBeenCalledWith({ companyId: 'c1', storeId: 's1', audience: { userIds: ['sara'] } });
  });
});

describe('NEGATIVE: who may not watch — 403, and no order is read', () => {
  it('a LIVE agent (she carries `confirmation.supervise`) asking for a colleague’s desk', async () => {
    state.user = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await mine('?agent=sara');
    expect(res.status).toBe(403);
    expect(state.wheres).toEqual([]);
    expect(handedOut).not.toHaveBeenCalled();
  });

  it('the supervisor template — supervise, every order, but no «متابعة أداء الفريق»', async () => {
    state.user = await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR);
    expect((await mine('?agent=sara')).status).toBe(403);
    expect(state.wheres).toEqual([]);
  });

  it('«متابعة أداء الفريق» without every order in sight («المسندة إليه»)', async () => {
    state.user = await person('lead', 'MANAGER', WATCHER, { 'orders.view': 'ASSIGNED' });
    expect((await mine('?agent=sara')).status).toBe(403);
    expect(state.wheres).toEqual([]);
  });

  it('«متابعة أداء الفريق» without «عرض الطلبات» at all', async () => {
    state.user = await person('hr', 'MANAGER', ['team.monitor']);
    expect((await mine('?agent=sara')).status).toBe(403);
  });
});

describe('NEGATIVE: whose desk may not be read — 404, and no order is read', () => {
  for (const [who, why] of [
    ['stranger', 'an agent of another company'],
    ['rana', 'an agent of this company who cannot enter this store'],
    ['gone', 'a deactivated account'],
    ['nobody', 'an id nobody has'],
    ['../users', 'something that is not an id'],
  ] as const) {
    it(`${why} («${who}»)`, async () => {
      state.user = await person('owner', 'SUPER_ADMIN', []);
      const res = await mine(`?agent=${encodeURIComponent(who)}`);
      expect(res.status).toBe(404);
      expect(state.wheres).toEqual([]);
    });
  }

  it('something that is not an id is refused before anybody is looked up', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    for (const bad of ['../users', 'a b', 'x'.repeat(65), "sara' OR 1=1"]) {
      expect((await mine(`?agent=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
    }
    expect(resolveAudience).not.toHaveBeenCalled();
  });
});

describe('WITHOUT `?agent=` the door is what it was', () => {
  it('the agent gets her own desk — her claim only, no `viewing`, the same keys in the answer', async () => {
    state.user = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await mine();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ids(body)).toEqual(['O-ME-1']);
    expect(body).not.toHaveProperty('viewing');
    expect(Object.keys(body).sort()).toEqual(
      // `due` is «الشغل أول» (8/11): how many calls she owes, the oldest, and the banner's sentence.
      ['closedToday', 'confirmed', 'dialCode', 'due', 'leadDays', 'noAnswer', 'noAnswerLimit', 'serverNow', 'waitingLater', 'work'].sort()
    );
    for (const w of state.wheres) expect(w).toMatchObject({ claimedById: 'abeer' });
    expect((handedOut.mock.calls[0][0] as { where: string }).where).toBe('طلباتي');
    expect(resolveAudience).not.toHaveBeenCalled();
  });

  it('`?agent=` naming herself is her own desk too — no `viewing`, and no watching key needed', async () => {
    state.user = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await mine('?agent=abeer');
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('viewing');
  });

  it('an empty `?agent=` is no agent', async () => {
    state.user = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await mine('?agent=');
    expect(res.status).toBe(200);
    expect(ids(await res.json())).toEqual(['O-ME-1']);
  });

  it('a watcher with no `confirmation.work` is still refused his OWN desk, as before', async () => {
    state.user = await person('manager', 'MANAGER', WATCHER);
    expect((await mine()).status).toBe(403);
  });

  it('a watcher who works confirmation and sends no agent gets HIS desk, not anybody else’s', async () => {
    state.user = await person('sara', 'CONFIRMATION_SUPERVISOR', [...SUPERVISOR, 'team.monitor']);
    const body = await (await mine()).json();
    expect(ids(body)).toEqual(['O-SARA-1', 'O-SARA-2']);
    expect(body).not.toHaveProperty('viewing');
  });
});

describe('the picker’s list (`GET /api/confirmation/desks`)', () => {
  it('names whoever works confirmation in this store — not the viewer, not another store, not another company, not a deactivated account, not a moderator', async () => {
    state.user = await person('abeer', 'CONFIRMATION_SUPERVISOR', [...SUPERVISOR, 'team.monitor']);
    const res = await desksRoute.GET();
    expect(res.status).toBe(200);
    const { agents } = await res.json();
    expect(agents).toEqual([
      { id: 'sara', name: 'سارة', holding: 2 },
      { id: 'hind', name: 'هند', holding: 1 },
    ]);
  });

  it('NEGATIVE: the live agent, the supervisor template and a watcher who does not see every order are refused it', async () => {
    for (const u of [
      await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT),
      await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR),
      await person('lead', 'MANAGER', WATCHER, { 'orders.view': 'ASSIGNED' }),
    ]) {
      state.user = u;
      const res = await desksRoute.GET();
      expect(res.status, u.id).toBe(403);
    }
    expect(resolveAudience).not.toHaveBeenCalled();
  });
});
