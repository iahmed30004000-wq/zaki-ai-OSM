import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { buildXlsx } from './xlsx-writer';
import { readXlsxRows } from './xlsx-reader';
import { MOVEMENT_CATEGORIES } from './wallets';
import { MOVEMENT_CATEGORY_AR } from './movement-category-words';
import { HISTORY_PDF_HELP, historyExportUrl } from './history-export-url';
import { renderHistoryPage } from './history-print';
import {
  HISTORY_ROW_CAP,
  MOVEMENT_HEADER,
  NO_FILTERS,
  TOO_MANY_ROWS,
  TOTALS_HEADER,
  TOTALS_TITLE,
  TRANSFER_HEADER,
  WITHDRAWAL_HEADER,
  historyWindow,
  movementSheet,
  movementsWhere,
  readHistoryFilters,
  sheetCells,
  storeMoment,
  transferSheet,
  transfersWhere,
  withdrawalSheet,
  withdrawalsWhere,
  type MovementLine,
  type TransferLine,
  type WithdrawalLine,
} from './history-export-core';

/**
 * «سحب سجل حركات وتحويلات وتواريخ ينزلو PDF أو Excel» (22/11, F5) — THE FILE'S CONTENT, golden: two currencies, a reversed row,
 * the store's clock, the totals per currency per direction that never cross a currency, and the filters read back.
 */

const TZ = 'Asia/Damascus'; // UTC+3 all year

const mv = (over: Partial<MovementLine>): MovementLine => ({
  id: 'm', direction: 'IN', amount: 0, currencyCode: 'USD', party: 'طرف', category: 'OTHER', note: 'ملاحظة',
  createdAt: '2026-11-20T09:00:00.000Z', realDate: '2026-11-20T09:00:00.000Z', createdByName: 'سلوى',
  reversalOfId: null, reversalReason: null, reversedBy: null, walletName: 'صندوق', minorUnit: 2, ...over,
});

const MOVEMENTS: MovementLine[] = [
  // Typed for the 19th at 23:30 Damascus (20:30Z), registered on the 20th.
  mv({ id: 'a', amount: 100.456, realDate: '2026-11-19T20:30:00.000Z', createdAt: '2026-11-20T06:05:00.000Z', category: 'COURIER_SETTLEMENT', party: 'شركة الشحن' }),
  mv({ id: 'b', direction: 'OUT', amount: 25.5, category: 'EXPENSE', party: 'مورد' }),
  // A Syrian-pound wallet, no decimals: 150000.4 is shown 150000.
  mv({ id: 'c', amount: 150000.4, currencyCode: 'SYP', minorUnit: 0, walletName: 'ليرة', party: 'زبون' }),
  // Reversed, and its reversing entry: both listed, neither in the totals.
  mv({ id: 'd', direction: 'OUT', amount: 40, party: 'خطأ', reversedBy: { reversalReason: 'مبلغ غلط' } }),
  mv({ id: 'e', direction: 'IN', amount: 40, party: 'خطأ', reversalOfId: 'd', reversalReason: 'مبلغ غلط' }),
];

