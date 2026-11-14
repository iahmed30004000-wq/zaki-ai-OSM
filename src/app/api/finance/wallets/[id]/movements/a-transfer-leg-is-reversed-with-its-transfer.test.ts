import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «القيد العكسي ما بيسمع بالتحويلات» — THE WALLET'S «قيد عكسي» ON A TRANSFER'S LEG.
 *
 * The owner pressed it on the Binance leg of a transfer and the Sham Cash leg stayed standing. The door
 * (`PATCH /api/finance/wallets/:id/movements`) is unchanged in what it asks — the key, the wallet of the store, the
 * reason — but `reverseMovement` now carries the other leg of the same transfer with it, in the same transaction, and the
 * door says so: the transfer's own trail gets a line and the answer says `transferReversed`, which the screen tells the
 * person. A movement that is not a transfer's is reversed alone, exactly as before.
 */

const { db, requireContext, requirePermission, logAudit, walletBalance, state } = vi.hoisted(() => ({
  db: { wallet: { findFirst: vi.fn() }, $transaction: vi.fn() },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  walletBalance: vi.fn(),
  state: { tx: null as unknown },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  walletBalance: (...a: unknown[]) => walletBalance(...a),
}));

import { PATCH } from './route';

interface Row {
  id: string; companyId: string; walletId: string; direction: 'IN' | 'OUT'; amount: number; currencyCode: string; party: string;
  category: string; note: string; referenceType: string | null; referenceId: string | null; reversalOfId: string | null;
  reversalReason?: string | null; createdById: string; createdAt: Date;
}
type Where = Record<string, unknown>;

function ledger(seed: Row[]) {
  const rows: Row[] = [...seed];
  let made = 0;
  const holds = (row: object, where: Where) =>
    Object.entries(where).every(([key, want]) => {
      const have = (row as Record<string, unknown>)[key];
      if (want && typeof want === 'object' && 'not' in want) return have !== (want as { not: unknown }).not;
      return have === want;
    });
  const tx = {
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

const SHAM = '22222222-2222-4222-8222-222222222222';
const BINANCE = '33333333-3333-4333-8333-333333333333';
const OUT_ID = '44444444-4444-4444-8444-444444444444';
const IN_ID = '55555555-5555-4555-8555-555555555555';
const PLAIN_ID = '66666666-6666-4666-8666-666666666666';
const STATEMENT_ID = '77777777-7777-4777-8777-777777777777';
const T1 = '88888888-8888-4888-8888-888888888888';

const base = { companyId: 'c1', createdById: 'u1', reversalOfId: null, createdAt: new Date(2026, 10, 14, 21, 27) };
const transferLeg = { ...base, referenceType: 'TRANSFER', referenceId: T1, note: 'تصريف من ليرة لدولار' };
const OUT_LEG: Row = { ...transferLeg, id: OUT_ID, walletId: SHAM, direction: 'OUT', amount: 663958, currencyCode: 'SYP', party: 'تحويل إلى binance', category: 'TRANSFER_OUT' };
const IN_LEG: Row = { ...transferLeg, id: IN_ID, walletId: BINANCE, direction: 'IN', amount: 4501.41, currencyCode: 'USDT', party: 'تحويل من شام كاش سوري', category: 'TRANSFER_IN' };
const PLAIN: Row = { ...base, id: PLAIN_ID, walletId: BINANCE, direction: 'IN', amount: 10, currencyCode: 'USDT', party: 'زبون', category: 'OTHER', note: 'حركة يدوية', referenceType: null, referenceId: null };
const STATEMENT: Row = { ...PLAIN, id: STATEMENT_ID, category: 'COURIER_SETTLEMENT', referenceType: 'STATEMENT', referenceId: T1 };
const HAND: Row = { ...IN_LEG, id: '99999999-9999-4999-8999-999999999999', direction: 'OUT', reversalOfId: IN_ID, reversalReason: 'خطأ من البنت' };
const REASON = 'خطأ من البنت';

let rows: Row[];
const open = (seed: Row[]) => {
  const l = ledger(seed);
  rows = l.rows;
  state.tx = l.tx;
};
const press = (walletId: string, movementId: string) =>
  PATCH(
    new Request('http://localhost/x', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ movementId, reason: REASON }) }),
    { params: Promise.resolve({ id: walletId }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u9', name: 'أحمد' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({});
  db.wallet.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, name: 'محفظة', isActive: true, country: { minorUnit: 2 } }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(state.tx));
  walletBalance.mockResolvedValue({ balance: 0 });
  open([OUT_LEG, IN_LEG, PLAIN, STATEMENT]);
});

