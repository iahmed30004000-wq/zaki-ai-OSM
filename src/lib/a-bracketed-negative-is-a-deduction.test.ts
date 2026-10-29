import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «(50)» IS MINUS FIFTY, AND AN UNREADABLE CELL REFUSES THE FILE BY NAME.
 *
 * `97530a6` fixed the order importer, where a strip `/[^\d.-]/` turned a
 * price typed on an Arabic keypad into a price of ZERO. Its sweep then found
 * the same strip in the courier-statement reader — the one path in this
 * repository that has run on real money: ten `STATEMENT_IMPORTED` audit rows
 * exist. Measured there, verbatim:
 *
 *     '(50)'     -> 50       A DEDUCTION BECAME A CREDIT OF THE SAME SIZE
 *     '3,5'      -> 35       ten times
 *     '3,500'    -> 3500     right, by accident of the same strip
 *     '1.234,56' -> 1.23456  a European-formatted figure, destroyed
 *     '1e400'    -> 1400        '0x10' -> 10        '12abc' -> 12
 *     '12 345'   -> 12345       '50 ر.س' -> 50
 *     '٣٥٠٠'     -> null     refused, not zeroed — and then the row was
 *                            dropped from the statement in SILENCE
 *
 * `(50)` is the sharp one. It is not a notation preference: brackets are how
 * Excel's own accounting and currency formats, and every accounting export,
 * write a negative. Read as +50 a fifty-unit deduction became a fifty-unit
 * credit — a hundred-unit swing on the one figure `runMatching` reconciles
 * an order against, and on `CourierStatement.totalAmount`, which is summed
 * from these lines and is what `receiptGap` measures the money that actually
 * arrived against.
 *
 * THE FIGURE IS ASSERTED BEFORE ANY LABEL, everywhere below. A test that
 * checks `result: 'MISMATCHED'` passes just as happily when the matcher is
 * reconciling against +50 as against −50, because ±50 against an expectation
 * of −50 is mismatched either way. So every assertion here names the number
 * first.
 */

