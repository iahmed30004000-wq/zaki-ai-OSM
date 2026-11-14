import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * «هل لازم أعمل قيد عكسي بالمكانين؟» — THE TRANSFERS SCREEN'S DOOR: ONE PRESS, BOTH LEGS.
 *
 * `PATCH /api/finance/transfers/:id { reason }` writes the opposite entry of every leg of the transfer still standing, in
 * one transaction, with one reason; under the key that WRITES a transfer (`finance.cashbox`); inside the session's company
 * and nowhere else; refused when there is nothing left to reverse. The ledger below is real enough to be read afterwards.
 */

const { db, requireContext, requirePermission, logAudit, state } = vi.hoisted(() => ({
  db: { $transaction: vi.fn() },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  state: { tx: null as unknown },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { PATCH } from './route';

interface Row {
  id: string; companyId: string; walletId: string; direction: 'IN' | 'OUT'; amount: number; currencyCode: string; party: string;
  category: string; note: string; referenceType: string | null; referenceId: string | null; reversalOfId: string | null;
  reversalReason?: string | null; createdById: string; createdAt: Date;
}
type Where = Record<string, unknown>;

function ledger(seed: Row[], transfers: { id: string; companyId: string }[]) {
  const rows: Row[] = [...seed];
  let made = 0;
  const holds = (row: object, where: Where) =>
    Object.entries(where).every(([key, want]) => {
      const have = (row as Record<string, unknown>)[key];
      if (want && typeof want === 'object' && 'not' in want) return have !== (want as { not: unknown }).not;
      if (want && typeof want === 'object' && 'in' in want) return (want as { in: unknown[] }).in.includes(have);
      return have === want;
    });
  const tx = {
    walletTransfer: { findFirst: async ({ where }: { where: Where }) => transfers.find((t) => holds(t, where)) ?? null },
    walletMovement: {
      findFirst: async ({ where }: { where: Where }) => rows.find((r) => holds(r, where)) ?? null,
      findUnique: async ({ where }: { where: Where }) => rows.find((r) => holds(r, where)) ?? null,
      findMany: async ({ where }: { where: Where }) =>
        rows.filter((r) => holds(r, where)).map((r) => {
          const reversedBy = rows.find((x) => x.reversalOfId === r.id);
          return { ...r, reversedBy: reversedBy ? { id: reversedBy.id } : null };
        }),
      create: async ({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
        made += 1;
        const row = { id: `rev-${made}`, createdAt: new Date(2026, 10, 14, 21, 28, made), ...data } as Row;
        rows.push(row);
        return row;
      },
    },
  };
  return { tx, rows };
}

const T1 = '11111111-1111-4111-8111-111111111111';
const base = { companyId: 'c1', createdById: 'u1', referenceType: 'TRANSFER', referenceId: T1, reversalOfId: null, note: 'تصريف من ليرة لدولار', createdAt: new Date(2026, 10, 14, 21, 27) };
const OUT_LEG: Row = { ...base, id: 'leg-out', walletId: 'sham', direction: 'OUT', amount: 663958, currencyCode: 'SYP', party: 'تحويل إلى binance', category: 'TRANSFER_OUT' };
const IN_LEG: Row = { ...base, id: 'leg-in', walletId: 'binance', direction: 'IN', amount: 4501.41, currencyCode: 'USDT', party: 'تحويل من شام كاش سوري', category: 'TRANSFER_IN' };
const HAND: Row = { ...IN_LEG, id: 'by-hand', direction: 'OUT', reversalOfId: 'leg-in', reversalReason: 'خطأ من البنت' };
const REASON = 'سُجِّل التحويل بالخطأ';

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const press = (id: string, body: unknown = { reason: REASON }) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), params(id));

let rows: Row[];
const open = (seed: Row[], transfers = [{ id: T1, companyId: 'c1' }]) => {
  const l = ledger(seed, transfers);
  rows = l.rows;
  state.tx = l.tx;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u9' }, companyId: 'c1' });
  requirePermission.mockResolvedValue(undefined);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(state.tx));
  open([OUT_LEG, IN_LEG]);
});

