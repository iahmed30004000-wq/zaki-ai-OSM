import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { deliveryWindows, deliveryWindowAr, type DeliveryWindow } from '@/lib/delivery-time';
import { shortMemo } from '@/lib/short-memo';

/** One minute, at most this many (company, store) pairs. */
const WINDOWS = shortMemo<Map<string, DeliveryWindow>>(60_000, 200);

/**
 * GET /api/geo/regions — the governorates of the SELECTED country.
 *
 * Reference data for every order form. Before this, the order screens read a
 * hard-coded Syrian list, so a Jordanian store offered Syrian governorates
 * and no order could be priced against the fee table.
 *
 * Any user with a country + store context may read it: it is a list of
 * place names, and every screen that creates an order needs it.
 */
export async function GET() {
  try {
    const { countryId, country, companyId, storeId } = await requireContext();

    const regions = await db.region.findMany({
      where: { countryId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    });

    /**
     * HOW LONG EACH ONE ACTUALLY TAKES, measured from delivered orders.
     *
     * «لما أدخل طلب بالمدينة والعنوان يعطيني خلال كم الفترة المتوقعة
     * للاستلام» — and every screen that needs the governorates is the
     * screen that needs to say it. Governorates with too few deliveries
     * carry nothing rather than an anecdote; see src/lib/delivery-time.ts.
     */
    // A minute's memory, per company AND store (RV184): the orders screen
    // asks this door three times on every opening, and each answer is a scan
    // of 180 days of delivered orders. A delivery time that is a minute old
    // is as true as one a second old.
    const windows = await WINDOWS.get(`${companyId}:${storeId ?? ''}`, () => deliveryWindows({ companyId, storeId }));

    return NextResponse.json({
      // The currency travels with the country: every screen that needs the
      // governorates is a screen that shows money in that country's currency.
      country: {
        id: country.id, code: country.code, name: country.name,
        currencyCode: country.currencyCode, minorUnit: country.minorUnit,
      },
      regions: regions.map((r) => {
        const w = windows.get(r.id) ?? null;
        return { ...r, delivery: w, deliveryAr: deliveryWindowAr(w) };
      }),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
