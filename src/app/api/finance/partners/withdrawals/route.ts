import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { WITHDRAWALS_MOVED, saveStanding, standingFor, withdrawalsBook } from '@/lib/partner-withdrawals';
import { readHistoryFilters } from '@/lib/history-export-core';
import type { Refusal } from '@/lib/partner-withdrawals-core';

/**
 * «المسحوبات» — THE PARTNERS' WITHDRAWALS DASHBOARD (23/11, F7; the record of 22/11 before it).
 *
 *   GET   the dashboard: the PARTNER_DRAW wallet movements of this store (?from=&to= on the real date), the totals per partner and
 *         currency, per store, the standing amounts, the wallets the one press may use, and the old record read-only.
 *         `?part=standing` answers the standing amounts alone (the wallet dialog's pre-fill).
 *   POST  RETIRED — a withdrawal is a wallet movement now (`POST /api/finance/partners/draws`). Refused, nothing written.
 *   PATCH RETIRED — a withdrawal is taken back by the wallet's reversing entry. Refused, nothing written.
 *   PUT   the standing amounts of one partner, one per currency, with what each is worth in the store's currency.
 *
 * «والحركات تكون من المحافظ … ما بدي الحركات المالية بكل مكان، خلص مكان واحد» (the owner). EVERY handler asks `finance.partners`
 * («الشركاء والسحوبات») FIRST, before the body is read. No money is written here: the dashboard reads, the standing amounts are a
 * setting, and the cash leaves a wallet only through the draws door, which asks the cash box's key as well.
 */

const refuse = (r: Refusal) => NextResponse.json({ error: r.errorAr, errorAr: r.errorAr, code: r.code }, { status: r.status });
const readBody = async (req: Request) => {
  const b = await req.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
};
const BAD_BODY: Refusal = { status: 400, code: 'INVALID_BODY', errorAr: 'الطلب مش مفهوم.' };

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('finance.partners');

    const params = new URL(req.url).searchParams;
    if (params.get('part') === 'standing') {
      return NextResponse.json({ standing: await standingFor(companyId), storeCurrency: country.currencyCode });
    }
    const filters = readHistoryFilters(params);
    if (!filters.ok) return refuse(filters.refusal);
    const book = await withdrawalsBook({ user, companyId, storeId, country, filters: filters.value });
    // Whether the one press is drawn: the draws door asks the cash box's key too, and a press that ends in a refusal is not offered.
    return NextResponse.json({ ...book, mayRecord: can(user, 'finance.cashbox') });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** RETIRED (23/11, F7) — marked, not removed: the key is still asked first, then the sentence that says where it went. */
export async function POST() {
  try {
    await requireContext();
    await requirePermission('finance.partners');
    return refuse(WITHDRAWALS_MOVED);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** RETIRED (23/11, F7) — an old record row is read-only; a draw is taken back at its wallet. */
export async function PATCH() {
  try {
    await requireContext();
    await requirePermission('finance.partners');
    return refuse(WITHDRAWALS_MOVED);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId, country } = await requireContext();
    await requirePermission('finance.partners');

    const body = await readBody(req);
    if (!body) return refuse(BAD_BODY);
    const done = await saveStanding({ user, companyId, storeCurrency: country.currencyCode, body });
    if (!done.ok) return refuse(done.refusal);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PARTNER_STANDING_SAVED',
      entity: 'PartnerStandingAmount',
      entityId: done.value.partnerId,
      newData: done.value,
    });
    return NextResponse.json({ standing: done.value });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
