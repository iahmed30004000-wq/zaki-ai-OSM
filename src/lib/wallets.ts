import type { Prisma } from '@prisma/client';
import { db } from './db';
import { roundMinor } from './money';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * WALLETS — money that actually exists somewhere.
 *
 * Nothing is ever deleted or edited: a correction is a REVERSING entry that
 * points at the original and carries a reason. The balance is therefore the
 * opening balance plus every movement, and the history explains itself.
 *
 * No fund movement may be posted before the settlement it belongs to is
 * approved; the settlement service is the only caller that creates them for
 * a statement.
 */

export const MOVEMENT_CATEGORIES = [
  'COURIER_SETTLEMENT', 'COMMISSION', 'EXPENSE', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT', 'OTHER',
] as const;
export type MovementCategory = (typeof MOVEMENT_CATEGORIES)[number];

export interface WalletBalance {
  walletId: string;
  currencyCode: string;
  opening: number;
  in: number;
  out: number;
  balance: number;
  movements: number;
}

/** Book balance of one wallet: opening + every IN - every OUT. */
export async function walletBalance(tx: Tx, walletId: string, minorUnit = 3): Promise<WalletBalance> {
  const wallet = await tx.wallet.findUnique({
    where: { id: walletId },
    select: { id: true, currencyCode: true, openingBalance: true },
  });
  if (!wallet) throw new Error('Wallet not found');

  const [inSum, outSum, count] = await Promise.all([
    tx.walletMovement.aggregate({ where: { walletId, direction: 'IN' }, _sum: { amount: true } }),
    tx.walletMovement.aggregate({ where: { walletId, direction: 'OUT' }, _sum: { amount: true } }),
    tx.walletMovement.count({ where: { walletId } }),
  ]);

  const opening = Number(wallet.openingBalance);
  const inTotal = Number(inSum._sum.amount ?? 0);
  const outTotal = Number(outSum._sum.amount ?? 0);

  return {
    walletId,
    currencyCode: wallet.currencyCode,
    opening: roundMinor(opening, minorUnit),
    in: roundMinor(inTotal, minorUnit),
    out: roundMinor(outTotal, minorUnit),
    balance: roundMinor(opening + inTotal - outTotal, minorUnit),
    movements: count,
  };
}

export interface MovementInput {
  companyId: string;
  walletId: string;
  direction: 'IN' | 'OUT';
  amount: number;
  party: string;
  category: MovementCategory;
  note: string;
  referenceType?: string;
  referenceId?: string;
  createdById: string;
}

/** Record one movement. Every field the contract lists is required. */
export async function recordMovement(tx: Tx, input: MovementInput) {
  /*
   * A MOVEMENT OF A CATEGORY WITH A LEDGER OF ITS OWN MUST NAME THAT LEDGER'S ROW.
   *
   * «مصروف» and «عمولة» are written by the expense door and the payout and payroll doors, each of which carries
   * the id of the row it belongs to. One with no reference is a person typing it in by hand — outside the expense
   * list (so profit never subtracts it) or beside the commission entries (so they can be paid again). The wallet
   * route refuses it first, with a sentence; this is the same rule where every writer has to pass.
   */
  if ((input.category === 'EXPENSE' || input.category === 'COMMISSION') && !input.referenceType) {
    throw new Error('A movement of this category must reference the row it belongs to');
  }
  const wallet = await tx.wallet.findFirst({
    where: { id: input.walletId, companyId: input.companyId, isActive: true },
    select: { id: true, currencyCode: true },
  });
  if (!wallet) throw new Error('Wallet not found');
  if (input.amount <= 0) throw new Error('Amount must be greater than zero');

  return tx.walletMovement.create({
    data: {
      companyId: input.companyId,
      walletId: wallet.id,
      direction: input.direction,
      amount: input.amount,
      currencyCode: wallet.currencyCode,
      party: input.party,
      category: input.category,
      note: input.note,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      createdById: input.createdById,
    },
  });
}

/**
 * Reverse a movement. The original row is never touched: the reversal is a
 * new movement in the opposite direction, linked to it, with a reason.
 *
 * `walletId` IS REQUIRED, AND IT IS NOT DECORATION. The route that calls this
 * checks that the wallet in the URL belongs to the current store, and then
 * passed a `movementId` from the request body straight through — so a movement
 * in a DIFFERENT store's wallet could be reversed by naming one of your own in
 * the path. The store boundary is checked on the wallet; the movement has to be
 * checked against the same wallet or the check is on nothing.
 */
