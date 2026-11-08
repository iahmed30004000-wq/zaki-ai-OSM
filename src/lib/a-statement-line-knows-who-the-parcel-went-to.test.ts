import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { parseStatementRows } from './settlement';

/**
 * «العنوان والمحافظة ورقم الهاتف والحالة» — the owner, 8/11, on a real Basha statement.
 *
 * The raw row the import keeps is every cell joined by « | » with NO heading, so nothing downstream can say which cell
 * is the phone and which is the sender's city (BACKLOG RV762). The import reads the headings, so it writes the five
 * cells that say who the parcel went to — and only those, by whole heading.
 *
 * Every name, phone and address below is invented.
 */

// The headings of a Basha (Logestechs) collection statement, in the order the file writes them.
const BASHA_HEADER = [
  'باركود الشحنة', 'الكمية', 'رقم الإرسالية', 'باركود كشف التحصيل', 'إسم المرسل', 'إسم المتجر', 'مدينة المرسل',
  'منطقة المرسل', 'اسم المستلم', 'هاتف المستلم', 'عنوان المستلم', 'الملاحظات', 'طريقة الدفع', 'تاريخ الحجز',
  'تاريخ التصدير', 'مدينة المستلم', 'منطقة المستلم', 'التحصيل', 'اول مستلم للتحصيلات', 'السعر', 'اسم الزبون',
  'رقم الزبون', 'الصافي', 'الحالة',
];

const bashaRow = (over: Partial<Record<(typeof BASHA_HEADER)[number], string>> = {}): string[] => {
  const base: Record<string, string> = {
    'باركود الشحنة': '100000000001', 'الكمية': '1.0', 'رقم الإرسالية': '', 'باركود كشف التحصيل': '7440000000001',
    'إسم المرسل': 'متجر تجريبي', 'إسم المتجر': 'متجر تجريبي', 'مدينة المرسل': 'دمشق', 'منطقة المرسل': 'دمشق',
    'اسم المستلم': 'سلمى الاختبار', 'هاتف المستلم': '+963 900 000 001', 'عنوان المستلم': 'حماة - حي الوسط - بجانب الفرن',
    'الملاحظات': '20001 - اتصل قبل الوصول', 'طريقة الدفع': 'كاش', 'تاريخ الحجز': '46322.5', 'تاريخ التصدير': '46324.1',
    'مدينة المستلم': 'حماة', 'منطقة المستلم': 'حماة', 'التحصيل': '15.0', 'اول مستلم للتحصيلات': 'موظف',
    'السعر': '3.0', 'اسم الزبون': 'حساب التاجر', 'رقم الزبون': '', 'الصافي': '12.0', 'الحالة': 'تم توصيلها',
    ...over,
  };
  return BASHA_HEADER.map((h) => base[h] ?? '');
};

