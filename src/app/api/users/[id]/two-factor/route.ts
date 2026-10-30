import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { wipePasskeys } from '@/lib/passkey-guard';
import { manageableUserWhere, mayActOnUser } from '@/lib/manageable-user';
import { mayResetTwoFactor } from '@/lib/two-factor-reset';
import { canActOnUser } from '@/lib/user-permissions';

/**
 * DELETE /api/users/:id/two-factor — the owner unlocks a locked-out employee.
 *
 * «زر لـ reset الـ 2FA للموظفين، بس للمالك حصراً».
 *
 * A phone is lost, or replaced, or wiped. The employee still knows their
 * password and still works here, and the authenticator that proves it is
 * gone. Without this the only cure was a developer with a database client,
 * which is not a cure — it is an outage with a person's name on it.
 *
 * WHAT IT DOES NOT DO is let anybody in. It clears the enrolment, so the
 * NEXT login walks that person through enrolling again on their new phone,
 * with a fresh secret and fresh recovery codes. A reset account is not an
 * account without a second factor; it is an account that has to set one up.
 *
 * WHO. The holders of `users.security` — the owner and the company admin, and
 * nobody else unless the owner ticks it for them (D6, PR-13). Not «anyone who
 * can edit users»: stripping a second factor is the one administrative act
 * that weakens somebody else's account, so it has a box of its own, and the
 * SUPER_ADMIN holds it centrally — whatever is unticked from the rest, an
 * account that lost its phone can always be recovered by the owner.
 *
 * AND NEVER YOUR OWN. An owner resetting themselves proves nothing — the
 * session doing it is already authenticated — but it is exactly the move a
 * stolen session makes to shed the factor it could not pass. Re-enrolling
 * yourself is done from your own security screen, with the current code.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireContext();

    const verdict = mayResetTwoFactor(user, id);
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status });
    }

    /**
     * WHOSE PERSON THIS IS — from the one helper, not written again here.
     *
     * `manageableUserWhere` owns that question for every route under
     * /api/users. Its own comment records why: the reasoning was written
     * by hand four times and one of the four was wrong, in a way that told
     * an owner «المستخدم غير موجود» about themselves. A repo guard refuses
     * a hand-written `{ id, companyId }` here, and it caught this route.
     */
    const target = await db.user.findFirst({
      where: manageableUserWhere(user, id),
      select: { id: true, name: true, email: true, role: true, roleId: true, companyId: true, totpEnabledAt: true },
    });
    if (!target) return NextResponse.json({ error: 'الموظف غير موجود' }, { status: 404 });

    /**
     * ── SEEING IS NOT ACTING, AND NOBODY RESETS THE ACCOUNT ABOVE THEM ──
     *
     * `manageableUserWhere` answers «is this row in front of this person»,
     * and it says yes to an unplaced account (`companyId: null`) on
     * purpose, because seeing one is how a new signup gets adopted. It is
     * NOT a licence to act on one, and `mayActOnUser` is the line between
     * the two — the same line the password door draws two files away.
     *
     * The role guard under it is the one that matters here. Until it was
     * written, a COMPANY_ADMIN could send this request with the owner's id
     * in it: the owner is either in their company or unplaced, so the
     * where-clause matched either way, and `mayResetTwoFactor` admits
     * COMPANY_ADMIN by design. The press stripped the platform owner's
     * second factor, deleted their recovery codes — and, since this PR
     * added the `tokenVersion` bump below, now signs them out of every
     * device at the same instant. The account that can do everything,
     * locked out and re-enrolling, at the press of somebody junior to it,
     * repeatable at will.
     *
     * Written here rather than hoisted into a helper because that is where
     * this system keeps it: `manageable-user.ts` says in its own comment
     * that «the privilege guards around SUPER_ADMIN targets still live
     * where the action is». There are two such actions on an account's
     * login — setting its password and stripping its second factor — and
     * they now read the same two lines.
     */
    if (!mayActOnUser(user, target)) {
      return NextResponse.json({ error: 'الموظف غير موجود' }, { status: 404 });
    }
    if (target.role === 'SUPER_ADMIN' && user.role !== 'SUPER_ADMIN') {
      return NextResponse.json(
        { error: 'فقط المدير الأعلى يمكنه إدارة حسابات المدراء الأعلى', code: 'SUPER_ADMIN_ONLY' },
        { status: 403 }
      );
    }
    // Stripping a second factor is acting on the account: not on one that
    // holds powers this person lacks (canActOnUser), as for every other action.
    const acting = await canActOnUser(user, target);
    if (!acting.ok) return NextResponse.json({ error: acting.error, code: 'BEYOND_REACH' }, { status: acting.status });

    if (!target.totpEnabledAt) {
      return NextResponse.json(
        { error: 'لا تحقّق بخطوتين مفعّلاً على هذا الحساب — لا شيء ليُعاد ضبطه', code: 'NOT_ENROLLED' },
        { status: 409 }
      );
    }

    /**
     * The enrolment and its recovery codes go together, in one transaction.
     *
     * Clearing the secret while leaving the recovery codes alive would
     * leave the old phone's escape hatch working for an account whose
     * owner has just been told it was reset.
     */
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: {
          totpSecretEnc: null,
          totpEnabledAt: null,
          totpLastStep: null,
          /*
           * ── AND HIS OPEN SESSIONS END ──
           *
           * A reset happens because the phone was lost, replaced, or
           * because somebody is suspected of having the account. Clearing
           * the secret alone left every browser he was already signed in
           * on working exactly as before — so whoever the reset was meant
           * to lock out stayed inside until their session expired.
           *
           * Bumping `tokenVersion` is how this system ends sessions
           * everywhere; `forceLogout` does the same thing. He signs in
           * again and `stepFor` sends him to enrol, which is the whole
           * point of having reset it.
           */
          tokenVersion: { increment: 1 },
        },
      });
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId: target.id } });
      // A fingerprint stands in for the six digits; with the factor reset it would be the only thing left that skips
      // them, and the phone that was lost may be the one holding it (A1).
      await wipePasskeys(tx, target.id);
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'TWO_FACTOR_RESET',
      entity: 'User',
      entityId: target.id,
      previousData: { totpEnabledAt: target.totpEnabledAt },
      // The person, the role and who did it — never the secret, which is
      // gone, and was encrypted while it existed.
      newData: { employee: target.name, role: target.role, by: user.name ?? user.id },
    });

    return NextResponse.json({
      ok: true,
      employee: target.name,
      message: `أُعيد ضبط التحقّق بخطوتين لـ${target.name} — أُغلقت جلساته، وسيُطلب منه تسجيله من جديد عند الدخول القادم.`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
