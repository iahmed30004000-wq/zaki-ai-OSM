import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earlyMessage, pressMessage, SETTLING_WORDS } from '@/lib/per-line-settlement-words';

/**
 * THE LIST OF STATEMENTS CARRIES THE NEW WORDS — AND THE COUNT OF CLEAN LINES WAITING — ONLY WHILE THE OWNER’S SWITCH IS ON (S8).
 *
 * With the switch off this answer is what it was: no `settling`, no `cleanWaiting`, and not one extra query. With it on the screens
 * receive the sentences that are true in that mode (`per-line-settlement-words`), and for each statement the number on the press
 * «سوّي الطلبات النظيفة هلّق»: the clean lines of an approved, still-open statement whose orders are not settled yet.
 */

const { db, state, requireContext, requirePermission, receiptGap } = vi.hoisted(() => {
  const state = {
    switchOn: false,
    switchBroken: false,
    statements: [] as Record<string, any>[],
    open: [] as { statementId: string; _count: { _all: number } }[],
    waiting: [] as { statementId: string; _count: { _all: number } }[],
  };
  const db = {
    company: {
      findUnique: vi.fn(async () => {
        if (state.switchBroken) throw new Error('db down');
        return { settings: JSON.stringify(state.switchOn ? { perLineSettlement: { enabled: true, enabledAt: '2026-11-09T06:00:00.000Z' } } : {}) };
      }),
    },
    courierStatement: { findMany: vi.fn(async () => state.statements) },
    settlementMatch: {
      groupBy: vi.fn(async (a: { where: Record<string, any> }) => ('result' in a.where ? state.waiting : state.open)),
    },
  };
  return { db, state, requireContext: vi.fn(), requirePermission: vi.fn(), receiptGap: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/settlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/settlement')>()),
  receiptGap: (...a: unknown[]) => receiptGap(...a),
}));

import { GET } from './route';
import { forgetPerLineSwitch } from '@/lib/per-line-settlement-switch';

