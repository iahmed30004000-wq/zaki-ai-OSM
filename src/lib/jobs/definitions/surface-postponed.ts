import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { createNotification } from '../../notification';
import { resolveAudience } from '../../notification-audience';
import { activeStores } from './shared';

/**
 * Postponed orders coming due, surfaced before the date rather than after.
 *
 * To the agent holding the order and this store's confirmation supervisors
 * — the two people the postponed screen shows it to — and linked to that
 * screen. (The old link, /orders?highlight=…, was read by nothing.)
 *
 * Idempotent per order AND date: the message carries both, so an order
 * postponed again to a new date is announced again, and one already
 * announced for this date is not. Legacy rows (no store) count too, so the
 * first run after the per-recipient change does not repeat what was
 * already said.
 */
export const surfacePostponed: JobDefinition = {
  name: 'surface-postponed',
  everySeconds: 86_400,
  // First thing, so a postponed order is on somebody's desk when they
  // sit down rather than discovered at four in the afternoon.
  at: '08:00',
  description: 'تنبيه بالطلبات المؤجَّلة التي حان موعدها',
  async run({ now }): Promise<JobResult> {
    const horizon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    let notified = 0;

    for (const store of await activeStores()) {
      const due = await db.order.findMany({
        where: {
          companyId: store.companyId,
          storeId: store.id,
          confirmationStatus: 'POSTPONED',
          postponedUntil: { not: null, lte: horizon },
        },
        select: { id: true, orderNumber: true, postponedUntil: true, claimedById: true },
        take: 200,
      });

      if (due.length === 0) continue;

      // Everyone this store's announcements go to, resolved ONCE for the
      // store — supervisors, and every agent holding one of these orders —
      // rather than the full audience lookup again for each of up to two
      // hundred orders.
      const people = await resolveAudience({
        companyId: store.companyId,
        storeId: store.id,
        audience: { userIds: due.map((o) => o.claimedById) },
      });
      const supervisors = await resolveAudience({
        companyId: store.companyId,
        storeId: store.id,
        audience: { permission: 'confirmation.supervise' },
      });
      const byId = new Map(people.map((u) => [u.id, u]));

      for (const order of due) {
        const message = `الطلب ${order.orderNumber} مؤجَّل حتى ${order.postponedUntil?.toISOString().slice(0, 10)}`;
        // Only a PERSONAL row counts as "already told". A row from before
        // stage 17 is history nobody but a supervisor can see, and counting
        // it would leave the agent holding the order never told at all.
        const already = await db.notification.findFirst({
          where: {
            companyId: store.companyId,
            type: 'POSTPONED_DUE',
            message,
            userId: { not: null },
            storeId: store.id,
          },
          select: { id: true },
        });
        if (already) continue;

        const holder = order.claimedById ? byId.get(order.claimedById) : undefined;
        const told = await createNotification({
          companyId: store.companyId,
          storeId: store.id,
          audience: {},
          recipients: holder ? [...supervisors, holder] : supervisors,
          title: 'طلب مؤجَّل حان موعده',
          message,
          type: 'POSTPONED_DUE',
          // The supervisor's «المتابعة»; an agent's postponed orders are a tab of «طلباتي».
          link: ['/confirmation/follow-up', '/confirmation/mine?tab=postponed'],
        });
        if (told) notified++;
      }
    }

    return { processed: notified, detail: notified ? `${notified} طلباً مؤجَّلاً حان موعده` : 'لا مؤجَّلات مستحقة' };
  },
};