const { db } = vi.hoisted(() => ({
  db: {
    statementLine: { findMany: vi.fn() },
    courierStatement: { findFirst: vi.fn(), findUnique: vi.fn() },
    // findMany: the answers a re-run keeps, and the other statements that name an order.
    settlementMatch: { deleteMany: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    order: { findFirst: vi.fn(), findMany: vi.fn() },
    statementReceipt: { findMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { readStatementFigure, readTypedFigure } from './numeric-input';
import { parseStatement, parseStatementRows, runMatching } from './settlement';

beforeEach(() => {
  vi.clearAllMocks();
  db.settlementMatch.create.mockResolvedValue({});
  db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.order.findMany.mockResolvedValue([]);
  db.courierStatement.findFirst.mockResolvedValue({
    id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null,
  });
});

/** An order row as `SETTLEMENT_ORDER_SELECT` returns it: one line nobody counted. */
const orderRow = (over: Record<string, unknown>) => ({
  priceIncludesDelivery: false,
  collectedAmount: null,
  deliveryFee: 0,
  returnReceipt: null,
  addOns: [],
  items: [{
    quantity: 1, freeQuantity: 0, unitPrice: Number(over.totalAmount ?? 0),
    discountShare: 0, lineTotal: Number(over.totalAmount ?? 0), deliveredQty: null,
  }],
  ...over,
});

/* ───────────────────────── the reader, on its own ───────────────────────── */

describe('readStatementFigure — one reader, and the one notation it adds', () => {
  it('reads a bracketed figure as the NEGATIVE it is', () => {
    expect(readStatementFigure('(50)')).toBe(-50);
    expect(readStatementFigure('(2.5)')).toBe(-2.5);
    expect(readStatementFigure(' ( 1250.500 ) ')).toBe(-1250.5);
    // And on an Arabic keypad, which this market types on.
    expect(readStatementFigure('(٥٠)')).toBe(-50);
    expect(readStatementFigure('٣٥٠٠')).toBe(3500);
  });

  it('and the number is what it was before the brackets — not a rounded cousin', () => {
    // The sign is the only thing that changes. A fils is a fils.
    expect(readStatementFigure('(9.995)')).toBe(-9.995);
    expect(readStatementFigure('9.995')).toBe(9.995);
  });

  it('and `-0` never comes out of it, because a column holding -0 is a lie', () => {
    // `Object.is` is the assertion, not `toBe(0)`: `-0 === 0` is true, so an
    // equality check here passes whether the sign is there or not.
    expect(Object.is(readStatementFigure('(0)'), 0)).toBe(true);
    expect(Object.is(readStatementFigure('(0.00)'), 0)).toBe(true);
  });

  it('and the strip that stood here would have called all of those POSITIVE', () => {
    // The defect, as a measurement rather than a memory. This is the function
    // that was in `settlement.ts`, copied.
    const asItWas = (value: unknown) => {
      const cleaned = String(value ?? '').replace(/[^\d.-]/g, '');
      if (!cleaned) return null;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    };
    expect(asItWas('(50)'), 'الحشوُ القديمُ كان يُسقِطُ الإشارة').toBe(50);
    expect(readStatementFigure('(50)')).toBe(-50);
    // A hundred apart on one cell, and the sign was the whole difference.
    expect(asItWas('(50)')! - readStatementFigure('(50)')!).toBe(100);
  });

  it('refuses a sign written twice, and a bracket that has no partner', () => {
    for (const cell of ['(-50)', '(+50)', '(50', '50)', '()', '( )', '(-)', '((50))']) {
      expect(readStatementFigure(cell), cell).toBeNull();
    }
  });

  it('refuses the comma — inside the brackets as well as outside them', () => {
    // `3,500` is 3500 to half the world and 3.5 to the other, and a courier's
    // export being machine-generated does not put the locale in the cell.
    for (const cell of ['3,5', '3,500', '1.234,56', '1 234,56', '(1,250.50)', '(3,5)']) {
      expect(readStatementFigure(cell), cell).toBeNull();
    }
  });

  it('refuses every other notation the strip used to rewrite', () => {
    for (const cell of ['1e400', '0x10', '12abc', '12 345', '50 ر.س', '50-', '1.2.3', '--5', '']) {
      expect(readStatementFigure(cell), cell).toBeNull();
    }
  });

  it('and is `readTypedFigure` plus the brackets, not a second grammar', () => {
    // Everything that is not bracketed is read by the SAME function the order
    // importer reads a cell with. A second grammar is a second set of bugs.
    for (const cell of ['12', '0', '-7.25', '٣٥٠٠', '3,5', '0x10', '1e400', 'abc', '']) {
      expect(readStatementFigure(cell), cell).toBe(readTypedFigure(cell));
    }
    expect(readTypedFigure('(50)'), 'القوسُ إضافةُ هذا القارئِ وحدَه').toBeNull();
  });
});

/* ──────────────────── the statement the courier handed us ───────────────── */

/**
 * The shape of the real file, as `settlement.test.ts` records it: Arabic
 * headers, three money columns, the merchant's number at the head of the
 * notes because this courier has no reference column.
 */
const HEADER = [
  'باركود الشحنة', 'الملاحظات', 'التحصيل', 'السعر', 'الصافي', 'الحالة',
];

describe('a deduction on a courier statement stays a deduction', () => {
  it('a bracketed net is stored NEGATIVE, and the total carries the sign', () => {
    const { rows, total, error } = parseStatementRows(HEADER, [
      ['BC1', '15133', '12.0', '3.0', '9.0', 'تم توصيلها'],
      // The courier is taking fifty off: a return leg they carried and
      // charged for, with nothing collected at the door.
      ['BC2', '15134', '0.0', '50.0', '(50)', 'تم إرجاعها'],
    ]);
    expect(error).toBeUndefined();
    expect(rows.map((r) => r.amount), 'الصافي السالب').toEqual([9, -50]);
    // ‑41, not 59. The old reader made this 59 and the statement claimed a
    // hundred more than the courier had said it owed.
    expect(total, 'مجموع الكشف يحمل الإشارة').toBe(-41);
  });

  it('and a bracketed FEE is a fee reversal, stored negative in its own column', () => {
    const { rows, error } = parseStatementRows(HEADER, [
      ['BC1', '15133', '12.0', '(3.0)', '15.0', 'تم توصيلها'],
    ]);
    expect(error).toBeUndefined();
    expect(rows[0].fee, 'أجرةٌ مردودة').toBe(-3);
    // And the net stands as stated; the fee is not re-derived from it.
    expect(rows[0].amount).toBe(15);
  });

  it('and a bracketed COD with a bracketed fee derives the net with both signs', () => {
    // No net column at all, so the net is `collected − fee`: (−12) − (−3).
    const { rows, error } = parseStatementRows(
      ['باركود الشحنة', 'التحصيل', 'السعر'],
      [['BC1', '(12)', '(3)']]
    );
    expect(error).toBeUndefined();
    expect(rows[0], 'الصافي المُستخرَج').toMatchObject({ collected: -12, fee: -3, amount: -9 });
  });

  it('and the positive statement every existing row in this database is made of still reads the same', () => {
    // The five statements that have actually been imported are all plain
    // Latin dot-decimals. None of them may move by a fils.
    const { rows, total } = parseStatementRows(HEADER, [
      ['GPMAINMUR6E5FO', 'ORD-2026-0039', '14', '2.5', '11.5', 'DELIVERED'],
      ['GPBUNDMUR6E9KJ', 'ORD-2026-0044', '38', '2.5', '35.5', 'DELIVERED'],
    ]);
    expect(rows.map((r) => [r.collected, r.fee, r.amount])).toEqual([[14, 2.5, 11.5], [38, 2.5, 35.5]]);
    expect(total).toBe(47);
  });
});

/* ───────────────────── what the matcher reconciles against ──────────────── */

describe('the figure the matcher reconciles against', () => {
  const scope = { companyId: 'c1', storeId: 's1', statementId: 'st1', minorUnit: 3 };

  it('is the NEGATIVE the courier stated — asserted before any result label', async () => {
    // A returned parcel: `expectedAmountFor` answers 0 for RETURNED, and the
    // courier is deducting the 50 they charged to carry it back.
    db.statementLine.findMany.mockResolvedValue([
      { id: 'l1', merchantRef: 'ORD-1', barcode: 'BC1', amount: -50, fee: 50 },
    ]);
    db.order.findFirst.mockResolvedValue(orderRow({ id: 'o1', shippingStatus: 'RETURNED', totalAmount: 0 }));

    await runMatching(db as never, scope);
    const data = db.settlementMatch.create.mock.calls[0][0].data;
    // THE FIGURES FIRST. Fifty we owe them, not fifty they owe us.
    expect(data.statementAmount, 'المبلغ المعلن').toBe(-50);
    expect(data.expectedAmount, 'المتوقَّع من طلبٍ مُرجَع').toBe(0);
    expect(data.difference, 'الفرق = المعلن − المتوقَّع').toBe(-50);
    // And only then the word.
    expect(data.result).toBe('MISMATCHED');
  });

  it('and a deduction we agree with reconciles to zero, which +50 never could', async () => {
    // We owe the courier 50: the goods the customer kept are worth nothing
    // and the returns desk recorded a 50 return fee. The courier says −50.
    db.statementLine.findMany.mockResolvedValue([
      { id: 'l1', merchantRef: 'ORD-1', barcode: 'BC1', amount: -50, fee: null },
    ]);
    db.order.findFirst.mockResolvedValue(
      orderRow({
        id: 'o1',
        shippingStatus: 'PARTIALLY_DELIVERED',
        totalAmount: 30,
        deliveryFee: 0,
        returnReceipt: { courierFeeAmount: 50 },
        items: [{ quantity: 3, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 30, deliveredQty: 0 }],
      })
    );

    await runMatching(db as never, scope);
    const data = db.settlementMatch.create.mock.calls[0][0].data;
    expect(data.expectedAmount, 'نتوقَّعُ أن ندفعَ خمسين').toBe(-50);
    expect(data.statementAmount).toBe(-50);
    expect(data.difference, 'لا فرق — الطرفان متّفقان على الدَّين').toBe(0);
    expect(data.result).toBe('MATCHED');
    // AND THE SIGN IS LOAD-BEARING: had the reader called the cell +50, the
    // very same row would have been a hundred out.
    expect(50 - Number(data.expectedAmount)).toBe(100);
  });
});

/* ──────────────────────── an unreadable cell, named ─────────────────────── */

describe('an unreadable money cell refuses the file, naming the row and the cell', () => {
  it('names the sheet row and quotes the cell back verbatim', () => {
    const { rows, total, error } = parseStatementRows(HEADER, [
      ['BC1', '15133', '12.0', '3.0', '9.0', 'تم توصيلها'],
      ['BC2', '15134', '12.0', '3.0', '3,500', 'تم توصيلها'],
    ]);
    // THE FIGURES FIRST, as everywhere in this file. The old strip read this
    // cell as 3500 — a thousand times the 3.5 it may equally have meant —
    // and nothing is allowed through in its place. A statement is one claim,
    // not a list of rows: letting only the readable line through would make
    // `totalAmount` 9 instead of the courier's own figure, and `receiptGap`
    // would then demand a written explanation for money nobody ever owed.
    expect(rows.map((r) => r.amount), 'لا سطرَ يَمُرُّ').toEqual([]);
    expect(total, 'ولا مجموعَ يُدَّعى').toBe(0);
    // And only then the sentence, which has to be actionable.
    expect(error, 'الخليّةُ مقتبسةٌ حرفيّاً').toContain('«3,500»');
    expect(error, 'العمودُ مُسمًّى').toContain('الصافي');
    // Row 3 of the sheet: the header is row 1, so this second data row is 3.
    expect(error).toContain('السطر 3');
  });

  it('and it names whichever money column actually holds the bad cell', () => {
    // Each of these three read as a WRONG NUMBER under the old strip — 125,
    // 10 and 1400 — so the figure each row would have carried is asserted
    // before the column's name.
    for (const [cells, column, wasRead] of [
      [['BC1', '15133', '١٢,٥', '3.0', '9.0', 'ok'], 'التحصيل', 125],
      [['BC1', '15133', '12.0', '0x10', '9.0', 'ok'], 'أجرة التوصيل', 10],
      [['BC1', '15133', '12.0', '3.0', '1e400', 'ok'], 'الصافي', 1400],
    ] as [string[], string, number][]) {
      const { rows, error } = parseStatementRows(HEADER, [cells]);
      expect(rows, `${column}: سطرٌ مَرَّ وكان سيحمل ${wasRead}`).toEqual([]);
      expect(error, column).toContain(column);
    }
  });

  it('and the sentence tells the operator what IS readable, including the bracket', () => {
    const { error } = parseStatementRows(HEADER, [['BC1', '15133', '12.0', '3.0', '3,5', 'ok']]);
    expect(error).toContain('(50)');
    expect(error, 'يَشرَحُ لماذا الفاصلةُ مرفوضة').toContain('3,500');
  });

  it('and it refuses rather than DROPPING the line, which is what it used to do', () => {
    // The old reader returned null for an unreadable cell, and the caller
    // did `if (amount === null) continue` — so the parcel silently left the
    // statement and the sweep then reported it as one the courier never
    // mentioned. One row in, zero rows out, no error: that is the shape of
    // the behaviour that is gone.
    const { rows, error } = parseStatementRows(HEADER, [['BC1', '15133', '', '', '٣٥٠٠ د.أ', 'ok']]);
    expect(rows).toEqual([]);
    expect(error, 'الصمتُ ذهب').toBeDefined();
  });

  it('but an EMPTY money cell is absent, not unreadable, and refuses nothing', () => {
    // A courier who states a net and nothing else. Absence loses no
    // information, so there is nothing to refuse.
    const { rows, error } = parseStatementRows(HEADER, [['BC1', '15133', '', '', '9.0', 'ok']]);
    expect(error).toBeUndefined();
    expect(rows[0]).toMatchObject({ amount: 9, collected: null, fee: null });
  });

  it('and a line with no money stated at all is still dropped, quietly and on purpose', () => {
    const { rows, error } = parseStatementRows(HEADER, [['BC1', '15133', '', '', '', 'قيد التوصيل']]);
    expect(error).toBeUndefined();
    // Nothing was lost: the courier said nothing about this parcel's money,
    // and MISSING_IN_STATEMENT is the word for a parcel no line names.
    expect(rows).toEqual([]);
  });

  it('and the refusal reaches through `parseStatement`, from a CSV as uploaded', () => {
    const { rows, error } = parseStatement('المرجع,الصافي\nORD-1,9\nORD-2,(50)\nORD-3,"1.234,56"');
    expect(error).toContain('«1.234,56»');
    expect(error).toContain('السطر 4');
    expect(rows).toEqual([]);

    // And with that one cell corrected the file imports, sign and all.
    const good = parseStatement('المرجع,الصافي\nORD-1,9\nORD-2,(50)\nORD-3,-1234.56');
    expect(good.error).toBeUndefined();
    expect(good.rows.map((r) => r.amount)).toEqual([9, -50, -1234.56]);
  });
});
