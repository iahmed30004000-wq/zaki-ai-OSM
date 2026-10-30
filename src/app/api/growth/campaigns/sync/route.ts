import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { syncAdSpend } from '@/lib/ads/sync';

/**
 * POST /api/growth/campaigns/sync — pull the spend now.
 *
 * The button. The work itself lives in `syncAdSpend`, because it also runs
 * on a schedule before anybody arrives in the morning: when it lived here
 * the spend was only ever pulled if somebody opened this screen, and a shop
 * whose owner did not look for a week showed a week of campaigns whose
 * profit was computed from a cost of zero.
 */
export async function POST() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('campaigns.manage');

    const result = await syncAdSpend({ companyId, storeId });

    if (result.updated > 0) {
      await logAudit({
        companyId,
        userId: user.id,
        action: 'CAMPAIGN_SPEND_SYNCED',
        entity: 'Campaign',
        entityId: storeId ?? '',
        newData: { updated: result.updated, accounts: result.accounts.length },
      });
    }

    return NextResponse.json(result);
  } catch (e) {
    return apiErrorResponse(e);
  }
}
