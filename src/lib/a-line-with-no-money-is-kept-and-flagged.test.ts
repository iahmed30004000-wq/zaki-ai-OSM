import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A LINE THE COMPANY NAMED AND WROTE NO MONEY AGAINST IS KEPT AS ZERO, WITH A FLAG — AND THE WORD IT WROTE
 * IS READ THE SAME WAY AT THE IMPORT AND AT THE MATCHING.
 *
 * «وصفر … يحطو بالملاحظات». Such a line used to be dropped (`if (amount === null) continue`), and a dash or
 * «لا يوجد» in a money cell refused the WHOLE file. Dropped, the parcel was missing from the record and the
 * sweep reported it as one no statement mentions; refused, a whole day's statement could not be imported
 * because of one empty cell.
 */

const { db } = vi.hoisted(() => ({
  db: {
    statementLine: { findMany: vi.fn() },
    courierStatement: { findFirst: vi.fn() },
    settlementMatch: { deleteMany: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    order: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { parseStatement, parseStatementRows, runMatching } from './settlement';
import { ZERO_LINE_NOTE } from './match-integrity';

// barcode, notes, collected, fee, net, status — the shape of the file the company sends.
const HEADER = ['باركود الشحنة', 'الملاحظات', 'التحصيل', 'السعر', 'الصافي', 'الحالة'];
const parse = (...rows: string[][]) => parseStatementRows(HEADER, rows);

describe('the import keeps a line with no money, whatever the empty cell looks like', () => {
  it.each([
    ['an empty cell', ''],
    ['spaces', '   '],
    ['a hyphen', '-'],
    ['a long dash', '—'],
    ['a short dash', '–'],
    ['an underscore', '_'],
    ['the words «لا يوجد»', 'لا يوجد'],
    ['«بدون»', 'بدون'],
    ['«N/A»', 'N/A'],
  ])('%s in every money cell: kept at 0, flagged, the file not refused', (_, cell) => {
    const { rows, error, blankLines, total } = parse(['BC1', '15133', cell, cell, cell, 'مؤجلة']);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ barcode: 'BC1', merchantRef: '15133', amount: 0, collected: null, fee: null, amountBlank: true });
    expect(blankLines).toBe(1);
    // A zero adds nothing: the claim the receipts are measured against does not move.
    expect(total).toBe(0);
  });

  it('a line with a figure is not flagged, and the blank beside it does not change its figure', () => {
    const { rows, total, blankLines } = parse(
      ['BC1', '15133', '12', '3', '9', 'تم توصيلها'],
      ['BC2', '15132', '', '', '-', 'مؤجل'],
      ['BC3', '15131', '20', '3', 'لا يوجد', 'تم توصيلها']
    );
    expect(rows.map((r) => [r.amount, r.amountBlank])).toEqual([[9, false], [0, true], [17, false]]);
    expect(total).toBe(26);
    expect(blankLines).toBe(1);
  });

  it('a dash in the net column is no net, but the collected and the fee beside it still make one', () => {
    const { rows } = parse(['BC1', '15133', '20', '2.5', '-', 'تم توصيلها']);
    expect(rows[0]).toMatchObject({ amount: 17.5, collected: 20, fee: 2.5, amountBlank: false });
  });

  it('and a written zero is a zero the company STATED — not blank, not flagged', () => {
    const { rows, blankLines } = parse(['BC1', '15055', '0.0', '0.0', '0.0', 'تم إرجاعها']);
    expect(rows[0]).toMatchObject({ amount: 0, amountBlank: false });
    expect(blankLines).toBe(0);
  });

  it('a row that names NO parcel and carries NO money is a heading or a footer, and is still skipped', () => {
    const { rows } = parse(['', '', '', '', '', 'المجموع'], ['', 'ملاحظة بلا مرجع', '', '', '', '']);
    expect(rows).toEqual([]);
  });

  it('a row of no cells at all is skipped, as before', () => {
    expect(parse(['', '', '', '', '', '']).rows).toEqual([]);
  });

  it('reaches through `parseStatement` from a CSV as uploaded', () => {
    const { rows, error, blankLines } = parseStatement('المرجع,الصافي\nORD-1,9\nORD-2,\nORD-3,-\nORD-4,لا يوجد');
    expect(error).toBeUndefined();
    expect(rows.map((r) => [r.merchantRef, r.amount, r.amountBlank])).toEqual([
      ['ORD-1', 9, false], ['ORD-2', 0, true], ['ORD-3', 0, true], ['ORD-4', 0, true],
    ]);
    expect(blankLines).toBe(3);
  });
});

describe('and what is NOT no-money is still refused by name — the file is not opened wider than it was', () => {
  it.each(['٣٥٠٠ د.أ', '3,500', '12abc', '1e400', 'تم'])('«%s» in the net column still refuses the file', (cell) => {
    const { rows, error } = parse(['BC1', '15133', '', '', cell, 'ok']);
    expect(rows).toEqual([]);
    expect(error).toContain('السطر 2');
    expect(error).toContain(`«${cell}»`);
  });
});

describe('a three-place currency keeps its fils through the import', () => {
  it('12.345 stays 12.345, a blank is 0 and not 0.001, and the total is exact', () => {
    const { rows, total } = parse(['BC1', '15133', '', '', '12.345', 'تم توصيلها'], ['BC2', '15132', '', '', '', 'مؤجلة']);
    expect(rows.map((r) => r.amount)).toEqual([12.345, 0]);
    expect(total).toBe(12.345);
  });
});

describe('the import reads the status words with the one table', () => {
  it('tallies them and lists the unknown ones as written', () => {
    const { words } = parse(
      ['BC1', '15133', '', '', '9', 'تم توصيلها'],
      ['BC2', '15132', '', '', '9', 'مؤجل'],
      ['BC3', '15131', '', '', '9', 'مؤجلة'],
      ['BC4', '15130', '', '', '9', 'حالة جديدة']
    );
    expect(words?.byOutcome).toEqual({ DELIVERED: 1, POSTPONED: 2, UNKNOWN: 1 });
    expect(words?.unknown).toEqual(['حالة جديدة']);
  });

  it('a refused file carries no tally — there is nothing to tally', () => {
    const r = parse(['BC1', '15133', '', '', '٣٥٠٠ د.أ', 'مؤجلة']);
    expect(r.error).toBeDefined();
    expect(r.words).toBeUndefined();
  });
});

// ───────────────────────────── the matching ─────────────────────────────

const scope = { companyId: 'c1', storeId: 's1', statementId: 'st1', minorUnit: 3 };

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING',
  totalAmount: 12.345,
  priceIncludesDelivery: false,
  collectedAmount: null,
  deliveryFee: 0,
  returnReceipt: null,
  addOns: [],
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 12.345, discountShare: 0, lineTotal: 12.345, deliveredQty: null }],
  ...over,
});
const line = (over: Record<string, unknown> = {}) => ({
  id: 'l1', merchantRef: 'REF-1', barcode: null, amount: 12.345, fee: null, status: null, ...over,
});
const created = () => db.settlementMatch.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  db.settlementMatch.create.mockResolvedValue({});
  db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.order.findMany.mockResolvedValue([]);
  db.courierStatement.findFirst.mockResolvedValue({
    id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-20T00:00:00Z'),
  });
});

