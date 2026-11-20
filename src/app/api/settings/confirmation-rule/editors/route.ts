import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { can, requirePermission } from '@/lib/authorization';
import { rateLimit } from '@/lib/rate-limit';
import { resolveAudience } from '@/lib/notification-audience';
import { catalogItem } from '@/lib/permission-catalog';
import { readConfirmationRuleDocument } from '@/lib/confirmation-rule-settings';

/**
 * GET /api/settings/confirmation-rule/editors — WHO MAY EDIT «أرقام القاعدة», and the names behind the versions (request Q3c, 20/11).
 *
 * The numbers editor on the rules page shows who may change the rule and who saved each version. Both are answered here, by the
 * server, the way the «مين مربوطة» door (Q1a) answers its people: every ACTIVE person of the company is built from her effective
 * grants (`resolveAudience` → `computeEffectiveGrants` → the real `can()`) and kept when she holds `settings.manage` — the key the
 * rule's own door asks for a save (the owner's decision R4: no new key). Never a role template alone.
 *
 * WHO ASKS: `settings.view` (the rules page). The key's Arabic name is answered to everybody who may open the page — the read-only
 * card says which key it lacks. The NAMES need `users.view` as well, the key «الموظفين» shows people behind; without it `editors` and
 * `names` are null and the card says only the key.
 *
 * WHAT IS ANSWERED: `{ keyLabel, editors: [{ id, name }] | null, names: { [userId]: name } | null }` — `names` covers every author the
 * stored document mentions (the pending change and each kept version), in this company, whatever their status today. Reading only.
 */

const EDIT_KEY = 'settings.manage';
const READS_PER_WINDOW = 30;
const READ_WINDOW_MS = 60_000;
const TOO_MANY = 'طلبات كتير ورا بعض — استنّى دقيقة وجرّب';

export async function GET() {
  try {
    const { user, companyId } = await requireContext();
    const viewer = await requirePermission('settings.view');
    const keyLabel = catalogItem(EDIT_KEY)?.ar ?? EDIT_KEY;
    if (!can(viewer, 'users.view')) return NextResponse.json({ keyLabel, editors: null, names: null });

    const limit = rateLimit(`rule-editors:${user.id}`, READS_PER_WINDOW, READ_WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: TOO_MANY, errorAr: TOO_MANY, code: 'RATE_LIMITED' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
      );
    }

    const holders = await resolveAudience({ companyId, storeId: null, audience: { permission: EDIT_KEY } });
    const editors = holders.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    const doc = await readConfirmationRuleDocument(db, companyId);
    const authorIds = [...new Set([doc?.byUserId, ...(doc?.previous ?? []).map((p) => p.byUserId)].filter((id): id is string => !!id))];
    const authors = authorIds.length
      ? await db.user.findMany({ where: { id: { in: authorIds }, companyId }, select: { id: true, name: true } })
      : [];

    return NextResponse.json({ keyLabel, editors, names: Object.fromEntries(authors.map((a) => [a.id, a.name])) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
