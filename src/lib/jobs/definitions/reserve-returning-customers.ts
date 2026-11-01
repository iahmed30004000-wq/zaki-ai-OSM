import type { JobDefinition, JobResult } from '../runner';
import { reserveReturningCustomers } from '../../reserve-returning-customers';
import { activeStores } from './shared';

/**
 * A returning customer's new order is held for the agent who worked him last.
 *
 * The rule is `order-reservation.ts` and the writer is `reserve-returning-customers.ts`; this is the minute's clock for
 * it. The pull, the queue read and the claim door make the same hold at the moment somebody is about to take an order, so
 * nothing waits on this job to be correct — it exists so the order is already in the agent's «الطلبات», with her name on it,
 * when she opens it, whether or not anybody has pulled.
 *
 * Idempotent: an order already held, claimed or past its first day is not touched, so a run that finds nothing new writes
 * nothing.
 */
export const reserveReturning: JobDefinition = {
  name: 'reserve-returning-customers',
  // Not 60: the heartbeat watches exactly the 60-second jobs (heartbeat.ts), and a hold that is a minute late costs nothing —
  // the pull, the queue read and the claim door make it at the moment it matters.
  everySeconds: 120,
  description: 'حجز طلب الزبون الراجع للموظفة التي تعاملت معه قبل',
  async run({ now }): Promise<JobResult> {
    let held = 0;
    for (const store of await activeStores()) {
      held += await reserveReturningCustomers({ companyId: store.companyId, storeId: store.id }, now);
    }
    return { processed: held, detail: held ? `حُجز ${held} طلباً لموظفاتها` : 'لا طلب جديد لزبون راجع' };
  },
};
