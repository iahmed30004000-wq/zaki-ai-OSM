import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «ركّن كل السطور بلا طلب» — POST /api/finance/statements/:id/park-unlinked
 *
 *  · parks, with ONE reason, every line of ONE statement that is MISSING_IN_SYSTEM, has no order and no answer — all or none;
 *  · the reason is the single door's rule; a closed statement refuses with the one sentence; the key is «مراجعة المطابقات»;
 *  · it writes the match rows and nothing else — no money, no wallet, no order, no note, no commission;
 *  · one audit row carrying the count; a second press parks 0 and writes nothing.
 *
 * Driven against an in-memory database whose transaction ROLLS BACK on a throw, and whose conditional writes take only the
 * rows their WHERE really matches — so a dropped condition is a row parked that should not be, and a lost rollback is a row
 * left parked after a refusal. People are built the way a session builds them (`computeEffectiveGrants` + the real `can`).
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;

const { db, state, requireContext, logAudit, current, touched } = vi.hoisted(() => {
  const state = {
    statements: [] as Row[],
    matches: [] as Row[],
    /** Runs between the read of the rows and their write — another person's hand in the middle of the press. */
    between: null as null | (() => void),
    /** Throws inside the write, after it has written — a database failure in the middle. */
    failWrite: false,
  };
  const touched = new Set<string>();

  const statementOf = (r: Row) => state.statements.find((s) => s.id === r.statementId)!;
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  function fits(row: Row, where: Row, of: (r: Row) => Row = statementOf): boolean {
    return Object.entries(where).every(([k, v]) => {
      if (k === 'statement') return fits(of(row), v as Row, () => ({}));
      if (v && typeof v === 'object' && !(v instanceof Date) && 'in' in (v as Row)) return ((v as { in: unknown[] }).in).includes(row[k]);
      if (v && typeof v === 'object' && !(v instanceof Date)) throw new Error(`the fake does not read ${k}: ${JSON.stringify(v)}`);
      return same(row[k], v);
    });
  }

  const model = {
    courierStatement: {
      findFirst: async ({ where }: { where: Row }) => state.statements.find((s) => fits(s, where, () => ({}))) ?? null,
    },
    settlementMatch: {
      findMany: async ({ where }: { where: Row }) => state.matches.filter((m) => fits(m, where)).map((m) => ({ id: m.id })),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        state.between?.();
        const hit = state.matches.filter((m) => fits(m, where));
        for (const m of hit) Object.assign(m, data);
        if (state.failWrite) throw new Error('the database went away in the middle');
        return { count: hit.length };
      },
    },
    $queryRaw: async () => [],
  };
  const money = new Proxy({}, { get: (_t, p) => { throw new Error(`the door reached for ${String(p)}`); } });
  const tx = new Proxy(model as Row, {
    get(t, p: string) {
      touched.add(p);
      return p in t ? t[p] : money;
    },
  });
  const db = new Proxy(
    {
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => {
        const before = structuredClone({ statements: state.statements, matches: state.matches });
        try {
          return await fn(tx);
        } catch (e) {
          state.statements = before.statements;
          state.matches = before.matches;
          throw e;
        }
      }),
    } as Row,
    {
      get(t, p: string) {
        if (p in t) return t[p];
        touched.add(`db.${p}`);
        return money;
      },
    }
  );
  return { db, state, touched, requireContext: vi.fn(), logAudit: vi.fn(), current: { user: null as unknown as SessionUser } };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { decisionData, decisionKind } from '@/lib/settlement-decisions';
import { STATEMENT_CLOSED_SENTENCE } from '@/lib/settlement-gates';
import { POST } from './route';

/** A person as a session builds one: role rows + personal overrides; `legacy` = no roleId, the in-code role map. */
async function person(opts: { keys?: string[]; deny?: string[]; legacy?: string; company?: string } = {}): Promise<SessionUser> {
  const base = {
    id: 'u1', email: 'u@x', name: 'محاسبة', role: opts.legacy ?? 'CUSTOM', roleId: opts.legacy ? null : 'r1',
    status: 'ACTIVE', companyId: opts.company ?? 'c1',
  } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => (opts.keys ?? []).map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => (opts.deny ?? []).map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
    })
  );
}
const REVIEWER = { keys: ['settlement.view', 'settlement.review'] };
async function as(opts: Parameters<typeof person>[0], ctx: { companyId?: string; storeId?: string } = {}) {
  current.user = await person(opts);
  requireContext.mockResolvedValue({ user: current.user, companyId: ctx.companyId ?? 'c1', storeId: ctx.storeId ?? 's1', country: { minorUnit: 2 } });
}

const REASON = 'طرود النظام القديم — مش إلنا';
const press = (note: unknown = REASON, id = 'st1') =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ note }) }), { params: Promise.resolve({ id }) });

