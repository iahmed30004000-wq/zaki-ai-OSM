import { describe, expect, it } from 'vitest';
import {
  extractPhone,
  parseTelegramOrderMessage,
  readLineRoleOrder,
  readMessageColumns,
  type LineRoleStore,
} from './parser';

/**
 * THE TELEGRAM READER — WHAT IT READ BEFORE, AND HIS SEVEN LINES.
 *
 * Nothing ran `parseTelegramOrderMessage` before this file: the guards only read its source. So the first block pins what
 * the labeled and one-line readings ARE, measured against the parser of the production commit (07c2451c) before the
 * seven-line reader was added beside it — a message with labels must read the same tomorrow as it did yesterday.
 *
 * Then the one change to that path (T9: a phone never runs across a line), and then his format, line by line.
 */

// The owner's own sample, 28/10, exactly as he typed it.
const SAMPLE = ['26818', '2026-10-28 15:40:01', 'محمد', '0932323642', 'سوريا حماه', 'ماء الكمأ الأصلي', 'القطعة ب 15 $ + توصيل مجاني'];
const lines = (...l: string[]) => l.join('\n');
const sample = (over: Partial<Record<number, string>> = {}) => lines(...SAMPLE.map((l, i) => over[i + 1] ?? l));

/** A Syrian store priced in dollars, the message arriving at 15:40 Damascus (12:40 UTC). */
const SYRIA: LineRoleStore = {
  country: { code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2 },
  receivedAt: new Date('2026-10-28T12:40:05Z'),
};
const withCurrency = (currencyCode: string, minorUnit = 2): LineRoleStore => ({
  ...SYRIA,
  country: { ...SYRIA.country, currencyCode, minorUnit },
});

/** The refusal a reading gave, or 'ok'. */
const verdict = (text: string, store: LineRoleStore = SYRIA) => {
  const r = readLineRoleOrder(text, store);
  if (!r.claimed) return 'not-claimed';
  return r.ok ? 'ok' : r.reason;
};
const offerOf = (line7: string, store: LineRoleStore = SYRIA) => {
  const r = readLineRoleOrder(sample({ 7: line7 }), store);
  return r.claimed && r.ok ? r.offer : r.claimed ? r.reason : 'not-claimed';
};

describe('today’s labeled and one-line reading — pinned against the production parser', () => {
  it('the labeled example of docs/telegram.md reads as it always did', () => {
    const r = parseTelegramOrderMessage(
      lines('طلب جديد', 'الاسم: أحمد', 'الهاتف: 0933444555', 'العنوان: عرفات', 'المنتج: ماء الكمأ', 'الكمية: 2')
    );
    expect(r).toMatchObject({
      isOrder: true,
      customerName: 'أحمد',
      phone: '0933444555',
      address: 'عرفات',
      productText: 'ماء الكمأ',
      quantity: 2,
    });
    expect(r.priceText).toBeUndefined();
    expect(r.governorate).toBeUndefined();
  });

  it('every label it knows, an Arabic-keypad quantity included', () => {
    const r = parseTelegramOrderMessage(
      lines(
        'الاسم: محمد علي',
        'رقم الهاتف: 0991234567',
        'المحافظة: حماة',
        'العنوان: حي الشريعة',
        'المنتج: ماء الكمأ الأصلي',
        'الكمية: ٣',
        'السعر: 45 دولار',
        'ملاحظات: بعد العصر',
        'الصفحة: صفحة الأعشاب'
      )
    );
    expect(r).toMatchObject({
      isOrder: true,
      customerName: 'محمد علي',
      phone: '0991234567',
      governorate: 'حماة',
      address: 'حي الشريعة',
      productText: 'ماء الكمأ الأصلي',
      quantity: 3,
      priceText: '45 دولار',
      notes: 'بعد العصر',
      pageName: 'صفحة الأعشاب',
    });
  });

  it('labels split by ؛ on one line read the same', () => {
    expect(parseTelegramOrderMessage('الاسم: سامر؛ الهاتف: 0933444555؛ المنتج: عسل')).toMatchObject({
      isOrder: true,
      customerName: 'سامر',
      phone: '0933444555',
      productText: 'عسل',
    });
  });

  it('a phone typed on an Arabic keypad behind a label is still found', () => {
    expect(parseTelegramOrderMessage(lines('الاسم: سامر', 'الهاتف: ٠٩٣٢٣٢٣٦٤٢', 'المنتج: عسل')).phone).toBe('0932323642');
  });

  it('a stated quantity wins over a unit word lower down', () => {
    expect(parseTelegramOrderMessage(lines('المنتج: عسل', 'الكمية: 2', '3 علب')).quantity).toBe(2);
  });

  it('a negative price and an empty notes label are kept as written, for the validators to judge', () => {
    const r = parseTelegramOrderMessage(lines('الاسم: سامر', 'الهاتف: 0933444555', 'المنتج: عسل', 'السعر: -5', 'الملاحظات:'));
    expect(r.priceText).toBe('-5');
    expect(r.notes).toBe('');
  });

  it('the one-line form: the name before the phone, the first small number after it the quantity', () => {
    expect(parseTelegramOrderMessage('أحمد 0933444555 عرفات 2 ريان')).toMatchObject({
      isOrder: true,
      customerName: 'أحمد',
      phone: '0933444555',
      quantity: 2,
      address: 'عرفات ريان',
    });
  });

  it('a greeting or a question is not an order', () => {
    expect(parseTelegramOrderMessage('السلام عليكم، وين طلبي؟')).toEqual({ isOrder: false, confidence: 0 });
    expect(parseTelegramOrderMessage('كم سعر العسل؟')).toEqual({ isOrder: false, confidence: 0 });
    expect(parseTelegramOrderMessage('   ')).toEqual({ isOrder: false, confidence: 0 });
  });
});

