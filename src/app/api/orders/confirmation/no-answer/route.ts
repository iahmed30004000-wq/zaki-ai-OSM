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
import { DEFAULT_FLOW_WINDOW, FLOW_WINDOWS, flowWindowKey } from '@/lib/held-flow';

/**
 * GET /api/orders/confirmation/no-answer?startDate=&endDate=&part=board|report|flow&window=6h|24h|7d
 *
 * «لا رد والطلبات المحجوزة» — read only. The board is «now»; the dates are the
 * answer-rate report's alone (default: the last fourteen days, today included,
 * clamped to ninety like every other window here).
 *
 * `?part=flow` is «حركة الطلبات» (`held-flow.ts`): what entered the agents' hands
 * and what left them over `window` (default 24h), how long the held orders have
 * sat, and how smoothly they move. It answers `{ flow }` and nothing else — the
 * board and the report are not read for it, and it ignores the dates.
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

    // `?part=flow`: «حركة الطلبات», its own question and its own window — after the key, so a person without it is refused
    // before anything is read, and before the window is even looked at.
    if (searchParams.get('part') === 'flow') {
      const asked = searchParams.get('window');
      const windowKey = asked === null ? DEFAULT_FLOW_WINDOW : flowWindowKey(asked);
      if (!windowKey) {
        const said = `المدة اللي طلبتها مش معروفة — اختر ${Object.values(FLOW_WINDOWS).map((w) => w.label).join(' أو ')}.`;
        return NextResponse.json({ error: said, errorAr: said, code: 'UNKNOWN_WINDOW' }, { status: 400 });
      }
      // Loaded only here: the board and the report never pay for the ledger's imports, and a test of them never loads the database.
      const { heldFlow } = await import('@/lib/held-flow-read');
      return NextResponse.json({ flow: await heldFlow({ companyId, storeId, calendar, windowKey, now }) });
    }

    // `?part=board` / `?part=report`: the screen asks for the board once and for the report on every date change, so
    // moving the dates never recomputes the board. Without `part`, both.
    const part = searchParams.get('part');
    const [board, report] = await Promise.all([
      part === 'report' ? undefined : noAnswerBoard({ companyId, storeId, calendar, now }),
      part === 'board' ? undefined : answerRateReport({ companyId, storeId, timezone: country.timezone, start, end }),
    ]);

    return NextResponse.json({
      ...(board ? { board } : {}),
      ...(report ? { report } : {}),
      window: { start: start.toISOString(), end: end.toISOString(), timezone: country.timezone },
      rules: { stuckBusinessDays: STUCK_BUSINESS_DAYS, freshNewHours: FRESH_NEW_HOURS },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
