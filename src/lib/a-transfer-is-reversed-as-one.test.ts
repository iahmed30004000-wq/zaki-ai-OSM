import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { reverseMovement, reverseTransfer, TransferReversalRefused, TRANSFER_REVERSAL_REFUSAL_AR } from './wallets';

/**
 * «القيد العكسي ما بيسمع بالتحويلات هاد خطأ عظيم» · «هل لازم أعمل قيد عكسي بالمكانين؟» — 14/11.
 *
 * A transfer is two movements, one in each wallet. The owner pressed «قيد عكسي» on the Binance leg of a transfer of
 * 663,958 SYP into 4,501.41 USDT; the Sham Cash leg stayed standing, and nothing in the transfers list said a word. A
 * leg is now never reversed alone: the reversal of one carries every leg of the SAME transfer still standing, in the same
 * transaction, each through `reverseMovement` — so each is the opposite row of its own original.
 *
 * These run on a small in-memory ledger (not on call shapes), so what is held is what the rows say afterwards.
 */

interface Row {
  id: string;
  companyId: string;
  walletId: string;
  direction: 'IN' | 'OUT';
  amount: number;
  currencyCode: string;
  party: string;
  category: string;
  note: string;
  referenceType: string | null;
  referenceId: string | null;
  reversalOfId: string | null;
  reversalReason?: string | null;
  createdById: string;
  createdAt: Date;
  partnerId?: string | null;
  valueInStoreCurrency?: unknown;
}
type Where = Record<string, unknown>;

