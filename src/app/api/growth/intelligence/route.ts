import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { FAMILIES, MIN_SAMPLE, runDetectors } from '@/lib/intelligence';
import { REPORT_TTL_MS, heavyOnce } from '@/lib/heavy-lane';

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

    // Eleven detectors over the whole history (about half a second, 21 statements) ran on EVERY dashboard mount. What they find does
    // not depend on who asks — the key is checked above — so it is one computation per company and store, in the reports' lane, kept
    // a minute (13/11).
    const { findings, skipped } = await heavyOnce(
      ['intelligence', companyId, storeId ?? '', String(country.minorUnit), country.currencyCode].join('|'),
      REPORT_TTL_MS,
      () => runDetectors(db, scope)
    );
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
