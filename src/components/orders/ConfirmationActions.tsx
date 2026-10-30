'use client';

/**
 * SALESFLOW — Phase D1: Confirmation quick actions + customer contact history.
 * Quick actions open a controlled form when the server requires extra data.
 * All authorization/workflow validation is backend-enforced.
 */

import { useState, useEffect } from 'react';
import { DismissButton } from '@/components/ui/DismissButton';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input, Textarea, Select } from '@/components/ui/Input';
import { apiFetch } from '@/lib/api-client';
import { useIsPhone } from '@/hooks/useIsPhone';
import { CONFIRMATION_STATUS_AR, PICKABLE_REJECTION_REASONS, REJECTION_REASON_AR } from '@/lib/confirmation-workflow';
import { arDateShort, arDateTime } from '@/lib/format';
import { RiCalendarScheduleLine, RiCheckLine, RiCloseCircleLine, RiPhoneLine, RiPhoneLockLine, RiRefreshLine, RiTimerLine } from '@remixicon/react';

// The list and its words live with the rule, in `confirmation-workflow`. A
// copy here held eight while that held ten, so a stored reason this screen
// had never heard of rendered as a raw English constant.
const REASON_OPTIONS = PICKABLE_REJECTION_REASONS.map((key) => ({
  key,
  ar: REJECTION_REASON_AR[key] ?? key,
}));

const RESULTS: Record<string, { ar: string; en: string }> = {
  ANSWERED: { ar: 'أجاب', en: 'Answered' },
  NO_ANSWER: { ar: 'لا يرد', en: 'No Answer' },
  BUSY: { ar: 'مشغول', en: 'Busy' },
  WRONG_NUMBER: { ar: 'رقم خاطئ', en: 'Wrong Number' },
  CALLBACK_REQUESTED: { ar: 'طلب الاتصال به', en: 'Callback Requested' },
  CONFIRMED: { ar: 'مؤكد', en: 'Confirmed' },
  REJECTED: { ar: 'مرفوض', en: 'Rejected' },
  OTHER: { ar: 'أخرى', en: 'Other' },
};

