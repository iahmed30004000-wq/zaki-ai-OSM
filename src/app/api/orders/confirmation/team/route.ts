import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { getDateRange, type DateFilter } from '@/lib/analytics';
import { confirmationTeamAnswer, withAttendance } from '@/lib/confirmation-team-answer';

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

    // ONE COMPUTATION PER QUESTION, IN THE REPORTS' LANE — moved to `lib/confirmation-team-answer.ts` so the door of one person reads the same answer.
    const { result, marks } = await confirmationTeamAnswer({ companyId, storeId, calendar, start, end });

    return NextResponse.json({
      ...result,
      employees: result.employees.map((e) => withAttendance(e, marks)),
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
