import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (Q2b, 19/11) — `GET /api/confirmation/rules/fired?day=`, through the REAL engine.
 *
 * Nothing about permissions is mocked: the people are found by the door's own lookup (`resolveAudience`) over a fake database
 * that answers role rows by roleId or by a legacy role's template, and personal ALLOW / DENY rows — each person built as her
 * session is (`computeEffectiveGrants` → `can`). The reads of the day run over the same fake.
 *
 *  1. 403 without `settings.view`, 403 without `team.monitor` — and nothing is read.
 *  2. Every person at the desk is in the answer; one with no activity has zeros, not a missing row.
 *  3. The red line: she decided orders that day, «اسحبي أول» does not bind her (a key frees her, or she does not work the desk),
 *     and she is not the owner. NEGATIVE: the bound agent, the owner, an exempt person who decided nothing.
 *  4. Yesterday says «بهاليوم», not «اليوم». A day to come → 400 in Arabic; a malformed day → 400 in Arabic.
 *  5. The refusal log missing → 200 with `refusalLog: false`. No customer field and no order in the answer.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Person = { id: string; name: string; role: string; roleId: string | null; status: string; companyId: string; stores: string[] };
type Override = { userId: string; permission: string; effect: 'ALLOW' | 'DENY' };

const { state, db } = vi.hoisted(() => {
  const state = {
    viewer: null as unknown as SessionUser,
    people: [] as Person[],
    roles: {} as Record<string, { name: string; keys: string[] }>,
    templates: {} as Record<string, string[]>,
    overrides: [] as Override[],
    /** decisions of the day (all in store s1, inside the day): who decided which order */
    decisions: [] as { changedById: string; orderId: string }[],
    pulls: [] as string[],
    refusalsMissing: false,
    reads: 0,
  };
  const pick = (where: Record<string, any>) =>
    state.people.filter(
      (p) =>
        (where.companyId === undefined || p.companyId === where.companyId) &&
        (where.status === undefined || p.status === where.status) &&
        (where.id?.in === undefined || where.id.in.includes(p.id))
    );
  const read = <T,>(v: T) => {
    state.reads += 1;
    return v;
  };
  const db = {
    user: {
      findMany: async ({ where }: { where: Record<string, any> }) =>
        read(
          pick(where).map((p) => ({
            id: p.id, name: p.name, email: `${p.id}@x`, role: p.role, roleId: p.roleId, status: p.status, companyId: p.companyId,
            roleRef: p.roleId ? { name: state.roles[p.roleId]?.name ?? null } : null,
          }))
        ),
    },
    userPermission: {
      findMany: async ({ where }: { where: Record<string, any> }) =>
        state.overrides
          .filter((o) => (where.userId?.in ?? [where.userId]).includes(o.userId))
          .map((o) => ({ userId: o.userId, permission: o.permission, effect: o.effect, scope: o.effect === 'ALLOW' ? 'ALL_COMPANY' : null, scopeIds: null })),
    },
    rolePermission: {
      findMany: async ({ where }: { where: Record<string, any> }) => {
        const keys = where.roleId ? state.roles[where.roleId]?.keys ?? [] : state.templates[where.role?.name] ?? [];
        return keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null }));
      },
    },
    orderClaimHistory: { findMany: async () => read(state.pulls.map((userId) => ({ userId, action: 'CLAIMED', reason: 'PULL_NEXT' }))) },
    orderContactAttempt: { findMany: async () => read([]) },
    orderStatusLog: {
      findMany: async ({ where }: { where: Record<string, any> }) => read(where.newValue ? state.decisions : []),
    },
    auditLog: { findMany: async () => read([]) },
    order: { findMany: async () => read([]) },
    deskRefusal: {
      groupBy: async () => {
        if (state.refusalsMissing) throw new Error('relation "desk_refusals" does not exist');
        return read([{ userId: 'sara', code: 'PULL_TOO_FAST', _count: { _all: 2 } }]);
      },
    },
  };
  return { state, db };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: state.viewer, companyId: 'c1', storeId: 's1', countryId: 'co1', country: { timezone: 'Asia/Damascus' } }),
  usersReachingStore: async (users: { id: string }[], companyId: string, storeId: string) =>
    new Set(users.filter((u) => state.people.find((p) => p.id === u.id && p.companyId === companyId)?.stores.includes(storeId)).map((u) => u.id)),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ allowed: true, remaining: 1, retryAfterSec: 0 }) }));
