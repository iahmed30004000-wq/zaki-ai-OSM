import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { forgetPerLineSwitch, perLineSettlementSwitch, savePerLineSwitch } from '@/lib/per-line-settlement-switch';

/**
 * GET/PUT /api/settings/per-line-settlement — «تسوية السطور النظيفة عند الاعتماد (تجريبي)», the owner's switch
 * (`per-line-settlement-switch.ts`).
 *
 * OFF by default, and OFF is every rule exactly as it is today. ON changes WHEN a statement's clean orders are settled — at the
 * approval instead of at the close of its matching — which makes commission payable and consumes stock, so turning it is
 * `settings.manage`, the box the owner holds for the company's keys, and not an accountant's. Seen by whoever opens the settings page
 * (`settings.view`). The twin of «الطلب يرجع للطابور فوراً»'s door, minus the dependency: it needs no other switch.
 *
 * The body is `{ enabled: boolean }` and nothing else: the moment it went on is the server's clock, never the client's.
 */
function view(sw: { enabled: boolean; enabledAt: Date | null }) {
  return { enabled: sw.enabled, enabledAt: sw.enabledAt ? sw.enabledAt.toISOString() : null };
}

export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');
    forgetPerLineSwitch(companyId);
    return NextResponse.json({ perLine: view(await perLineSettlementSwitch(db, companyId)) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.manage');

    const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).some((k) => k !== 'enabled')) {
      const errorAr = 'أرسل «مفعّل» نعم أو لا فقط.';
      return NextResponse.json({ error: errorAr, errorAr, code: 'INVALID_SWITCH' }, { status: 400 });
    }

    forgetPerLineSwitch(companyId);
    const before = await perLineSettlementSwitch(db, companyId);
    const saved = await savePerLineSwitch(companyId, body.enabled);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PER_LINE_SETTLEMENT_SWITCHED',
      entity: 'Company',
      entityId: companyId,
      previousData: view(before),
      newData: view(saved),
    });

    return NextResponse.json({ perLine: view(saved) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
