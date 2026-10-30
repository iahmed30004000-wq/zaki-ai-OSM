'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select, Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { useApp } from '@/context/AppContext';
import { useCreateIntent } from '@/hooks/useCreateIntent';
import { arDate, arDateTime } from '@/lib/format';
import { userCan } from '@/lib/can';
import { apiJson } from '@/lib/api-client';
import { CreateUserModal } from './users/CreateUserModal';
import { useConfirm } from '@/components/ui/Confirm';
import { ASSIGNABLE_ROLES, ROLE_LABELS as ROLE_LABELS_AR, USER_STATUSES } from '@/types/auth';
import { findRoute, routeLabel } from '@/lib/route-registry';
import { RiArrowLeftSLine, RiArrowRightSLine, RiForbidLine, RiKey2Line, RiLogoutBoxLine, RiMedalLine, RiPlayCircleLine, RiRefreshLine, RiSearchLine, RiShieldCheckLine, RiShieldCrossLine, RiUserAddLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { HealthChip } from '@/components/ui/HealthChip';
import type { EmployeeGrade, RosterReadiness } from '@/lib/employee-grade';

/** One source for the Arabic role names — a screen with its own copy is how
 *  two of them ended up blank in the filter. */
const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(ROLE_LABELS_AR).map(([key, label]) => [key, label.ar])
);

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'قيد المراجعة',
  ACTIVE: 'نشط',
  SUSPENDED: 'موقوف',
  DISABLED: 'معطّل',
};

const PERIOD_AR: Record<string, string> = { WEEKLY: 'هذا الأسبوع', MONTHLY: 'هذا الشهر' };

/** What the grades route answers with, so the screen never guesses a shape. */
interface GradesData {
  window: { period: 'WEEKLY' | 'MONTHLY' };
  minSample: number;
  grades: EmployeeGrade[];
  readiness: RosterReadiness;
}

