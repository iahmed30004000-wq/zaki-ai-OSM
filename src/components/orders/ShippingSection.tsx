'use client';

/**
 * SALESFLOW — Phase D2: Shipping & Delivery section in Order Details.
 * Shows status timeline, provider, tracking, batch, attempts.
 * All mutations go through /api/orders/[id]/shipping (backend-enforced);
 * this component renders server state and never decides permissions.
 */

import { useState, useEffect } from 'react';
import { DismissButton } from '@/components/ui/DismissButton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { SHIPPING_STATUS_AR } from '@/lib/shipping-workflow';
import { apiFetch } from '@/lib/api-client';
import { arDateShort } from '@/lib/format';
import {
  ATTEMPT_RESULT_AR,
  // The lists and their words come from one place — see the note there.
  DELIVERY_FAILURE_REASON_LABELS as FAILURE_REASONS,
  RETURN_REASON_LABELS as RETURN_REASONS,
} from '@/lib/shipping-workflow';
import { RiArchiveDrawerLine, RiArrowGoBackLine, RiCloseCircleLine, RiHistoryLine, RiNumbersLine, RiShipLine, RiTimerLine, RiTruckLine } from '@remixicon/react';
import { RatingLinkButton } from './RatingLinkButton';


/*
 * THE WORD COMES FROM `SHIPPING_STATUS_AR`; ONLY THE COLOURS ARE HERE.
 * This map was one of six vocabularies for the same twelve values.
 */
