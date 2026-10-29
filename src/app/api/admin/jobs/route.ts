import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { JOBS, jobByName } from '@/lib/jobs/definitions';
import { JobSkipped, consecutiveFailures, isOverdue, runJob, unpark, ALERT_AFTER_FAILURES } from '@/lib/jobs/runner';
import { scheduleAr } from '@/lib/jobs/schedule';

/**
 * GET  /api/admin/jobs   what each job did last, and whether it is overdue
 * POST /api/admin/jobs   run one now
 *
 * The screen this feeds exists to answer one question: is anything quietly
 * not running? A job with nothing to do and a job that stopped firing look
 * identical without the run log, so "overdue" is computed from the last
 * SUCCESS against the job's own interval.
 *
 * Running by hand does not bypass the lock — a job already RUNNING is
 * refused, because double-processing is the thing the lock exists to stop.
 */

const runSchema = z.object({
  /** A job's name, or `*` for all of them in the order they are declared. */
  job: z.string().trim().min(1).max(80),
  /** 'unpark' lets a job that gave up try again; anything else runs it now. */
  action: z.enum(['run', 'unpark']).optional(),
});

export async function GET() {
  try {
    await requireContext();
    await requirePermission('settings.view');

    const rows = await Promise.all(
      JOBS.map(async (job) => {
        const [last, lastSuccess, failures] = await Promise.all([
          db.jobRun.findFirst({ where: { jobName: job.name }, orderBy: { startedAt: 'desc' } }),
          db.jobRun.findFirst({
            where: { jobName: job.name, status: 'SUCCEEDED' },
            orderBy: { startedAt: 'desc' },
          }),
          consecutiveFailures(job.name),
        ]);

        return {
          name: job.name,
          description: job.description,
          everySeconds: job.everySeconds,
          // The schedule in words. Seconds on a screen is a number the
          // reader has to divide before they know whether it is wrong.
          schedule: scheduleAr(job),
          at: job.at ?? null,
          last: last && {
            status: last.status,
            startedAt: last.startedAt,
            finishedAt: last.finishedAt,
            processed: last.processed,
            detail: last.detail,
            error: last.error,
          },
          lastSuccessAt: lastSuccess?.startedAt ?? null,
          overdue: isOverdue(job, lastSuccess?.startedAt ?? null),
          consecutiveFailures: failures,
          alerting: failures >= ALERT_AFTER_FAILURES,
          // Parked: it stopped trying, and only a person starts it again.
          parked: last?.status === 'GAVE_UP',
        };
      })
    );

    const recent = await db.jobRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 40,
      select: {
        id: true, jobName: true, status: true, startedAt: true, finishedAt: true,
        processed: true, detail: true, error: true,
      },
    });

    return NextResponse.json({ jobs: rows, recent });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.jobs');

    const parsed = runSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'اسم المهمة مطلوب' }, { status: 400 });
    }

    /**
     * ALL OF THEM, IN ORDER, ONE AT A TIME.
     *
     * Sequential rather than parallel, and the order is `JOBS`' own: some
     * of these feed each other — claims are released before postponed
     * orders are surfaced, commission accrues before penalties are
     * proposed — and running them at once would have a job read what the
     * one before it had not yet written.
     *
     * A failure does not stop the run. One courier's API being down is not
     * a reason to skip accruing commission, and the caller gets a row per
     * job saying which did what.
     */
    if (parsed.data.job === '*') {
      const results: { job: string; ok: boolean; processed?: number; error?: string }[] = [];
      for (const j of JOBS) {
        try {
          const r = await runJob(j);
          results.push({ job: j.name, ok: true, processed: r.processed });
        } catch (e) {
          results.push({
            job: j.name,
            ok: false,
            error: e instanceof JobSkipped ? 'تُخطّيت' : e instanceof Error ? e.message : 'فشلت',
          });
        }
      }
      await logAudit({
        companyId, userId: user.id, action: 'JOB_RUN_ALL',
        entity: 'JobRun', entityId: 'all',
        newData: { ran: results.length, failed: results.filter((r) => !r.ok).length },
      });
      return NextResponse.json({ ran: results });
    }

    const job = jobByName(parsed.data.job);
    if (!job) return NextResponse.json({ error: 'لا توجد مهمة بهذا الاسم' }, { status: 404 });

    // A parked job starts again only because a person said so — after they
    // fixed whatever it was. Written to the audit, because "who turned this
    // back on" is the first question asked when it fails again.
    if (parsed.data.action === 'unpark') {
      await unpark(job.name, user.id);
      await logAudit({
        companyId, userId: user.id, action: 'JOB_UNPARKED',
        entity: 'JobRun', entityId: job.name,
        newData: { job: job.name },
      });
      return NextResponse.json({ job: job.name, unparked: true });
    }

    try {
      const result = await runJob(job);
      await logAudit({
        companyId, userId: user.id, action: 'JOB_RUN_MANUAL',
        entity: 'JobRun', entityId: result.runId,
        newData: { job: job.name, processed: result.processed, detail: result.detail ?? null },
      });
      return NextResponse.json({ job: job.name, ...result });
    } catch (e) {
      if (e instanceof JobSkipped) {
        return NextResponse.json({ error: e.message, code: 'ALREADY_RUNNING' }, { status: 409 });
      }
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'فشلت المهمة', code: 'JOB_FAILED' },
        { status: 500 }
      );
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
