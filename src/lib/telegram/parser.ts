/**
 * TELEGRAM ORDER PARSER — deterministic (no AI) natural-language parser.
 *
 * Extracts: customerName, phone, address, city, productText, quantity, notes.
 * Design contract:
 *   - `isOrder` + `confidence` are ADVISORY. Never used alone for a dangerous
 *     decision — the ingestion pipeline independently validates each field.
 *   - Non-order chit-chat (greetings, price questions, thanks) → isOrder=false.
 *   - Order-like but incomplete → isOrder=true with low confidence; the
 *     pipeline maps missing fields to NEEDS_REVIEW reasons.
 *
 * Reuses normalizeArabic() from the existing free-text order parser so
 * Arabic normalization stays consistent across the codebase.
 */
import { toLatinDigits } from '../latin-digits';
import { normalizeArabic } from '../order-parser';
import { isValidPhoneFor } from '../phone-rules';
import { sameArabicName } from '../address';

export interface ParsedTelegramOrder {
  isOrder: boolean;
  confidence: number; // 0..1 advisory only
  customerName?: string;
  phone?: string;
  address?: string;
  city?: string;
  /** المحافظة — kept separate from address (never merged) */
  governorate?: string;
  productText?: string;
  quantity?: number;
  /** السعر كما ورد في الرسالة — للعرض/التدقيق فقط، لا يُستخدم سعرًا نهائيًا */
  priceText?: string;
  notes?: string;
  /** اسم الصفحة التجارية (المصدر) داخل الرسالة — غير مرتبط بمجموعة تيليجرام */
  pageName?: string;
}

const MAX_TEXT_LENGTH = 4000;

/**
 * Find the first plausible phone number in text (Syrian/Egyptian/Gulf friendly).
 *
 * ONE LINE AT A TIME, AND A DATE IS NOT A PHONE (T9).
 *
 * The search used to run over the whole text, and `\s` in the digit run matches a line break too. So a reference on one
 * line and a date on the next were read as ONE number: the owner's «26818⏎2026-10-28 15:40:01» came out as
 * 268182026102815 — fifteen digits, which passes the length check below, and which a Syrian store even accepts as a
 * foreign line. The real phone, three lines further down, was never reached. A line that is nothing but a date or a time
 * is skipped, and a run of digits never crosses into the next line.
 */
export function extractPhone(text: string): string | null {
  for (const line of toLatinDigits(text).split(/\r?\n/)) {
    if (DATE_TIME_LINE.test(line.replace(BIDI_MARKS, '').replace(/\s+/g, ' ').trim())) continue;
    const match = line.match(/(?:\+?\d[\d\s\-()]{6,17}\d)/);
    if (!match) continue;
    const digits = match[0].replace(/\D/g, '');
    // Reasonable phone length without country code garbage (7..15 digits)
    if (digits.length < 7 || digits.length > 15) continue;
    // Reject pure-quantity/false positives: e.g. "3" already excluded by length
    return digits;
  }
  return null;
}

/** Extract quantity; returns undefined when none stated. Throws no errors. */
export function extractQuantity(text: string): number | undefined {
  const t = toLatinDigits(text);
  // labeled: الكمية: 5 / العدد: 3 / qty: 5
  const labeled = t.match(/(?:الكمية|الكميه|العدد)\s*[:：=\-]?\s*(\d{1,5})/);
  if (labeled) return parseInt(labeled[1], 10);
  // "×2" / "x2" / "*2" after product words
  const symbol = t.match(/[×x*]\s*(\d{1,4})/i);
  if (symbol) return parseInt(symbol[1], 10);
  // "2 كرتون|كراتين|قطعة|حبة|علبة" or "كمية 2"
  const unit = t.match(/(\d{1,4})\s*(?:كرتون|كراتين|علبة|علب|قطعة|قطع|حبة|حبات|عبوة)/);
  if (unit) return parseInt(unit[1], 10);
  const kammia = t.match(/كمية\s*(\d{1,4})/);
  if (kammia) return parseInt(kammia[1], 10);
  return undefined;
}

