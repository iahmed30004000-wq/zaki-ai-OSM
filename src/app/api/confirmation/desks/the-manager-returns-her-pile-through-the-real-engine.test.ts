import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «أرجِع «لا يرد» للطابور»: THE DOOR, ASKED AS EVERYONE WHO MIGHT ASK, THROUGH THE REAL ENGINE.
 *
 * The owner, 8/11, on an agent holding 479 «لا يرد» orders: «واذا ساحبيتو رجعهم». The door (`POST /api/confirmation/desks/
 * [agentId]/return-no-answer`) returns up to 200 of HER «لا يرد» orders per press, for a watcher (desk-watch.ts) who ALSO holds
 * `orders.unlock` — the key the claim door's «سحبه منه» asks.
 *
 * Nothing about permissions is mocked: every person is built the way a session is (`computeEffectiveGrants` → `attachGrants`)
 * and the REAL `can` / `getPermissionScope` answer, so the live agent’s keys (read on the live site on 1/11) are the keys
 * tried. Only the database, the store-reach lookup (`resolveAudience`, its own tests elsewhere) and the audit are stubbed — and
 * the stub of the reach lookup answers by company, store and status, so a door that asked the wrong question gets the wrong
 * person back.
 *
 *  1. Who may: a watcher with `orders.unlock` — the owner, a manager. Nobody else, and every refusal writes and reads nothing.
 *  2. Whose desk: an ACTIVE colleague of this company who reaches this store. Not the presser’s own, not another company’s,
 *     not an id nobody has, not something that is not an id.
 *  3. Acting as nobody but the presser: the history line keeps HER id in `userId` (whose order it was) and names HIM in its
 *     metadata; the notice goes TO her and names him in its sentence; the audit row is written under HIS id. The agent is
 *     only whose pile.
 *  4. One audit row per press that moved something — none for a refusal and none for a press that moved nothing.
 *
 * Blockers: no money, no order creation, no migration, no customer data to a model.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;

