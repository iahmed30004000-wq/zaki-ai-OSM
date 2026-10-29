import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { FAMILIES, MIN_SAMPLE, runDetectors } from '@/lib/intelligence';

/**
 * GET /api/growth/intelligence — what is bleeding, and what to do.
 *
 * Business analysis over operational data, not the chat assistant. Every
 * figure is counted from orders that exist; where the data cannot answer,
 * the answer is "not enough data" rather than a plausible-sounding number.
 */
export async function GET() {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('growth.intelligence');

    const scope = {
      companyId,
      storeId,
      minorUnit: country.minorUnit,
      currency: country.currencyCode,
    };

    const { findings, skipped } = await runDetectors(db, scope);
    const totalOrders = await db.order.count({ where: { companyId, storeId } });

    return NextResponse.json({
      findings,
      // Detectors that threw and were left out, by name. Empty when all ran.
      skipped,
      totalOrders,
      minSample: MIN_SAMPLE,
      counts: {
        alarm: findings.filter((f) => f.severity === 'ALARM').length,
        watch: findings.filter((f) => f.severity === 'WATCH').length,
      },
      // Per tab, so the dashboard can say WHERE the trouble is without
      // fetching twice or counting in two places.
      byFamily: Object.fromEntries(
        FAMILIES.map((f) => [
          f.key,
          {
            total: findings.filter((x) => x.family === f.key).length,
            alarm: findings.filter((x) => x.family === f.key && x.severity === 'ALARM').length,
          },
        ])
      ),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
