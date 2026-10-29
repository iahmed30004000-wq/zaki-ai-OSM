/**
 * The scheduler worker.
 *
 * A real process, run alongside the app and independent of any browser:
 *
 *   npm run worker                       run forever
 *   npm run worker:once                  run every job once and exit
 *   npx tsx scripts/worker.ts --job=NAME run one job and exit
 *
 * It is a separate process from the web app on purpose, so deploying it is
 * a matter of keeping one command alive:
 *
 *   pm2 start npm --name osm-worker -- run worker
 *   # or a systemd unit whose ExecStart is: npm run worker
 *
 * Nothing schedules itself from inside the app, and nothing runs because a
 * browser happened to be open: if this process is not running, the jobs are
 * not running, and the run log in the database says exactly when each last
 * ran.
 *
 * Deliberately node-cron-and-Redis-free. Each job keeps its own next-due
 * time in memory and its own backoff, and the database run log is what
 * survives a restart — so there is no queue to operate, nothing to install,
 * and a crashed worker resumes simply by starting again.
 *
 * A job that fails backs off exponentially rather than hammering a courier
 * that is down, and after three consecutive failures it says so loudly
 * instead of scrolling past.
 */
import { config } from 'dotenv';
config();

import { db } from '../src/lib/db';
import { JOBS, jobByName } from '../src/lib/jobs/definitions';
import {
  ALERT_AFTER_FAILURES,
  JobSkipped,
  backoffSeconds,
  consecutiveFailures,
  isParked,
  lastRun,
  runJob,
  type JobDefinition,
} from '../src/lib/jobs/runner';
import { scheduleAr } from '../src/lib/jobs/schedule';
import { newTickState, tick } from '../src/lib/jobs/tick';
import { alertAboutJob, shouldAlertOnFailure } from '../src/lib/jobs/alerts';
import { bootAlarms } from '../src/lib/boot-alarms';

const args = process.argv.slice(2);
const once = args.includes('--once');
const only = args.find((a) => a.startsWith('--job='))?.slice('--job='.length);

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (msg: string) => console.log(`[${stamp()}] ${msg}`);

/**
 * Run it once. Returns how many seconds to WAIT BEFORE TRYING AGAIN, which
 * is zero on success — the schedule decides when it is next due, and this
 * only decides how long to leave a failing provider alone.
 */
async function attempt(job: JobDefinition): Promise<number> {
  try {
    const result = await runJob(job);
    log(`✓ ${job.name} — ${result.detail ?? `${result.processed}`}`);
    return 0;
  } catch (error) {
    if (error instanceof JobSkipped) {
      // Another worker holds it. Not a failure, so no backoff.
      log(`· ${job.name} — يعمل بالفعل، تُخطّي`);
      return 0;
    }

    const failures = await consecutiveFailures(job.name);
    const wait = backoffSeconds(failures, job.everySeconds);
    const message = error instanceof Error ? error.message : String(error);

    if (failures >= ALERT_AFTER_FAILURES) {
      log(`✗✗ ${job.name} — فشل ${failures} مرات متتالية: ${message}`);
      log(`   يحتاج تدخّلاً — المحاولة القادمة بعد ${wait}s`);

      /**
       * AND NOW IT ACTUALLY TELLS SOMEBODY.
       *
       * The two `log` lines above were the entire alert for this condition.
       * A log line in a detached pm2/systemd process is a file nobody opens
       * unless they already suspect something is wrong — which is the one
       * job an alert has. So the message goes to Telegram, with a link to
       * /admin/jobs so whoever reads it at 3am can act from a phone.
       *
       * `shouldAlertOnFailure` decides, not this branch: the threshold is
       * a floor, and above it only every tenth failure is sent, because a
       * 60-second job that has broken would otherwise send 1,440 identical
       * messages a day and get the chat muted.
       *
       * Awaited, and it never throws (see alerts.ts): an alert that threw
       * here would be caught as the worker failing and would try to alert
       * about itself.
       */
      if (shouldAlertOnFailure(failures)) {
        const alert = await alertAboutJob({ jobName: job.name, kind: 'failing', failures, error: message });
        if (alert.sent) log('   أُرسل تنبيه على تلغرام');
        else if (alert.reason === 'NOT_CONFIGURED')
          log('   لم يُرسل تنبيه: TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID غير مضبوطين');
        else if (alert.reason === 'SEND_FAILED') log('   تعذَّر إرسال التنبيه على تلغرام');
      }
    } else {
      log(`✗ ${job.name} — ${message} (المحاولة القادمة بعد ${wait}s)`);
    }
    return wait;
  }
}

async function main() {
  const jobs = only ? [jobByName(only)].filter(Boolean as unknown as (j: JobDefinition | undefined) => j is JobDefinition) : JOBS;

  if (only && jobs.length === 0) {
    console.error(`لا توجد مهمة باسم ${only}. المتاح: ${JOBS.map((j) => j.name).join(', ')}`);
    process.exit(1);
  }

  if (once || only) {
    for (const job of jobs) await attempt(job);
    await db.$disconnect();
    return;
  }

  // Printed on every start, beside the line a deployer reads first. See boot-alarms.ts.
  for (const alarm of bootAlarms(process.env)) console.error(`[${stamp()}] تنبيه إقلاع: ${alarm}`);

  log(`بدأ المجدول — ${jobs.length} مهمة`);
  for (const job of jobs) log(`   ${job.name} ${scheduleAr(job)} — ${job.description}`);

  /**
   * What the loop remembers: when a FAILING job may be tried again (backoff
   * only — this process's patience with a provider that is down), and when a
   * job found NOT due is next worth asking about.
   *
   * Whether a job is DUE is asked of the run log in the database instead of
   * a variable starting at zero. That variable meant every deploy re-ran
   * every job: the idempotent ones shrugged and the ones that message a
   * person messaged them twice.
   *
   * And a job that was found not due is not asked about again until the
   * moment it could become due (see `src/lib/jobs/tick.ts`). Asking fourteen
   * jobs two questions every second was 28 queries a second to learn that
   * nothing had changed.
   */
  const state = newTickState();
  let stopping = false;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(1); // a second one means business
      stopping = true;
      log('إيقاف بعد انتهاء المهمة الحالية…');
    });
  }

  while (!stopping) {
    await tick(jobs, state, { isParked, lastRun, attempt, now: Date.now }, () => stopping);
    await new Promise((r) => setTimeout(r, 1000));
  }

  await db.$disconnect();
  log('توقف المجدول');
}

main().catch(async (error) => {
  console.error('المجدول توقف بخطأ غير متوقَّع:', error);
  await db.$disconnect();
  process.exit(1);
});
