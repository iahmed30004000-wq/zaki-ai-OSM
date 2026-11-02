import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — AN ORDER IS HANDED ONLY TO HANDS THAT CAN WORK IT, AND THE LIST AND THE DOOR AGREE TO THE LETTER
 * (the independent review of #154, 2/11 — BACKLOG RV567)
 *
 * Whoever assigns (`orders.assign`) hands an order to anybody who «can work it». That was ONE key, `confirmation.work` — and the
 * CONFIRMATION_SUPERVISOR template holds it (it works a queue to watch it) with no `confirmation.pull`, no `orders.confirm` and no
 * `orders.contact_log`: she was offered, and received, an order she could neither confirm nor ring.
 *
 *  1. a target can work the order only when she holds `confirmation.work` AND `confirmation.pull` AND `orders.confirm` — asked of the
 *     sessions the existing audience resolver already built (no query of its own, in memory);
 *  2. `GET` offers exactly the people `POST` accepts, for every kind of account there is: the live agent, the supervisor template, a
 *     follow-up agent, a warehouse account, a manager, an owner, a person with a personal «سماح», a person with a personal «منع»;
 *  3. the warehouse (and every other account that cannot work it) stays refused with `CANNOT_WORK_IT`;
 *  4. an agent giving her own order up to a colleague of her role is not touched (rank, not keys).
 *
 * Nothing about permissions is mocked: the REAL audience resolver builds every candidate's grants with the REAL engine from the role
 * rows and overrides below; only Prisma is a small in-memory company. A role-name list could not pass this.
 *
 * Blockers: no money, no order creation.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, state, requireContext, assertOrderAccess, logAudit } = vi.hoisted(() => {
  const state = {
    users: [] as Array<Record<string, unknown>>,
    roleRows: {} as Record<string, Array<{ permission: string; scope: string; scopeIds: null }>>,
    overrides: [] as Array<{ userId: string; permission: string; effect: string; scope: null; scopeIds: null }>,
  };
  const db = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.users.find((u) => u.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { companyId: string; status?: string } }) =>
        state.users.filter((u) => u.companyId === where.companyId && (!where.status || u.status === where.status))
      ),
    },
    userPermission: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) => state.overrides.filter((o) => where.userId.in.includes(o.userId))),
    },
    rolePermission: {
      findMany: vi.fn(async ({ where }: { where: { roleId?: string; role?: { name: string } } }) => state.roleRows[where.roleId ?? where.role!.name] ?? []),
    },
    order: { updateMany: vi.fn(), findUnique: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
  };
  return { db, state, requireContext: vi.fn(), assertOrderAccess: vi.fn(), logAudit: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: (...a: unknown[]) => requireContext(...a),
  // Everybody may enter the store here — the store narrowing has its own test (notification-audience.test.ts).
  usersReachingStore: async (users: Array<{ id: string }>) => new Set(users.map((u) => u.id)),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/order-locks', () => ({ ownershipSnapshot: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { GET, POST } from './route';

const grants = (...keys: string[]) => keys.map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null }));

/** CONFIRMATION_AGENT, live, 1/11 (`GET /api/roles`): all 22 keys at the whole company. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/**
 * CONFIRMATION_SUPERVISOR as the stage-2 migration shipped it (+ the boxes PR-7 gave whoever held `confirmation.supervise`): work and
 * supervise — and NO `confirmation.pull`, NO `orders.confirm`, NO `orders.contact_log`. A subset where the migration is the source.
 */
const SUPERVISOR = [
  'confirmation.work', 'confirmation.supervise', 'confirmation.issues', 'confirmation.winback', 'confirmation.reassign', 'control.change_requests',
  'control.discount_alerts', 'orders.view', 'customers.view_basic', 'reports.view', 'dashboard.view',
];
/** FOLLOW_UP_AGENT as the permission-engine, stage-2 and followup-sees-issues migrations shipped it (+ `orders.contact_log`): work and pull, and it «cannot reverse confirmation decisions» — no `orders.confirm`. */
const FOLLOW_UP = [
  'confirmation.pull', 'confirmation.work', 'confirmation.issues', 'orders.view', 'orders.edit', 'orders.claim', 'orders.release', 'orders.contact_log',
  'customers.view_basic', 'products.view', 'dashboard.view',
];
const WAREHOUSE = ['ops.prepare', 'ops.labels', 'ops.returns', 'inventory.view', 'inventory.adjust', 'dashboard.view'];
/** MANAGER, live, cut to what matters (takes any order, hands any out, supervises) — it holds NO `confirmation.work`. */
const LIVE_MANAGER = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.assign', 'orders.unlock', 'confirmation.supervise'];
/** A manager the owner also made a working agent: the manager's keys + the pull + the desk. */
const WORKING_MANAGER = [...LIVE_MANAGER, 'confirmation.work', 'confirmation.pull'];
const MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.claim'];

