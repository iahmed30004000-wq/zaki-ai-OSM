import { describe, expect, it } from 'vitest';
import {
  LOSS_RECEIPT_NOTE,
  SETTLEMENT_WITH_MONEY,
  lossReceiptCounts,
  nothingCameBack,
  receiptCameBackWhere,
  receiptNothingCameBackWhere,
} from './written-off';

/**
 * ONE SHAPE FOR «NOTHING CAME BACK», IN JAVASCRIPT AND IN THE DATABASE'S WORDS.
 *
 * The orders' outcome and the win-back verdict ask it of a row; the win-back list and the dashboard's counts ask
 * it of the database. If the two ever disagreed, the list would hold an order the verdict refuses, or the card
 * would count a loss the row does not call one. So the database's version is held to the JavaScript one over
 * every receipt the grid can make.
 */

type Any = Record<string, any>;
/** The few operators these two `where`s are written in. */
function holds(where: Any, row: Any): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Any[]).some((w) => holds(w, row));
    const value = row[key];
    if (typeof cond !== 'object') return value === cond;
    return Object.entries(cond as Any).every(([op, arg]) => {
      if (op === 'gt') return value > arg;
      throw new Error(`unknown operator ${op}`);
    });
  });
}

const GRID = [0, 1, 2, 5];
const receipts = GRID.flatMap((receivedQty) => GRID.flatMap((damagedQty) => GRID.map((missingQty) => ({ receivedQty, damagedQty, missingQty }))));

describe('nothingCameBack', () => {
  it('is true only for received 0, damaged 0 and something missing', () => {
    expect(nothingCameBack({ receivedQty: 0, damagedQty: 0, missingQty: 4 })).toBe(true);
    expect(nothingCameBack({ receivedQty: 0, damagedQty: 0, missingQty: 1 })).toBe(true);
  });

  it('NEGATIVE: a unit received, a unit broken, or nothing expected is not a loss', () => {
    expect(nothingCameBack({ receivedQty: 1, damagedQty: 0, missingQty: 3 })).toBe(false);
    expect(nothingCameBack({ receivedQty: 0, damagedQty: 1, missingQty: 3 })).toBe(false);
    expect(nothingCameBack({ receivedQty: 0, damagedQty: 0, missingQty: 0 })).toBe(false);
  });

  it('is the exact complement of the database\'s «something came back», over the whole grid', () => {
    let checked = 0;
    for (const r of receipts) {
      expect(holds(receiptCameBackWhere() as Any, r), JSON.stringify(r)).toBe(!nothingCameBack(r));
      expect(holds(receiptNothingCameBackWhere() as Any, r), JSON.stringify(r)).toBe(nothingCameBack(r));
      checked++;
    }
    expect(checked).toBe(GRID.length ** 3);
  });
});

describe('what the write-off writes', () => {
  it('a receipt of everything expected and none of it back', () => {
    expect(lossReceiptCounts(4)).toEqual({ expectedQty: 4, receivedQty: 0, damagedQty: 0, missingQty: 4 });
    expect(nothingCameBack(lossReceiptCounts(4))).toBe(true);
  });

  it('says it in the owner\'s words', () => {
    expect(LOSS_RECEIPT_NOTE).toBe('أُغلق كخسارة — لم يصل');
  });

  it('never rewrites a settlement that holds money', () => {
    expect([...SETTLEMENT_WITH_MONEY].sort()).toEqual(['COLLECTED', 'PARTIALLY_REFUNDED', 'PARTIALLY_SETTLED', 'REFUNDED', 'SETTLED']);
  });
});