export function UsersScreen() {
  const { currentUser } = useApp();
  const [users, setUsers] = useState<any[]>([]);
  const [pagination, setPagination] = useState({ total: 0, page: 1, limit: 25, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * THE GRADE ARRIVES SEPARATELY, AND THE ROSTER DOES NOT WAIT FOR IT.
   *
   * Two reasons, both about not breaking a screen people already use.
   * Managing accounts and monitoring performance are different permissions,
   * so an admin who may approve a signup but not read anybody's numbers gets
   * this list exactly as it was — no column, no strip, no error. And the
   * quality half of the grade is a store-scoped scoring pass over the whole
   * role; folding it into `/api/users` would make every page of the employee
   * list wait on it, including for the readers who cannot see it.
   */
  const [gradeData, setGradeData] = useState<GradesData | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Create + manage modals
  const [createOpen, setCreateOpen] = useState(false);
  // «+ أنشئ» in Ctrl+K arrives as `?new=user` and opens the form «موظف جديد» opens — for whom that button is drawn for.
  useCreateIntent({ user: userCan(currentUser, 'users.create') ? () => setCreateOpen(true) : undefined });
  const confirm = useConfirm();
  const [manageUser, setManageUser] = useState<any>(null);
  /** Whether this viewer may act on the account being managed — the server's answer (canActOnUser). */
  const [manageReach, setManageReach] = useState<{ ok: boolean; why?: string } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  // Critical-action confirmation (suspend/disable/role change)
  const [pendingAction, setPendingAction] = useState<{ action: string; extra?: any; title: string; msg: string } | null>(null);

  /**
   * The grade for exactly the people on screen — never for a set the list is
   * not showing, or the number beside a name would belong to another row.
   */
  const loadGrades = useCallback(async (ids: string[]) => {
    setGradeData(null);
    if (ids.length === 0) return;
    try {
      const res = await fetch(`/api/users/grades?ids=${ids.join(',')}`);
      // A 403 here is the ordinary case for an account administrator without
      // `team.monitor`, not a failure worth a red box on the roster.
      if (!res.ok) return;
      setGradeData(await res.json());
    } catch {
      // Same reasoning: the names must render even when the grade cannot.
    }
  }, []);

  const loadUsers = useCallback(
    async (pageToLoad = 1) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          page: pageToLoad.toString(),
          q: search,
          role: roleFilter,
          status: statusFilter,
          from: fromDate,
          to: toDate,
        });
        const res = await fetch(`/api/users?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const list: any[] = data.users || [];
        setUsers(list);
        setPagination(data.pagination || { total: 0, page: 1, limit: 25, totalPages: 1 });
        void loadGrades(list.map((u) => u.id));
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [search, roleFilter, statusFilter, fromDate, toDate, loadGrades]
  );

  const gradeOf = (id: string): EmployeeGrade | undefined =>
    gradeData?.grades.find((g) => g.userId === id);

  useEffect(() => {
    const timer = setTimeout(() => loadUsers(1), 250);
    return () => clearTimeout(timer);
  }, [loadUsers]);

  const openManage = (u: any) => {
    setManageUser(u);
    setModalError(null);
    setPendingAction(null);
    setManageReach(null);
    // Asked when the panel opens, so a suspend or a sign-out this person may
    // not do is not offered, rather than refused after its confirmation.
    void apiJson<{ mayManage?: boolean; manageRefusal?: string }>(`/api/users/${u.id}/profile`)
      .then((p) => setManageReach({ ok: p.mayManage !== false, why: p.manageRefusal }))
      .catch(() => setManageReach(null));
  };

  /** Critical actions require explicit confirmation (Decision 7 safety) */
  const requestAction = (action: string, title: string, msg: string, extra: any = {}) => {
    setPendingAction({ action, extra, title, msg });
  };

  const confirmPendingAction = async () => {
    if (!pendingAction) return;
    await handleAction(pendingAction.action, pendingAction.extra);
    setPendingAction(null);
  };

  const handleAction = async (action: string, extra: any = {}) => {
    if (!manageUser) return;
    setActionLoading(true);
    setModalError(null);
    try {
      const res = await fetch(`/api/users/${manageUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setManageUser(null);
      loadUsers(pagination.page);
    } catch (err: any) {
      setModalError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const statusVariant = (s: string) =>
    s === 'ACTIVE' ? 'success' : s === 'PENDING' ? 'warning' : 'danger';

  return (
    <>
      <div className="space-y-6">
        <PageHeader title={routeLabel('/admin/users')}
            description="مراجعة طلبات التسجيل، تعيين الأدوار، تنشيط/إيقاف الحسابات — كل إجراء يُسجَّل في سجل التدقيق"
            actions={
              <><div className="flex items-center gap-2">
            {userCan(currentUser, 'users.create') && (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <RiUserAddLine className="w-4 h-4" />
                موظف جديد
              </Button>
            )}
            {/* The list does not refresh itself, so the refresh stays — drawn, not
                folded: a «متقدم» holding one icon button was a click for nothing. */}
            <Button variant="outline" size="sm" onClick={() => loadUsers(pagination.page)} className="p-2" aria-label="تحديث القائمة" title="تحديث">
              <RiRefreshLine className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div></>
            }
          />

        {error && (
          <div className="p-3 bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-xs rounded-lg">{error}</div>
        )}

        {/* Filters */}
        <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 shadow-raised grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="relative sm:col-span-2">
            <RiSearchLine className="absolute left-3 rtl:left-auto rtl:right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--sys-muted)]" />
            <input
              type="text"
              placeholder="بحث بالاسم أو البريد الإلكتروني..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-11 md:h-auto w-full pl-9 pr-4 rtl:pl-4 rtl:pr-9 md:py-2 text-xs bg-[var(--sys-surface)] border border-[var(--sys-border-input)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/30 focus:border-[var(--sys-primary)]"
            />
          </div>
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="text-xs py-2">
            <option value="all">كل الأدوار</option>
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]} ({r})
              </option>
            ))}
          </Select>
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="text-xs py-2">
            <option value="all">كل الحالات</option>
            {USER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          <div className="flex items-center space-x-2 rtl:space-x-reverse">
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="text-xs py-1.5" />
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="text-xs py-1.5" />
          </div>
        </div>

        {/*
          WHAT THE GRADE IS MADE OF, AND WHAT IS MISSING BEFORE IT SPEAKS.
          Measured on this record, the column can grade one person out of
          nineteen. A column that is blank on eighteen rows teaches a reader
          that the feature is broken — so the screen says out loud how many
          rows are blank and for which of five reasons, and names the bands the
          number would be built from. «6 حسابات بلا أثر» is six accounts to
          close or six people to train, which is worth more than one score.
        */}
        {gradeData && (
          <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-4 space-y-2">
            <div className="flex items-center gap-2">
              <RiMedalLine className="w-4 h-4 text-[var(--sys-primary)]" />
              <h3 className="text-xs font-bold text-[var(--sys-heading)]">
                التقدير: ممّا يُبنى، وما ينقص قبل أن ينطق
              </h3>
            </div>
            <p className="text-xs font-semibold text-[var(--sys-foreground)] leading-relaxed">
              {gradeData.readiness.why}
            </p>
            {gradeData.readiness.madeOf.length > 0 && (
              <p className="text-xs text-[var(--sys-muted-foreground)] leading-relaxed">
                يُبنى على: {gradeData.readiness.madeOf.join('، ')} — عن {PERIOD_AR[gradeData.window.period]} وفي
                المتجر المختار وحده، ولا يُعطى رقمٌ لمن عيّنتُه أقلّ من {gradeData.minSample} طلباً. الترتيب داخل
                الدور نفسه، لا بين الأدوار: البنودُ التي لا يقدر دورٌ على كسبها لا تُحسَب عليه صفراً.
              </p>
            )}
            <p className="text-xs text-[var(--sys-muted)] leading-relaxed">
              لا يُستدعى أيُّ نموذجٍ في هذا الرقم. كلُّ جملةٍ هنا قالبٌ حول عددٍ مقروءٍ من السجل، والرقمُ نفسه
              هو رقمُ بطاقةِ الأداء لا حساباً ثانياً له.
            </p>
          </div>
        )}

        {/* RiGroupLine Table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
                            <Rows
                rows={users}
                keyOf={(u) => u.id}
                columns={[
                  { key: 'c0', label: "المستخدم", primary: true,
                    render: (u) => (
                  <><p className="font-bold text-[var(--sys-heading)]">{u.name}</p>
                        <p className="text-xs text-[var(--sys-muted)]">{u.email}</p></>
                ) },
                  { key: 'c1', label: "الدور الحالي", primary: true,
                    render: (u) => (
                  <><Badge variant={u.role === 'PENDING_USER' ? 'warning' : u.role === 'SUPER_ADMIN' ? 'purple' : 'info'}>
                          {ROLE_LABELS[u.role] || u.role}
                        </Badge></>
                ) },
                  { key: 'c2', label: "حالة الحساب",
                    render: (u) => (
                  <><Badge variant={statusVariant(u.status) as any}>{STATUS_LABELS[u.status] || u.status}</Badge></>
                ) },
                  /*
                    THE CHIP IS NEVER ALONE. «مقيَّم» on its own is the opaque
                    figure this system refuses everywhere else; the sentence
                    under it carries the counted numbers so the reader can
                    check it by hand, and the presence line under THAT is a
                    second, independent fact — never added to the first.

                    The score is printed in the primary colour and given no
                    verdict colour of its own, exactly as `ScoreCard` prints
                    it: there is no owner-set bar for a composite out of
                    ninety, and colouring it would be this screen inventing
                    one.
                  */
                  { key: 'c7', label: "التقدير",
                    render: (u) => {
                      const g = gradeOf(u.id);
                      if (!g) return <span className="text-xs text-[var(--sys-muted)]">—</span>;
                      return (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <HealthChip health={{ tone: g.tone, label: g.label, why: g.why }} />
                            {g.scored && g.scored.total !== null && (
                              <span className="text-xs font-bold tabular-nums text-[var(--sys-primary)]">
                                {g.scored.total}
                                <span className="font-normal text-[var(--sys-muted-foreground)]"> / {g.scored.possible}</span>
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[var(--sys-muted-foreground)] leading-relaxed">{g.why}</p>
                          <p className={`text-xs leading-relaxed ${g.stale ? 'text-[var(--sys-warning)]' : 'text-[var(--sys-muted)]'}`}>
                            {g.presence}
                          </p>
                        </div>
                      );
                    } },
                  { key: 'c3', label: "تاريخ التسجيل",
                    render: (u) => arDate(u.createdAt) },
                  { key: 'c4', label: "آخر دخول",
                    render: (u) => arDateTime(u.lastLoginAt) },
                  /*
                     THE SECOND FACTOR, AT A GLANCE.

                     Every account carries one now, so the only question a
                     list can answer is whether the person has set it up
                     yet — and «بانتظار أوّل دخول» says the honest
                     thing: nothing is missing, it happens when they next
                     sign in. The date is read, never the secret.
                  */
                  { key: 'c2fa', label: "التحقّق بخطوتين",
                    render: (u) => (
                      <span className={`inline-flex items-center gap-1 text-xs font-semibold ${u.totpEnabledAt ? 'text-[var(--sys-success)]' : 'text-[var(--sys-muted-foreground)]'}`}>
                        {u.totpEnabledAt ? 'مفعّل' : 'بانتظار أوّل دخول'}
                      </span>
                    ) },
                  { key: 'c5', label: "عيّنه",
                    render: (u) => (u.assignedBy?.name || '—') },
                  { key: 'c6', label: "إجراءات", align: 'end',
                    render: (u) => (
                  <><div className="flex items-center gap-1.5 justify-end rtl:justify-start">
                          {/* Every act in the panel it opens (status, sign-out) asks «تعديل المستخدمين» — no button for who would only be refused. */}
                          {userCan(currentUser, 'users.edit') && (
                            <Button size="sm" variant="outline" onClick={() => openManage(u)} className="text-xs">
                              <RiShieldCheckLine className="w-4 h-4 ml-1 rtl:ml-0 rtl:mr-1" />
                              إدارة
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => (window.location.href = `/admin/users/${u.id}`)}
                            className="text-xs"
                            title="الدور والصلاحيات والوصول"
                          >
                            <RiKey2Line className="w-4 h-4 ml-1 rtl:ml-0 rtl:mr-1" />
                            صفحة الموظف
                          </Button>
                        </div></>
                ) },
                ]}
                empty={
                  <EmptyState
                    title="لا موظّف يطابق هذا البحث"
                    why="البحث يقرأ الاسم والبريد. امسحه أو وسّع الفلاتر لترى الحسابات كلّها."
                  />
                }
              />
            </div>

            <div className="px-6 py-3 border-t border-[var(--sys-border)] flex items-center justify-between text-xs text-[var(--sys-muted-foreground)]">
              <span>
                إجمالي <strong>{pagination.total}</strong> مستخدم
              </span>
              <div className="flex items-center space-x-2 rtl:space-x-reverse">
                <Button size="sm" variant="outline" disabled={pagination.page <= 1} onClick={() => loadUsers(pagination.page - 1)} className="p-1.5">
                  <RiArrowLeftSLine className="icon-mirror w-4 h-4" />
                </Button>
                <span className="font-medium">
                  صفحة {pagination.page} من {pagination.totalPages || 1}
                </span>
                <Button size="sm" variant="outline" disabled={pagination.page >= pagination.totalPages} onClick={() => loadUsers(pagination.page + 1)} className="p-1.5">
                  <RiArrowRightSLine className="icon-mirror w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <CreateUserModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (created) => {
          await loadUsers(1);
          if (!created) return;
          // The role gives the defaults; anything particular to this person
          // is set in the permissions editor that already exists — offered
          // here rather than rebuilt inside the creation form.
          const open = await confirm({
            title: `أُنشئ حساب «${created.name}»`,
            body: 'صلاحياته الآن هي صلاحيات دوره. تخصيصها لهذا الموظف تحديداً؟',
            confirmLabel: 'خصّص صلاحياته',
            cancelLabel: 'لاحقاً',
          });
          if (open) window.location.href = `/admin/users/${created.id}`;
        }}
      />

      {/* Manage User Modal */}
      <Modal
        isOpen={!!manageUser}
        onClose={() => setManageUser(null)}
        title={`إدارة حساب: ${manageUser?.name || ''}`}
        subtitle={manageUser?.email}
      >
        {manageUser && (
          <div className="space-y-5">
            {modalError && (
              <div className="p-3 bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-xs rounded-lg">{modalError}</div>
            )}

            {/* The role is changed in ONE place — the employee's page, where the
                permissions it carries and the stores it reaches are shown with
                it. A second editor here set the role's name and left its
                permissions on the old role. */}
            <a
              href={`/admin/users/${manageUser.id}`}
              className="flex items-center justify-between rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 text-xs font-semibold text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
            >
              <span>الدور الحالي: {ROLE_LABELS[manageUser.role] || manageUser.role}</span>
              <span>تغيير الدور والصلاحيات والوصول ←</span>
            </a>

            {manageReach && !manageReach.ok && (
              <p className="text-xs text-[var(--sys-muted-foreground)]">{manageReach.why}</p>
            )}

            {/* Status actions — only for an account this person may act on. */}
            {manageReach?.ok !== false && (
            <div className="border border-[var(--sys-border)] rounded-lg p-4 space-y-3 bg-[var(--sys-surface)]">
              <h4 className="text-xs font-bold text-[var(--sys-foreground)]">حالة الحساب</h4>
              <div className="flex flex-wrap gap-2">
                {manageUser.status === 'PENDING' && (
                  <Button size="sm" variant="success" loading={actionLoading} onClick={() => handleAction('changeStatus', { status: 'ACTIVE' })}>
                    <RiPlayCircleLine className="w-4 h-4 ml-1 rtl:ml-0 rtl:mr-1" />
                    اعتماد الحساب
                  </Button>
                )}
                {manageUser.status !== 'ACTIVE' && manageUser.status !== 'PENDING' && (
                  <Button size="sm" variant="success" loading={actionLoading} onClick={() => handleAction('changeStatus', { status: 'ACTIVE' })}>
                    <RiPlayCircleLine className="w-4 h-4 ml-1 rtl:ml-0 rtl:mr-1" />
                    تنشيط الحساب
                  </Button>
                )}
                {manageUser.status !== 'SUSPENDED' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={actionLoading}
                    onClick={() =>
                      requestAction(
                        'changeStatus',
                        'إيقاف المستخدم؟',
                        'سيفقد هذا الموظف وصوله الفوري للموارد المحمية في النظام. سيتم إنهاء جميع جلساته النشطة.',
                        { status: 'SUSPENDED' }
                      )
                    }
                  >
                    <RiShieldCrossLine className="w-4 h-4 ml-1 rtl:ml-0 rtl:mr-1" />
                    إيقاف مؤقت
                  </Button>
                )}
                {manageUser.status !== 'DISABLED' && (
                  <Button
                    size="sm"
                    variant="danger"
                    loading={actionLoading}
                    onClick={() =>
                      requestAction(
                        'changeStatus',
                        'تعطيل المستخدم؟',
                        'سيتم تعطيل الحساب نهائياً وإنهاء جميع جلساته فوراً.',
                        { status: 'DISABLED' }
                      )
                    }
                  >
                    <RiForbidLine className="w-4 h-4 ml-1 rtl:ml-0 rtl:mr-1" />
                    تعطيل
                  </Button>
                )}
                <Button size="sm" variant="outline" loading={actionLoading} onClick={() => handleAction('forceLogout')}>
                  <RiLogoutBoxLine className="icon-mirror w-4 h-4 ml-1 rtl:ml-0 rtl:mr-1" />
                  إنهاء كل الجلسات
                </Button>
              </div>
              <p className="text-xs text-[var(--sys-muted-foreground)]">
                إيقاف/تعطيل الحساب ينهي جميع الجلسات النشطة فوراً عبر إبطال التوكن الحالي.
              </p>
            </div>
            )}
          </div>
        )}
      </Modal>

      {/* Critical-action confirmation dialog */}
      <Modal
        isOpen={!!pendingAction}
        onClose={() => setPendingAction(null)}
        title={pendingAction?.title || ''}
        maxWidth="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--sys-foreground)] leading-relaxed">{pendingAction?.msg}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setPendingAction(null)}>
              إلغاء
            </Button>
            <Button
              size="sm"
              loading={actionLoading}
              onClick={confirmPendingAction}
              className={
                pendingAction?.action === 'changeStatus' && pendingAction.extra?.status === 'ACTIVE'
                  ? 'bg-[var(--sys-success)] hover:bg-[var(--sys-success)]/85'
                  : ''
              }
            >
              تأكيد
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
