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

/**
 * `PARTNER_DRAW` (13/11) — a partner's withdrawal: «السحوبات لازم تنضاف بند». It is NOT an expense: it creates no `Expense`
 * row and never enters the profit; it is measured against the partner's share of the net profit (`lib/partner-statement.ts`).
 * Always OUT, always written by `POST /api/finance/partners/draws` (key `finance.partners`) through `recordMovement` below, and
 * refused at the hand door with every other category that has a ledger of its own.
 */
export const MOVEMENT_CATEGORIES = [
  'COURIER_SETTLEMENT', 'COMMISSION', 'EXPENSE', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT', 'OTHER', 'PARTNER_DRAW',
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
  /** The statement receipt this IN is the money of: one movement per receipt, held by a unique index. */
  statementReceiptId?: string;
  /** A partner draw's partner, and what it is worth in the STORE's currency. Both are required on a `PARTNER_DRAW` and refused on every other kind. */
  partnerId?: string;
  valueInStoreCurrency?: number;
  createdById: string;
}

/** Record one movement. Every field the contract lists is required. */
export async function recordMovement(tx: Tx, input: MovementInput) {
  /*
   * A PARTNER'S DRAW NAMES ITS PARTNER AND ITS VALUE, AND GOES OUT.
   *
   * It is measured against the partner's share of the net profit, in the store's currency, so a draw with no partner belongs to
   * nobody's ledger and a draw with no value cannot be added to one — and a draw coming IN is a reversal, which has its own door.
   * The partners' door states all of it; this is the same rule where every writer has to pass. And the two fields mean nothing on
   * any other kind of movement, so they are refused there rather than stored beside a category that never reads them.
   */
  if (input.category === 'PARTNER_DRAW') {
    if (input.direction !== 'OUT') throw new Error('A partner draw only goes out of a wallet');
    if (!input.partnerId || input.referenceType !== 'PARTNER_DRAW' || input.referenceId !== input.partnerId) {
      throw new Error('A partner draw must name its partner');
    }
    if (!(typeof input.valueInStoreCurrency === 'number' && input.valueInStoreCurrency > 0)) {
      throw new Error('A partner draw must carry its value in the store currency');
    }
  } else if (input.partnerId !== undefined || input.valueInStoreCurrency !== undefined) {
    throw new Error('Only a partner draw carries a partner or a store value');
  }
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
      ...(input.statementReceiptId ? { statementReceiptId: input.statementReceiptId } : {}),
      ...(input.partnerId ? { partnerId: input.partnerId, valueInStoreCurrency: input.valueInStoreCurrency } : {}),
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
    /**
     * May this caller take a PARTNER'S DRAW back? Reversing one changes his balance in the partners' statement, which is the
     * partners' key (`finance.partners`), not the cash box's — so the door that calls this says whether the person holds it.
     * Absent = no: a caller that never thought about partners cannot reverse a draw by accident.
     */
    mayReversePartnerDraw?: boolean;
  }
) {
  const original = await tx.walletMovement.findFirst({
    where: { id: params.movementId, companyId: params.companyId, walletId: params.walletId },
  });
  if (!original) throw new Error('Movement not found');
  // FIRST, before anything about its state: whoever lacks the key is told no, and learns nothing about the draw.
  if (original.category === 'PARTNER_DRAW' && !params.mayReversePartnerDraw) throw new PartnerDrawRefused('NOT_ALLOWED');
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

  const reversal = await tx.walletMovement.create({
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
      // A draw's reversal stays the partner's: his, and worth what the original was (the statement counts the pair as nothing).
      ...(original.partnerId ? { partnerId: original.partnerId, valueInStoreCurrency: original.valueInStoreCurrency } : {}),
      createdById: params.createdById,
    },
  });

  /*
   * A LEG OF A TRANSFER IS NEVER REVERSED ALONE (14/11 — «القيد العكسي ما بيسمع بالتحويلات هاد خطأ عظيم»).
   *
   * A transfer is two movements written in ONE transaction precisely so that a wallet is never left with half of it. The
   * reversing entry of one leg used to leave the other standing: «عكست من binance» and the 663,958 lira still sat outside
   * the Sham Cash wallet, the transfer list saying nothing. So the reversal of a leg carries every leg of the same transfer
   * that is still standing, in THIS transaction, with the same reason — each through this very function, so each is the
   * opposite row of its own original, for its own amount, in its own wallet. A leg that was reversed before (the person
   * did the first half by hand) is skipped, which is what lets the other half be finished.
   */
  if (original.referenceType === 'TRANSFER' && original.referenceId) {
    const others = await tx.walletMovement.findMany({
      where: {
        companyId: original.companyId,
        referenceType: 'TRANSFER',
        referenceId: original.referenceId,
        reversalOfId: null,
        id: { not: original.id },
      },
      select: { id: true, walletId: true, reversedBy: { select: { id: true } } },
      orderBy: { createdAt: 'asc' },
    });
    for (const other of others) {
      if (other.reversedBy) continue;
      await reverseMovement(tx, { ...params, walletId: other.walletId, movementId: other.id });
    }
  }
  return reversal;
}