export async function reverseMovement(
  tx: Tx,
  params: {
    companyId: string;
    walletId: string;
    movementId: string;
    reason: string;
    createdById: string;
    /**
     * May this caller cancel an EXPENSE through its movement? Reversing the money of an expense also takes the
     * expense out of the profit, which is a finance edit, so the door that calls this says whether the person
     * holds it. Absent = no: a caller that never thought about expenses cannot cancel one by accident.
     */
    mayCancelExpense?: boolean;
  }
) {
  const original = await tx.walletMovement.findFirst({
    where: { id: params.movementId, companyId: params.companyId, walletId: params.walletId },
  });
  if (!original) throw new Error('Movement not found');
  if (original.reversalOfId) throw new Error('A reversing entry cannot be reversed');

  const already = await tx.walletMovement.findUnique({ where: { reversalOfId: original.id } });
  if (already) throw new Error('This movement was already reversed');

  /*
   * THE MONEY OF AN EXPENSE COMING BACK CANCELS THE EXPENSE.
   *
   * It did not: the reversal returned the money to the wallet and the expense kept subtracting from profit, so
   * the books said the money was spent and the drawer said it was there. The expense is marked cancelled FIRST,
   * in the same transaction: if the mark is refused nothing has moved yet, and the caller's transaction (see
   * the route) keeps the two together if the reversal fails after it.
   */
  if (original.referenceType === 'EXPENSE') {
    if (!params.mayCancelExpense) throw new ExpenseRefused('NOT_ALLOWED');
    if (!original.referenceId) throw new ExpenseRefused('NOT_PAID_BY_THIS');
    await markExpenseVoided(tx, {
      companyId: original.companyId,
      expenseId: original.referenceId,
      movementId: original.id,
      reason: params.reason,
      userId: params.createdById,
    });
  }

  return tx.walletMovement.create({
    data: {
      companyId: original.companyId,
      walletId: original.walletId,
      direction: original.direction === 'IN' ? 'OUT' : 'IN',
      amount: original.amount,
      currencyCode: original.currencyCode,
      party: original.party,
      category: original.category,
      note: `عكس حركة: ${original.note}`,
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      reversalOfId: original.id,
      reversalReason: params.reason,
      createdById: params.createdById,
    },
  });
}

/** Why an expense could not be cancelled — each with a sentence a person can act on. */
export type ExpenseRefusal = 'NOT_FOUND' | 'ALREADY_VOID' | 'NOT_PAID_BY_THIS' | 'OTHER_STORE' | 'NOT_ALLOWED';

export const EXPENSE_REFUSAL_AR: Record<ExpenseRefusal, string> = {
  NOT_FOUND: 'المصروف غير موجود',
  ALREADY_VOID: 'هذا المصروف ملغى من قبل',
  NOT_PAID_BY_THIS: 'هذه الحركة ليست حركة هذا المصروف — لم يُلغَ شيء',
  OTHER_STORE: 'هذا المصروف خرج من محفظة متجر آخر — يُلغى من ذلك المتجر',
  NOT_ALLOWED: 'عكس حركة مصروف يُلغي المصروف من الربح — يحتاج «تعديل المالية»',
};

export class ExpenseRefused extends Error {
  constructor(public readonly code: ExpenseRefusal) {
    super(EXPENSE_REFUSAL_AR[code]);
    this.name = 'ExpenseRefused';
  }
}

/**
 * Mark one expense cancelled — only the expense that THIS movement paid, and only once.
 *
 * The condition is in the write, not before it: two presses at once cannot both win, and a movement id that
 * belongs to some other expense matches nothing. When nothing matched, the row is read again to say which of the
 * two it was, so the person is told the truth rather than a guess.
 */
export async function markExpenseVoided(
  tx: Tx,
  p: { companyId: string; expenseId: string; movementId: string | null; reason: string; userId: string }
) {
  const done = await tx.expense.updateMany({
    where: { id: p.expenseId, companyId: p.companyId, movementId: p.movementId, voidedAt: null },
    data: { voidedAt: new Date(), voidReason: p.reason, voidedById: p.userId },
  });
  if (done.count === 1) return;
  const row = await tx.expense.findFirst({ where: { id: p.expenseId, companyId: p.companyId }, select: { voidedAt: true } });
  throw new ExpenseRefused(row?.voidedAt ? 'ALREADY_VOID' : 'NOT_PAID_BY_THIS');
}

/**
 * Yesterday's closing must be explained before today's can be recorded:
 * an unexplained non-zero difference blocks the next day.
 */
export async function blockingClosing(tx: Tx, walletId: string, date: Date) {
  return tx.dailyClosing.findFirst({
    where: {
      walletId,
      date: { lt: date },
      status: 'OPEN',
      NOT: { difference: 0 },
      OR: [{ explanation: null }, { explanation: '' }],
    },
    orderBy: { date: 'desc' },
    select: { id: true, date: true, difference: true },
  });
}
