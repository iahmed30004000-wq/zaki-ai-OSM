import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { forgetRoundsSwitch, roundsSwitch, saveRoundsSwitch } from '@/lib/no-answer-rounds-switch';

/**
 * GET/PUT /api/settings/no-answer-rounds — «نظام الجولات (تجريبي)», the owner's switch (`no-answer-rounds.ts`).
 *
 * OFF by default, and OFF is the old rotation and rounds exactly (the pull's order and the cap do not depend on it). ON changes
 * who holds an order nobody answered and when three no-answers close it — work an agent is paid on — so turning it is
 * `settings.manage`, the box the owner holds for the company's keys, and not a supervisor's. Seen by whoever opens the settings
 * page (`settings.view`).
 *
 * The body is `{ enabled: boolean }` and nothing else: the moment it went on is the server's clock, never the client's,
 * because nothing logged before that moment may move an order.
 */
function view(sw: { enabled: boolean; enabledAt: Date | null }) {
  return { enabled: sw.enabled, enabledAt: sw.enabledAt ? sw.enabledAt.toISOString() : null };
}

export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');
    forgetRoundsSwitch(companyId);
    return NextResponse.json({ rounds: view(await roundsSwitch(db, companyId)) });
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

    forgetRoundsSwitch(companyId);
    const before = await roundsSwitch(db, companyId);
    const saved = await saveRoundsSwitch(companyId, body.enabled);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'NO_ANSWER_ROUNDS_SWITCHED',
      entity: 'Company',
      entityId: companyId,
      previousData: view(before),
      newData: view(saved),
    });

    return NextResponse.json({ rounds: view(saved) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
