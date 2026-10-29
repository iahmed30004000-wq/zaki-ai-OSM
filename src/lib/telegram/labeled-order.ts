import { toLatinDigits } from '../latin-digits';
import { normalizeArabic } from '../order-parser';
import { sameArabicName } from '../address';
import {
  BIDI_MARKS,
  COUNTRY_WORDS,
  CURRENCY_WORDS,
  PLACE_GAP,
  PLACE_WORD,
  SOURCE_TIME_AFTER_MS,
  SOURCE_TIME_BEFORE_MS,
  isCustomerName,
  sourceTime,
} from './parser';
import { readPhoneText, type PhoneReading } from './phone-text';

/**
 * THE ONLY MESSAGE THAT BECOMES AN ORDER — NINE LABELS, ONE PER LINE.
 *
 * The owner, 28/10: «أريده يسحب الطلبات بهذه الصيغة … هذه نصوص تكون ثابتة واي شيء بعدها يتخزن بالخانة المناسبة كطلب جديد
 * … ولازم يكون مكتوب بهذي الصيغة عشان يرتفع كطلب جديد»:
 *
 *     رقم الطلب · تاريخ الطلب · إسم العميل · رقم الهاتف · عنوان العميل · إسم المنتج · إسم العرض · السعر · الكمية
 *
 * and then: «تجاهل رقم الطلب لانه مش مهم عندنا ولا تحطو». So «رقم الطلب» is read and DROPPED: it is not a field of the
 * result, it is never stored, never compared and never shown, and a message without it is still an order.
 *
 * PURE. No I/O and no model — the text a seller pastes carries a customer's name, phone and address.
 *
 * ── WHAT «CLAIMS THE FORMAT» MEANS ──
 * A message claims it when TWO of the nine labels stand at the start of a line. A claimed message is read by these rules
 * and by no other: if a line is wrong it is refused, with the field named, and it is never quietly read as something
 * else (and never ignored). A message that does not claim it is not an order.
 *
 * ── WHAT THE MONEY IS ──
 * «السعر» is the TOTAL of the order and «الكمية» is the number of PIECES of the product (the owner: «الكمية يعني قطعتين
 * فقط ولا تربطها بالعرض بل اربطها بقطع المنتج نفسو»). «إسم العرض» names one of the product's offers — the door binds it
 * (`offer-text.ts`); this reader only hands the text over. Whatever the price and the quantity mean for the money is the
 * door's and `createTelegramOrder`'s.
 *
 * «رقم الهاتف» is read leniently (`phone-text.ts`): every way of writing the Syrian code, every script of digits, two
 * numbers in a line. A message is never refused for the SHAPE of its phone; a number that still fails the store country's
 * rule is still taken when it has `MIN_PHONE_DIGITS` digits (the owner, 29/10: «يقبل كل الارقام»); a stub like «12» is
 * `INVALID_PHONE` and waits for a person, and a value with no digit is `MISSING_PHONE`.
 *
 * «عنوان العميل» is taken whole, whatever it says (the owner, 29/10: «يقبل كل العناوين … طلبات تنزل باسم سوريا بس»): the
 * store's own country word is dropped when something else is left, and kept when it is all there is; another country's word
 * is no refusal either — the address stays as written and the confirmation call decides.
 */

/** The eight fields an order is made from, in the order the door judges them. */
export const LABELED_FIELDS = ['orderedAt', 'customer', 'phone', 'address', 'product', 'offer', 'price', 'quantity'] as const;
export type LabeledField = (typeof LABELED_FIELDS)[number];

/** The nine labels as the owner writes them. `null` is the order number: read, and dropped. */
const LABELS: ReadonlyArray<{ field: LabeledField | null; label: string }> = [
  { field: null, label: 'رقم الطلب' },
  { field: 'orderedAt', label: 'تاريخ الطلب' },
  { field: 'customer', label: 'إسم العميل' },
  { field: 'phone', label: 'رقم الهاتف' },
  { field: 'address', label: 'عنوان العميل' },
  { field: 'product', label: 'إسم المنتج' },
  { field: 'offer', label: 'إسم العرض' },
  { field: 'price', label: 'السعر' },
  { field: 'quantity', label: 'الكمية' },
];