describe('the movements sheet', () => {
  const sheet = movementSheet(MOVEMENTS, TZ);

  it('golden rows: real date and registration on the store clock, rounded amounts, Arabic words, the reversal said', () => {
    expect(sheet.header).toEqual(MOVEMENT_HEADER);
    expect(sheet.rows.map((r) => r.cells)).toEqual([
      ['2026-11-19 23:30', '2026-11-20 09:05', 'سلوى', 'صندوق', 'وارد', 100.46, 'USD', 'شركة الشحن', 'تحصيل شركة شحن', 'ملاحظة', 'ساري'],
      ['2026-11-20 12:00', '2026-11-20 12:00', 'سلوى', 'صندوق', 'صادر', 25.5, 'USD', 'مورد', 'مصروف', 'ملاحظة', 'ساري'],
      ['2026-11-20 12:00', '2026-11-20 12:00', 'سلوى', 'ليرة', 'وارد', 150000, 'SYP', 'زبون', 'أخرى', 'ملاحظة', 'ساري'],
      ['2026-11-20 12:00', '2026-11-20 12:00', 'سلوى', 'صندوق', 'صادر', 40, 'USD', 'خطأ', 'أخرى', 'ملاحظة', 'معكوس — مبلغ غلط'],
      ['2026-11-20 12:00', '2026-11-20 12:00', 'سلوى', 'صندوق', 'وارد', 40, 'USD', 'خطأ', 'أخرى', 'ملاحظة', 'قيد عكسي — مبلغ غلط'],
    ]);
  });

  it('totals per currency per direction, the standing rows only, never across currencies', () => {
    expect(sheet.totals).toEqual([
      { label: 'وارد', currency: 'SYP', minorUnit: 0, amount: 150000, count: 1 },
      { label: 'صادر', currency: 'USD', minorUnit: 2, amount: 25.5, count: 1 },
      { label: 'وارد', currency: 'USD', minorUnit: 2, amount: 100.46, count: 1 },
    ]);
  });

  it('the Excel file carries the rows, then the totals block, read back by the project reader', () => {
    const file = buildXlsx({ name: sheet.title, header: sheet.header, rows: sheetCells(sheet) });
    const back = readXlsxRows(file);
    expect(back[0]).toEqual(MOVEMENT_HEADER);
    expect(back[1].slice(0, 7)).toEqual(['2026-11-19 23:30', '2026-11-20 09:05', 'سلوى', 'صندوق', 'وارد', '100.46', 'USD']);
    const at = back.findIndex((r) => r[0] === TOTALS_TITLE);
    expect(at).toBeGreaterThan(5);
    expect(back[at + 1]).toEqual(TOTALS_HEADER);
    expect(back.slice(at + 2)).toEqual([
      ['وارد', 'SYP', '150000', '1'],
      ['صادر', 'USD', '25.5', '1'],
      ['وارد', 'USD', '100.46', '1'],
    ]);
  });

  it('the sheet is read right to left', () => {
    const file = buildXlsx({ name: sheet.title, header: sheet.header, rows: sheetCells(sheet) });
    // The worksheet part, inflated out of the ZIP: the view says right-to-left.
    const at = file.indexOf(Buffer.from('xl/worksheets/sheet1.xml'));
    const local = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at);
    const size = file.readUInt32LE(local + 18);
    const nameLen = file.readUInt16LE(local + 26);
    const xml = inflateRawSync(file.subarray(local + 30 + nameLen, local + 30 + nameLen + size)).toString('utf8');
    expect(xml).toContain('rightToLeft="1"');
  });
});

const tr = (over: Partial<TransferLine>): TransferLine => ({
  id: 't', amountOut: 100, amountIn: 100, exchangeRate: 1, kindLabel: 'تحويل داخلي', note: 'نقل', createdAt: '2026-11-20T09:00:00.000Z',
  realDate: '2026-11-20T09:00:00.000Z', createdByName: 'سلوى', from: { name: 'صندوق', currencyCode: 'USD' }, to: { name: 'بنك', currencyCode: 'USD' },
  state: 'ACTIVE', reversal: null, fromMinor: 2, toMinor: 2, ...over,
});