vi.mock('@/lib/no-answer-cadence-switch', () => ({ cadenceSince: async () => null }));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(state.viewer, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return state.viewer;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { ALARM_OTHER_DAY_AR, ALARM_TODAY_AR, DAY_IN_FUTURE_AR, DAY_INVALID_AR } from '@/lib/rule-fired';
import { GET } from './route';

const AGENT = ['confirmation.pull', 'confirmation.supervise', 'confirmation.work', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.view', 'orders.release'];
const MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.claim', 'orders.release'];
const FOLLOW_UP = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.view', 'orders.release'];
const VIEW = ['settings.view', 'team.monitor'];

async function viewer(keys: string[]): Promise<SessionUser> {
  const base = { id: 'viewer', email: 'v@x', name: 'المدير', role: 'MANAGER', roleId: 'r-viewer', status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => [],
    })
  );
}

const ask = async (day?: string) => {
  const res = await GET(new Request(`http://x/api/confirmation/rules/fired${day ? `?day=${day}` : ''}`) as never);
  return { status: res.status, body: (await res.json()) as any };
};
const row = (body: any, id: string) => body.people.find((p: any) => p.userId === id);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 10:00 of 19/11 in Damascus.
  vi.setSystemTime(new Date('2026-11-19T07:00:00Z'));
  state.roles = { 'r-agent': { name: 'موظفة تأكيد', keys: AGENT }, 'r-mod': { name: 'موديريتور', keys: MODERATOR } };
  state.templates = { FOLLOW_UP_AGENT: FOLLOW_UP };
  state.people = [
    { id: 'sara', name: 'سارة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'idle', name: 'هدى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'lead', name: 'منى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'lead2', name: 'رنا', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'mod', name: 'مازن', role: 'MODERATOR', roleId: 'r-mod', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'legacy', name: 'ليلى', role: 'FOLLOW_UP_AGENT', roleId: null, status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'owner', name: 'المالك', role: 'SUPER_ADMIN', roleId: null, status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
  ];
  // منى and رنا are freed from «اسحبي أول» by a personal «سماح» of «إسناد الطلبات».
  state.overrides = [
    { userId: 'lead', permission: 'orders.assign', effect: 'ALLOW' },
    { userId: 'lead2', permission: 'orders.assign', effect: 'ALLOW' },
  ];
  state.decisions = [
    { changedById: 'sara', orderId: 'o1' },
    { changedById: 'lead', orderId: 'o2' },
    { changedById: 'mod', orderId: 'o3' },
    { changedById: 'mod', orderId: 'o4' },
    { changedById: 'owner', orderId: 'o5' },
    { changedById: 'legacy', orderId: 'o6' },
  ];
  state.pulls = ['sara', 'sara', 'legacy'];
  state.refusalsMissing = false;
  state.reads = 0;
  state.viewer = await viewer(VIEW);
});
afterEach(() => vi.useRealTimers());

describe('who may ask', () => {
  it('NEGATIVE: 403 without settings.view — nothing is read', async () => {
    state.viewer = await viewer(['team.monitor']);
    expect((await ask()).status).toBe(403);
    expect(state.reads).toBe(0);
  });

  it('NEGATIVE: 403 without team.monitor — nothing is read', async () => {
    state.viewer = await viewer(['settings.view', 'users.view']);
    expect((await ask()).status).toBe(403);
    expect(state.reads).toBe(0);
  });
});