const line = (id: string, over: Row = {}): Row => ({
  id, statementId: 'st1', companyId: 'c1', result: 'MISSING_IN_SYSTEM', orderId: null,
  resolution: null, resolutionNote: null, resolvedById: null, resolvedAt: null, resolutionKind: null, appliedAt: null, ...over,
});
const EARLIER = new Date('2026-11-20T10:00:00Z');

beforeEach(async () => {
  vi.clearAllMocks();
  touched.clear();
  state.between = null;
  state.failWrite = false;
  state.statements = [
    { id: 'st1', companyId: 'c1', storeId: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt: null, matchingClosedAt: null },
    { id: 'st2', companyId: 'c1', storeId: 's1', reference: 'ST-2', status: 'MATCHED', approvedAt: null, matchingClosedAt: null },
    { id: 'st9', companyId: 'c1', storeId: 's2', reference: 'ST-9', status: 'MATCHED', approvedAt: null, matchingClosedAt: null },
    { id: 'stX', companyId: 'c2', storeId: 's7', reference: 'ST-X', status: 'MATCHED', approvedAt: null, matchingClosedAt: null },
    // another company whose store happens to carry the same id: only the company on the statement tells it apart
    { id: 'stY', companyId: 'c2', storeId: 's1', reference: 'ST-Y', status: 'MATCHED', approvedAt: null, matchingClosedAt: null },
  ];
  state.matches = [
    // the three it is for
    line('a1'), line('a2'), line('a3'),
    // the same statement, and not this question
    line('linked', { orderId: 'o1' }),
    line('answered', { resolution: 'UNDER_REVIEW', resolutionNote: 'سبب قديم مكتوب', resolvedById: 'u7', resolvedAt: EARLIER }),
    line('mismatch', { result: 'MISMATCHED', orderId: 'o2' }),
    line('mismatchNoOrder', { result: 'MISMATCHED' }),
    line('notMentioned', { result: 'MISSING_IN_STATEMENT', orderId: 'o3' }),
    line('excluded', { result: 'EXCLUDED', orderId: 'o4' }),
    line('matched', { result: 'MATCHED', orderId: 'o5' }),
    // another statement of the same store, another store, another company
    line('other1', { statementId: 'st2' }),
    line('store2', { statementId: 'st9' }),
    line('company2', { statementId: 'stX', companyId: 'c2' }),
    // a row that names this statement but another company (a broken row): the company on the row still decides
    line('foreignRow', { companyId: 'c2' }),
    line('companyY', { statementId: 'stY', companyId: 'c2' }),
  ];
  await as(REVIEWER);
});

const rowOf = (id: string) => state.matches.find((m) => m.id === id)!;
const PARKED_IDS = ['a1', 'a2', 'a3'];
const snapshot = () => structuredClone(state.matches);

describe('the press parks every line no order carries, and answers how many', () => {
  it('parks the three, with the reason and the person, as the single door writes one', async () => {
    const res = await press(`  ${REASON}  `);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parked).toBe(3);
    expect(body.message).toContain('3');
    for (const id of PARKED_IDS) {
      const r = rowOf(id);
      expect(r).toMatchObject({ resolution: 'UNDER_REVIEW', resolutionNote: REASON, resolvedById: 'u1', resolutionKind: null });
      expect(r.resolvedAt).toBeInstanceOf(Date);
      // The very fields the single door's writer writes — no more, no fewer.
      const shape = { ...decisionData({ resolution: 'UNDER_REVIEW', note: REASON, userId: 'u1' }), ...decisionKind() };
      for (const k of Object.keys(shape)) expect(r, k).toHaveProperty(k);
    }
  });

  it('touches no other row: an order, an answer, a difference, another statement, another store, another company', async () => {
    const before = snapshot();
    await press();
    for (const b of before) {
      if (PARKED_IDS.includes(b.id as string)) continue;
      expect(rowOf(b.id as string), b.id as string).toEqual(b);
    }
    // the answered row keeps its own reason and its own person
    expect(rowOf('answered')).toMatchObject({ resolutionNote: 'سبب قديم مكتوب', resolvedById: 'u7', resolvedAt: EARLIER });
  });

  it('one audit row, carrying the count, the reason and the statement', async () => {
    await press();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'SETTLEMENT_UNLINKED_LINES_PARKED',
      entity: 'CourierStatement',
      entityId: 'st1',
      companyId: 'c1',
      userId: 'u1',
      newData: { rows: 3, explanation: REASON, resolution: 'UNDER_REVIEW', statement: 'ST-1' },
    });
  });

  it('a second press parks 0, writes nothing and writes no audit row', async () => {
    await press();
    const after = snapshot();
    const res = await press('سبب ثاني مختلف تماماً');
    expect(res.status).toBe(200);
    expect((await res.json()).parked).toBe(0);
    expect(state.matches).toEqual(after);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it('a statement whose money is in but whose matching is still open takes it (as the single door does)', async () => {
    state.statements[0].approvedAt = EARLIER;
    state.statements[0].status = 'APPROVED';
    const res = await press();
    expect(res.status).toBe(200);
    expect((await res.json()).parked).toBe(3);
  });
});

