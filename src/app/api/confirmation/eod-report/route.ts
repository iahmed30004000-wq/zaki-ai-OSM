import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { REJECTION_REASON_AR } from '@/lib/confirmation-workflow';
import { dayRange, localDay, mayReportDay, systemNumbers, validateSubmission } from '@/lib/eod-report';

/**
 * GET/POST /api/confirmation/eod-report — the team leader's end-of-day report (step H2 of Confirmation Center v2).
 *
 * GET ?day=YYYY-MM-DD (default today of the store): the system's numbers for that day, per agent (what the form shows beside her own figures), and whether this person already sent
 * hers. POST {day, agents[], biggestProblem, tip}: her report. Both need the team table's key, `team.monitor`, asked before anything is read or written.
 *
 * A report is written ONCE per (store, day, person) and never edited: a second one is refused (409), so a figure cannot be tuned after the system's numbers were seen. The day must
 * be today or yesterday of the store. The system's numbers are frozen with hers at the moment she sends, for the owner's audit (`/api/audit/team-leader`) — she is never shown a verdict.
 * Agents and counts only: no customer field is read.
 */
function resolveDay(raw: string | null, now: Date, timeZone: string): { day: string; start: Date; end: Date } | null {
  const day = raw || localDay(now, timeZone);
  const range = dayRange(day, timeZone);
  return range ? { day, ...range } : null;
}

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('team.monitor');

    const now = new Date();
    const when = resolveDay(new URL(req.url).searchParams.get('day'), now, country.timezone);
    if (!when) return NextResponse.json({ error: 'اليوم غير صالح.', errorAr: 'اليوم غير صالح.', code: 'INVALID_DAY' }, { status: 400 });

    const [numbers, mine] = await Promise.all([
      systemNumbers(db, { companyId, storeId, start: when.start, end: when.end }, now),
      db.confirmationEodReport.findUnique({ where: { companyId_storeId_day_userId: { companyId, storeId, day: when.day, userId: user.id } }, select: { payload: true, submittedAt: true } }),
    ]);
    return NextResponse.json({ day: when.day, mayReport: mayReportDay(when.day, now, country.timezone), reasons: REJECTION_REASON_AR, system: numbers, submitted: mine ? { at: mine.submittedAt, payload: mine.payload } : null });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('team.monitor');

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const now = new Date();
    const when = resolveDay(typeof body?.day === 'string' ? body.day : null, now, country.timezone);
    if (!when) return NextResponse.json({ error: 'اليوم غير صالح.', errorAr: 'اليوم غير صالح.', code: 'INVALID_DAY' }, { status: 400 });
    if (!mayReportDay(when.day, now, country.timezone)) {
      const said = 'التقرير لليوم أو لأمس بس.';
      return NextResponse.json({ error: said, errorAr: said, code: 'DAY_TOO_OLD' }, { status: 400 });
    }

    const system = await systemNumbers(db, { companyId, storeId, start: when.start, end: when.end }, now);
    const checked = validateSubmission(body, new Set(system.map((s) => s.userId)));
    if (!checked.ok) return NextResponse.json({ error: checked.error, errorAr: checked.error, code: 'INVALID_REPORT' }, { status: 400 });

    try {
      await db.confirmationEodReport.create({
        data: {
          companyId,
          storeId,
          day: when.day,
          userId: user.id,
          payload: checked.value as unknown as Prisma.InputJsonValue,
          system: system as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const said = 'أرسلتي تقرير هاليوم أصلاً، وما بيتعدّل.';
        return NextResponse.json({ error: said, errorAr: said, code: 'ALREADY_SUBMITTED' }, { status: 409 });
      }
      throw e;
    }

    // The event only — never the numbers: the audit screen is read by people who are not the owner.
    await logAudit({ companyId, userId: user.id, action: 'EOD_REPORT_SUBMITTED', entity: 'ConfirmationEodReport', entityId: `${storeId}:${when.day}:${user.id}`, newData: { day: when.day } });
    return NextResponse.json({ ok: true, day: when.day }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