describe('the transfers sheet', () => {
  const sheet = transferSheet(
    [
      tr({ id: 'x', amountOut: 1300000, amountIn: 100, exchangeRate: 0.0000769231, kindLabel: 'صرافة', from: { name: 'ليرة', currencyCode: 'SYP' }, to: { name: 'دولار', currencyCode: 'USD' }, fromMinor: 0 }),
      tr({ id: 'y', amountOut: 50.555 }),
      tr({ id: 'z', amountOut: 10, amountIn: 10, state: 'REVERSED', reversal: { reason: 'تحويل مكرر' } }),
    ],
    TZ
  );

  it('golden rows: from → to, both amounts in their own decimals, the rate in words only where the currency changed, the state', () => {
    expect(sheet.header).toEqual(TRANSFER_HEADER);
    expect(sheet.rows.map((r) => r.cells)).toEqual([
      ['2026-11-20 12:00', '2026-11-20 12:00', 'سلوى', 'ليرة', 'دولار', 'صرافة', 1300000, 'SYP', 100, 'USD', '0.0000769231 (1 SYP = 0.0000769231 USD)', 'نقل', 'ساري'],
      ['2026-11-20 12:00', '2026-11-20 12:00', 'سلوى', 'صندوق', 'بنك', 'تحويل داخلي', 50.56, 'USD', 100, 'USD', '', 'نقل', 'ساري'],
      ['2026-11-20 12:00', '2026-11-20 12:00', 'سلوى', 'صندوق', 'بنك', 'تحويل داخلي', 10, 'USD', 10, 'USD', '', 'نقل', 'معكوس — تحويل مكرر'],
    ]);
  });

  it('totals: out per source currency, arrived per destination currency; the reversed transfer is left out', () => {
    expect(sheet.totals).toEqual([
      { label: 'صادر', currency: 'SYP', minorUnit: 0, amount: 1300000, count: 1 },
      { label: 'صادر', currency: 'USD', minorUnit: 2, amount: 50.56, count: 1 },
      { label: 'واصل', currency: 'USD', minorUnit: 2, amount: 200, count: 2 },
    ]);
  });
});

describe('the withdrawals sheet', () => {
  const w = (over: Partial<WithdrawalLine>): WithdrawalLine => ({
    id: 'w', partnerName: 'الشريك أ', currencyCode: 'USD', minorUnit: 2, amount: 500, withdrawnOn: '2026-11-19', fromStanding: true, note: null,
    createdAt: '2026-11-20T09:00:00.000Z', createdByName: 'المالك', cancelled: null, storeName: 'متجر', ...over,
  });
  const sheet = withdrawalSheet(
    [w({ id: '1' }), w({ id: '2', currencyCode: 'JOD', minorUnit: 3, amount: 70.1234, fromStanding: false, note: 'سلفة' }), w({ id: '3', cancelled: { reason: 'سجلتها غلط' } })],
    TZ
  );

  it('golden rows and per-currency totals without the cancelled one', () => {
    expect(sheet.header).toEqual(WITHDRAWAL_HEADER);
    expect(sheet.rows.map((r) => r.cells)).toEqual([
      ['2026-11-19', '2026-11-20 12:00', 'المالك', 'الشريك أ', 'متجر', 500, 'USD', 'نعم', '', 'ساري'],
      ['2026-11-19', '2026-11-20 12:00', 'المالك', 'الشريك أ', 'متجر', 70.123, 'JOD', 'لا', 'سلفة', 'ساري'],
      ['2026-11-19', '2026-11-20 12:00', 'المالك', 'الشريك أ', 'متجر', 500, 'USD', 'نعم', '', 'ملغى — سجلتها غلط'],
    ]);
    expect(sheet.totals).toEqual([
      { label: 'مسحوبات', currency: 'JOD', minorUnit: 3, amount: 70.123, count: 1 },
      { label: 'مسحوبات', currency: 'USD', minorUnit: 2, amount: 500, count: 1 },
    ]);
  });
});

