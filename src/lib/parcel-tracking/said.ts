import type { HealthTone } from '../health';
import { SAID_STATUSES, type SaidStatus } from '../couriers/courier-said';
import { COMPANY_WORD_AR } from '../couriers/word-names';
import { arabicDays } from '../transit';

/**
 * «الشركة بتقول» — WHAT THE LIST SAYS ABOUT THE COMPANY'S OWN WORD, IN ONE PLACE.
 *
 * The poll keeps what the company says about a parcel (`couriers/courier-said`), and `couriers/courier-said-read` turns
 * the newest line into the finished object the server puts on each row. The screen only draws it: this module is the
 * words, the tones and the age it draws it with, and it reaches no server module (the screen reads it).
 *
 * The filter's words are the matching screens' own (`COMPANY_WORD_AR`: «سُلِّمت», «رجعت», …) so the two lists that ask
 * «what does the company say» name the same five things in the same way.
 */

/** The row's field, as it travels: the server's `CourierSaid` with its date written out. */
export interface SaidOnTheRow {
  status: SaidStatus;
  label: string;
  note: string | null;
  at: string;
  ageMinutes: number;
}

export const SAID_PREFIX = 'الشركة بتقول';

/**
 * The tone of each word, from the one palette every verdict here is painted with. «تم التوصيل» is news worth having;
 * «رجعت» and «ملغاة» are bad news; a part delivery and «مؤجلة» ask for a look — the first one for an act that cannot
 * wait for the statement (`SAID_PARTIAL_HINT`).
 */
export const SAID_TONE: Record<SaidStatus, HealthTone> = {
  DELIVERED: 'good',
  PARTIALLY_DELIVERED: 'ok',
  RETURNED: 'bad',
  CANCELLED: 'bad',
  FAILED_DELIVERY: 'ok',
};

/** The five choices of the filter, in the order they are drawn, named as the matching screens name them. */
export const SAID_OPTION_AR: Record<SaidStatus, string> = {
  DELIVERED: COMPANY_WORD_AR.DELIVERED,
  PARTIALLY_DELIVERED: COMPANY_WORD_AR.PARTIAL,
  RETURNED: COMPANY_WORD_AR.RETURNED,
  CANCELLED: COMPANY_WORD_AR.CANCELLED,
  FAILED_DELIVERY: COMPANY_WORD_AR.POSTPONED,
};

/** What the numbers beside the filter are before the server has answered — or when an old answer carries none. */
export const NO_SAID_COUNTS: Record<SaidStatus, number> = Object.fromEntries(SAID_STATUSES.map((s) => [s, 0])) as Record<SaidStatus, number>;

/**
 * A part delivery must be recorded AT THE DOOR before the statement closes: the company's word gives no lines and no
 * amounts, and a statement that closes first settles the parcel as if it had come whole.
 */
export const SAID_PARTIAL_HINT = 'سجّلي «استلم جزءاً» بالبنود';

/** The chip: «الشركة بتقول: تم التوصيل». The words after the colon are the company's name for its code. */
export const saidChipLabel = (said: Pick<SaidOnTheRow, 'label'>): string => `${SAID_PREFIX}: ${said.label}`;

/** The extra line a part delivery carries; every other word carries none. */
export const saidHint = (said: Pick<SaidOnTheRow, 'status'>): string | null => (said.status === 'PARTIALLY_DELIVERED' ? SAID_PARTIAL_HINT : null);

interface Counted {
  one: string;
  two: string;
  few: string;
  many: string;
}
const MINUTES: Counted = { one: 'دقيقة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقة' };
const HOURS: Counted = { one: 'ساعة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' };
const counted = (n: number, w: Counted): string => (n === 1 ? w.one : n === 2 ? w.two : `${n} ${n >= 3 && n <= 10 ? w.few : w.many}`);

/**
 * HOW OLD THE WORD IS, SHORT AND SPOKEN — «قبل ساعتين». Counted by the server (`ageMinutes`, its clock), said here:
 * the screen reads no clock of its own. Floored, as every age here is, so «قبل 3 ساعات» is never printed about two and
 * a half.
 */
export function saidAge(minutes: number): string {
  const m = Number.isFinite(minutes) ? Math.max(0, Math.floor(minutes)) : 0;
  if (m < 1) return 'قبل لحظات';
  if (m < 60) return `قبل ${counted(m, MINUTES)}`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `قبل ${counted(hours, HOURS)}`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'قبل يوم' : `قبل ${arabicDays(days)}`;
}

/** The line under the chip: how old the word is, then the company's own note when it wrote one. */
export const saidWhen = (said: Pick<SaidOnTheRow, 'ageMinutes' | 'note'>): string =>
  said.note ? `${saidAge(said.ageMinutes)} · «${said.note}»` : saidAge(said.ageMinutes);

/** The chip's tooltip: the note first, then the plain fact that nothing about the order has changed because of it. */
export const saidTitle = (said: Pick<SaidOnTheRow, 'ageMinutes' | 'note'>): string =>
  `${said.note ? `ملاحظة الشركة: «${said.note}» — ` : ''}قالتها الشركة ${saidAge(said.ageMinutes)} — حالة الطلب عندنا ما تغيّرت، والكشف أو اللي سلّم الطرد هو اللي بيكتبها`;