/** A label compared without its spelling: أ إ آ → ا, ى → ي, ة → ه, no marks, no stretching, single spaces. */
function foldLabel(text: string): string {
  return normalizeArabic(text).replace(/\s+/g, ' ').trim();
}
const FOLDED = new Map(LABELS.map((l) => [foldLabel(l.label), l.field]));

/** The labels' own text, for the screen's one-line rule. */
export const LABEL_TEXTS = LABELS.map((l) => l.label);

/** What each of the eight fields is called by the label the seller writes — the dialog's own words. */
export const LABEL_OF = Object.fromEntries(LABELS.filter((l) => l.field).map((l) => [l.field, l.label])) as Record<LabeledField, string>;

/**
 * THE EIGHT FIELDS BACK INTO A MESSAGE — what «تعديل وترحيل» stores when a person corrects a held message by hand.
 *
 * One line per label, in the owner's order and without the order number (which is dropped anyway), each value on ONE line
 * (a person typed it into a box; a line break in it would be a stray line). The result is read by `readLabeledOrder`
 * like any message, so a corrected message goes through every rule a sent one does: nothing a person types here skips the
 * offer, the price, the duplicate or the blacklist.
 */
export function labeledText(fields: LabeledFields): string {
  return LABELS.filter((l) => l.field)
    .map((l) => `${l.label}: ${String(fields[l.field as LabeledField] ?? '').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

/** Why a claimed message is refused. Each has its Arabic sentence, and its field, in `review-reasons.ts`. */
export type LabeledRefusal =
  | 'REPEATED_ORDER_NUMBER'
  | 'REPEATED_ORDERED_AT'
  | 'REPEATED_CUSTOMER_NAME'
  | 'REPEATED_PHONE'
  | 'REPEATED_ADDRESS'
  | 'REPEATED_PRODUCT'
  | 'REPEATED_OFFER_NAME'
  | 'REPEATED_PRICE'
  | 'REPEATED_QUANTITY'
  | 'STRAY_LINE'
  | 'MISSING_ORDERED_AT'
  | 'MISSING_CUSTOMER_NAME'
  | 'MISSING_PHONE'
  | 'MISSING_ADDRESS'
  | 'MISSING_PRODUCT'
  | 'MISSING_OFFER_NAME'
  | 'MISSING_PRICE'
  | 'MISSING_QUANTITY'
  | 'BAD_DATE'
  | 'SOURCE_TIME_OFF'
  | 'INVALID_CUSTOMER_NAME'
  | 'INVALID_PHONE'
  | 'COUNTRY_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_QUANTITY';

/** What each field is called when a label is missing or twice — the keys of the two code families. */
const CODE_OF: Record<LabeledField | 'orderNumber', string> = {
  orderNumber: 'ORDER_NUMBER',
  orderedAt: 'ORDERED_AT',
  customer: 'CUSTOMER_NAME',
  phone: 'PHONE',
  address: 'ADDRESS',
  product: 'PRODUCT',
  offer: 'OFFER_NAME',
  price: 'PRICE',
  quantity: 'QUANTITY',
};

/** Values as the message wrote them, digits Latin, spaces single. */
export type LabeledFields = Record<LabeledField, string>;

/** The store a message is judged against: its country, and when the message reached us. */
export interface LabeledStore {
  country: { code: string; name: string; currencyCode: string; minorUnit: number };
  /** `TelegramMessage.createdAt`, not now: a retry a week later must get the same answer for the date. */
  receivedAt: Date;
}

export type LabeledReading =
  | { claimed: false }
  | { claimed: true; ok: false; reason: LabeledRefusal; fields: Partial<LabeledFields> }
  | {
      claimed: true;
      ok: true;
      fields: LabeledFields;
      /** The address without the store's own country word. */
      place: string;
      /** «السعر» as plain digits — the order's TOTAL. */
      priceText: string;
      /** «الكمية» — pieces of the product. */
      quantity: number;
      /** «رقم الهاتف», cleaned: the number the customer is made from, and any others in the line. */
      phone: PhoneReading;
    };

const MAX_TEXT_LENGTH = 4000;
const MAX_QUANTITY = 1000;

interface Scan {
  /** Distinct labels found at the start of a line. */
  labels: number;
  values: Partial<Record<LabeledField, string>>;
  /** The first label (in the order it was written) that stood twice. */
  repeated: LabeledField | 'orderNumber' | null;
  /** A line that belongs to no label, or to a label that takes one line only. */
  stray: boolean;
}

/** A line under «رقم الهاتف» that is another number: digits and what numbers are written with, and at least one digit. */
const PHONE_CONTINUATION = /^(?=.*\d)[+\d\s().\-–—/،,]+$/;

/** The text as lines, label by label. A value is everything after the first colon; only the address may run on. */
function scan(text: string): Scan {
  const lines = toLatinDigits((text || '').slice(0, MAX_TEXT_LENGTH).replace(BIDI_MARKS, '').replace(/\r/g, ''))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const out: Scan = { labels: 0, values: {}, repeated: null, stray: false };
  let current: LabeledField | 'orderNumber' | null = null;

  for (const line of lines) {
    const colon = line.search(/[:：]/);
    const key = colon > 0 ? FOLDED.get(foldLabel(line.slice(0, colon))) : undefined;
    if (key !== undefined) {
      const name = key ?? 'orderNumber';
      if (seen.has(name)) out.repeated ??= name;
      else {
        seen.add(name);
        out.labels++;
        if (key) out.values[key] = line.slice(colon + 1).trim();
      }
      current = name;
      continue;
    }
    if (current === 'address') {
      // The address is the one value that may run onto the next line.
      out.values.address = `${out.values.address ?? ''} ${line}`.trim();
    } else if (current === 'phone' && PHONE_CONTINUATION.test(line)) {
      // A second number on the next line (28/10: «او سطر جديد»): only a line made of what a number is written with.
      out.values.phone = `${out.values.phone ?? ''} / ${line}`.trim();
    } else {
      out.stray = true;
    }
  }
  return out;
}

/** «25», «25 $», «$25», «25 دولار», «25.5»: a number and, at most, one currency word — and nothing else. */
const CURRENCY = CURRENCY_WORDS.map((c) => c.pattern).join('|');
const PRICE_VALUE = new RegExp(`^(?:(${CURRENCY}) ?)?(\\d+(?:\\.\\d+)?)(?: ?(${CURRENCY}))?$`, 'iu');

function readPrice(value: string): { priceText: string; currency: string | null } | null {
  const m = PRICE_VALUE.exec(normalizeArabic(value).replace(/٫/g, '.').replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const named = m[1] ?? m[3];
  const currency = named ? CURRENCY_WORDS.find((c) => new RegExp(`^(?:${c.pattern})$`, 'iu').test(named))?.code ?? null : null;
  return { priceText: m[2], currency };
}

/**
 * The address without the country word at either end — or the refusal, when that word names another country.
 *
 * «دمشق سوريا» and «سوريا دمشق» are the same place. The words are the store's own country (its name, and the spellings
 * in `COUNTRY_WORDS`) and the other countries the geo list knows; a word of another country is never guessed past.
 */
export function placeOf(address: string, country: LabeledStore['country']): { place: string } | { refusal: 'COUNTRY_MISMATCH' } {
  const own = country.code.trim().toUpperCase();
  const tokens = [...address.matchAll(new RegExp(PLACE_WORD, 'g'))].map((m) => ({
    text: m[0],
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  const strip = (from: number, to: number) => address.slice(from, to).replace(new RegExp(`^${PLACE_GAP}|${PLACE_GAP}$`, 'g'), '').trim();

  for (const { code, words } of [{ code: own, words: [country.name] }, ...COUNTRY_WORDS]) {
    for (const word of words) {
      const count = word.trim().split(/\s+/).length;
      if (tokens.length < count) continue;
      const head = tokens.slice(0, count);
      if (sameArabicName(head.map((t) => t.text).join(' '), word)) {
        return code === own ? { place: strip(head[count - 1].end, address.length) } : { refusal: 'COUNTRY_MISMATCH' };
      }
      const tail = tokens.slice(tokens.length - count);
      if (sameArabicName(tail.map((t) => t.text).join(' '), word)) {
        return code === own ? { place: strip(0, tail[0].start) } : { refusal: 'COUNTRY_MISMATCH' };
      }
    }
  }
  return { place: address };
}

/**
 * The message, read. Never throws; never performs I/O.
 *
 * Without `store`: whether the message claims the format, and its fields — what the screen draws. With `store`: every
 * rule that needs the store too (the date window, the phone rule, the country word, the currency), in field order, the
 * first refusal winning. The catalogue is the door's.
 */
export function readLabeledOrder(text: string, store?: LabeledStore): LabeledReading {
  const read = scan(text);
  if (read.labels < 2) return { claimed: false };

  const refused = (reason: LabeledRefusal): LabeledReading => ({ claimed: true, ok: false, reason, fields: read.values });

  // 1 — the shape: a label twice, or a line no label owns.
  if (read.repeated) return refused(`REPEATED_${CODE_OF[read.repeated]}` as LabeledRefusal);
  if (read.stray) return refused('STRAY_LINE');

  // 2 — every label but the order number is required, and needs a value.
  for (const field of LABELED_FIELDS) {
    if (!read.values[field]) return refused(`MISSING_${CODE_OF[field]}` as LabeledRefusal);
  }
  const fields = read.values as LabeledFields;

  // 3 — each value, by the rule of its field.
  const when = sourceTime(fields.orderedAt);
  if (when === null) return refused('BAD_DATE');
  if (store) {
    const arrived = store.receivedAt.getTime();
    if (when < arrived - SOURCE_TIME_BEFORE_MS || when > arrived + SOURCE_TIME_AFTER_MS) return refused('SOURCE_TIME_OFF');
  }

  if (!isCustomerName(fields.customer)) return refused('INVALID_CUSTOMER_NAME');

  const phone = readPhoneText(fields.phone, store?.country.code);
  if (!phone) return refused('MISSING_PHONE');
  if (!phone.accepted) return refused('INVALID_PHONE');

  // Every address is an address. The country word comes off only when a place is left; «سوريا» alone, another country's
  // word and a line that names no place at all stay exactly as the seller wrote them.
  const where = store ? placeOf(fields.address, store.country) : { place: fields.address };
  const place = 'place' in where && where.place ? where.place : fields.address;

  const price = readPrice(fields.price);
  if (!price) return refused('MISSING_PRICE');
  if (store) {
    if (price.currency && price.currency !== store.country.currencyCode.trim().toUpperCase()) return refused('CURRENCY_MISMATCH');
    const decimals = price.priceText.split('.')[1]?.length ?? 0;
    if (decimals > store.country.minorUnit) return refused('MISSING_PRICE');
  }

  const quantity = /^\d{1,5}$/.test(fields.quantity) ? Number(fields.quantity) : NaN;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return refused('INVALID_QUANTITY');

  return { claimed: true, ok: true, fields, place, priceText: price.priceText, quantity, phone };
}

/** What the «طلبات تلجرام» columns show for one message: the fields as it wrote them, when it claims the format. */
export interface MessageColumns {
  claimed: boolean;
  orderedAt?: string;
  customer?: string;
  phone?: string;
  address?: string;
  product?: string;
  offer?: string;
  price?: string;
  quantity?: string;
}

/** The same pure reader the door uses, run when the list is read — so no column of the table needs a column in the database. */
export function readMessageColumns(text: string): MessageColumns {
  const reading = readLabeledOrder(text);
  if (!reading.claimed) return { claimed: false };
  return { claimed: true, ...reading.fields };
}