describe('T9 — a phone never runs across a line, and a date is never a phone', () => {
  it('his sample no longer yields the glued 268182026102815', () => {
    expect(extractPhone(sample())).toBe('0932323642');
    expect(parseTelegramOrderMessage(sample()).phone).toBe('0932323642');
  });

  it('a line that is only a date or a time is skipped', () => {
    expect(extractPhone('2026-10-28')).toBeNull();
    expect(extractPhone('2026-10-28 15:40:01')).toBeNull();
  });

  it('two short runs on two lines are two runs, not one phone', () => {
    // The whole-text search read «12345⏎678 9» as the nine-digit 123456789.
    expect(extractPhone(lines('الطلب 12345', '678 9'))).toBeNull();
  });

  it('a phone on one line is read whole, with its spaces and dashes', () => {
    expect(extractPhone('+963 932-323-642')).toBe('963932323642');
  });
});

describe('his seven lines — the sample, field by field', () => {
  it('— is claimed, and every line lands in its role', () => {
    const r = readLineRoleOrder(sample(), SYRIA);
    expect(r).toEqual({
      claimed: true,
      ok: true,
      lineCount: 7,
      lines: {
        ref: '26818',
        orderedAt: '2026-10-28 15:40:01',
        customer: 'محمد',
        phone: '0932323642',
        governorate: 'سوريا حماه',
        product: 'ماء الكمأ الأصلي',
        offer: 'القطعة ب 15 $ + توصيل مجاني',
      },
      place: 'حماه',
      offer: { quantity: 1, priceText: '15', currency: 'USD', deliveryIncluded: true },
    });
  });

  it('— the old reader, given the same text, cannot read it: no product, and a «name» glued from three lines', () => {
    // Why his format is claimed BEFORE the old reader runs: its one-line fallback takes everything above the phone as
    // the name, and it never finds a product — so it could only ever end in review.
    const old = parseTelegramOrderMessage(sample());
    expect(old.productText).toBeUndefined();
    expect(old.customerName).toBe('26818\n2026-10-28 15:40:01\nمحمد');
  });

  it('— Arabic-Indic digits and direction marks read the same', () => {
    const typed = lines(
      '‏٢٦٨١٨',
      '٢٠٢٦-١٠-٢٨ ١٥:٤٠:٠١‎',
      'محمد',
      '‫٠٩٣٢٣٢٣٦٤٢‬',
      'سوريا حماه',
      'ماء الكمأ الأصلي',
      'القطعة ب ١٥ $ + توصيل مجاني'
    );
    expect(readLineRoleOrder(typed, SYRIA)).toEqual(readLineRoleOrder(sample(), SYRIA));
  });

  it('— a blank line between two lines, and Windows line ends, change nothing', () => {
    const spaced = SAMPLE.slice(0, 3).join('\r\n') + '\r\n\r\n   \r\n' + SAMPLE.slice(3).join('\r\n');
    expect(readLineRoleOrder(spaced, SYRIA)).toEqual(readLineRoleOrder(sample(), SYRIA));
  });
});

