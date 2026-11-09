import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { roundsOn } from '@/lib/no-answer-rounds';
import { roundsSwitch } from '@/lib/no-answer-rounds-switch';
import { forgetReturnsSwitch, returnsSwitch, saveReturnsSwitch } from '@/lib/no-answer-returns-switch';

/**
 * GET/PUT /api/settings/no-answer-returns — «الطلب يرجع للطابور فوراً (تجريبي)», the owner's switch (`no-answer-returns.ts`).
 *
 * OFF by default, and OFF is every rule exactly as it is today. ON changes who holds an order nobody answered, and how many an agent
 * may hold — work an agent is paid on — so turning it is `settings.manage`, the box the owner holds for the company's keys, and not a
 * supervisor's. Seen by whoever opens the settings page (`settings.view`). The twin of «نظام الجولات»' door, line for line.
 *
 * It does nothing without «نظام الجولات» (the close is the rounds' counting). GET says whether the rounds are on, so the card is drawn
 * disabled with the reason; PUT refuses to turn it ON while they are off (409 `ROUNDS_OFF`) rather than store a wish that would
 * switch itself on the day the rounds do. Turning it OFF is always allowed.
 *
 * The body is `{ enabled: boolean }` and nothing else: the moment it went on is the server's clock, never the client's.
 */
function view(sw: { enabled: boolean; enabledAt: Date | null }) {
  return { enabled: sw.enabled, enabledAt: sw.enabledAt ? sw.enabledAt.toISOString() : null };
}

const ROUNDS_OFF_MESSAGE = 'لازم «نظام الجولات» يكون شغّال أول — هالمفتاح ما بيشتغل إلا معه.';

export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');
    forgetReturnsSwitch(companyId);
    return NextResponse.json({
      returns: view(await returnsSwitch(db, companyId)),
      // The mode needs the rounds: the card says so, and is disabled, while they are off.
      roundsOn: roundsOn(await roundsSwitch(db, companyId)),
    });
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

    const rounds = roundsOn(await roundsSwitch(db, companyId));
    if (body.enabled && !rounds) {
      return NextResponse.json({ error: ROUNDS_OFF_MESSAGE, errorAr: ROUNDS_OFF_MESSAGE, code: 'ROUNDS_OFF' }, { status: 409 });
    }

    forgetReturnsSwitch(companyId);
    const before = await returnsSwitch(db, companyId);
    const saved = await saveReturnsSwitch(companyId, body.enabled);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'NO_ANSWER_RETURNS_SWITCHED',
      entity: 'Company',
      entityId: companyId,
      previousData: view(before),
      newData: view(saved),
    });

    return NextResponse.json({ returns: view(saved), roundsOn: rounds });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
