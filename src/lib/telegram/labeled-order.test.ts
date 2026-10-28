import { describe, expect, it } from 'vitest';
import { LABEL_TEXTS, placeOf, readLabeledOrder, readMessageColumns } from './labeled-order';

/**
 * THE READER OF THE OWNER'S NINE LABELS, ON ITS OWN — no database, no door.
 *
 * His example (28/10) is the fixture; each test changes one thing and says what that one thing must do.
 */

const SYRIA = { code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2 };
const store = { country: SYRIA, receivedAt: new Date('2026-10-28T14:45:40Z') };

const text = (over: Record<string, string | null> = {}, extra = '') =>
  [
    ['رقم الطلب', '26842'],
    ['تاريخ الطلب', '2026-10-28 17:45:32'],
    ['إسم العميل', 'محمد عيد أطليبي'],
    ['رقم الهاتف', '0933620102'],
    ['عنوان العميل', 'دمشق سوريا'],
    ['إسم المنتج', 'ماء الكمأ الأصلي'],
    ['إسم العرض', 'قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني'],
    ['السعر', '25'],
    ['الكمية', '1'],
  ]
    .filter(([label]) => over[label] !== null)
    .map(([label, value]) => `${label}: ${over[label] ?? value}`)
    .join('\n') + extra;

describe('his example', () => {
  it('is claimed and read, field by field — and the order number is not among them', () => {
    const r = readLabeledOrder(text(), store);
    expect(r).toMatchObject({ claimed: true, ok: true, place: 'دمشق', priceText: '25', quantity: 1 });
    if (!r.claimed || !r.ok) throw new Error('not read');
    expect(r.fields).toEqual({
      orderedAt: '2026-10-28 17:45:32',
      customer: 'محمد عيد أطليبي',
      phone: '0933620102',
      address: 'دمشق سوريا',
      product: 'ماء الكمأ الأصلي',
      offer: 'قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني',
      price: '25',
      quantity: '1',
    });
    expect(JSON.stringify(r)).not.toContain('26842');
  });

  it('is read without a store too: the same fields, no judgment that needs the store', () => {
    expect(readLabeledOrder(text({ 'تاريخ الطلب': '2026-01-01 10:00:00' }))).toMatchObject({ claimed: true, ok: true });
    expect(readLabeledOrder(text({ 'تاريخ الطلب': '2026-01-01 10:00:00' }), store)).toMatchObject({ ok: false, reason: 'SOURCE_TIME_OFF' });
  });

  it('the screen’s columns are the fields as written', () => {
    expect(readMessageColumns(text())).toEqual({
      claimed: true,
      orderedAt: '2026-10-28 17:45:32',
      customer: 'محمد عيد أطليبي',
      phone: '0933620102',
      address: 'دمشق سوريا',
      product: 'ماء الكمأ الأصلي',
      offer: 'قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني',
      price: '25',
      quantity: '1',
    });
    expect(readMessageColumns('سلام')).toEqual({ claimed: false });
  });

  it('and the nine labels are the ones he wrote, in his order', () => {
    expect(LABEL_TEXTS).toEqual(['رقم الطلب', 'تاريخ الطلب', 'إسم العميل', 'رقم الهاتف', 'عنوان العميل', 'إسم المنتج', 'إسم العرض', 'السعر', 'الكمية']);
  });
});

describe('what claims the format', () => {
  it('one label at the start of a line does not', () => {
    expect(readLabeledOrder('السعر: 25')).toEqual({ claimed: false });
  });

  it('two do — even with nothing else, and the rest is named missing', () => {
    expect(readLabeledOrder('السعر: 25\nالكمية: 1')).toMatchObject({ claimed: true, ok: false, reason: 'MISSING_ORDERED_AT' });
  });

  it('the same label twice is one label, not two', () => {
    expect(readLabeledOrder('السعر: 25\nالسعر: 30')).toEqual({ claimed: false });
  });

  it('a label inside a sentence is not at the start of a line', () => {
    expect(readLabeledOrder('ابعتلي رقم الهاتف: 0933620102 والسعر: 25')).toEqual({ claimed: false });
  });

  it('a colon is needed after the label', () => {
    expect(readLabeledOrder('السعر 25\nالكمية 1')).toEqual({ claimed: false });
  });
});