describe('which messages are his — and which keep the path they had', () => {
  it('a labeled message is never claimed, however many lines it has', () => {
    expect(readLineRoleOrder(lines('طلب جديد', 'الاسم: أحمد', 'الهاتف: 0933444555', 'العنوان: عرفات', 'المنتج: عسل', 'الكمية: 2')).claimed).toBe(false);
    // One label among his seven lines is enough: the labels win.
    expect(readLineRoleOrder(sample({ 3: 'الاسم: محمد' })).claimed).toBe(false);
    expect(readLineRoleOrder(sample({ 7: 'السعر: القطعة ب 15 $' })).claimed).toBe(false);
  });

  it('a one-line message, or one with no date near the top, is never claimed', () => {
    expect(readLineRoleOrder('أحمد 0933444555 عرفات 2 ريان').claimed).toBe(false);
    expect(readLineRoleOrder(lines('26818', 'محمد', 'خالد', '0932323642', 'سوريا حماه', 'ماء الكمأ الأصلي', 'القطعة ب 15 $')).claimed).toBe(false);
  });

  it('fewer than five lines is not his shape either', () => {
    expect(readLineRoleOrder(lines('2026-10-28 15:40:01', 'محمد', '0932323642', 'حماه')).claimed).toBe(false);
  });

  it('a claimed message is never IGNORED-shaped: chit-chat words do not let it out', () => {
    expect(verdict(sample({ 3: 'مرحبا شكرا' }))).toBe('ok');
  });
});

