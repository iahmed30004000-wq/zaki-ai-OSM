import type { Prisma } from '@prisma/client';
import { db } from './db';
import { roundMinor } from './money';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * MONEY LEAVING A WALLET TO PAY A PERSON.
 *
 * Commission and salary are different debts and settle on different clocks,
 * but the act of handing the money over is one act, and it was about to be
 * written twice. Written twice it drifts: one of them rounds by the wallet's
 * minor unit and the other by a global rule, one records a movement and the
 * other forgets, and a year later two screens disagree about how much left
 * the drawer.
 *
 * Two currencies meet here and they are not the same question:
 *
 *   the person's — what they are owed, and what they are told they are
 *                  owed. An Egyptian employee counts in pounds.
 *   the wallet's — what actually left the business. There may be no pound
 *                  wallet at all; the money leaves the dollar one.
 *
 * The rate is written by the owner AT PAYMENT, because which wallet will
 * pay is not known before then — and it is stored and never recalculated.
 * A month already paid reads the same next year, whatever the market did.
 */

export type WalletRefusal = 'WALLET_NOT_FOUND' | 'BAD_RATE' | 'NOTHING_OWED';

export interface SpendInput {
  companyId: string;
  walletId: string;
  /** What the person is owed, in THEIR currency. */
  amount: number;
  currencyCode: string;
  /** Wallet currency per person currency, as the owner wrote it. */
  exchangeRate: number;
  /** Who is being paid, for the movement's party line. */
  personName: string;
  category: 'COMMISSION' | 'EXPENSE';
  referenceType: string;
  referenceId: string;
  note: string;
  createdById: string;
}

export interface WalletCheck {
  walletId: string;
  currencyCode: string;
  minorUnit: number;
  /** The amount in the wallet's own currency, rounded by its own minor unit. */
  paidAmount: number;
}

/**
 * Work out what would leave the wallet, and refuse early if it cannot.
 *
 * Separate from the write so a screen can show the figure before anybody
 * commits to it: somebody entering an exchange rate is entitled to see what
 * it means before they press.
 */
export async function checkWallet(
  tx: Tx,
  input: {
    companyId: string;
    walletId: string;
    amount: number;
    exchangeRate: number;
    /**
     * The store the payment is made from. A wallet of ANOTHER store of the company is not this store's money:
     * the wallet is found among this store's and the unplaced ones, as the expense door and the wallets screen do.
     * Omitted only by a caller that has no store to stand in (the commission payout is a company-level door).
     */
    storeId?: string | null;
  }
): Promise<WalletCheck | WalletRefusal> {
  if (!(input.exchangeRate > 0)) return 'BAD_RATE';
  if (!(input.amount > 0)) return 'NOTHING_OWED';

  const wallet = await tx.wallet.findFirst({
    where: {
      id: input.walletId,
      companyId: input.companyId,
      isActive: true,
      ...(input.storeId ? { OR: [{ storeId: input.storeId }, { storeId: null }] } : {}),
    },
    select: { id: true, currencyCode: true, country: { select: { minorUnit: true } } },
  });
  if (!wallet) return 'WALLET_NOT_FOUND';

  const minorUnit = wallet.country.minorUnit;
  return {
    walletId: wallet.id,
    currencyCode: wallet.currencyCode,
    minorUnit,
    // The wallet's own rounding. Rounding both currencies by one minor unit
    // would give a Jordanian wallet two decimals or an Egyptian one three.
    paidAmount: roundMinor(input.amount * input.exchangeRate, minorUnit),
  };
}

/**
 * Record the money leaving — in the one place every other movement is kept.
 *
 * Always inside the caller's transaction, so the thing being settled and
 * the money that settled it can never disagree about whether it happened.
 */
export async function recordSpend(tx: Tx, input: SpendInput, wallet: WalletCheck) {
  return tx.walletMovement.create({
    data: {
      companyId: input.companyId,
      walletId: wallet.walletId,
      direction: 'OUT',
      amount: wallet.paidAmount,
      currencyCode: wallet.currencyCode,
      party: input.personName,
      category: input.category,
      note:
        input.currencyCode === wallet.currencyCode
          ? input.note
          : `${input.note} — ${input.amount} ${input.currencyCode} بسعر ${input.exchangeRate}`,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      createdById: input.createdById,
    },
  });
}