describe('NEGATIVE — what it refuses, writing nothing', () => {
  it('a closed statement: the one sentence of a closed statement, and no row moves', async () => {
    state.statements[0].approvedAt = EARLIER;
    state.statements[0].matchingClosedAt = EARLIER;
    const before = snapshot();
    const res = await press();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'ALREADY_APPROVED', error: STATEMENT_CLOSED_SENTENCE });
    expect(state.matches).toEqual(before);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['four letters', 'سبب'],
    ['five dots', '.....'],
    ['stretch marks', 'ـــــــ'],
    ['not text', null],
  ])('a reason that is not one (%s): 400, nothing read', async (_n, note) => {
    const res = await press(note);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.error).not.toMatch(/[A-Za-z]{3}/);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(rowOf('a1').resolution).toBeNull();
  });

  it('a statement of another store: 404, and its rows untouched', async () => {
    const before = snapshot();
    const res = await press(REASON, 'st9');
    expect(res.status).toBe(404);
    expect(state.matches).toEqual(before);
  });

  it('a statement of another company under the same store id: 404 — the statement read is held to the company', async () => {
    const before = snapshot();
    const res = await press(REASON, 'stY');
    expect(res.status).toBe(404);
    expect(state.matches).toEqual(before);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a statement of another company, asked from this one: 404, nothing moves', async () => {
    const before = snapshot();
    const res = await press(REASON, 'stX');
    expect(res.status).toBe(404);
    expect(state.matches).toEqual(before);
  });

  it('a row tied to an order in the middle of the press: the whole press is refused and NO row is left parked', async () => {
    state.between = () => {
      rowOf('a2').orderId = 'o9';
    };
    const res = await press();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGED');
    for (const id of PARKED_IDS) expect(rowOf(id).resolution, id).toBeNull();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a row answered by somebody else in the middle: refused, nothing parked, her answer stands', async () => {
    state.between = () => {
      Object.assign(rowOf('a3'), { resolution: 'UNDER_REVIEW', resolutionNote: 'سببها هي', resolvedById: 'u8' });
    };
    const res = await press();
    expect(res.status).toBe(409);
    expect(rowOf('a1').resolution).toBeNull();
    expect(rowOf('a2').resolution).toBeNull();
    // (her own transaction is not rolled back with ours in a real database; here it shares the fake's, so what is asserted is that OURS wrote nothing on it.)
    expect(rowOf('a3').resolvedById).not.toBe('u1');
  });

  it('a failure of the database in the middle of the write: nothing is left parked, no audit row', async () => {
    state.failWrite = true;
    const res = await press();
    expect(res.status).toBe(500);
    for (const id of PARKED_IDS) expect(rowOf(id).resolution, id).toBeNull();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a statement that does not exist: 404', async () => {
    const res = await press(REASON, 'nope');
    expect(res.status).toBe(404);
  });
});

describe('it writes the match rows and nothing else', () => {
  it('reaches no model but the statement (read, locked) and its match rows — no wallet, order, note, commission, expense', async () => {
    await press();
    expect([...touched].sort()).toEqual(['$queryRaw', 'courierStatement', 'settlementMatch']);
  });

  it('and so after a park the money and the orders are as they were — nothing but the three rows changed', async () => {
    const before = snapshot();
    await press();
    const changed = state.matches.filter((m, i) => JSON.stringify(m) !== JSON.stringify(before[i])).map((m) => m.id);
    expect(changed).toEqual(PARKED_IDS);
  });
});

describe('the key — «مراجعة المطابقات», asked through the engine a session uses', () => {
  const forbidden = async () => {
    const before = snapshot();
    const res = await press();
    expect(res.status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(state.matches).toEqual(before);
  };

  it('a role that carries it is let in', async () => {
    await as(REVIEWER);
    expect((await press()).status).toBe(200);
  });

  it('NEGATIVE: who only SEES the statements is refused, and nothing is read', async () => {
    await as({ keys: ['settlement.view', 'settlement.upload'] });
    await forbidden();
  });

  it('NEGATIVE: a «منع» on the key beats a role that carries it', async () => {
    await as({ ...REVIEWER, deny: ['settlement.review'] });
    await forbidden();
  });

  it('NEGATIVE: no key at all', async () => {
    await as({ keys: [] });
    await forbidden();
  });

  it('a legacy account with no role row follows its role: a settlement officer is let in, a confirmation agent is not', async () => {
    await as({ legacy: 'SETTLEMENT_OFFICER' });
    expect((await press()).status).toBe(200);
    await as({ legacy: 'CONFIRMATION_AGENT' });
    expect((await press()).status).toBe(403);
  });
});
