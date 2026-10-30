import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { manageableUserWhere, mayActOnUser } from '@/lib/manageable-user';
import { mayIssueEnrolCode } from '@/lib/two-factor-reset';
import { canActOnUser } from '@/lib/user-permissions';
import { ENROL_CODE_TTL_MS, newEnrolCode, sealEnrolCode } from '@/lib/enrol-code';

/**
 * POST /api/users/:id/enrol-code — the owner issues the code for somebody's first setup of the second factor (A2).
 *
 * «أصدر رمز تفعيل». The code is returned ONCE, in this answer, and is kept only as a hash: the owner reads it out or
 * sends it, and a copy of the table holds nothing that works. It is good for one setup and one day. Issuing a new one
 * replaces the old, so a code that was sent to the wrong person is cancelled by issuing another.
 *
 * Whether the setup ASKS for it is a switch (`AUTH_ENROL_CODE_REQUIRED`, off by default). Issuing while it is off is
 * harmless, and lets the owner hand out every code before he turns the switch on.
 *
 * WHO: the holders of `users.security`, never for yourself, and with the same reach limits as resetting a factor —
 * somebody inside the company's reach, never the account above you.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireContext();

    const verdict = mayIssueEnrolCode(user, id);
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status });
    }

    const target = await db.user.findFirst({
      where: manageableUserWhere(user, id),
      select: { id: true, name: true, email: true, role: true, roleId: true, companyId: true, totpEnabledAt: true, status: true },
    });
    if (!target) return NextResponse.json({ error: 'الموظف غير موجود' }, { status: 404 });
    if (!mayActOnUser(user, target)) {
      return NextResponse.json({ error: 'الموظف غير موجود' }, { status: 404 });
    }
    if (target.role === 'SUPER_ADMIN' && user.role !== 'SUPER_ADMIN') {
      return NextResponse.json(
        { error: 'فقط المدير الأعلى يمكنه إدارة حسابات المدراء الأعلى', code: 'SUPER_ADMIN_ONLY' },
        { status: 403 }
      );
    }
    const acting = await canActOnUser(user, target);
    if (!acting.ok) return NextResponse.json({ error: acting.error, code: 'BEYOND_REACH' }, { status: acting.status });

    if (target.totpEnabledAt) {
      return NextResponse.json(
        { error: 'التحقّق بخطوتين مفعّل على هذا الحساب أصلاً — لا حاجة لرمز', code: 'ALREADY_ENROLLED' },
        { status: 409 }
      );
    }
    if (target.status !== 'ACTIVE') {
      return NextResponse.json({ error: 'الحساب غير مفعّل — فعّله أولاً', code: 'NOT_ACTIVE' }, { status: 409 });
    }

    const code = newEnrolCode();
    const sealed = await sealEnrolCode(code);
    await db.user.update({ where: { id: target.id }, data: sealed });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'ENROL_CODE_ISSUED',
      entity: 'User',
      entityId: target.id,
      // Never the code. Who it was issued for, by whom, and until when.
      newData: { employee: target.name, role: target.role, by: user.name ?? user.id, expiresAt: sealed.enrolCodeExpiresAt.toISOString() },
    });

    return NextResponse.json({
      ok: true,
      employee: target.name,
      code,
      expiresAt: sealed.enrolCodeExpiresAt.toISOString(),
      hours: ENROL_CODE_TTL_MS / 3_600_000,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
