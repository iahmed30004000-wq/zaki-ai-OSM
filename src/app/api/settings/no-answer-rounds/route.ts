import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { forgetRoundsSwitch, roundsSwitch } from '@/lib/no-answer-rounds-switch';
import { RETIRED_SWITCH_AR, RETIRED_SWITCH_CODE } from '@/lib/retired-switch';

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
 *
 * REQUEST C2 (18/11): THE CARD LEFT «قواعد مركز التأكيد» AND THIS DOOR TAKES NO MORE WRITES. GET is as it was; PUT asks who you are and what you hold (as before) and
 * then refuses with 409 `RULE_RETIRED` — nothing is read for writing, nothing is saved, nothing is audited (`retired-switch.ts`). The stored value is left as it is.
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

export async function PUT() {
  try {
    await requireContext();
    await requirePermission('settings.manage');
    return NextResponse.json({ error: RETIRED_SWITCH_AR, errorAr: RETIRED_SWITCH_AR, code: RETIRED_SWITCH_CODE }, { status: 409 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
