import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { cancelExpense } from './expense-void';
import { ExpenseRefused, markExpenseVoided, reverseMovement } from './wallets';

/**
 * CANCELLING AN EXPENSE: THE MONEY COMES BACK AND THE PROFIT STOPS COUNTING IT — TOGETHER.
 *
 * Before: reversing an expense's money from the wallet screen returned the money and left the expense
 * subtracting from profit (the books said it was spent, the drawer said it was there). These run the real
 * `cancelExpense` / `reverseMovement` / `markExpenseVoided` over an in-memory database that evaluates the
 * `where` it is given, so a condition that is missing from a query is a row that is wrongly found.
 */

type Row = Record<string, any>;

/** The few `where` shapes these functions use: equality, null, `OR`, and a relation filter on `reversedBy`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
    return row[key] === want;
  });
}

function fakeTx() {
  const log: string[] = [];
  const data = {
    expense: [] as Row[],
    wallet: [] as Row[],
    walletMovement: [] as Row[],
  };
  const tx = {
    expense: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => data.expense.find((r) => matches(r, where)) ?? null),
      updateMany: vi.fn(async ({ where, data: set }: { where: Row; data: Row }) => {
        const hit = data.expense.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, set));
        if (hit.length) log.push('expense.mark');
        return { count: hit.length };
      }),
    },
    wallet: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => data.wallet.find((r) => matches(r, where)) ?? null),
    },
    walletMovement: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const m = data.walletMovement.find((r) => matches(r, { ...where }));
        if (!m) return null;
        const reversal = data.walletMovement.find((r) => r.reversalOfId === m.id);
        return { ...m, reversedBy: reversal ? { id: reversal.id } : null };
      }),
      findUnique: vi.fn(async ({ where }: { where: { reversalOfId: string } }) =>
        data.walletMovement.find((r) => r.reversalOfId === where.reversalOfId) ?? null),
      create: vi.fn(async ({ data: row }: { data: Row }) => {
        const made = { id: `rev-${data.walletMovement.length + 1}`, ...row };
        data.walletMovement.push(made);
        log.push('movement.reverse');
        return made;
      }),
    },
  };
  return { tx: tx as any, data, log };
}

/** Store s1 and store s2, each with a wallet; one expense per case. */
function world() {
  const w = fakeTx();
  w.data.wallet.push(
    { id: 'w1', companyId: 'c1', storeId: 's1' },
    { id: 'w2', companyId: 'c1', storeId: 's2' },
    { id: 'w0', companyId: 'c1', storeId: null },
  );
  const pay = (id: string, wallet: string, expenseId: string, amount = 100) =>
    w.data.walletMovement.push({
      id, companyId: 'c1', walletId: wallet, direction: 'OUT', amount, currencyCode: 'JOD', party: 'x',
      category: 'EXPENSE', note: 'مصروف: x', referenceType: 'EXPENSE', referenceId: expenseId, reversalOfId: null,
    });
  const spend = (id: string, storeId: string | null, wallet: string | null, movementId: string | null) =>
    w.data.expense.push({ id, companyId: 'c1', storeId, walletId: wallet, movementId, amount: 100, voidedAt: null });

  spend('e1', 's1', 'w1', 'm1'); pay('m1', 'w1', 'e1');
  spend('e2', 's2', 'w2', 'm2'); pay('m2', 'w2', 'e2');
  spend('e3', null, 'w1', 'm3'); pay('m3', 'w1', 'e3'); // from before expenses had a store
  spend('e4', 's1', null, null); // no wallet: nothing to give back
  spend('e5', null, 'w2', 'm5'); pay('m5', 'w2', 'e5'); // unplaced expense whose money left store s2's wallet
  spend('e6', 's1', 'w1', 'm6'); pay('m6', 'w1', 'e6');
  w.data.walletMovement.push({ id: 'm6-back', companyId: 'c1', walletId: 'w1', reversalOfId: 'm6', direction: 'IN', amount: 100 });
  return w;
}

