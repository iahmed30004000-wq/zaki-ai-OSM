import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { releaseStaleClaims } from '../../confirmation-queue';
import { activeStores } from './shared';

/**
 * Claims held with no contact attempt past the business-minute cap go back
 * to the pool. Business-hours aware, so a claim taken at 4pm is not released
 * overnight for sitting through hours nobody was working.
 */
export const releaseClaims: JobDefinition = {
  name: 'release-stale-claims',
  everySeconds: 300,
  description: 'إعادة الطلبات المحجوزة بلا محاولة اتصال إلى المخزن المشترك',
  async run({ now }): Promise<JobResult> {
    let released = 0;
    for (const store of await activeStores()) {
      const count = await db.$transaction((tx) =>
        releaseStaleClaims(
          tx,
          { companyId: store.companyId, storeId: store.id },
          {
            workHoursStart: store.country.workHoursStart,
            workHoursEnd: store.country.workHoursEnd,
            weekendDays: store.country.weekendDays,
            timezone: store.country.timezone,
          },
          now
        )
      );
      released += count;
    }
    return { processed: released, detail: released ? `حُرِّر ${released} طلباً` : 'لا طلبات متأخرة' };
  },
};