describe('the print page', () => {
  it('is a whole RTL A4 document with the company, the filters, Western digits with separators and the totals; no app code', () => {
    const html = renderHistoryPage(movementSheet(MOVEMENTS, TZ), {
      companyName: 'شركة <تجربة>', storeName: 'متجر', filtersAr: ['الفترة: من 2026-11-01 إلى 2026-11-20 (حسب تاريخ الحركة)'], printedAt: '2026-11-22 10:00',
    });
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('size: A4 landscape');
    expect(html).toContain('شركة &lt;تجربة&gt; — متجر');
    expect(html).toContain('الفترة: من 2026-11-01 إلى 2026-11-20 (حسب تاريخ الحركة)');
    expect(html).toContain('150,000');
    expect(html).toContain('100.46');
    expect(html).toContain(TOTALS_TITLE);
    expect(html).toContain(HISTORY_PDF_HELP);
    expect(html).not.toMatch(/[٠-٩]/);
    // One inline line presses print; nothing of the app's bundles is loaded.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });
});

describe('the filters', () => {
  const read = (q: string) => readHistoryFilters(new URLSearchParams(q));

  it('reads a full address back', () => {
    const url = historyExportUrl('movements', { from: '2026-11-01', to: '2026-11-20', basis: 'registered', walletId: 'w-1', direction: 'OUT', category: 'EXPENSE' }, 'xlsx');
    expect(url).toBe('/api/finance/history/movements?from=2026-11-01&to=2026-11-20&basis=registered&walletId=w-1&direction=OUT&category=EXPENSE&format=xlsx');
    expect(read(url.split('?')[1])).toEqual({
      ok: true,
      value: { from: '2026-11-01', to: '2026-11-20', basis: 'registered', walletId: 'w-1', direction: 'OUT', category: 'EXPENSE' },
    });
  });

  it('NEGATIVE: a backwards span, a day that is not one, half a span, an unknown word — each an Arabic refusal with a code', () => {
    for (const q of ['from=2026-11-20&to=2026-11-01', 'from=2026-02-30&to=2026-03-01', 'from=2026-11-01', 'basis=x', 'direction=SIDEWAYS', 'category=NOPE', 'currency=usd', 'walletId=%3Cscript%3E']) {
      const r = read(q);
      expect(r.ok, q).toBe(false);
      if (!r.ok) {
        expect(r.refusal.code).toMatch(/^HISTORY_/);
        expect(r.refusal.errorAr).toMatch(/[؀-ۿ]/);
        expect(r.refusal.errorAr).not.toMatch(/[A-Za-z]{3}/);
      }
    }
  });

  it('the store day: a span of the 20th in Damascus is 21:00Z of the 19th to 21:00Z of the 20th', () => {
    expect(historyWindow({ ...NO_FILTERS, from: '2026-11-20', to: '2026-11-20' }, TZ)).toEqual({
      start: new Date('2026-11-19T21:00:00.000Z'),
      end: new Date('2026-11-20T21:00:00.000Z'),
    });
    expect(storeMoment('2026-11-19T21:00:00.000Z', TZ)).toBe('2026-11-20 00:00');
  });

  it('the row cap is a number, and its refusal names a narrower span in Arabic', () => {
    expect(HISTORY_ROW_CAP).toBe(5000);
    expect(TOO_MANY_ROWS.code).toBe('HISTORY_TOO_MANY_ROWS');
    expect(TOO_MANY_ROWS.errorAr).toContain('5000');
    expect(TOO_MANY_ROWS.errorAr).toContain('ضيّق التاريخ');
  });

  it('the category words are exactly the movement categories', () => {
    expect(Object.keys(MOVEMENT_CATEGORY_AR).sort()).toEqual([...MOVEMENT_CATEGORIES].sort());
  });
});

describe('the lists keep their own clause (no filter = byte for byte what the doors asked before)', () => {
  it('movements, transfers, withdrawals', () => {
    expect(movementsWhere({ walletId: 'w1' }, NO_FILTERS, TZ)).toEqual({ walletId: 'w1' });
    expect(transfersWhere('c1', NO_FILTERS, TZ)).toEqual({ companyId: 'c1' });
    expect(withdrawalsWhere('c1', ['s1', 's2'], NO_FILTERS, TZ)).toEqual({ companyId: 'c1', storeId: { in: ['s1', 's2'] } });
  });

  it('the real date reads the typed moment, or the registration where none was typed', () => {
    const f = { ...NO_FILTERS, from: '2026-11-20', to: '2026-11-20' };
    const span = { gte: new Date('2026-11-19T21:00:00.000Z'), lt: new Date('2026-11-20T21:00:00.000Z') };
    expect(movementsWhere({ walletId: 'w1' }, f, TZ)).toEqual({ walletId: 'w1', OR: [{ occurredAt: span }, { occurredAt: null, createdAt: span }] });
    expect(movementsWhere({ walletId: 'w1' }, { ...f, basis: 'registered' }, TZ)).toEqual({ walletId: 'w1', createdAt: span });
  });
});