/** A ledger with the five reads and the one write the reversal uses, scoped the way the real queries are. */
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
        rows
          .filter((r) => holds(r, where))
          .map((r) => {
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
  return { tx: tx as never, rows };
}

const SHAM = 'w-sham-cash';
const BINANCE = 'w-binance';
const base = {
  companyId: 'c1', createdById: 'u1', referenceType: 'TRANSFER', referenceId: 't1', reversalOfId: null,
  note: 'تصريف من ليرة لدولار', createdAt: new Date(2026, 10, 14, 21, 27, 0),
};
/** The owner's own transfer: 663,958 SYP out of Sham Cash, 4,501.41 USDT into Binance. */
const OUT_LEG: Row = { ...base, id: 'leg-out', walletId: SHAM, direction: 'OUT', amount: 663958, currencyCode: 'SYP', party: 'تحويل إلى binance', category: 'TRANSFER_OUT' };
const IN_LEG: Row = { ...base, id: 'leg-in', walletId: BINANCE, direction: 'IN', amount: 4501.41, currencyCode: 'USDT', party: 'تحويل من شام كاش سوري', category: 'TRANSFER_IN' };
const TRANSFER = { id: 't1', companyId: 'c1' };
const REASON = 'خطأ من البنت';

/** What the person had reversed by hand before this fix existed: the Binance leg only. */
const HAND_REVERSAL_OF_IN: Row = {
  ...IN_LEG, id: 'rev-by-hand', direction: 'OUT', reversalOfId: 'leg-in', reversalReason: REASON,
  note: 'عكس حركة: تصريف من ليرة لدولار', createdAt: new Date(2026, 10, 14, 21, 28, 0),
};

const net = (rows: Row[], walletId: string) =>
  rows.filter((r) => r.walletId === walletId).reduce((sum, r) => sum + (r.direction === 'IN' ? r.amount : -r.amount), 0);

describe('reversing ONE leg of a transfer carries the other leg with it', () => {
  it('writes the opposite entry of BOTH legs — each in its own wallet, in its own currency, for its own amount', async () => {
    const { tx, rows } = ledger([OUT_LEG, IN_LEG], [TRANSFER]);
    const pressed = await reverseMovement(tx, { companyId: 'c1', walletId: BINANCE, movementId: 'leg-in', reason: REASON, createdById: 'u9' });

    const written = rows.filter((r) => r.reversalOfId);
    expect(written).toHaveLength(2);
    expect(written.find((r) => r.reversalOfId === 'leg-in')).toMatchObject({
      walletId: BINANCE, direction: 'OUT', amount: 4501.41, currencyCode: 'USDT', category: 'TRANSFER_IN',
      referenceType: 'TRANSFER', referenceId: 't1', reversalReason: REASON, createdById: 'u9',
    });
    expect(written.find((r) => r.reversalOfId === 'leg-out')).toMatchObject({
      walletId: SHAM, direction: 'IN', amount: 663958, currencyCode: 'SYP', category: 'TRANSFER_OUT',
      referenceType: 'TRANSFER', referenceId: 't1', reversalReason: REASON, createdById: 'u9',
    });
    // The answer is the entry of the leg that was pressed, as the wallet's door has always answered.
    expect(pressed).toMatchObject({ reversalOfId: 'leg-in', walletId: BINANCE });
    // The two originals are never touched.
    expect(rows.find((r) => r.id === 'leg-in')).toMatchObject({ direction: 'IN', amount: 4501.41, reversalOfId: null });
    expect(rows.find((r) => r.id === 'leg-out')).toMatchObject({ direction: 'OUT', amount: 663958, reversalOfId: null });
  });

  it('is the same from the other leg: pressing the Sham Cash leg reverses the Binance leg too', async () => {
    const { tx, rows } = ledger([OUT_LEG, IN_LEG], [TRANSFER]);
    const pressed = await reverseMovement(tx, { companyId: 'c1', walletId: SHAM, movementId: 'leg-out', reason: REASON, createdById: 'u9' });
    expect(rows.filter((r) => r.reversalOfId).map((r) => r.reversalOfId).sort()).toEqual(['leg-in', 'leg-out']);
    expect(pressed).toMatchObject({ reversalOfId: 'leg-out', walletId: SHAM });
  });

  it('leaves each wallet where it stood before the transfer — nothing is lost between the two', async () => {
    const { tx, rows } = ledger([OUT_LEG, IN_LEG], [TRANSFER]);
    expect(net(rows, SHAM)).toBe(-663958);
    expect(net(rows, BINANCE)).toBe(4501.41);
    await reverseMovement(tx, { companyId: 'c1', walletId: BINANCE, movementId: 'leg-in', reason: REASON, createdById: 'u9' });
    expect(net(rows, SHAM)).toBe(0);
    expect(net(rows, BINANCE)).toBe(0);
  });

  it('finishes a half-made reversal: a leg reversed by hand before is skipped and the other is written once', async () => {
    const { tx, rows } = ledger([OUT_LEG, IN_LEG, HAND_REVERSAL_OF_IN], [TRANSFER]);
    // Before: the Binance leg is undone, the Sham Cash lira are still out — the books of 14/11 21:28.
    expect(net(rows, SHAM)).toBe(-663958);
    expect(net(rows, BINANCE)).toBe(0);

    await reverseMovement(tx, { companyId: 'c1', walletId: SHAM, movementId: 'leg-out', reason: 'نكمّل عكس التحويل', createdById: 'u9' });

    const added = rows.filter((r) => r.reversalOfId && r.id !== 'rev-by-hand');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ reversalOfId: 'leg-out', walletId: SHAM, direction: 'IN', amount: 663958 });
    // The Binance leg keeps the ONE reversal it had: not written twice.
    expect(rows.filter((r) => r.reversalOfId === 'leg-in')).toHaveLength(1);
    expect(net(rows, SHAM)).toBe(0);
    expect(net(rows, BINANCE)).toBe(0);
  });

  it('a leg that is already reversed is still refused when pressed again, and nothing is written', async () => {
    const { tx, rows } = ledger([OUT_LEG, IN_LEG, HAND_REVERSAL_OF_IN], [TRANSFER]);
    await expect(
      reverseMovement(tx, { companyId: 'c1', walletId: BINANCE, movementId: 'leg-in', reason: REASON, createdById: 'u9' })
    ).rejects.toThrow(/already reversed/i);
    expect(rows).toHaveLength(3);
  });

  it('never touches the legs of ANOTHER transfer, even in the same two wallets', async () => {
    const other: Row[] = [
      { ...OUT_LEG, id: 'o2', referenceId: 't2' },
      { ...IN_LEG, id: 'i2', referenceId: 't2' },
    ];
    const { tx, rows } = ledger([OUT_LEG, IN_LEG, ...other], [TRANSFER, { id: 't2', companyId: 'c1' }]);
    await reverseMovement(tx, { companyId: 'c1', walletId: BINANCE, movementId: 'leg-in', reason: REASON, createdById: 'u9' });
    expect(rows.filter((r) => r.reversalOfId).map((r) => r.reversalOfId).sort()).toEqual(['leg-in', 'leg-out']);
  });

  it('never touches a leg of ANOTHER company that carries the same transfer id', async () => {
    const foreign: Row = { ...OUT_LEG, id: 'f-out', companyId: 'c2' };
    const { tx, rows } = ledger([OUT_LEG, IN_LEG, foreign], [TRANSFER]);
    await reverseMovement(tx, { companyId: 'c1', walletId: BINANCE, movementId: 'leg-in', reason: REASON, createdById: 'u9' });
    expect(rows.some((r) => r.reversalOfId === 'f-out')).toBe(false);
    expect(rows.filter((r) => r.reversalOfId)).toHaveLength(2);
  });

  it('a movement that is not a transfer’s is reversed alone, as it always was', async () => {
    const courier: Row = {
      ...OUT_LEG, id: 'c-1', walletId: SHAM, direction: 'IN', category: 'COURIER_SETTLEMENT', referenceType: null, referenceId: null, party: 'شركة الشحن',
    };
    const statement: Row = { ...courier, id: 's-1', referenceType: 'STATEMENT', referenceId: 't1' };
    const { tx, rows } = ledger([OUT_LEG, IN_LEG, courier, statement], [TRANSFER]);
    await reverseMovement(tx, { companyId: 'c1', walletId: SHAM, movementId: 'c-1', reason: 'مسجّل مرتين', createdById: 'u9' });
    await reverseMovement(tx, { companyId: 'c1', walletId: SHAM, movementId: 's-1', reason: 'مسجّل مرتين', createdById: 'u9' });
    // Two reversals, one for each; the transfer t1 shares an id with the statement row and is still untouched.
    expect(rows.filter((r) => r.reversalOfId).map((r) => r.reversalOfId).sort()).toEqual(['c-1', 's-1']);
  });
});