describe('the matching keeps the zero line and says it is one', () => {
  it('a zero line against a delivered order is MISMATCHED by the whole expected amount, to the fils, with the zero named', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ amount: 0 })]);
    db.order.findFirst.mockResolvedValue(orderRow());

    await runMatching(db as never, scope);

    const row = created()[0];
    expect(row).toMatchObject({ result: 'MISMATCHED', orderId: 'o1', expectedAmount: 12.345, statementAmount: 0, difference: -12.345 });
    expect(row.note).toContain(ZERO_LINE_NOTE);
  });

  it('a zero line that names no order is MISSING_IN_SYSTEM, with the zero named beside the usual sentence', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ amount: 0 })]);
    db.order.findFirst.mockResolvedValue(null);

    await runMatching(db as never, scope);

    const row = created()[0];
    expect(row.result).toBe('MISSING_IN_SYSTEM');
    expect(row.note).toBe(`لا يوجد طلب بهذا الباركود أو المرجع · ${ZERO_LINE_NOTE}`);
  });

  it('a zero line against a parcel that CAME BACK is the clean match it always was (nothing is owed for a return)', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ amount: 0 })]);
    db.order.findFirst.mockResolvedValue(orderRow({ shippingStatus: 'RETURNED' }));

    await runMatching(db as never, scope);

    expect(created()[0]).toMatchObject({ result: 'MATCHED', note: null, difference: 0 });
  });
});

