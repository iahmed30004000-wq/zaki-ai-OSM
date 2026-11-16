import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { intakeFilterSwitch, forgetIntakeFilterSwitch, saveIntakeFilterSwitch } from '@/lib/intake-filter-switch';

/**
 * GET/PUT /api/settings/intake-filter — «فلتر الاستقبال (تجريبي)», the owner’s switch (`intake-filter-switch.ts`, step C of Confirmation Center v2).
 *
 * OFF by default, and OFF is every rule exactly as it is today. ON makes the system flag a repeated order and an oddly-shaped number on a NEW order — a note the agent
 * reads, nothing refused, nothing closed — so turning it is `settings.manage`, the box the owner holds for the company's keys, and not a supervisor's.
 * Seen by whoever opens the settings page (`settings.view`). It needs no other switch, and it is not the call-proof switch.
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
    forgetIntakeFilterSwitch(companyId);
    return NextResponse.json({ intakeFilter: view(await intakeFilterSwitch(db, companyId)) });
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

    forgetIntakeFilterSwitch(companyId);
    const before = await intakeFilterSwitch(db, companyId);
    const saved = await saveIntakeFilterSwitch(companyId, body.enabled);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'INTAKE_FILTER_SWITCHED',
      entity: 'Company',
      entityId: companyId,
      previousData: view(before),
      newData: view(saved),
    });

    return NextResponse.json({ intakeFilter: view(saved) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