const { state, db, tx, logAudit, resolveAudience, pressSpy } = vi.hoisted(() => {
  const state = {
    user: null as unknown as SessionUser,
    storeId: 's1',
    contextError: null as Error | null,
    /** The store's country: its work hours and weekend are the calendar the press counts «just taken» and «on the phone» on. */
    country: { id: 'co1', code: 'JO', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' },
    people: [] as { id: string; name: string; companyId: string; stores: string[]; status: string }[],
    /** What the light transaction reads: her returnable orders. */
    rows: [] as { id: string; claimedAt: Date; customerId: string | null }[],
    /** What a count reads after the writes. */
    remaining: 0,
    /** The press as the module under test, wrapped in a spy so a test can see its arguments (and replace its answer). */
    real: null as null | ((...a: unknown[]) => Promise<unknown>),
  };
  const tx = {
    order: {
      findMany: vi.fn<(q: Record<string, unknown>) => Promise<typeof state.rows>>(async () => state.rows),
      updateMany: vi.fn<(q: Record<string, unknown>) => Promise<{ count: number }>>(async () => ({ count: 1 })),
      count: vi.fn<(q: Record<string, unknown>) => Promise<number>>(async () => state.remaining),
    },
    orderClaimHistory: { createMany: vi.fn(async () => ({ count: 0 })) },
    notification: { create: vi.fn(async () => ({})) },
  };
  const db = { $transaction: vi.fn<(fn: (t: unknown) => unknown, options?: unknown) => Promise<unknown>>(async (fn) => fn(tx)) };
  const resolveAudience = vi.fn(
    async (q: { companyId: string; storeId: string; audience: { userIds?: string[] }; actorId?: string }) =>
      state.people
        .filter((p) => p.companyId === q.companyId && p.status === 'ACTIVE' && p.stores.includes(q.storeId))
        .filter((p) => p.id !== q.actorId)
        .filter((p) => (q.audience.userIds ?? []).includes(p.id))
        .map((p) => ({ id: p.id, name: p.name, role: 'CONFIRMATION_AGENT', status: 'ACTIVE', companyId: p.companyId, permissions: [] }))
  );
  const pressSpy = vi.fn((...a: unknown[]) => state.real!(...a));
  return { state, db, tx, logAudit: vi.fn(), resolveAudience, pressSpy };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => {
    if (state.contextError) throw state.contextError;
    return { user: state.user, companyId: 'c1', storeId: state.storeId, countryId: 'co1', country: state.country };
  },
}));
vi.mock('@/lib/notification-audience', () => ({ resolveAudience }));
vi.mock('@/lib/audit', () => ({ logAudit }));
vi.mock('@/lib/return-no-answer-pile', async (orig) => {
  const actual = await orig<typeof import('@/lib/return-no-answer-pile')>();
  state.real = actual.returnNoAnswerPile as never;
  return { ...actual, returnNoAnswerPile: pressSpy };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { DESK_NOT_FOUND, DESK_WATCH_REFUSAL } from '@/lib/desk-watch';
import {
  OWN_DESK_REFUSAL,
  RETURN_PILE_REFUSAL,
  RETURN_TRANSACTION_OPTIONS,
  pileCutoffs,
  returnablePileWhere,
} from '@/lib/return-no-answer-pile';
import * as door from '@/app/api/confirmation/desks/[agentId]/return-no-answer/route';

/** CONFIRMATION_AGENT, live, 1/11: all 22 keys, every one at the whole company. No `team.monitor`, no `orders.unlock`. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** The CONFIRMATION_SUPERVISOR template: supervise and all orders, no team.monitor, no orders.unlock. */
const SUPERVISOR = ['confirmation.work', 'confirmation.supervise', 'confirmation.issues', 'orders.view', 'customers.view_basic', 'reports.view', 'dashboard.view'];
/** A manager: watches desks, sees every order, and may take any order back. */
const MANAGER = ['team.monitor', 'orders.view', 'orders.unlock', 'confirmation.supervise'];

async function person(
  id: string,
  role: string,
  keys: string[],
  scope: Record<string, string> = {},
  deny: string[] = []
): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id === 'owner' ? 'أحمد' : id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: scope[k] ?? 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => deny.map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
  });
  return attachGrants(base, grants);
}

const press = (agentId: string) =>
  door.POST(new Request(`http://x/api/confirmation/desks/${encodeURIComponent(agentId)}/return-no-answer`, { method: 'POST' }), {
    params: Promise.resolve({ agentId }),
  });

/** Nothing was read, nothing was written, nobody was told. */
const untouched = () => {
  expect(pressSpy).not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(tx.order.findMany).not.toHaveBeenCalled();
  expect(tx.order.updateMany).not.toHaveBeenCalled();
  expect(tx.orderClaimHistory.createMany).not.toHaveBeenCalled();
  expect(tx.notification.create).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  state.storeId = 's1';
  state.contextError = null;
  state.remaining = 0;
  state.rows = [
    { id: 'o1', claimedAt: new Date('2026-11-08T08:00:00Z'), customerId: 'cu1' },
    { id: 'o2', claimedAt: new Date('2026-11-08T08:30:00Z'), customerId: 'cu2' },
  ];
  state.people = [
    { id: 'sara', name: 'سارة', companyId: 'c1', stores: ['s1'], status: 'ACTIVE' },
    { id: 'rana', name: 'رنا', companyId: 'c1', stores: ['s2'], status: 'ACTIVE' },
    { id: 'gone', name: 'منى', companyId: 'c1', stores: ['s1'], status: 'INACTIVE' },
    { id: 'stranger', name: 'غريبة', companyId: 'c2', stores: ['s1'], status: 'ACTIVE' },
    { id: 'owner', name: 'أحمد', companyId: 'c1', stores: ['s1'], status: 'ACTIVE' },
    { id: 'manager', name: 'مدير', companyId: 'c1', stores: ['s1'], status: 'ACTIVE' },
  ];
});

