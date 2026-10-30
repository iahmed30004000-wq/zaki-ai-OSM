import type { JobDefinition, JobResult } from '../runner';
import { dueConversions, deliverConversion } from '../../conversions/emit';

/**
 * SENDING THE CONVERSIONS THE ORDERS OWE.
 *
 * The other half of the same idea as the job above, to a different kind of
 * receiver. An order reaching a moment the seller marked as a conversion
 * wrote a row; this sends it to Meta.
 *
 * Kept apart from deliver-app-events on purpose. A webhook goes to a server
 * we know nothing about and is allowed to be slow or broken; Meta is one
 * endpoint with its own rate limits, and a shop's own integrations failing
 * must not stop its advertising from being told what it sold.
 */
export const deliverConversions: JobDefinition = {
  name: 'deliver-conversions',
  everySeconds: 60,
  description: 'إرسال التحويلات المخصّصة إلى ميتا',
  async run(): Promise<JobResult> {
    const due = await dueConversions(50);
    if (due.length === 0) return { processed: 0, detail: 'لا تحويلات معلّقة' };

    let ok = 0;
    for (const d of due) {
      // One at a time. Fifty parallel calls is the fastest way to meet
      // Meta's rate limit, and a rate limit costs every shop on this
      // deployment, not only the busy one.
      if (await deliverConversion(d.id)) ok++;
    }
    return { processed: due.length, detail: `أُرسل ${ok} من ${due.length}` };
  },
};
