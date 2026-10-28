import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { validateWinbackRule } from '@/lib/winback';
import { saveWinbackRule, winbackRule } from '@/lib/winback-rule';

/**
 * PUT /api/confirmation/winback/rule — the owner's rule for «استرجاع الملغى».
 *
 * «شو القاعدة تبعو لاني ممكن اعدلها». Five things may be turned, all within
 * bounds (`WINBACK_BOUNDS`): which reasons are worth a second call (the four the
 * screen was built for, and three more at the owner's own risk), whether a
 * parcel that shipped and came back is read too («يشمل المرتجع بعد الشحن», a
 * yes or a no, on when it is left out — 28/10), how long to wait, how far back
 * to look, how much of the price may be given away. Nothing else is read from
 * the body — `.strict()` in spirit: a field this route does not know is a
 * refusal, so a form that still sends one finds out.
 *
 * WHO. `settings.manage` — the owner and the admin. A supervisor works the list
 * and reads the rule on the screen; changing how much money may be given away is
 * not a supervisor's decision (the offer's own ceiling, `confirmation.supervise`,
 * is what she works under).
 *
 * REFUSED, NOT CLAMPED. A stored rule is read leniently; a typed one is judged
 * (`validateWinbackRule`), because «500%» is a slip and quietly storing 50 would
 * let the owner believe he had set what he typed. Every refusal is a 400 in
 * Arabic that names the field and the limit.
 *
 * WRITTEN DOWN. Who changed it, from what, to what — it decides how much of the
 * company's money a discount may give away.
 *
 * NOT WHAT IS ALWAYS REFUSED. A parcel that left and is not back (or is back and
 * nobody received it), an order already offered, a second chance, a duplicate,
 * a wrong number, a fake order, an entry error: no value of this rule reaches
 * any of them, and `winbackVerdict` applies every one of those whatever is
 * stored here. (The first of them read «a shipped parcel» until 28/10, when the
 * owner ruled the ones that came back in, behind the switch above.)
 */
export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.manage');

    const parsed = validateWinbackRule(await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr, errorAr: parsed.errorAr, code: parsed.code }, { status: 400 });

    const before = await winbackRule(companyId);
    const saved = await saveWinbackRule(companyId, parsed.rule);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'WINBACK_RULE_UPDATED',
      entity: 'Company',
      entityId: companyId,
      previousData: { ...before },
      newData: { ...saved },
    });

    return NextResponse.json({ rule: saved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