describe('who may press', () => {
  it('the owner (SUPER_ADMIN) presses on Sara’s desk: 200, and the press runs once, in one transaction', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    const res = await press('sara');
    expect(res.status).toBe(200);
    expect(pressSpy).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // The literals, not the module's own constant: 200 statements need more than the default 5 seconds a transaction is given,
    // and a wait for a connection longer than a few seconds is a press that hangs.
    expect(db.$transaction.mock.calls[0][1]).toEqual({ maxWait: 5_000, timeout: 30_000 });
  });

  it('the options the door passes are the module’s own constant, and the constant is those literals', () => {
    expect(RETURN_TRANSACTION_OPTIONS).toEqual({ maxWait: 5_000, timeout: 30_000 });
  });

  it('a manager with «متابعة أداء الفريق», every order in sight and «تجاوز أقفال التحرير» does too — without `confirmation.work`', async () => {
    state.user = await person('manager', 'MANAGER', MANAGER);
    expect((await press('sara')).status).toBe(200);
    expect(pressSpy).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: a LIVE agent (22 keys, she even carries `confirmation.supervise`) is refused with the desk door’s own sentence, and nothing is looked up', async () => {
    state.user = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await press('sara');
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toBe(DESK_WATCH_REFUSAL);
    expect(resolveAudience).not.toHaveBeenCalled();
    untouched();
  });

  it('NEGATIVE: the supervisor template (supervise, every order, no watching key, no unlock)', async () => {
    state.user = await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR);
    const res = await press('sara');
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toBe(DESK_WATCH_REFUSAL);
    untouched();
  });

  it('NEGATIVE: a watcher WITHOUT «تجاوز أقفال التحرير» — watching alone returns nothing; the refusal names the key', async () => {
    state.user = await person('lead', 'MANAGER', ['team.monitor', 'orders.view']);
    const res = await press('sara');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errorAr).toBe(RETURN_PILE_REFUSAL);
    expect(body.errorAr).toContain('تجاوز أقفال التحرير');
    expect(body.error).toContain('orders.unlock');
    expect(resolveAudience).not.toHaveBeenCalled();
    untouched();
  });

  it('NEGATIVE: a holder of `orders.unlock` who may not watch — no «متابعة أداء الفريق» — gets the watching refusal', async () => {
    state.user = await person('boss', 'MANAGER', ['orders.unlock', 'orders.view']);
    const res = await press('sara');
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toBe(DESK_WATCH_REFUSAL);
    expect(resolveAudience).not.toHaveBeenCalled();
    untouched();
  });

  it('NEGATIVE: …nor with «متابعة أداء الفريق» when he does not see every order («المسندة إليه»)', async () => {
    state.user = await person('lead', 'MANAGER', MANAGER, { 'orders.view': 'ASSIGNED' });
    const res = await press('sara');
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toBe(DESK_WATCH_REFUSAL);
    untouched();
  });

  it('NEGATIVE: …nor with «متابعة أداء الفريق» and no «عرض الطلبات» at all', async () => {
    state.user = await person('hr', 'MANAGER', ['team.monitor', 'orders.unlock']);
    expect((await press('sara')).status).toBe(403);
    untouched();
  });

  it('NEGATIVE: a «منع» on `orders.unlock` beats a role that carries it', async () => {
    state.user = await person('lead', 'MANAGER', MANAGER, {}, ['orders.unlock']);
    const res = await press('sara');
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toBe(RETURN_PILE_REFUSAL);
    untouched();
  });

  it('NEGATIVE: a «منع» on «متابعة أداء الفريق» beats a role that carries it', async () => {
    state.user = await person('lead', 'MANAGER', MANAGER, {}, ['team.monitor']);
    expect((await press('sara')).status).toBe(403);
    untouched();
  });

  it('NEGATIVE: not signed in — nothing is looked up, read, written or told', async () => {
    state.contextError = new Error('Unauthorized');
    const res = await press('sara');
    expect(res.status).toBe(401);
    expect(resolveAudience).not.toHaveBeenCalled();
    untouched();
  });

  it('NEGATIVE: the door answers POST and nothing else (a GET, PUT, PATCH or DELETE has nowhere to land)', () => {
    expect(Object.keys(door).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))).toEqual(['POST']);
  });
});

