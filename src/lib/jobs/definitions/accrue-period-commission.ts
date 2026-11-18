import { SPANS, accrueForPeriod, lastClosedSpan } from '../../commission-period';
import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { SKIP_AR, activeStores } from './shared';

/**
 * Commission that only a closed span can answer.
 *
 * "150 confirmed in a day" is not a fact about any one order, so it cannot
 * be accrued at delivery like the rest. This runs after each span has
 * closed and writes one entry per person per rule, carrying the span it
 * covers and what was counted in it.
 *
 * It always works on the span that has ENDED, never the running one: a
 * figure that the next order changes is not a record of anything. Running
 * twice is safe — the database holds one entry per person, rule and span.
 */
export const accruePeriodCommission: JobDefinition = {
  name: 'accrue-period-commission',
  everySeconds: 3_600,
  description: 'احتساب عمولات الشرائح للفترات المنتهية',
  async run(): Promise<JobResult> {
    let created = 0;
    let amount = 0;
    const skipped: Record<string, number> = {};
    const now = new Date();

    /*
     * NOT A BENCH STORE (B2, 18/11 — `test-store.ts`). A period rule can count CONFIRMATIONS («150 مؤكَّد باليوم»), and a
     * bench order is confirmed and then goes nowhere: paying for it is paying for a test. Every other accrual waits for
     * DELIVERED (`accrueForOrder`), which a bench order never reaches, so this is the one place commission could be
     * earned on one. The figure of a real store is untouched: the rule, the count and the sum are the same functions.
     */
    for (const store of (await activeStores()).filter((s) => !s.isTest)) {
      for (const span of SPANS) {
        const { start, end } = lastClosedSpan(span, now);
        const result = await db.$transaction((tx) =>
          accrueForPeriod(tx, {
            companyId: store.companyId,
            storeId: store.id,
            span,
            start,
            end,
            minorUnit: store.country.minorUnit,
            currencyCode: store.country.currencyCode,
          })
        );
        created += result.created;
        amount += result.amount;
        for (const [why, n] of Object.entries(result.skipped)) skipped[why] = (skipped[why] ?? 0) + n;
      }
    }

    const reasons = Object.entries(skipped)
      .map(([reason, count]) => `${count} ${SKIP_AR[reason] ?? reason}`)
      .join(' · ');

    return {
      processed: created,
      detail: created
        ? `احتُسبت ${created} عمولة فترة بمجموع ${amount.toFixed(2)}${reasons ? ` · ${reasons}` : ''}`
        : reasons || 'لا قواعد فترات مستحقة',
    };
  },
};
