import { LOGESTECHS_STATUS_AR } from './couriers/logestechs';

/**
 * THE COURIER'S OWN WORD, READ ONE WAY AT BOTH DOORS.
 *
 * A courier's statement has a column «الحالة». It was parsed, stored on the line, and read by nothing: a
 * line that said «مؤجلة» and a line that said «تم توصيلها» were the same line to every screen, and the
 * person looking at a difference could not see what the company itself claimed had happened.
 *
 * ── AN EXACT-PHRASE TABLE, NOT A GUESS ──
 *
 * The first design read the word by a piece of it («تم» is a delivery, «قيد» is on the way). A piece of a
 * word is how «تم رفضه» and «لم يتم التسليم» become deliveries. So the table holds WHOLE phrases, and a
 * phrase that is not in it reads UNKNOWN — which is shown as such and decides nothing. Being unknown is
 * not an error; it is the honest answer for a word nobody has met yet, and the person sees the word itself.
 *
 * It is SEEDED from `LOGESTECHS_STATUS_AR` (the company's own table of its Arabic names), so the phrases
 * the company documents are in it by construction and a new status added there cannot be forgotten here:
 * the test holds the two to each other. Beside it sit the few spellings a statement FILE uses that the
 * API's table does not («تم توصيلها»), and the masculine «مؤجل» — one reading for «مؤجل» and «مؤجلة»,
 * wherever it is read.
 *
 * ── TWO DOORS, ONE FUNCTION ──
 *
 * The import (`parseStatementRows`) tallies the words of the file so the person is told which ones are
 * unknown; the matching (`runMatching`) reads the same cell again from the stored line and writes the
 * reading beside a row that needs a person. Both call `readCourierWord`; neither has a table of its own.
 *
 * Pure. No database, no clock.
 */

export const COURIER_OUTCOMES = [
  'DELIVERED',
  'PARTIAL',
  'RETURNED',
  'POSTPONED',
  'CANCELLED',
  'IN_TRANSIT',
  'OTHER',
  'UNKNOWN',
] as const;
export type CourierOutcome = (typeof COURIER_OUTCOMES)[number];

/** What each reading says, as the screen writes it. «OTHER» is a known word that does not say where the parcel is. */
export const COURIER_OUTCOME_AR: Record<CourierOutcome, string> = {
  DELIVERED: 'تقول الشركة: سُلِّم',
  PARTIAL: 'تقول الشركة: سُلِّم جزئياً',
  RETURNED: 'تقول الشركة: رجع',
  POSTPONED: 'تقول الشركة: مؤجَّل',
  CANCELLED: 'تقول الشركة: مُلغى',
  IN_TRANSIT: 'تقول الشركة: ما زال عندها',
  OTHER: 'كلمة معروفة لا تقول إن كان سُلِّم',
  UNKNOWN: 'كلمة لا نعرفها بعد',
};

/**
 * What each of the company's documented codes MEANS for a statement line. Every code of
 * `LOGESTECHS_STATUS_AR` is named here; the test fails the day one is added there and not here.
 */
const CODE_OUTCOME: Record<string, CourierOutcome> = {
  PENDING_CUSTOMER_CARE_APPROVAL: 'IN_TRANSIT',
  APPROVED_BY_CUSTOMER_CARE_AND_WAITING_FOR_DISPATCHER: 'IN_TRANSIT',
  CANCELLED: 'CANCELLED',
  ASSIGNED_TO_DRIVER_AND_PENDING_APPROVAL: 'IN_TRANSIT',
  REJECTED_BY_DRIVER_AND_PENDING_MANGEMENT: 'IN_TRANSIT',
  ACCEPTED_BY_DRIVER_AND_PENDING_PICKUP: 'IN_TRANSIT',
  SCANNED_BY_DRIVER_AND_IN_CAR: 'IN_TRANSIT',
  DELIVERED_TO_RECIPIENT: 'DELIVERED',
  POSTPONED_DELIVERY: 'POSTPONED',
  RETURNED_BY_RECIPIENT: 'RETURNED',
  COMPLETED: 'OTHER',
  TRANSFERRED_OUT: 'OTHER',
  PARTIALLY_DELIVERED: 'PARTIAL',
  SWAPPED: 'OTHER',
  BROUGHT: 'OTHER',
  DELIVERED_TO_SENDER: 'RETURNED',
  EXPORTED_TO_THIRD_PARTY: 'OTHER',
};

/** The codes the table below is built from, exposed so the test can hold them to the company's own list. */
export const COURIER_CODES_READ = Object.keys(CODE_OUTCOME);

