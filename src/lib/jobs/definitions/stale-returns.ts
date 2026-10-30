import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { createNotification } from '../../notification';
import { activeStores } from './shared';

/**
 * Returns announced by the courier but never physically received, oldest
 * first. A parcel that is "returned" on paper and absent from the shelf is
 * stock we think we have and do not.
 */
export const staleReturns: JobDefinition = {
  name: 'stale-returns',
  everySeconds: 86_400,
  at: '09:00',
  description: 'تنبيه بالمرتجعات المعلنة ولم تُستلم فعلياً',
  async run({ now }): Promise<JobResult> {
    const threshold = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    let flagged = 0;

    for (const store of await activeStores()) {
      const stale = await db.order.findMany({
        where: {
          companyId: store.companyId,
          storeId: store.id,
          shippingStatus: { in: ['RETURN_REQUESTED', 'RETURNED'] },
          returnReceipt: null,
          updatedAt: { lte: threshold },
        },
        orderBy: { updatedAt: 'asc' },
        select: { id: true, orderNumber: true },
        take: 100,
      });
      flagged += stale.length;

      // Once per STORE per day, to whoever receives this store's returns.
      // The check used to be per company, so after the first store nobody
      // else heard about theirs that day.
      if (stale.length > 0) {
        const today = now.toISOString().slice(0, 10);
        const already = await db.notification.findFirst({
          where: {
            companyId: store.companyId,
            storeId: store.id,
            type: 'RETURNS_NOT_RECEIVED',
            createdAt: { gte: new Date(`${today}T00:00:00.000Z`) },
          },
          select: { id: true },
        });
        if (!already) {
          await createNotification({
            companyId: store.companyId,
            storeId: store.id,
            audience: { permission: 'ops.returns' },
            title: 'مرتجعات لم تُستلم',
            message: `${stale.length} مرتجعاً معلناً لم يُستلم فعلياً — أقدمها ${stale[0].orderNumber}`,
            type: 'RETURNS_NOT_RECEIVED',
            link: '/ops/returns',
          });
        }
      }
    }

    return { processed: flagged, detail: flagged ? `${flagged} مرتجعاً بانتظار الاستلام` : 'لا مرتجعات عالقة' };
  },
};