const LABEL_PATTERNS = {
  customerName: /(?:الاسم|اسم الزبون|اسم العميل|الاسم الكامل|الزبون|العميل)\s*[:：\-]\s*(.*)/,
  phone: /(?:الرقم|رقم الهاتف|الهاتف|رقم الموبايل|رقم الواتس|واتساب|واتس|التليفون)\s*[:：\-]?\s*([0-9+\-\s()]{7,20})/,
  address: /(?:العنوان|عنوان التوصيل|السكن|العنوان بالتفصيل)\s*[:：\-]\s*(.*)/,
  governorate: /(?:اسم المحافظة|اسم المحافظه|المحافظة|المحافظه|المدينة|المدينه)\s*[:：\-]\s*(.*)/,
  product: /(?:الطلب\s*[\(（]\s*[^)）]*\s*[\)）]|الطلب|المنتج|اسم المنتج|المنتج المطلوب|المطلوب)\s*[:：\-]\s*(.*)/,
  quantity: /(?:الكمية|الكميه|العدد)\s*[:：=\-]?\s*([0-9٠-٩]{1,5})/,
  price: /(?:السعر|الثمن|المبلغ)\s*[:：]\s*(.+)/,
  notes: /(?:الملاحظات|ملاحظات|ملاحظة)\s*[:：\-]\s*(.*)/,
  pageName: /(?:اسم الصفحة|اسم الصفحه|الصفحة|الصفحه|المصدر)\s*[:：\-]\s*(.*)/,
};

/** Chit-chat / non-order signals. */
const NON_ORDER_PATTERNS: RegExp[] = [
  /^(?:السلام\s*عليكم|سلام|مرحبا|هلا|هاي|hi|hello)\b/i,
  /(?:شكرا|شكرًا|تم\s*التوصيل|وصل\s*الطلب|تم\s*الاستلام|مشكور)/,
  /(?:وين\s*طلبي|متى\s*يصل|وين\s*وصلت|فين\s*طلبي|متى\s*التوصيل|متى\s*يوصل)/,
  /(?:كم\s*(?:ال)?(?:سعر|ثمن)|بكم|السعر\s*كم|عندي\s*سؤال|سؤال|استفسار)/,
];

const ORDER_ACTION_WORDS = /(?:طلب|اطلب|بدي|ابي|أبغي|اريد|أريد|عاز|حدثني|اوريد|أوريد|دزلي|سجل\s*طلب|طلب\s*جديد|new\s*order)/i;

function clean(v: string | undefined | null): string | undefined {
  if (!v) return undefined;
  const t = v.replace(/^[-–—:：]+\s*/, '').trim();
  return t && t !== '-' ? t : undefined;
}

/**
 * Labeled-field values that may legitimately be EMPTY (e.g. الملاحظات:).
 * clean() returns undefined for empty; emptyField() returns '' so the
 * caller knows the label existed with an empty value.
 */
function cleanAllowEmpty(v: string | undefined | null): string {
  if (!v) return '';
  // Strip label punctuation, but keep a leading minus (negative values must
  // survive to the validator so they can be rejected, not silently flipped)
  const t = v.replace(/^[:：]\s*/, '').replace(/^[-–—](?!\d)\s*/, '').trim();
  return t === '-' ? '' : t;
}

/**
 * Parse a Telegram message into a structured order draft.
 * Never throws; never performs I/O.
 */