describe('labels are read by their spelling, not their letters', () => {
  it.each([
    ['اسم العميل', 'إسم العميل'],
    ['إسم  العميل', 'إسم العميل'],
    ['اِسْم العميل', 'إسم العميل'],
    ['الكميه', 'الكمية'],
    ['رقم الهاتف', 'رقم الهاتف'],
    ['عنوان العميل', 'عنوان العميل'],
  ])('«%s» is «%s»', (spelled) => {
    const r = readLabeledOrder(`${spelled}: قيمة\nالسعر: 25`);
    expect(r.claimed).toBe(true);
    // The label was recognised if it is no stray line and its value was taken.
    expect(r).not.toMatchObject({ reason: 'STRAY_LINE' });
  });

  it('wide colon, spaces around the colon, and a value that holds a colon itself', () => {
    const r = readLabeledOrder('تاريخ الطلب ： 2026-10-28 17:45:32\nالسعر :25');
    expect(r).toMatchObject({ claimed: true, ok: false, fields: { orderedAt: '2026-10-28 17:45:32', price: '25' } });
  });

  it('digits are read in either script, and the values come out Latin', () => {
    const r = readLabeledOrder(text({ 'رقم الهاتف': '٠٩٣٣٦٢٠١٠٢', 'الكمية': '٣', 'السعر': '٢٥٫٥' }), store);
    expect(r).toMatchObject({ ok: true, quantity: 3, priceText: '25.5' });
    if (r.claimed && r.ok) expect(r.fields.phone).toBe('0933620102');
  });
});

describe('what is refused, and by which name', () => {
  it.each([
    ['a label twice', `${text()}\nإسم المنتج: عسل`, 'REPEATED_PRODUCT'],
    ['the order number twice', `${text()}\nرقم الطلب: 1`, 'REPEATED_ORDER_NUMBER'],
    ['a required label empty', text({ 'رقم الهاتف': '' }), 'MISSING_PHONE'],
    ['a required label absent', text({ 'إسم العرض': null }), 'MISSING_OFFER_NAME'],
    ['the first missing one wins, in field order', text({ 'السعر': null, 'إسم العميل': null }), 'MISSING_CUSTOMER_NAME'],
    ['a stray line after a one-line field', `${text()}\nملاحظة`, 'STRAY_LINE'],
  ])('%s → %s', (_what, message, reason) => {
    expect(readLabeledOrder(message, store)).toMatchObject({ claimed: true, ok: false, reason });
  });

  it('the shape is judged before the values: a twice-label beats a bad date', () => {
    expect(readLabeledOrder(`${text({ 'تاريخ الطلب': 'غلط' })}\nالسعر: 30`, store)).toMatchObject({ reason: 'REPEATED_PRICE' });
  });

  it('an unreadable value never loses what was seen, so the screen can still draw it', () => {
    const r = readLabeledOrder(text({ 'الكمية': '0' }), store);
    expect(r).toMatchObject({ ok: false, reason: 'INVALID_QUANTITY', fields: { customer: 'محمد عيد أطليبي', quantity: '0' } });
  });
});

describe('the address', () => {
  it.each([
    ['دمشق سوريا', 'دمشق'],
    ['سوريا دمشق', 'دمشق'],
    ['سوريه، حلب', 'حلب'],
    ['سورية - ريف دمشق', 'ريف دمشق'],
    ['ريف دمشق سورية', 'ريف دمشق'],
    ['حماة', 'حماة'],
  ])('«%s» → place «%s»', (address, place) => {
    expect(placeOf(address, SYRIA)).toEqual({ place });
  });

  it.each(['الأردن عمان', 'عمان الأردن', 'مصر القاهرة', 'بيروت لبنان'])('«%s» names another country', (address) => {
    expect(placeOf(address, SYRIA)).toEqual({ refusal: 'COUNTRY_MISMATCH' });
  });

  it('and for a Jordanian store, Syria is the other country', () => {
    const jordan = { code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3 };
    expect(placeOf('عمان الأردن', jordan)).toEqual({ place: 'عمان' });
    expect(placeOf('دمشق سوريا', jordan)).toEqual({ refusal: 'COUNTRY_MISMATCH' });
  });
});

describe('the price', () => {
  it.each([
    ['25', '25'],
    ['25 $', '25'],
    ['$25', '25'],
    ['25 دولار', '25'],
    ['25.50', '25.50'],
    ['٢٥', '25'],
  ])('«%s» → %s', (price, priceText) => {
    expect(readLabeledOrder(text({ 'السعر': price }), store)).toMatchObject({ ok: true, priceText });
  });

  it.each(['25 د.أ', '25 ل.س', 'JOD 25'])('«%s» is another currency than the store’s', (price) => {
    expect(readLabeledOrder(text({ 'السعر': price }), store)).toMatchObject({ ok: false, reason: 'CURRENCY_MISMATCH' });
  });

  it.each(['', 'كثير', '25 و30', '1,000', '-5', '25 للقطعة', '2.555'])('«%s» is no price', (price) => {
    expect(readLabeledOrder(text({ 'السعر': price }), store)).toMatchObject({ ok: false });
  });
});
