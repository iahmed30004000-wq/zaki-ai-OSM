import type { JobDefinition, JobResult } from '../runner';
import { dueDeliveries, deliverOne } from '../../apps/events';

/**
 * Telling apps what happened.
 *
 * Delivery is never inline with the event: an order must not fail to save
 * because somebody's server is down. The row is written when it happens and
 * sent from here, so a developer's outage costs them a delay and costs the
 * seller nothing.
 */
export const deliverAppEvents: JobDefinition = {
  name: 'deliver-app-events',
  everySeconds: 60,
  description: 'إرسال أحداث الطلبات إلى التطبيقات المثبَّتة',
  async run(): Promise<JobResult> {
    const due = await dueDeliveries(50);
    if (due.length === 0) return { processed: 0, detail: 'لا إشعارات معلّقة' };

    let ok = 0;
    for (const d of due) {
      // One at a time: fifty parallel requests to fifty unknown servers is
      // a good way to exhaust this process's sockets on somebody else's
      // slow endpoint.
      if (await deliverOne(d.id)) ok++;
    }
    return {
      processed: due.length,
      detail: `أُرسل ${ok} من ${due.length}`,
    };
  },
};