export function parseTelegramOrderMessage(rawText: string): ParsedTelegramOrder {
  const text = (rawText || '').slice(0, MAX_TEXT_LENGTH);
  if (!text.trim()) return { isOrder: false, confidence: 0 };

  // 1) Labeled (structured) extraction first — strongest signal
  const lines = text.split(/\n|؛|;/);
  const out: ParsedTelegramOrder = { isOrder: false, confidence: 0 };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!out.customerName) {
      const m = trimmed.match(LABEL_PATTERNS.customerName);
      if (m) out.customerName = clean(m[1]);
    }
    if (!out.phone) {
      const m = trimmed.match(LABEL_PATTERNS.phone);
      if (m) {
        const digits = extractPhone(m[1]);
        if (digits) out.phone = digits;
      }
    }
    if (!out.address) {
      const m = trimmed.match(LABEL_PATTERNS.address);
      if (m) out.address = clean(m[1]);
    }
    if (!out.governorate) {
      const m = trimmed.match(LABEL_PATTERNS.governorate);
      if (m) out.governorate = clean(m[1]);
    }
    if (!out.productText) {
      const m = trimmed.match(LABEL_PATTERNS.product);
      if (m) out.productText = clean(m[1]);
    }
    if (out.quantity === undefined) {
      const m = trimmed.match(LABEL_PATTERNS.quantity);
      if (m) {
        const n = parseInt(toLatinDigits(m[1]), 10);
        if (Number.isFinite(n)) out.quantity = n;
      }
    }
    if (!out.priceText) {
      const m = trimmed.match(LABEL_PATTERNS.price);
      // keep raw value (incl. signs) so the price validator can reject negatives
      if (m) out.priceText = cleanAllowEmpty(m[1]) || undefined;
    }
    // الملاحظات may be intentionally empty — preserve the label presence
    if (out.notes === undefined) {
      const m = trimmed.match(LABEL_PATTERNS.notes);
      if (m) out.notes = cleanAllowEmpty(m[1]);
    }
    if (!out.pageName) {
      const m = trimmed.match(LABEL_PATTERNS.pageName);
      if (m) out.pageName = clean(m[1]);
    }
  }

  // 2) Phone fallback: any phone-shaped token anywhere
  if (!out.phone) out.phone = extractPhone(text) ?? undefined;

  // 3) Quantity
  const q = extractQuantity(text);
  if (q !== undefined) out.quantity = q;

  // 4) Non-order suppression: chit-chat with no product/no phone
  const hasPhone = Boolean(out.phone);
  const hasProduct = Boolean(out.productText);
  const hasName = Boolean(out.customerName);
  const isChitChat = NON_ORDER_PATTERNS.some((p) => p.test(normalizeArabic(text)));
  if (isChitChat && !hasProduct && !hasName) {
    return { isOrder: false, confidence: 0 };
  }

  // 5) Order-likeness scoring (advisory confidence only)
  let score = 0;
  if (hasPhone) score += 2;
  if (hasProduct) score += 2;
  if (hasName) score += 1;
  if (out.address) score += 1;
  if (out.quantity !== undefined) score += 1;
  if (ORDER_ACTION_WORDS.test(text)) score += 1;

  // 6) Confidence = fraction of expected fields present
  const fields = [hasPhone, hasProduct, hasName, Boolean(out.address || out.governorate), out.quantity !== undefined];
  out.confidence = Math.min(1, fields.filter(Boolean).length / fields.length);

  // 7) Free-format fallbacks (no labels): "أحمد 33334444 عرفات 2 ريان"
  if (!hasName && !hasProduct && hasPhone) {
    const candidate = extractFreeForm(text, out.phone!);
    if (candidate.customerName) {
      out.customerName = candidate.customerName;
      if (!out.productText) out.productText = candidate.productText;
      if (!out.address) out.address = candidate.address;
      if (out.quantity === undefined && candidate.quantity) out.quantity = candidate.quantity;
    }
  }

  // An order needs at minimum a phone OR (a product AND order intent/score)
  const isOrder = hasPhone || (hasProduct && ORDER_ACTION_WORDS.test(text)) || (hasProduct && score >= 3);
  if (!isOrder) return { isOrder: false, confidence: 0 };

  out.isOrder = true;
  return out;
}

// (fix-up helpers used above — kept module-private)