/**
 * The words a statement FILE uses that the API's table does not have. Whole phrases only, and each one seen
 * in a real file or in the fixtures written from one («تم توصيلها», «تم إرجاعها», «قيد التوصيل»); «مؤجل» is
 * the masculine of «مؤجلة» and reads the same.
 */
const FILE_PHRASES: Record<string, CourierOutcome> = {
  'تم توصيلها': 'DELIVERED',
  'مؤجل': 'POSTPONED',
  'قيد التوصيل': 'IN_TRANSIT',
};

/**
 * One spelling of a phrase. Hamza forms fold together (إرجاعها = ارجاعها), so does the final ة/ه and ى/ي, and
 * diacritics and the stretch character go. It does NOT cut a phrase short: «مؤجل» and «مؤجلة» stay two
 * phrases, both in the table, which is the point of having one table.
 */
export function normalizePhrase(text: string | null | undefined): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const PHRASES: ReadonlyMap<string, CourierOutcome> = (() => {
  const table = new Map<string, CourierOutcome>();
  for (const [code, phrase] of Object.entries(LOGESTECHS_STATUS_AR)) {
    table.set(normalizePhrase(phrase), CODE_OUTCOME[code] ?? 'UNKNOWN');
  }
  for (const [phrase, outcome] of Object.entries(FILE_PHRASES)) table.set(normalizePhrase(phrase), outcome);
  // «مؤجلة» is seeded from the company's table as POSTPONED; the masculine must say the same thing.
  table.set(normalizePhrase('مؤجلة'), 'POSTPONED');
  return table;
})();

export interface CourierWordReading {
  /** The word as the courier wrote it, trimmed. */
  phrase: string;
  outcome: CourierOutcome;
  /** False for a phrase the table does not hold. */
  known: boolean;
}

/** What a courier's status cell says. Null when the cell is empty: no word was said. */
export function readCourierWord(text: string | null | undefined): CourierWordReading | null {
  const phrase = String(text ?? '').trim();
  if (!phrase) return null;
  const outcome = PHRASES.get(normalizePhrase(phrase));
  return outcome ? { phrase, outcome, known: true } : { phrase, outcome: 'UNKNOWN', known: false };
}

export interface CourierWordTally {
  /** How many lines say each thing. */
  byOutcome: Partial<Record<CourierOutcome, number>>;
  /** The distinct words nobody has met, as written — so a person can tell us what they mean. */
  unknown: string[];
}

const UNKNOWN_LISTED = 20;

/** The words of a whole file, counted. The import door's reading. */
export function tallyCourierWords(statuses: (string | null | undefined)[]): CourierWordTally {
  const byOutcome: CourierWordTally['byOutcome'] = {};
  const unknown = new Set<string>();
  for (const status of statuses) {
    const reading = readCourierWord(status);
    if (!reading) continue;
    byOutcome[reading.outcome] = (byOutcome[reading.outcome] ?? 0) + 1;
    if (!reading.known && unknown.size < UNKNOWN_LISTED) unknown.add(reading.phrase);
  }
  return { byOutcome, unknown: [...unknown] };
}

/**
 * The sentence written beside a row that needs a person: the company's own word, and what we made of it.
 * Nothing for a line that says delivered — there is nothing to point at — and nothing for an empty cell.
 */
export function courierWordNote(reading: CourierWordReading | null): string | null {
  if (!reading || reading.outcome === 'DELIVERED') return null;
  if (!reading.known) return `كلمة الشركة «${reading.phrase}» لا نعرفها بعد`;
  return `قالت الشركة: «${reading.phrase}»`;
}

/**
 * A MONEY CELL THAT SAYS «NOTHING HERE» — empty, a dash, or the words for none.
 *
 * Couriers do not leave a cell blank; they write «-» or «لا يوجد» or «—». Read as a figure those are
 * unreadable and refused the WHOLE file, which is right for «٣٥٠٠ د.أ» (a figure with a unit stuck to it:
 * a number that could be read wrong) and wrong for a cell that plainly states no figure. Only these exact
 * forms are «no money»; anything else that is not a number is still refused, by name.
 */
const NO_MONEY_WORDS = new Set(
  ['لا يوجد', 'لايوجد', 'لا شيء', 'لا شي', 'بدون', 'فاضي', 'فارغ', 'n/a', 'na', 'null', 'nil', 'none'].map(
    normalizePhrase
  )
);

export function isNoMoneyCell(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim();
  if (t === '') return true;
  if (/^[-‐-―−_ـ./\\\s]+$/.test(t)) return true;
  return NO_MONEY_WORDS.has(normalizePhrase(t));
}
