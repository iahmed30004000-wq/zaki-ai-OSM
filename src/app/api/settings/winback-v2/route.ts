import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { winbackV2Switch, forgetWinbackV2Switch, saveWinbackV2Switch } from '@/lib/winback-v2-switch';

/**
 * GET/PUT /api/settings/winback-v2 — «الاسترجاع اليومي (تجريبي)», the owner’s switch (`winback-v2-switch.ts`, step F of Confirmation Center v2).
 *
 * OFF by default, and OFF is the follow-up screen exactly as it is today. ON adds the daily list (lost orders 24–72 hours after the outcome, and postponed orders whose date was missed)
 * with an assignee and a tracked result to the «ملغاة سابقاً» tab — nothing is offered, discounted, closed or messaged by it, so turning it is `settings.manage`, the box the owner holds
 * for the company's keys. Seen by whoever opens the settings page (`settings.view`). It needs no other switch.
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
    forgetWinbackV2Switch(companyId);
    return NextResponse.json({ winbackV2: view(await winbackV2Switch(db, companyId)) });
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

    forgetWinbackV2Switch(companyId);
    const before = await winbackV2Switch(db, companyId);
    const saved = await saveWinbackV2Switch(companyId, body.enabled);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'WINBACK_V2_SWITCHED',
      entity: 'Company',
      entityId: companyId,
      previousData: view(before),
      newData: view(saved),
    });

    return NextResponse.json({ winbackV2: view(saved) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
