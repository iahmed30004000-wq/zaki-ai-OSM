import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (Q1b, 19/11) — `GET /api/confirmation/rules/check?userId=` («افحص موظفة»).
 *
 *  1. It answers, for one person of THIS store, what she holds against her limit, her untried orders against their cap, her pulls
 *     in the window against the pace, and what the pull would answer her now — the pull's own refusal code and sentence, in the
 *     pull's own order: her key → the caps and the untouched order (`pullRefusal`, with the mode's hand) → «الشغل أول» → the pace.
 *  2. The person is built as her session is (role rows, a personal «منع», a roleId-null legacy account → `can`).
 *  3. 403 without `settings.view` or `users.view`, and nothing about her is read. A person of another store / company, or a
 *     deactivated one → 404 with an Arabic sentence.
 *  4. It writes nothing and never calls `pullNextOrder`: the fake database has read methods only.
 *  5. Counts only: no customer, no order id in the answer.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Person = { id: string; name: string; role: string; roleId: string | null; status: string; companyId: string; stores: string[] };
type Override = { userId: string; permission: string; effect: 'ALLOW' | 'DENY' };

const { state, db, spies } = vi.hoisted(() => {
  const state = {
    viewer: null as unknown as SessionUser,
    storeId: 's1',
    people: [] as Person[],
    roles: {} as Record<string, string[]>,
    templates: {} as Record<string, string[]>,
    overrides: [] as Override[],
    counts: { total: 0, heldForHer: 0, withoutAttempt: 0, untouched: null as null | { id: string; orderNumber: string } },
    pulls: [] as Date[],
    returnsOn: false,
    hand: 3,
    workFirst: null as null | Record<string, unknown>,
    limited: false,
  };
  const pick = (where: Record<string, any>) =>
    state.people.filter(
      (p) =>
        (where.companyId === undefined || p.companyId === where.companyId) &&
        (where.status === undefined || p.status === where.status) &&
        (where.id === undefined || (typeof where.id === 'string' ? where.id === p.id : where.id.in.includes(p.id)))
    );
  const row = (p: Person) => ({ id: p.id, name: p.name, email: `${p.id}@x`, role: p.role, roleId: p.roleId, status: p.status, companyId: p.companyId });
  const spies = {
    ownedCounts: vi.fn(async () => ({ ...state.counts })),
    workFirstGate: vi.fn(async () => state.workFirst),
    pullNextOrder: vi.fn(async () => {
      throw new Error('the check must never pull');
    }),
    claimHistory: vi.fn(async (_args: unknown) => state.pulls.map((createdAt) => ({ createdAt }))),
  };
  const db = {
    user: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => pick(where).map(row)),
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const p = pick(where)[0];
        return p ? { status: p.status } : null;
      }),
    },
    userPermission: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        state.overrides
          .filter((o) => (where.userId?.in ?? [where.userId]).includes(o.userId))
          .map((o) => ({ userId: o.userId, permission: o.permission, effect: o.effect, scope: o.effect === 'ALLOW' ? 'ALL_COMPANY' : null, scopeIds: null }))
      ),
    },
    rolePermission: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const keys = where.roleId ? state.roles[where.roleId] ?? [] : state.templates[where.role?.name] ?? [];
        return keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null }));
      }),
    },
    orderClaimHistory: { findMany: spies.claimHistory },
  };
  return { state, db, spies };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: state.viewer,
    companyId: 'c1',
    storeId: state.storeId,
    countryId: 'co1',
    country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Damascus' },
  }),
  usersReachingStore: async (users: { id: string }[], companyId: string, storeId: string) =>
    new Set(users.filter((u) => state.people.find((p) => p.id === u.id && p.companyId === companyId)?.stores.includes(storeId)).map((u) => u.id)),
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => (state.limited ? { allowed: false, remaining: 0, retryAfterSec: 42 } : { allowed: true, remaining: 1, retryAfterSec: 0 }),
}));
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
// The reads that touch orders and switches are stood in for; the RULES (pullRefusal, capRefusal, pullPaceRefusal, capLoad) are the real ones.
vi.mock('@/lib/confirmation-queue', async (orig) => {
  const real = await orig<typeof import('@/lib/confirmation-queue')>();
  return {
    ...real,
    ownedCounts: spies.ownedCounts,
    pullNextOrder: spies.pullNextOrder,
    readReturnsMode: vi.fn(async () => (state.returnsOn ? ({ on: true } as never) : null)),
    returnsLimits: vi.fn(async () => ({ handLimit: state.hand, idleBusinessMinutes: 20 })),
  };
});
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false }) }));
vi.mock('@/lib/work-first', () => ({ workFirstGate: spies.workFirstGate }));