describe('whose desk', () => {
  it('NEGATIVE: the presser’s OWN id — returning your own desk is not this door’s job (400, nothing looked up)', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    const res = await press('owner');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('OWN_DESK');
    expect(body.errorAr).toBe(OWN_DESK_REFUSAL);
    expect(resolveAudience).not.toHaveBeenCalled();
    untouched();
  });

  for (const [who, why] of [
    ['stranger', 'an agent of another company'],
    ['rana', 'an agent of this company who cannot enter this store'],
    ['gone', 'a deactivated account'],
    ['nobody', 'an id nobody has'],
  ] as const) {
    it(`NEGATIVE: ${why} («${who}») — 404 with the desk door’s sentence, and nothing happens`, async () => {
      state.user = await person('owner', 'SUPER_ADMIN', []);
      const res = await press(who);
      expect(res.status).toBe(404);
      expect((await res.json()).errorAr).toBe(DESK_NOT_FOUND);
      untouched();
    });
  }

  it('NEGATIVE: something that is not an id is refused before anybody is looked up', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    for (const bad of ['../users', 'a b', 'x'.repeat(65), "sara' OR 1=1"]) {
      expect((await press(bad)).status, bad).toBe(404);
    }
    expect(resolveAudience).not.toHaveBeenCalled();
    untouched();
  });

  it('the reach is asked for the presser’s company and store, about the one id in the address', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    await press('sara');
    expect(resolveAudience).toHaveBeenCalledWith({ companyId: 'c1', storeId: 's1', audience: { userIds: ['sara'] } });
  });

  it('a colleague of ANOTHER store of the same company is reachable only from a store she enters', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    expect((await press('rana')).status).toBe(404);
    state.storeId = 's2';
    expect((await press('rana')).status).toBe(200);
    expect(pressSpy.mock.calls.at(-1)![1]).toMatchObject({ scope: { companyId: 'c1', storeId: 's2' }, agentId: 'rana' });
  });
});