describe('reverseTransfer — the transfers screen’s door', () => {
  it('reverses both legs of a standing transfer, and says what it wrote', async () => {
    const { tx, rows } = ledger([OUT_LEG, IN_LEG], [TRANSFER]);
    const done = await reverseTransfer(tx, { companyId: 'c1', transferId: 't1', reason: REASON, createdById: 'u9' });
    expect(done.legs).toBe(2);
    expect(done.alreadyReversed).toBe(0);
    expect(done.reversals.map((r) => r.reversalOfId).sort()).toEqual(['leg-in', 'leg-out']);
    expect(rows.filter((r) => r.reversalOfId)).toHaveLength(2);
    expect(net(rows, SHAM)).toBe(0);
    expect(net(rows, BINANCE)).toBe(0);
  });

  it('a transfer reversed by hand on one side gets only the other, and says one leg was done before', async () => {
    const { tx, rows } = ledger([OUT_LEG, IN_LEG, HAND_REVERSAL_OF_IN], [TRANSFER]);
    const done = await reverseTransfer(tx, { companyId: 'c1', transferId: 't1', reason: 'نكمّل', createdById: 'u9' });
    expect(done.alreadyReversed).toBe(1);
    // Only what THIS press wrote: the hand-made reversal is not in the answer.
    expect(done.reversals.map((r) => r.reversalOfId)).toEqual(['leg-out']);
    expect(net(rows, SHAM)).toBe(0);
  });

  it('refuses a transfer that is already reversed whole — and writes nothing', async () => {
    const { tx, rows } = ledger([OUT_LEG, IN_LEG], [TRANSFER]);
    await reverseTransfer(tx, { companyId: 'c1', transferId: 't1', reason: REASON, createdById: 'u9' });
    const count = rows.length;
    await expect(reverseTransfer(tx, { companyId: 'c1', transferId: 't1', reason: 'مرة ثانية', createdById: 'u9' })).rejects.toMatchObject({
      name: 'TransferReversalRefused', code: 'ALREADY_REVERSED',
    });
    expect(rows).toHaveLength(count);
  });

  it('looks the transfer up INSIDE the company: another company’s transfer is «not found», and nothing is written', async () => {
    const { tx, rows } = ledger([OUT_LEG, IN_LEG], [TRANSFER]);
    await expect(reverseTransfer(tx, { companyId: 'c2', transferId: 't1', reason: REASON, createdById: 'u9' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(rows).toHaveLength(2);
  });

  it('refuses a transfer with no movements at all — there is nothing to reverse', async () => {
    const { tx, rows } = ledger([], [TRANSFER]);
    await expect(reverseTransfer(tx, { companyId: 'c1', transferId: 't1', reason: REASON, createdById: 'u9' })).rejects.toMatchObject({
      code: 'NO_LEGS',
    });
    expect(rows).toHaveLength(0);
  });

  it('does not take a reversing entry for a leg: the reversal rows carry the transfer’s reference too', async () => {
    // The legs are read with `reversalOfId: null`; if the reversal rows were read as legs, a reversed transfer would look
    // as if it had four legs standing and pressing it again would try to reverse a reversal.
    const { tx } = ledger([OUT_LEG, IN_LEG], [TRANSFER]);
    await reverseTransfer(tx, { companyId: 'c1', transferId: 't1', reason: REASON, createdById: 'u9' });
    await expect(reverseTransfer(tx, { companyId: 'c1', transferId: 't1', reason: REASON, createdById: 'u9' })).rejects.toBeInstanceOf(TransferReversalRefused);
  });

  it('says each refusal in a sentence a person can act on', () => {
    expect(TRANSFER_REVERSAL_REFUSAL_AR.ALREADY_REVERSED).toBe('هذا التحويل معكوس بالكامل من قبل');
    expect(new TransferReversalRefused('NOT_FOUND').message).toBe('التحويل غير موجود');
    expect(Object.values(TRANSFER_REVERSAL_REFUSAL_AR).every((s) => /[؀-ۿ]/.test(s))).toBe(true);
  });
});
