/**
 * THE COMPANY'S WORDS AS A PERSON SAYS THEM ABOUT A PARCEL — one list for the screens that count or filter by them.
 *
 * The keys are `CourierOutcome` (`couriers/words`), the reading of a status cell through the one phrase table; `NONE` is a line
 * whose status cell was empty. The summary at the top of the matching screen (`StatementTally`) and the filter above each queue
 * (`QueueTools`) name the same kinds, so the two cannot name one of them differently.
 */
export const COMPANY_WORD_AR: Record<string, string> = {
  DELIVERED: 'سُلِّمت',
  PARTIAL: 'سُلِّمت جزئياً',
  RETURNED: 'رجعت',
  POSTPONED: 'مؤجَّلة',
  CANCELLED: 'مُلغاة',
  IN_TRANSIT: 'ما زالت عند الشركة',
  OTHER: 'كلمة معروفة أخرى',
  UNKNOWN: 'كلمة ما نعرفها بعد',
  NONE: 'بلا كلمة',
};

/** The order a list of kinds is drawn in: what was delivered first, what nobody knows last. */
export const COMPANY_WORD_ORDER = ['DELIVERED', 'PARTIAL', 'RETURNED', 'POSTPONED', 'CANCELLED', 'IN_TRANSIT', 'OTHER', 'UNKNOWN', 'NONE'];
