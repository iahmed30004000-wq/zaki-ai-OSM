import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { callProofSwitch, forgetCallProofSwitch, saveCallProofSwitch } from '@/lib/call-proof-switch';

/**
 * GET/PUT /api/settings/call-proof — «إثبات المكالمات وجدول المحاولات (تجريبي)», the owner's switch (`call-proof-switch.ts`).
 *
 * OFF by default, and OFF is every rule exactly as it is today. ON changes when an agent may record «لا يرد» (only after a logged «اتصال» press at least thirty
 * seconds old) — work an agent is paid on — so turning it is `settings.manage`, the box the owner holds for the company's keys, and not a supervisor's.
 * Seen by whoever opens the settings page (`settings.view`). It needs no other switch.
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
    forgetCallProofSwitch(companyId);
    return NextResponse.json({ callProof: view(await callProofSwitch(db, companyId)) });
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

    forgetCallProofSwitch(companyId);
    const before = await callProofSwitch(db, companyId);
    const saved = await saveCallProofSwitch(companyId, body.enabled);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'CALL_PROOF_SWITCHED',
      entity: 'Company',
      entityId: companyId,
      previousData: view(before),
      newData: view(saved),
    });

    return NextResponse.json({ callProof: view(saved) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