describe('the matching reads the company’s word with the same table as the import', () => {
  it('«مؤجلة» and «مؤجل» are written beside a row a person must look at — the same sentence shape, each in its own spelling', async () => {
    for (const word of ['مؤجلة', 'مؤجل']) {
      vi.clearAllMocks();
      db.settlementMatch.create.mockResolvedValue({});
      db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
      db.settlementMatch.findMany.mockResolvedValue([]);
      db.orderChangeRequest.findMany.mockResolvedValue([]);
      db.order.findMany.mockResolvedValue([]);
      db.courierStatement.findFirst.mockResolvedValue({ id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date() });
      db.statementLine.findMany.mockResolvedValue([line({ amount: 5, status: word })]);
      db.order.findFirst.mockResolvedValue(orderRow());

      await runMatching(db as never, scope);

      expect(created()[0].result, word).toBe('MISMATCHED');
      expect(created()[0].note, word).toBe(`قالت الشركة: «${word}»`);
    }
  });

  it('an unknown word is said to be unknown, on a row that needs a person', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ amount: 5, status: 'حالة جديدة' })]);
    db.order.findFirst.mockResolvedValue(orderRow());

    await runMatching(db as never, scope);

    expect(created()[0].note).toBe('كلمة الشركة «حالة جديدة» لا نعرفها بعد');
  });

  it('and on a line with no order too', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ status: 'مؤجلة' })]);
    db.order.findFirst.mockResolvedValue(null);

    await runMatching(db as never, scope);

    expect(created()[0].note).toBe('لا يوجد طلب بهذا الباركود أو المرجع · قالت الشركة: «مؤجلة»');
  });

  it('but a WORD NEVER CHANGES A VERDICT: a clean line stays MATCHED with no note, whatever it says', async () => {
    for (const word of ['مؤجلة', 'تم توصيلها', 'حالة جديدة', null]) {
      vi.clearAllMocks();
      db.settlementMatch.create.mockResolvedValue({});
      db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
      db.settlementMatch.findMany.mockResolvedValue([]);
      db.orderChangeRequest.findMany.mockResolvedValue([]);
      db.order.findMany.mockResolvedValue([]);
      db.courierStatement.findFirst.mockResolvedValue({ id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date() });
      db.statementLine.findMany.mockResolvedValue([line({ status: word })]);
      db.order.findFirst.mockResolvedValue(orderRow());

      await runMatching(db as never, scope);

      expect(created()[0], String(word)).toMatchObject({ result: 'MATCHED', note: null, difference: 0 });
    }
  });

  it('and a delivered line that is wrong in money says the amount, not the word: «تم توصيلها» adds nothing', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ amount: 5, status: 'تم توصيلها' })]);
    db.order.findFirst.mockResolvedValue(orderRow());

    await runMatching(db as never, scope);

    expect(created()[0]).toMatchObject({ result: 'MISMATCHED', difference: -7.345, note: null });
  });
});
