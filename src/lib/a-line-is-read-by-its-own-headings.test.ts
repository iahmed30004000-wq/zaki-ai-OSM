import { describe, expect, it } from 'vitest';
import { lineEssentials, phoneFromCell, phoneFromRawRow } from './statement-line-reading';

/**
 * «زر المطابقة عبر الهاتف مش شغال كأنو» — five lines of a real Basha statement carry a number of another country
 * («+353…», «00966…», «+218…»), and the button read only Syrian and Jordanian mobiles, so for those it said «ما في رقم
 * هاتف بسطر الشركة» about a row that has one.
 *
 * What these pin: a cell the company HEADED as a phone is read as a phone whatever country it is from; a row with no
 * heading still reads only what cannot be mistaken (a Syrian or Jordanian mobile, or a cell that is wholly a number
 * written with + or 00); and a Syrian mobile keeps exactly the keys it always had.
 *
 * Every number below is invented.
 */

describe('phoneFromCell — a cell headed as a phone', () => {
  it('a Syrian mobile keeps the keys it always had, in whatever form it is written', () => {
    for (const cell of ['+963 900 000 001', '0900000001', '900000001', '00963900000001', '+٩٦٣ ٩٠٠ ٠٠٠ ٠٠١']) {
      const p = phoneFromCell(cell, 'SY');
      expect(p, cell).toMatchObject({ shown: '0900000001', country: 'SY' });
      expect(p!.keys).toEqual(['900000001', '963900000001']);
    }
  });

  it('a foreign number written with + keeps its code: shown whole, keyed the way the address book stores it', () => {
    const p = phoneFromCell('+353 87 123 4567', 'SY');
    expect(p).toMatchObject({ shown: '+353871234567', country: 'OTHER' });
    expect(p!.keys).toContain('353871234567');
  });

  it('a number written with 00 is the same as with +; a code the table knows is also offered without it', () => {
    const p = phoneFromCell('00966 50 123 4567', 'SY');
    expect(p).toMatchObject({ shown: '+966501234567', country: 'OTHER' });
    // How a customer saved before the country code was kept is stored: the national number alone.
    expect(p!.keys).toEqual(expect.arrayContaining(['966501234567', '501234567']));
  });

  it('a Turkish line (the north of Syria runs on them) is a phone', () => {
    expect(phoneFromCell('+90 535 123 45 67', 'SY')).toMatchObject({ shown: '+905351234567', country: 'OTHER' });
    expect(phoneFromCell('0535 123 45 67', 'SY')).toMatchObject({ shown: '05351234567', country: 'OTHER' });
  });

  it('a whole foreign number is never read as a stretch of itself: «+353 78 123 4567» is not Jordan’s 078…', () => {
    const p = phoneFromCell('+353 78 123 4567', 'SY');
    expect(p).toMatchObject({ shown: '+353781234567', country: 'OTHER' });
  });

  it('a landline is a phone when its heading says so: the trunk zero goes, as the address book does it', () => {
    const p = phoneFromCell('011 2345678', 'SY');
    expect(p).toMatchObject({ shown: '0112345678', country: 'OTHER' });
    expect(p!.keys).toEqual(['112345678']);
  });

  it('two numbers in one cell: the first is the one read', () => {
    expect(phoneFromCell('0900000001 - 0900000002', 'SY')?.shown).toBe('0900000001');
    expect(phoneFromCell('+353 87 123 4567 / 0900000002', 'SY')?.shown).toBe('+353871234567');
  });

  it('what is no phone is no phone: words, a date serial, a short number, an empty cell', () => {
    for (const cell of ['لا يوجد', '46322.57921296296', '123456', '', '   ', null, undefined]) {
      expect(phoneFromCell(cell as string | null | undefined, 'SY'), String(cell)).toBeNull();
    }
  });

  it('the store’s own country is tried first for a number that fits both readings', () => {
    expect(phoneFromCell('0791234567', 'JO')).toMatchObject({ shown: '0791234567', country: 'JO' });
  });
});

describe('phoneFromRawRow — a row with no heading', () => {
  const row = (rawRow: string, over: { merchantRef?: string | null; barcode?: string | null } = {}) => ({
    rawRow, merchantRef: over.merchantRef ?? null, barcode: over.barcode ?? null,
  });

  it('a cell that is wholly a number written with + or 00 is read when the row has no Syrian or Jordanian mobile', () => {
    expect(phoneFromRawRow(row('100000000001 | 1.0 | +353 87 123 4567 | 46322.5'), 'SY')).toMatchObject({ shown: '+353871234567', country: 'OTHER' });
    expect(phoneFromRawRow(row('x | 00966 50 123 4567 | y'), 'SY')).toMatchObject({ shown: '+966501234567', country: 'OTHER' });
  });

  it('a Syrian or Jordanian mobile anywhere in the row still wins over a foreign cell that comes first', () => {
    expect(phoneFromRawRow(row('+353 87 123 4567 | 0900000001'), 'SY')).toMatchObject({ shown: '0900000001', country: 'SY' });
  });

  it('a number buried in a sentence is not read: only a cell that is wholly the number', () => {
    expect(phoneFromRawRow(row('اتصل على +353 87 123 4567 قبل الوصول'), 'SY')).toBeNull();
  });

  it('a date, a quantity, a plain long parcel number and the line’s own barcode are never a foreign phone', () => {
    expect(phoneFromRawRow(row('46322.57921296296 | 1.0 | 7440000000001 | 0.0'), 'SY')).toBeNull();
    expect(phoneFromRawRow(row('0012345678901 | note', { barcode: '0012345678901' }), 'SY')).toBeNull();
  });

  it('a Syrian or Jordanian code that is no mobile stays refused — it does not come back in as «foreign»', () => {
    expect(phoneFromRawRow(row('+962 71 123 4567'), 'SY')).toBeNull();
    expect(phoneFromRawRow(row('00963 11 2345678'), 'SY')).toBeNull();
  });
});

