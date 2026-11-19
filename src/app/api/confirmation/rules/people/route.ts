import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { can, hasFullAccess, requirePermission } from '@/lib/authorization';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { resolveAudience } from '@/lib/notification-audience';
import { DESK_KEYS, deskReadiness, labelledReadiness } from '@/lib/desk-readiness';
import { ROLE_LABELS, type UserRole } from '@/types/auth';

/**
 * GET /api/confirmation/rules/people — «مين مربوطة بالقواعد»: every person at the confirmation desk of THIS store, and for each
 * whether «اسحبي الطلب أول» binds her, which key frees her when it does not, and which of the desk's tools she lacks.
 *
 * WHO ASKS: `settings.view` AND `users.view` — the rules page, and the people's keys (which «الموظفين» shows behind `users.view`).
 *
 * WHO IS LISTED: an ACTIVE person of the viewer's company who reaches this store and holds any of `DESK_KEYS` — the same
 * question the notification fan-out and the transfer list ask (`resolveAudience`): role rows by roleId or the template of her
 * legacy role, her personal ALLOW / DENY, then the real `can()`. Never a role template alone — a personal «منع» is her truth.
 *
 * WHAT IS ANSWERED: id, name, role, the readiness (`desk-readiness.ts`) with each key's Arabic name. No order, no customer.
 * Reading only.
 */

const PEOPLE_READS_PER_WINDOW = 30;
const PEOPLE_READ_WINDOW_MS = 60_000;
const TOO_MANY = 'طلبات كتير ورا بعض — استنّى دقيقة وجرّب';

export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('settings.view');
    await requirePermission('users.view');

    const limit = rateLimit(`desk-people:${user.id}`, PEOPLE_READS_PER_WINDOW, PEOPLE_READ_WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: TOO_MANY, errorAr: TOO_MANY, code: 'RATE_LIMITED' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
      );
    }

    const people = await resolveAudience({ companyId, storeId, audience: { anyPermission: DESK_KEYS } });
    if (people.length === 0) return NextResponse.json({ people: [] });

    const roles = await db.user.findMany({
      where: { id: { in: people.map((p) => p.id) }, companyId },
      select: { id: true, role: true, roleRef: { select: { name: true } } },
    });
    const roleOf = new Map(roles.map((r) => [r.id, r.roleRef?.name ?? ROLE_LABELS[r.role as UserRole]?.ar ?? r.role]));

    return NextResponse.json({
      people: people
        .map((p) => ({
          id: p.id,
          name: p.name,
          roleLabel: roleOf.get(p.id) ?? ROLE_LABELS[p.role as UserRole]?.ar ?? p.role,
          readiness: labelledReadiness(deskReadiness((k) => can(p, k), { fullAccess: hasFullAccess(p) })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ar')),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
