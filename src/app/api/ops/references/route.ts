import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { courierScope } from '@/lib/couriers/scope';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';

/**
 * GET /api/ops/references — couriers and regions for the operations filters.
 *
 * The shipping, warehouse and settlement roles need these lists but hold no
 * settings permission; the settings endpoint stays settings-only, and this
 * one returns names and ids alone, for anyone who works a shipment screen or
 * imports a courier statement.
 */
const OPS_PERMISSIONS = [
  'ops.ship', 'ops.labels', 'ops.track', 'ops.returns', 'ops.prepare',
  'settlement.view', 'settlement.upload',
];

export async function GET() {
  try {
    const { user, companyId, countryId, storeId } = await requireContext();
    if (!OPS_PERMISSIONS.some((p) => can(user, p))) {
      return NextResponse.json({ error: 'Forbidden: missing an operations permission', errorAr: 'لا تملك أيّ صلاحيّةٍ من صلاحيّات التشغيل.' }, { status: 403 });
    }

    const [providers, regions] = await Promise.all([
      db.deliveryProvider.findMany({
        // Only this store's couriers, plus the ones shared by all.
        where: { ...courierScope(companyId, storeId), isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true, kind: true },
      }),
      db.region.findMany({
        where: { countryId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true },
      }),
    ]);

    return NextResponse.json({ providers, regions });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
