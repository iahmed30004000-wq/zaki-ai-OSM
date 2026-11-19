import { NextRequest, NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { requirePermission } from '@/lib/authorization';
import { rateLimit } from '@/lib/rate-limit';
import { resolveFiredDay, ruleFiredAnswer } from '@/lib/rule-fired';

/**
 * GET /api/confirmation/rules/fired?day=YYYY-MM-DD — «القاعدة اشتغلت عندها كم مرة»: for one day of THIS store, per person at the
 * desk, how many times each rule caught her (`lib/rule-fired.ts` says where each figure is read from).
 *
 * WHO ASKS: `settings.view` (the rules page) AND `team.monitor` (the team's numbers, as the team table and the end-of-day report ask).
 * Both are asked before anything is read.
 *
 * THE DAY: the store's day (the country's time zone). No `day` is today; a malformed day → 400 `INVALID_DAY`; a day still to come →
 * 400 `DAY_IN_FUTURE`. The answer is a report: computed in the reports lane, once per (company, store, day) — not per person.
 *
 * Reading only. Ids and counts: no order, no customer.
 */

const READS_PER_WINDOW = 30;
const READ_WINDOW_MS = 60_000;
const TOO_MANY = 'طلبات كتير ورا بعض — استنّى دقيقة وجرّب';

function refuse(status: number, code: string, errorAr: string, headers?: Record<string, string>) {
  return NextResponse.json({ error: errorAr, errorAr, code }, { status, headers });
}

export async function GET(request: NextRequest) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settings.view');
    await requirePermission('team.monitor');

    const limit = rateLimit(`rule-fired:${user.id}`, READS_PER_WINDOW, READ_WINDOW_MS);
    if (!limit.allowed) return refuse(429, 'RATE_LIMITED', TOO_MANY, { 'Retry-After': String(limit.retryAfterSec) });

    const when = resolveFiredDay(new URL(request.url).searchParams.get('day'), new Date(), country.timezone);
    if (!when.ok) return refuse(400, when.code, when.errorAr);

    return NextResponse.json(await ruleFiredAnswer({ companyId, storeId, timeZone: country.timezone, when }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
