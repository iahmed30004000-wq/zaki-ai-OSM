import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { createNotification } from '../../notification';

/**
 * A change request nobody has answered past its deadline.
 *
 * The deadline column and the escalation column were both built and nothing
 * ever wrote to either: a request could sit PENDING for a week, blocking
 * the order it was raised on, and the only sign was a red row on a screen
 * somebody had to think to open.
 *
 * It escalates. It NEVER decides — silence is not consent, and a change to
 * a customer's order approved because a manager was on holiday is a change
 * nobody made.
 */
export const escalateChangeRequests: JobDefinition = {
  name: 'escalate-change-requests',
  everySeconds: 60,
  description: 'تصعيد طلبات التعديل التي تجاوزت مهلتها بلا قرار',
  async run({ now }): Promise<JobResult> {
    const due = await db.orderChangeRequest.findMany({
      where: { status: 'PENDING', escalatedAt: null, slaDueAt: { not: null, lt: now } },
      select: {
        id: true, companyId: true, reason: true, slaDueAt: true,
        order: { select: { id: true, orderNumber: true, storeId: true } },
      },
      take: 100,
    });
    if (due.length === 0) return { processed: 0, detail: 'لا طلبات تجاوزت مهلتها' };

    for (const request of due) {
      // Stamped BEFORE the notification: a failure to send must not make
      // this fire again every minute for the rest of the day.
      await db.orderChangeRequest.update({ where: { id: request.id }, data: { escalatedAt: now } });

      await createNotification({
        companyId: request.companyId,
        storeId: request.order.storeId,
        audience: { permission: 'control.change_requests' },
        type: 'SYSTEM_ALERT',
        title: 'طلب تعديل تجاوز مهلته',
        message:
          `الطلب ${request.order.orderNumber} — طلب تعديل بلا قرار بعد انتهاء المهلة. ` +
          'لا يُعتمَد تلقائياً: الصمت ليس موافقة.',
        link: '/control/change-requests',
      });
    }

    return { processed: due.length, detail: `${due.length} طلب تعديل صُعِّد` };
  },
};
