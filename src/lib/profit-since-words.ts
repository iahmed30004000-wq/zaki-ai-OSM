import { arDate } from './format';

/**
 * WHERE THE PROFIT STARTS, IN THE WORDS BOTH SCREENS PRINT (25/11, A1).
 *
 * The profit screen and the partners' card name the same start — the day of the store's first courier statement — so the sentence
 * lives once, here. The day arrives as the store writes it (YYYY-MM-DD) and is printed at its own noon, so no reader's clock can move
 * it to the day before or after.
 */

/** «28 أكتوبر 2026» — the store's day, Western digits. */
export function sinceDate(day: string): string {
  return arDate(`${day}T12:00:00`);
}

/** The sentence beside the figures. */
export function profitSinceSentence(day: string): string {
  return `الأرباح محسوبة من ${sinceDate(day)} — يوم أول كشف مرفوع`;
}

/** Said when the picked span starts before that day: the days before it add nothing. */
export function earlierDaysNote(day: string): string {
  return `الأيام قبل ${sinceDate(day)} ما بتنحسب بالأرباح.`;
}

/** Does a picked span (its first day, YYYY-MM-DD) start before the profit's start? */
export function startsBefore(from: string | null | undefined, sinceDay: string | null | undefined): boolean {
  return !!from && !!sinceDay && from < sinceDay;
}
