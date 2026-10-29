'use client';

/**
 * SALESFLOW — /users/[id]: employee profile.
 * Identity + role/status + workload (assigned & claimed orders).
 * All data comes from the server; actions link back to the manage modal on /users.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/Card';
import { useApp } from '@/context/AppContext';
import { arDate, arDateTime } from '@/lib/format';
import { userCan } from '@/lib/can';
import { ScoreCard } from '@/components/performance/ScoreCard';
import { UserShift } from '@/components/screens/users/UserShift';
import { UserSalary } from '@/components/screens/users/UserSalary';
import {
  PERMISSION_MODULES,
  MODULE_LABELS,
  SCOPE_LABELS,
  TIER_COVERAGE,
  catalogItem,
  isRetiredKey,
  type ScopeValue,
} from '@/lib/permission-catalog';
import { planOverride, removalBlock, type PlanRow } from '@/lib/override-plan';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { UserGeoAccessSection, UserPhoneField } from '@/components/screens/users/UserAccessSections';
import { UserCommissionCurrency } from '@/components/screens/users/UserCommissionCurrency';
import { ASSIGNABLE_ROLES, ROLE_LABELS } from '@/types/auth';
import { RiAddCircleLine, RiAlertLine, RiArrowRightLine, RiCheckLine, RiCloseLine, RiDeleteBinLine, RiKey2Line, RiLoader4Line, RiMailLine, RiSearchLine, RiShieldCheckLine, RiShieldKeyholeLine, RiTimerLine, RiToolsLine, RiUserLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { maySetPassword } from '@/lib/two-factor-reset';
import { PASSWORD_RULES, passwordProblems } from '@/lib/password-rules';
import { useConfirm } from '@/components/ui/Confirm';
import { mayResetTwoFactor } from '@/lib/two-factor-reset';
import { PageHeader } from '@/components/ui/PageHeader';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';

/** A role picked by name (the fallback list), not by its row id. */
const BY_NAME = 'name:';

