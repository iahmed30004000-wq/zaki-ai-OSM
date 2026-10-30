import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { consecutiveFailures, isParked } from '../runner';
import { overdueBy } from '../schedule';
import { alertAboutJob } from '../alerts';
// A cycle on purpose: the watchdog watches every job, itself included in the list it skips. `JOBS` is only read
// inside `run`, long after both modules have loaded — but never import THIS file first; always go through `./index`.
import { JOBS } from './index';

/**
 * THE WATCHDOG — THE JOB WHOSE JOB IS THE OTHER JOBS.
 *
 * Every other job in this folder fails LOUDLY: it throws, the runner writes
 * the failure down, the worker counts it and alerts. That covers a job that
 * runs and breaks.
 *
 * It does not cover a job that NEVER RUNS. And that is the failure that
 * actually hurt: a clock-time job whose hour passed with the worker busy, a
 * job parked after twelve failures that then sat parked for a fortnight, a
 * job whose name was changed in a deploy so the scheduler no longer had
 * anything to call. In every one of those the run log is simply EMPTY for
 * that job — and an empty log looks exactly like a quiet day. Nothing
 * throws, so nothing alerts, so nobody is told. The commissions were not
 * accrued and the only evidence was an absence.
 *
 * So one job reads the others' run logs and shouts about the silences.
 *
 * ── WHAT THIS CANNOT DO, STATED PLAINLY ──
 *
 * It runs INSIDE the worker. If the whole worker is dead, this is dead too,
 * and a dead watchdog cannot report itself — the oldest trap in monitoring.
 * That case is covered from outside the process, by GET /api/health/worker:
 * an uptime monitor polls it every minute and it answers 503 once no job
 * has written a heartbeat row for three minutes.
 *
 * The two halves are deliberate and neither replaces the other. The
 * watchdog catches ONE job wedged while the worker is otherwise healthy —
 * which an external monitor cannot see, because the worker is plainly
 * alive. The health endpoint catches the worker being gone — which the
 * watchdog cannot see, because it is gone with it.
 *
 * ── COST ──
 *
 * Two indexed one-row lookups per watched job, every five minutes. Thirteen
 * jobs is twenty-six index seeks on `JobRun(jobName, startedAt)` — a few
 * milliseconds, and flat as the log grows.
 */
export const watchdog: JobDefinition = {
  name: 'watchdog',
  everySeconds: 300,
  description: 'مراقبة المهام المجدولة والتنبيه عن أي مهمة لم تعمل',
  async run({ now }): Promise<JobResult> {
    const shouted: string[] = [];
    let unconfigured = 0;

    for (const job of JOBS) {
      // Itself excluded: it is running, so it is never the silent one, and
      // a watchdog that can alert about itself is a loop.
      if (job.name === watchdog.name) continue;

      // Parked first. A parked job is NOT overdue in the ordinary sense —
      // it is overdue because a person has to press "try again", and the
      // message has to say that or the reader will wait for a retry that
      // is never coming.
      if (await isParked(job.name)) {
        const failures = await consecutiveFailures(job.name);
        const res = await alertAboutJob({ jobName: job.name, kind: 'parked', failures }, now);
        if (res.sent) shouted.push(job.name);
        if (!res.sent && res.reason === 'NOT_CONFIGURED') unconfigured++;
        continue;
      }

      const lastSuccess = await db.jobRun.findFirst({
        where: { jobName: job.name, status: 'SUCCEEDED' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      });

      // `overdueBy` and not a bare interval comparison: it knows that a
      // daily 16:45 job is not late at 09:00, and judging the daily jobs by
      // their interval made them all look late every morning — which is
      // how an alert channel gets muted before it has ever been right.
      const lateBy = overdueBy(job, lastSuccess?.startedAt ?? null, now);
      if (lateBy <= 0) continue;

      const res = await alertAboutJob(
        { jobName: job.name, kind: 'overdue', overdueSeconds: lateBy },
        now
      );
      if (res.sent) shouted.push(job.name);
      if (!res.sent && res.reason === 'NOT_CONFIGURED') unconfigured++;
    }

    // A quiet run is the normal one. `processed` counts alerts SENT, so the
    // jobs screen shows zero on a healthy day rather than a number that
    // looks like work was done.
    return {
      processed: shouted.length,
      detail: unconfigured
        ? `${unconfigured} مهمة متوقّفة ولا يوجد معرِّف محادثة للتنبيه — راجع TELEGRAM_ALERT_CHAT_ID`
        : shouted.length
          ? `تنبيه عن: ${shouted.join('، ')}`
          : 'كل المهام تعمل في مواعيدها',
    };
  },
};