describe('the key', () => {
  it('is the one that WRITES a transfer, asked before anything is read or written', async () => {
    await press(T1);
    expect(requirePermission).toHaveBeenCalledWith('finance.cashbox');
  });

  it('NEGATIVE: without it the press is refused (403) and nothing is written, audited or even started', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission finance.cashbox'));
    const res = await press(T1);
    expect(res.status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
  });
});

describe('what a press needs', () => {
  it('NEGATIVE: a reason shorter than five letters is a 400 and writes nothing', async () => {
    for (const reason of ['', '   ', 'خطأ']) {
      const res = await press(T1, { reason });
      expect(res.status).toBe(400);
    }
    expect((await press(T1, {})).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
  });

  it('NEGATIVE: an id that is not a transfer’s id at all is «not found», not a database error', async () => {
    const res = await press('not-an-id');
    expect(res.status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('one press, both legs', () => {
  it('writes the opposite entry of BOTH legs in ONE transaction, with the one reason, and says so', async () => {
    const res = await press(T1);
    expect(res.status).toBe(201);
    expect(db.$transaction).toHaveBeenCalledTimes(1);

    const written = rows.filter((r) => r.reversalOfId);
    expect(written).toHaveLength(2);
    expect(written.find((r) => r.reversalOfId === 'leg-in')).toMatchObject({ walletId: 'binance', direction: 'OUT', amount: 4501.41, currencyCode: 'USDT', reversalReason: REASON, createdById: 'u9' });
    expect(written.find((r) => r.reversalOfId === 'leg-out')).toMatchObject({ walletId: 'sham', direction: 'IN', amount: 663958, currencyCode: 'SYP', reversalReason: REASON, createdById: 'u9' });

    const body = await res.json();
    expect(body.transferId).toBe(T1);
    expect(body.alreadyReversed).toBe(0);
    expect(body.reversals).toHaveLength(2);
  });

  it('writes ONE line in the transfer’s own trail, with the reason and the two reversing entries', async () => {
    await press(T1);
    expect(logAudit).toHaveBeenCalledTimes(1);
    const call = logAudit.mock.calls[0][0];
    expect(call).toMatchObject({ companyId: 'c1', userId: 'u9', action: 'WALLET_TRANSFER_REVERSED', entity: 'WalletTransfer', entityId: T1 });
    expect(call.newData).toMatchObject({ reason: REASON, alreadyReversed: 0 });
    expect(call.newData.reversals).toHaveLength(2);
  });

  it('finishes a half-made reversal: only the leg that is left is written, and the answer says one was done before', async () => {
    open([OUT_LEG, IN_LEG, HAND]);
    const res = await press(T1);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.alreadyReversed).toBe(1);
    expect(body.reversals.map((r: Row) => r.reversalOfId)).toEqual(['leg-out']);
    // The Binance leg keeps the one reversal it had.
    expect(rows.filter((r) => r.reversalOfId === 'leg-in')).toHaveLength(1);
  });
});

describe('what it refuses', () => {
  it('a transfer reversed whole is a 409 with its own code — nothing is written and nothing is audited', async () => {
    await press(T1);
    vi.clearAllMocks();
    requireContext.mockResolvedValue({ user: { id: 'u9' }, companyId: 'c1' });
    requirePermission.mockResolvedValue(undefined);
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(state.tx));
    const count = rows.length;

    const again = await press(T1);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('ALREADY_REVERSED');
    expect(rows).toHaveLength(count);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('NEGATIVE: ANOTHER COMPANY’S transfer is «not found» — the company is the session’s, never the body’s', async () => {
    open([{ ...OUT_LEG, companyId: 'c2' }, { ...IN_LEG, companyId: 'c2' }], [{ id: T1, companyId: 'c2' }]);
    const res = await press(T1, { reason: REASON, companyId: 'c2' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    expect(rows).toHaveLength(2);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a transfer with no movements is a 409 — there is nothing to reverse', async () => {
    open([]);
    const res = await press(T1);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NO_LEGS');
  });

  it('two presses at once: the loser meets the unique column, is told so (409), and nothing is audited for it', async () => {
    db.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }));
    const res = await press(T1);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_REVERSED');
    expect(logAudit).not.toHaveBeenCalled();
  });
});
