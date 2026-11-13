import type { HealthTone } from '../health';
import { EXCHANGE_AR, PARKED, PARKED_AR, RESOLUTIONS, RESOLUTION_AR, isExchange, type Resolution } from '../settlement-difference';

/**
 * «فيه فرق» — WHAT THE FOLLOW-UP SCREEN SAYS ABOUT A PARCEL WHOSE MATCHING CAME BACK WITH A DIFFERENCE, IN ONE PLACE.
 *
 *   «واذا المطابقة رجعت في فرق حط جنبو علامة انو في فرق عشان بنت المتابعة تشيك … وتعتمد رقمنا او رقم الشركة» (the owner, 13/11)
 *
 * The server decides which parcels carry a difference (`parcel-tracking/difference.ts`) and puts the finished object on the
 * row; the screen only draws it. This module is the object's shape, the words and the tones it is drawn with, and it reaches
 * no server module — the screen reads it.
 *
 * The figures are the matching's own and are never worked out here: `ours` and `theirs` are the two columns of the match
 * row, and `gap` is `shortfall()` of the settlement rule (`settlement-difference`), signed the way a shop reads it — a
 * positive gap is what the company kept back, a negative one is more than we expected. The browser prints them.
 */

/** What may be said about this order now, per saying (`settlement-decisions`): allowed, or the sentence why not. */
export type DifferenceVerdicts = Record<string, { allowed: boolean; why: string | null }>;

/** The company's own word for the line, read through the one phrase table (`couriers/words`) — what «سبب الشركة» draws. */
export interface DifferenceCourierWord {
  phrase: string;
  outcome: string;
  known: boolean;
  label: string;
}

/** The company's line, as the matching screen reads it: the cells `lineEssentials` and `readCourierRow` take. Display only. */
export interface DifferenceLine {
  merchantRef: string | null;
  barcode: string | null;
  amount: number;
  collected: number | null;
  fee: number | null;
  status: string | null;
  rawRow: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  receiverCity: string | null;
  receiverArea: string | null;
}

/** The field a row carries — only for whoever may see the courier's money; never for anyone else. */
export interface DifferenceOnTheRow {
  /** The match row the answer is written on, and the statement it sits on: the door of the matching screen takes both. */
  matchId: string;
  statementId: string;
  /** The statement's reference, as people call it. */
  statement: string;
  /** Ours: what the order is expected to bring. */
  ours: number | null;
  /** Theirs: what the company's line states. */
  theirs: number | null;
  /** Signed as the shop reads it (`shortfall`): positive = the company paid less than we expected; null when a figure is missing. */
  gap: number | null;
  /** Somebody has answered it (any of the sayings) — the mark then wears the answer's word instead of the red one. */
  answered: boolean;
  resolution: string | null;
  /**
   * «طلب تبديل»: `EXCHANGE` beside «اعتُمد رقم الشركة» (`isExchange`) — the courier's figure with a reason, so the answer's own
   * word is the exchange's. Null for every other answer; absent from an older server, which reads as «not an exchange».
   */
  resolutionKind?: string | null;
  resolutionNote: string | null;
  /** What the company still owes when our figure was the one that stood. */
  claim: number | null;
  /** The statement's matching is closed: no answer is taken any more, and the correction is a settlement statement. */
  closed: boolean;
  /** The matching's own sentence about the row («أجرة التوصيل 3 بدل 2», «الطلب مذكور بكشف آخر»), when it wrote one. */
  note: string | null;
  /** What may be said — only for whoever may decide; null for everyone else. */
  decisions: DifferenceVerdicts | null;
  courierWord: DifferenceCourierWord | null;
  statementLine: DifferenceLine | null;
}

export const DIFFERENCE_MARK = 'فيه فرق';
/** The company paid less than we expected / more than we expected — said as words, so a sign is never misread. */
export const SHORT_AR = 'نقص';
export const OVER_AR = 'زيادة';

export const OURS_AR = 'رقمنا';
export const THEIRS_AR = 'رقم الشركة';
export const COMPANY_LINE_AR = 'ما كتبته الشركة عن السطر';
export const MATCHING_NOTE_AR = 'ملاحظة المطابقة';
/** What a person who may see the figures but not decide is told in the dialog, in place of the answers. */
export const NEEDS_REVIEW_KEY_AR = 'البتّ بالفرق من صلاحية «مراجعة المطابقات» — اطلبه ممن يملكها.';
/** A saying this screen has no word for — never the code itself. */
export const ANSWERED_AR = 'انبتّ فيه';

/** «نقص» when the company paid less than we expected, «زيادة» when it paid more, and nothing when the figures agree or one is missing. */
export function gapWord(gap: number | null | undefined): typeof SHORT_AR | typeof OVER_AR | null {
  if (gap === null || gap === undefined || !Number.isFinite(gap) || gap === 0) return null;
  return gap > 0 ? SHORT_AR : OVER_AR;
}

/**
 * The answer's own word — «اعتُمد رقم الشركة» · «رقمنا هو المعتمد» · «قيد المراجعة» · «طلب تبديل» — or null while nobody has answered.
 *
 * «طلب تبديل» is the courier's figure with a reason (`isExchange`: `resolution` is `ACCEPTED_COURIER` AND the kind is `EXCHANGE`): the
 * same answer for the money, and its own word for the person who reads it — on the mark, in its tooltip and in the dialog — so a
 * replacement is never read as a discount somebody gave. The kind alone says nothing: beside any other answer it is ignored.
 */
export function answerWord(resolution: string | null | undefined, resolutionKind?: string | null): string | null {
  if (!resolution) return null;
  if (isExchange({ resolution, resolutionKind })) return EXCHANGE_AR;
  if ((RESOLUTIONS as readonly string[]).includes(resolution)) return RESOLUTION_AR[resolution as Resolution];
  return resolution === PARKED ? PARKED_AR : ANSWERED_AR;
}

/**
 * THE MARK'S COLOUR, FROM THE ONE PALETTE EVERY VERDICT HERE IS PAINTED WITH: red while nobody has answered; the two money
 * answers are settled news; «قيد المراجعة» (or a saying this screen has no word for) is a look that was postponed.
 */
export function markTone(d: Pick<DifferenceOnTheRow, 'resolution'>): HealthTone {
  if (!d.resolution) return 'bad';
  return (RESOLUTIONS as readonly string[]).includes(d.resolution) ? 'good' : 'ok';
}

/** The mark's first words: the red «فيه فرق», or — once answered — the answer's own word in its place («طلب تبديل» for an exchange). */
export const markHead = (d: Pick<DifferenceOnTheRow, 'resolution' | 'resolutionKind'>): string =>
  answerWord(d.resolution, d.resolutionKind) ?? DIFFERENCE_MARK;

/** The mark's tooltip: what it is, and what pressing it does for THIS person. */
export function markTitle(d: Pick<DifferenceOnTheRow, 'resolution' | 'resolutionKind' | 'closed'>, mayDecide: boolean): string {
  const word = answerWord(d.resolution, d.resolutionKind);
  const first = word ? `انبتّ فيه: ${word}` : 'سطر الشركة بالكشف بيختلف عن رقمنا';
  const closed = d.closed ? ' — الكشف مغلق، فما بيتغيّر' : '';
  const press = mayDecide && !d.closed ? ' — اضغط تشوف الرقمين وتبتّ فيه' : ' — اضغط تشوف الرقمين';
  return `${first}${closed}${press}`;
}

/** Said to the person after an answer went through: the order stays marked either way. */
export const differenceDoneMessage = (ref: string): string => `انبتّ بفرق ${ref} — بيضل الطلب معلَّماً`;