describe('a leg of a transfer', () => {
  it('reversed from the Binance wallet reverses the Sham Cash leg too — the owner’s own case, both rows, one transaction', async () => {
    const res = await press(BINANCE, IN_ID);
    expect(res.status).toBe(201);
    expect(db.$transaction).toHaveBeenCalledTimes(1);

    const written = rows.filter((r) => r.reversalOfId);
    expect(written).toHaveLength(2);
    expect(written.find((r) => r.reversalOfId === IN_ID)).toMatchObject({ walletId: BINANCE, direction: 'OUT', amount: 4501.41, reversalReason: REASON });
    expect(written.find((r) => r.reversalOfId === OUT_ID)).toMatchObject({ walletId: SHAM, direction: 'IN', amount: 663958, reversalReason: REASON });

    const body = await res.json();
    // The answer is still the entry of the movement that was pressed, and says the transfer went whole.
    expect(body.reversal).toMatchObject({ reversalOfId: IN_ID, walletId: BINANCE });
    expect(body.transferReversed).toBe(true);
  });

  it('writes the transfer’s own line in the trail beside the movement’s, with the reason and the wallet it came from', async () => {
    await press(BINANCE, IN_ID);
    expect(logAudit.mock.calls.map((c) => c[0].action)).toEqual(['WALLET_MOVEMENT_REVERSED', 'WALLET_TRANSFER_REVERSED']);
    expect(logAudit.mock.calls[1][0]).toMatchObject({ entity: 'WalletTransfer', entityId: T1 });
    expect(logAudit.mock.calls[1][0].newData).toMatchObject({ reason: REASON, walletId: BINANCE });
  });

  it('finishes a half-made reversal: the leg that is left is the only one written, and the answer still says the transfer is whole', async () => {
    open([OUT_LEG, IN_LEG, HAND]);
    const res = await press(SHAM, OUT_ID);
    expect(res.status).toBe(201);
    expect(rows.filter((r) => r.reversalOfId)).toHaveLength(2);
    expect(rows.filter((r) => r.reversalOfId === IN_ID)).toHaveLength(1);
    expect((await res.json()).transferReversed).toBe(true);
  });

  it('NEGATIVE: naming a leg that is not in the wallet of the path reaches neither leg — the wallet check is on something', async () => {
    const res = await press(SHAM, IN_ID);
    expect(res.status).toBe(409);
    expect(rows).toHaveLength(4);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('a movement that is not a transfer’s', () => {
  it('is reversed alone, answered as it always was, and writes no line for a transfer', async () => {
    const res = await press(BINANCE, PLAIN_ID);
    expect(res.status).toBe(201);
    expect(rows.filter((r) => r.reversalOfId)).toHaveLength(1);
    const body = await res.json();
    expect(body.reversal).toMatchObject({ reversalOfId: PLAIN_ID });
    expect('transferReversed' in body).toBe(false);
    expect(logAudit.mock.calls.map((c) => c[0].action)).toEqual(['WALLET_MOVEMENT_REVERSED']);
  });

  it('a statement’s movement is reversed alone even though it carries an id that is a transfer’s', async () => {
    const res = await press(BINANCE, STATEMENT_ID);
    expect(res.status).toBe(201);
    expect(rows.filter((r) => r.reversalOfId).map((r) => r.reversalOfId)).toEqual([STATEMENT_ID]);
    expect('transferReversed' in (await res.json())).toBe(false);
  });
});