export function UserDetailScreen() {
  const { locale, isRtl, currentUser } = useApp();
  const confirm = useConfirm();
  const ar = locale === 'ar';
  const params = useParams();
  const router = useRouter();
  const userId = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : null;

  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Role assignment state (roleId-based)
  const [roles, setRoles] = useState<{ id: string; name: string; isSystem: boolean; permissionsCount: number }[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [savingRole, setSavingRole] = useState(false);
  const [roleFlash, setRoleFlash] = useState<string | null>(null);
  const [resetting2fa, setResetting2fa] = useState(false);
  const [twoFaMsg, setTwoFaMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /*
   * THE NEW PASSWORD, HELD FOR AS LONG AS THE SCREEN IS OPEN AND NO LONGER.
   *
   * In component state only — never written anywhere, never fetched back.
   * The system keeps a bcrypt hash and nothing else, so this is the single
   * moment the characters exist outside the owner's head, and the screen
   * says so rather than letting them assume they can come back for it.
   */
  const [typedPassword, setTypedPassword] = useState('');
  const [shownPassword, setShownPassword] = useState<string | null>(null);
  const [settingPassword, setSettingPassword] = useState(false);
  const [passwordErr, setPasswordErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /**
   * CLEARING AN ENROLMENT IS NOT LOGGING SOMEBODY IN.
   *
   * It asks first and says exactly what follows, because «أعِد الضبط» read
   * on its own sounds like it hands the account over. It does the
   * opposite: the next login cannot proceed until a new phone is enrolled.
   */
  /**
   * SET A STAFF PASSWORD — TYPED, OR GENERATED, AND SHOWN ONCE.
   *
   * `newPassword` absent means «generate one». The door returns the
   * characters exactly once, in this response; there is no second request
   * that can ask for them again, because the system never stored them.
   * His open sessions end with the change, which is the point: whoever was
   * using the old password is out.
   */
  const setPassword = async (generate: boolean) => {
    if (!userId) return;
    const ok = await confirm({
      title: `تغيير كلمة سرّ ${user?.name ?? 'هذا الموظّف'}؟`,
      body: 'رح تُغلَق كلّ جلساته المفتوحة فوراً، ورح تشوف كلمة السرّ مرّة وحدة بس. يُسجّل هذا باسمك في سجلّ التدقيق.',
      confirmLabel: 'غيّرها',
      tone: 'danger',
    });
    if (!ok) return;
    setSettingPassword(true);
    setPasswordErr(null);
    setShownPassword(null);
    setCopied(false);
    try {
      const res = await apiJson<{ temporaryPassword: string }>(`/api/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'resetPassword',
          ...(generate ? {} : { newPassword: typedPassword }),
        }),
      });
      setShownPassword(res.temporaryPassword);
      setTypedPassword('');
    } catch (e) {
      setPasswordErr(e instanceof Error ? e.message : 'تعذّر تغيير كلمة السرّ');
    } finally {
      setSettingPassword(false);
    }
  };

  const resetTwoFactor = async () => {
    if (!userId) return;
    const ok = await confirm({
      title: `إعادة ضبط التحقّق بخطوتين لـ${user?.name ?? 'هذا الموظّف'}؟`,
      body:
        'يُمسح تسجيلُ هاتفه الحالي ورموزُ الاسترداد، ويُطلب منه تسجيلُ هاتفٍ جديد عند الدخول القادم — ' +
        'ولا يدخل بلا تحقّق. يُسجَّل هذا باسمك في سجلّ التدقيق.',
      confirmLabel: 'أعِد الضبط',
      tone: 'danger',
    });
    if (!ok) return;
    setResetting2fa(true);
    setTwoFaMsg(null);
    try {
      const res = await apiJson<{ message: string }>(`/api/users/${userId}/two-factor`, { method: 'DELETE' });
      setTwoFaMsg({ ok: true, text: res.message });
      // The card is drawn from this one field, so clearing it here is what
      // makes the button disappear — no refetch for a fact we just set.
      setUser((prev: any) => (prev ? { ...prev, totpEnabledAt: null } : prev));
    } catch (e) {
      setTwoFaMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذر إعادة الضبط' });
    } finally {
      setResetting2fa(false);
    }
  };
  const [roleError, setRoleError] = useState<string | null>(null);
  // The server says whether this viewer may act on this account (canActOnUser);
  // every control that acts on it is drawn from that, with one line saying why not.
  const mayManage = user?.mayManage !== false;
  const canAssignRole = userCan(currentUser, 'users.edit') && mayManage;

  useEffect(() => {
    if (!userId) return;
    (async () => {
      setLoading(true);
      try {
        // Load user + workload counts via existing APIs (server enforces users.view)
        const res = await fetch(`/api/users/${userId}/profile`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Not found');
        }
        const data = await res.json();
        setUser(data);
        // Load assignable roles (system + company) — server enforces roles.view
        // via the same API used by /roles; failure is non-fatal here.
        try {
          const rolesRes = await fetch('/api/roles');
          if (rolesRes.ok) {
            const rolesData = await rolesRes.json();
            setRoles(
              (rolesData.roles ?? []).map((r: any) => ({
                id: r.id,
                name: r.name,
                isSystem: r.isSystem,
                permissionsCount: r.permissionsCount,
              }))
            );
          }
        } catch {
          // role picker stays empty; assignment card falls back to display-only
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  if (loading) {
    return (
      <>
        <div className="flex justify-center py-24">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--sys-primary)]" />
        </div>
      </>
    );
  }

  if (error || !user) {
    return (
      <>
        <div className="space-y-4 text-center py-16" dir={isRtl ? 'rtl' : 'ltr'}>
          <p className="text-sm text-[var(--sys-destructive)]">{error || (ar ? 'المستخدم غير موجود' : 'User not found')}</p>
          <Button variant="outline" size="sm" onClick={() => router.push('/admin/users')}>
            {ar ? 'عودة للموظفين' : 'Back to Employees'}
          </Button>
        </div>
      </>
    );
  }

  const statusCls: Record<string, string> = {
    ACTIVE: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success-soft)]',
    PENDING: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/60',
    SUSPENDED: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]',
    DISABLED: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]',
  };

  const currentRoleRow = roles.find((r) => r.name === user.role);
  const effectivePermsCount = currentRoleRow?.permissionsCount ?? null;

  async function saveRole() {
    if (!selectedRoleId || !user) return;
    setSavingRole(true);
    setRoleError(null);
    setRoleFlash(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // A named role (the fallback list) goes by name; the server points
        // roleId at the company's role of that name and checks what it grants.
        body: JSON.stringify(
          selectedRoleId.startsWith(BY_NAME)
            ? { action: 'assignRole', role: selectedRoleId.slice(BY_NAME.length) }
            : { action: 'assignRole', roleId: selectedRoleId }
        ),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || (ar ? 'فشل حفظ الدور' : 'Failed to update role'));
      }
      const d = await res.json();
      setUser((prev: any) => ({ ...prev, role: d.user?.role ?? prev.role }));
      setRoleFlash(ar ? 'تم تحديث الدور بنجاح' : 'Role updated successfully');
      setTimeout(() => setRoleFlash(null), 2500);
    } catch (e: any) {
      setRoleError(e.message);
    } finally {
      setSavingRole(false);
    }
  }

  return (
    <>
      <div className="space-y-6" dir={isRtl ? 'rtl' : 'ltr'}>
        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" size="sm" onClick={() => router.push('/admin/users')}>
            <RiArrowRightLine className="icon-mirror w-4 h-4" />
            {ar ? 'عودة للموظفين' : 'Back to Employees'}
          </Button>
        </div>

        {/* Identity header */}
        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="w-14 h-14 rounded-lg bg-[var(--sys-destructive-soft)] border-2 border-[var(--sys-destructive-border)] flex items-center justify-center shrink-0">
                <RiUserLine className="w-6 h-6 text-[var(--sys-destructive)]" />
              </div>
              <PageHeader title={user.name}
          description={`<RiMailLine className="w-4 h-4" /> ${user.email}`}
        />
              <span className={`text-xs font-bold rounded-full border-2 px-3 py-1 ${statusCls[user.status] || ''}`}>
                {user.status}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-5 text-xs">
              <div className="rounded-lg bg-[var(--sys-surface)] px-3 py-2.5">
                <p className="text-xs text-[var(--sys-muted)] flex items-center gap-1"><RiShieldCheckLine className="w-4 h-4" />{ar ? 'الرتبة' : 'Role'}</p>
                <p className="font-bold text-[var(--sys-heading)]">{user.role}</p>
              </div>
              <div className="rounded-lg bg-[var(--sys-surface)] px-3 py-2.5">
                <p className="text-xs text-[var(--sys-muted)] flex items-center gap-1"><RiTimerLine className="w-4 h-4" />{ar ? 'آخر دخول' : 'Last Login'}</p>
                <p className="font-bold text-[var(--sys-heading)]">
                  {arDateTime(user.lastLoginAt)}
                </p>
              </div>
              <div className="rounded-lg bg-[var(--sys-surface)] px-3 py-2.5">
                <p className="text-xs text-[var(--sys-muted)]">{ar ? 'تاريخ التسجيل' : 'Created'}</p>
                <p className="font-bold text-[var(--sys-heading)]">{arDate(user.createdAt)}</p>
              </div>
              {userId && <UserPhoneField userId={userId} initial={user.phone ?? null} canEdit={userCan(currentUser, 'users.edit')} />}
              {/* Counting is one question, paying another: this names the
                  currency they earn in, not a wallet the business may not
                  have. The wallet is chosen when the money is handed over. */}
              {userId && (
                <UserCommissionCurrency
                  userId={userId}
                  initial={user.commissionCurrency ?? null}
                  // Pay, like the salary below — the server asks the same key, on the employee door (users.edit).
                  canEdit={userCan(currentUser, 'payroll.pay') && userCan(currentUser, 'users.edit')}
                />
              )}
              {/* When they start and when they hand over. Lateness — and
                  anything deducted for it — is measured against these, not
                  against the country's nine o'clock. */}
              {/* What they are paid, and the button that pays it — where
                  the deductions finally land. Its own permission: whoever
                  may edit a colleague's phone has no business setting what
                  the business pays them. */}
              {userId && userCan(currentUser, 'payroll.view') && (
                <UserSalary
                  userId={userId}
                  initial={{
                    salaryAmount: user.salaryAmount ?? null,
                    salaryCurrency: user.salaryCurrency ?? null,
                  }}
                  canEdit={userCan(currentUser, 'payroll.pay')}
                  canPay={userCan(currentUser, 'payroll.pay')}
                />
              )}
              {userId && (
                <UserShift
                  userId={userId}
                  initial={{
                    shiftStart: user.shiftStart ?? null,
                    shiftEnd: user.shiftEnd ?? null,
                    restDays: user.restDays ?? null,
                  }}
                  canEdit={userCan(currentUser, 'users.edit')}
                />
              )}
            </div>
          </CardContent>
        </Card>

        {/* Their performance, in their file, for whoever may watch the
            team. The same numbers they see on their own profile — two
            figures for one month is an argument nobody can settle. */}
        {userId && userCan(currentUser, 'team.monitor') && <ScoreCard userId={userId} />}

        {/* Role assignment (roleId-based) */}
        {/*
          A PHONE IS LOST, AND THE PERSON STILL WORKS HERE.

          «زر لـ reset الـ 2FA للموظفين، بس للمالك حصراً». Without it the
          only cure was a developer with a database client, which is not a
          cure — it is an outage with somebody's name on it.

          It does not let anybody in: it clears the enrolment, so the next
          login walks that person through enrolling again on the new phone,
          with a fresh secret and fresh recovery codes.

          Drawn only for the owner, only for somebody ELSE, and only when
          there is an enrolment to clear — a button that always refuses
          teaches people the screen is lying to them.
        */}
        {/*
          THE STATE IS SHOWN WHETHER OR NOT THERE IS ANYTHING TO RESET.

          Every account carries a second factor now, so «not enrolled» is
          no longer «this role is exempt» — it is «he has not signed in
          since». That is a fact the owner needs to see, and the card used
          to be drawn only when there WAS an enrolment, so the accounts
          that had none were the ones it said nothing about.
        */}
        {/*
          ═══ CHANGING A STAFF PASSWORD ═══

          The owner asked to SEE a staff password. The system cannot show
          one: it stores a bcrypt hash and nothing else, which is the
          property that makes a database leak survivable. So the screen
          says that in as many words, and offers the thing that does help
          — set a new one and see THAT, once.

          For the owner only, and never on himself: `maySetPassword` is the
          same rule that governs stripping a second factor, from the same
          file, because both hand somebody a way into an account.
        */}
        {maySetPassword(currentUser as never, user.id).ok && (
          <Card>
            <CardContent className="p-5 space-y-3">
              <h3 className="text-xs font-black text-[var(--sys-foreground)] flex items-center gap-1.5">
                <RiKey2Line className="w-4 h-4" />
                كلمة السرّ
              </h3>

              {/* Icons, not emoji: `one-icon-family.test.ts` refuses a
                  glyph the operating system draws, because it is a
                  different typeface on every phone. */}
              <div className="rounded-lg bg-[var(--sys-warning-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--sys-warning)]">
                <p className="flex items-start gap-1.5">
                  <RiAlertLine className="mt-0.5 h-4 w-4 shrink-0" />
                  كلمة السرّ الحاليّة ما بتنعرض — النظام ما بيخزّنها.
                </p>
                <p className="mt-1 flex items-start gap-1.5">
                  <RiToolsLine className="mt-0.5 h-4 w-4 shrink-0" />
                  غيّرها من هون وانسخ الجديدة.
                </p>
              </div>

              {shownPassword ? (
                <div className="space-y-2 rounded-lg border border-[var(--sys-success-soft)] bg-[var(--sys-success-soft)] p-3">
                  <p className="text-xs font-black text-[var(--sys-success)]">انسخها هلأ — ما رح تنعرض مرّة تانية</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 select-all rounded-lg bg-[var(--sys-card)] px-3 py-2 text-sm font-bold tracking-wide" dir="ltr">
                      {shownPassword}
                    </code>
                    <button
                      type="button"
                      onClick={() => { void navigator.clipboard?.writeText(shownPassword); setCopied(true); }}
                      className="min-h-11 md:min-h-0 rounded-lg border border-[var(--sys-border)] px-3 py-1.5 text-xs font-bold hover:border-[var(--sys-primary)]"
                    >
                      {copied ? 'اننسخت' : 'انسخ'}
                    </button>
                  </div>
                  <p className="text-xs leading-relaxed text-[var(--sys-success)]">
                    وكلّ جلساته المفتوحة انقفلت — رح يدخل بهاي الكلمة.
                  </p>
                </div>
              ) : (
                <>
                  <label className="block">
                    <span className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">كلمة سرّ جديدة</span>
                    <input
                      type="text"
                      dir="ltr"
                      value={typedPassword}
                      onChange={(e) => { setTypedPassword(e.target.value); setPasswordErr(null); }}
                      placeholder="اكتبها، أو ولّد واحدة"
                      className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm"
                    />
                  </label>
                  <ul className="space-y-0.5">
                    {PASSWORD_RULES.map((r) => {
                      const met = typedPassword.length > 0 && r.test(typedPassword);
                      return (
                        <li key={r.key} className={`flex items-center gap-1 text-xs ${met ? 'text-[var(--sys-success)]' : 'text-[var(--sys-muted-foreground)]'}`}>
                          <RiCheckLine className={`h-4 w-4 shrink-0 ${met ? '' : 'opacity-40'}`} />
                          {r.ar}
                        </li>
                      );
                    })}
                  </ul>
                  {passwordErr && (
                    <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] px-3 py-2 text-xs text-[var(--sys-destructive)]">
                      {passwordErr}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={settingPassword || passwordProblems(typedPassword).length > 0}
                      onClick={() => void setPassword(false)}
                      className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg bg-[var(--sys-primary)] px-4 py-1.5 text-xs font-bold text-[var(--sys-primary-foreground)] disabled:opacity-50"
                    >
                      {settingPassword ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiKey2Line className="w-4 h-4" />}
                      غيّر كلمة السرّ
                    </button>
                    <button
                      type="button"
                      disabled={settingPassword}
                      onClick={() => void setPassword(true)}
                      className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-border)] px-4 py-1.5 text-xs font-medium hover:border-[var(--sys-primary)] disabled:opacity-50"
                    >
                      ولّد واحدة
                    </button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {!user.totpEnabledAt && (
          <Card>
            <CardContent className="p-5 space-y-1">
              <h3 className="text-xs font-black text-[var(--sys-foreground)] flex items-center gap-1.5">
                <RiShieldKeyholeLine className="w-4 h-4" />
                التحقّق بخطوتين
              </h3>
              <p className="text-xs font-semibold text-[var(--sys-muted-foreground)]">بانتظار أوّل دخول</p>
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                كلّ حساب صار عليه تحقّق بخطوتين. هذا الموظّف رح يُطلَب منه يسجّله أوّل مرّة يدخل فيها بكلمة السرّ — لازم يكون منزّل تطبيق Google Authenticator على جواله.
              </p>
            </CardContent>
          </Card>
        )}

        {mayResetTwoFactor(currentUser as never, user.id).ok && user.totpEnabledAt && (
          <Card>
            <CardContent className="p-5 space-y-2">
              <h3 className="text-xs font-black text-[var(--sys-foreground)] flex items-center gap-1.5">
                <RiShieldKeyholeLine className="w-4 h-4" />
                التحقّق بخطوتين
              </h3>
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                مسجَّلٌ على جهاز هذا الموظّف. إن فقد هاتفه، تُعيد الضبطَ فيُطلب منه تسجيلُه من
                جديد عند الدخول القادم — ولا يدخل أحدٌ بلا تحقّق.
              </p>
              {twoFaMsg && (
                <p
                  className={`rounded-lg px-3 py-2 text-xs font-medium ${
                    twoFaMsg.ok
                      ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]'
                      : 'bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]'
                  }`}
                >
                  {twoFaMsg.text}
                </p>
              )}
              {/* Resetting somebody's second factor is a recovery step, not a
                  daily one; it folds under متقدم beside the password controls.
                  Nothing is removed — the card still says it is registered. */}
              <AdvancedGroup holds="إعادة ضبط">
              <button
                type="button"
                disabled={resetting2fa}
                onClick={() => void resetTwoFactor()}
                className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-border)] px-4 py-1.5 text-xs font-medium text-[var(--sys-foreground)] hover:border-[var(--sys-destructive-border)] hover:text-[var(--sys-destructive)] disabled:opacity-50"
              >
                {resetting2fa ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiShieldKeyholeLine className="w-4 h-4" />}
                أعِد ضبط التحقّق بخطوتين
              </button>
              </AdvancedGroup>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-5">
            <h3 className="text-xs font-black text-[var(--sys-foreground)] mb-3 flex items-center gap-1.5">
              <RiKey2Line className="w-4 h-4" />
              {ar ? 'الدور والصلاحيات' : 'Role & Permissions'}
            </h3>
            {roleFlash && (
              <div className="mb-3 rounded-lg bg-[var(--sys-success-soft)] border border-[var(--sys-success-soft)] text-[var(--sys-success)] text-xs font-medium px-3 py-2">
                {roleFlash}
              </div>
            )}
            {roleError && (
              <div className="mb-3 rounded-lg bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-xs font-medium px-3 py-2">
                {roleError}
              </div>
            )}
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1 space-y-1">
                <p className="text-xs text-[var(--sys-muted)]">{ar ? 'الدور الحالي' : 'Current role'}</p>
                <p className="text-sm font-bold text-[var(--sys-heading)]">{user.role}</p>
                {effectivePermsCount !== null && (
                  <p className="text-xs text-[var(--sys-muted-foreground)]">
                    {ar ? `${effectivePermsCount} صلاحية فعّالة` : `${effectivePermsCount} effective permissions`}
                  </p>
                )}
              </div>
              {canAssignRole && (
                <>
                  <div className="flex-1 max-w-xs">
                    <Select
                      label={ar ? 'تغيير الدور' : 'Change role'}
                      value={selectedRoleId}
                      onChange={(e) => setSelectedRoleId(e.target.value)}
                      options={[
                        { value: '', label: ar ? '— اختر دورًا —' : '— Pick a role —' },
                        // The roles list needs roles.view. Without it the
                        // page still offers the named roles — the list's own
                        // role editor, which this page replaced.
                        ...(roles.length > 0
                          ? roles.map((r) => ({
                              value: r.id,
                              label: `${r.name}${r.isSystem ? (ar ? ' (نظامي)' : ' (system)') : ''}`,
                            }))
                          : ASSIGNABLE_ROLES.map((name) => ({
                              value: `${BY_NAME}${name}`,
                              label: ar ? ROLE_LABELS[name].ar : ROLE_LABELS[name].en,
                            }))),
                      ]}
                    />
                  </div>
                  <Button onClick={saveRole} loading={savingRole} disabled={!selectedRoleId}>
                    {ar ? 'حفظ الدور' : 'Save role'}
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Where this person may work — the access API had no screen before this. */}
        {!mayManage && user?.manageRefusal && (
          <p className="text-xs text-[var(--sys-muted-foreground)]">{user.manageRefusal}</p>
        )}

        {userId && userCan(currentUser, 'geo.manage') && (
          <UserGeoAccessSection userId={userId} canEdit={userCan(currentUser, 'geo.manage') && mayManage} />
        )}

        {/* Effective permissions + user overrides (Phase 5) — gated server-side by users.view/users.edit */}
        {userCan(currentUser, 'users.view') && userId && (
          <UserPermissionsSection userId={userId} canEdit={userCan(currentUser, 'users.edit') && mayManage} />
        )}

        {/* Workload */}
        <Card>
          <CardContent className="p-5">
            <h3 className="text-xs font-black text-[var(--sys-foreground)] mb-3">
              {ar ? 'حجم العمل الحالي' : 'Current Workload'}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
              <div className="rounded-lg border border-[var(--sys-border)] px-3 py-4">
                <p className="text-2xl font-black text-[var(--sys-destructive)]">{user.workload?.assigned ?? 0}</p>
                <p className="text-xs text-[var(--sys-muted-foreground)] mt-1">{ar ? 'طلبات مسندة' : 'Assigned Orders'}</p>
              </div>
              <div className="rounded-lg bg-[var(--sys-surface)] px-3 py-4">
                <p className="text-2xl font-black text-[var(--sys-heading)]">{user.workload?.claimed ?? 0}</p>
                <p className="text-xs text-[var(--sys-muted-foreground)] mt-1">{ar ? 'طلبات مستلمة' : 'Claimed Orders'}</p>
              </div>
              <div className="rounded-lg bg-[var(--sys-surface)] px-3 py-4">
                <p className="text-2xl font-black text-[var(--sys-heading)]">{user.workload?.created ?? 0}</p>
                <p className="text-xs text-[var(--sys-muted-foreground)] mt-1">{ar ? 'طلبات منشأة' : 'Created Orders'}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

// ─── Phase 5: Effective permissions inspector + user override editor ───
// Server remains the source of truth: /api/users/:id/permissions (GET/PUT)
// and /api/users/:id/permissions/:permission (DELETE) enforce users.view /
// users.edit plus tenant and SUPER_ADMIN guards. This UI only gates affordances.

interface GrantLike {
  scope: string;
  scopeIds?: unknown[] | null;
}

interface PermsPayload {
  user: { id: string; name: string; email: string };
  role: { id: string | null; name: string };
  permissionsVersion: number;
  roleGrants: Record<string, GrantLike>;
  overrides: { permission: string; effect: string; scope: string | null; scopeIds: unknown[] | null }[];
  effective: { fullAccess: boolean; grants: Record<string, GrantLike> };
  denied: string[];
}

interface EffectiveRow {
  key: string;
  ar: string;
  en: string;
  roleEffect: 'ALLOW' | null; // role_permissions carry no DENY effect
  overrideEffect: 'ALLOW' | 'DENY' | null;
  effectiveEffect: 'ALLOW' | 'DENY' | null;
  scopeLabel: string | null;
}

const PRODUCT_SEARCH_DEBOUNCE_MS = 350;

function UserPermissionsSection({ userId, canEdit }: { userId: string; canEdit: boolean }) {
  const { locale, currentUser } = useApp();
  const ar = locale === 'ar';

  const [payload, setPayload] = useState<PermsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [tableSearch, setTableSearch] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  // Why an exception was NOT removed (it would leave an action without its screen key).
  const [removeNotice, setRemoveNotice] = useState<string | null>(null);

  // Add/edit-override modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [draftEffect, setDraftEffect] = useState<'ALLOW' | 'DENY'>('ALLOW');
  // «إضافة بحث… ويظهرلي قائمة الأشياء اللي مش بصلاحياته أصلاً». The picker's search.
  const [pickQuery, setPickQuery] = useState('');
  const [draftScope, setDraftScope] = useState<ScopeValue>('ALL_COMPANY');
  // Advanced toggle: scopes stay hidden unless the admin opts in
  const [advancedScopes, setAdvancedScopes] = useState(false);
  const [draftScopeIds, setDraftScopeIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Scope pickers (mirrors the /roles editor)
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [productResults, setProductResults] = useState<{ id: string; name: string; sku: string }[]>([]);
  const [productLoading, setProductLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPerms = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/users/${userId}/permissions`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || (ar ? 'فشل تحميل الصلاحيات' : 'Failed to load permissions'));
      }
      const data: PermsPayload = await res.json();
      setPayload(data);
    } catch (e: any) {
      setLoadError(e.message);
    }
  }, [userId, ar]);

  useEffect(() => {
    loadPerms();
  }, [loadPerms]);

  function showFlash(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  }

  const overridesMap = useMemo(
    () => new Map((payload?.overrides ?? []).map((o) => [o.permission, o])),
    [payload]
  );
  const isFullAccess = payload?.effective.fullAccess ?? false;

  /*
   * WHAT THE PERSON HOLDS FROM THE ROLE, before any exception: the role's own
   * keys, and the effective keys no exception touches (the template's, for an
   * account with no role row of its own). The plan lays the exceptions over it
   * the way the engine does.
   */
  const baseKeys = useMemo(() => {
    if (!payload) return new Set<string>();
    const touched = new Set(payload.overrides.map((o) => o.permission));
    return new Set<string>([
      ...Object.keys(payload.roleGrants),
      ...Object.keys(payload.effective.grants).filter((k) => !touched.has(k)),
    ]);
  }, [payload]);

  // Every OTHER exception as stored, ready to be sent back with this one (a retired key is let go).
  const storedRows = useMemo<PlanRow[]>(
    () =>
      (payload?.overrides ?? [])
        .filter((o) => !isRetiredKey(o.permission))
        .map((o) => ({
          permission: o.permission,
          effect: o.effect === 'DENY' ? ('DENY' as const) : ('ALLOW' as const),
          ...(o.effect === 'ALLOW' && o.scope ? { scope: o.scope } : {}),
          ...(Array.isArray(o.scopeIds) && o.scopeIds.length > 0 ? { scopeIds: o.scopeIds as string[] } : {}),
        })),
    [payload],
  );

  // Whether the person at the keyboard can grant a key: holds it, or the broader tier that covers it.
  const canGrant = useCallback(
    (key: string) => userCan(currentUser, key) || (TIER_COVERAGE[key] ? userCan(currentUser, TIER_COVERAGE[key]) : false),
    [currentUser],
  );

  // ── Effective-permission table rows: roleGrants ∪ overrides ∪ effective ──
  const rows = useMemo<EffectiveRow[]>(() => {
    if (!payload) return [];
    const keys = new Set<string>([
      ...Object.keys(payload.roleGrants),
      ...payload.overrides.map((o) => o.permission),
      ...(payload.effective.fullAccess ? [] : Object.keys(payload.effective.grants)),
    ]);
    // Sort by catalog order (module → item) for a predictable layout
    const order = new Map<string, number>();
    PERMISSION_MODULES.forEach((m, mi) => m.items.forEach((i, ii) => order.set(i.key, mi * 1000 + ii)));
    return [...keys].sort((a, b) => (order.get(a) ?? 999999) - (order.get(b) ?? 999999)).map((key) => {
      const item = catalogItem(key);
      const ov = overridesMap.get(key);
      const eff = payload.effective.fullAccess ? { scope: 'ALL_COMPANY' } : payload.effective.grants[key];
      const effScope = (eff?.scope as ScopeValue | undefined) ?? null;
      return {
        key,
        ar: item?.ar ?? key,
        en: item?.en ?? key,
        roleEffect: payload.roleGrants[key] ? 'ALLOW' : null,
        overrideEffect: ov ? (ov.effect === 'DENY' ? 'DENY' : 'ALLOW') : null,
        effectiveEffect: payload.effective.fullAccess || eff ? 'ALLOW' : 'DENY',
        scopeLabel: effScope ? (SCOPE_LABELS[effScope]?.[ar ? 'ar' : 'en'] ?? effScope) : null,
      };
    });
  }, [payload, overridesMap, ar]);

  const filteredRows = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.key.toLowerCase().includes(q) || r.ar.includes(tableSearch.trim()) || r.en.toLowerCase().includes(q)
    );
  }, [rows, tableSearch]);

  // ── Modal helpers ──
  function openAddModal() {
    setRemoveNotice(null);
    setDraftKey('');
    setPickQuery('');
    setDraftEffect('ALLOW');
    setDraftScope('ALL_COMPANY');
    setDraftScopeIds([]);
    setModalError(null);
    setProductQuery('');
    setProductResults([]);
    setProductsError(null);
    setModalOpen(true);
  }

  function onDraftKeyChange(key: string) {
    setDraftKey(key);
    setModalError(null);
    const existing = overridesMap.get(key);
    if (existing) {
      // Permission already has an override → prefill (edit-in-place semantics)
      setDraftEffect(existing.effect === 'DENY' ? 'DENY' : 'ALLOW');
      const declared: readonly string[] = catalogItem(key)?.scopes ?? ['ALL_COMPANY'];
      const s = (existing.scope as ScopeValue) ?? 'ALL_COMPANY';
      setDraftScope(declared.includes(s) ? s : 'ALL_COMPANY');
      setDraftScopeIds(Array.isArray(existing.scopeIds) ? (existing.scopeIds as string[]) : []);
      setProductQuery('');
      setProductResults([]);
    } else {
      // The effect stays what the person chose: the list they picked from was built for it.
      setDraftScope('ALL_COMPANY');
      setDraftScopeIds([]);
      setProductQuery('');
      setProductResults([]);
    }
  }

  function onDraftScopeChange(s: ScopeValue) {
    setDraftScope(s);
    setDraftScopeIds([]);
    setModalError(null);
  }

  function toggleScopeId(id: string) {
    setDraftScopeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // Load categories once when a CATEGORY scope is being picked
  useEffect(() => {
    if (!modalOpen || draftEffect !== 'ALLOW' || draftScope !== 'CATEGORY' || categories.length > 0 || categoriesError) return;
    fetch('/api/categories')
      .then(async (r) => {
        if (!r.ok) throw new Error('failed');
        return r.json();
      })
      .then((d) => setCategories(d.categories ?? []))
      .catch(() => setCategoriesError(ar ? 'تعذر تحميل التصنيفات' : 'Failed to load categories'));
  }, [modalOpen, draftEffect, draftScope, categories.length, categoriesError, ar]);

  // Debounced product search for SPECIFIC scope
  useEffect(() => {
    if (!modalOpen || draftEffect !== 'ALLOW' || draftScope !== 'SPECIFIC') return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setProductLoading(true);
      setProductsError(null);
      try {
        const res = await fetch(`/api/products?q=${encodeURIComponent(productQuery)}&limit=20`);
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        setProductResults(
          (data.products ?? []).map((p: any) => ({ id: p.id, name: p.name, sku: p.sku }))
        );
      } catch {
        setProductsError(ar ? 'تعذر البحث في المنتجات' : 'Product search failed');
      } finally {
        setProductLoading(false);
      }
    }, PRODUCT_SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [productQuery, modalOpen, draftEffect, draftScope, ar]);

  // The list that will be sent, and what it adds beside the one exception the person is making.
  const plan = useMemo(
    () =>
      draftKey
        ? planOverride({
            baseKeys,
            others: storedRows,
            draft: { key: draftKey, effect: draftEffect, scope: draftScope, scopeIds: draftScopeIds },
            canGrant,
          })
        : null,
    [draftKey, draftEffect, draftScope, draftScopeIds, baseKeys, storedRows, canGrant],
  );

  async function saveOverride() {
    if (!payload) return;
    if (!draftKey) {
      setModalError(ar ? 'اختر صلاحية أولًا' : 'Pick a permission first');
      return;
    }
    if (draftEffect === 'ALLOW' && (draftScope === 'CATEGORY' || draftScope === 'SPECIFIC') && draftScopeIds.length === 0) {
      setModalError(
        draftScope === 'CATEGORY'
          ? (ar ? 'اختر تصنيفًا واحدًا على الأقل' : 'Pick at least one category')
          : (ar ? 'اختر منتجًا واحدًا على الأقل' : 'Pick at least one product')
      );
      return;
    }
    setSaving(true);
    setModalError(null);
    try {
      // Full replacement payload: every other override + this one + what this one pulls with it (the plan),
      // over the version the page was read at — a list that is out of date is refused with 409.
      if (!plan || plan.blocked) return;
      const res = await fetch(`/api/users/${userId}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: plan.list, version: payload.permissionsVersion }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        // Changed since this page was read: read it again, so the next try carries the current version.
        if (res.status === 409) await loadPerms();
        throw new Error(d.error || (ar ? 'فشل حفظ الاستثناءات' : 'Failed to save overrides'));
      }
      setModalOpen(false);
      showFlash(plan.notes.length ? `تم حفظ الاستثناءات — ${plan.notes.join(' ')}` : 'تم حفظ الاستثناءات بنجاح');
      await loadPerms();
    } catch (e: any) {
      setModalError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeOverride(permission: string) {
    // Taking this one away must not leave an action without its screen key: say so, and change nothing.
    const block = removalBlock({ baseKeys, rows: storedRows, removing: permission });
    if (block) {
      setRemoveNotice(block);
      return;
    }
    setRemoveNotice(null);
    setRemoving(permission);
    try {
      const res = await fetch(`/api/users/${userId}/permissions/${encodeURIComponent(permission)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || (ar ? 'فشل إزالة الاستثناء' : 'Failed to remove override'));
      }
      showFlash(ar ? 'تم إزالة الاستثناء' : 'Override removed');
      await loadPerms();
    } catch (e: any) {
      setLoadError(e.message);
    } finally {
      setRemoving(null);
    }
  }

  const effectiveCount = payload ? Object.keys(payload.effective.grants).length : 0;
  const overrideCount = payload?.overrides.length ?? 0;
  const draftIsEdit = overridesMap.has(draftKey);

  return (
    <>
      {/* Card 1 — Effective permissions */}
      <Card>
        <CardContent className="p-5">
          <h3 className="text-xs font-black text-[var(--sys-foreground)] mb-3 flex items-center gap-1.5">
            <RiShieldCheckLine className="w-4 h-4" />
            {ar ? 'الصلاحيات الفعّالة' : 'Effective Permissions'}
          </h3>

          {loadError && (
            <div className="rounded-lg bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-xs font-medium px-3 py-2 mb-3 flex items-center justify-between gap-2">
              <span>{loadError}</span>
              <Button variant="outline" size="sm" onClick={loadPerms}>
                {ar ? 'إعادة المحاولة' : 'Retry'}
              </Button>
            </div>
          )}

          {!payload && !loadError && (
            <p className="text-xs text-[var(--sys-muted)] py-3">{ar ? 'جارِ التحميل…' : 'Loading…'}</p>
          )}

          {payload && (
            <>
              {/* Summary line */}
              <div className="rounded-lg bg-[var(--sys-surface)] px-3 py-2.5 text-xs text-[var(--sys-foreground)] mb-3 flex flex-wrap gap-x-3 gap-y-1">
                <span className="font-bold text-[var(--sys-heading)]">
                  {ar ? `الدور: ${payload.role.name}` : `Role: ${payload.role.name}`}
                </span>
                <span>
                  •{' '}
                  {isFullAccess
                    ? (ar ? 'وصول كامل (كل الصلاحيات)' : 'Full access (all permissions)')
                    : (ar ? `${effectiveCount} صلاحية فعّالة` : `${effectiveCount} effective permissions`)}
                </span>
                <span>• {ar ? `${overrideCount} استثناء` : `${overrideCount} overrides`}</span>
              </div>

              {isFullAccess ? (
                <p className="text-xs text-[var(--sys-muted-foreground)]">
                  {ar
                    ? 'حساب SUPER_ADMIN — وصول كامل مركزيًا ولا يقبل استثناءات.'
                    : 'SUPER_ADMIN account — central full access; overrides do not apply.'}
                </p>
              ) : (
                <>
                  <div className="relative max-w-xs mb-3">
                    <RiSearchLine className="absolute top-1/2 -translate-y-1/2 start-2.5 w-4 h-4 text-[var(--sys-muted)]" />
                    <Input
                      value={tableSearch}
                      onChange={(e) => setTableSearch(e.target.value)}
                      placeholder={ar ? 'بحث في الصلاحيات…' : 'Search permissions…'}
                      className="ps-8 text-xs"
                    />
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-[var(--sys-border)]">
                                        <Rows
                      rows={filteredRows}
                      keyOf={(r) => r.key}
                      columns={[
                        { key: 'c0', label: ar ? 'الصلاحية' : 'Permission', primary: true,
                          render: (r) => (
                  <><p className="font-medium text-[var(--sys-heading)]">{ar ? r.ar : r.en}</p>
                              <p className="text-xs text-[var(--sys-muted)] font-mono" dir="ltr">{r.key}</p></>
                ) },
                        { key: 'c1', label: ar ? 'من الدور' : 'Role', primary: true,
                          render: (r) => (
                  <>{r.roleEffect ? (
                                <span className="font-bold text-[var(--sys-success)]">مسموح · من الدور</span>
                              ) : (
                                <span className="text-[var(--sys-muted)]">{ar ? 'غير ممنوح' : 'not granted'}</span>
                              )}</>
                ) },
                        { key: 'c2', label: ar ? 'الاستثناء' : 'Override',
                          render: (r) => (
                  <>{r.overrideEffect ? (
                                <span className={`font-bold ${r.overrideEffect === 'DENY' ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-success)]'}`}>
                                  {r.overrideEffect === 'DENY' ? 'منع' : 'منح'}
                                </span>
                              ) : (
                                <span className="text-[var(--sys-muted)]">—</span>
                              )}</>
                ) },
                        { key: 'c3', label: ar ? 'الفعّالة' : 'Effective',
                          render: (r) => (
                  <>{r.effectiveEffect === 'ALLOW' ? (
                                <span className="font-bold text-[var(--sys-success)]">مسموح</span>
                              ) : (
                                <span className="font-bold text-[var(--sys-destructive)]">
                                  ممنوع
                                </span>
                              )}</>
                ) },
                        { key: 'c4', label: ar ? 'النطاق' : 'Scope',
                          render: (r) => (r.scopeLabel ?? '—') },
                      ]}
                      empty={
                        <EmptyState
                          title="لا استثناءات على هذا الحساب"
                          why="الصلاحيات تأتي من الدور كما هي. الاستثناء يُضاف هنا حين يحتاج شخصٌ أكثرَ أو أقلَّ من دوره."
                        />
                      }
                    />
                  </div>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Card 2 — User overrides */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="text-xs font-black text-[var(--sys-foreground)] flex items-center gap-1.5">
              <RiKey2Line className="w-4 h-4" />
              {ar ? 'استثناءات المستخدم' : 'User Overrides'}
            </h3>
            {canEdit && !isFullAccess && (
              <Button size="sm" onClick={openAddModal}>
                <RiAddCircleLine className="w-4 h-4" />
                {ar ? 'إضافة استثناء' : 'Add override'}
              </Button>
            )}
          </div>

          {flash && (
            <div className="mb-3 rounded-lg bg-[var(--sys-success-soft)] border border-[var(--sys-success-soft)] text-[var(--sys-success)] text-xs font-medium px-3 py-2">
              {flash}
            </div>
          )}

          {removeNotice && (
            <div role="status" className="mb-3 rounded-lg bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)] text-[var(--sys-warning)] text-xs px-3 py-2">
              {removeNotice}
            </div>
          )}

          {payload && isFullAccess && (
            <p className="text-xs text-[var(--sys-muted-foreground)]">
              {ar ? 'لا توجد استثناءات — حساب SUPER_ADMIN وصول كامل.' : 'No overrides — SUPER_ADMIN has central full access.'}
            </p>
          )}

          {payload && !isFullAccess && (
            payload.overrides.length === 0 ? (
              <p className="text-xs text-[var(--sys-muted-foreground)]">
                {ar
                  ? 'لا توجد استثناءات — الصلاحيات تأتي من الدور كما هي.'
                  : 'No overrides — permissions come from the role as-is.'}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--sys-surface)] rounded-lg border border-[var(--sys-border)]">
                {payload.overrides.map((o) => {
                  const item = catalogItem(o.permission);
                  const scopeLabel = o.scope
                    ? (SCOPE_LABELS[o.scope as ScopeValue]?.[ar ? 'ar' : 'en'] ?? o.scope)
                    : null;
                  return (
                    <li key={o.permission} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[var(--sys-heading)] truncate">
                          {ar ? item?.ar ?? o.permission : item?.en ?? o.permission}
                        </p>
                        <p className="text-xs text-[var(--sys-muted)] font-mono" dir="ltr">{o.permission}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`text-xs font-bold rounded-lg px-2 py-0.5 border ${
                            o.effect === 'DENY'
                              ? 'text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)]'
                              : 'text-[var(--sys-success)] bg-[var(--sys-success-soft)] border-[var(--sys-success-soft)]'
                          }`}
                        >
                          {o.effect === 'DENY' ? 'منع' : 'منح'}
                        </span>
                        {o.effect === 'ALLOW' && scopeLabel && (
                          <span className="text-xs text-[var(--sys-muted-foreground)]">{scopeLabel}</span>
                        )}
                        {canEdit && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-[var(--sys-destructive)]"
                            loading={removing === o.permission}
                            onClick={() => removeOverride(o.permission)}
                          >
                            <RiDeleteBinLine className="w-4 h-4" />
                            {ar ? 'إزالة' : 'Remove'}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )
          )}
        </CardContent>
      </Card>

      {/* Add/edit override modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={draftIsEdit ? (ar ? 'تعديل استثناء قائم' : 'Edit existing override') : (ar ? 'إضافة استثناء' : 'Add Override')}
        subtitle={ar ? 'الاستثناء يخص هذا المستخدم فقط ويتجاوز صلاحيات الدور' : 'Overrides apply to this user only, on top of the role'}
        maxWidth="lg"
      >
        <div className="space-y-4">
          {/* What kind of exception — first, because the list below depends on it. Words, never colour alone. */}
          <div>
            <p className="block text-xs font-medium text-[var(--sys-heading)] mb-1.5">نوع الاستثناء</p>
            <div className="flex flex-wrap items-center gap-5">
              <label className="flex items-center gap-1.5 text-xs text-[var(--sys-heading)] cursor-pointer">
                <input
                  type="radio"
                  name="override-effect"
                  checked={draftEffect === 'ALLOW'}
                  onChange={() => setDraftEffect('ALLOW')}
                  className="w-3.5 h-3.5 accent-[var(--sys-success)] cursor-pointer"
                />
                منح — صلاحية زيادة عن دوره
              </label>
              <label className="flex items-center gap-1.5 text-xs text-[var(--sys-heading)] cursor-pointer">
                <input
                  type="radio"
                  name="override-effect"
                  checked={draftEffect === 'DENY'}
                  onChange={() => setDraftEffect('DENY')}
                  className="w-3.5 h-3.5 accent-[var(--sys-destructive)] cursor-pointer"
                />
                منع — يحجبها حتى لو دوره بيسمح
              </label>
              {/* Advanced toggle — scopes stay hidden for ordinary permission changes */}
              <label className="flex items-center gap-1.5 text-xs text-[var(--sys-muted-foreground)] cursor-pointer ms-auto">
                <input
                  type="checkbox"
                  checked={advancedScopes}
                  onChange={(e) => {
                    setAdvancedScopes(e.target.checked);
                    if (!e.target.checked) onDraftScopeChange('ALL_COMPANY');
                  }}
                  className="w-3.5 h-3.5 accent-[var(--sys-primary)] cursor-pointer"
                />
                {ar ? 'تخصيص نطاق الوصول' : 'Customize access scope'}
              </label>
            </div>
          </div>

          {/*
            THE PERMISSION, FOUND BY SEARCHING — «إضافة بحث… لأني بتوه».
            Ninety keys in one dropdown was a list to get lost in. Now a search box, and a list built for the
            chosen kind: «منح» offers only what the role does NOT already give (granting what he has is nothing),
            «منع» offers only what he HAS (blocking what he lacks is nothing). An existing exception stays findable.
          */}
          <PermissionPicker
            effect={draftEffect}
            query={pickQuery}
            onQuery={setPickQuery}
            selected={draftKey}
            onPick={onDraftKeyChange}
            has={(key) => Boolean(payload?.effective.fullAccess || payload?.effective.grants[key] || payload?.roleGrants[key])}
            fromRole={(key) => Boolean(payload?.roleGrants[key])}
            hasOverride={(key) => overridesMap.has(key)}
          />

          {/* What the chosen key is, and what choosing it brings with it — said BEFORE the press */}
          {draftKey && catalogItem(draftKey)?.note && (
            <p className="text-xs text-[var(--sys-muted)]">{catalogItem(draftKey)?.note}</p>
          )}
          {plan && plan.notes.length > 0 && (
            <div role="status" className="space-y-0.5">
              {plan.notes.map((n) => (
                <p key={n} className="text-xs text-[var(--sys-warning)]">{n}</p>
              ))}
            </div>
          )}
          {plan?.blocked && <p role="alert" className="text-xs text-[var(--sys-destructive)]">{plan.blocked}</p>}

          {/* Scope — only meaningful for ALLOW (DENY blocks regardless of scope);
              hidden behind the advanced toggle for ordinary permission changes */}
          {draftEffect === 'ALLOW' && advancedScopes && (
            <>
              <Select
                label={ar ? 'النطاق' : 'Scope'}
                value={draftScope}
                onChange={(e) => onDraftScopeChange(e.target.value as ScopeValue)}
                options={(catalogItem(draftKey)?.scopes ?? ['ALL_COMPANY']).map((s) => ({
                  value: s,
                  label: ar ? SCOPE_LABELS[s].ar : SCOPE_LABELS[s].en,
                }))}
              />

              {draftKey && draftScope === 'CATEGORY' && (
                <div className="rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] p-3">
                  {categoriesError && <p className="text-xs text-[var(--sys-destructive)]">{categoriesError}</p>}
                  {!categoriesError && categories.length === 0 && (
                    <p className="text-xs text-[var(--sys-muted)]">لا تصنيفات منتجات بعد — وبلا تصنيف لا يمكن حصر هذا الموظف في جزء من الكتالوج. تُعرَّف من «المنتجات ← التصنيفات».</p>
                  )}
                  {categories.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                      {categories.map((c) => (
                        <label key={c.id} className="flex items-center gap-1.5 text-xs text-[var(--sys-heading)] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={draftScopeIds.includes(c.id)}
                            onChange={() => toggleScopeId(c.id)}
                            className="w-3.5 h-3.5 accent-[var(--sys-primary)] cursor-pointer"
                          />
                          {c.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {draftKey && draftScope === 'SPECIFIC' && (
                <div className="rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] p-3 space-y-2">
                  <div className="relative">
                    <RiSearchLine className="absolute top-1/2 -translate-y-1/2 start-2.5 w-4 h-4 text-[var(--sys-muted)]" />
                    <Input
                      value={productQuery}
                      onChange={(e) => setProductQuery(e.target.value)}
                      placeholder={ar ? 'ابحث عن منتج بالاسم أو SKU…' : 'Search products by name or SKU…'}
                      className="ps-8 text-xs"
                    />
                  </div>
                  {productLoading && <p className="text-xs text-[var(--sys-muted)]">{ar ? 'جارِ البحث…' : 'Searching…'}</p>}
                  {productsError && <p className="text-xs text-[var(--sys-destructive)]">{productsError}</p>}
                  {productResults.length > 0 && (
                    <div className="max-h-36 overflow-y-auto rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] divide-y divide-[var(--sys-surface)]">
                      {productResults.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          disabled={draftScopeIds.includes(p.id)}
                          onClick={() => toggleScopeId(p.id)}
                          className="w-full text-start px-3 py-2 text-xs text-[var(--sys-heading)] hover:bg-[var(--sys-surface)] cursor-pointer disabled:opacity-50"
                        >
                          {p.name}{' '}
                          <span className="text-xs text-[var(--sys-muted)] font-mono" dir="ltr">{p.sku}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {draftScopeIds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {draftScopeIds.map((id) => {
                        const prod = productResults.find((p) => p.id === id);
                        return (
                          <span
                            key={id}
                            className="inline-flex items-center gap-1 text-xs font-medium bg-[var(--sys-primary-soft)] text-[var(--sys-primary)] border border-[var(--sys-primary-soft)] rounded-md px-1.5 py-0.5"
                          >
                            {prod?.name ?? id}
                            <button type="button" onClick={() => toggleScopeId(id)} aria-label="أزل من النطاق" title="أزل من النطاق" className="cursor-pointer hover:text-[var(--sys-destructive)]">
                              <RiCloseLine className="w-4 h-4" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {modalError && <p className="text-xs text-[var(--sys-destructive)]">{modalError}</p>}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--sys-border)]">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              {ar ? 'إلغاء' : 'Cancel'}
            </Button>
            <Button onClick={saveOverride} loading={saving} disabled={!draftKey || !!plan?.blocked}>
              {ar ? 'حفظ' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}


/**
 * The permission list of the «إضافة استثناء» dialog: a search box over the catalog, grouped by section, showing only
 * what the chosen kind of exception can change for this person.
 */
export function PermissionPicker({
  effect,
  query,
  onQuery,
  selected,
  onPick,
  has,
  fromRole,
  hasOverride,
}: {
  effect: 'ALLOW' | 'DENY';
  query: string;
  onQuery: (q: string) => void;
  selected: string;
  onPick: (key: string) => void;
  /** Whether the person holds the key now (from the role or an exception). */
  has: (key: string) => boolean;
  /** Whether the role itself gives it. */
  fromRole: (key: string) => boolean;
  hasOverride: (key: string) => boolean;
}) {
  const q = query.trim().toLowerCase();
  const groups = PERMISSION_MODULES.map((m) => {
    const section = MODULE_LABELS[m.module]?.ar ?? m.module;
    const items = m.items.filter((i) => {
      // «منح»: what the role does not give. «منع»: what he holds. A key that already has an exception, or the one
      // being edited, stays in the list so it can be changed.
      const fits = effect === 'ALLOW' ? !fromRole(i.key) : has(i.key);
      if (!fits && !hasOverride(i.key) && i.key !== selected) return false;
      if (!q) return true;
      return i.ar.includes(query.trim()) || i.key.toLowerCase().includes(q) || section.includes(query.trim());
    });
    return { module: m.module, section, items };
  }).filter((g) => g.items.length > 0);
  const count = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div>
      <p className="block text-xs font-medium text-[var(--sys-heading)] mb-1.5">الصلاحية</p>
      <Input
        aria-label="ابحث عن صلاحية"
        placeholder="ابحث بالاسم أو بالقسم — مثلاً: الشحن، المرتجعات، الرواتب"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <p className="mt-1 text-xs text-[var(--sys-muted)]">
        {effect === 'ALLOW'
          ? `${count} صلاحية مش بدوره — اختار اللي بدك تمنحه إياها`
          : `${count} صلاحية عنده — اختار اللي بدك تمنعها عنه`}
      </p>
      <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-[var(--sys-border)]" role="listbox" aria-label="الصلاحيات">
        {groups.length === 0 ? (
          <p className="p-3 text-xs text-[var(--sys-muted)]">ما في صلاحية بهالاسم.</p>
        ) : (
          groups.map((g) => (
            <div key={g.module}>
              <p className="sticky top-0 bg-[var(--sys-surface)] px-3 py-1 text-xs font-semibold text-[var(--sys-muted-foreground)]">{g.section}</p>
              {g.items.map((i) => (
                <button
                  key={i.key}
                  type="button"
                  role="option"
                  aria-selected={selected === i.key}
                  onClick={() => onPick(i.key)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-xs ${
                    selected === i.key ? 'bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]' : 'text-[var(--sys-heading)] hover:bg-[var(--sys-surface)]'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block font-medium">{i.ar}</span>
                    <span className="block font-mono text-[var(--sys-muted)]" dir="ltr">{i.key}</span>
                  </span>
                  {hasOverride(i.key) && <span className="shrink-0 text-[var(--sys-muted-foreground)]">عنده استثناء</span>}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
