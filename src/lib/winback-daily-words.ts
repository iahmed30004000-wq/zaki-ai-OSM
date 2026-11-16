/**
 * The words and the fixed figures of the daily winback list (Confirmation Center v2, step F) — a file with NO imports, so the list in the browser reads them without pulling the server
 * library (database, winback rule, phone) into its bundle.
 */

/** A lost order or a missed date is called no sooner than this long after it happened… */
export const DAILY_FROM_HOURS = 24;
/** …and no later than this long after: past it the list lets it go. */
export const DAILY_TO_HOURS = 72;

/** The reasons the daily list calls about: a changed mind, a price, and five unanswered calls (three, while the old rule is the one in force). */
export const DAILY_REASONS = ['CUSTOMER_CHANGED_MIND', 'PRICE_TOO_HIGH', 'NO_ANSWER_5_ATTEMPTS', 'NO_ANSWER_3_ATTEMPTS'] as const;

/** What a call came to — the result that is tracked. */
export const CALL_RESULTS = ['NO_ANSWER', 'DECLINED', 'AGREED', 'CALL_LATER'] as const;
export type CallResult = (typeof CALL_RESULTS)[number];

export const CALL_RESULT_AR: Record<CallResult, string> = {
  NO_ANSWER: 'ما ردّ',
  DECLINED: 'رفض',
  AGREED: 'وافق',
  CALL_LATER: 'بدو اتصال لاحقاً',
};

export type DailyKind = 'LOST' | 'MISSED_POSTPONED';

export const DAILY_KIND_AR: Record<DailyKind, string> = {
  LOST: 'طلب ملغى',
  MISSED_POSTPONED: 'مؤجّل فات موعدو',
};

/** The longest note that goes with a call. */
export const MAX_CALL_NOTE = 200;
