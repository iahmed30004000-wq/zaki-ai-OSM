import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { REJECTION_REASONS, REJECTION_REASON_AR } from '@/lib/confirmation-workflow';
import { PERIODS, PERIOD_AR } from '@/lib/winback-filters';
import { BULK_MAX, bulkAgents } from '@/lib/winback-bulk';

/**
 * GET /api/confirmation/winback/bulk — what the «وزّع على الموظفات» card needs to draw itself: the agents of this store who may receive
 * an order (each with her room under her cap), the reasons and periods to filter by, and the most one press makes. Read only; the plan
 * and the run are `POST /api/confirmation/winback` with an `action` (the one creator). The products and their win-back prices are
 * `./prices`.
 *
 * Who: the offer's box; the card is offered only to whoever ALSO holds «إسناد الطلبات» (`orders.assign`, `canBulk`) — a manager's key, not an agent's. No customer
 * field is read.
 */
export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.winback');
    const canBulk = can(user, 'orders.assign');
    if (!canBulk || !storeId) return NextResponse.json({ canBulk: false, storeRequired: canBulk && !storeId });

    const agents = await bulkAgents({ companyId, storeId });
    return NextResponse.json({
      canBulk: true,
      max: BULK_MAX,
      agents,
      reasons: REJECTION_REASONS.map((code) => ({ code, label: REJECTION_REASON_AR[code] ?? code })),
      periods: PERIODS.map((p) => ({ code: p, label: PERIOD_AR[p] })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
