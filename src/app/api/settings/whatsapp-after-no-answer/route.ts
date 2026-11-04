import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { ruleFor } from '@/lib/phone-rules';
import { effectiveStatus, getActiveConnection } from '@/lib/whatsapp/connection';
import {
  afterNoAnswer,
  forgetAfterNoAnswer,
  saveAfterNoAnswer,
  validateAfterNoAnswer,
} from '@/lib/whatsapp/after-no-answer';

/**
 * GET/PUT /api/settings/whatsapp-after-no-answer — «واتساب بعد لا يرد»: from the agent's WhatsApp or from the company's
 * number, per country (`after-no-answer.ts`).
 *
 * Read by whoever opens the WhatsApp settings (`whatsapp.manage`) or the system settings (`settings.view`). Written with
 * `settings.manage`, the owner's box for the company's keys, as «نظام الجولات» is: COMPANY sends from the company's number
 * in the company's name, and that is not a supervisor's choice.
 *
 * The answer carries the company's countries (by calling code, from its own Country rows) so the card draws one row per
 * country it actually works in, and whether the number is connected — until it is, every message goes from the agent's
 * WhatsApp whatever is saved here, and the card says so.
 */
async function countries(companyId: string): Promise<Array<{ dialCode: string; name: string }>> {
  const rows = await db.country.findMany({ where: { companyId }, select: { code: true, name: true }, orderBy: { name: 'asc' } });
  const seen = new Set<string>();
  const out: Array<{ dialCode: string; name: string }> = [];
  for (const r of rows) {
    const dialCode = ruleFor(r.code)?.dialCode;
    if (!dialCode || seen.has(dialCode)) continue;
    seen.add(dialCode);
    out.push({ dialCode, name: r.name });
  }
  return out;
}

export async function GET() {
  try {
    const { user, companyId } = await requireContext();
    if (!can(user, 'whatsapp.manage') && !can(user, 'settings.view')) {
      await requirePermission('whatsapp.manage');
    }
    forgetAfterNoAnswer(companyId);
    const [setting, list, conn] = await Promise.all([afterNoAnswer(db, companyId), countries(companyId), getActiveConnection(companyId)]);
    return NextResponse.json({ setting, countries: list, connected: effectiveStatus(conn) === 'CONNECTED' });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.manage');

    const body = await req.json().catch(() => null);
    const checked = validateAfterNoAnswer(body);
    if (!checked.ok) {
      return NextResponse.json({ error: checked.errorAr, errorAr: checked.errorAr, code: 'INVALID_SETTING' }, { status: 400 });
    }

    forgetAfterNoAnswer(companyId);
    const before = await afterNoAnswer(db, companyId);
    const saved = await saveAfterNoAnswer(companyId, checked.value);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'WHATSAPP_AFTER_NO_ANSWER_SAVED',
      entity: 'Company',
      entityId: companyId,
      previousData: before,
      newData: saved,
    });

    return NextResponse.json({ setting: saved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