const ask = (over: Partial<Parameters<typeof cancelExpense>[1]> = {}) => ({
  companyId: 'c1', storeId: 's1', expenseId: 'e1', reason: 'سُجِّل بالخطأ', userId: 'u1', ...over,
});

const refused = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof ExpenseRefused ? e.code : `other:${(e as Error).message}`; }
  return 'no refusal';
};

let w: ReturnType<typeof world>;
beforeEach(() => { w = world(); });

describe('cancelling an expense from its own list', () => {
  it('gives the money back by a reversing entry AND marks the expense — the worked example', async () => {
    const out = await cancelExpense(w.tx, ask());
    expect(out).toEqual({ reversalId: 'rev-' + w.data.walletMovement.length, moneyReturned: true });
    const e1 = w.data.expense.find((e) => e.id === 'e1')!;
    expect(e1.voidedAt).toBeInstanceOf(Date);
    expect(e1).toMatchObject({ voidReason: 'سُجِّل بالخطأ', voidedById: 'u1' });
    // The reversal is the OPPOSITE of the original, the original's amount, linked to it.
    const back = w.data.walletMovement.find((m) => m.reversalOfId === 'm1')!;
    expect(back).toMatchObject({ direction: 'IN', amount: 100, walletId: 'w1', referenceType: 'EXPENSE', referenceId: 'e1' });
  });

  it('marks the expense BEFORE the money moves, so a refused mark leaves the wallet untouched', async () => {
    await cancelExpense(w.tx, ask());
    expect(w.log).toEqual(['expense.mark', 'movement.reverse']);
  });

  it('NEGATIVE: another store’s expense is not found — and nothing is written', async () => {
    expect(await refused(cancelExpense(w.tx, ask({ expenseId: 'e2' })))).toBe('NOT_FOUND');
    expect(w.log).toEqual([]);
    expect(w.data.expense.find((e) => e.id === 'e2')!.voidedAt).toBeNull();
  });

  it('NEGATIVE: another company’s expense is not found either', async () => {
    expect(await refused(cancelExpense(w.tx, ask({ companyId: 'c2' })))).toBe('NOT_FOUND');
    expect(w.log).toEqual([]);
  });

  it('an expense from before stores (store null) can be cancelled from any store', async () => {
    const out = await cancelExpense(w.tx, ask({ expenseId: 'e3' }));
    expect(out.moneyReturned).toBe(true);
    expect(w.data.expense.find((e) => e.id === 'e3')!.voidedAt).toBeInstanceOf(Date);
  });

  it('NEGATIVE: an unplaced expense whose money left ANOTHER store’s wallet is refused — no money is put into that wallet', async () => {
    expect(await refused(cancelExpense(w.tx, ask({ expenseId: 'e5' })))).toBe('OTHER_STORE');
    expect(w.log).toEqual([]);
    expect(w.data.expense.find((e) => e.id === 'e5')!.voidedAt).toBeNull();
  });

  it('an expense with no wallet is marked only — there is no money to return', async () => {
    const out = await cancelExpense(w.tx, ask({ expenseId: 'e4' }));
    expect(out).toEqual({ reversalId: null, moneyReturned: false });
    expect(w.log).toEqual(['expense.mark']);
  });

  it('an expense whose money was already given back by hand is marked only — never returned twice', async () => {
    const out = await cancelExpense(w.tx, ask({ expenseId: 'e6' }));
    expect(out).toEqual({ reversalId: null, moneyReturned: false });
    expect(w.log).toEqual(['expense.mark']);
    expect(w.data.walletMovement.filter((m) => m.reversalOfId === 'm6')).toHaveLength(1);
  });

  it('NEGATIVE: a second cancel is refused, and gives nothing back again', async () => {
    await cancelExpense(w.tx, ask());
    const movements = w.data.walletMovement.length;
    expect(await refused(cancelExpense(w.tx, ask()))).toBe('ALREADY_VOID');
    expect(w.data.walletMovement).toHaveLength(movements);
  });

  it('NEGATIVE: a movement that is not this expense’s is refused', async () => {
    w.data.walletMovement.find((m) => m.id === 'm1')!.referenceId = 'e-other';
    expect(await refused(cancelExpense(w.tx, ask()))).toBe('NOT_PAID_BY_THIS');
    expect(w.log).toEqual([]);
  });
});

