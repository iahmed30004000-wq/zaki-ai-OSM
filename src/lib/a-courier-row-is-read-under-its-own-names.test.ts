import { describe, expect, it } from 'vitest';
import { phoneFromRawRow, readCourierRow, splitRawRow } from './statement-line-reading';

/**
 * «خانة سبب الشركة… البيانات تحتها منظمة الرقم الطلب و المبلغ» — and «بحث برقم الهاتف المرفق ياخد تلقائيا الرقم».
 *
 * The row is the cells the import joined with « | » and no header beside them. What these pin: the pieces the
 * import already parsed come out under their own names, every other cell the company wrote is kept (nothing is
 * dropped for being untidy), and the phone is a Syrian or Jordanian MOBILE read from a cell that is not the
 * reference or the barcode — never a parcel number, an amount or a date.
 */

describe('readCourierRow — the row under its own names', () => {
  it('a Basha-style row: barcode, our number, COD, fee, net, status, notes', () => {
    const r = readCourierRow({
      merchantRef: 'ORD-2026-1711',
      barcode: 'BSH-55012',
      amount: '23000',
      collected: '25000',
      fee: '2000',
      status: 'مؤجل',
      rawRow: 'BSH-55012 | ORD-2026-1711 | 25000 | 2000 | 23000 | مؤجل | العميل طلب التأجيل للأسبوع الجاي',
    });
    expect(r).toMatchObject({ orderRef: 'ORD-2026-1711', barcode: 'BSH-55012', amount: 23000, collected: 25000, fee: 2000, status: 'مؤجل' });
    expect(r.rest).toEqual(['العميل طلب التأجيل للأسبوع الجاي']);
    expect(r.raw).toContain('BSH-55012 | ORD-2026-1711');
  });

  it('a notes-only courier: the reference read from the notes, the notes cell itself kept as the reason', () => {
    const r = readCourierRow({
      merchantRef: '15132',
      barcode: null,
      amount: 0,
      collected: null,
      fee: null,
      status: null,
      rawRow: '2026-10-28 | سارة أحمد | 0933620102 |  | 15132 - العميل طلب التأجيل',
    });
    expect(r.orderRef).toBe('15132');
    expect(r.amount).toBe(0);
    // The date, the name, the phone and the notes are the company's words: kept, in order. The empty cell is not.
    expect(r.rest).toEqual(['2026-10-28', 'سارة أحمد', '0933620102', '15132 - العميل طلب التأجيل']);
  });

  it('a deduction written in brackets is the amount, not a note; Arabic digits are figures too', () => {
    const r = readCourierRow({
      merchantRef: null, barcode: 'AWB-9', amount: -50, collected: null, fee: '3000.000', status: 'مرتجع',
      rawRow: 'AWB-9 | (50) | ٣٠٠٠ | مرتجع | رفض الاستلام',
    });
    expect(r.amount).toBe(-50);
    expect(r.fee).toBe(3000);
    expect(r.rest).toEqual(['رفض الاستلام']);
  });

  it('a figure that equals none of the amounts stays — it may be a quantity or a code the company meant', () => {
    const r = readCourierRow({ merchantRef: 'R1', barcode: null, amount: 20, status: null, rawRow: 'R1 | 20 | 3 | 17.505' });
    expect(r.rest).toEqual(['3', '17.505']);
  });

  it('case and spaces do not make the reference a note', () => {
    const r = readCourierRow({ merchantRef: 'ord-9', barcode: null, amount: 1, status: 'DELIVERED', rawRow: '  ORD-9  | delivered | 1' });
    expect(r.rest).toEqual([]);
  });

  it('a line with no row at all: no pieces invented, no raw', () => {
    const r = readCourierRow({ merchantRef: null, barcode: null, amount: null, status: null, rawRow: null });
    expect(r).toMatchObject({ orderRef: null, barcode: null, amount: null, collected: null, fee: null, status: null, rest: [], raw: null });
  });

  it('splitRawRow splits on the import’s own separator only, so a dash inside a note stays one cell', () => {
    expect(splitRawRow('a | b - c | d')).toEqual(['a', 'b - c', 'd']);
    expect(splitRawRow(null)).toEqual([]);
  });
});

describe('phoneFromRawRow — the customer’s mobile in the row', () => {
  const row = (rawRow: string, over: { merchantRef?: string | null; barcode?: string | null } = {}) => ({
    rawRow, merchantRef: over.merchantRef ?? null, barcode: over.barcode ?? null,
  });

  it.each([
    ['0933620102', '0933620102'],
    ['933620102', '0933620102'],
    ['+963 933 620 102', '0933620102'],
    ['00963933620102', '0933620102'],
    ['963933620102', '0933620102'],
    ['٠٩٣٣٦٢٠١٠٢', '0933620102'],
    ['0933-620-102', '0933620102'],
  ])('Syrian mobile written %s → %s', (cell, shown) => {
    const p = phoneFromRawRow(row(`X-1 | ${cell} | 25000`), 'SY');
    expect(p).toMatchObject({ shown, country: 'SY' });
    expect(p!.keys).toEqual(['933620102', '963933620102']);
  });

  it.each([
    ['0791234567', '0791234567'],
    ['+962 79 123 4567', '0791234567'],
    ['00962781234567', '0781234567'],
  ])('Jordanian mobile written %s → %s', (cell, shown) => {
    const p = phoneFromRawRow(row(`${cell}`), 'JO');
    expect(p).toMatchObject({ shown, country: 'JO' });
  });

  it('a Jordanian line in a Syrian store keeps both forms a customer of it may be stored in', () => {
    const p = phoneFromRawRow(row('سارة | 0791234567'), 'SY');
    expect(p).toMatchObject({ shown: '0791234567', country: 'JO' });
    expect(p!.keys).toEqual(['791234567', '962791234567']);
  });

  it('a phone written beside an amount in one cell is still found', () => {
    expect(phoneFromRawRow(row('0933620102 - 25000'), 'SY')?.shown).toBe('0933620102');
    expect(phoneFromRawRow(row('هاتف 0944111222 0933620102'), 'SY')?.shown).toBe('0944111222');
  });

  it('a barcode or a reference cell that LOOKS like a mobile is never read as one', () => {
    expect(phoneFromRawRow(row('0933620102 | 25000', { barcode: '0933620102' }), 'SY')).toBeNull();
    expect(phoneFromRawRow(row('0933620102 | 25000', { merchantRef: '0933620102' }), 'SY')).toBeNull();
  });

  it('amounts, dates, landlines and long parcel numbers are not mobiles', () => {
    expect(phoneFromRawRow(row('25000 | 2026-10-28 | 011 2345678 | 1234567890123'), 'SY')).toBeNull();
    expect(phoneFromRawRow(row('064123456'), 'JO')).toBeNull();
  });

  it('no row, no phone', () => {
    expect(phoneFromRawRow({ rawRow: null, merchantRef: null, barcode: null }, 'SY')).toBeNull();
  });

  it('the first mobile in the row is the one read', () => {
    expect(phoneFromRawRow(row('0944111222 | 0933620102'), 'SY')?.shown).toBe('0944111222');
  });
});
