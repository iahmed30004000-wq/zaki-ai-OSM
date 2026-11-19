import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { DESK_REFUSAL_KEEP_DAYS, pruneDeskRefusalsOnce } from '../../desk-refusals';

/** One pass deletes at most this many rows; a run makes at most `PASSES` passes, so no run holds the table for long. */
export const PRUNE_DESK_REFUSALS_BATCH = 5_000;
export const PRUNE_DESK_REFUSALS_PASSES = 20;

/**
 * «سجل الرفض» — A REFUSAL IS KEPT 90 DAYS.
 *
 * The rows of `desk_refusals` (`desk-refusals.ts`) are evidence that a desk rule caught somebody; the rules page counts a day or a
 * week of them, never a season. Older rows are deleted in bounded passes (`PRUNE_DESK_REFUSALS_BATCH` × `PRUNE_DESK_REFUSALS_PASSES`)
 * so a backlog is cleared over a few nights instead of in one long statement. Idempotent: a second run the same day finds nothing.
 * The table missing (rolled back) fails the run with its error in the run log, and touches nothing else.
 */
export const pruneDeskRefusals: JobDefinition = {
  name: 'prune-desk-refusals',
  everySeconds: 86_400,
  description: `حذف سطور سجل رفض مكتب التأكيد الأقدم من ${DESK_REFUSAL_KEEP_DAYS} يوم`,
  async run({ now }): Promise<JobResult> {
    let removed = 0;
    for (let pass = 0; pass < PRUNE_DESK_REFUSALS_PASSES; pass++) {
      const count = await pruneDeskRefusalsOnce(db, now, PRUNE_DESK_REFUSALS_BATCH);
      removed += count;
      if (count < PRUNE_DESK_REFUSALS_BATCH) break;
    }
    return { processed: removed, detail: removed ? `حُذف ${removed} سطر رفض قديم` : 'لا سطور رفض قديمة' };
  },
};