describe('the answer', () => {
  it('every person at the desk, the store’s today, and a person with no activity is zeros — not missing', async () => {
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body.day).toBe('2026-11-19');
    expect(body.today).toBe(true);
    expect(body.people.map((p: any) => p.userId).sort()).toEqual(['idle', 'lead', 'lead2', 'legacy', 'mod', 'owner', 'sara']);
    expect(row(body, 'idle')).toMatchObject({ pulls: 0, idleReturns: 0, noAnswerReturns: 0, countedNoAnswer: 0, earlyNoAnswer: 0, autoCloses: 0, callProofRefusals: 0, decided: 0, refusals: [], alarmAr: null });
    expect(row(body, 'sara')).toMatchObject({ pulls: 2, decided: 1, refusals: [{ code: 'PULL_TOO_FAST', count: 2 }] });
    expect(row(body, 'sara').refusals[0].labelAr).toMatch(/[؀-ۿ]/);
    expect(row(body, 'legacy').pulls).toBe(1);
  });

  it('the red line: decided while exempt by a key, and decided without working the desk', async () => {
    const { body } = await ask();
    expect(row(body, 'lead')).toMatchObject({ hold: 'EXEMPT', decided: 1, alarmAr: ALARM_TODAY_AR });
    expect(row(body, 'mod')).toMatchObject({ hold: 'DOES_NOT_WORK', decided: 2, alarmAr: ALARM_TODAY_AR });
  });

  it('NEGATIVE: no red line for the bound agent, the legacy follow-up (bound by her template), the owner, or an exempt person who decided nothing', async () => {
    const { body } = await ask();
    expect(row(body, 'sara')).toMatchObject({ hold: 'BOUND', alarmAr: null });
    expect(row(body, 'legacy')).toMatchObject({ hold: 'BOUND', alarmAr: null });
    expect(row(body, 'owner')).toMatchObject({ hold: 'OWNER', decided: 1, alarmAr: null });
    expect(row(body, 'lead2')).toMatchObject({ hold: 'EXEMPT', decided: 0, alarmAr: null });
  });

  it('yesterday is asked by its day, and its red line does not say «اليوم»', async () => {
    const { status, body } = await ask('2026-11-18');
    expect(status).toBe(200);
    expect(body.today).toBe(false);
    expect(row(body, 'lead').alarmAr).toBe(ALARM_OTHER_DAY_AR);
  });

  it('the refusal log missing: still 200, said, and the other counters stand', async () => {
    state.refusalsMissing = true;
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body.refusalLog).toBe(false);
    expect(row(body, 'sara')).toMatchObject({ pulls: 2, refusals: [] });
  });

  it('ids and counts only: no name, no order, no customer', async () => {
    const { body } = await ask();
    expect(Object.keys(body).sort()).toEqual(['day', 'people', 'refusalLog', 'timeZone', 'today', 'truncated']);
    for (const p of body.people) {
      expect(Object.keys(p).sort()).toEqual(
        ['alarmAr', 'autoCloses', 'callProofRefusals', 'countedNoAnswer', 'decided', 'earlyNoAnswer', 'hold', 'idleReturns', 'noAnswerReturns', 'pulls', 'refusals', 'userId']
      );
    }
    expect(JSON.stringify(body)).not.toMatch(/o1|phone|customer/);
  });
});

describe('the day', () => {
  it('NEGATIVE: a day still to come → 400 DAY_IN_FUTURE in Arabic, nothing read', async () => {
    const { status, body } = await ask('2026-11-20');
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'DAY_IN_FUTURE', errorAr: DAY_IN_FUTURE_AR });
    expect(state.reads).toBe(0);
  });

  it('NEGATIVE: a malformed day → 400 INVALID_DAY in Arabic', async () => {
    const { status, body } = await ask('2026-13-01');
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_DAY', errorAr: DAY_INVALID_AR });
  });
});