describe('lineEssentials — what the screen says about a company’s line', () => {
  const headed = {
    merchantRef: '20001', barcode: '100000000001', amount: 12, collected: 15, fee: 3, status: 'تم توصيلها',
    rawRow: '100000000001 | 20001 | 15 | 3 | 12 | تم توصيلها',
    receiverName: 'سلمى الاختبار', receiverPhone: '+353 87 123 4567', receiverAddress: 'حماة - حي الوسط',
    receiverCity: 'حماة', receiverArea: 'حماة',
  };

  it('reads status, phone, name, address and governorate from the company’s own columns', () => {
    const e = lineEssentials(headed, 'SY');
    expect(e).toMatchObject({
      status: 'تم توصيلها', name: 'سلمى الاختبار', address: 'حماة - حي الوسط', city: 'حماة', governorate: 'حماة', fromHeadings: true,
    });
    expect(e.phone).toMatchObject({ shown: '+353871234567', country: 'OTHER' });
  });

  it('the area is added to the governorate only when it says something more', () => {
    expect(lineEssentials({ ...headed, receiverCity: 'ريف دمشق', receiverArea: 'ضواحي دمشق' }, 'SY').governorate).toBe('ريف دمشق — ضواحي دمشق');
    expect(lineEssentials({ ...headed, receiverCity: 'ريف دمشق', receiverArea: ' ريف  دمشق ' }, 'SY').governorate).toBe('ريف دمشق');
    expect(lineEssentials({ ...headed, receiverCity: null, receiverArea: 'حماة' }, 'SY').governorate).toBe('حماة');
  });

  it('a phone column that holds no phone gives NO phone — the row is not searched for another number to put in its place', () => {
    const e = lineEssentials({ ...headed, receiverPhone: 'لا يوجد', rawRow: 'x | 0900000009 | y' }, 'SY');
    expect(e.phone).toBeNull();
  });

  it('a line imported before the columns were kept reads its phone from the raw row, as it always did, and knows nothing else', () => {
    const e = lineEssentials({ merchantRef: 'R1', barcode: 'B1', status: 'مؤجلة', rawRow: 'B1 | R1 | 0900000001 | مؤجلة' }, 'SY');
    expect(e).toMatchObject({ status: 'مؤجلة', name: null, address: null, city: null, area: null, governorate: null, fromHeadings: false });
    expect(e.phone).toMatchObject({ shown: '0900000001', country: 'SY' });
  });

  it('a file with an address column but no phone column falls back to the raw row for the phone only', () => {
    const e = lineEssentials({ merchantRef: 'R1', barcode: 'B1', status: null, rawRow: 'B1 | 0900000001', receiverAddress: 'حلب' }, 'SY');
    expect(e.fromHeadings).toBe(true);
    expect(e.address).toBe('حلب');
    expect(e.phone?.shown).toBe('0900000001');
  });

  it('nothing at all: every piece null, and not «from headings»', () => {
    const e = lineEssentials({ merchantRef: null, barcode: null, status: null, rawRow: null }, 'SY');
    expect(e).toEqual({ status: null, phone: null, name: null, address: null, city: null, area: null, governorate: null, fromHeadings: false });
  });
});

describe('a number written with its country code is one number: its tail is never read as a second one', () => {
  const row = (rawRow: string) => ({ rawRow, merchantRef: null, barcode: null });

  it('«+353 78 123 4567» is an Irish line in a row with no heading — not the Jordanian mobile 078…', () => {
    expect(phoneFromRawRow(row('x | +353 78 123 4567 | y'), 'SY')).toMatchObject({ shown: '+353781234567', country: 'OTHER' });
  });

  it('«+218 91 234 5678» is a Libyan line — not the Syrian mobile 091…', () => {
    expect(phoneFromRawRow(row('+218 91 234 5678'), 'SY')).toMatchObject({ shown: '+218912345678', country: 'OTHER' });
    expect(phoneFromRawRow(row('00218 91 234 5678'), 'SY')).toMatchObject({ shown: '+218912345678', country: 'OTHER' });
  });

  it('two numbers in one cell are still read from the first one: a number written with + keeps its own beginning', () => {
    expect(phoneFromCell('+963 900 000 001 - 0944111222', 'SY')?.shown).toBe('0900000001');
    expect(phoneFromRawRow(row('+963 900 000 001 - 0944111222'), 'SY')?.shown).toBe('0900000001');
  });

  it('a number WITHOUT a country code beside an amount is cut as before: «0933620102 - 25000»', () => {
    expect(phoneFromRawRow(row('0933620102 - 25000'), 'SY')?.shown).toBe('0933620102');
    expect(phoneFromRawRow(row('هاتف 0944111222 0933620102'), 'SY')?.shown).toBe('0944111222');
  });
});