const u = (id: string, name: string, role: string, roleId: string, over: Record<string, unknown> = {}) => ({
  id, name, email: `${id}@x.test`, role, roleId, status: 'ACTIVE', companyId: 'c1', ...over,
});

async function sessionOf(id: string, role: string, roleId: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, { roleRows: async () => grants(...keys), overrideRows: async () => [] })
  );
}

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const params = { params: Promise.resolve({ id: ORDER_ID }) };
const HOLDER = u('holder', 'نجلاء', 'MODERATOR', 'role-mod');

const world = () => {
  state.roleRows = {
    'role-agent': grants(...LIVE_AGENT), 'role-sup': grants(...SUPERVISOR), 'role-follow': grants(...FOLLOW_UP), 'role-wh': grants(...WAREHOUSE),
    'role-mgr': grants(...LIVE_MANAGER), 'role-deputy': grants(...WORKING_MANAGER), 'role-mod': grants(...MODERATOR),
  };
  state.users = [
    HOLDER,
    u('abeer', 'عبير', 'CONFIRMATION_AGENT', 'role-agent'),
    u('layla', 'ليلى', 'CONFIRMATION_AGENT', 'role-agent'),
    u('sup', 'سوسن', 'CONFIRMATION_SUPERVISOR', 'role-sup'),
    u('follow', 'فادي', 'FOLLOW_UP_AGENT', 'role-follow'),
    u('wh', 'أبو أحمد', 'WAREHOUSE', 'role-wh'),
    u('mgr', 'المدير', 'MANAGER', 'role-mgr'),
    u('deputy', 'نائبة', 'MANAGER', 'role-deputy'),
    // The owner: SUPER_ADMIN holds every key.
    u('owner', 'المالك', 'SUPER_ADMIN', 'role-none'),
    // A warehouse account the owner ticked the three boxes for, personally («سماح»).
    u('allowed', 'سالم', 'WAREHOUSE', 'role-wh'),
    // A live agent the owner took `orders.confirm` from, personally («منع»).
    u('denied', 'دانة', 'CONFIRMATION_AGENT', 'role-agent'),
    u('gone', 'غادة', 'CONFIRMATION_AGENT', 'role-agent', { status: 'SUSPENDED' }),
    u('abroad', 'غريب', 'CONFIRMATION_AGENT', 'role-agent', { companyId: 'c2' }),
  ];
  state.overrides = [
    ...['confirmation.work', 'confirmation.pull', 'orders.confirm'].map((permission) => ({ userId: 'allowed', permission, effect: 'ALLOW', scope: null, scopeIds: null })),
    { userId: 'denied', permission: 'orders.confirm', effect: 'DENY', scope: null, scopeIds: null },
  ];
};

/** Who can work an order, as the engine says it — the answer both halves must give. */
const CAN_WORK = ['abeer', 'layla', 'deputy', 'owner', 'allowed'];

const ORDER = {
  id: ORDER_ID, companyId: 'c1', version: 2, status: 'NEW', confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY',
  claimedById: HOLDER.id, currentOwnerId: HOLDER.id,
};

const get = () => GET(new Request('http://localhost/x'), params);
const post = (targetUserId: string) =>
  POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUserId, reason: 'قرار إداري' }) }), params);

async function actAs(user: SessionUser) {
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: ORDER });
}

beforeEach(async () => {
  vi.clearAllMocks();
  world();
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue(ORDER);
  await actAs(await sessionOf('boss', 'COMPANY_ADMIN', 'role-boss', ['orders.view', 'orders.assign', 'orders.unlock']));
});

describe('whoever assigns is offered exactly the people who can work the order', () => {
  it('the list holds the live agents, a working manager, the owner and the person ticked personally — and nobody else', async () => {
    const body = await (await get()).json();
    expect(body.scope).toBe('ANY_AGENT');
    expect(body.candidates.map((c: { id: string }) => c.id).sort()).toEqual([...CAN_WORK].sort());
  });

  it('NOT the supervisor template: she holds `confirmation.work` and can neither confirm nor ring', async () => {
    const ids = (await (await get()).json()).candidates.map((c: { id: string }) => c.id);
    expect(ids).not.toContain('sup');
    expect(SUPERVISOR).toContain('confirmation.work');
    expect(SUPERVISOR).not.toContain('confirmation.pull');
    expect(SUPERVISOR).not.toContain('orders.confirm');
  });

  it('NOT a follow-up agent (work + pull, but no `orders.confirm` — the confirmation door asks it of every action)', async () => {
    const ids = (await (await get()).json()).candidates.map((c: { id: string }) => c.id);
    expect(ids).not.toContain('follow');
    expect(FOLLOW_UP).toContain('confirmation.pull');
    expect(FOLLOW_UP).not.toContain('orders.confirm');
  });

  it('NOT the warehouse, NOT the manager who holds no `confirmation.work`, NOT a suspended or foreign account', async () => {
    const ids = (await (await get()).json()).candidates.map((c: { id: string }) => c.id);
    for (const out of ['wh', 'mgr', 'gone', 'abroad']) expect(ids, out).not.toContain(out);
  });

  it('and a personal «منع» on `orders.confirm` takes a live agent out; a personal «سماح» on the three brings a warehouse account in', async () => {
    const ids = (await (await get()).json()).candidates.map((c: { id: string }) => c.id);
    expect(ids).not.toContain('denied');
    expect(ids).toContain('allowed');
  });

  it('the holder is never offered to herself', async () => {
    state.users.push(u('holder2', 'هدى', 'CONFIRMATION_AGENT', 'role-agent'));
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, claimedById: 'holder2', currentOwnerId: 'holder2' } });
    const ids = (await (await get()).json()).candidates.map((c: { id: string }) => c.id);
    expect(ids).not.toContain('holder2');
  });
});

