import { describe, expect, it } from 'vitest';
import { matchesQuery } from './queue-search';

/**
 * «زر تثبيت وفلاتر وسيرش بوكس» (the owner, 8/11) — what a person types above a queue against what a row says.
 *
 * They are written in different hands: «0900000001» against «+963 900 000 001», «ادلب» against «إدلب», Arabic digits against
 * Latin ones. Both sides go into one spelling first; every word must be found; a typed number is also looked for among the
 * digits of each field on its own and never among digits glued across two cells. Every value below is invented.
 */

const row = {
  fields: ['100000000001', '20001', 'سلمى الاختبار', '+963 900 000 001', 'إدلب - سلقين - سوق الخضار', 'إدلب', 'تم توصيلها'],
  text: ['100000000001 | 20001 | سلمى الاختبار | +963 900 000 001 | كاش | 46322.57921296296'],
};

describe('what the box answers', () => {
  it('an empty box (or only spaces) answers yes — nothing is hidden', () => {
    expect(matchesQuery(row, '')).toBe(true);
    expect(matchesQuery(row, '   ')).toBe(true);
    expect(matchesQuery({ fields: [] }, '')).toBe(true);
  });

  it('finds a barcode, the company’s order number, a name, a word of the address — by the text', () => {
    for (const q of ['100000000001', '20001', 'سلمى', 'سوق الخضار', 'سلقين']) expect(matchesQuery(row, q), q).toBe(true);
    expect(matchesQuery(row, 'حلب')).toBe(false);
  });

  it('a phone typed as the person has it finds the phone as the company wrote it: trunk zero, plus, spaces, Arabic digits', () => {
    for (const q of ['0900000001', '900000001', '+963900000001', '963900000001', '٠٩٠٠٠٠٠٠٠١', '900 000 001']) {
      expect(matchesQuery(row, q), q).toBe(true);
    }
    expect(matchesQuery(row, '0900000002')).toBe(false);
  });

  it('hamza, ة/ه and ى/ي are one letter each: «ادلب» finds «إدلب», «حماه» finds «حماة»', () => {
    expect(matchesQuery(row, 'ادلب')).toBe(true);
    expect(matchesQuery({ fields: ['حماة'] }, 'حماه')).toBe(true);
    expect(matchesQuery({ fields: ['مستشفى'] }, 'مستشفي')).toBe(true);
  });

  it('every word has to be found: a second word narrows, it never widens', () => {
    expect(matchesQuery(row, 'سلمى إدلب')).toBe(true);
    expect(matchesQuery(row, 'سلمى حلب')).toBe(false);
  });

  it('case does not matter for Latin text', () => {
    expect(matchesQuery({ fields: ['Test Receiver'] }, 'test RECEIVER')).toBe(true);
  });

  it('a number is never looked for among digits glued across two cells', () => {
    // «100000000001» + «20001» glued is «…00012 0001»: a query nobody wrote must not find the row.
    expect(matchesQuery({ fields: ['100000000001', '20001'] }, '000120001')).toBe(false);
    expect(matchesQuery({ fields: ['100000000001', '20001'] }, '120001')).toBe(false);
  });

  it('the company’s whole row is searched as text only: a word in it finds the row, its digits do not make phones', () => {
    expect(matchesQuery(row, 'كاش')).toBe(true);
    // The spreadsheet serial inside the free text is found as written, but not as «digits of a field».
    expect(matchesQuery({ fields: ['x'], text: ['a | 1234 | 5678'] }, '12345678')).toBe(false);
  });

  it('a short run of digits is only a word, not a phone fragment', () => {
    expect(matchesQuery({ fields: ['963900000001'] }, '001')).toBe(true); // as text it is simply in there
    // «0 12» → bare «12»: shorter than four digits, never looked for in digit cells.
    expect(matchesQuery({ fields: ['+963 900 000 001'] }, '012')).toBe(false);
  });

  it('null, undefined and empty fields are skipped, not read as the text «null»', () => {
    expect(matchesQuery({ fields: [null, undefined, '', 'حماة'] }, 'null')).toBe(false);
    expect(matchesQuery({ fields: [null, undefined, '', 'حماة'] }, 'undefined')).toBe(false);
    expect(matchesQuery({ fields: [null, undefined, '', 'حماة'] }, 'حماة')).toBe(true);
  });
});