describe('the import writes who the parcel went to, by the file’s own headings', () => {
  it('a Basha row: name, phone, address, governorate and area come from the receiver’s columns', () => {
    const { rows, error } = parseStatementRows(BASHA_HEADER, [bashaRow()]);
    expect(error).toBeUndefined();
    expect(rows[0].receiver).toEqual({
      name: 'سلمى الاختبار',
      phone: '+963 900 000 001',
      address: 'حماة - حي الوسط - بجانب الفرن',
      city: 'حماة',
      area: 'حماة',
    });
  });

  it('the SENDER’s columns and the merchant’s own account name are never the receiver', () => {
    const { rows } = parseStatementRows(BASHA_HEADER, [
      bashaRow({ 'اسم المستلم': '', 'هاتف المستلم': '', 'مدينة المستلم': '', 'منطقة المستلم': '', 'عنوان المستلم': '' }),
    ]);
    // «إسم المرسل» / «مدينة المرسل» / «اسم الزبون» hold values on this row, and none of them leaks across.
    expect(rows[0].receiver).toEqual({ name: null, phone: null, address: null, city: null, area: null });
  });

  it('a heading that only CONTAINS «هاتف» is not the receiver’s phone: «هاتف المرسل» is the sender’s', () => {
    const header = ['باركود الشحنة', 'هاتف المرسل', 'الصافي'];
    const { rows } = parseStatementRows(header, [['100000000002', '0911111111', '10']]);
    expect(rows[0].receiver.phone).toBeNull();
  });

  it('an empty cell is null — never an empty string standing for «nobody wrote this»', () => {
    const { rows } = parseStatementRows(BASHA_HEADER, [bashaRow({ 'عنوان المستلم': '   ', 'منطقة المستلم': '' })]);
    expect(rows[0].receiver.address).toBeNull();
    expect(rows[0].receiver.area).toBeNull();
    expect(rows[0].receiver.city).toBe('حماة');
  });

  it('the spelling of «اسم» with the hamza under the alef is the same heading', () => {
    const header = ['باركود الشحنة', 'إسم المستلم', 'الصافي'];
    const { rows } = parseStatementRows(header, [['100000000003', 'ريما الاختبار', '10']]);
    expect(rows[0].receiver.name).toBe('ريما الاختبار');
  });

  it('English headings are read too (receiver_phone, address, city)', () => {
    const header = ['barcode', 'receiver_name', 'receiver_phone', 'address', 'city', 'net'];
    const { rows } = parseStatementRows(header, [['100000000004', 'Test Receiver', '0900000002', 'Street 1', 'Hama', '10']]);
    expect(rows[0].receiver).toEqual({ name: 'Test Receiver', phone: '0900000002', address: 'Street 1', city: 'Hama', area: null });
  });

  it('a file with none of these columns reads exactly as before: every piece null, the money untouched', () => {
    const { rows } = parseStatementRows(['المرجع', 'التحصيل', 'السعر'], [['ORD-1', '20', '3']]);
    expect(rows[0]).toMatchObject({ amount: 17, collected: 20, fee: 3, merchantRef: 'ORD-1' });
    expect(rows[0].receiver).toEqual({ name: null, phone: null, address: null, city: null, area: null });
  });

  it('a cell is a field, not a paragraph: an absurdly long address is cut, the raw row still holds what the company wrote', () => {
    const long = 'شارع '.repeat(200);
    const { rows } = parseStatementRows(BASHA_HEADER, [bashaRow({ 'عنوان المستلم': long })]);
    expect(rows[0].receiver.address!.length).toBe(300);
    expect(rows[0].rawRow.length).toBeLessThanOrEqual(500);
  });

  it('reading the receiver changes no figure: the same row parses to the same net, collected, fee and status', () => {
    const { rows, total } = parseStatementRows(BASHA_HEADER, [bashaRow()]);
    expect(rows[0]).toMatchObject({ amount: 12, collected: 15, fee: 3, status: 'تم توصيلها', merchantRef: '20001', barcode: '100000000001' });
    expect(total).toBe(12);
  });
});

describe('which column is the receiver’s — by how specific the heading is, never by which comes first', () => {
  it('a generic «الهاتف» before «هاتف المستلم» (the sender’s, say) does not win', () => {
    const header = ['باركود الشحنة', 'الهاتف', 'هاتف المستلم', 'الصافي'];
    const { rows } = parseStatementRows(header, [['100000000005', '0911111111', '0922222222', '10']]);
    expect(rows[0].receiver.phone).toBe('0922222222');
  });

  it('the same for the address and the city: «العنوان» and «المدينة» give way to the receiver’s own headings', () => {
    const header = ['باركود الشحنة', 'العنوان', 'المدينة', 'عنوان المستلم', 'مدينة المستلم', 'الصافي'];
    const { rows } = parseStatementRows(header, [['100000000006', 'عنوان المرسل', 'دمشق', 'عنوان الزبون الحقيقي', 'حماة', '10']]);
    expect(rows[0].receiver).toMatchObject({ address: 'عنوان الزبون الحقيقي', city: 'حماة' });
  });

  it('with only the generic heading the generic one is read — a file with nothing better is not left blind', () => {
    const { rows } = parseStatementRows(['باركود الشحنة', 'الهاتف', 'الصافي'], [['100000000007', '0933333333', '10']]);
    expect(rows[0].receiver.phone).toBe('0933333333');
  });

  it('«الزبون», «العميل» and customer_* are NOT the receiver: in a LogesTechs sheet they name the merchant', () => {
    const header = ['باركود الشحنة', 'اسم الزبون', 'اسم العميل', 'هاتف العميل', 'هاتف الزبون', 'عنوان العميل', 'عنوان الزبون', 'customer_name', 'customer_phone', 'customer_address', 'الصافي'];
    const { rows } = parseStatementRows(header, [['100000000008', 'حساب التاجر', 'حساب التاجر', '0900000009', '0900000009', 'مكتب التاجر', 'مكتب التاجر', 'Merchant', '0900000009', 'Office', '10']]);
    expect(rows[0].receiver).toEqual({ name: null, phone: null, address: null, city: null, area: null });
  });

  it('the money columns are still found by position, exactly as before — a receiver alias never moves them', () => {
    const header = ['الهاتف', 'باركود الشحنة', 'التحصيل', 'السعر', 'الصافي', 'الحالة'];
    const { rows } = parseStatementRows(header, [['0900000001', '100000000009', '15', '3', '12', 'تم توصيلها']]);
    expect(rows[0]).toMatchObject({ amount: 12, collected: 15, fee: 3, status: 'تم توصيلها', barcode: '100000000009' });
  });
});