describe('reversing the movement of an expense from the wallet screen', () => {
  const reverse = (over: Record<string, unknown> = {}) =>
    reverseMovement(w.tx, { companyId: 'c1', walletId: 'w1', movementId: 'm1', reason: 'سُجِّل بالخطأ', createdById: 'u1', ...over });

  it('cancels the expense in the same call, when the caller may edit finance', async () => {
    await reverse({ mayCancelExpense: true });
    expect(w.data.expense.find((e) => e.id === 'e1')!.voidedAt).toBeInstanceOf(Date);
    expect(w.log).toEqual(['expense.mark', 'movement.reverse']);
  });

  it('NEGATIVE: a caller who did not say so cannot cancel an expense by the back door — nothing is written', async () => {
    expect(await refused(reverse())).toBe('NOT_ALLOWED');
    expect(await refused(reverse({ mayCancelExpense: false }))).toBe('NOT_ALLOWED');
    expect(w.log).toEqual([]);
    expect(w.data.expense.find((e) => e.id === 'e1')!.voidedAt).toBeNull();
  });

  it('NEGATIVE: an expense that is already cancelled stops the reversal before any money moves', async () => {
    w.data.expense.find((e) => e.id === 'e1')!.voidedAt = new Date();
    expect(await refused(reverse({ mayCancelExpense: true }))).toBe('ALREADY_VOID');
    expect(w.log).toEqual([]);
  });

  it('NEGATIVE: a movement that points at an expense which names a different movement writes nothing', async () => {
    w.data.expense.find((e) => e.id === 'e1')!.movementId = 'm-someone-else';
    expect(await refused(reverse({ mayCancelExpense: true }))).toBe('NOT_PAID_BY_THIS');
    expect(w.log).toEqual([]);
  });

  it('a movement that is not an expense’s is reversed exactly as before, with no expense touched', async () => {
    w.data.walletMovement.push({ id: 'mx', companyId: 'c1', walletId: 'w1', direction: 'IN', amount: 7, currencyCode: 'JOD',
      party: 'x', category: 'OTHER', note: 'n', referenceType: null, referenceId: null, reversalOfId: null });
    await reverse({ movementId: 'mx' });
    expect(w.log).toEqual(['movement.reverse']);
  });
});

describe('the mark itself', () => {
  it('is one conditional write: the expense, this movement, and not yet cancelled', async () => {
    await markExpenseVoided(w.tx, { companyId: 'c1', expenseId: 'e1', movementId: 'm1', reason: 'سبب', userId: 'u1' });
    expect(w.tx.expense.updateMany.mock.calls[0][0].where).toEqual({
      id: 'e1', companyId: 'c1', movementId: 'm1', voidedAt: null,
    });
  });

  it('says ALREADY_VOID for a cancelled row and NOT_PAID_BY_THIS for one that was never this movement’s', async () => {
    const p = { companyId: 'c1', reason: 'سبب', userId: 'u1' };
    expect(await refused(markExpenseVoided(w.tx, { ...p, expenseId: 'e1', movementId: 'wrong' }))).toBe('NOT_PAID_BY_THIS');
    w.data.expense.find((e) => e.id === 'e1')!.voidedAt = new Date();
    expect(await refused(markExpenseVoided(w.tx, { ...p, expenseId: 'e1', movementId: 'm1' }))).toBe('ALREADY_VOID');
    expect(await refused(markExpenseVoided(w.tx, { ...p, expenseId: 'ghost', movementId: 'm1' }))).toBe('NOT_PAID_BY_THIS');
  });
});
