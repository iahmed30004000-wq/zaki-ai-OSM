'use client';

/**
 * SALESFLOW — Phase D1: Confirmation quick actions + customer contact history.
 * Quick actions open a controlled form when the server requires extra data.
 * All authorization/workflow validation is backend-enforced.
 */

import { useState, useEffect, useRef } from 'react';
import { Card } from '@/components/ui/Card';
import { DismissButton } from '@/components/ui/DismissButton';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input, Textarea, Select } from '@/components/ui/Input';
import { apiFetch } from '@/lib/api-client';
import { useIsPhone } from '@/hooks/useIsPhone';
import { needsRegionFirst, REGION_REQUIRED_MESSAGE } from '@/lib/confirmation-queue';
import { CONFIRMATION_STATUS_AR, PICKABLE_REJECTION_REASONS, REJECTION_REASON_AR } from '@/lib/confirmation-workflow';
import { confirmAnywayBody, rejectAsDuplicateBody, twinsFromRefusal, type ConfirmedTwinView } from '@/lib/twin-refusal';
import { TwinConfirmedDialog } from '@/components/orders/TwinConfirmedDialog';
import { arDateShort, arDateTime } from '@/lib/format';
import { CALL_OPENED_EVENT } from '@/lib/contact-line';
import { CALL_PROOF_WORDS, secondsLeft, type CallProofState } from '@/lib/call-proof-words';
import { NO_ANSWER_NOT_A_POSTPONE_HINT } from '@/lib/postpone-reasons';
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

/** How often a panel stuck on NO_OPENED asks again — a press may have been made on another device. */
const PROOF_POLL_MS = 12_000;

/** What the server said about her «لا يرد» on this order, with the moment (on this phone's clock) it said it. Null = the switch is off. */
interface ProofView extends CallProofState {
  serverNow: number;
  fetchedAt: number;
}

/** The refusal's own words when the body carries none (the server always sends `errorAr`; this is the net under it). */
const PROOF_REFUSAL_FALLBACK: Record<string, string> = {
  CALL_NOT_STARTED: CALL_PROOF_WORDS.refusedNotStarted,
  CALL_NOT_LOGGED: CALL_PROOF_WORDS.notLogged,
};

