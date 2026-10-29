import { toLatinDigits } from '@/lib/latin-digits';
import { mayActOnUser, USER_NOT_FOUND } from '@/lib/manageable-user';
import { NextResponse } from 'next/server';
import { apiErrorResponse, forbiddenAr } from '@/lib/api-error';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { hashPassword, resolveSingleCompanyId } from '@/lib/auth';
import { maySetPassword, generatePassword } from '@/lib/two-factor-reset';
import { passwordMessage } from '@/lib/password-rules';
import { ASSIGNABLE_ROLES, UserRole, UserStatus } from '@/types/auth';
import { logAudit } from '@/lib/audit';
import { can, requirePermission } from '@/lib/authorization';
import { isPrivilegedRoleName } from '@/lib/role-names';
import { canActOnUser, canConferRole } from '@/lib/user-permissions';
import { parseHhMm, parseRestDays } from '@/lib/employee-shift';
import { money } from '@/lib/numeric-input';

/**
 * PATCH /api/users/:id — admin actions on a user account:
 * assignRole, changeStatus, forceLogout, resetPassword, delete
 * All actions are recorded in Audit Logs. Passwords are never logged.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const admin = await requirePermission('users.edit');
    const body = await req.json();
    const { action, role, status, roleId } = body;

    const target = await db.user.findUnique({
      where: { id },
      include: { assignedBy: { select: { name: true } } },
      // `totpEnabledAt` comes through with the rest of the scalars; the
      // SECRET never leaves the database and is encrypted where it sits.

    });
    if (!target) {
      return NextResponse.json({ error: USER_NOT_FOUND }, { status: 404 });
    }

    /**
     * MAY THIS ADMIN ACT ON THIS USER.
     *
     * Fifteen lines of tenancy reasoning used to live here, and three
     * sibling routes each had their own version of it — one of which was
     * wrong in a way that told the owner «المستخدم غير موجود» about
     * themselves. The rule is the same rule in all four places, so it is
     * written in one: see manageable-user.ts.
     *
     * Seeing an unplaced account is how it gets adopted; acting on one is
     * a platform matter — and `assignRole` IS the adoption.
     */
    if (!mayActOnUser(admin, target, { adopting: action === 'assignRole' })) {
      return NextResponse.json({ error: USER_NOT_FOUND }, { status: 404 });
    }

    // ── Privilege-escalation guards ──
    // Only SUPER_ADMIN may manage SUPER_ADMIN accounts
    if (target.role === 'SUPER_ADMIN' && admin.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'فقط المدير الأعلى يمكنه إدارة حسابات المدراء الأعلى' }, { status: 403 });
    }
    // Only SUPER_ADMIN may assign the SUPER_ADMIN role to anyone
    if (action === 'assignRole' && role === 'SUPER_ADMIN' && admin.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'فقط المدير الأعلى يمكنه تعيين رتبة المدير الأعلى' }, { status: 403 });
    }
    // And not on an account that holds powers this admin lacks — suspending,
    // signing out, deleting, re-roling, re-activating or resetting it alike
    // (see canActOnUser). Re-roling is also checked against the NEW role below.
    //
    // Except the clerical record (`updateContact`: phone, shift, rest days):
    // that is not power over anybody, and holding it back stopped an admin
    // correcting a supervisor's phone the day the owner unticked one key on
    // the admin. The pay inside the same action keeps its own key, payroll.pay.
    if (action !== 'updateContact') {
      const acting = await canActOnUser(admin, target);
      if (!acting.ok) {
        return NextResponse.json({ error: acting.error }, { status: acting.status });
      }
    }

    const updateData: Record<string, unknown> = {};
    let auditAction = '';

    if (action === 'assignRole') {
      // roleId-based assignment (Permission Engine) takes precedence over the
      // legacy `role` string. The legacy path below is kept for compatibility.
      if (roleId) {
        if (typeof roleId !== 'string') {
          return NextResponse.json({ error: 'الدور غير صالح' }, { status: 400 });
        }
        const roleRow = await db.role.findUnique({ where: { id: roleId }, include: { _count: { select: { users: true } } } });
        if (!roleRow) {
          return NextResponse.json({ error: 'الدور غير موجود' }, { status: 400 });
        }
        // Tenant rule: system roles (companyId null) are assignable by anyone
        // with the permission; company roles only within the same company.
        const roleAllowed = roleRow.companyId === null || roleRow.companyId === admin.companyId;
        if (!roleAllowed) {
          return NextResponse.json({ error: 'الدور غير موجود' }, { status: 404 });
        }
        // Only SUPER_ADMIN may assign a privileged legacy role string (name-based,
      // normalization-safe: guards both system and shadow company roles)
      if (isPrivilegedRoleName(roleRow.name) && admin.role !== 'SUPER_ADMIN') {
        return NextResponse.json({ error: 'فقط المدير الأعلى يمكنه تعيين رتبة المدير الأعلى' }, { status: 403 });
      }
        if (target.id === admin.id && target.roleId !== roleId) {
          return NextResponse.json({ error: 'لا يمكنك تغيير دورك الشخصي' }, { status: 400 });
        }
        // Conferral policy: assigning a role confers its FULL canonical matrix
        // onto the target — the granter must be able to grant every key/scope
        // the role carries (granter-must-hold), not just hold users.edit.
        const conferral = await canConferRole(admin, { id: roleRow.id, name: roleRow.name });
        if (!conferral.ok) {
          return NextResponse.json({ error: conferral.error }, { status: conferral.status });
        }
        updateData.roleId = roleId;
        updateData.role = roleRow.name; // keep legacy role string in sync
        updateData.permissionsVersion = { increment: 1 }; // invalidate cached grants
        auditAction = 'USER_ROLE_CHANGED';
      } else if (!role || !ASSIGNABLE_ROLES.includes(role as UserRole)) {
        return NextResponse.json({ error: 'الدور غير صالح' }, { status: 400 });
      } else {
        if (target.id === admin.id && role !== admin.role) {
          return NextResponse.json({ error: 'لا يمكنك تغيير دورك الشخصي' }, { status: 400 });
        }
        // Grants resolve by roleId when one is set, so changing only the
        // string left the badge saying one role and the permissions being
        // another's. Point roleId at the role of that name — the company's
        // own first, then the system one — or clear it so the string rules.
        const named = await db.role.findFirst({
          where: {
            name: role as string,
            // Never another company's role: without a company, the system one only.
            OR: admin.companyId ? [{ companyId: admin.companyId }, { companyId: null }] : [{ companyId: null }],
          },
          orderBy: { companyId: 'asc' },
          select: { id: true },
        });
        // Conferral policy, checked against what is really granted: the role
        // row the user will point at — a company may have widened its own
        // role of this name — or, without one, the legacy matrix (fail-closed
        // for unknown names; PENDING_USER confers nothing).
        const conferral = await canConferRole(admin, { id: named?.id ?? null, name: role as string });
        if (!conferral.ok) {
          return NextResponse.json({ error: conferral.error }, { status: conferral.status });
        }
        updateData.role = role;
        updateData.roleId = named?.id ?? null;
        updateData.permissionsVersion = { increment: 1 };
      }
      /**
       * HIRING SOMEBODY PUTS THEM IN THE COMPANY — WHOEVER DOES THE HIRING.
       *
       * ONE block, after both branches, reading the name that was actually
       * assigned. A first version of this fix put a second copy inside the
       * `roleId` branch, and the two disagreed immediately: the outer one
       * tested the legacy `role` string, which is `undefined` on the roleId
       * path, so assigning the SUPER_ADMIN role through it adopted a platform
       * administrator into a company. A test caught it. Two copies of a rule
       * about who joins what is exactly the kind of duplication that produces
       * a hole rather than a conflict.
       *
       * WHAT WAS WRONG BEFORE ANY OF THAT. The condition read
       * `admin.companyId && admin.role !== 'SUPER_ADMIN'` — and the person who
       * actually approves new staff is the owner, a PLATFORM SUPER_ADMIN with
       * no company of their own. Both halves were false for them, so an
       * employee got a role, an ACTIVE account and a working login, and kept
       * `companyId: null` for ever. Every screen looks a person up with
       * `{ id, companyId }`, so that employee was invisible to all of them at
       * once: «الموظف غير موجود» on their page, «المستخدم غير موجود» on their
       * access, a commission rule for them refused. Only the users list
       * showed them, because it alone also reads `companyId: null`.
       *
       * The company is resolved exactly as `POST /api/users` already resolves
       * it for the same actor — the existing idea, applied to the door it was
       * missing from.
       *
       * A platform administrator is never adopted: they have no company on
       * purpose. And a company admin still may not take over an ACTIVE
       * account from elsewhere — adoption is onboarding, not capture.
       */
      const assignedName = (updateData.role as string | undefined) ?? role;
      if (!target.companyId && !isPrivilegedRoleName(assignedName)) {
        if (target.status !== 'PENDING' && admin.role !== 'SUPER_ADMIN') {
          return NextResponse.json({ error: 'غير مسموح بإسناد حساب من شركة أخرى' }, { status: 403 });
        }
        updateData.companyId = admin.companyId ?? (await resolveSingleCompanyId());
      }
      auditAction = 'USER_ROLE_CHANGED';
    } else if (action === 'changeStatus') {
      if (!['PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED'].includes(status)) {
        return NextResponse.json({ error: 'الحالة غير صالحة' }, { status: 400 });
      }
      if (target.id === admin.id) {
        return NextResponse.json({ error: 'لا يمكنك تغيير حالة حسابك الشخصي' }, { status: 400 });
      }
      updateData.status = status;
      if (status === 'ACTIVE') {
        updateData.assignedById = admin.id;
        updateData.assignedAt = new Date();
      }
      // Suspension/disable must kill active sessions immediately
      if (status === 'SUSPENDED' || status === 'DISABLED') {
        updateData.tokenVersion = { increment: 1 };
      }
      auditAction = 'USER_STATUS_CHANGED';
    } else if (action === 'forceLogout') {
      updateData.tokenVersion = { increment: 1 };
      auditAction = 'USER_FORCED_LOGOUT';
    } else if (action === 'resetPassword') {
      /*
       * ── THE OWNER'S, AND NOBODY ELSE'S ──
       *
       * `users.edit` opens this route, and MANAGER holds it: without this
       * check a manager could set the password on the account above them.
       * Setting a password and stripping a second factor are the same kind
       * of act — a way into an account that is not yours — so they are
       * granted by the same rule, from the same file.
       */
      const mayDo = maySetPassword(admin as never, id);
      if (!mayDo.ok) {
        return NextResponse.json({ error: mayDo.error, code: mayDo.code }, { status: mayDo.status });
      }

      /*
       * TYPED, OR GENERATED — AND NEVER READ BACK.
       *
       * The owner asked to «see» a staff password. The system cannot: it
       * stores a bcrypt hash and nothing else, which is the property that
       * makes a database leak survivable. So the honest answer is the one
       * the screen gives — set a new one, and see THAT once.
       *
       * A typed password goes through the same `PASSWORD_RULES` every
       * other door uses, so the button and the server agree about what is
       * allowed.
       */
      const typed = typeof body.newPassword === 'string' ? body.newPassword : null;
      if (typed !== null) {
        const problem = passwordMessage(typed);
        if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      }
      const tempPassword = typed ?? generatePassword((max) => crypto.randomInt(max));
      updateData.passwordHash = await hashPassword(tempPassword);
      updateData.tokenVersion = { increment: 1 };
      await db.user.update({ where: { id }, data: updateData });
      await logAudit({
        companyId: target.companyId || admin.companyId || 'platform',
        userId: admin.id,
        action: 'USER_PASSWORD_RESET_BY_ADMIN',
        entity: 'User',
        entityId: id,
        previousData: { user: target.name, email: target.email },
        newData: { resetBy: admin.name, chosen: typed !== null }, // the password itself is NEVER logged
      });
      // Returned once over the authenticated response only
      return NextResponse.json({ success: true, temporaryPassword: tempPassword });
    } else if (action === 'updateContact') {
      // The employee's phone, on their own page. It could be set only when
      // the account was created, with no way to correct it afterwards.
      // Typed on an Arabic keyboard the digits are ٠-٩; stored as 0-9.
      //
      // ONLY WHEN THE PHONE WAS SENT. The shift, salary and commission-currency
      // cards save through this same action without a phone, and an absent
      // phone read as «cleared»: every one of those saves wiped the
      // employee's number. Absent now means untouched; an empty string still
      // clears it on purpose.
      if ('phone' in body) {
        const phone = typeof body.phone === 'string' ? toLatinDigits(body.phone).trim() : '';
        if (phone && !/^\+?[\d\s()-]{6,24}$/.test(phone)) {
          return NextResponse.json({ error: 'رقم الهاتف غير صالح — أرقام فقط، ويمكن أن يبدأ بـ +' }, { status: 400 });
        }
        updateData.phone = phone || null;
      }

      // WHAT THIS PERSON'S COMMISSION IS COUNTED IN.
      //
      // An Egyptian moderator working a Syrian store's orders earns in
      // pounds, and is told a figure in pounds. Where the money comes from
      // is a separate question answered when it is paid: there may be no
      // pound wallet at all, and the cash leaves another one at a rate the
      // owner writes then (commission-payout.ts).
      if ('commissionCurrency' in body) {
        // Every accrual is booked in it, so it is pay — the same key as the
        // salary below, not «تعديل المستخدمين».
        if (!can(admin, 'payroll.pay')) {
          const refusal = forbiddenAr('Forbidden: missing required permission payroll.pay');
          return NextResponse.json({ error: refusal, errorAr: refusal }, { status: 403 });
        }
        const raw = typeof body.commissionCurrency === 'string' ? body.commissionCurrency.trim().toUpperCase() : '';
        if (raw && !/^[A-Z]{3}$/.test(raw)) {
          return NextResponse.json({ error: 'رمز العملة ثلاثة أحرف (ISO)' }, { status: 400 });
        }
        // Empty means the store's own currency, which is how it always was.
        updateData.commissionCurrency = raw || null;
      }

      /*
       * NOT YOUR OWN SHIFT, unless you may already move pay (RV159).
       *
       * `updateContact` is exempt from `canActOnUser` on purpose — correcting a colleague's phone is not power over
       * them — and that exemption also covered the person themselves: whoever holds «تعديل المستخدمين» could set
       * their own start time and rest days, and lateness and the deduction built on it are counted from exactly
       * those. So a CHANGE to one's own schedule asks for the key that already guards what the business pays a
       * person (`payroll.pay`, the same one the salary and the commission currency below ask for). No new key.
       *
       * A save that sends the values the account already has is not a change: the shift card posts both fields
       * together, and an employee correcting their own phone must not be refused for a shift they did not touch.
       */
      if (target.id === admin.id && ('shiftStart' in body || 'shiftEnd' in body || 'restDays' in body)) {
        const moves =
          ('shiftStart' in body && parseHhMm(body.shiftStart) !== (target.shiftStart ?? null)) ||
          ('shiftEnd' in body && parseHhMm(body.shiftEnd) !== (target.shiftEnd ?? null)) ||
          ('restDays' in body && parseRestDays(body.restDays) !== (target.restDays ?? null));
        if (moves && !can(admin, 'payroll.pay')) {
          const refusal = 'ما بتقدر تغيّر دوامك بنفسك — الدوام بيحدد التأخير والخصم، وبيغيّره حدا ثاني.';
          return NextResponse.json({ error: refusal, errorAr: refusal, code: 'OWN_SHIFT' }, { status: 403 });
        }
      }

      // WHEN THIS PERSON STARTS, AND WHEN THEY HAND OVER.
      //
      // Lateness was measured against the COUNTRY's hours, so somebody
      // whose shift genuinely starts at noon read as three hours late every
      // day — and every figure built on that, now including a deduction,
      // was wrong in the same direction. Empty means the country's, which
      // is what everybody had before this existed.
      if ('shiftStart' in body || 'shiftEnd' in body) {
        const from = parseHhMm(body.shiftStart);
        const to = parseHhMm(body.shiftEnd);
        if (body.shiftStart && !from) {
          return NextResponse.json({ error: 'وقت البدء بصيغة HH:mm' }, { status: 400 });
        }
        if (body.shiftEnd && !to) {
          return NextResponse.json({ error: 'وقت التسليم بصيغة HH:mm' }, { status: 400 });
        }
        // Refused rather than silently ignored: a shift saved and not
        // applied is worse than one refused, because nobody goes back to
        // check a field that reported success.
        if (from && to && to <= from) {
          return NextResponse.json({ error: 'وقت التسليم يجب أن يكون بعد وقت البدء' }, { status: 400 });
        }
        updateData.shiftStart = from;
        updateData.shiftEnd = to;
      }
      if ('restDays' in body) updateData.restDays = parseRestDays(body.restDays);

      // WHAT THIS PERSON IS PAID.
      //
      // Empty clears it, and no salary on file is the normal state: a
      // salary is a deliberate entry, and a default one would pay somebody
      // a number nobody chose. The currency is its own field rather than
      // the store's, for the same reason the commission currency is — an
      // Egyptian employee told a figure in Syrian pounds has been told
      // nothing.
      if ('salaryAmount' in body || 'salaryCurrency' in body) {
        // Its own key. Whoever may edit a colleague's phone number has no
        // business setting what the business pays them.
        if (!can(admin, 'payroll.pay')) {
          return NextResponse.json(
            { error: 'Forbidden: missing required permission payroll.pay', errorAr: forbiddenAr('Forbidden: missing required permission payroll.pay') },
            { status: 403 }
          );
        }
      }
      if ('salaryAmount' in body) {
        const raw = body.salaryAmount;
        if (raw === null || raw === '') {
          updateData.salaryAmount = null;
        } else {
          /*
           * READ LIKE MONEY, NOT LIKE `Number()`.
           *
           * The finiteness check and the ceiling were already here and both
           * are right. The NOTATION was not, and `Number()` is the whole
           * reason: measured on this build, `Number('0x10')` is **16**, so
           * `{"salaryAmount":"0x10"}` filed somebody's pay as sixteen —
           * and `Number('   ')` is **0**, so a field holding one space
           * filed a salary of ZERO. Zero is the worse of the two: the
           * screen shows a salary and offers «اصرف» (`UserSalary.tsx`
           * shows the button for any non-null amount), and payroll then
           * refuses by the other road — `payroll.ts:85` treats `<= 0` as
           * NO_SALARY. A person with a salary on file who cannot be paid.
           *
           * `money()` is the repository's strict money reader: a number, or
           * a string written the way a decimal number is written, and
           * nothing else. It carries these exact bounds, so nothing moves:
           *
           *   min 0           — a month paid at nothing is a real entry,
           *                     and the column's own default side is zero.
           *   max 100_000_000 — the column is `Decimal(14, 3)`, which holds
           *                     9,999,999,999.99; a hundred million is the
           *                     tighter, deliberate business ceiling that
           *                     was already written here, and no monthly
           *                     wage in any currency this system serves
           *                     reaches it. This is the ONLY door that
           *                     writes `User.salaryAmount`, so there is no
           *                     second declaration to agree with.
           *
           * The clearing branch above stays BEFORE this on purpose: `''`
           * and `null` mean «no salary on file», and `money()` refuses both
           * rather than reading them as zero — which is exactly why it is
           * the right reader here.
           */
          const amount = money(100_000_000).safeParse(raw);
          if (!amount.success) {
            return NextResponse.json({ error: 'الراتب رقم موجب' }, { status: 400 });
          }
          updateData.salaryAmount = amount.data;
        }
      }
      if ('salaryCurrency' in body) {
        const raw = typeof body.salaryCurrency === 'string' ? body.salaryCurrency.trim().toUpperCase() : '';
        if (raw && !/^[A-Z]{3}$/.test(raw)) {
          return NextResponse.json({ error: 'رمز العملة ثلاثة أحرف (ISO)' }, { status: 400 });
        }
        updateData.salaryCurrency = raw || null;
      }

      auditAction = 'USER_CONTACT_UPDATED';
    } else if (action === 'delete') {
      if (target.id === admin.id) {
        return NextResponse.json({ error: 'لا يمكنك حذف حسابك الشخصي' }, { status: 400 });
      }
      if (target.role === 'SUPER_ADMIN') {
        return NextResponse.json({ error: 'لا يمكن حذف حساب المدير الأعلى' }, { status: 400 });
      }
      await db.user.delete({ where: { id } });
      await logAudit({
        companyId: target.companyId || admin.companyId || 'platform',
        userId: admin.id,
        action: 'USER_DELETED',
        entity: 'User',
        entityId: id,
        previousData: { user: target.name, email: target.email, role: target.role, status: target.status },
        newData: { deletedBy: admin.name },
      });
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 });
    }

    const updated = await db.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        assignedById: true,
        assignedAt: true,
      },
    });

    await logAudit({
      companyId: target.companyId || admin.companyId || 'platform',
      userId: admin.id,
      action: auditAction,
      entity: 'User',
      entityId: id,
      previousData: {
        user: target.name,
        email: target.email,
        role: target.role,
        status: target.status,
        ...(action === 'updateContact'
          ? {
              phone: target.phone,
              commissionCurrency: target.commissionCurrency,
              shiftStart: target.shiftStart,
              shiftEnd: target.shiftEnd,
              restDays: target.restDays,
              // The amount is in the audit on purpose: a salary changed
              // quietly is the one change nobody can reconstruct later.
              salaryAmount: target.salaryAmount === null ? null : Number(target.salaryAmount),
              salaryCurrency: target.salaryCurrency,
            }
          : {}),
      },
      newData: {
        user: updated.name,
        email: updated.email,
        role: updated.role,
        status: updated.status,
        ...(action === 'updateContact'
          ? {
              phone: updateData.phone,
              commissionCurrency: updateData.commissionCurrency,
              /*
               * THE NEW SALARY, NEXT TO THE OLD ONE.
               *
               * The row above kept the old figure «on purpose: a salary changed quietly is the one change
               * nobody can reconstruct later» — and then wrote only the OLD one, so the log said what a salary
               * had been and never what it became. Only a key that was sent is written (an absent key is «not
               * touched», a present null is «cleared»), so a phone edit does not claim to have set a salary.
               * The pay keys are stripped from this row for anyone without the payroll key (audit-pay-redact).
               */
              ...('salaryAmount' in updateData
                ? { salaryAmount: updateData.salaryAmount === null ? null : Number(updateData.salaryAmount) }
                : {}),
              ...('salaryCurrency' in updateData ? { salaryCurrency: updateData.salaryCurrency } : {}),
            }
          : {}),
        changedBy: admin.name,
        changedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({ success: true, user: updated });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}
