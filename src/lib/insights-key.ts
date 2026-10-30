import { NextResponse } from 'next/server';
import { can } from '@/lib/authorization';
import type { SessionUser } from '@/types/auth';

/**
 * THE SMART CARDS ASK ONE KEY, BESIDE THE KEY OF THE SCREEN THEY ARE DRAWN ON (perm-plan PR-10, D2).
 *
 * A product's grade, the dashboard's rankings and loss reasons, a channel's score, an order's return risk, a customer's
 * return risk, a campaign's best and worst, a landing page's verdict and the live counts in the search box are VERDICTS
 * about the shop, not its records. Until now each came with the screen it sits on: whoever could open the screen could not be
 * kept from the verdict.
 *
 * `insights.view` is a visibility key. It opens no screen and it is never enough alone: the door still asks the screen's own
 * key first, and this one decides only whether the CARD travels. Two shapes, by what the door is:
 *
 *   · a door that exists only to serve a card (the grades, the product figures, the channel scores, the loss reasons, the order's
 *     return risk) answers 403 with a sentence in Arabic;
 *   · a door that serves records AND a card leaves the card out of the answer — absent, not zero and not null, because a zero is
 *     the claim «nothing happened» and a null «not measured» — and the screen draws no card where the field is not there.
 *
 * The migration 20261030170000_costs_insights_keys gave the key to everybody who held the key of a screen a card is drawn
 * on, so nobody lost a card on the day.
 */
export const INSIGHTS_KEY = 'insights.view';

/** The one sentence a card door answers with, in both fields (`arabic-refusals` lets no new English refusal in). */
export const INSIGHTS_REFUSAL = 'البطاقات الذكية مقفلة على حسابك — اطلب مفتاح «عرض البطاقات الذكية» من المدير.';

export function mayReadInsights(user: SessionUser): boolean {
  return can(user, INSIGHTS_KEY);
}

/** The 403 of a door that serves only cards. */
export function insightsRefused(): NextResponse {
  return NextResponse.json({ error: INSIGHTS_REFUSAL, errorAr: INSIGHTS_REFUSAL, code: 'INSIGHTS_REQUIRED' }, { status: 403 });
}
