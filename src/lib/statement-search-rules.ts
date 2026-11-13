import { toLatinDigits } from './latin-digits';

/**
 * «اعمل زر بحث داخل كل الكشوف» (the owner, 13/11) — THE WORDS AND THE RULES OF THE SEARCH, WHICH THE SCREEN AND THE DOOR BOTH READ.
 *
 * The matching screen's own box looks through the queues of the ONE statement that is open. This is the other question:
 * «where did this parcel appear?» — asked of every statement of the store at once, by the thing a person has in hand: our
 * order number, the courier's barcode, the company's own reference, and (for somebody who may read customers' numbers) the
 * customer's name or phone. The answer is a list of lines, each saying which statement wrote it, what the matching made of
 * it, what was answered, and the figures — and one press opens that statement on the screen.
 *
 * Nothing here imports the server: the screen reads the same constants, the same sentence and the same shape of an answer,
 * so the box and the door cannot disagree about how short is too short. The query builder lives in `statement-search.ts`.
 */

/** The shortest thing searched: two letters would match half of every name and a third of every number. */
export const MIN_QUERY = 3;
/** The longest. A barcode is a few dozen characters at most; the rest is somebody pasting a page. */
export const MAX_QUERY = 100;
/** How many lines are answered at once; the true number is said beside them when there are more. */
export const MAX_HITS = 50;

/** The five groups the matching screen draws its lines in, by what the matching made of them. */
export const QUEUES = ['MATCHED', 'MISMATCHED', 'MISSING_IN_SYSTEM', 'EXCLUDED', 'MISSING_IN_STATEMENT'] as const;
export type QueueKey = (typeof QUEUES)[number];
export const isQueue = (v: unknown): v is QueueKey => typeof v === 'string' && (QUEUES as readonly string[]).includes(v);

/**
 * WHAT EACH RESULT IS CALLED — the title of the group it is drawn in on the matching screen, word for word, so a line that
 * says «فرق في المبلغ» here is in the group called that when the statement is opened. (`MissingIn…` reads as the group's
 * title: a line the company wrote that nothing of ours carries, or an order of ours that no statement names.)
 */
export const RESULT_AR: Record<QueueKey, string> = {
  MATCHED: 'مطابق',
  MISMATCHED: 'فرق في المبلغ',
  MISSING_IN_SYSTEM: 'في الكشف وليس عندنا',
  EXCLUDED: 'مستبعدة — مرتجع أو مؤجل',
  MISSING_IN_STATEMENT: 'طلب عندنا لم يذكره الكشف',
};

/** A line the company wrote, in a statement the matching has not been run on yet: it has no group to be in. */
export const NOT_MATCHED_YET_AR = 'المطابقة لم تُشغَّل على هذا الكشف بعد';

/** What the box says while there is too little to search by. */
export const TOO_SHORT_AR = `اكتب ${MIN_QUERY} أحرف على الأقل، أو امسح الباركود`;

/** What the list says when nothing of what was typed is in any statement of the store. */
export const NOT_IN_ANY_STATEMENT_AR = 'ما انذكر بأي كشف';

/** The invisible marks a phone picks up on its way here (left-to-right and right-to-left marks, zero-width spaces, the byte-order mark). */
const INVISIBLE = /[​-‏‪-‮⁠⁦-⁩؜﻿]/g;

/**
 * WHAT WAS TYPED, IN THE SPELLING THE DATABASE KEEPS: Latin digits, no invisible marks, one space between words, no edge
 * spaces. «ORD-٢٠٢٦-١٢٣٤» and a number copied out of a chat are then the same search as the one typed plainly.
 */
export const cleanQuery = (raw: string): string => toLatinDigits(raw).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

export type QueryRead = { ok: true; q: string; scanned: boolean } | { ok: false; error: string };

/**
 * THE URL'S QUESTION, READ ONCE.
 *
 * `q` is cut to `MAX_QUERY` after cleaning. Fewer than `MIN_QUERY` characters is refused, in Arabic — except for a whole
 * barcode the camera read (`scan=1`): a scan is complete by construction, and a two-character barcode is still a barcode.
 * The exception waives the LENGTH and nothing else: the scope, the limit and the contact rule apply to a scan as to a
 * typed word.
 */
export function readQuery(params: URLSearchParams): QueryRead {
  const q = cleanQuery(params.get('q') ?? '').slice(0, MAX_QUERY);
  const scanned = params.get('scan') === '1';
  if (q.length === 0 || (q.length < MIN_QUERY && !scanned)) return { ok: false, error: TOO_SHORT_AR };
  return { ok: true, q, scanned };
}

export interface HitStatement {
  id: string;
  /** The reference the statement was imported under. */
  reference: string;
  /** The shipping company's name, when it can still be read (the statement names it by id). */
  company: string | null;
  /** When the statement was imported (ISO). */
  at: string;
  /** `DRAFT` · `IMPORTED` · `RECEIPTED` · `MATCHED` · `APPROVED` · `CLOSED` — and the word the collection screen says it with. */
  state: string;
  stateAr: string;
  currencyCode: string;
}

/** One line a statement wrote about what was typed — or, for an order no statement names, the row that says so. */
export interface StatementHit {
  /** The matching's row for it; null for a line the matching has not been run over yet. */
  matchId: string | null;
  statement: HitStatement;
  /** The group the line is drawn in on the matching screen; null when the matching has not placed it. */
  queue: QueueKey | null;
  /** What the matching made of it, in the group's own words (or the sentence for a line not placed yet). */
  resultAr: string;
  /** The answer a person gave, when there is one, in the words the matching screen shows it with. */
  answerAr: string | null;
  order: { id: string; orderNumber: string } | null;
  /** The company's own references for the parcel, as its line wrote them. */
  barcode: string | null;
  merchantRef: string | null;
  /** The three figures of the line, as stored: what we expected, what the statement says, and the difference. Null where the row has none. */
  expected: number | null;
  stated: number | null;
  difference: number | null;
}

export interface StatementSearchResponse {
  /** What was searched, as the door read it. */
  q: string;
  hits: StatementHit[];
  /** The true number of lines the search found — more than `hits.length` when the answer was cut at `limit`. */
  total: number;
  limit: number;
}
