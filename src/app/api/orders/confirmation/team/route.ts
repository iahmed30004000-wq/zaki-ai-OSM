import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { getDateRange, type DateFilter } from '@/lib/analytics';
import { teamPerformance } from '@/lib/team-performance';
import { attendance } from '@/lib/attendance';
import { db } from '@/lib/db';
import type { PersonShift } from '@/lib/employee-shift';

/**
 * GET /api/orders/confirmation/team?period=&startDate=&endDate=
 *
 * Every confirmation employee at once, for a chosen span of days. The
 * per-employee endpoint answers "how am I doing"; this answers "who is
 * doing well, and this week or last month".
 *
 * The arithmetic lives in the service layer so the report and any future
 * export say the same thing. The window is clamped to 90 days there, the
 * same ceiling every other aggregate in the system obeys.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();

    // The team's table is `team.monitor`'s (PR-10). It read `users.view` OR three role NAMES; the migration
    // 20261030170000_costs_insights_keys gave the key to everybody who passed either, so nobody lost the table on the day.
    if (!can(user, 'team.monitor')) {
      return NextResponse.json({ error: 'Forbidden: cannot view team performance', errorAr: 'أداء الفريق للمشرف وحده.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const filter: DateFilter = {
      period: (searchParams.get('period') as DateFilter['period']) || undefined,
      startDate: searchParams.get('startDate') || undefined,
      endDate: searchParams.get('endDate') || undefined,
    };
    const { start, end } = getDateRange(filter);

    const calendar = {
      workHoursStart: country.workHoursStart,
      workHoursEnd: country.workHoursEnd,
      weekendDays: country.weekendDays,
      timezone: country.timezone,
    };

    const result = await teamPerformance({ companyId, storeId, calendar, start, end });

    // Attendance rides along on the same window, for the same people. Two
    // requests for one table would let the halves disagree about the dates.
    const userIds = result.employees.map((e) => e.id);
    // Each person's own hours, where they have them. Without these the
    // lateness column measures a noon shift against a nine o'clock country
    // and reports three hours late, every day, forever.
    const shifts = new Map<string, PersonShift>(
      (
        await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, shiftStart: true, shiftEnd: true, restDays: true },
        })
      ).map((u) => [u.id, { shiftStart: u.shiftStart, shiftEnd: u.shiftEnd, restDays: u.restDays }])
    );

    const marks =
      start && end
        ? await attendance({ companyId, storeId, userIds, calendar, shifts, start, end })
        : new Map();

    return NextResponse.json({
      ...result,
      employees: result.employees.map((e) => {
        const a = marks.get(e.id);
        return {
          ...e,
          // Days here, days late, and the hours actually spent — the
          // fingerprint, beside the work it produced.
          daysPresent: a?.daysPresent ?? 0,
          daysLate: a?.daysLate ?? 0,
          totalLateMinutes: a?.totalLateMinutes ?? 0,
          avgPresentMinutes: a?.avgPresentMinutes ?? null,
          daysWithoutWork: a?.daysWithoutWork ?? 0,
          daysLateEstimated: a?.daysLateEstimated ?? 0,
        };
      }),
      window: { start: start?.toISOString() ?? null, end: end?.toISOString() ?? null },
      definitions: {
        claimed: 'الطلبات التي سحبها الموظف من المجمّع خلال المدة',
        decided: 'ما وصل إلى قرار (مؤكد أو مرفوض) خلال المدة — ما زال قيد العمل لا يُحسب',
        confirmationRate: 'المؤكد ÷ ما وصل إلى قرار',
        medianConfirmMinutes: 'وسيط دقائق العمل من سحب الطلب حتى تأكيده — خارج الدوام لا يُحتسب',
        medianGapMinutes: 'وسيط دقائق العمل بين سحب طلب والذي يليه',
        openNow: 'ما يحمله الموظف مفتوحاً الآن، بصرف النظر عن المدة',
        medianFirstActionMinutes: 'وسيط دقائق العمل من سحب الطلب حتى أول إجراء عليه',
        daysPresent: 'أيام ظهر فيها أثر حضور — دخول، أو بصمة، أو شغل',
        daysLate: 'أيام وصل فيها بعد بداية الدوام (العطلة لا تُحسب تأخيراً)',
        avgPresentMinutes: 'متوسط دقائق التواجد في اليوم الواحد',
        daysWithoutWork: 'أيام كان حاضراً بلا أي إجراء مسجَّل',
        daysLateEstimated: 'من أيام التأخير، كم يوم وقت الوصول فيه مُقدَّر من أول إجراء لأن أحداً لم يبصم',
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
