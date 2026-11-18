import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { roundsOn } from '@/lib/no-answer-rounds';
import { roundsSwitch } from '@/lib/no-answer-rounds-switch';
import { forgetReturnsSwitch, returnsSwitch } from '@/lib/no-answer-returns-switch';
import { RETIRED_SWITCH_AR, RETIRED_SWITCH_CODE } from '@/lib/retired-switch';

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
 *
 * REQUEST C2 (18/11): THE CARD LEFT «قواعد مركز التأكيد» AND THIS DOOR TAKES NO MORE WRITES — on or off. GET is as it was; PUT asks who you are and what you hold (as
 * before) and then refuses with 409 `RULE_RETIRED`: nothing is saved, nothing is audited (`retired-switch.ts`). The stored value is left as it is.
 */
function view(sw: { enabled: boolean; enabledAt: Date | null }) {
  return { enabled: sw.enabled, enabledAt: sw.enabledAt ? sw.enabledAt.toISOString() : null };
}


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

export async function PUT() {
  try {
    await requireContext();
    await requirePermission('settings.manage');
    return NextResponse.json({ error: RETIRED_SWITCH_AR, errorAr: RETIRED_SWITCH_AR, code: RETIRED_SWITCH_CODE }, { status: 409 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
