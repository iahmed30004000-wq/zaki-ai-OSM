'use client';

import React, { useCallback, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { useOrderPatch } from '@/components/orders/useOrderPatch';
import { useRegions } from '@/hooks/useRegions';
import { arDateTime } from '@/lib/format';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiAlertLine, RiForbidLine, RiLoader4Line, RiPencilLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { OrderLink } from '@/components/orders/OrderLink';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';

/**
 * /confirmation/issues — entry issues on moderator-entered orders only.
 *
 * The agent who found the problem already named it: wrong phone, wrong
 * address, missing data. So this screen opens the very fields that reason
 * points at, pre-filled with what is currently wrong, and the moderator
 * edits them. It used to ask "ماذا تم تصحيحه؟" in a browser prompt and
 * close the issue on whatever was typed — the wrong number stayed wrong and
 * came straight back to the same agent.
 *
 * The correction saves through the ordinary order edit, so it takes the same
 * validation (a Syrian store refuses a Jordanian number), the same duplicate
 * check and the same lost-update guard as any other edit. Only then is the
 * issue closed, and the note is written from what actually changed.
 */

interface Issue {
  id: string;
  reason: string;
  note: string | null;
  status: string;
  createdAt: string;
  order: {
    id: string;
    orderNumber: string;
    createdAt: string;
    source: string;
    version: number;
    quantity: number;
    regionId: string | null;
    region: { id: string; name: string } | null;
    product: { name: string } | null;
    confirmationStatus: string;
    customer: {
      id: string;
      fullName: string;
      phone: string;
      rawPhone: string | null;
      altPhone: string | null;
      city: string;
      address: string;
    };
    moderator: { id: string; name: string } | null;
  };
}

const REASON_LABEL: Record<string, string> = {
  WRONG_PHONE: 'رقم خاطئ',
  WRONG_ADDRESS: 'عنوان خاطئ',
  WRONG_PRODUCT: 'منتج خاطئ',
  MISSING_DATA: 'بيانات ناقصة',
  DUPLICATE: 'طلب مكرر',
  OTHER: 'أخرى',
};

/** Which field the agent was pointing at — it opens focused and marked. */
const REASON_FIELD: Record<string, keyof Draft | null> = {
  WRONG_PHONE: 'phone',
  WRONG_ADDRESS: 'address',
  MISSING_DATA: null,
  WRONG_PRODUCT: null,
  DUPLICATE: null,
  OTHER: null,
};

interface Draft {
  fullName: string;
  phone: string;
  regionId: string;
  address: string;
}

const FIELD_LABEL: Record<keyof Draft, string> = {
  fullName: 'اسم العميل',
  phone: 'رقم الهاتف',
  regionId: 'المحافظة',
  address: 'العنوان',
};

export function ConfirmationIssuesScreen() {
  const patchOrder = useOrderPatch();
  const toast = useToast();
  // «صحّح البيانات» is the correction's own box and the void is `orders.cancel` (PR-7): the list alone opens neither. The
  // correction saves the order FIRST and closes the issue second, so a button the close would refuse must not be there.
  const { currentUser } = useApp();
  const canCorrect = userCan(currentUser, 'confirmation.issues_correct');
  const canVoid = userCan(currentUser, 'orders.cancel');
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const { regions, countryName } = useRegions();

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ issues: Issue[] }>('/api/confirmation/issues');
      setIssues(res.issues);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  function openCorrection(issue: Issue) {
    setError(null);
    setVoiding(null);
    setEditing(issue.id);
    setDraft({
      fullName: issue.order.customer.fullName ?? '',
      phone: issue.order.customer.rawPhone || issue.order.customer.phone || '',
      regionId: issue.order.regionId ?? '',
      address: issue.order.customer.address ?? '',
    });
  }

  /** What the moderator actually changed, in words, for the order's history. */
  function changeSummary(issue: Issue, d: Draft): string[] {
    const before = {
      fullName: issue.order.customer.fullName ?? '',
      phone: issue.order.customer.rawPhone || issue.order.customer.phone || '',
      regionId: issue.order.regionId ?? '',
      address: issue.order.customer.address ?? '',
    };
    const nameOf = (id: string) => regions.find((r) => r.id === id)?.name ?? '—';
    const out: string[] = [];
    for (const key of Object.keys(before) as (keyof Draft)[]) {
      if (before[key] === d[key]) continue;
      const from = key === 'regionId' ? nameOf(before[key]) : before[key] || '—';
      const to = key === 'regionId' ? nameOf(d[key]) : d[key] || '—';
      out.push(`${FIELD_LABEL[key]}: ${from} ← ${to}`);
    }
    return out;
  }

  async function saveCorrection(issue: Issue) {
    if (!draft) return;
    const changes = changeSummary(issue, draft);
    if (changes.length === 0) {
      toast.failed('لم تُعدّل أي بيانات — صحّح ما أشار إليه موظف التأكيد أولاً.');
      return;
    }
    setBusy(issue.id);
    try {
      // 1. The correction itself, through the ordinary order edit: phone rule,
      //    duplicate check and version guard all apply here and nowhere else.
      const res = await patchOrder(issue.order.id, {
        expectedVersion: issue.order.version,
        customerName: draft.fullName,
        customerPhone: draft.phone,
        customerAddress: draft.address,
        regionId: draft.regionId || null,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.errorAr || data.error || 'تعذر حفظ التصحيح');
      }

      // 2. Only once the data is actually fixed does the issue close. If this
      //    fails the correction still stands and the issue stays visible —
      //    the safe direction to fail in.
      await apiJson(`/api/confirmation/issues/${issue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'correct', note: changes.join(' · ') }),
      });

      setEditing(null);
      setDraft(null);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر حفظ التصحيح');
    } finally {
      setBusy(null);
    }
  }

  async function confirmVoid(issue: Issue) {
    if (!voidReason.trim()) {
      toast.failed('سبب الإبطال مطلوب.');
      return;
    }
    setBusy(issue.id);
    try {
      await apiJson(`/api/confirmation/issues/${issue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'void', note: voidReason.trim() }),
      });
      setVoiding(null);
      setVoidReason('');
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الإبطال');
    } finally {
      setBusy(null);
    }
  }

  if (!issues) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  const inputClass =
    'w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-sm focus:outline-none focus:border-[var(--sys-primary)]';
  const flaggedClass =
    'w-full h-11 md:h-10 px-3 rounded-lg border-2 border-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] text-sm focus:outline-none';

  return (
    <div className="max-w-4xl space-y-3">
      <ScreenTitle />

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}

      {/*
          THE SHARED EMPTY STATE, WHICH ASKS FOR THE «WHY».
          This screen wrote its own paragraph and said only that the list was
          empty. Every sibling — the returns desk, the pull queue, the
          postponed list, the change requests — says what fills it, because
          `ui/EmptyState` takes `title` AND `why` and this was the one place
          that did not use it.
      */}
      {issues.length === 0 && (
        <EmptyState
          icon={RiAlertLine}
          title="لا إشكالات مفتوحة"
          why="الإشكالُ يُفتَح حين يعلق طلبٌ على موظّف التأكيد — رقمٌ خاطئ، عنوانٌ ناقص، أو سعرٌ يحتاج قراراً. فراغُ القائمة يعني أنّ لا طلبَ ينتظر قراراً من أحد."
        />
      )}

      {issues.map((issue) => {
        const flagged = REASON_FIELD[issue.reason] ?? null;
        const isEditing = editing === issue.id;
        const isVoiding = voiding === issue.id;

        return (
          <article key={issue.id} className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 space-y-2">
            <header className="flex flex-wrap items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] flex items-center justify-center">
                <RiAlertLine className="w-4 h-4 text-[var(--sys-destructive)]" />
              </span>
              <OrderLink id={issue.order.id} number={issue.order.orderNumber} className="font-semibold text-[var(--sys-heading)]" />
              <span className="text-xs px-2 py-0.5 rounded-md bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] font-medium">
                {REASON_LABEL[issue.reason] ?? issue.reason}
              </span>
              <span className="mr-auto text-xs text-[var(--sys-muted-foreground)]">
                المودريتور: {issue.order.moderator?.name ?? '—'}
              </span>
            </header>

            {!isEditing && (
              <>
                <p className="text-sm text-[var(--sys-foreground)]">
                  {issue.order.customer.fullName} ·{' '}
                  <span dir="ltr">{issue.order.customer.rawPhone || issue.order.customer.phone}</span> ·{' '}
                  {issue.order.region?.name ?? issue.order.customer.city}
                </p>
                <p className="text-xs text-[var(--sys-muted-foreground)]">{issue.order.customer.address}</p>
                {issue.order.product && (
                  <p className="text-xs text-[var(--sys-muted)]">
                    {issue.order.product.name} × {issue.order.quantity}
                  </p>
                )}
              </>
            )}

            {issue.note && (
              <p className="text-sm text-[var(--sys-heading)] bg-[var(--sys-surface)] rounded-lg p-2">
                <span className="text-[var(--sys-muted-foreground)]">ملاحظة موظف التأكيد: </span>
                {issue.note}
              </p>
            )}

            {isEditing && draft && (
              <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 space-y-3">
                <p className="text-xs text-[var(--sys-muted-foreground)]">
                  صحّح البيانات هنا — الحقل المؤشَّر بالأحمر هو ما أبلغ عنه موظف التأكيد.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block">
                    <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{FIELD_LABEL.fullName}</span>
                    <input
                      value={draft.fullName}
                      onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
                      className={flagged === 'fullName' ? flaggedClass : inputClass}
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{FIELD_LABEL.phone}</span>
                    <input
                      value={draft.phone}
                      onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                      dir="ltr"
                      autoFocus={flagged === 'phone'}
                      className={flagged === 'phone' ? flaggedClass : inputClass}
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">
                      {FIELD_LABEL.regionId}
                      {countryName ? ` — ${countryName}` : ''}
                    </span>
                    {/* NOT marked by an address complaint.
                        It carried `flagged === 'address'`, copied from the
                        field below, so one complaint lit up two fields —
                        and the agent had pointed at one. The mark means
                        "this is what she was looking at"; spreading it
                        across a second field is the fastest way to teach
                        somebody to ignore the mark. No reason maps to the
                        governorate (see REASON_FIELD), so it is never the
                        flagged field. */}
                    <select
                      value={draft.regionId}
                      onChange={(e) => setDraft({ ...draft, regionId: e.target.value })}
                      className={inputClass}
                    >
                      <option value="">— اختر المحافظة —</option>
                      {regions.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{FIELD_LABEL.address}</span>
                    <input
                      value={draft.address}
                      onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                      autoFocus={flagged === 'address'}
                      className={flagged === 'address' ? flaggedClass : inputClass}
                    />
                  </label>
                </div>

                {changeSummary(issue, draft).length > 0 && (
                  <div className="text-xs text-[var(--sys-foreground)] bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-2.5 space-y-0.5">
                    <p className="text-[var(--sys-muted-foreground)]">سيُسجَّل في الطلب:</p>
                    {changeSummary(issue, draft).map((line) => (
                      <p key={line} dir="rtl">• {line}</p>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => saveCorrection(issue)}
                    disabled={busy === issue.id}
                    className="min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium disabled:opacity-50"
                  >
                    {busy === issue.id ? 'جارٍ الحفظ…' : 'احفظ التصحيح وأعده للطابور'}
                  </button>
                  <button
                    onClick={() => { setEditing(null); setDraft(null); setError(null); }}
                    className="min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 rounded-lg border border-[var(--sys-border)] text-xs text-[var(--sys-muted-foreground)]"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            )}

            {isVoiding && (
              <div className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 space-y-2">
                <label className="block">
                  <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">سبب الإبطال</span>
                  <input
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    autoFocus
                    placeholder="طلب وهمي، مكرر…"
                    className={inputClass}
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => confirmVoid(issue)}
                    disabled={busy === issue.id}
                    className="min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 rounded-lg bg-[var(--sys-destructive)] text-[var(--sys-primary-foreground)] text-xs font-medium disabled:opacity-50"
                  >
                    تأكيد الإبطال
                  </button>
                  <button
                    onClick={() => { setVoiding(null); setVoidReason(''); setError(null); }}
                    className="min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 rounded-lg border border-[var(--sys-border)] text-xs text-[var(--sys-muted-foreground)]"
                  >
                    تراجع
                  </button>
                </div>
              </div>
            )}

            <p className="text-xs text-[var(--sys-muted)]">
              تاريخ إنشاء الطلب الأصلي:{' '}
              <span>{arDateTime(issue.order.createdAt)}</span> — لا يتغير بعد التصحيح.
            </p>

            {!isEditing && !isVoiding && (
              <footer className="flex gap-2 pt-2 border-t border-[var(--sys-border)]">
                {canCorrect && (
                <button
                  onClick={() => openCorrection(issue)}
                  className="min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium inline-flex items-center gap-1.5"
                >
                  <RiPencilLine className="w-4 h-4" />
                  صحّح البيانات
                </button>
                )}
                {canVoid && (
                <button
                  onClick={() => { setVoiding(issue.id); setVoidReason(''); setError(null); }}
                  className="min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 rounded-lg border border-[var(--sys-border)] text-xs text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)] inline-flex items-center gap-1.5"
                >
                  <RiForbidLine className="w-4 h-4" />
                  إبطال الطلب (المالك فقط)
                </button>
                )}
              </footer>
            )}
          </article>
        );
      })}
    </div>
  );
}