describe('what the door passes on, and what it says', () => {
  it('the press is made for HER pile in THIS company and store, by HIM — the agent is only whose pile it is', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    await press('sara');
    const [, args] = pressSpy.mock.calls[0] as [unknown, { scope: Row; agentId: string; by: Row }];
    expect(args.scope).toEqual({ companyId: 'c1', storeId: 's1' });
    expect(args.agentId).toBe('sara');
    expect(args.by).toEqual({ id: 'owner', name: 'أحمد' });
  });

  it('the store’s working calendar goes down with the press — the four fields of its country, nothing else', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    await press('sara');
    const [, args] = pressSpy.mock.calls[0] as [unknown, { calendar: Row }];
    expect(args.calendar).toEqual({ workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' });
  });

  it('the READ, the WRITE and the COUNT after it all carry the working-clock guard, drawn from that calendar at the press’s own moment', async () => {
    const NOW = new Date('2026-11-08T12:00:00.000Z'); // Sunday 15:00 in Amman
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      state.user = await person('owner', 'SUPER_ADMIN', []);
      await press('sara');
      const expected = returnablePileWhere({ companyId: 'c1', storeId: 's1' }, 'sara', NOW, pileCutoffs(NOW, state.country));
      expect(tx.order.findMany.mock.calls[0][0]).toMatchObject({ where: expected, take: 200 });
      // the write asks everything the read asked, for this order and the claim it read — and the guard is still in it
      expect(tx.order.updateMany.mock.calls[0][0]).toMatchObject({ where: { ...expected, id: 'o1', claimedAt: state.rows[0].claimedAt } });
      expect(tx.order.count.mock.calls[0][0]).toEqual({ where: expected });
      // …and the guard is the 15-minute and the 90-minute edges, on the working clock of Sunday afternoon
      expect(pileCutoffs(NOW, state.country)).toEqual({ quiet: new Date('2026-11-08T11:45:00.000Z'), held: new Date('2026-11-08T10:30:00.000Z') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('it is the STORE’S calendar: another country’s hours give other edges, through the same door', async () => {
    const NOW = new Date('2026-11-08T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const other = { ...state.country, weekendDays: [0, 6] };
    const mine = state.country;
    try {
      state.country = other;
      state.user = await person('owner', 'SUPER_ADMIN', []);
      await press('sara');
      const expected = returnablePileWhere({ companyId: 'c1', storeId: 's1' }, 'sara', NOW, pileCutoffs(NOW, other));
      expect(tx.order.findMany.mock.calls[0][0]).toMatchObject({ where: expected });
      expect(expected).not.toEqual(returnablePileWhere({ companyId: 'c1', storeId: 's1' }, 'sara', NOW, pileCutoffs(NOW, mine)));
    } finally {
      state.country = mine;
      vi.useRealTimers();
    }
  });

  it('the transaction hands the press its own client, not the global one', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    await press('sara');
    expect(pressSpy.mock.calls[0][0]).toBe(tx);
  });

  it('through the real press: every line and the notice carry HIS name as the presser and HER id as whose order it was', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    const res = await press('sara');
    expect(res.status).toBe(200);
    const lines = (tx.orderClaimHistory.createMany.mock.calls[0] as unknown as [{ data: Row[] }])[0].data;
    expect(lines.map((l) => [l.orderId, l.userId, l.action, l.reason])).toEqual([
      ['o1', 'sara', 'RELEASED', 'MANAGER_RETURNED'],
      ['o2', 'sara', 'RELEASED', 'MANAGER_RETURNED'],
    ]);
    for (const l of lines) expect(JSON.parse(l.metadata as string)).toEqual({ pulledBack: true, from: 'sara', by: { id: 'owner', name: 'أحمد' } });
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect((tx.notification.create.mock.calls[0] as unknown as [{ data: Row }])[0].data).toMatchObject({ userId: 'sara', companyId: 'c1', storeId: 's1' });
    // not one write names her as the actor of the press
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain('"userId":"sara"');
  });

  it('the answer: the counts, whose desk, and the sentence the screen shows', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    state.remaining = 40;
    const body = await (await press('sara')).json();
    expect(body).toEqual({
      returned: 2,
      skipped: 0,
      remaining: 40,
      limit: 200,
      agent: { id: 'sara', name: 'سارة' },
      message: 'رجع 2 طلب «لا يرد» للطابور — باقي 40 — اضغط تاني',
    });
  });

  it('ONE audit row for the press — who pressed, whose desk, the counts', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    state.remaining = 40;
    await press('sara');
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toEqual({
      companyId: 'c1',
      userId: 'owner',
      action: 'DESK_NO_ANSWER_RETURNED',
      entity: 'User',
      entityId: 'sara',
      previousData: { holder: 'سارة' },
      newData: { returned: 2, skipped: 0, remaining: 40, limit: 200, by: 'أحمد' },
    });
  });

  it('a press that moved nothing writes no audit row, no line, no notice — and still answers 200 with the sentence', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    state.rows = [];
    const res = await press('sara');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ returned: 0, skipped: 0, remaining: 0, message: 'ما في طلب «لا يرد» يرجع هلأ — اللي عليه موعد أو اللي ردّ زبونه بيضل عندها' });
    expect(logAudit).not.toHaveBeenCalled();
    expect(tx.orderClaimHistory.createMany).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it('a press where every order changed under it moved nothing either — counted as skipped, no audit row', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    const body = await (await press('sara')).json();
    expect(body).toMatchObject({ returned: 0, skipped: 2 });
    expect(logAudit).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
    tx.order.updateMany.mockResolvedValue({ count: 1 });
  });

  it('a press that cannot finish (the database fails) answers an error and writes no audit row', async () => {
    state.user = await person('owner', 'SUPER_ADMIN', []);
    pressSpy.mockRejectedValueOnce(new Error('connection lost'));
    const res = await press('sara');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
