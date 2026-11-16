import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { leadsV2Switch, forgetLeadsV2Switch, saveLeadsV2Switch } from '@/lib/leads/leads-v2-switch';

/**
 * GET/PUT /api/settings/leads-v2 — «ليدز الصفحات (تجريبي)», the owner’s switch (`leads/leads-v2-switch.ts`, step E of Confirmation Center v2).
 *
 * OFF by default: the signed webhook of the pages system answers «received» and keeps nothing. ON, it keeps each lead once (a person's name and number, so the owner decides, `settings.manage`,
 * the box he holds for the company's keys) and flags the ones that already ordered the same product in the last 24 hours. Seen by whoever opens the settings page (`settings.view`).
 * It needs no other switch. The secret that makes the webhook accept anything is an environment variable (`PAGES_WEBHOOK_SECRET`), never a setting.
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
    forgetLeadsV2Switch(companyId);
    return NextResponse.json({ leadsV2: view(await leadsV2Switch(db, companyId)) });
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

    forgetLeadsV2Switch(companyId);
    const before = await leadsV2Switch(db, companyId);
    const saved = await saveLeadsV2Switch(companyId, body.enabled);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'LEADS_V2_SWITCHED',
      entity: 'Company',
      entityId: companyId,
      previousData: view(before),
      newData: view(saved),
    });

    return NextResponse.json({ leadsV2: view(saved) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
