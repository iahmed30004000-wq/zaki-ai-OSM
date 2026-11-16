import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { currentSpan } from '@/lib/commission-period';
import { readAgentCommission } from '@/lib/agent-commission-settings';
import { readCommissionPreview } from '@/lib/agent-commission-calc';

/**
 * GET /api/performance/commission-preview — the month's commission ESTIMATE per agent (step G2 of Confirmation Center v2), with the rule that made each number.
 *
 * Money figures are the payroll's: the key is `payroll.view`, asked before anything is read, exactly as the owed figure of the performance card is. An estimate, not the ledger:
 * nothing here writes, accrues or pays (`agent-commission-calc.ts`). The month is the commission module's own span. Agents and amounts only — no customer field.
 */
export async function GET() {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('payroll.view');

    const now = new Date();
    const span = currentSpan('MONTHLY', now);
    const config = await readAgentCommission(db, companyId);
    const rows = await readCommissionPreview(db, { companyId, storeId, start: span.start, end: span.end }, config, now);
    return NextResponse.json({ window: { start: span.start.toISOString(), end: span.end.toISOString() }, config, rows });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
