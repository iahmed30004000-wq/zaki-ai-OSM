import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { courierScope } from '@/lib/couriers/scope';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { courierPlaces } from '@/lib/couriers/places';

/**
 * GET /api/settings/delivery-fees/places?courier=<id>
 *
 * The cities and regions the courier's own list names, so the «رمزها عند الشركة» box can say which place a typed
 * number is. Reference data from the repo, not the store's: it carries no customer and no money.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('settings.view');

    const id = new URL(req.url).searchParams.get('courier');
    if (!id) return NextResponse.json({ places: null });

    const provider = await db.deliveryProvider.findFirst({
      where: { id, ...courierScope(companyId, storeId) },
      // The code AND the platform: production's Basha row is «LEG-1» on LogesTechs (`places.courierListKey`).
      select: { code: true, adapterCode: true },
    });
    return NextResponse.json({ places: courierPlaces(provider) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