import { NextRequest } from 'next/server';
import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { CLAIM_CAPS, PULL_PACE, pullPaceRefusal, pullRefusal } from '@/lib/confirmation-queue';
import { handLimitMessage } from '@/lib/no-answer-returns';
import { GET } from './route';

const AGENT = ['confirmation.work', 'confirmation.pull', 'confirmation.supervise', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.view'];
const MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.claim', 'orders.release'];
const FOLLOW_UP = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.view'];

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

const ask = async (userId: string | null) => {
  const url = userId === null ? 'http://x/api/confirmation/rules/check' : `http://x/api/confirmation/rules/check?userId=${userId}`;
  const res = await GET(new NextRequest(url));
  return { status: res.status, body: (await res.json()) as any };
};

beforeEach(async () => {
  vi.clearAllMocks();
  state.storeId = 's1';
  state.limited = false;
  state.returnsOn = false;
  state.hand = 3;
  state.workFirst = null;
  state.pulls = [];
  state.counts = { total: 0, heldForHer: 0, withoutAttempt: 0, untouched: null };
  state.roles = { 'r-agent': AGENT, 'r-mod': MODERATOR };
  state.templates = { FOLLOW_UP_AGENT: FOLLOW_UP };
  state.overrides = [];
  state.people = [
    { id: 'sara', name: 'سارة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'huda', name: 'هدى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'legacy', name: 'ليلى', role: 'FOLLOW_UP_AGENT', roleId: null, status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'mod', name: 'مازن', role: 'MODERATOR', roleId: 'r-mod', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'away', name: 'رنا', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s2'] },
    { id: 'gone', name: 'دانة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'INACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'other', name: 'غريبة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c2', stores: ['s1'] },
  ];
  state.viewer = await viewer(['settings.view', 'users.view']);
});

describe('who may ask', () => {
  it.each([[['settings.view']], [['users.view']], [[]]])('NEGATIVE: %j alone is refused, and nothing about her is read', async (keys) => {
    state.viewer = await viewer(keys);
    const { status } = await ask('sara');
    expect(status).toBe(403);
    expect(spies.ownedCounts).not.toHaveBeenCalled();
    expect(spies.claimHistory).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('too many checks in a minute → 429 in Arabic', async () => {
    state.limited = true;
    const { status, body } = await ask('sara');
    expect(status).toBe(429);
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
  });

  it('no name picked → 400 USER_REQUIRED', async () => {
    const { status, body } = await ask(null);
    expect(status).toBe(400);
    expect(body.code).toBe('USER_REQUIRED');
  });
});

describe('whom it answers about — 404 for anyone not working this store', () => {
  it.each([
    ['away', 'NOT_IN_STORE'],
    ['gone', 'USER_INACTIVE'],
    ['other', 'USER_NOT_FOUND'],
    ['nobody', 'USER_NOT_FOUND'],
  ])('%s → 404 %s, an Arabic sentence, and none of her numbers', async (id, code) => {
    const { status, body } = await ask(id);
    expect(status).toBe(404);
    expect(body.code).toBe(code);
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
    expect(body.hold).toBeUndefined();
    expect(spies.ownedCounts).not.toHaveBeenCalled();
  });

  it('another company\'s person is told apart from nobody at all: never — the same «not found»', async () => {
    const a = await ask('other');
    const b = await ask('nobody');
    expect(a.body).toEqual(b.body);
  });
});

describe('what the pull would answer her now', () => {
  it('nothing in her hands → open, with her numbers, against the cap of 500 and the pace', async () => {
    const { status, body } = await ask('sara');
    expect(status).toBe(200);
    expect(body.pull).toEqual({ open: true, code: null, sentence: expect.stringMatching(/مفتوح/) });
    expect(body.hold).toEqual({ inHand: 0, heldForHer: 0, load: 0, limit: CLAIM_CAPS.total, limitFrom: 'CAP', withoutAttempt: 0, withoutAttemptLimit: CLAIM_CAPS.withoutAttempt });
    expect(body.pace).toEqual({ pulled: 0, perHour: PULL_PACE.perHour, windowMinutes: PULL_PACE.windowMinutes });
    expect(spies.pullNextOrder).not.toHaveBeenCalled();
  });

  it('an untouched order → the pull\'s own UNTOUCHED_ORDER sentence, word for word', async () => {
    state.counts = { total: 2, heldForHer: 1, withoutAttempt: 1, untouched: { id: 'o1', orderNumber: 'ORD-7' } };
    const { body } = await ask('sara');
    const expected = pullRefusal(state.counts)!;
    expect(body.pull).toEqual({ open: false, code: 'UNTOUCHED_ORDER', sentence: expected.message });
    expect(body.hold).toMatchObject({ inHand: 2, heldForHer: 1, load: 3, withoutAttempt: 1 });
    // A count and a sentence — never the order's id.
    expect(JSON.stringify(body)).not.toContain('o1');
    // A refusal before «الشغل أول»: the gate is not asked (the pull's order).
    expect(spies.workFirstGate).not.toHaveBeenCalled();
  });

  it('the mode on: the hand limit is the limit, and a full hand says the mode\'s sentence', async () => {
    state.returnsOn = true;
    state.hand = 3;
    state.counts = { total: 3, heldForHer: 0, withoutAttempt: 0, untouched: null };
    const { body } = await ask('sara');
    expect(body.hold).toMatchObject({ limit: 3, limitFrom: 'HAND', load: 3 });
    expect(body.pull).toEqual({ open: false, code: 'CAP_TOTAL', sentence: handLimitMessage(3) });
  });

  it('NEGATIVE: the mode off, three in hand is open — the 3 is only the mode\'s', async () => {
    state.counts = { total: 3, heldForHer: 0, withoutAttempt: 0, untouched: null };
    const { body } = await ask('sara');
    expect(body.pull.open).toBe(true);
    expect(body.hold.limit).toBe(CLAIM_CAPS.total);
  });

  it('«الشغل أول» after the caps, before the pace', async () => {
    state.counts = { total: 4, heldForHer: 0, withoutAttempt: 0, untouched: null };
    state.workFirst = { code: 'WORK_FIRST', message: 'عليها اتصالات قبل سحب طلب جديد.', orderId: 'o9', orderNumber: 'ORD-9', count: 2 };
    state.pulls = Array.from({ length: PULL_PACE.perHour }, (_, i) => new Date(Date.now() - (i + 1) * 60_000));
    const { body } = await ask('sara');
    expect(body.pull).toEqual({ open: false, code: 'WORK_FIRST', sentence: 'عليها اتصالات قبل سحب طلب جديد.' });
    expect(JSON.stringify(body)).not.toContain('o9');
    const args = spies.workFirstGate.mock.calls[0] as unknown as [unknown, { userId: string; held: number; room: number }];
    expect(args[1]).toMatchObject({ userId: 'sara', held: 4, room: CLAIM_CAPS.total });
  });

  it('the pace: her pulls of the window, read as the pull reads them, and the pull\'s own sentence', async () => {
    state.pulls = Array.from({ length: PULL_PACE.perHour }, (_, i) => new Date(Date.now() - (i + 1) * 60_000));
    const before = Date.now();
    const { body } = await ask('sara');
    expect(body.pace.pulled).toBe(PULL_PACE.perHour);
    expect(body.pull.code).toBe('PULL_TOO_FAST');
    expect(body.pull.sentence).toBe(pullPaceRefusal(state.pulls, new Date())!.message);
    const where = (spies.claimHistory.mock.calls[0][0] as { where: any }).where;
    expect(where).toMatchObject({ userId: 'sara', action: 'CLAIMED', reason: 'PULL_NEXT' });
    const since = where.createdAt.gt.getTime();
    expect(Math.abs(since - (before - PULL_PACE.windowMinutes * 60_000))).toBeLessThan(5_000);
  });

  it('NEGATIVE: one pull under the pace is open', async () => {
    state.pulls = Array.from({ length: PULL_PACE.perHour - 1 }, (_, i) => new Date(Date.now() - (i + 1) * 60_000));
    const { body } = await ask('sara');
    expect(body.pull.open).toBe(true);
  });
});

describe('her keys are her session\'s', () => {
  it('the moderator (no «سحب») → NO_PULL_KEY, naming the key in Arabic, and no rule of the pull is asked', async () => {
    const { body } = await ask('mod');
    expect(body.pull.code).toBe('NO_PULL_KEY');
    expect(body.pull.sentence).not.toMatch(/[A-Za-z]/);
    expect(spies.workFirstGate).not.toHaveBeenCalled();
  });

  it('a personal «منع» of confirmation.pull on an agent of a pulling role → NO_PULL_KEY for her alone', async () => {
    state.overrides = [{ userId: 'huda', permission: 'confirmation.pull', effect: 'DENY' }];
    expect((await ask('huda')).body.pull.code).toBe('NO_PULL_KEY');
    expect((await ask('sara')).body.pull.code).toBeNull();
  });

  it('a roleId-null legacy account reads her legacy role\'s template', async () => {
    const { status, body } = await ask('legacy');
    expect(status).toBe(200);
    expect(body.pull.open).toBe(true);
  });

  it('NEGATIVE: a personal «سماح» of confirmation.pull opens it for the moderator', async () => {
    state.overrides = [{ userId: 'mod', permission: 'confirmation.pull', effect: 'ALLOW' }];
    expect((await ask('mod')).body.pull.open).toBe(true);
  });
});

describe('the answer, and what the door never does', () => {
  it('exactly person, hold, pace, pull — no customer, no order', async () => {
    state.counts = { total: 1, heldForHer: 0, withoutAttempt: 0, untouched: null };
    const { body } = await ask('sara');
    expect(Object.keys(body).sort()).toEqual(['hold', 'pace', 'person', 'pull']);
    expect(body.person).toEqual({ id: 'sara', name: 'سارة' });
    expect(JSON.stringify(body)).not.toMatch(/customer|phone|address|orderId/i);
  });

  const source = readFileSync(join(__dirname, 'route.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('the route never pulls, never writes, never opens a transaction', () => {
    expect(source).not.toMatch(/pullNextOrder|releaseStaleClaims|reserveReturningCustomers|sweepIntakeForPull/);
    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$transaction|\$executeRaw/);
  });

  it('PIN: the pull\'s reason and its order of refusals are what this door mirrors', () => {
    const queue = readFileSync(join(process.cwd(), 'src/lib/confirmation-queue.ts'), 'utf8');
    expect(queue).toContain("const PULL_NEXT_REASON = 'PULL_NEXT';");
    expect(queue).toMatch(/where: \{ userId, action: 'CLAIMED', reason: PULL_NEXT_REASON, createdAt: \{ gt: since \} \}/);
    const pull = queue.slice(queue.indexOf('export async function pullNextOrder('));
    const order = ['pullRefusal(counts', 'workFirstGate(tx', 'pullPaceRefusal('].map((s) => pull.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const mine = ['pullRefusal(counts', 'workFirstGate(db', 'pullPaceRefusal('].map((s) => source.indexOf(s));
    expect(mine.every((i) => i > 0)).toBe(true);
    expect([...mine].sort((a, b) => a - b)).toEqual(mine);
    // The pull's door asks the key first (requirePermission) — so does this answer.
    expect(source.indexOf("can(person, 'confirmation.pull')")).toBeLessThan(mine[0]);
  });
});
