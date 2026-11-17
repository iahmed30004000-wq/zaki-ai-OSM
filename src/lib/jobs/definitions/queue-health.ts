import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { createNotification } from '../../notification';
import { queuePrioritySwitch } from '../../queue-priority-switch';
import { readQueueHealth } from '../../queue-health';
import { healthAlerts } from '../../queue-health-words';
import { activeStores } from './shared';

/**
 * «صحة الطابور»: ينبّه المشرف والمالك لما الطابور يتعطّل أو يفوت الحد (الخطوة D2).
 *
 * The rules and the reads are `queue-health-words.ts` and `queue-health.ts`; this is the scheduler's clock for them. Only a company whose «أولوية الطابور» key is ON is read at all
 * (a cached read, nothing written otherwise). A kind of alert is told ONCE per store per two hours — the next pass finds the earlier notification and stays quiet — to the
 * supervisors of the store and the company admin. It writes notifications and nothing else: no order, no claim, no release.
 */
export const queueHealthJob: JobDefinition = {
  name: 'queue-health',
  everySeconds: 300,
  description: 'تنبيه المشرف والمالك لما الطابور يتعطّل أو ينفلت',
  async run({ now }): Promise<JobResult> {
    let told = 0;
    for (const store of await activeStores()) {
      if (!(await queuePrioritySwitch(db, store.companyId, now.getTime())).enabled) continue;
      const cal = {
        workHoursStart: store.country.workHoursStart,
        workHoursEnd: store.country.workHoursEnd,
        weekendDays: store.country.weekendDays,
        timezone: store.country.timezone,
      };
      const health = await readQueueHealth(db, { companyId: store.companyId, storeId: store.id }, cal, now);
      for (const alert of healthAlerts(health)) {
        const link = '/confirmation/queue';
        const already = await db.notification.findFirst({
          where: { companyId: store.companyId, storeId: store.id, type: 'SYSTEM_ALERT', title: alert.title, link, createdAt: { gte: new Date(now.getTime() - 2 * 3_600_000) } },
          select: { id: true },
        });
        if (already) continue;
        told += await createNotification({
          companyId: store.companyId,
          storeId: store.id,
          audience: { permission: 'confirmation.supervise', roles: ['COMPANY_ADMIN'] },
          title: alert.title,
          message: alert.message,
          type: 'SYSTEM_ALERT',
          link,
        });
      }
    }
    return { processed: told, detail: told ? `نُبّه ${told} شخص بصحة الطابور` : 'الطابور سليم' };
  },
};
