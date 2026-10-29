import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { inStoreOrShared } from './store-filter';
import { ExpenseRefused, markExpenseVoided, reverseMovement } from './wallets';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * CANCEL AN EXPENSE — ITS MONEY COMES BACK AND IT LEAVES THE PROFIT, TOGETHER.
 *
 * Before this, an expense could not be undone from where it was made, and
 * undoing its money from the wallet screen left the expense subtracting from
 * profit: the books said the money was spent, the drawer said it was there.
 * An expense is now CANCELLED, never deleted: it stays on the list, marked,
 * with who cancelled it and why (`voidedAt`, `voidReason`, `voidedById`), and
 * every profit figure ignores it (`expensesOf` in expense-scope.ts).
 *
 * There are two roads to the same end and both land here or in
 * `reverseMovement`:
 *   · the expense list (this function, via PATCH /api/finance): it finds the
 *     expense's own movement, checks the wallet is this store's, reverses it
 *     and marks the expense;
 *   · the wallet screen (`reverseMovement`): a movement that belongs to an
 *     expense marks that expense in the same call.
 *
 * MUST RUN INSIDE A TRANSACTION. The mark and the reversing movement are two
 * writes and are one fact; the caller wraps them (a test sweeps for it).
 *
 * The money is the original's, never a number the caller chose
 * (`reverseMovement` copies it): there is no arithmetic here.
 */
export async function cancelExpense(
  tx: Tx,
  p: { companyId: string; storeId: string; expenseId: string; reason: string; userId: string }
): Promise<{ reversalId: string | null; moneyReturned: boolean }> {
  // This store's expense, or one from before expenses had a store.
  const expense = await tx.expense.findFirst({
    where: { id: p.expenseId, companyId: p.companyId, OR: [{ storeId: p.storeId }, { storeId: null }] },
    select: { id: true, voidedAt: true, movementId: true },
  });
  if (!expense) throw new ExpenseRefused('NOT_FOUND');
  if (expense.voidedAt) throw new ExpenseRefused('ALREADY_VOID');

  const mark = () =>
    markExpenseVoided(tx, {
      companyId: p.companyId,
      expenseId: expense.id,
      movementId: expense.movementId,
      reason: p.reason,
      userId: p.userId,
    });

  // No money left a wallet for it: only the profit has to change.
  if (!expense.movementId) {
    await mark();
    return { reversalId: null, moneyReturned: false };
  }

  const movement = await tx.walletMovement.findFirst({
    where: { id: expense.movementId, companyId: p.companyId },
    select: { id: true, walletId: true, referenceType: true, referenceId: true, reversedBy: { select: { id: true } } },
  });
  if (!movement || movement.referenceType !== 'EXPENSE' || movement.referenceId !== expense.id) {
    throw new ExpenseRefused('NOT_PAID_BY_THIS');
  }

  // The money left a wallet of THIS store (or one not placed yet). A wallet of another store is not ours to put
  // money back into, and cancelling from here would have done it.
  const wallet = await tx.wallet.findFirst({
    where: { id: movement.walletId, ...inStoreOrShared(p.companyId, p.storeId) },
    select: { id: true },
  });
  if (!wallet) throw new ExpenseRefused('OTHER_STORE');

  // Already given back by hand from the wallet screen before this existed: only the profit is left to fix.
  if (movement.reversedBy) {
    await mark();
    return { reversalId: null, moneyReturned: false };
  }

  const reversal = await reverseMovement(tx, {
    companyId: p.companyId,
    walletId: wallet.id,
    movementId: movement.id,
    reason: p.reason,
    createdById: p.userId,
    mayCancelExpense: true,
  });
  return { reversalId: reversal.id, moneyReturned: true };
}