/** Pull name/product/address/quantity from an unlabeled single-line format. */
function extractFreeForm(text: string, phone: string): {
  customerName?: string; productText?: string; address?: string; quantity?: number;
} {
  const t = toLatinDigits(text);
  const idx = t.indexOf(phone);
  if (idx === -1) return {};
  const before = t.slice(0, idx).trim();
  const after = t.slice(idx + phone.length).trim();
  const tokens = after.split(/[\s,،\-–—]+/).filter(Boolean);

  // Leading number after phone = quantity
  let quantity: number | undefined;
  const rest: string[] = [];
  for (const tok of tokens) {
    if (quantity === undefined && /^\d{1,3}$/.test(tok)) { quantity = parseInt(tok, 10); continue; }
    rest.push(tok);
  }
  const remainder = rest.join(' ').trim();

  // Known Syrian/Egyptian-style city hints stay in address; simplest split:
  // remainder → address (and product matched later by product matching layer).
  return {
    customerName: before ? before.replace(/[-–—:،]+$/, '').trim() || undefined : undefined,
    quantity,
    address: remainder || undefined,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * HIS SEVEN LINES — ONE FACT PER LINE, IN A FIXED ORDER (T1).
 *
 * The owner, 28/10: «خلي تنسيق الطلبات اللي جاية من التلجرام يكون هيك»:
 *
 *     26818                          1  a reference — copied into no order field
 *     2026-10-28 15:40:01            2  when the order was taken, at the source
 *     محمد                            3  the customer
 *     0932323642                     4  the phone
 *     سوريا حماه                      5  the governorate; a leading word naming the store's own country is dropped
 *     ماء الكمأ الأصلي                6  the product
 *     القطعة ب 15 $ + توصيل مجاني     7  the offer: how many pieces, for what TOTAL, and whether delivery is in it
 *
 * Nothing in it has a label, so the labeled reader above read none of it, and every such message stopped at
 * «اسم العميل ناقص» with the name in plain sight on line 3.
 *
 * WHICH MESSAGES ARE HIS. At least five lines, no line that opens with one of the labels above (the labeled reader would
 * read it), and a line among the first three that is only a date. A labeled message, or a one-line one, never matches
 * and keeps the path it always had.
 *
 * A MESSAGE THAT CLAIMS THE FORMAT NEVER FALLS BACK. Once it is his shape, a line that does not fit sends the message to a
 * person with the line named. It is not handed to the old reader to be half-read, and it is never IGNORED.
 *
 * PURE. No I/O and no model. Read without a store it gives the lines (the screen's columns, the duplicate key); read with
 * the store it also judges lines 2, 4, 5 and 7 against that store — its country, its phone rule, its currency. Line 6 is
 * the door's: only the door knows the catalogue.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Direction marks a phone keyboard or a copy from another app leaves inside a line: LRM, RLM, the embeddings, the isolates, ALM. */
export const BIDI_MARKS = /[‎‏‪-‮⁦-⁩؜]/g;

/** «2026-10-28 15:40:01», «2026/10/28», «2026-10-28 15:40» — a date, maybe a time, and nothing else on the line. */
const DATE_TIME_LINE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** A line the labeled reader above reads as a label, from its first character. One list of labels, not two. */
const LABEL_AT_START = Object.values(LABEL_PATTERNS).map((p) => new RegExp(`^${p.source}`));

export const LINE_ROLE_COUNT = 7;

/** The seven lines as they read once the marks are gone, the digits are Latin and the spaces are single. */
export interface LineRoleLines {
  ref: string;
  orderedAt: string;
  customer: string;
  phone: string;
  governorate: string;
  product: string;
  offer: string;
}

/** What a line of his format can be refused for. Each has its Arabic sentence, and its line, in `review-reasons.ts`. */
export type LineRoleRefusal =
  | 'LINE_COUNT'
  | 'BAD_DATE'
  | 'SOURCE_TIME_OFF'
  | 'MISSING_CUSTOMER_NAME'
  | 'INVALID_PHONE'
  | 'COUNTRY_MISMATCH'
  | 'MISSING_ADDRESS'
  | 'INVALID_QUANTITY'
  | 'MISSING_PRICE'
  | 'OFFER_UNREADABLE'
  | 'DELIVERY_FEE_STATED'
  | 'CURRENCY_MISMATCH'
  | 'GIFT_NEEDS_OFFER';

/** Line 7, read. */
export interface LineRoleOffer {
  /** From the piece words of THIS line, and from nowhere else in the message. */
  quantity: number;
  /** The order's TOTAL for those pieces, in plain Latin digits: «القطعتين ب 25» is two for 25, never 25 each. */
  priceText: string;
  /** The currency the line names, as a `Country.currencyCode` would say it — or null when it names none (the store's own). */
  currency: string | null;
  /** «توصيل مجاني», «التوصيل مجاني» or «شامل التوصيل»: this order's price includes delivery. */
  deliveryIncluded: boolean;
}

/** The store a message is judged against: its country, and when the message reached us. */
export interface LineRoleStore {
  country: { code: string; name: string; currencyCode: string; minorUnit: number };
  /** `TelegramMessage.createdAt`, not now: a retry a week later must get the same answer for line 2. */
  receivedAt: Date;
}

export type LineRoleReading =
  | { claimed: false }
  | { claimed: true; ok: false; lineCount: number; lines: Partial<LineRoleLines>; reason: LineRoleRefusal }
  | { claimed: true; ok: true; lineCount: number; lines: LineRoleLines; place: string; offer: LineRoleOffer };

/** Line 2 may say a time up to a week before the message arrived and up to a day after it — wide enough for any time zone. */
export const SOURCE_TIME_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
export const SOURCE_TIME_AFTER_MS = 24 * 60 * 60 * 1000;

/** The text as lines: marks gone, digits Latin, split on line breaks ONLY (never on ؛ or ;), trimmed, the blank ones dropped. */
function plainLines(text: string): string[] {
  return toLatinDigits(text.replace(BIDI_MARKS, '').replace(/\r/g, ''))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Line 2 as a moment (the wall-clock time read as UTC, which the wide windows make safe), or null when it is no real date. */
export function sourceTime(line: string): number | null {
  const m = DATE_TIME_LINE.exec(line);
  if (!m) return null;
  const part = (v: string | undefined) => (v === undefined ? 0 : Number(v));
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(part);
  const at = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(at);
  const real =
    back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute &&
    back.getUTCSeconds() === second;
  return real ? at : null;
}

/** Line 3: a name — two letters at least, no digit, eighty characters at most. */
export function isCustomerName(line: string): boolean {
  return line.length <= 80 && !/\d/.test(line) && (line.match(/\p{L}/gu) ?? []).length >= 2;
}

/** Line 4 holds only what a phone is written with. */
export const PHONE_LINE = /^\+?[\d\s\-()]+$/;

/**
 * The country words a governorate line may open with: the geo migration's own list (20260919203204), with Syria's
 * spellings. Compared through `sameArabicName`, so «الاردن» is «الأردن» and «سوريه» is «سورية».
 */
export const COUNTRY_WORDS: ReadonlyArray<{ code: string; words: readonly string[] }> = [
  { code: 'SY', words: ['سوريا', 'سورية', 'syria'] },
  { code: 'JO', words: ['الأردن', 'jordan'] },
  { code: 'EG', words: ['مصر', 'egypt'] },
  { code: 'IQ', words: ['العراق', 'iraq'] },
  { code: 'LB', words: ['لبنان', 'lebanon'] },
  { code: 'SA', words: ['السعودية', 'saudi arabia'] },
  { code: 'AE', words: ['الإمارات', 'uae'] },
  { code: 'US', words: ['usa'] },
];

/** What may stand between the country word and the place: a space, a dash, a comma of either script, a slash. */
export const PLACE_GAP = '[\\s\\-–—،,/|]+';
export const PLACE_WORD = '[^\\s\\-–—،,/|]+';

/** Line 5 without a leading word naming the store's own country — or the refusal, when the word names another one (T6). */
function placeOf(line: string, country: LineRoleStore['country']): { place: string } | { refusal: 'COUNTRY_MISMATCH' } {
  const own = country.code.trim().toUpperCase();
  for (const { code, words } of [{ code: own, words: [country.name] }, ...COUNTRY_WORDS]) {
    for (const word of words) {
      const count = word.trim().split(/\s+/).length;
      const head = new RegExp(`^((?:${PLACE_WORD}${PLACE_GAP}){${count - 1}}${PLACE_WORD})(?:${PLACE_GAP}|$)`).exec(line);
      if (!head || !sameArabicName(head[1].replace(new RegExp(PLACE_GAP, 'g'), ' '), word)) continue;
      return code === own ? { place: line.slice(head[0].length).trim() } : { refusal: 'COUNTRY_MISMATCH' };
    }
  }
  return { place: line };
}

/*
 * LINE 7: PIECES [ب | بـ | بسعر] NUMBER [CURRENCY] [+ | و | مع FREE] — read whole, or refused.
 *
 * Compared in the form `normalizeArabic` gives (ة is ه, أ is ا, no tatweel), so «القطعه» and «بـ15» read as written.
 * The number is the TOTAL for the pieces in front of it and is never multiplied by them (T2).
 */
const NOT_A_LETTER = '(?![\\p{L}])';
const PIECES_COUNTED = new RegExp(`^(\\d{1,4}) ?(?:قطع|قطعه|علب|علبه|حبات|حبه|عبوات|عبوه)${NOT_A_LETTER}`, 'u');
const PIECES_TWO = new RegExp(`^(?:ال)?(?:قطعتين|قطعتان|حبتين|علبتين)${NOT_A_LETTER}`, 'u');
const PIECES_ONE = new RegExp(`^(?:ال)?(?:قطعه|حبه|علبه)(?: (?:ال)?واحده)?${NOT_A_LETTER}`, 'u');
const CONNECTOR = new RegExp(`^(?:ب ?سعر|ب)${NOT_A_LETTER}`, 'u');
/** Each currency the line may name, by the code `Country.currencyCode` carries. A symbol is compared, never converted. */
export const CURRENCY_WORDS: ReadonlyArray<{ code: string; pattern: string }> = [
  { code: 'USD', pattern: '\\$|usd|دولار(?: امريكي)?' },
  { code: 'SYP', pattern: 'ل\\.? ?س\\.?|ليره(?: سوريه)?|syp' },
  { code: 'JOD', pattern: 'د\\.? ?ا\\.?|دينار(?: اردني)?|jod' },
];
const CURRENCY = CURRENCY_WORDS.map((c) => c.pattern).join('|');
const CURRENCY_AT_START = new RegExp(`^(${CURRENCY})${NOT_A_LETTER}`, 'u');
const NUMBER_AT_START = /^(\d+(?:\.\d+)?)(?![\d.])/;
const FREE = '(?:(?:\\+|و|مع) ?)?(?:توصيل مجاني|التوصيل مجاني|شامل التوصيل)';
const FREE_AT_START = new RegExp(`^${FREE}${NOT_A_LETTER}`, 'u');
const FREE_ANYWHERE = new RegExp(FREE, 'gu');
/** A figure beside «توصيل»: a delivery fee written into the message. */
const FEE_BESIDE_A_FIGURE = new RegExp(
  `\\d[\\d.]* ?(?:(?:${CURRENCY}) ?)?(?:ال)?توصيل|(?:ال)?توصيل ?(?:ب ?سعر ?|ب ?)?(?:(?:${CURRENCY}) ?)?\\d`,
  'u'
);

function currencyOf(word: string): string | null {
  return CURRENCY_WORDS.find((c) => new RegExp(`^(?:${c.pattern})$`, 'u').test(word))?.code ?? null;
}

function readOfferLine(line: string): { ok: true; offer: LineRoleOffer } | { ok: false; reason: LineRoleRefusal } {
  const s = normalizeArabic(line).replace(/٫/g, '.').replace(/\s+/g, ' ').trim();
  // A gift needs an offer row to say what the gift IS. Until a message can be bound to one, a person reads it.
  if (/هديه|هدايا/.test(s)) return { ok: false, reason: 'GIFT_NEEDS_OFFER' };
  // «15,000» is fifteen thousand or fifteen, and which one is never guessed.
  if (/\d[,٬،]\d/.test(s)) return { ok: false, reason: 'OFFER_UNREADABLE' };
  // The fee comes from the region table, never from the message.
  if (FEE_BESIDE_A_FIGURE.test(s.replace(FREE_ANYWHERE, ' '))) return { ok: false, reason: 'DELIVERY_FEE_STATED' };
  if (!/\d/.test(s)) return { ok: false, reason: 'MISSING_PRICE' };

  let rest = s;
  const take = (re: RegExp) => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(m[0].length).trimStart();
    return m;
  };

  const counted = take(PIECES_COUNTED);
  const quantity = counted ? Number(counted[1]) : take(PIECES_TWO) ? 2 : take(PIECES_ONE) ? 1 : null;
  if (quantity === null) return { ok: false, reason: 'OFFER_UNREADABLE' };
  if (quantity < 1 || quantity > 1000) return { ok: false, reason: 'INVALID_QUANTITY' };

  take(CONNECTOR);
  const before = take(CURRENCY_AT_START);
  const figure = take(NUMBER_AT_START);
  if (!figure) return { ok: false, reason: /\d/.test(rest) ? 'OFFER_UNREADABLE' : 'MISSING_PRICE' };
  const after = before ? null : take(CURRENCY_AT_START);
  const free = take(FREE_AT_START);
  // A second figure, a second piece phrase, a word nobody wrote a rule for: the whole line is read, or none of it is.
  if (rest) return { ok: false, reason: 'OFFER_UNREADABLE' };

  const named = (before ?? after)?.[1];
  return {
    ok: true,
    offer: { quantity, priceText: figure[1], currency: named ? currencyOf(named) : null, deliveryIncluded: Boolean(free) },
  };
}

/**
 * His seven lines, read (see the block above). Never throws; never performs I/O.
 *
 * Without `store`: whether the message is his format, and its lines — what the screen draws and what the duplicate check
 * compares. With `store`: every rule of lines 2 to 7 except the catalogue, in line order, the first refusal winning.
 */
export function readLineRoleOrder(text: string, store?: LineRoleStore): LineRoleReading {
  const lines = plainLines((text || '').slice(0, MAX_TEXT_LENGTH));
  const claimed =
    lines.length >= 5 &&
    !lines.some((line) => LABEL_AT_START.some((label) => label.test(line))) &&
    lines.slice(0, 3).some((line) => DATE_TIME_LINE.test(line));
  if (!claimed) return { claimed: false };

  const lineCount = lines.length;
  const refused = (reason: LineRoleRefusal, seen: Partial<LineRoleLines>): LineRoleReading => ({
    claimed: true,
    ok: false,
    lineCount,
    lines: seen,
    reason,
  });

  // Six or eight lines cannot be given their roles; only the date is certain.
  if (lineCount !== LINE_ROLE_COUNT) {
    return refused('LINE_COUNT', { orderedAt: lines.slice(0, 3).find((line) => DATE_TIME_LINE.test(line)) });
  }
  const [ref, orderedAt, customer, phone, governorate, product, offer] = lines;
  const seen: LineRoleLines = { ref, orderedAt, customer, phone, governorate, product, offer };

  // 2 — a real date and time, near the moment the message arrived.
  const when = sourceTime(orderedAt);
  if (when === null) return refused('BAD_DATE', seen);
  if (store) {
    const arrived = store.receivedAt.getTime();
    if (when < arrived - SOURCE_TIME_BEFORE_MS || when > arrived + SOURCE_TIME_AFTER_MS) return refused('SOURCE_TIME_OFF', seen);
  }

  // 3 — a name.
  if (!isCustomerName(customer)) return refused('MISSING_CUSTOMER_NAME', seen);

  // 4 — a phone, by this store's own rule.
  const digits = phone.replace(/\D/g, '').length;
  const phoneOk = PHONE_LINE.test(phone) && (store ? isValidPhoneFor(store.country.code, phone) : digits >= 7 && digits <= 15);
  if (!phoneOk) return refused('INVALID_PHONE', seen);

  // 5 — the place, without the store's own country in front of it.
  const where = store ? placeOf(governorate, store.country) : { place: governorate };
  if ('refusal' in where) return refused(where.refusal, seen);
  if (!where.place) return refused('MISSING_ADDRESS', seen);

  // 6 — the product is the door's to find.

  // 7 — the offer, in this store's currency and decimals.
  const read = readOfferLine(offer);
  if (!read.ok) return refused(read.reason, seen);
  if (store) {
    const currency = store.country.currencyCode.trim().toUpperCase();
    if (read.offer.currency && read.offer.currency !== currency) return refused('CURRENCY_MISMATCH', seen);
    const decimals = read.offer.priceText.split('.')[1]?.length ?? 0;
    if (decimals > store.country.minorUnit) return refused('OFFER_UNREADABLE', seen);
  }

  return { claimed: true, ok: true, lineCount, lines: seen, place: where.place, offer: read.offer };
}

/** What the «طلبات تلجرام» columns show for one message: his lines when it is his format, the labels' fields when not. */
export interface MessageColumns {
  format: 'lines' | 'labels' | 'none';
  /** How many lines his format found — the reason says it when it is not seven. */
  lineCount?: number;
  orderedAt?: string;
  customer?: string;
  phone?: string;
  governorate?: string;
  product?: string;
  offer?: string;
}

/** The same pure readers the door uses, run when the list is read — so no column of the table needs a column in the database. */
export function readMessageColumns(text: string): MessageColumns {
  const reading = readLineRoleOrder(text);
  if (reading.claimed) {
    const { orderedAt, customer, phone, governorate, product, offer } = reading.lines;
    return { format: 'lines', lineCount: reading.lineCount, orderedAt, customer, phone, governorate, product, offer };
  }
  const parsed = parseTelegramOrderMessage(text);
  if (!parsed.isOrder) return { format: 'none' };
  return {
    format: 'labels',
    customer: parsed.customerName,
    phone: parsed.phone,
    governorate: parsed.governorate ?? parsed.address,
    product: parsed.productText,
    offer: parsed.priceText,
  };
}
