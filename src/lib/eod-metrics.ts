/**
 * The six figures of the end-of-day report and their Arabic names — a file with NO imports, so the form in the browser can read them without pulling the server library
 * (`eod-report.ts`: calendar, workflow, phone rules, the database) into its bundle.
 */
export const EOD_METRICS = ['claims', 'confirmed', 'rejected', 'noAnswer', 'winback', 'stuck'] as const;
export type EodMetric = (typeof EOD_METRICS)[number];

export const EOD_METRIC_AR: Record<EodMetric, string> = {
  claims: 'سحب',
  confirmed: 'تأكيد',
  rejected: 'رفض',
  noAnswer: 'محاولات لا يرد',
  winback: 'اتصالات استرجاع',
  stuck: 'عالق أكتر من 48 ساعة',
};

/** The longest «biggest problem» or «tip» she may write. */
export const MAX_TEXT = 500;

/** A date as YYYY-MM-DD in the browser's own local day — what a date box and the report's «yesterday» speak (the SERVER still decides which day a report may be for, by the store's clock). */
export function localIsoDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
