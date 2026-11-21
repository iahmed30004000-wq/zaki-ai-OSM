import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { nextWorkStart } from '@/lib/confirmation-rule-settings';
import { overlapRefusal, validateConfirmationRuleRow, type ConfirmationRuleRow } from '@/lib/confirmation-rules';
import { forgetConfirmationRules } from '@/lib/employee-numbers';
import { activeRowsFresh, endAfter, startOf } from '@/lib/confirmation-own-rules';

/**
 * PATCH /api/confirmation/rules/[id] — STOP, RENAME, OR CHANGE THE DATES of one of the owner's rules (request Q4c, 21/11). `settings.manage` (decision R4).
 *
 *   { action: 'stop' }                                  → `isActive: false`. The row stays — there is no delete, and nothing here deletes.
 *   { action: 'rename', name }                          → the new name, checked by the table's validator.
 *   { action: 'dates', days, start? }                   → the end becomes `days` after the start (empty = until stopped); `start` («هلق» / «من بداية الدوام
 *                                                         الجاي») only while the rule has not begun. Checked again against the other active rules.
 * A stopped rule changes no more (a new one is written instead). One audit row per change, with the before and the after; the rules cache of this process is
 * forgotten at once.
 */

const ACTIONS = ['stop', 'rename', 'dates'] as const;
const AUDIT: Record<(typeof ACTIONS)[number], string> = {
  stop: 'CONFIRMATION_OWN_RULE_STOPPED',
  rename: 'CONFIRMATION_OWN_RULE_RENAMED',
  dates: 'CONFIRMATION_OWN_RULE_DATES_CHANGED',
};

function refuse(status: number, code: string, errorAr: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: errorAr, errorAr, code, ...extra }, { status });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, companyId, country } = await requireContext();
    await requirePermission('settings.manage');
    const { id } = await params;

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const action = body?.action;
    if (!(ACTIONS as readonly unknown[]).includes(action)) return refuse(400, 'UNKNOWN_ACTION', 'الطلب لازم يكون «وقّف» أو «غيّر الاسم» أو «غيّر المدة».', { field: 'action' });

    const stored = await db.confirmationRule.findFirst({
      where: { id, companyId },
      select: {
        id: true, companyId: true, storeId: true, name: true, kind: true, userIds: true, productId: true, channelKind: true, phase: true,
        hoursFrom: true, hoursTo: true, effectiveFrom: true, effectiveTo: true, isActive: true, payload: true, createdAt: true,
      },
    });
    if (!stored) return refuse(404, 'RULE_NOT_FOUND', 'ما لقينا هالقاعدة.');
    const row = stored as ConfirmationRuleRow;
    if (!row.isActive) return refuse(409, 'RULE_STOPPED', 'هالقاعدة موقوفة — ما بتتعدّل. اكتب قاعدة جديدة بدالها.');

    const now = Date.now();
    let next: ConfirmationRuleRow;
    if (action === 'stop') {
      next = { ...row, isActive: false };
    } else if (action === 'rename') {
      next = { ...row, name: typeof body?.name === 'string' ? body.name : '' };
    } else {
      let from = row.effectiveFrom;
      if (body?.start !== undefined) {
        if (row.effectiveFrom.getTime() <= now) return refuse(409, 'RULE_STARTED', 'القاعدة بلّشت — بدايتها ما بتتغيّر، بس مدتها.', { field: 'start' });
        const start = startOf(body.start, now, nextWorkStart(new Date(now), country));
        if (!start.ok) return refuse(400, start.code, start.errorAr, { field: start.field });
        from = start.from;
      }
      const end = endAfter(from, body?.days);
      if (!end.ok) return refuse(400, end.code, end.errorAr, { field: end.field });
      if (end.to && end.to.getTime() <= now) return refuse(400, 'RULE_DATES', 'هالمدة بتخلص قبل هلق — إذا بدك توقّفها استعمل «وقّفها».', { field: 'days' });
      next = { ...row, effectiveFrom: from, effectiveTo: end.to };
    }

    if (action !== 'stop') {
      const checked = validateConfirmationRuleRow(next);
      if (!checked.ok) return refuse(400, checked.code, checked.errorAr, { field: checked.field });
      next = { ...next, name: checked.rule.name };
      if (action === 'dates') {
        const overlap = overlapRefusal(checked.rule, await activeRowsFresh(db, companyId));
        if (overlap) return refuse(409, overlap.code, overlap.errorAr, { field: 'days', otherRuleId: overlap.otherRuleId });
      }
    }

    // Written only while it is still active: a stop that raced another stop changes nothing twice.
    const written = await db.confirmationRule.updateMany({
      where: { id, companyId, isActive: true },
      data: { isActive: next.isActive, name: next.name, effectiveFrom: next.effectiveFrom, effectiveTo: next.effectiveTo },
    });
    if (written.count === 0) return refuse(409, 'RULE_STOPPED', 'هالقاعدة انوقفت هلق من حدا تاني.');
    forgetConfirmationRules(companyId);

    const pick = (r: ConfirmationRuleRow) => ({ name: r.name, isActive: r.isActive, effectiveFrom: r.effectiveFrom.toISOString(), effectiveTo: r.effectiveTo?.toISOString() ?? null });
    await logAudit({ companyId, userId: user.id, action: AUDIT[action as (typeof ACTIONS)[number]], entity: 'ConfirmationRule', entityId: id, previousData: pick(row), newData: pick(next) });
    return NextResponse.json({ id, ...pick(next) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