const WORKFLOW_STATE: Record<string, { ar: string; en: string; cls: string }> = {
  NEW: { ar: CONFIRMATION_STATUS_AR.NEW, en: 'New', cls: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-muted-foreground)]/50' },
  IN_PROGRESS: { ar: CONFIRMATION_STATUS_AR.IN_PROGRESS, en: 'In Progress', cls: 'bg-[var(--sys-surface)] text-[var(--sys-foreground)] border-[var(--sys-border-strong)]' },
  NO_ANSWER: { ar: CONFIRMATION_STATUS_AR.NO_ANSWER, en: 'No Answer', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/60' },
  FOLLOW_UP_REQUIRED: { ar: CONFIRMATION_STATUS_AR.FOLLOW_UP_REQUIRED, en: 'Follow-Up Required', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/60' },
  POSTPONED: { ar: CONFIRMATION_STATUS_AR.POSTPONED, en: 'Postponed', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/60' },
  CONFIRMED: { ar: CONFIRMATION_STATUS_AR.CONFIRMED, en: 'Confirmed', cls: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/60' },
  REJECTED: { ar: CONFIRMATION_STATUS_AR.REJECTED, en: 'Rejected', cls: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]' },
  CANCELLED: { ar: CONFIRMATION_STATUS_AR.CANCELLED, en: 'Cancelled', cls: 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)] border-[var(--sys-border-strong)]' },
};

const METHOD_LABELS: Record<string, { ar: string; en: string }> = {
  PHONE: { ar: 'هاتف', en: 'Phone' },
  WHATSAPP: { ar: 'واتساب', en: 'WhatsApp' },
  SMS: { ar: 'رسالة', en: 'SMS' },
  OTHER: { ar: 'أخرى', en: 'Other' },
};

interface ConfirmationActionsProps {
  order: any;
  ar: boolean;
  isRtl: boolean;
  onRefreshOrder: () => void | Promise<void>;
}

export function ConfirmationActions({ order, ar, isRtl, onRefreshOrder }: ConfirmationActionsProps) {
  /* A phone groups the seven quick buttons by what they are; a desk keeps the one wrapping row. */
  const phone = useIsPhone();
  const [attempts, setAttempts] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loadingAttempts, setLoadingAttempts] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Quick-action form state
  const [openForm, setOpenForm] = useState<string | null>(null); // 'confirm' | 'reject' | 'followup' | 'call_later'
  const [note, setNote] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');

  const loadAttempts = async () => {
    if (!order?.id) return;
    setLoadingAttempts(true);
    try {
      const res = await apiFetch(`/api/orders/${order.id}/contact-attempts`);
      if (res.ok) {
        const data = await res.json();
        setAttempts(data.attempts || []);
        setSummary(data.summary || null);
      }
      } catch (e) {
      console.error(e);
    } finally {
      setLoadingAttempts(false);
    }
  };

  useEffect(() => {
    setFeedback(null);
    loadAttempts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  /** Core submit: record attempt (always) + workflow transition (when provided) */
  const submitAction = async (payload: {
    action?: string; result?: string; contactMethod?: string; note?: string;
    nextFollowUpAt?: string; followUpReason?: string;
    rejectionReason?: string; rejectionNote?: string;
  }) => {
    if (!order?.id) return false;
    setActionLoading(true);
    setFeedback(null);
    try {
      // 1. Contact attempt (append-only history) — recorded for every action
      const attRes = await apiFetch(`/api/orders/${order.id}/contact-attempts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactMethod: payload.contactMethod || 'PHONE',
          result: payload.result || 'OTHER',
          note: payload.note,
          nextFollowUpAt: payload.nextFollowUpAt,
        }),
      });
      if (!attRes.ok) {
        const d = await attRes.json().catch(() => ({}));
        setFeedback({ type: 'error', text: d.errorAr || d.error || (ar ? 'فشل تسجيل المحاولة' : 'Failed to record attempt') });
        return false;
      }

      // 2. Workflow transition (only when the action changes confirmation state)
      if (payload.action && payload.action !== 'attempt_only') {
        const confRes = await apiFetch(`/api/orders/${order.id}/confirmation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: payload.action,
            result: payload.result,
            note: payload.note,
            nextFollowUpAt: payload.nextFollowUpAt,
            rejectionReason: payload.rejectionReason,
            rejectionNote: payload.rejectionNote,
            expectedVersion: order.version,
          }),
        });
        const confData = await confRes.json().catch(() => ({}));
        if (!confRes.ok) {
          // The contact attempt WAS recorded but the transition failed —
          // warn clearly and keep the modal open with the form values intact
          const errText = confData.errorAr || confData.error || (ar ? 'رفض الإجراء' : 'Action rejected');
          setFeedback({
            type: 'error',
            text: ar
              ? `تم تسجيل محاولة الاتصال لكن فشل تحديث حالة الطلب: ${errText}`
              : `Contact attempt recorded but the order status update failed: ${errText}`,
          });
          return false;
        }
      }

      setFeedback({ type: 'success', text: ar ? 'تم تسجيل الإجراء بنجاح' : 'Action recorded successfully' });
      setNote(''); setRejectionReason(''); setFollowUpDate('');
      await loadAttempts();
      await onRefreshOrder();
      return true;
    } finally {
      setActionLoading(false);
    }
  };

  const wf = WORKFLOW_STATE[order?.confirmationStatus] ?? WORKFLOW_STATE.NEW;
  const terminal = ['CONFIRMED', 'REJECTED', 'CANCELLED'].includes(order?.confirmationStatus);
  const busy = actionLoading || loadingAttempts;

  const handleQuickSubmit = async () => {
    if (!openForm) return;
    let ok = false;
    if (openForm === 'confirm') {
      ok = await submitAction({ action: 'confirm', result: 'CONFIRMED', note });
    } else if (openForm === 'reject') {
      ok = await submitAction({ action: 'reject', result: 'REJECTED', rejectionReason, note, rejectionNote: note });
    } else {
      ok = await submitAction({
        action: 'schedule_follow_up',
        result: openForm === 'call_later' ? 'CALLBACK_REQUESTED' : 'OTHER',
        note,
        nextFollowUpAt: followUpDate ? new Date(followUpDate).toISOString() : undefined,
      });
    }
    if (ok) setOpenForm(null);
  };

  /*
   * THE SEVEN QUICK BUTTONS, DRAWN ONCE, PLACED BY THE WIDTH.
   *
   * `grow` on a phone: a button takes the rest of its row instead of leaving a ragged edge, and the
   * full-width confirmation takes the whole of one.
   */
  const spread = phone ? 'grow justify-center ' : '';
  const answeredButton = (
    <button
      onClick={() => submitAction({ action: 'contact_result', result: 'ANSWERED' })}
      disabled={busy}
      className={`${spread}min-h-11 md:min-h-0 inline-flex items-center inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border-2 border-[var(--sys-muted-foreground)]/50 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)] transition-colors cursor-pointer disabled:opacity-50`}
    >
      <RiPhoneLine className="w-4 h-4" />{ar ? 'العميل أجاب' : 'Answered'}
    </button>
  );
  const noAnswerButton = (
    <button
      onClick={() => submitAction({ action: 'contact_result', result: 'NO_ANSWER' })}
      disabled={busy}
      className={`${spread}min-h-11 md:min-h-0 inline-flex items-center inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border-2 border-[var(--sys-warning)]/60 text-[var(--sys-warning)] hover:bg-[var(--sys-warning-soft)] transition-colors cursor-pointer disabled:opacity-50`}
    >
      <RiPhoneLockLine className="w-4 h-4" />{ar ? 'لا يرد' : 'No Answer'}
    </button>
  );
  const callLaterButton = (
    <button
      onClick={() => { setNote(''); setOpenForm('call_later'); }}
      disabled={busy}
      className={`${spread}min-h-11 md:min-h-0 inline-flex items-center inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border-2 border-[var(--sys-border-strong)] text-[var(--sys-foreground)] hover:bg-[var(--sys-surface)] transition-colors cursor-pointer disabled:opacity-50`}
    >
      <RiTimerLine className="w-4 h-4" />{ar ? 'تأجيل' : 'Call Later'}
    </button>
  );
  const followUpButton = (
    <button
      onClick={() => { setNote(''); setOpenForm('followup'); }}
      disabled={busy}
      className={`${spread}min-h-11 md:min-h-0 inline-flex items-center inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border-2 border-[var(--sys-warning)]/60 text-[var(--sys-warning)] hover:bg-[var(--sys-warning-soft)] transition-colors cursor-pointer disabled:opacity-50`}
    >
      <RiRefreshLine className="w-4 h-4" />{ar ? 'متابعة' : 'Follow Up'}
    </button>
  );
  const confirmButton = (
    <button
      onClick={() => { setNote(''); setOpenForm('confirm'); }}
      disabled={busy}
      className={`${phone ? 'w-full justify-center ' : ''}min-h-11 md:min-h-0 inline-flex items-center inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border-2 border-[var(--sys-success)]/60 text-[var(--sys-success)] hover:bg-[var(--sys-success-soft)] transition-colors cursor-pointer disabled:opacity-50`}
    >
      <RiCheckLine className="w-4 h-4" />{ar ? 'تأكيد الطلب' : 'Confirm Order'}
    </button>
  );
  const rejectButton = (
    <button
      onClick={() => { setNote(''); setRejectionReason(''); setOpenForm('reject'); }}
      disabled={busy}
      className={`${spread}min-h-11 md:min-h-0 inline-flex items-center inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border-2 border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] hover:bg-[var(--sys-destructive-soft)] transition-colors cursor-pointer disabled:opacity-50`}
    >
      <RiCloseCircleLine className="w-4 h-4" />{ar ? 'العميل رفض' : 'Rejected'}
    </button>
  );
  const wrongNumberButton = (
    <button
      onClick={() => submitAction({ action: 'contact_result', result: 'WRONG_NUMBER' })}
      disabled={busy}
      className={`${spread}min-h-11 md:min-h-0 inline-flex items-center inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border-2 border-[var(--sys-border-strong)] text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)] transition-colors cursor-pointer disabled:opacity-50`}
    >
      <RiPhoneLockLine className="w-4 h-4" />{ar ? 'رقم خاطئ' : 'Wrong Number'}
    </button>
  );

  return (
    <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 shadow-raised" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h4 className="text-xs font-black text-[var(--sys-foreground)] flex items-center gap-2">
          <RiPhoneLine className="w-4 h-4 text-[var(--sys-primary)]" />
          {ar ? 'تسجيل نتيجة الاتصال' : 'Record a call outcome'}
        </h4>
        <div className={phone ? 'flex flex-wrap items-center gap-2' : 'flex items-center gap-2'}>
          {summary?.total > 0 && (
            <span className="text-xs font-bold text-[var(--sys-muted-foreground)] bg-[var(--sys-surface-strong)] rounded-lg px-2 py-1">
              {ar ? `محاولات: ${summary.total}` : `Attempts: ${summary.total}`}
            </span>
          )}
          {order.nextFollowUpAt && order.followUpStatus !== 'COMPLETED' && order.followUpStatus !== 'CANCELLED' && (
            <span className="text-xs font-bold text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg px-2 py-1 inline-flex items-center gap-1">
              <RiCalendarScheduleLine className="w-4 h-4" />
              {ar ? 'متابعة:' : 'Follow-up:'} {arDateShort(order.nextFollowUpAt)}
            </span>
          )}
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border-2 text-xs font-bold ${wf.cls}`}>
            {ar ? wf.ar : wf.en}
          </span>
        </div>
      </div>

      {/* Quick actions */}
      {!terminal && (
        <div className={phone ? 'mb-4 space-y-3' : 'flex flex-wrap gap-2 mb-4'}>
          {/*
            A PHONE: THE OUTCOME FIRST AND ALONE, THE CALL RESULTS TOGETHER (ORD-11).

            Seven outlined buttons of one weight wrapped into four rows, with «تأكيد الطلب» — what most calls end in —
            fifth, looking like «رقم خاطئ». Now «تأكيد الطلب» is the first thing and the width of the card; the three
            results of the call (answered, no answer, wrong number) sit together in a row that SAYS what it is, and the
            three that decide what happens next (later, follow up, refuse) sit together under it. The same seven
            buttons, the same handlers; nothing is added and nothing is asked twice.
          */}
          {phone ? (
            <>
              {confirmButton}
              <div>
                <p className="mb-1.5 text-xs text-[var(--sys-muted)]">{ar ? 'نتيجة الاتصال' : 'Call result'}</p>
                <div className="flex flex-wrap gap-2">
                  {answeredButton}
                  {noAnswerButton}
                  {wrongNumberButton}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {callLaterButton}
                {followUpButton}
                {rejectButton}
              </div>
            </>
          ) : (
            <>
              {answeredButton}
              {noAnswerButton}
              {callLaterButton}
              {followUpButton}
              {confirmButton}
              {rejectButton}
              {wrongNumberButton}
            </>
          )}
        </div>
      )}

      {/* Feedback banner */}
      {feedback && (
        <div
          className={`mb-3 rounded-lg border p-2.5 text-xs flex items-center justify-between gap-2 ${
            feedback.type === 'success'
              ? 'border-[var(--sys-success)]/60 bg-[var(--sys-success-soft)] text-[var(--sys-success)]'
              : 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]'
          }`}
        >
          <span className="leading-relaxed">{feedback.text}</span>
          <DismissButton onClick={() => setFeedback(null)} />
        </div>
      )}

      {/* Quick-action form modal */}
      <Modal isOpen={!!openForm} onClose={() => setOpenForm(null)} title={formTitle()} maxWidth="md">
        <div className="space-y-3" dir={isRtl ? 'rtl' : 'ltr'}>
          {openForm === 'confirm' && (
            <>
              <p className="text-xs text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/40 rounded-lg p-2.5">
                {ar
                  ? 'سيتم تسجيل تأكيد العميل للطلب ونقله لمرحلة ما بعد التأكيد.'
                  : 'The order will be confirmed and prepared for the next operational stage.'}
              </p>
              <Textarea label={ar ? 'ملاحظة تأكيد (اختياري)' : 'Confirmation note (optional)'} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </>
          )}

          {openForm === 'reject' && (
            <>
              <Select label={ar ? 'سبب الرفض *' : 'Rejection Reason *'} value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)}>
                <option value="">— {ar ? 'اختر السبب' : 'Select reason'} —</option>
                {REASON_OPTIONS.map((r) => (
                  <option key={r.key} value={r.key}>{r.ar}</option>
                ))}
              </Select>
              <Textarea
                label={rejectionReason === 'OTHER' ? `${ar ? 'ملاحظة (إلزامية للسبب: أخرى)' : 'Note (required for Other)'} *` : ar ? 'ملاحظة إضافية' : 'Additional note'}
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </>
          )}

          {(openForm === 'followup' || openForm === 'call_later') && (
            <>
              <p className="text-xs text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg p-2.5">
                {ar ? 'تحديد موعد المتابعة إلزامي لهذا الإجراء.' : 'A next follow-up date is required for this action.'}
              </p>
              <Input label={ar ? 'موعد المتابعة *' : 'Next Follow-Up *'} type="datetime-local" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
              <Textarea label={ar ? 'ملاحظة المتابعة' : 'Follow-up note'} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => setOpenForm(null)}>
              {ar ? 'إلغاء' : 'Cancel'}
            </Button>
            <Button size="sm" loading={actionLoading} onClick={handleQuickSubmit} disabled={formDisabled()}>
              {ar ? 'تأكيد' : 'Submit'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );

  function formTitle() {
    if (!openForm) return '';
    const map: Record<string, { ar: string; en: string }> = {
      confirm: { ar: 'تأكيد الطلب', en: 'Confirm Order' },
      reject: { ar: 'رفض الطلب', en: 'Reject Order' },
      followup: { ar: 'جدولة متابعة', en: 'Schedule Follow-Up' },
      call_later: { ar: 'الاتصال لاحقاً', en: 'Call Later' },
    };
    const t = map[openForm];
    return t ? (ar ? t.ar : t.en) : '';
  }

  function formDisabled(): boolean {
    if (openForm === 'reject') return !rejectionReason || (rejectionReason === 'OTHER' && (!note || note.trim().length < 5));
    if (openForm === 'followup' || openForm === 'call_later') return !followUpDate;
    return false;
  }
}
