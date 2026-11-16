import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { requireContext } from '@/lib/geo-context';
import { userHasFullAccess } from '@/lib/can';
import { apiErrorResponse } from '@/lib/api-error';
import { compare, dayRange, localDay, sampleRejected, type AgentNumbers, type Submission } from '@/lib/eod-report';

/**
 * GET /api/audit/team-leader?day=&leaderId= — THE OWNER'S WINDOW ON THE TEAM LEADER (step H2 of Confirmation Center v2). The owner's alone: a hard 403 for everybody else, the team
 * leader herself included — the check is on the ACCOUNT (`userHasFullAccess`), not on a key anyone can be ticked, and it is the first thing asked, before anything is read.
 *
 * It answers, for one day of the store:
 *   · her SUBMITTED figures against the SYSTEM's, as they were frozen when she sent them, with the variance in percent per agent and metric;
 *   · her own ACTION LOG that day (every audit line written under her name: reassignments, winback offers, issue corrections, logins…);
 *   · a SAMPLE of ten rejected orders of the day — the same ten every time the day is opened — with the reason and only whether the number is valid for the store's country.
 * No customer name, phone or address leaves this door. Read only.
 */
export async function GET(req: Request) {
  try {
    const user = await requireAuth();
    if (!userHasFullAccess(user)) throw new Error('Forbidden: owner only');
    const { companyId, storeId, country } = await requireContext();

    const { searchParams } = new URL(req.url);
    const now = new Date();
    const day = searchParams.get('day') || localDay(now, country.timezone);
    const range = dayRange(day, country.timezone);
    if (!range) return NextResponse.json({ error: 'اليوم غير صالح.', errorAr: 'اليوم غير صالح.', code: 'INVALID_DAY' }, { status: 400 });

    // the leaders: everyone who holds the role, so the owner can choose; the one asked for, or the first
    const leaders = await db.user.findMany({ where: { companyId, role: 'TEAM_LEADER', status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const wanted = searchParams.get('leaderId');
    const leader = leaders.find((l) => l.id === wanted) ?? leaders[0] ?? null;

    const [report, actions, sample] = await Promise.all([
      leader ? db.confirmationEodReport.findUnique({ where: { companyId_storeId_day_userId: { companyId, storeId, day, userId: leader.id } } }) : null,
      leader
        ? db.auditLog.findMany({
            where: { companyId, userId: leader.id, createdAt: { gte: range.start, lt: range.end } },
            select: { action: true, entity: true, entityId: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
            take: 500,
          })
        : [],
      sampleRejected(db, { companyId, storeId, start: range.start, end: range.end, countryCode: country.code, day }),
    ]);

    const submission = report?.payload as unknown as Submission | undefined;
    const frozen = report?.system as unknown as AgentNumbers[] | undefined;
    return NextResponse.json({
      day,
      leaders,
      leader,
      report: report && submission && frozen ? { submittedAt: report.submittedAt, biggestProblem: submission.biggestProblem, tip: submission.tip, comparison: compare(submission, frozen) } : null,
      actions,
      sample,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
