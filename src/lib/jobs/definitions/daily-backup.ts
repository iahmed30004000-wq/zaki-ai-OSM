import type { JobDefinition, JobResult } from '../runner';
import { backupHealth, takeBackup } from '../../backup';

/**
 * THE DAILY BACKUP.
 *
 * In the scheduler that already exists rather than in cron: a second thing
 * that runs on a timer is a second thing to notice has stopped, and
 * `/admin/jobs` already answers «is anything quietly not running» — which is
 * the only question a backup ever needs answered.
 *
 * 03:00 because a dump locks nothing but reads everything, and the hour with
 * the fewest orders is the hour it costs least.
 *
 * `processed` is 1 for a dump taken and 0 for a dump that could not be — and
 * a THROWN error, not a quiet zero, when `pg_dump` fails: the runner counts
 * failures, backs off, and alerts after three. A backup job that returns
 * «nothing to do» when the disk is full is the exact shape of the problem
 * this job exists to prevent.
 */
export const dailyBackup: JobDefinition = {
  name: 'daily-backup',
  everySeconds: 86_400,
  at: '03:00',
  description: 'نسخة احتياطية يوميّة لقاعدة البيانات، مقروءةً بعد أخذها',
  async run({ now }): Promise<JobResult> {
    const taken = await takeBackup({ now });
    const health = await backupHealth({ now });
    const mb = (taken.bytes / 1_048_576).toFixed(1);
    const where = taken.offSite ? 'ونُقلت خارج الخادم' : 'وبقيت على الخادم';
    return {
      processed: 1,
      detail:
        `${mb} م.ب ${where}` +
        (taken.pruned ? ` · حُذفت ${taken.pruned} نسخة قديمة` : '') +
        (health.problems.length ? ` · ${health.problems[0]}` : ''),
    };
  },
};
