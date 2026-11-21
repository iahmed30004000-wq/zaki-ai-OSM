import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { requirePermission } from '@/lib/authorization';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { nextWorkStart } from '@/lib/confirmation-rule-settings';
import { overlapRefusal } from '@/lib/confirmation-rules';
import { activeRowsFresh, candidateFromBody, previewAtTheDoor } from '@/lib/confirmation-own-rules';

/**
 * POST /api/confirmation/rules/preview — «مين بتمسك ومين لا، وليش» BEFORE a rule is saved (request Q4c, 21/11).
 *
 * The same body as a save (`POST /api/confirmation/rules`), read and checked the same way, and answered with the preview the save would compute — the desk's people
 * built from their effective grants (`resolveAudience` → `computeEffectiveGrants` → `can` → `deskReadiness`), never a role template — plus, when another active
 * rule would refuse the save, its sentence (`overlap`). Writes nothing.
 *
 * WHO ASKS: `settings.view` AND `users.view` — the keys of «مين مربوطة», whose people it names.
 */

const READS_PER_WINDOW = 30;
const WINDOW_MS = 60_000;
const TOO_MANY = 'طلبات كتير ورا بعض — استنّى دقيقة وجرّب';

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settings.view');
    await requirePermission('users.view');
    const limit = rateLimit(`own-rules-preview:${user.id}`, READS_PER_WINDOW, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json({ error: TOO_MANY, errorAr: TOO_MANY, code: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } });
    }
    if (!storeId) return NextResponse.json({ error: 'اختار متجر من فوق أول.', errorAr: 'اختار متجر من فوق أول.', code: 'STORE_REQUIRED' }, { status: 400 });

    const body = await req.json().catch(() => null);
    const now = Date.now();
    const candidate = candidateFromBody(body, { companyId, userId: user.id, nowMs: now, nextWorkStart: nextWorkStart(new Date(now), country) });
    if (!candidate.ok) {
      return NextResponse.json({ error: candidate.errorAr, errorAr: candidate.errorAr, code: candidate.code, field: candidate.field }, { status: 400 });
    }
    const others = await activeRowsFresh(db, companyId);
    const overlap = overlapRefusal(candidate.rule, others);
    const preview = await previewAtTheDoor(db, { companyId, storeId, country, rule: candidate.rule, nowMs: now, others });
    return NextResponse.json({
      preview,
      overlap: overlap ? { errorAr: overlap.errorAr, otherRuleId: overlap.otherRuleId } : null,
      effectiveFrom: candidate.rule.effectiveFrom.toISOString(),
      effectiveTo: candidate.rule.effectiveTo?.toISOString() ?? null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
