import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { getDateRange } from '@/lib/analytics';
import { endOfLocalDay, localDayKey, startOfLocalDay } from '@/lib/local-day';
import {
  FRESH_NEW_HOURS,
  REPORT_DEFAULT_DAYS,
  STUCK_BUSINESS_DAYS,
  answerRateReport,
  noAnswerBoard,
} from '@/lib/no-answer-watch';

/**
 * GET /api/orders/confirmation/no-answer?startDate=&endDate=
 *
 * «لا رد والطلبات المحجوزة» — read only. The board is «now»; the dates are the
 * answer-rate report's alone (default: the last fourteen days, today included,
 * clamped to ninety like every other window here).
 *
 * The key is the team table's, `team.monitor`, and the refusal is the team
 * table's own words — the same people see both, and nobody else is asked
 * anything before the refusal. Agents and counts only: no customer field.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();

    if (!can(user, 'team.monitor')) {
      return NextResponse.json({ error: 'أداء الفريق للمشرف وحده.', errorAr: 'أداء الفريق للمشرف وحده.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const now = new Date();
    const asked = { startDate: searchParams.get('startDate') || undefined, endDate: searchParams.get('endDate') || undefined };
    let { start, end } = asked.startDate && asked.endDate ? getDateRange(asked) : {};
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
      const from = new Date(now);
      from.setDate(from.getDate() - (REPORT_DEFAULT_DAYS - 1));
      start = startOfLocalDay(localDayKey(from))!;
      end = endOfLocalDay(localDayKey(now))!;
    }

    const calendar = {
      workHoursStart: country.workHoursStart,
      workHoursEnd: country.workHoursEnd,
      weekendDays: country.weekendDays,
      timezone: country.timezone,
    };

    const [board, report] = await Promise.all([
      noAnswerBoard({ companyId, storeId, calendar, now }),
      answerRateReport({ companyId, storeId, timezone: country.timezone, start, end }),
    ]);

    return NextResponse.json({
      board,
      report,
      window: { start: start.toISOString(), end: end.toISOString(), timezone: country.timezone },
      rules: { stuckBusinessDays: STUCK_BUSINESS_DAYS, freshNewHours: FRESH_NEW_HOURS },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
