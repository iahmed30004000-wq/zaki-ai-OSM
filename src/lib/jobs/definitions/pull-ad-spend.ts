import type { JobDefinition, JobResult } from '../runner';
import { syncAdSpend, type SpendSyncResult } from '../../ads/sync';
import { activeStores } from './shared';

/**
 * HOW LONG THE JOB WAITS BEFORE ASKING AGAIN FOR A STORE THAT FAILED.
 *
 * A platform that answers «too many requests», drops the connection or has a
 * bad minute is not a platform that is gone. The job runs once a day at 06:00,
 * and a day's schedule does not run again the same day (a failed run counts as
 * today's run), so one such minute at 06:00 meant a day of campaigns with
 * yesterday's cost — and a «green» run that only said so in its detail line.
 *
 * Two more tries, spaced out: a rate limit needs minutes, not seconds.
 */
const RETRY_WAITS_MS = [90_000, 300_000] as const;

/**
 * The retries stop starting after this long. The runner treats a RUNNING row
 * older than STALE_RUN_MINUTES (30) as abandoned and lets another worker take
 * the job, so a slow store must never push the job past that line.
 */
const RETRY_BUDGET_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Store = Awaited<ReturnType<typeof activeStores>>[number];

const errorsOf = (result: SpendSyncResult) =>
  result.accounts.filter((a) => a.error).map((a) => `${a.account}: ${a.error}`);

/**
 * Yesterday's ad spend, pulled before anybody arrives.
 *
 * It used to happen only when somebody opened the campaigns screen, so a
 * shop whose owner did not look for a week showed a week of campaigns whose
 * profit was computed from a cost of zero — the single number the system
 * cannot witness for itself, missing, while every number beside it was
 * exact.
 *
 * A store with an account that failed is asked again (see RETRY_WAITS_MS); a
 * store that came through is not asked twice. The sync is idempotent — a
 * campaign whose spend did not change is not written — so asking a store again
 * costs calls, never wrong numbers.
 */
export const pullAdSpend: JobDefinition = {
  name: 'pull-ad-spend',
  everySeconds: 86_400,
  // Early, so the morning's first look at profit is a true one.
  at: '06:00',
  description: 'سحب الإنفاق الإعلاني من المنصات المربوطة',
  async run(): Promise<JobResult> {
    const started = Date.now();
    let updated = 0;
    let passes = 1;

    // What each store still owes after its latest pass; absent = it came through.
    const failing = new Map<string, { store: Store; errors: string[] }>();

    const ask = async (store: Store) => {
      const result = await syncAdSpend({ companyId: store.companyId, storeId: store.id });
      updated += result.updated;
      // One account's expired token must not hide behind a green run.
      const errors = errorsOf(result);
      if (errors.length) failing.set(store.id, { store, errors });
      else failing.delete(store.id);
    };

    for (const store of await activeStores()) await ask(store);

    for (const wait of RETRY_WAITS_MS) {
      if (failing.size === 0) break;
      if (Date.now() - started + wait > RETRY_BUDGET_MS) break;
      await sleep(wait);
      passes++;
      for (const { store } of [...failing.values()]) await ask(store);
    }

    const errors = [...failing.values()].flatMap((f) => f.errors);
    const tried = passes > 1 ? ` · بعد ${passes} محاولات` : '';

    return {
      processed: updated,
      detail: errors.length
        ? `حُدِّثت ${updated} حملة · ${errors.length} حساب بخطأ${tried}: ${errors.slice(0, 2).join(' · ')}`
        : updated
          ? `حُدِّثت ${updated} حملة${passes > 1 ? ` (بعد ${passes} محاولات)` : ''}`
          : 'لا تغيير في الإنفاق',
    };
  },
};
