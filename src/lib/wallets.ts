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
  params: { companyId: string; walletId: string; movementId: string; reason: string; createdById: string }
) {
  const original = await tx.walletMovement.findFirst({
    where: { id: params.movementId, companyId: params.companyId, walletId: params.walletId },
  });
  if (!original) throw new Error('Movement not found');
  if (original.reversalOfId) throw new Error('A reversing entry cannot be reversed');

  const already = await tx.walletMovement.findUnique({ where: { reversalOfId: original.id } });
  if (already) throw new Error('This movement was already reversed');

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
