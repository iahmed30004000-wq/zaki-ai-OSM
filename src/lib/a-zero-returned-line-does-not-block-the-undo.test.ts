import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCourierWord } from './couriers/words';
import { stripComments } from './guard-source';
import { isExcludedLine } from './statement-exclusion';
import {
  ZERO_RETURN_ROW_RESULTS,
  isZeroReturnedLine,
  rowRebuiltUnanswered,
  statementNamingRefusal,
  undoDeliveryNamingRefusal,
  zeroReturnCarriesNoMoney,
  type UndoLinkedLine,
  type UndoNamingLine,
} from './settlement-gates';

/**
 * 25/11 (A3): «تراجع عن التسليم» — A LINE AT ZERO THAT SAYS «RETURNED» IS NOT THE ORDER'S MONEY.
 *
 * The rule, read on its own: which lines and which rows it sets aside, and that it sets aside nothing else. The press itself, against a
 * database that remembers, is in `delivery-undo.test.ts` (section 10); the collect door's byte-for-byte equality with main is in
 * `the-collect-door-reads-statements-as-main.test.ts`.
 */

const word = (s: string | null) => readCourierWord(s);
const ORDER = { id: 'o1', orderNumber: 'ORD-2026-1696', merchantRef: 'MR-1', trackingNumber: 'BC-1', deliveryProviderId: 'p1' };
const APPROVED = { reference: 'ST-9', status: 'APPROVED', approvedAt: '2026-11-20T10:00:00.000Z', deliveryProviderId: 'p1' };
const ROW = { result: 'MISMATCHED', resolution: null, appliedAt: null, matchedBy: 'BARCODE' };
const line = (over: Partial<UndoNamingLine> = {}): UndoNamingLine => ({
  merchantRef: null,
  barcode: 'BC-1',
  amount: 0,
  collected: 0,
  fee: 0,
  word: word('تم إرجاعها'),
  statement: APPROVED,
  matches: [ROW],
  ...over,
});

describe('which line is «returned, at zero»', () => {
  it.each([
    ['«تم إرجاعها» at zero', {}],
    ['«تم ارجاعها» (no hamza)', { word: word('تم ارجاعها') }],
    ['no collected and no fee cell', { collected: null, fee: null }],
    ['figures written as text, as a Decimal prints', { amount: '0.000', collected: '0', fee: '0.00' }],
    ['the company\'s own table: «مسلمة الى المرسل»', { word: word('مسلمة الى المرسل') }],
  ] as [string, Partial<UndoNamingLine>][])('%s → yes', (_n, over) => {
    expect(isZeroReturnedLine(line(over))).toBe(true);
  });

  it.each([
    ['money in the net', { amount: 25 }],
    ['the return fee charged (net −3)', { amount: -3, fee: 3 }],
    ['a fee beside a zero net (RV807)', { fee: 3 }],
    ['a collected figure beside a zero net', { collected: 3 }],
    ['a negative collected figure', { collected: -2 }],
    ['no net at all', { amount: null }],
    ['«مؤجلة»', { word: word('مؤجلة') }],
    ['«مؤجل»', { word: word('مؤجل') }],
    ['an empty cell', { word: word(null) }],
    ['blank', { word: word('   ') }],
    ['a word nobody knows', { word: word('حالة جديدة') }],
    ['«تم توصيلها» at zero', { word: word('تم توصيلها') }],
    ['«ملغاة» at zero (cancelled is not returned)', { word: word('ملغاة') }],
    ['an unknown word that claims RETURNED', { word: { outcome: 'RETURNED', known: false } }],
  ] as [string, Partial<UndoNamingLine>][])('%s → no', (_n, over) => {
    expect(isZeroReturnedLine(line(over))).toBe(false);
  });
});

describe('which rows the matching rebuilds — the only rows set aside', () => {
  it('MISMATCHED and EXCLUDED, nobody\'s answer, not settled by the approval, not made by a person', () => {
    expect([...ZERO_RETURN_ROW_RESULTS]).toEqual(['MISMATCHED', 'EXCLUDED']);
    expect(rowRebuiltUnanswered(ROW)).toBe(true);
    expect(rowRebuiltUnanswered({ ...ROW, result: 'EXCLUDED' })).toBe(true);
    expect(rowRebuiltUnanswered({ ...ROW, matchedBy: null })).toBe(true);
  });

  it.each([
    ['MATCHED', { result: 'MATCHED' }],
    ['MISSING_IN_SYSTEM', { result: 'MISSING_IN_SYSTEM' }],
    ['answered «اعتُمد رقم الشركة»', { resolution: 'ACCEPTED_COURIER' }],
    ['answered «رقمنا»', { resolution: 'OURS_STANDS' }],
    ['settled by the approval', { appliedAt: '2026-11-20T10:00:00.000Z' }],
    ['tied by a person', { matchedBy: 'MANUAL' }],
    ['a read that did not ask for the answer', { resolution: undefined }],
    ['a read that did not ask for the stamp', { appliedAt: undefined }],
    ['a read that did not ask who made it', { matchedBy: undefined }],
  ] as [string, Record<string, unknown>][])('NEGATIVE — %s → kept (it speaks)', (_n, over) => {
    expect(rowRebuiltUnanswered({ ...ROW, ...over } as never)).toBe(false);
    expect(zeroReturnCarriesNoMoney(line(), [{ ...ROW, ...over } as never])).toBe(false);
  });

  it('one kept row among the line\'s rows keeps the whole line', () => {
    expect(zeroReturnCarriesNoMoney(line(), [ROW, { ...ROW, result: 'MATCHED' }])).toBe(false);
    expect(zeroReturnCarriesNoMoney(line(), [])).toBe(true);
  });
});