/** Why a transfer could not be reversed — each with a sentence a person can act on. */
export type TransferReversalRefusal = 'NOT_FOUND' | 'NO_LEGS' | 'ALREADY_REVERSED';

export const TRANSFER_REVERSAL_REFUSAL_AR: Record<TransferReversalRefusal, string> = {
  NOT_FOUND: 'التحويل غير موجود',
  NO_LEGS: 'لا حركات مسجّلة لهذا التحويل — لم يُعكس شيء',
  ALREADY_REVERSED: 'هذا التحويل معكوس بالكامل من قبل',
};

export class TransferReversalRefused extends Error {
  constructor(public readonly code: TransferReversalRefusal) {
    super(TRANSFER_REVERSAL_REFUSAL_AR[code]);
    this.name = 'TransferReversalRefused';
  }
}

/**
 * Reverse a TRANSFER — the transfers screen's door. Both legs, one transaction (the caller's), one reason.
 *
 * It is `reverseMovement` asked of the first leg still standing, because that function already carries the rest of the
 * transfer with it; this one only finds the transfer (in THIS company), refuses what has nothing to reverse, and says
 * what was written. A transfer one leg of which was reversed by hand before (the half-made reversal this door exists to
 * finish) gets only the leg that is left; one that is reversed whole is refused, and nothing is written.
 */
export async function reverseTransfer(
  tx: Tx,
  params: { companyId: string; transferId: string; reason: string; createdById: string }
) {
  const transfer = await tx.walletTransfer.findFirst({
    where: { id: params.transferId, companyId: params.companyId },
    select: { id: true },
  });
  if (!transfer) throw new TransferReversalRefused('NOT_FOUND');

  // The ORIGINAL legs only: a reversing entry carries the same reference and is not a leg.
  const legs = await tx.walletMovement.findMany({
    where: { companyId: params.companyId, referenceType: 'TRANSFER', referenceId: transfer.id, reversalOfId: null },
    select: { id: true, walletId: true, reversedBy: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (legs.length === 0) throw new TransferReversalRefused('NO_LEGS');

  const standing = legs.filter((leg) => !leg.reversedBy);
  if (standing.length === 0) throw new TransferReversalRefused('ALREADY_REVERSED');

  await reverseMovement(tx, {
    companyId: params.companyId,
    walletId: standing[0].walletId,
    movementId: standing[0].id,
    reason: params.reason,
    createdById: params.createdById,
  });

  const standingIds = new Set(standing.map((leg) => leg.id));
  const written = await tx.walletMovement.findMany({
    where: { companyId: params.companyId, reversalOfId: { in: [...standingIds] } },
    orderBy: { createdAt: 'asc' },
  });
  return { reversals: written, legs: legs.length, alreadyReversed: legs.length - standing.length };
}

/**
 * Reverse, one by one and in the order given, hand-entered rows the person said are the money of a statement
 * the caller is approving. Always on the CALLER'S transaction client: a failure on any row rolls the whole
 * approval back. Hand rows carry no reference, so none of them can be an expense (`reverseMovement` voids an
 * expense only by its `EXPENSE` reference).
 */
export async function reverseHandRows(
  tx: Prisma.TransactionClient,
  p: { companyId: string; rows: { id: string; walletId: string }[]; reason: string; createdById: string }
) {
  for (const row of p.rows) {
    await reverseMovement(tx, {
      companyId: p.companyId,
      walletId: row.walletId,
      movementId: row.id,
      reason: p.reason,
      createdById: p.createdById,
    });
  }
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

/** Why a partner's draw could not be taken back — with the sentence a person can act on. */
export type PartnerDrawRefusal = 'NOT_ALLOWED';

export const PARTNER_DRAW_REFUSAL_AR: Record<PartnerDrawRefusal, string> = {
  NOT_ALLOWED: 'عكس سحب شريك بيغيّر رصيده عند الشركاء — بيحتاج «الشركاء والسحوبات»',
};

export class PartnerDrawRefused extends Error {
  constructor(public readonly code: PartnerDrawRefusal) {
    super(PARTNER_DRAW_REFUSAL_AR[code]);
    this.name = 'PartnerDrawRefused';
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
