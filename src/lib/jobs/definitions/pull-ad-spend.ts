import type { JobDefinition, JobResult } from '../runner';
import { syncAdSpend } from '../../ads/sync';
import { activeStores } from './shared';

/**
 * Yesterday's ad spend, pulled before anybody arrives.
 *
 * It used to happen only when somebody opened the campaigns screen, so a
 * shop whose owner did not look for a week showed a week of campaigns whose
 * profit was computed from a cost of zero — the single number the system
 * cannot witness for itself, missing, while every number beside it was
 * exact.
 */
export const pullAdSpend: JobDefinition = {
  name: 'pull-ad-spend',
  everySeconds: 86_400,
  // Early, so the morning's first look at profit is a true one.
  at: '06:00',
  description: 'سحب الإنفاق الإعلاني من المنصات المربوطة',
  async run(): Promise<JobResult> {
    let updated = 0;
    const errors: string[] = [];

    for (const store of await activeStores()) {
      const result = await syncAdSpend({ companyId: store.companyId, storeId: store.id });
      updated += result.updated;
      for (const account of result.accounts) {
        // One account's expired token must not hide behind a green run.
        if (account.error) errors.push(`${account.account}: ${account.error}`);
      }
    }

    return {
      processed: updated,
      detail: errors.length
        ? `حُدِّثت ${updated} حملة · ${errors.length} حساب بخطأ: ${errors.slice(0, 2).join(' · ')}`
        : updated
          ? `حُدِّثت ${updated} حملة`
          : 'لا تغيير في الإنفاق',
    };
  },
};
