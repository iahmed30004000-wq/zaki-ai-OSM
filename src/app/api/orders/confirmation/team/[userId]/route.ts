import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { getDateRange, type DateFilter } from '@/lib/analytics';
import { confirmationTeamAnswer, withAttendance } from '@/lib/confirmation-team-answer';

/**
 * GET /api/orders/confirmation/team/[userId]?period=&startDate=&endDate= — ONE person's row of the team table, for a chosen span of days.
 *
 * The drawer under a row of «جدول الفريق» (plan 17/11, R14a). The table is the one source of the team's numbers; this is the same
 * source for one person, so the drawer can never say a different figure from the row it opened from. It does NOT compute a second time:
 * it asks `confirmationTeamAnswer`, the very function behind the table, under the very same key, and takes the person out of it.
 *
 * Their OWN row needs no key — the numbers of your own work are yours, the same rule as your own performance card. Somebody ELSE's row
 * is a decision and needs `team.monitor`, exactly the key of the table. Only the one row leaves, never the team's.
 *
 * A person who did nothing in the window has no row in the table, and so none here: 404 with a sentence, not a row of invented zeros.
 * The words that define each figure are the table's (`definitions` on `GET /api/orders/confirmation/team`); the drawer opens from it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  try {
    const { userId } = await ctx.params;
    const { user, companyId, storeId, country } = await requireContext();

    const own = userId === user.id;
    if (!own && !can(user, 'team.monitor')) {
      return NextResponse.json(
        { errorAr: 'أرقام زميلك للمشرف وحده. أرقامك أنت مفتوحة لك.' },
        { status: 403 },
      );
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

    const { result, marks } = await confirmationTeamAnswer({ companyId, storeId, calendar, start, end });

    const row = result.employees.find((e) => e.id === userId);
    if (!row) {
      return NextResponse.json({ errorAr: 'ما في شغل مسجّل لهذا الموظف بالمدة المختارة.' }, { status: 404 });
    }

    return NextResponse.json({
      employee: withAttendance(row, marks),
      // The desk's totals for the same days, so the drawer can set one person beside the whole desk without a second request — for the one who may see the desk (`team.monitor`). On a small desk, your own row taken out of the totals would show your colleagues' combined work, which is theirs.
      ...(own && !can(user, 'team.monitor') ? {} : { team: result.totals }),
      window: { start: start?.toISOString() ?? null, end: end?.toISOString() ?? null },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