const SHIPPING_STATE: Record<string, { ar: string; en: string; cls: string }> = {
  NOT_READY: { ar: SHIPPING_STATUS_AR.NOT_READY, en: 'Not Ready', cls: 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)] border-[var(--sys-border-strong)]' },
  READY_FOR_SHIPPING: { ar: SHIPPING_STATUS_AR.READY_FOR_SHIPPING, en: 'Ready for Shipping', cls: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-muted-foreground)]/50' },
  PACKING: { ar: SHIPPING_STATUS_AR.PACKING, en: 'Packing', cls: 'bg-[var(--sys-surface)] text-[var(--sys-foreground)] border-[var(--sys-border-strong)]' },
  READY_FOR_PICKUP: { ar: SHIPPING_STATUS_AR.READY_FOR_PICKUP, en: 'Ready for Pickup', cls: 'bg-[var(--sys-surface)] text-[var(--sys-foreground)] border-[var(--sys-border-strong)]' },
  SHIPPED: { ar: SHIPPING_STATUS_AR.SHIPPED, en: 'Shipped', cls: 'bg-[var(--sys-surface)] text-[var(--sys-foreground)] border-[var(--sys-border-strong)]' },
  OUT_FOR_DELIVERY: { ar: SHIPPING_STATUS_AR.OUT_FOR_DELIVERY, en: 'Out for Delivery', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/60' },
  DELIVERED: { ar: SHIPPING_STATUS_AR.DELIVERED, en: 'Delivered', cls: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/60' },
  FAILED_DELIVERY: { ar: SHIPPING_STATUS_AR.FAILED_DELIVERY, en: 'Delivery Failed', cls: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]' },
  RETURN_REQUESTED: { ar: SHIPPING_STATUS_AR.RETURN_REQUESTED, en: 'Return Requested', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/60' },
  RETURNED: { ar: SHIPPING_STATUS_AR.RETURNED, en: 'Returned', cls: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]' },
  CANCELLED: { ar: SHIPPING_STATUS_AR.CANCELLED, en: 'Cancelled', cls: 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)] border-[var(--sys-border-strong)]' },
};


/** Next allowed transitions per current status (mirrors backend map for UX only) */
const NEXT_ACTIONS: Record<string, { to: string; labelAr: string; labelEn: string; cls: string }[]> = {
  // NOT_READY offers nothing here on purpose. An order becomes ready to ship
  // in the preparation screen, where the stock is actually reserved against
  // its lines; a button here only ever produced "الشحن يتطلب طلباً مؤكداً".
  NOT_READY: [],
  READY_FOR_SHIPPING: [{ to: 'PACKING', labelAr: 'بدء التغليف', labelEn: 'Start Packing', cls: 'border-[var(--sys-border-strong)] text-[var(--sys-foreground)] hover:bg-[var(--sys-surface)]' }],
  PACKING: [{ to: 'READY_FOR_PICKUP', labelAr: 'جاهز للاستلام', labelEn: 'Ready for Pickup', cls: 'border-[var(--sys-border-strong)] text-[var(--sys-foreground)] hover:bg-[var(--sys-surface)]' }],
  READY_FOR_PICKUP: [{ to: 'SHIPPED', labelAr: 'تم الشحن', labelEn: 'Shipped', cls: 'border-[var(--sys-border-strong)] text-[var(--sys-foreground)] hover:bg-[var(--sys-surface)]' }],
  SHIPPED: [{ to: 'OUT_FOR_DELIVERY', labelAr: 'خرج للتوصيل', labelEn: 'Out for Delivery', cls: 'border-[var(--sys-warning)]/60 text-[var(--sys-warning)] hover:bg-[var(--sys-warning-soft)]' }],
  OUT_FOR_DELIVERY: [
    { to: 'DELIVERED', labelAr: 'تم التسليم', labelEn: 'Delivered', cls: 'border-[var(--sys-success)]/60 text-[var(--sys-success)] hover:bg-[var(--sys-success-soft)]' },
    { to: 'FAILED_DELIVERY', labelAr: 'فشل التوصيل', labelEn: 'Failed', cls: 'border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] hover:bg-[var(--sys-destructive-soft)]' },
  ],
  FAILED_DELIVERY: [
    { to: 'RETURN_REQUESTED', labelAr: 'طلب إرجاع', labelEn: 'Return', cls: 'border-[var(--sys-warning)]/60 text-[var(--sys-warning)] hover:bg-[var(--sys-warning-soft)]' },
    { to: 'SHIPPED', labelAr: 'إعادة شحن', labelEn: 'Reship', cls: 'border-[var(--sys-border-strong)] text-[var(--sys-foreground)] hover:bg-[var(--sys-surface)]' },
  ],
  RETURN_REQUESTED: [{ to: 'RETURNED', labelAr: 'تم الإرجاع', labelEn: 'Returned', cls: 'border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] hover:bg-[var(--sys-destructive-soft)]' }],
};

interface ShippingSectionProps {
  order: any;
  ar: boolean;
  isRtl: boolean;
  onRefreshOrder: () => void | Promise<void>;
  /**
   * May this person move the shipment at all?
   *
   * The server already refuses them — every action here needs
   * orders.change_status — but showing the buttons to a confirmation agent
   * or a moderator invites a click that can only end in a red error, and
   * teaches them the screen is unreliable. Worse, this modal opens from
   * half a dozen screens, so "who is looking at it" is never obvious from
   * the buttons alone.
   */
  canEdit?: boolean;
}

export function ShippingSection({ order, ar, isRtl, onRefreshOrder, canEdit = true }: ShippingSectionProps) {
  const [providers, setProviders] = useState<any[]>([]);
  const [attempts, setAttempts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // form state
  const [openForm, setOpenForm] = useState<string | null>(null); // 'fail' | 'return' | 'provider' | 'tracking'
  const [providerId, setProviderId] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('');
  // Why the fee was changed — written beside the old and the new figure when the fee moves.
  const [feeReason, setFeeReason] = useState('');
  const [failureReason, setFailureReason] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [attemptResult, setAttemptResult] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    setFeedback(null);
    loadProviders();
    loadAttempts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  const loadProviders = async () => {
    try {
      const res = await apiFetch('/api/delivery-providers');
      if (res.ok) setProviders((await res.json()).providers || []);
      else setListError((ar ? 'فشل تحميل شركات التوصيل' : 'Failed to load providers') + ` (HTTP ${res.status})`);
    } catch (e: any) {
      setListError(e?.message || (ar ? 'فشل تحميل شركات التوصيل' : 'Failed to load providers'));
    }
  };

  const loadAttempts = async () => {
    if (!order?.id) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/orders/${order.id}/delivery-attempts`);
      if (res.ok) {
        setAttempts((await res.json()).attempts || []);
        setListError(null);
      } else {
        setListError((ar ? 'فشل تحميل سجل التوصيل' : 'Failed to load attempts') + ` (HTTP ${res.status})`);
      }
    } catch (e: any) {
      setListError(e?.message || (ar ? 'فشل تحميل سجل التوصيل' : 'Failed to load attempts'));
    } finally {
      setLoading(false);
    }
  };

  /** Submit one shipping action. Returns the updated order (with fresh version)
   *  so multi-step sequences can thread optimistic-concurrency versions. */
  const submit = async (payload: Record<string, unknown>): Promise<{ ok: boolean; order?: any }> => {
    return submitWithVersion(payload, order.version);
  };

  const submitWithVersion = async (payload: Record<string, unknown>, expectedVersion: number): Promise<{ ok: boolean; order?: any }> => {
    if (!order?.id) return { ok: false };
    setActionLoading(String(payload.action));
    setFeedback(null);
    try {
      const res = await apiFetch(`/api/orders/${order.id}/shipping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, expectedVersion }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({ type: 'error', text: data.errorAr || data.error || (ar ? 'فشل الإجراء' : 'Action failed') });
        return { ok: false };
      }
      setFeedback({ type: 'success', text: ar ? 'تم تحديث الشحن' : 'Shipping updated' });
      await onRefreshOrder();
      await loadAttempts();
      return { ok: true, order: data.order };
    } catch (e: any) {
      setFeedback({ type: 'error', text: e?.message || (ar ? 'فشل الإجراء' : 'Action failed') });
      return { ok: false };
    } finally {
      setActionLoading(null);
    }
  };

  /** Single-step transition: close the form + clear inputs only on success */
  const transition = async (to: string, extra: Record<string, unknown> = {}) => {
    const result = await submit({ action: 'transition', to, ...extra });
    if (result.ok) {
      setNote(''); setFailureReason(''); setReturnReason(''); setOpenForm(null);
    }
    return result.ok;
  };

  /**
   * An attempt that does NOT end the order — see the modal below. Outcomes
   * are never recorded from here; the server writes those with the status.
   */
  const recordAttempt = async (result: string): Promise<boolean> => {
    setActionLoading('attempt');
    setFeedback(null);
    try {
      const res = await apiFetch(`/api/orders/${order.id}/delivery-attempts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result, note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({ type: 'error', text: data.errorAr || data.error || (ar ? 'فشل التسجيل' : 'Failed') });
        return false;
      }
      await loadAttempts();
      return true;
    } catch (e: any) {
      setFeedback({ type: 'error', text: e?.message || (ar ? 'فشل التسجيل' : 'Failed') });
      return false;
    } finally {
      setActionLoading(null);
    }
  };

  const st = SHIPPING_STATE[order?.shippingStatus] ?? SHIPPING_STATE.NOT_READY;
  const terminal = ['DELIVERED', 'RETURNED', 'CANCELLED'].includes(order?.shippingStatus);
  const canTrack = !['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED'].includes(order?.shippingStatus);
  const actions = NEXT_ACTIONS[order?.shippingStatus] ?? [];

  return (
    <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 shadow-raised" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h4 className="text-xs font-black text-[var(--sys-foreground)] flex items-center gap-2">
          <RiTruckLine className="w-4 h-4 text-[var(--sys-destructive)]" />
          {ar ? 'الشحن والتوصيل' : 'Shipping & Delivery'}
        </h4>
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border-2 text-xs font-bold ${st.cls}`}>
          {ar ? st.ar : st.en}
        </span>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs mb-3">
        <Info label={ar ? 'شركة التوصيل' : 'Provider'} value={order.deliveryProvider?.name || (ar ? 'غير معيّنة' : 'None')} />
        <Info label={ar ? 'رقم التتبع' : 'Tracking #'} value={order.trackingNumber || '—'} mono />
        <Info label={ar ? 'دفعة الشحن' : 'Batch'} value={order.shippingBatch?.batchNumber || '—'} mono />
        <Info label={ar ? 'شُحن في' : 'Shipped At'} value={arDateShort(order.shippedAt)} />
        <Info label={ar ? 'خرج للتوصيل' : 'Out for Delivery'} value={arDateShort(order.outForDeliveryAt)} />
        <Info label={ar ? 'سُلّم في' : 'Delivered At'} value={arDateShort(order.deliveredAt)} />
      </div>

      {/* THE RATING LINK — only once the goods actually arrived.
          Owner decision D8: the customer is offered it on the tracking
          page, and the seller gets it here to send over WhatsApp. A link
          handed out before delivery is an invitation to rate a parcel
          nobody has opened, so the door refuses it too. */}
      {['DELIVERED', 'PARTIALLY_DELIVERED'].includes(order?.shippingStatus) && (
        <RatingLinkButton orderId={order.id} />
      )}

      {/* Failure/return reasons */}
      {order.shippingStatus === 'FAILED_DELIVERY' && order.deliveryFailureReason && (
        <p className="mb-3 text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-2.5 py-1.5">
          <RiCloseCircleLine className="me-1 inline-block h-4 w-4 align-text-bottom" aria-hidden />
          {ar ? 'سبب الفشل:' : 'Failure reason:'}{' '}
          {(FAILURE_REASONS as any)[order.deliveryFailureReason]?.[ar ? 'ar' : 'en'] ?? order.deliveryFailureReason}
          {order.deliveryNote ? ` — ${order.deliveryNote}` : ''}
        </p>
      )}
      {order.returnReason && ['RETURN_REQUESTED', 'RETURNED'].includes(order.shippingStatus) && (
        <p className="mb-3 text-xs text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg px-2.5 py-1.5">
          <RiArrowGoBackLine className="icon-mirror me-1 inline-block h-4 w-4 align-text-bottom" aria-hidden />
          {ar ? 'سبب الإرجاع:' : 'Return reason:'}{' '}
          {(RETURN_REASONS as any)[order.returnReason]?.[ar ? 'ar' : 'en'] ?? order.returnReason}
        </p>
      )}

      {!canEdit && (
        <p className="mb-3 text-xs text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg px-2.5 py-2">
          الشحن والتوصيل للعرض فقط — تحريكه من صلاحية فريق الشحن.
        </p>
      )}

      {/* Quick transition actions (backend validates everything) */}
      {canEdit && !terminal && actions.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {actions.map((a) => (
            <button
              key={a.to}
              onClick={() => {
                setNote('');
                if (a.to === 'FAILED_DELIVERY') { setOpenForm('fail'); return; }
                if (a.to === 'RETURN_REQUESTED' || a.to === 'RETURNED') { setOpenForm('return'); return; }
                transition(a.to);
              }}
              disabled={actionLoading !== null}
              className={`min-h-11 md:min-h-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border-2 transition-colors cursor-pointer disabled:opacity-50 ${a.cls}`}
            >
              {a.to === 'DELIVERED' ? <RiArchiveDrawerLine className="w-4 h-4" /> : a.to === 'FAILED_DELIVERY' ? <RiCloseCircleLine className="w-4 h-4" /> : a.to === 'RETURNED' || a.to === 'RETURN_REQUESTED' ? <RiArrowGoBackLine className="icon-mirror w-4 h-4" /> : <RiShipLine className="w-4 h-4" />}
              {ar ? a.labelAr : a.labelEn}
            </button>
          ))}
          {canTrack && (
            <button
              /*
               * A STORED ZERO IS A VALUE, NOT A BLANK.
               *
               * `order.deliveryFee ? String(…) : ''` was falsy-tested on a
               * figure whose legitimate values include 0 —
               * `priceIncludesDelivery` makes a zero fee a real policy — so
               * an order recorded as «delivery costs us nothing» opened with
               * an EMPTY box. Harmless while an empty box also sent 0; now
               * that an empty box sends `null`, it would have silently
               * turned a recorded 0 into «not recorded» on the next save.
               *
               * So the box shows `null`/absent as empty and everything else,
               * including 0, as the stored number.
               */
              onClick={() => { setTrackingNumber(order.trackingNumber || ''); setDeliveryFee(order.deliveryFee == null ? '' : String(order.deliveryFee)); setFeeReason(''); setOpenForm('tracking'); }}
              disabled={actionLoading !== null}
              className="min-h-11 md:min-h-0 inline-flex items-center inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border-2 border-[var(--sys-border-strong)] text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)] transition-colors cursor-pointer disabled:opacity-50"
            >
              <RiNumbersLine className="w-4 h-4" />{ar ? 'رقم التتبع' : 'Tracking'}
            </button>
          )}
        </div>
      )}

      {/* Feedback */}
      {feedback && (
        <div className={`mb-3 rounded-lg border p-2.5 text-xs flex items-center justify-between gap-2 ${
          feedback.type === 'success' ? 'border-[var(--sys-success)]/60 bg-[var(--sys-success-soft)] text-[var(--sys-success)]' : 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]'
        }`}>
          <span>{feedback.text}</span>
          <DismissButton onClick={() => setFeedback(null)} />
        </div>
      )}

      {/* Inline load error (providers / attempts) */}
      {listError && (
        <div className="mb-3 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] p-2.5 text-xs flex items-center justify-between gap-2">
          <span>{listError}</span>
          <DismissButton onClick={() => setListError(null)} />
        </div>
      )}

      {/* Delivery attempts (append-only history) */}
      <div className="border-t border-[var(--sys-border)] pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-bold text-[var(--sys-muted)] flex items-center gap-1.5">
            <RiHistoryLine className="w-4 h-4" />
            {ar ? 'سجل الشحن والتوصيل' : 'Shipping & Delivery Timeline'}
            {loading && <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-[var(--sys-destructive)]" />}
          </p>
          {canEdit && ['SHIPPED', 'OUT_FOR_DELIVERY'].includes(order?.shippingStatus) && (
            <button
              type="button"
              onClick={() => { setNote(''); setAttemptResult(''); setOpenForm('attempt'); }}
              disabled={actionLoading !== null}
              className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-border-strong)] px-3 py-1.5 text-xs font-bold text-[var(--sys-foreground)] transition-colors cursor-pointer hover:bg-[var(--sys-surface)] disabled:opacity-50"
            >
              <RiTimerLine className="w-4 h-4" />
              {ar ? 'تسجيل محاولة' : 'Log an attempt'}
            </button>
          )}
        </div>
        {attempts.length === 0 ? (
          <p className="text-xs text-[var(--sys-muted)] py-1.5">{ar ? 'لا محاولات توصيل بعد.' : 'No delivery attempts yet.'}</p>
        ) : (
          <div className="space-y-1.5">
            {attempts.map((att: any) => (
              <div key={att.id} className={`p-2 rounded-lg border text-xs ${
                att.result === 'DELIVERED' ? 'bg-[var(--sys-success-soft)]/60 border-[var(--sys-success)]/40' : att.result === 'FAILED' ? 'bg-[var(--sys-destructive-soft)]/60 border-[var(--sys-destructive-border)]' : 'bg-[var(--sys-surface)] border-[var(--sys-border)]'
              }`}>
                <div className="flex items-center justify-between flex-wrap gap-1">
                  <span className="font-bold text-[var(--sys-foreground)]">
                    {ar ? `محاولة #${att.attemptNumber}` : `Attempt #${att.attemptNumber}`} — {ATTEMPT_RESULT_AR[att.result] ?? att.result}
                  </span>
                  <span className="text-[var(--sys-muted)]">{arDateShort(att.createdAt)}</span>
                </div>
                <div className="text-[var(--sys-muted-foreground)] mt-0.5 flex flex-wrap gap-x-3">
                  <span>{ar ? 'بواسطة:' : 'By:'} <span className="font-semibold">{att.agent?.name ?? '—'}</span></span>
                  {att.provider && <span>{ar ? 'المندوب:' : 'Provider:'} {att.provider.name}</span>}
                  {att.failureReason && <span className="text-[var(--sys-destructive)]">{(FAILURE_REASONS as any)[att.failureReason]?.[ar ? 'ar' : 'en'] ?? att.failureReason}</span>}
                </div>
                {att.note && <p className="text-[var(--sys-muted-foreground)] mt-0.5">{att.note}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Forms ─── */}

      {/*
        AN ATTEMPT THAT IS NOT AN OUTCOME.
        «Knocked, nobody home, agreed to come back tomorrow» is most of what a
        hard round consists of, and it does not end the order — so it had no
        transition button, and therefore no way into the product at all. The
        endpoint for it existed and nothing could reach it.
        Only results that leave the order out for delivery are offered. A
        delivery that truly failed belongs on «فشل التوصيل», which records the
        attempt and moves the order in one step.
      */}
      <Modal isOpen={openForm === 'attempt'} onClose={() => setOpenForm(null)} title={ar ? 'تسجيل محاولة توصيل' : 'Log a Delivery Attempt'} maxWidth="md">
        <div className="space-y-3" dir={isRtl ? 'rtl' : 'ltr'}>
          <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            {ar
              ? 'للمحاولة التي لم تُنهِ الطلب — يبقى الطلب خارجاً للتوصيل. إن فشل التوصيل نهائياً فاستخدم «فشل التوصيل».'
              : 'For an attempt that did not end the order — it stays out for delivery. If the delivery failed for good, use «Failed».'}
          </p>
          <Select label={ar ? 'النتيجة *' : 'Result *'} value={attemptResult} onChange={(e) => setAttemptResult(e.target.value)}>
            <option value="">— {ar ? 'اختر' : 'Select'} —</option>
            <option value="RESCHEDULED">{ar ? ATTEMPT_RESULT_AR.RESCHEDULED : 'Rescheduled'}</option>
            <option value="OTHER">{ar ? ATTEMPT_RESULT_AR.OTHER : 'Other'}</option>
          </Select>
          <Textarea
            label={attemptResult === 'OTHER' ? `${ar ? 'ملاحظة (إلزامية)' : 'Note (required)'} *` : ar ? 'ملاحظة' : 'Note'}
            rows={2} value={note} onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpenForm(null)}>{ar ? 'إلغاء' : 'Cancel'}</Button>
            <Button
              size="sm" loading={actionLoading === 'attempt'}
              disabled={!attemptResult || (attemptResult === 'OTHER' && note.trim().length < 5)}
              onClick={async () => {
                const ok = await recordAttempt(attemptResult);
                if (ok) { setNote(''); setAttemptResult(''); setOpenForm(null); }
              }}
            >
              {ar ? 'تسجيل' : 'Log'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={openForm === 'fail'} onClose={() => setOpenForm(null)} title={ar ? 'تسجيل فشل التوصيل' : 'Record Delivery Failure'} maxWidth="md">
        <div className="space-y-3" dir={isRtl ? 'rtl' : 'ltr'}>
          <Select label={ar ? 'سبب الفشل *' : 'Failure Reason *'} value={failureReason} onChange={(e) => setFailureReason(e.target.value)}>
            <option value="">— {ar ? 'اختر السبب' : 'Select'} —</option>
            {Object.entries(FAILURE_REASONS).map(([k, v]) => <option key={k} value={k}>{ar ? v.ar : v.en}</option>)}
          </Select>
          <Textarea
            label={failureReason === 'OTHER' ? `${ar ? 'ملاحظة (إلزامية)' : 'Note (required)'} *` : ar ? 'ملاحظة' : 'Note'}
            rows={2} value={note} onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpenForm(null)}>{ar ? 'إلغاء' : 'Cancel'}</Button>
            <Button
              size="sm" loading={actionLoading === 'transition'}
              disabled={!failureReason || (failureReason === 'OTHER' && note.trim().length < 5)}
              onClick={async () => {
                // One request. The attempt row is appended by the server in
                // the same transaction as the status change — it used to be
                // POSTed from here first, which could leave a permanent audit
                // row for a transition that then failed.
                const transitionOk = await transition('FAILED_DELIVERY', { deliveryFailureReason: failureReason, shippingNote: note });
                if (transitionOk) {
                  setNote(''); setFailureReason('');
                  setOpenForm(null);
                }
              }}
            >
              {ar ? 'تأكيد الفشل' : 'Confirm Failure'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={openForm === 'return'} onClose={() => setOpenForm(null)} title={ar ? 'طلب إرجاع' : 'Return Request'} maxWidth="md">
        <div className="space-y-3" dir={isRtl ? 'rtl' : 'ltr'}>
          <Select label={ar ? 'سبب الإرجاع *' : 'Return Reason *'} value={returnReason} onChange={(e) => setReturnReason(e.target.value)}>
            <option value="">— {ar ? 'اختر السبب' : 'Select'} —</option>
            {Object.entries(RETURN_REASONS).map(([k, v]) => <option key={k} value={k}>{ar ? v.ar : v.en}</option>)}
          </Select>
          <Textarea label={ar ? 'ملاحظة' : 'Note'} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpenForm(null)}>{ar ? 'إلغاء' : 'Cancel'}</Button>
            <Button
              size="sm" loading={actionLoading === 'transition'} className="bg-[var(--sys-warning)] hover:bg-[var(--sys-warning)]"
              disabled={!returnReason}
              onClick={async () => {
                const ok = await transition('RETURN_REQUESTED', { returnReason, shippingNote: note });
                if (ok) { setNote(''); setReturnReason(''); setOpenForm(null); }
              }}
            >
              {ar ? 'تأكيد الإرجاع' : 'Confirm Return'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={openForm === 'tracking'} onClose={() => setOpenForm(null)} title={ar ? 'بيانات التتبع' : 'Tracking Details'} maxWidth="md">
        <div className="space-y-3" dir={isRtl ? 'rtl' : 'ltr'}>
          <Select
            label={ar ? 'شركة التوصيل' : 'Delivery Provider'}
            value={providerId || order.deliveryProviderId || ''}
            onChange={(e) => setProviderId(e.target.value)}
          >
            <option value="">— {ar ? 'بدون' : 'None'} —</option>
            {providers.filter((p) => p.isActive).map((p: any) => (
              <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
            ))}
          </Select>
          <Input label={ar ? 'رقم التتبع' : 'Tracking Number'} name="trackingNumber" value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} dir="ltr" />
          <Input
            label={ar ? 'رسوم التوصيل ($)' : 'Delivery Fee ($)'}
            name="deliveryFee"
            type="number"
            step="0.01"
            value={deliveryFee}
            onChange={(e) => setDeliveryFee(e.target.value)}
            dir="ltr"
            placeholder={ar ? 'غير مسجّلة' : 'Not recorded'}
            helperText={
              ar
                ? 'فارغة = لم تُسجَّل بعد (وهي حالة 30 من 56 طلباً). صفر مكتوب = الشركة لا تأخذ أجرة على هذا الطلب، ويُحاسَب صفراً.'
                : 'Empty = not recorded yet. A typed 0 = no fee on this order, and it is settled as zero.'
            }
          />
          {deliveryFee !== String(order.deliveryFee ?? '') && (
            <Input
              label={ar ? 'سبب تغيير الأجرة (اختياري)' : 'Why the fee changed (optional)'}
              name="deliveryFeeReason"
              value={feeReason}
              onChange={(e) => setFeeReason(e.target.value)}
              maxLength={300}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpenForm(null)}>{ar ? 'إلغاء' : 'Cancel'}</Button>
            <Button
              size="sm" loading={actionLoading !== null}
              onClick={async () => {
                // Sequence: assign_provider → update_tracking. Each call must use
                // the LATEST version from the previous response — abort on first
                // failure and keep the modal open so the user can retry.
                let currentVersion = order.version;
                if (providerId && providerId !== (order.deliveryProviderId ?? '')) {
                  const r1 = await submit({ action: 'assign_provider', deliveryProviderId: providerId });
                  if (!r1.ok) return;
                  currentVersion = r1.order?.version ?? currentVersion;
                }
                if (trackingNumber !== (order.trackingNumber ?? '') || deliveryFee !== String(order.deliveryFee ?? '')) {
                  /*
                   * THREE STATES, THREE THINGS ON THE WIRE — AND THIS IS WHY
                   * `0aea050`'s DOOR WAS UNREACHABLE.
                   *
                   * `deliveryFee ? Number(deliveryFee) : 0` could only ever
                   * send a number. So:
                   *
                   *   · an EMPTY box sent `0` — «the courier charges us
                   *     nothing» — over a `Float?` column whose whole point
                   *     is that it can say «not recorded», which 30 of 56
                   *     live orders do. The browser manufactured the one
                   *     wrong value the door is obliged to accept.
                   *   · `'2,500'` sent `Number('2,500')` = `NaN`, and
                   *     `0aea050` measured that Prisma ACCEPTS `NaN` for a
                   *     nullable Float: it lands as NULL and every reader
                   *     spells NULL `?? 0`. The same wrong zero by a longer
                   *     road, and the 400 waiting at the door never fired.
                   *
                   * Now, and the column is nullable so all three are
                   * sayable:
                   *   empty   → `null`  — «not recorded», written as NULL.
                   *   `'0'`   → `'0'`   — a real zero fee, stored 0.
                   *   typed   → the CHARACTERS, so `numeric-input` reads
                   *             them and refuses `'2,500'` with
                   *             «رسوم التوصيل: اكتبه رقماً بالأرقام».
                   *
                   * `null` and not `undefined`: `undefined` means «do not
                   * touch the column» at this door, and clearing the box is
                   * a decision to clear the fee, not a decision to skip it.
                   */
                  const r2 = await submitWithVersion({
                    action: 'update_tracking',
                    trackingNumber,
                    deliveryFee: deliveryFee.trim() === '' ? null : deliveryFee,
                    ...(feeReason.trim() && deliveryFee !== String(order.deliveryFee ?? '') ? { deliveryFeeReason: feeReason.trim() } : {}),
                  }, currentVersion);
                  if (!r2.ok) return;
                }
                // Full sequence succeeded → close + refresh
                setTrackingNumber(''); setDeliveryFee(''); setFeeReason(''); setProviderId('');
                setOpenForm(null);
                await onRefreshOrder();
              }}
            >
              {ar ? 'حفظ' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-[var(--sys-surface)] px-2.5 py-2">
      <p className="text-xs text-[var(--sys-muted)]">{label}</p>
      <p className={`text-xs font-bold text-[var(--sys-foreground)] truncate ${mono ? 'font-mono' : ''}`} dir={mono ? 'ltr' : undefined}>{value}</p>
    </div>
  );
}
