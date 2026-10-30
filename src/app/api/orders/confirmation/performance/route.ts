import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { getDateRange, type DateFilter } from '@/lib/analytics';
import { teamPerformance } from '@/lib/team-performance';

/**
 * GET /api/orders/confirmation/performance?employeeId=&from=&to=
 *
 * ONE PERSON'S NUMBERS — and the same numbers the team screen shows.
 *
 * This route used to compute them itself: eight hand-written queries for
 * `claimed`, `confirmed`, `rejected`, `noAnswer`, the decided count, the
 * confirmation rate and the median confirm time, beside
 * `teamPerformance()` in `team/route.ts` computing the same seven for the
 * whole team. Two implementations of one person's week.
 *
 * AND THEY DID NOT AGREE. The shared one counts a pull of work from
 * `orderClaimHistory`, with its own comment saying why: «an order released
 * and re-claimed was two pulls of work, and `claimedAt` remembers only the
 * second». This one counted `order.claimedById` — the CURRENT holder — so
 * an order passed from one agent to another vanished from the first
 * agent's workload entirely, and the median it timed ran from the LAST
 * claim rather than the first.
 *
 * It also took no date window at all, so `claimed` here meant «ever» while
 * `claimed` on the team screen meant «in the period being looked at». The
 * same word, two meanings, on two screens about the same person.
 *
 * Latent today — `order_claim_history` has 0 rows and no order carries a
 * `claimedById`, so the confirmation workflow has not been used on this
 * database and both endpoints currently answer zero. A second
 * implementation that cannot be reached is still a second implementation;
 * it waits for the first week of real use.
 *
 * WHAT IS STILL COMPUTED HERE, and why it is not a second copy: follow-ups
 * resolved, contact attempts, and today's tallies are not part of
 * `EmployeeRow` and nothing else derives them. They are this route's own
 * subject, not another reading of the team's.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const { searchParams } = new URL(req.url);
    const requestedEmployeeId = searchParams.get('employeeId')?.trim();

    /*
     * WHOSE NUMBERS. Your own by default; somebody else's needs the
     * permission to look at people. Unchanged — the guard was never the
     * problem with this route.
     */
    let employeeId = user.id;
    if (requestedEmployeeId && requestedEmployeeId !== user.id) {
      // Somebody else's numbers are `team.monitor`'s (PR-10): it read `users.view` OR three role NAMES, and the migration
      // 20261030170000_costs_insights_keys gave the key to everybody who passed either.
      if (!can(user, 'team.monitor')) {
        return NextResponse.json(
          {
            error: 'Forbidden: cannot view other employees’ performance',
            errorAr: 'ترى أداءك وحدك — أداء الآخرين للمشرف.',
          },
          { status: 403 }
        );
      }
      employeeId = requestedEmployeeId;
    }

    /*
     * THE SAME WINDOW THE TEAM SCREEN USES, read the same way. Absent means
     * everything, which is what this route always did — but now it is a
     * stated default rather than the absence of the idea.
     */
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

    // The shared calculator, for every figure it already owns.
    const team = await teamPerformance({ companyId, storeId, calendar, start, end });
    const me = team.employees.find((e) => e.id === employeeId) ?? null;

    /*
     * THIS ROUTE'S OWN SUBJECT. Three things `EmployeeRow` does not carry
     * and nothing else derives: what this person resolved, how many calls
     * they made, and what they have done since midnight.
     */
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const sinceMidnight = { createdAt: { gte: startOfToday } };
    const statusToday = (value: string) => ({
      companyId,
      order: { storeId },
      changedById: employeeId,
      statusType: 'CONFIRMATION',
      newValue: value,
      ...sinceMidnight,
    });

    const [followUpsCompleted, attempts, confirmedToday, rejectedToday, contactedToday, noAnswerToday] =
      await Promise.all([
        db.order.count({
          where: { companyId, storeId, followUpResolvedById: employeeId, followUpStatus: 'COMPLETED' },
        }),
        db.orderContactAttempt.count({ where: { companyId, employeeId, order: { storeId } } }),
        db.orderStatusLog.count({ where: statusToday('CONFIRMED') }),
        db.orderStatusLog.count({ where: statusToday('REJECTED') }),
        db.orderContactAttempt.count({
          where: { companyId, order: { storeId }, employeeId, ...sinceMidnight },
        }),
        db.orderStatusLog.count({ where: statusToday('NO_ANSWER') }),
      ]);

    /*
     * A PERSON WITH NO WORK IN THE WINDOW IS NOT AN ERROR. They get zeros
     * and nulls, the same shape as everyone else — `null` for a median
     * nobody can compute, never a 0 that reads as «instant».
     */
    const claimed = me?.claimed ?? 0;

    return NextResponse.json({
      employeeId,
      window: { start: start?.toISOString() ?? null, end: end?.toISOString() ?? null },
      metrics: {
        claimed,
        inProgress: me?.openNow ?? 0,
        processed: me?.decided ?? 0,
        confirmed: me?.confirmed ?? 0,
        rejected: me?.rejected ?? 0,
        noAnswer: me?.noAnswer ?? 0,
        followUpsCompleted,
        avgAttemptsPerOrder: claimed > 0 ? Number((attempts / claimed).toFixed(2)) : null,
        medianConfirmMinutes: me?.medianConfirmMinutes ?? null,
        confirmationRate: me?.confirmationRate ?? null,
        pendingWorkload: me?.openNow ?? 0,
        today: { confirmedToday, rejectedToday, contactedToday, noAnswerToday },
      },
      definitions: {
        claimed: 'الطلبات التي سحبها الموظف من المجمّع خلال المدة — من سجل السحب، فإعادة السحب سحبةٌ ثانية',
        processed: 'ما وصل إلى قرار (مؤكد أو مرفوض) خلال المدة — ما زال قيد العمل لا يُحسب',
        confirmationRate: 'المؤكد ÷ ما وصل إلى قرار',
        medianConfirmMinutes: 'وسيط دقائق العمل من سحب الطلب حتى تأكيده — خارج الدوام لا يُحتسب',
        avgAttemptsPerOrder: 'محاولات الاتصال ÷ الطلبات المسحوبة في المدة',
        today: 'ما سُجِّل منذ منتصف الليل، بصرف النظر عن المدة أعلاه',
      },
    });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}
