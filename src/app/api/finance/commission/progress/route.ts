import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { measure } from '@/lib/commission-metrics';
import {
  METRIC_LABEL_AR, PERIOD_LABEL_AR, isTarget, parseTiers, targetGoal, tierFor,
} from '@/lib/commission-rules';
import { SPANS, lastClosedSpan, type Span } from '@/lib/commission-period';

/**
 * GET /api/finance/commission/progress
 *
 * HOW THE RUNNING SPAN IS GOING — the one thing a tiered rule could not say.
 *
 * A rule that pays on a day's count is accrued only after the day closes, so
 * until then there was nothing to look at: a person worked towards a number
 * they could not see, which is the opposite of what a target is for.
 *
 * This reads the SAME measures the accrual will use, over the span that is
 * still running, and says where each person stands. It writes nothing and
 * accrues nothing — the figure moves with every order until the span ends,
 * and only the closed span becomes money.
 */

/** The span being worked right now: the one after the last closed one. */
function runningSpan(span: Span, now: Date): { start: Date; end: Date } {
  const { end: start } = lastClosedSpan(span, now);
  const end = new Date(start);
  if (span === 'DAILY') end.setDate(end.getDate() + 1);
  else if (span === 'WEEKLY') end.setDate(end.getDate() + 7);
  else end.setMonth(end.getMonth() + 1);
  return { start, end };
}

export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();

    /*
     * WHOSE ROWS IS DECIDED HERE, NEVER BY THE CALLER.
     *
     * The route used to read «mine» from the query string and drop the
     * other people's rows only when the CALLER asked it to: anybody who left
     * the flag off — a script, a second tab, a copied URL — was handed every
     * agent's running count. commission.view sees the team. A person who holds
     * only the door this route used to ask (settings.view) sees their OWN row,
     * and nobody else gets in. The query string is not read at all.
     */
    const seesEveryone = can(user, 'commission.view');
    if (!seesEveryone) await requirePermission('settings.view');

    const rules = await db.commissionRule.findMany({
      where: {
        companyId,
        storeId,
        isActive: true,
        period: { in: [...SPANS] },
        effectiveFrom: { lte: new Date() },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
      },
    });

    const now = new Date();
    const rows: unknown[] = [];

    for (const rule of rules) {
      const people = rule.appliesToUserId
        ? await db.user.findMany({ where: { id: rule.appliesToUserId, companyId }, select: { id: true, name: true } })
        : await db.user.findMany({
            where: { companyId, role: rule.appliesToRole ?? '__none__', status: 'ACTIVE' },
            select: { id: true, name: true },
          });

      const span = runningSpan(rule.period as Span, now);
      const tiers = parseTiers(rule.tiers);

      for (const person of people) {
        if (!seesEveryone && person.id !== user.id) continue;
        const result = await measure(db, rule.metric, {
          companyId, storeId, userId: person.id,
          start: span.start, end: span.end,
          productId: rule.productId,
        });

        const band = tiers ? tierFor(tiers, result.count) : null;
        const next = tiers?.find((t) => t.from > result.count) ?? null;

        rows.push({
          ruleId: rule.id,
          ruleName: rule.name,
          userId: person.id,
          userName: person.name,
          metric: rule.metric,
          metricLabel: METRIC_LABEL_AR[rule.metric as keyof typeof METRIC_LABEL_AR] ?? rule.metric,
          period: rule.period,
          periodLabel: PERIOD_LABEL_AR[rule.period as keyof typeof PERIOD_LABEL_AR] ?? rule.period,
          spanStart: span.start.toISOString(),
          spanEnd: span.end.toISOString(),
          /** Where they are now. It moves until the span closes. */
          count: result.count,
          /** The band they are in, and what it is worth. */
          inBand: band ? { label: band.label ?? `${band.from}${band.to === null ? '+' : `–${band.to}`}`, value: band.value } : null,
          /** The next step up, and how far away it is. */
          next: next ? { at: next.from, value: next.value, remaining: next.from - result.count } : null,
          isTarget: isTarget({ type: rule.type, tiers }),
          goal: targetGoal(tiers),
          /** Below this the rule pays nothing at all. */
          minOrders: rule.minOrders,
        });
      }
    }

    return NextResponse.json({
      rows,
      note: 'أرقام الفترة الجارية — تتغيّر مع كل طلب، ولا تصير عمولة إلا بعد انتهاء الفترة.',
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
