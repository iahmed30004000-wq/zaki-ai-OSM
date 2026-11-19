import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import {
  CONFIRMATION_RULE_DEFAULT,
  CONFIRMATION_RULE_RANGES,
  changeConfirmationRuleDocument,
  documentAfterCancel,
  documentAfterSave,
  nextWorkStart,
  readConfirmationRule,
  readConfirmationRuleDocument,
  ruleAt,
  ruleAttempts,
  validateConfirmationRule,
  type ConfirmationRuleDocument,
  type ConfirmationRuleNumbers,
} from '@/lib/confirmation-rule-settings';

/**
 * GET/PUT/POST /api/settings/confirmation-rule — «أرقام القاعدة»: the owner's edit of the confirmation rule's numbers (request Q3a; INERT — no engine file reads
 * the stored rule yet, the next request wires it). Seen with `settings.view`; changed with `settings.manage` (the owner's decision R4: no new key).
 *
 *  · GET  → the rule in force, the pending change with its moment, the last ten versions, the default, the ranges, and when «بداية الدوام الجاي» is for this store.
 *  · PUT  { rule, when: 'NOW' | 'NEXT_WORK_START' } → validated WHOLE (an Arabic sentence and the field on a refusal, nothing stored); the moment is the SERVER's —
 *         now, or the next start of work of the current store's Country (the default when `when` is absent: the owner's decision R5). A save while a change is
 *         pending replaces the pending one only.
 *  · POST { action: 'revert', version?, when? } → with nothing pending and no version: back to the newest previous version; with a version: back to that one
 *         (0 = newest); with a change pending and no version: the pending change is cancelled. A revert acts NOW unless `when` says otherwise — it is the way back.
 * One audit row per change, with the before and the after.
 */

type Body = Record<string, unknown> | null;
const WHEN = ['NOW', 'NEXT_WORK_START'] as const;
type When = (typeof WHEN)[number];

function refuse(status: number, code: string, errorAr: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: errorAr, errorAr, code, ...extra }, { status });
}

function answer(doc: ConfirmationRuleDocument | null, inForce: ConfirmationRuleNumbers, nowMs: number, nextStart: Date) {
  const { pending } = ruleAt(doc, nowMs);
  return {
    confirmationRule: {
      rule: { ...inForce, attempts: ruleAttempts(inForce) },
      pending: pending ? { ...pending, rule: { ...pending.rule, attempts: ruleAttempts(pending.rule) } } : null,
      previous: (doc?.previous ?? []).map((p, version) => ({ version, ...p, rule: { ...p.rule, attempts: ruleAttempts(p.rule) } })),
      savedAt: doc?.savedAt ?? null,
      byUserId: doc?.byUserId ?? null,
      defaults: { ...CONFIRMATION_RULE_DEFAULT, attempts: ruleAttempts(CONFIRMATION_RULE_DEFAULT) },
      ranges: CONFIRMATION_RULE_RANGES,
      nextWorkStart: nextStart.toISOString(),
    },
  };
}

function whenOf(raw: unknown, fallback: When): When | null {
  if (raw === undefined) return fallback;
  return (WHEN as readonly unknown[]).includes(raw) ? (raw as When) : null;
}

const WHEN_AR = 'وقت السريان لازم يكون «هلق» أو «من بداية الدوام الجاي».';

export async function GET() {
  try {
    const { companyId, country } = await requireContext();
    await requirePermission('settings.view');
    const now = Date.now();
    const doc = await readConfirmationRuleDocument(db, companyId, now);
    const inForce = await readConfirmationRule(db, companyId, now);
    return NextResponse.json(answer(doc, inForce, now, nextWorkStart(new Date(now), country)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId, country } = await requireContext();
    await requirePermission('settings.manage');

    const body = (await req.json().catch(() => null)) as Body;
    const checked = validateConfirmationRule(body && typeof body === 'object' ? body.rule : undefined);
    if (!checked.ok) return refuse(400, 'INVALID_CONFIRMATION_RULE', checked.error, { field: checked.field });
    const when = whenOf(body?.when, 'NEXT_WORK_START');
    if (!when) return refuse(400, 'INVALID_WHEN', WHEN_AR, { field: 'when' });

    const now = Date.now();
    const effectiveAt = when === 'NOW' ? new Date(now) : nextWorkStart(new Date(now), country);
    let before: ReturnType<typeof ruleAt> | null = null;
    const { doc } = await changeConfirmationRuleDocument(companyId, (stored) => {
      before = ruleAt(stored, now);
      return documentAfterSave(stored, { rule: checked.rule, effectiveAt, byUserId: user.id }, now);
    });

    await logAudit({
      companyId, userId: user.id, action: 'CONFIRMATION_RULE_CHANGED', entity: 'Company', entityId: companyId,
      previousData: before, newData: { rule: checked.rule, when, effectiveAt: effectiveAt.toISOString() },
    });
    return NextResponse.json(answer(doc, ruleAt(doc, now).rule, now, nextWorkStart(new Date(now), country)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, country } = await requireContext();
    await requirePermission('settings.manage');

    const body = (await req.json().catch(() => null)) as Body;
    if (!body || body.action !== 'revert') return refuse(400, 'UNKNOWN_ACTION', 'الطلب لازم يكون «رجّع» بس.');
    const version = body.version;
    if (version !== undefined && !(typeof version === 'number' && Number.isInteger(version) && version >= 0)) {
      return refuse(400, 'INVALID_VERSION', 'رقم النسخة لازم يكون رقم صحيح من القائمة.', { field: 'version' });
    }
    const when = whenOf(body.when, 'NOW');
    if (!when) return refuse(400, 'INVALID_WHEN', WHEN_AR, { field: 'when' });

    const now = Date.now();
    const effectiveAt = when === 'NOW' ? new Date(now) : nextWorkStart(new Date(now), country);
    let before: ReturnType<typeof ruleAt> | null = null;
    let did: 'CANCELLED' | 'REVERTED' | null = null;
    let missing = false;
    const { written, doc } = await changeConfirmationRuleDocument(companyId, (stored) => {
      before = ruleAt(stored, now);
      did = null;
      missing = false;
      if (version === undefined && before.pending) {
        did = 'CANCELLED';
        return documentAfterCancel(stored, now);
      }
      const target = stored?.previous[version ?? 0];
      if (!target) {
        missing = true;
        return null;
      }
      did = 'REVERTED';
      return documentAfterSave(stored, { rule: target.rule, effectiveAt, byUserId: user.id }, now);
    });
    if (!written || missing) return refuse(409, 'NO_SUCH_VERSION', 'ما في نسخة قبل هاي ترجعلها.');

    await logAudit({
      companyId, userId: user.id, action: 'CONFIRMATION_RULE_REVERTED', entity: 'Company', entityId: companyId,
      previousData: before, newData: { did, version: version ?? 0, ...ruleAt(doc, now), effectiveAt: doc?.effectiveAt ?? null },
    });
    return NextResponse.json(answer(doc, ruleAt(doc, now).rule, now, nextWorkStart(new Date(now), country)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
