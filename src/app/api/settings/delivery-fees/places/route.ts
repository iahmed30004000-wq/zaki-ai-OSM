import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { courierScope } from '@/lib/courier-scope';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { courierPlaces } from '@/lib/courier-places';

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
      select: { code: true },
    });
    return NextResponse.json({ places: provider ? courierPlaces(provider.code) : null });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
