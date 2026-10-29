import type { Prisma } from '@prisma/client';

/**
 * A PARCEL THAT NEVER CAME BACK — ONE SHAPE, READ EVERYWHERE.
 *
 * The counting desk closes an order with a zero count: it writes a receipt
 * that says «received 0, damaged 0, missing = what was expected». A write-off
 * (the parcel was lost and is not coming back) is the same fact, so it writes
 * the same receipt. Nothing stores a «written off» flag: the word is READ from
 * the receipt's shape, so it cannot drift from the numbers.
 *
 * Every reader that asks «did something come back?» asks it here — the
 * win-back list (it must not ring a customer for goods nobody holds), the
 * orders' outcome word, the write-off door and the desk that can complete the
 * receipt if the parcel turns up after all.
 */

/** The note the write-off door writes on the receipt, and the backfill after it. */
export const LOSS_RECEIPT_NOTE = 'أُغلق كخسارة — لم يصل';

/**
 * Money already recorded against the order. A write-off never rewrites these:
 * the door only sets «no settlement applies» on an order that has none.
 */
export const SETTLEMENT_WITH_MONEY = ['SETTLED', 'COLLECTED', 'PARTIALLY_SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;

export interface ReceiptCounts {
  receivedQty: number;
  damagedQty: number;
  missingQty: number;
}

/** True when the receipt says no unit came back — a zero count, or a write-off. */
export function nothingCameBack(r: ReceiptCounts): boolean {
  return r.receivedQty === 0 && r.damagedQty === 0 && r.missingQty > 0;
}

/**
 * The same sentence for the database: a receipt where at least one unit came
 * back, sound or broken. `missingQty: 0` keeps a receipt that expected nothing
 * (and so can never be a loss) on the side of «came back».
 *
 * Written as the exact complement of `nothingCameBack`; the test walks a grid
 * of counts through both and holds them to each other.
 */
export const receiptCameBackWhere = (): Prisma.ReturnReceiptWhereInput => ({
  OR: [{ receivedQty: { gt: 0 } }, { damagedQty: { gt: 0 } }, { missingQty: 0 }],
});

/** The receipts that say nothing came back — for the outcome counts. */
export const receiptNothingCameBackWhere = (): Prisma.ReturnReceiptWhereInput => ({
  receivedQty: 0,
  damagedQty: 0,
  missingQty: { gt: 0 },
});

/** The receipt a write-off writes: nothing received, nothing damaged, all of it missing. */
export function lossReceiptCounts(expectedQty: number): ReceiptCounts & { expectedQty: number } {
  return { expectedQty, receivedQty: 0, damagedQty: 0, missingQty: expectedQty };
}
