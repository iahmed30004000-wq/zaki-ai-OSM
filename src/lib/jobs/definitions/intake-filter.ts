import type { JobDefinition, JobResult } from '../runner';
import { sweepIntake } from '../../intake-filter';
import { activeStores } from './shared';

/**
 * «فلتر الاستقبال»: وسم الطلب المكرر والرقم المشكوك (الخطوة C1).
 *
 * The rule and the writer are `intake-filter.ts`; this is the scheduler's clock for it. The pull makes the same pass right before it picks, so nothing waits on this
 * job to be correct — it exists so a flag is already on the order when somebody opens it. A company whose switch is off costs one cached read and writes nothing.
 * Idempotent: an order already flagged for a kind is not flagged for it again.
 */
export const intakeFilter: JobDefinition = {
  name: 'intake-filter',
  // Not 60: the heartbeat watches exactly the 60-second jobs (heartbeat.ts), and a flag that is a minute late costs nothing.
  everySeconds: 120,
  description: 'وسم الطلب المكرر والرقم المشكوك عند الاستقبال',
  async run({ now }): Promise<JobResult> {
    let flagged = 0;
    for (const store of await activeStores()) {
      flagged += await sweepIntake({ companyId: store.companyId, storeId: store.id, countryCode: store.country?.code }, now);
    }
    return { processed: flagged, detail: flagged ? `وُسم ${flagged} طلباً عند الاستقبال` : 'لا طلب يحتاج وسماً' };
  },
};
