import type { JobDefinition, JobResult } from '../runner';
import { refreshExchangeRates } from '../../exchange-rates';

/**
 * «سعر الصرف التلقائي» (23/11, F8) — THE DAILY FETCH OF THE RATES.
 *
 * Once a day (no clock time: a daily job with one is asked about every 45 s), the fiat rates and the price of USDT are read from two
 * public sources that need no key (`exchange-rates.ts`). The request carries no business data. A source that fails keeps its last
 * good value; the screens flag a rate older than three days. The gate inside (`mayTryNow`) holds «once a day» even if the worker runs
 * the job twice. Nothing else is written: no movement, no wallet, no profit — a rate is used only when a person saves a draw.
 */
export const refreshExchangeRatesJob: JobDefinition = {
  name: 'refresh-exchange-rates',
  everySeconds: 86_400,
  description: 'جلب سعر الصرف اليومي (العملات والـUSDT) من الإنترنت',
  async run({ now }): Promise<JobResult> {
    const out = await refreshExchangeRates({ now });
    if (!out.tried) return { processed: 0, detail: 'انجلب السعر من أقل من يوم' };
    const word = (s: string) => (s === 'ok' ? 'انجلب' : 'فشل — بقي آخر سعر');
    return { processed: (out.fiat === 'ok' ? 1 : 0) + (out.usdt === 'ok' ? 1 : 0), detail: `العملات: ${word(out.fiat)} · USDT: ${word(out.usdt)}` };
  },
};