describe('the door accepts exactly the people the list offers — to the letter', () => {
  it('EVERY account: offered ⇔ accepted (200), and every other one is refused CANNOT_WORK_IT with nothing moved', async () => {
    const offered = new Set<string>((await (await get()).json()).candidates.map((c: { id: string }) => c.id));
    const everyone = state.users.filter((x) => x.id !== HOLDER.id && x.companyId === 'c1' && x.status === 'ACTIVE').map((x) => x.id as string);
    expect(everyone.length, 'the world must hold every kind of account').toBeGreaterThanOrEqual(10);

    for (const id of everyone) {
      db.order.updateMany.mockClear();
      const res = await post(id);
      const body = await res.json();
      if (offered.has(id)) {
        expect(res.status, `${id} was offered and refused: ${JSON.stringify(body)}`).toBe(200);
        expect(db.order.updateMany, id).toHaveBeenCalledTimes(1);
        expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ claimedById: id, currentOwnerId: id, assignedToId: id });
      } else {
        expect(res.status, `${id} was NOT offered and accepted: ${JSON.stringify(body)}`).toBe(409);
        expect(body.code, id).toBe('CANNOT_WORK_IT');
        expect(db.order.updateMany, `${id}: انتقل الطلب لمن لا يقدر يشتغل عليه`).not.toHaveBeenCalled();
      }
    }
    expect([...offered].sort()).toEqual([...CAN_WORK].sort());
  });

  it('the supervisor is refused in a sentence that names the three boxes, so the owner knows what to tick', async () => {
    const res = await post('sup');
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('CANNOT_WORK_IT');
    expect(body.errorAr).toContain('سوسن');
    for (const box of ['العمل على طلباتي', 'سحب الطلب التالي', 'تغيير حالة التأكيد']) expect(body.errorAr, box).toContain(box);
    expect(body.errorAr).toContain('موظف تأكيد');
  });

  it('the warehouse stays refused with CANNOT_WORK_IT', async () => {
    const res = await post('wh');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CANNOT_WORK_IT');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('the live agent is handed the order and it lands in her hands, unsigned, as before', async () => {
    const res = await post('abeer');
    expect(res.status).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ claimedById: 'abeer', signatureStatus: 'UNSIGNED', assignedToId: 'abeer' });
    expect(db.orderClaimHistory.create).toHaveBeenCalledTimes(1);
  });
});

describe('the question costs no query of its own — the list is the resolver’s answer, asked in memory', () => {
  it('one read of the users, one of their overrides, and one per DISTINCT role — not one per account', async () => {
    await get();
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    expect(db.userPermission.findMany).toHaveBeenCalledTimes(1);
    const candidates = state.users.filter((x) => x.companyId === 'c1' && x.status === 'ACTIVE' && x.role !== 'SUPER_ADMIN');
    const distinctRoles = new Set(candidates.map((x) => x.roleId)).size;
    expect(db.rolePermission.findMany.mock.calls.length).toBeLessThanOrEqual(distinctRoles);
    expect(db.rolePermission.findMany.mock.calls.length).toBeLessThan(candidates.length);
  });
});

describe('an agent giving her own order up keeps to her rank — keys are not asked', () => {
  it('the live agent hands her order to a colleague of her own role, without the resolver', async () => {
    const abeer = await sessionOf('abeer', 'CONFIRMATION_AGENT', 'role-agent', LIVE_AGENT);
    requireContext.mockResolvedValue({ user: abeer, companyId: 'c1', storeId: 's1' });
    const mine = { ...ORDER, claimedById: 'abeer', currentOwnerId: 'abeer' };
    assertOrderAccess.mockResolvedValue({ allowed: true, order: mine });
    db.order.findUnique.mockResolvedValue(mine);
    const res = await post('layla');
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(db.user.findMany, 'the audience resolver is for whoever assigns').not.toHaveBeenCalled();
  });
});