/** Step 1 (her line) passed but the status door could not pair it with the call: the call IS on record, and the press is used up. */
const STATUS_AFTER_LINE = 'تسجّلت محاولة الاتصال، بس حالة الطلب ما تغيّرت (مرّ وقت بين الخطوتين). اضغط «اتصال» وجرّب من جديد.';

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
  // The door held the yes back for a confirmed twin: the orders it named, and the note she had typed (it goes with the second try).
  const [twin, setTwin] = useState<{ twins: ConfirmedTwinView[]; note: string } | null>(null);

  // «إثبات المكالمات»: what the server says her «لا يرد» waits for. Null while the switch is off (and until the first answer).
  const [proof, setProof] = useState<ProofView | null>(null);
  // The clock is STATE (a render never reads it); the one-second ticker below moves it while a countdown is on screen.
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** Has an answer said whether the switch is on? (`undefined` = not yet.) While off, no focus/poll/event asks anything extra. */
  const proofKnown = useRef<boolean | undefined>(undefined);
  /** The newest request wins: a slow answer that left before a press must not paint over the one that left after it. */
  const loadSeq = useRef(0);

  /** `quiet`: a refetch the screen makes by itself (poll, focus, a press) — it must not grey the buttons while it runs. */
  const loadAttempts = async (quiet = false) => {
    if (!order?.id) return;
    const seq = ++loadSeq.current;
    if (!quiet) setLoadingAttempts(true);
    try {
      const res = await apiFetch(`/api/orders/${order.id}/contact-attempts`);
      if (res.ok) {
        const data = await res.json();
        if (seq === loadSeq.current) {
          setAttempts(data.attempts || []);
          setSummary(data.summary || null);
          const cp = data.callProof;
          if (cp && cp.on === true) {
            proofKnown.current = true;
            setProof({ state: cp.state, unlocksAtMs: cp.unlocksAtMs ?? null, serverNow: Number(cp.serverNow), fetchedAt: Date.now() });
          } else {
            proofKnown.current = false;
            setProof(null);
          }
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (!quiet) setLoadingAttempts(false);
    }
  };

  useEffect(() => {
    setFeedback(null);
    setTwin(null);
    setProof(null);
    proofKnown.current = undefined;
    loadAttempts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  // The press may land after this window drew (the strip beside it, another tab) or be made on another device: ask again on the
  // press, on coming back to the window, and — while the panel still says «press اتصال first» — every twelve seconds.
  useEffect(() => {
    if (!order?.id) return;
    const orderId = order.id;
    const visible = () => document.visibilityState !== 'hidden';
    const refresh = () => {
      if (proofKnown.current !== false && visible()) void loadAttempts(true);
    };
    const onOpened = (e: Event) => {
      if ((e as CustomEvent<{ orderId?: string }>).detail?.orderId === orderId && proofKnown.current !== false) void loadAttempts(true);
    };
    window.addEventListener(CALL_OPENED_EVENT, onOpened);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener(CALL_OPENED_EVENT, onOpened);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  const proofState = proof?.state;
  useEffect(() => {
    if (proofState !== 'NO_OPENED') return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void loadAttempts(true);
    }, PROOF_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proofState, order?.id]);

  /** Whole seconds until «لا يرد» opens, from the server's clock (its `serverNow` plus what has passed here since) — null unless WAIT. */
  const waitLeft =
    proof && proof.state === 'WAIT' && proof.unlocksAtMs !== null ? secondsLeft(proof.unlocksAtMs, proof.serverNow + Math.max(0, nowMs - proof.fetchedAt)) : null;
  const waiting = waitLeft !== null && waitLeft > 0;
  // One-second ticker, only while there is a number to tick; it makes no request.
  useEffect(() => {
    if (!waiting) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);
  const proofLocked = !!proof && (proof.state === 'NO_OPENED' || waiting);
  const proofReason = !proof ? null : proof.state === 'NO_OPENED' ? CALL_PROOF_WORDS.noOpened : waiting ? CALL_PROOF_WORDS.wait(waitLeft as number) : null;

  /** The door said «wait n seconds»: lock again for exactly that long (the clock here is the only one this needs). */
  const adoptWait = (seconds: unknown) => {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return;
    const now = Date.now();
    setProof({ state: 'WAIT', unlocksAtMs: now + n * 1000, serverNow: now, fetchedAt: now });
  };

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
        // A proof refusal (409): nothing was written. The server's Arabic is said; «wait n» re-locks the button; «no press» asks again.
        if (d.code === 'CALL_TOO_SOON') adoptWait(d.waitSeconds);
        else if (d.code === 'CALL_NOT_STARTED' || d.code === 'CALL_NOT_LOGGED') void loadAttempts(true);
        setFeedback({ type: 'error', text: d.errorAr || PROOF_REFUSAL_FALLBACK[d.code] || d.error || (ar ? 'فشل تسجيل المحاولة' : 'Failed to record attempt') });
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
          /*
           * «الزبون عنده طلب مؤكَّد بنفس المنتج» IS A QUESTION, NOT AN ERROR LINE. The door wrote nothing and named the other
           * orders; the answer is hers, in the dialog. The call WAS recorded above and stays recorded — the call happened. The
           * confirm form is closed (its work is done) and the note she typed waits for the second try.
           */
          const twins = twinsFromRefusal(confData);
          if (twins) {
            setTwin({ twins, note: payload.note ?? '' });
            setOpenForm(null);
            return false;
          }
          // The contact attempt WAS recorded but the transition failed —
          // warn clearly and keep the modal open with the form values intact
          if (confData.code === 'CALL_TOO_SOON') adoptWait(confData.waitSeconds);
          // CALL_NOT_LOGGED / CALL_NOT_STARTED at THIS door: step 1 DID write her line (it passed), so the call is on record — but the status
          // door could not pair it (a long pause between the two steps, or another outcome landed first), and the press is used up. Say exactly that.
          if (confData.code === 'CALL_NOT_LOGGED' || confData.code === 'CALL_NOT_STARTED') {
            setFeedback({ type: 'error', text: STATUS_AFTER_LINE });
            void loadAttempts(true);
            return false;
          }
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

  /**
   * WHAT SHE ANSWERED TO «الزبون عنده طلب مؤكَّد بنفس المنتج» — the transition alone, with no second contact attempt: the call was
   * recorded when she pressed «تأكيد». The two bodies are `twin-refusal.ts`'s (the desk sends the same ones). The dialog closes as
   * she presses, like every dialog of the desk, and the outcome — a stale version included — is said in this card's own line.
   */
  const decideTwin = async (kind: 'reject' | 'confirm') => {
    if (!order?.id || !twin) return;
    const held = twin;
    setTwin(null);
    setActionLoading(true);
    setFeedback(null);
    try {
      const res = await apiFetch(`/api/orders/${order.id}/confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'reject' ? rejectAsDuplicateBody(order.version) : confirmAnywayBody(order.version, held.note)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({ type: 'error', text: data.errorAr || data.error || 'رفض الإجراء' });
        return;
      }
      setFeedback({ type: 'success', text: kind === 'reject' ? 'رُفض الطلب كمكرر' : 'تم تأكيد الطلب' });
      setNote(''); setRejectionReason(''); setFollowUpDate('');
      await loadAttempts();
      await onRefreshOrder();
    } catch (e) {
      setFeedback({ type: 'error', text: e instanceof Error && e.message ? e.message : 'تعذّر تنفيذ الإجراء' });
    } finally {
      setActionLoading(false);
    }
  };

  const wf = WORKFLOW_STATE[order?.confirmationStatus] ?? WORKFLOW_STATE.NEW;
  const terminal = ['CONFIRMED', 'REJECTED', 'CANCELLED'].includes(order?.confirmationStatus);
  const busy = actionLoading || loadingAttempts;
  /*
   * NO GOVERNORATE, NO YES (the owner, 30/10): the door refuses the confirmation (`REGION_REQUIRED`), and this window says so
   * BEFORE the press — a contact attempt is recorded first by `submitAction`, and a refusal after it would leave a call in the
   * log for a confirmation that never happened. `'regionId' in order`: an order object that does not carry the field at all
   * is not "without a governorate"; the door still decides.
   */
  const regionMissing = !!order && 'regionId' in order && needsRegionFirst(order);

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
  const spread = phone ? 'grow' : undefined;
  const answeredButton = (
    <Button
      variant="secondary"
      size="sm"
      className={spread}
      onClick={() => { void submitAction({ action: 'contact_result', result: 'ANSWERED' }); }}
      disabled={busy}
    >
      <RiPhoneLine className="w-4 h-4" />{ar ? 'العميل أجاب' : 'Answered'}
    </Button>
  );
  const noAnswerButton = (
    <Button
      variant="secondary"
      size="sm"
      className={spread}
      onClick={() => { void submitAction({ action: 'contact_result', result: 'NO_ANSWER' }); }}
      disabled={busy || proofLocked}
      {...(proofLocked ? { 'aria-describedby': 'call-proof-reason' } : {})}
    >
      <RiPhoneLockLine className="w-4 h-4" />{ar ? 'لا يرد' : 'No Answer'}
    </Button>
  );
  const callLaterButton = (
    <Button
      variant="secondary"
      size="sm"
      className={spread}
      onClick={() => { setNote(''); setOpenForm('call_later'); }}
      disabled={busy}
    >
      <RiTimerLine className="w-4 h-4" />{ar ? 'تأجيل' : 'Call Later'}
    </Button>
  );
  const followUpButton = (
    <Button
      variant="secondary"
      size="sm"
      className={spread}
      onClick={() => { setNote(''); setOpenForm('followup'); }}
      disabled={busy}
    >
      <RiRefreshLine className="w-4 h-4" />{ar ? 'متابعة' : 'Follow Up'}
    </Button>
  );
  const confirmButton = (
    <Button
      variant="primary"
      size="sm"
      className={phone ? 'w-full' : undefined}
      onClick={() => { setNote(''); setOpenForm('confirm'); }}
      disabled={busy}
    >
      <RiCheckLine className="w-4 h-4" />{ar ? 'تأكيد الطلب' : 'Confirm Order'}
    </Button>
  );
  const rejectButton = (
    <Button
      variant="danger"
      size="sm"
      className={spread}
      onClick={() => { setNote(''); setRejectionReason(''); setOpenForm('reject'); }}
      disabled={busy}
    >
      <RiCloseCircleLine className="w-4 h-4" />{ar ? 'العميل رفض' : 'Rejected'}
    </Button>
  );
  const wrongNumberButton = (
    <Button
      variant="secondary"
      size="sm"
      className={spread}
      onClick={() => { void submitAction({ action: 'contact_result', result: 'WRONG_NUMBER' }); }}
      // «رقم غلط» also puts the order on «لا يرد» at the status door, which wants a press of hers before it (no waiting): locked, and explained below, until there is one.
      disabled={busy || proof?.state === 'NO_OPENED'}
    >
      <RiPhoneLockLine className="w-4 h-4" />{ar ? 'رقم خاطئ' : 'Wrong Number'}
    </Button>
  );

  return (
    <Card plain padding="md"><div dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h4 className="text-sm font-black text-[var(--sys-foreground)] flex items-center gap-2">
          <RiPhoneLine className="w-4 h-4 text-[var(--sys-primary)]" />
          {ar ? 'تسجيل نتيجة الاتصال' : 'Record a call outcome'}
        </h4>
        <div className={phone ? 'flex flex-wrap items-center gap-2' : 'flex items-center gap-2'}>
          {summary?.total > 0 && (
            <span className="text-note font-bold text-[var(--sys-muted-foreground)] bg-[var(--sys-surface-strong)] rounded-lg px-2 py-1">
              {ar ? `محاولات: ${summary.total}` : `Attempts: ${summary.total}`}
            </span>
          )}
          {order.nextFollowUpAt && order.followUpStatus !== 'COMPLETED' && order.followUpStatus !== 'CANCELLED' && (
            <span className="text-note font-bold text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg px-2 py-1 inline-flex items-center gap-1">
              <RiCalendarScheduleLine className="w-4 h-4" />
              {ar ? 'متابعة:' : 'Follow-up:'} {arDateShort(order.nextFollowUpAt)}
            </span>
          )}
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border-2 text-note font-bold ${wf.cls}`}>
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
                <p className="mb-1.5 text-note text-[var(--sys-muted)]">{ar ? 'نتيجة الاتصال' : 'Call result'}</p>
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
          {/* «إثبات المكالمات»: why «لا يرد» is shut, in words (a phone has no tooltip). Drawn only with the switch on and the button locked. */}
          {proofLocked && proofReason && (
            <p id="call-proof-reason" className="w-full text-note text-[var(--sys-warning)]">
              {proofReason}
            </p>
          )}
        </div>
      )}

      {/* Feedback banner */}
      {feedback && (
        <div
          className={`mb-3 rounded-lg border p-2.5 text-note flex items-center justify-between gap-2 ${
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
              <p className="text-note text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/40 rounded-lg p-2.5">
                {ar
                  ? 'سيتم تسجيل تأكيد العميل للطلب ونقله لمرحلة ما بعد التأكيد.'
                  : 'The order will be confirmed and prepared for the next operational stage.'}
              </p>
              {regionMissing && (
                <p role="alert" className="text-note text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-2.5">
                  {REGION_REQUIRED_MESSAGE}
                </p>
              )}
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
              <p className="text-note text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg p-2.5">
                {ar ? 'تحديد موعد المتابعة إلزامي لهذا الإجراء.' : 'A next follow-up date is required for this action.'}
              </p>
              <Input label={ar ? 'موعد المتابعة *' : 'Next Follow-Up *'} type="datetime-local" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
              {/* Request C2: with the plan on (the proof's answer is here only then), a date is never «لا يرد» — this form sends no such reason; the line says where «لا يرد» goes. */}
              {proof && <p className="text-note text-[var(--sys-muted-foreground)]">{NO_ANSWER_NOT_A_POSTPONE_HINT}</p>}
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

      {twin && (
        <TwinConfirmedDialog
          open
          orderNumber={order.orderNumber}
          twins={twin.twins}
          busy={actionLoading}
          onRejectAsDuplicate={() => void decideTwin('reject')}
          onConfirmAnyway={() => void decideTwin('confirm')}
          onBack={() => setTwin(null)}
        />
      )}
    </div></Card>
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
    if (openForm === 'confirm') return regionMissing;
    if (openForm === 'reject') return !rejectionReason || (rejectionReason === 'OTHER' && (!note || note.trim().length < 5));
    if (openForm === 'followup' || openForm === 'call_later') return !followUpDate;
    return false;
  }
}
