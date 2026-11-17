import type { JobDefinition } from '../runner';
import { pullSpend } from './pull-ad-spend';

/**
 * THE SAME PULL, AGAIN JUST AFTER MIDNIGHT (the owner, 17/11): 00:10 Asia/Amman, the last seven days.
 *
 * The night round of the media buyer (00:35) judges the last three COMPLETE days, so yesterday must already be whole when it looks — and a
 * pull at 06:00 is six hours too late for that. This is the one `pullSpend` the morning job runs (campaign totals, then the per-ad per-day
 * grain, the same retries), asked at 00:10 in Amman's own clock whatever the scheduler's default zone is. The 06:00 pull stays.
 *
 * A separate job, not a second time on the first: a job has ONE clock time (`schedule.ts`), and a run at 00:10 must not cancel the 06:00 one
 * («already ran today»). Its own log line, its own red when it is late.
 */
export const pullAdSpendNight: JobDefinition = {
  name: 'pull-ad-spend-night',
  everySeconds: 86_400,
  at: '00:10',
  timezone: 'Asia/Amman',
  description: 'سحب الإنفاق الإعلاني بعد منتصف الليل (بتوقيت عمّان) قبل جولة الميديا باير الليلية',
  run: pullSpend,
};