const statement = (id: string) => ({
  id, reference: `ST-${id}`, fileName: 'x.xlsx', status: 'APPROVED', approvedAt: new Date('2026-11-09T08:00:00Z'), matchingClosedAt: null,
  fileHash: 'ab'.repeat(32), currencyCode: 'JOD', totalAmount: 20, createdAt: new Date('2026-11-08T00:00:00Z'), periodFrom: null, periodTo: null,
  _count: { lines: 2, receipts: 1, matches: 2 }, receipts: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  forgetPerLineSwitch();
  state.switchOn = false;
  state.switchBroken = false;
  state.statements = [statement('a'), statement('b')];
  state.open = [{ statementId: 'a', _count: { _all: 1 } }];
  state.waiting = [{ statementId: 'a', _count: { _all: 4 } }];
  requireContext.mockResolvedValue({ companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
  requirePermission.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 20, received: 20, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
});

describe('the switch OFF — the list is what it was', () => {
  it('carries no words, no count of clean lines waiting, and asks the database nothing more', async () => {
    const body = await (await GET()).json();
    expect(body).not.toHaveProperty('settling');
    for (const s of body.statements) expect(s.counts).not.toHaveProperty('cleanWaiting');
    expect(body.statements[0].counts).toEqual({ lines: 2, receipts: 1, matches: 2, openLines: 1 });
    expect(db.settlementMatch.groupBy).toHaveBeenCalledTimes(1);
  });

  it('a switch that cannot be read is OFF too', async () => {
    state.switchOn = true;
    state.switchBroken = true;
    const body = await (await GET()).json();
    expect(body).not.toHaveProperty('settling');
    expect(db.settlementMatch.groupBy).toHaveBeenCalledTimes(1);
  });
});

describe('the switch ON', () => {
  beforeEach(() => {
    state.switchOn = true;
  });

  it('sends the words of that mode, whole', async () => {
    const body = await (await GET()).json();
    expect(body.settling).toEqual(SETTLING_WORDS);
  });

  it('sends, for each statement, how many clean lines wait — 0 for a statement with none', async () => {
    const body = await (await GET()).json();
    expect(body.statements.map((s: { id: string; counts: { cleanWaiting: number } }) => [s.id, s.counts.cleanWaiting])).toEqual([['a', 4], ['b', 0]]);
    // The counts it always had are still there, beside it.
    expect(body.statements[0].counts).toMatchObject({ lines: 2, receipts: 1, matches: 2, openLines: 1, cleanWaiting: 4 });
  });

  it('asks for the clean lines the way the press would settle them: matched, with an order, not applied, of an approved statement whose matching is open', async () => {
    await GET();
    const ask = db.settlementMatch.groupBy.mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where).find((w) => 'result' in w)!;
    expect(ask).toEqual({
      companyId: 'c1', statementId: { in: ['a', 'b'] }, result: 'MATCHED', orderId: { not: null }, appliedAt: null,
      statement: { approvedAt: { not: null }, matchingClosedAt: null },
    });
  });

  it('with no statement at all it asks nothing', async () => {
    state.statements = [];
    const body = await (await GET()).json();
    expect(body.statements).toEqual([]);
    expect(db.settlementMatch.groupBy).not.toHaveBeenCalled();
  });
});

describe('the sentences the early step and the press answer with', () => {
  it('the approval says how many were settled, and how many were left for the close', () => {
    expect(earlyMessage({ ran: true, settled: 5, heldBack: 0, failed: false })).toBe('تسوّى 5 طلب نظيف مع الاعتماد');
    expect(earlyMessage({ ran: true, settled: 5, heldBack: 2, failed: false })).toBe('تسوّى 5 طلب نظيف مع الاعتماد، و2 بقوا للإغلاق (تغيّر وضعهم)');
  });

  it('and what is left beyond one transaction’s share, with the way to settle it', () => {
    expect(earlyMessage({ ran: true, settled: 300, heldBack: 0, failed: false, remaining: 5 })).toBe('تسوّى 300 طلب نظيف مع الاعتماد. بقي 5 نظيف — زر «سوّي الطلبات النظيفة»');
    expect(pressMessage({ settled: 5, heldBack: 0, remaining: 20 })).toBe('تسوّى 5 طلب نظيف. بقي 20 نظيف — اضغط مرة تانية');
    // Nothing settled and nothing left out is the only “nothing waiting”.
    expect(pressMessage({ settled: 0, heldBack: 0, remaining: 0 })).toBe('ما في طلبات نظيفة بتنتظر التسوية');
  });

  it('says nothing when there was nothing to say — the step did not run, or found nothing', () => {
    expect(earlyMessage({ ran: false, settled: 0, heldBack: 0, failed: false })).toBe('');
    expect(earlyMessage({ ran: true, settled: 0, heldBack: 0, failed: false })).toBe('');
  });

  it('says plainly that the step undid itself and what happens instead', () => {
    expect(earlyMessage({ ran: true, settled: 0, heldBack: 0, failed: true })).toBe('تعذّرت تسوية الطلبات النظيفة مع الاعتماد — بتتسوّى كلها عند «إغلاق المطابقة»');
  });

  it('the press says how many it settled, and that none was waiting when none was', () => {
    expect(pressMessage({ settled: 3, heldBack: 0 })).toBe('تسوّى 3 طلب نظيف');
    expect(pressMessage({ settled: 1, heldBack: 2 })).toBe('تسوّى 1 طلب نظيف، و2 بقوا للإغلاق (تغيّر وضعهم)');
    expect(pressMessage({ settled: 0, heldBack: 0 })).toBe('ما في طلبات نظيفة بتنتظر التسوية');
  });

  it('every sentence is spoken Arabic with no English word', () => {
    const all = [
      ...Object.values(SETTLING_WORDS),
      earlyMessage({ ran: true, settled: 1, heldBack: 1, failed: false }),
      earlyMessage({ ran: true, settled: 0, heldBack: 0, failed: true }),
      pressMessage({ settled: 1, heldBack: 1 }),
      pressMessage({ settled: 0, heldBack: 0 }),
    ];
    for (const text of all) expect(/[A-Za-z]/.test(text), text).toBe(false);
  });
});
