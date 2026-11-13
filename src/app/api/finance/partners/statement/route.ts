import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { partnerStatement } from '@/lib/partner-statement';

/**
 * GET /api/finance/partners/statement — THE PARTNERS' STATEMENT FOR THE CURRENT STORE (13/11).
 *
 * The single source for the profit screen's «الشركاء», the wallet dialog's live hint and the tests: each partner's share of the net
 * profit (the number the profit screen prints under «صافي الربح»), what he has drawn, the balance, and «مكسور عليه» — everything since
 * the beginning, in the store's currency. Read-only. Asks `finance.partners` FIRST: the figures are the partners' business, and the
 * key is the owner's to tick.
 */
export async function GET() {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('finance.partners');

    return NextResponse.json(
      await partnerStatement({ companyId, storeId, currency: country.currencyCode, minorUnit: country.minorUnit })
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
