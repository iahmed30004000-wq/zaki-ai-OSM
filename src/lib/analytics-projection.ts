import { can } from '@/lib/authorization';
import { allowedScopes, scopeContext } from '@/lib/ai-scope';
import { TEAM_PERMISSIONS } from '@/lib/ai-assistants';
import type { SessionUser } from '@/types/auth';

/**
 * WHAT THE DASHBOARD'S ANSWER CARRIES, BY WHO IS ASKING.
 *
 * `/api/analytics` already held back `financials`, and it said why: the
 * dashboard hides every money tile behind «عرض المالية», and «a control
 * hidden in the UI but permitted by the API is not a permission». The rest
 * of the same answer went on carrying the money in other shapes:
 *
 *   • every product's revenue, cost of goods, shipping, net profit and
 *     margin (`productStats`, and the `rankings` built from it);
 *   • every moderator's sales and commission, by name (`moderatorLeaderboard`);
 *   • last period's delivered revenue (`previous`);
 *   • the money still out with couriers (`vitals.outstanding.money`);
 *   • delivered revenue in the AI context, which the filter's pattern missed;
 *   • and the latest ten orders with their customers' phones (`orders`),
 *     which no screen reads at all.
 *
 * Money now leaves only with «عرض المالية», as on every money screen. A
 * colleague's numbers leave only with the key of a screen that already shows
 * them (the AI's TEAM_PERMISSIONS): the performance board, the team
 * scoreboard, the people screen. The counts and rates stay — they are what
 * the dashboard is for.
 */

const PRODUCT_MONEY = ['revenue', 'cogs', 'shippingCost', 'netProfit', 'profitMargin'] as const;
const PERSON_MONEY = ['sales', 'commissions'] as const;

type Row = Record<string, unknown>;

function without(row: unknown, fields: readonly string[]): unknown {
  if (!row || typeof row !== 'object') return row;
  const out: Row = { ...(row as Row) };
  for (const f of fields) delete out[f];
  return out;
}

export function maySeeColleagues(user: SessionUser): boolean {
  return TEAM_PERMISSIONS.some((p) => can(user, p));
}

/** The analytics answer, as this person may read it. `orders` never leaves. */
export function projectAnalytics(analytics: Row, user: SessionUser): Row {
  const money = can(user, 'finance.view');
  const team = maySeeColleagues(user);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { orders, financials, aiContext, productStats, rankings, moderatorLeaderboard, topModerator, ...rest } = analytics;

  const out: Row = { ...rest };
  if (money) out.financials = financials;

  if (aiContext && typeof aiContext === 'object') {
    // The same closed map the assistant uses: a key nobody classified is dropped.
    out.aiContext = scopeContext(aiContext as object, allowedScopes(['orders', 'finance', 'team'], (p) => can(user, p))).context;
    // The two rankings the model is told are the smart cards again (PR-10): they follow `insights.view` into the context too.
    if (!can(user, 'insights.view') && out.aiContext && typeof out.aiContext === 'object') {
      const ctx = { ...(out.aiContext as Row) };
      delete ctx.top_demanded_product;
      delete ctx.highest_rejection_product;
      out.aiContext = ctx;
    }
  }

  if (Array.isArray(productStats)) {
    out.productStats = money ? productStats : productStats.map((p) => without(p, PRODUCT_MONEY));
  }

  // The five «most / highest» products are smart cards (PR-10): ABSENT, not an empty object, without `insights.view`.
  if (rankings && typeof rankings === 'object' && can(user, 'insights.view')) {
    const r = rankings as Row;
    out.rankings = money
      ? r
      : Object.fromEntries(
          Object.entries(r)
            // The most profitable product IS a money figure, whatever is stripped from it.
            .filter(([k]) => k !== 'mostProfitable')
            .map(([k, v]) => [k, without(v, PRODUCT_MONEY)]),
        );
  }

  if (team) {
    if (Array.isArray(moderatorLeaderboard)) {
      out.moderatorLeaderboard = money ? moderatorLeaderboard : moderatorLeaderboard.map((m) => without(m, PERSON_MONEY));
    }
    if (topModerator !== undefined) out.topModerator = money ? topModerator : without(topModerator, PERSON_MONEY);
  }

  return out;
}
