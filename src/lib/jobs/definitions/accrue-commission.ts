import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { accrueForOrder } from '../../commission';
import { SKIP_AR, activeStores } from './shared';

/**
 * Commission is earned on delivery. Until this ran on a schedule it only
 * accrued when somebody pressed a button, which meant a month could close
 * with nothing calculated.
 */
export const accrueCommission: JobDefinition = {
  name: 'accrue-commission',
  everySeconds: 86_400,
  // After the day's deliveries have settled, not at whatever hour the
  // server last restarted at.
  at: '23:00',
  description: 'احتساب عمولات الطلبات المسلَّمة',
  async run(): Promise<JobResult> {
    let created = 0;
    const skipped: Record<string, number> = {};

    for (const store of await activeStores()) {
      const orders = await db.order.findMany({
        where: {
          companyId: store.companyId,
          storeId: store.id,
          shippingStatus: 'DELIVERED',
          commissions: { none: {} },
          // Imported history (scripts/migration) was paid in the old system
          // and names nobody here, so it never accrues — and 10,391 such rows
          // would fill this 500-row batch every night, ahead of the real
          // deliveries still waiting for theirs.
          source: { not: 'Legacy import' },
        },
        select: { id: true },
        take: 500,
      });

      for (const order of orders) {
        const result = await db.$transaction((tx) =>
          accrueForOrder(tx, {
            companyId: store.companyId,
            orderId: order.id,
            minorUnit: store.country.minorUnit,
          })
        );
        created += result.created;
        if (result.skipped) skipped[result.skipped] = (skipped[result.skipped] ?? 0) + 1;
      }
    }

    // Say WHY nothing accrued. "No commissions" reads like a quiet day; "112
    // orders have no rule covering them" is someone forgetting to write one.
    const reasons = Object.entries(skipped)
      .map(([reason, count]) => `${count} ${SKIP_AR[reason] ?? reason}`)
      .join(' · ');

    return {
      processed: created,
      detail: created
        ? `احتُسبت ${created} عمولة${reasons ? ` · ${reasons}` : ''}`
        : reasons || 'لا طلبات مسلَّمة بانتظار الاحتساب',
    };
  },
};
