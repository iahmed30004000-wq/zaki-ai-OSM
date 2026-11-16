import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { readAgentCommission, saveAgentCommission, validateAgentCommission } from '@/lib/agent-commission-settings';

/**
 * GET/PUT /api/settings/agent-commission — the commission CALCULATOR's settings (step G2 of Confirmation Center v2): the tiers, the per-order bonus and the optional quality gate.
 *
 * It changes an ESTIMATE only (`agent-commission-calc.ts`): nothing here touches a commission rule, an accrual or a payout. Seen by whoever opens the settings page (`settings.view`);
 * changed by `settings.manage` — the box the owner holds for the company's keys. The body is the whole document and is validated whole: an invalid one is refused with an Arabic
 * sentence and nothing is stored (no partial save, no unknown field). One audit row with the before and the after.
 */
export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');
    return NextResponse.json({ agentCommission: await readAgentCommission(db, companyId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.manage');

    const body = await req.json().catch(() => null);
    const checked = validateAgentCommission(body);
    if (!checked.ok) return NextResponse.json({ error: checked.error, errorAr: checked.error, code: 'INVALID_COMMISSION_CALCULATOR' }, { status: 400 });

    const before = await readAgentCommission(db, companyId);
    const saved = await saveAgentCommission(companyId, checked.config);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'AGENT_COMMISSION_CHANGED',
      entity: 'Company',
      entityId: companyId,
      previousData: before,
      newData: saved,
    });

    return NextResponse.json({ agentCommission: saved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