describe('the edge cases, each to its own answer', () => {
  it('six lines (no reference) or eight → LINE_COUNT, with the count and only the date', () => {
    const six = readLineRoleOrder(lines(...SAMPLE.slice(1)), SYRIA);
    expect(six).toMatchObject({ claimed: true, ok: false, reason: 'LINE_COUNT', lineCount: 6, lines: { orderedAt: '2026-10-28 15:40:01' } });
    const eight = readLineRoleOrder(lines(...SAMPLE, 'شكراً'), SYRIA);
    expect(eight).toMatchObject({ ok: false, reason: 'LINE_COUNT', lineCount: 8 });
    expect(eight.claimed && eight.lines.customer).toBeUndefined();
  });

  it('line 2: no real date → BAD_DATE; a date far from the message → SOURCE_TIME_OFF', () => {
    expect(verdict(sample({ 2: '2026-13-40 15:40:01' }))).toBe('BAD_DATE');
    expect(verdict(lines('2026-10-28', '26818', ...SAMPLE.slice(2)))).toBe('BAD_DATE');
    expect(verdict(sample(), { ...SYRIA, receivedAt: new Date('2026-11-06T12:00:00Z') })).toBe('SOURCE_TIME_OFF');
    expect(verdict(sample(), { ...SYRIA, receivedAt: new Date('2026-10-26T12:00:00Z') })).toBe('SOURCE_TIME_OFF');
    // Within the week before and the day after, any time zone of his tool reads true.
    expect(verdict(sample(), { ...SYRIA, receivedAt: new Date('2026-11-03T12:00:00Z') })).toBe('ok');
    expect(verdict(sample({ 2: '2026-10-28' }))).toBe('ok');
  });

  it('line 3: a digit, or a single letter, is not a name', () => {
    expect(verdict(sample({ 3: 'محمد 2' }))).toBe('MISSING_CUSTOMER_NAME');
    expect(verdict(sample({ 3: 'م' }))).toBe('MISSING_CUSTOMER_NAME');
  });

  it('line 4: only a phone, and a phone by the store’s own rule', () => {
    expect(verdict(sample({ 4: '0932-ABC' }))).toBe('INVALID_PHONE');
    expect(verdict(sample({ 4: '0912345' }))).toBe('INVALID_PHONE');
    expect(verdict(sample({ 4: '+963 932 323 642' }))).toBe('ok');
    // A Jordanian number on a Jordanian store passes; the same digits are not a Syrian mobile.
    const jordan: LineRoleStore = { ...SYRIA, country: { code: 'JO', name: 'الأردن', currencyCode: 'USD', minorUnit: 2 } };
    expect(verdict(sample({ 4: '0791234567', 5: 'عمان' }), jordan)).toBe('ok');
    expect(verdict(sample({ 4: '0791234', 5: 'عمان' }), jordan)).toBe('INVALID_PHONE');
  });

  it('line 5: the store’s own country is dropped, another country is refused, nothing left is refused', () => {
    const placeOf = (line5: string) => {
      const r = readLineRoleOrder(sample({ 5: line5 }), SYRIA);
      return r.claimed && r.ok ? r.place : r.claimed ? r.reason : 'not-claimed';
    };
    expect(placeOf('سوريا حماه')).toBe('حماه');
    expect(placeOf('سورية - حماة')).toBe('حماة');
    expect(placeOf('سوريه، حماه السقيلبية')).toBe('حماه السقيلبية');
    expect(placeOf('حماه')).toBe('حماه');
    expect(placeOf('الأردن عمان')).toBe('COUNTRY_MISMATCH');
    expect(placeOf('الاردن - عمان')).toBe('COUNTRY_MISMATCH');
    expect(placeOf('سوريا')).toBe('MISSING_ADDRESS');
  });

  it('line 7: one piece, two, or N — and the number is the TOTAL for them, never multiplied', () => {
    expect(offerOf('القطعة ب 15 $')).toEqual({ quantity: 1, priceText: '15', currency: 'USD', deliveryIncluded: false });
    expect(offerOf('القطعتين ب 25 $')).toEqual({ quantity: 2, priceText: '25', currency: 'USD', deliveryIncluded: false });
    expect(offerOf('3 قطع ب 40 $')).toEqual({ quantity: 3, priceText: '40', currency: 'USD', deliveryIncluded: false });
    expect(offerOf('قطعة واحدة بسعر 15 دولار')).toMatchObject({ quantity: 1, priceText: '15', currency: 'USD' });
    expect(offerOf('القطعه بـ15$+توصيل مجاني')).toEqual({ quantity: 1, priceText: '15', currency: 'USD', deliveryIncluded: true });
    expect(offerOf('حبتين $25')).toMatchObject({ quantity: 2, priceText: '25', currency: 'USD' });
  });

  it('line 7: the words that put delivery in the price, and only those', () => {
    for (const free of ['+ توصيل مجاني', 'والتوصيل مجاني', 'مع التوصيل مجاني', 'شامل التوصيل']) {
      expect(offerOf(`القطعة ب 15 $ ${free}`), free).toMatchObject({ deliveryIncluded: true });
    }
    expect(offerOf('القطعة ب 15 $')).toMatchObject({ deliveryIncluded: false });
  });

  it('line 7: a fee written beside «توصيل» is the region table’s, not the message’s', () => {
    expect(offerOf('القطعة ب 15 $ + 3 $ توصيل')).toBe('DELIVERY_FEE_STATED');
    expect(offerOf('القطعة ب 15 $ + توصيل 3 $')).toBe('DELIVERY_FEE_STATED');
    expect(offerOf('القطعة ب 15 $ مع التوصيل بسعر 3')).toBe('DELIVERY_FEE_STATED');
  });

  it('line 7: what is not read whole is refused — never guessed', () => {
    expect(offerOf('القطعة ب 15,000 ل.س', withCurrency('SYP'))).toBe('OFFER_UNREADABLE');
    expect(offerOf('القطعة ب 15٬000 ل.س', withCurrency('SYP'))).toBe('OFFER_UNREADABLE');
    expect(offerOf('ب 15 $')).toBe('OFFER_UNREADABLE');
    expect(offerOf('القطعة ب 15 $ و 20 $')).toBe('OFFER_UNREADABLE');
    expect(offerOf('القطعتين والقطعة ب 15')).toBe('OFFER_UNREADABLE');
    expect(offerOf('القطعة ب 15 $ + توصيل')).toBe('OFFER_UNREADABLE');
    expect(offerOf('القطعة ب 15.555 $')).toBe('OFFER_UNREADABLE');
  });

  it('line 7: no figure is MISSING_PRICE; a count out of range is INVALID_QUANTITY; a gift waits for an offer', () => {
    expect(offerOf('القطعة ب $')).toBe('MISSING_PRICE');
    expect(offerOf('القطعتين')).toBe('MISSING_PRICE');
    expect(offerOf('0 قطع ب 15 $')).toBe('INVALID_QUANTITY');
    expect(offerOf('5000 قطع ب 15 $')).toBe('INVALID_QUANTITY');
    expect(offerOf('3 قطع + 1 هدية ب 25 $')).toBe('GIFT_NEEDS_OFFER');
  });

  it('line 7: the currency is compared with the store’s and never converted; none named is the store’s', () => {
    expect(offerOf('القطعة ب 150000 ل.س')).toBe('CURRENCY_MISMATCH');
    expect(offerOf('القطعة ب 150000 ل.س', withCurrency('SYP'))).toMatchObject({ priceText: '150000', currency: 'SYP' });
    expect(offerOf('القطعة ب 15 د.أ')).toBe('CURRENCY_MISMATCH');
    expect(offerOf('القطعة ب 15 دينار', withCurrency('JOD', 3))).toMatchObject({ currency: 'JOD' });
    expect(offerOf('القطعة ب 15 ليرة', withCurrency('SYP'))).toMatchObject({ currency: 'SYP' });
    expect(offerOf('القطعة ب 15', withCurrency('SYP'))).toMatchObject({ priceText: '15', currency: null });
  });

  it('line 7: the decimals are the store currency’s — three for a dinar, two for a dollar', () => {
    expect(offerOf('القطعتين ب 14.250 د.أ', withCurrency('JOD', 3))).toMatchObject({ quantity: 2, priceText: '14.250', currency: 'JOD' });
    expect(offerOf('القطعتين ب 14.2555 د.أ', withCurrency('JOD', 3))).toBe('OFFER_UNREADABLE');
    expect(offerOf('القطعة ب ١٥٫٥ $')).toMatchObject({ priceText: '15.5' });
  });

  it('the first failing line is the one named, in line order', () => {
    // Line 4 and line 7 both wrong: line 4 is said.
    expect(verdict(sample({ 4: 'غلط', 7: 'غلط' }))).toBe('INVALID_PHONE');
    // Lines 4 and 5 swapped: the place is read as a phone first, and refused.
    expect(verdict(sample({ 4: SAMPLE[4], 5: SAMPLE[3] }))).toBe('INVALID_PHONE');
  });
});

describe('the columns the screen draws', () => {
  it('his format: the seven lines as written', () => {
    expect(readMessageColumns(sample())).toEqual({
      format: 'lines',
      lineCount: 7,
      orderedAt: '2026-10-28 15:40:01',
      customer: 'محمد',
      phone: '0932323642',
      governorate: 'سوريا حماه',
      product: 'ماء الكمأ الأصلي',
      offer: 'القطعة ب 15 $ + توصيل مجاني',
    });
  });

  it('a labeled message fills the same columns from its labels', () => {
    expect(
      readMessageColumns(lines('الاسم: سامر', 'الهاتف: 0933444555', 'المحافظة: حلب', 'المنتج: عسل', 'السعر: 20 $'))
    ).toEqual({ format: 'labels', customer: 'سامر', phone: '0933444555', governorate: 'حلب', product: 'عسل', offer: '20 $' });
  });

  it('chit-chat fills nothing', () => {
    expect(readMessageColumns('شكراً وصل الطلب')).toEqual({ format: 'none' });
  });
});