describe('the undo\'s question against the collect door\'s, on the same facts', () => {
  it('the worked case: the collect door refuses on the zero «returned» line; the undo does not', () => {
    const l = line();
    expect(statementNamingRefusal([ORDER], [l])?.code).toBe('IN_APPROVED_STATEMENT');
    expect(undoDeliveryNamingRefusal([ORDER], [l])).toBeNull();
    const link: UndoLinkedLine = { orderId: 'o1', ...ROW, statement: APPROVED, line: { amount: 0, collected: null, fee: null, word: word('تم إرجاعها') } };
    expect(statementNamingRefusal([ORDER], [], [link])?.code).toBe('IN_APPROVED_STATEMENT');
    expect(undoDeliveryNamingRefusal([ORDER], [], [link])).toBeNull();
  });

  it('NEGATIVE — a link with no line read speaks for the order, as the collect door reads it', () => {
    const link: UndoLinkedLine = { orderId: 'o1', ...ROW, statement: APPROVED, line: null };
    expect(undoDeliveryNamingRefusal([ORDER], [], [link])).toEqual(statementNamingRefusal([ORDER], [], [link]));
    expect(undoDeliveryNamingRefusal([ORDER], [], [link])?.code).toBe('IN_APPROVED_STATEMENT');
  });

  it('NEGATIVE — every other line gets the collect door\'s very answer, sentence for sentence', () => {
    for (const over of [{ amount: 25 }, { word: word('مؤجلة') }, { word: word(null) }, { amount: -3, fee: 3 }, { matches: [{ ...ROW, resolution: 'ACCEPTED_COURIER' }] }]) {
      const l = line(over as Partial<UndoNamingLine>);
      const a = undoDeliveryNamingRefusal([ORDER], [l]);
      expect(a).not.toBeNull();
      expect(a).toEqual(statementNamingRefusal([ORDER], [l]));
    }
  });

  it('PROPERTY — over 3,000 random sets of lines the undo never refuses where the collect door would not, and agrees exactly when no line is a zero «returned» one', () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    let differed = 0;
    for (let n = 0; n < 3000; n++) {
      const lines: UndoNamingLine[] = Array.from({ length: Math.floor(r() * 4) }, () => ({
        merchantRef: pick(['MR-1', null]),
        barcode: pick(['BC-1', 'BC-2', null]),
        amount: pick([0, 0, 25, -3]),
        collected: pick([null, 0, 3]),
        fee: pick([null, 0, 3]),
        word: word(pick(['تم إرجاعها', 'مؤجلة', null, 'تم توصيلها'])),
        statement: { ...APPROVED, approvedAt: pick([APPROVED.approvedAt, null]), deliveryProviderId: pick(['p1', 'p2']) },
        matches: Array.from({ length: Math.floor(r() * 3) }, () => ({
          result: pick(['MATCHED', 'MISMATCHED', 'EXCLUDED']),
          resolution: pick([null, 'ACCEPTED_COURIER']),
          appliedAt: null,
          matchedBy: pick(['BARCODE', 'MANUAL']),
        })),
      }));
      const collect = statementNamingRefusal([ORDER], lines);
      const undo = undoDeliveryNamingRefusal([ORDER], lines);
      if (undo !== null) expect(collect).not.toBeNull();
      if (!lines.some((l) => isZeroReturnedLine(l))) expect(undo).toEqual(collect);
      if (JSON.stringify(undo) !== JSON.stringify(collect)) differed++;
    }
    expect(differed).toBeGreaterThanOrEqual(15);
  });

  it('what is set aside here is what the matching excludes once the order is back on the road', () => {
    for (const status of ['تم إرجاعها', 'تم ارجاعها', 'مسلمة الى المرسل']) {
      expect(isZeroReturnedLine(line({ word: word(status) })), status).toBe(true);
      expect(isExcludedLine({ amount: 0, collected: 0, fee: 0, status }, { shippingStatus: 'SHIPPED' }), status).toBe(true);
      // …while the order still says delivered, the same line is a difference — the row that used to block the undo
      expect(isExcludedLine({ amount: 0, collected: 0, fee: 0, status }, { shippingStatus: 'DELIVERED' }), status).toBe(false);
    }
  });
});

describe('the gates file stays free of the word table — screens import it', () => {
  it('settlement-gates imports no word reader (the caller reads the word)', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/lib/settlement-gates.ts'), 'utf8'));
    expect(src).not.toMatch(/couriers\/words|readCourierWord\(/);
    const imports = src.split(/\r?\n/).filter((l) => /^import /.test(l)).map((l) => l.trim());
    expect(imports).toEqual(["import { MANUAL_MATCH } from './match-integrity';", "import { EXCLUDED_RESULT } from './statement-open-lines';"]);
  });
});
