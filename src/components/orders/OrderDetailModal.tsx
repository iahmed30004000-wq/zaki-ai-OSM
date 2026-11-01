'use client';

import React, { useState, useEffect, useRef } from 'react';
import { DismissButton } from '@/components/ui/DismissButton';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select, Textarea, Input } from '@/components/ui/Input';
import { ProductThumb } from '@/components/ui/ProductThumb';
import { useOrderOwnership } from '@/hooks/useOrderOwnership';
import { OrderResponsibility } from '@/components/orders/OrderResponsibility';
import { CustomerCard } from '@/components/orders/CustomerCard';
import { OrderLinesCard } from '@/components/orders/OrderLinesCard';
import { DeliveryIncludedBox, mayTellDelivery } from '@/components/orders/DeliveryIncludedBox';
import { ConfirmationActions } from '@/components/orders/ConfirmationActions';
import { ShapeRiskPanel } from '@/components/orders/ShapeRiskPanel';
import { DuplicateSuspectNotice } from '@/components/orders/DuplicateSuspectNotice';
import { STAGE_AR, STAGE_STATE_AR, type StageState } from '@/lib/order-closing';
import { ChangeRequestDialog, type ChangeRequestValue } from '@/components/screens/confirmation/ActionDialogs';
import { raiseChangeRequest } from '@/components/orders/raiseChangeRequest';
import { handedToCourier } from '@/lib/order-seal';
import { ShippingSection } from '@/components/orders/ShippingSection';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { apiFetch, apiJson } from '@/lib/api-client';
import { useOrderPatch } from '@/components/orders/useOrderPatch';
import { CustomerHistoryModal } from '@/components/orders/CustomerHistory';
import { OrderStateBadge } from '@/components/orders/OrderStateBadge';
import { OrderStages } from '@/components/orders/OrderStages';
import { OrderNotes } from '@/components/orders/OrderNotes';
import { orderStages } from '@/lib/order-stages';
import { agentMustPullFirst, NOT_HELD_MESSAGE } from '@/lib/confirmation-queue';
import { useRegions } from '@/hooks/useRegions';
import { amount, arDateShort, arDateTime, type Currency } from '@/lib/format';
import { RiArrowLeftSLine, RiArrowRightSLine, RiEBike2Line, RiLockLine, RiMoneyDollarCircleLine, RiPencilLine, RiTimerLine, RiTruckLine, RiUserFollowLine } from '@remixicon/react';
import { POST_ORDER_ADDITION_AR } from '@/lib/post-order-offer-copy';
import { useIsPhone } from '@/hooks/useIsPhone';

/** Settlement is its own fact, never merged into the delivery status. */
const SETTLEMENT_AR: Record<string, string> = {
  PENDING: 'بانتظار التسوية',
  PENDING_COLLECTION: 'لم يُحصَّل',
  COLLECTED: 'محصَّل',
  PARTIALLY_SETTLED: 'مسوّى جزئياً',
  SETTLED: 'مسوّى',
  UNSETTLED: 'غير مسوّى',
  REFUNDED: 'مُسترد',
  CANCELLED: 'ملغى',
};


interface OrderDetailModalProps {
  orderId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void;
  /**
   * The list's filters, so ‹previous› and ‹next› walk the list behind this
   * dialog and not some wider one. Every filter, or the arrows quietly
   * leave the set the person was reading — which is what they did while
   * only three of the nine were forwarded.
   */
  filters?: {
    q?: string;
    status?: string;
    productId?: string;
    source?: string;
    regionId?: string;
    courierId?: string;
    from?: string;
    to?: string;
    lateDays?: string;
  };
}

export function OrderDetailModal({ orderId, isOpen, onClose, onRefresh, filters }: OrderDetailModalProps) {
  const { t, locale, isRtl, currentUser } = useApp();
  /* A phone reads the order in a different ORDER (the call right after the customer) — the same cards. */
  const phone = useIsPhone();
  // Saves an edit, and asks why when the server says this authority owes a
  // reason. See src/components/orders/useOrderPatch.ts.
  const patchOrder = useOrderPatch();

  // Two fields the person editing may not have authority over. The server
  // decides; these mirror it so the screen never offers what it will refuse.
  // `userCan` is the server's own answer — no role is let through by name, because none is on the server.
  const mayChangeChannel = userCan(currentUser, 'orders.assign');
  const mayChangeShipping = userCan(currentUser, 'orders.change_status');
  // Raising a request on a confirmed order is a key of its own (PR-6); the server asks the same.
  const mayRequestChange = userCan(currentUser, 'orders.request_change');
  const mayWriteNote = userCan(currentUser, 'orders.note');
  const mayChangeFee = userCan(currentUser, 'orders.change_fee');
  const mayCopyRatingLink = userCan(currentUser, 'orders.rating_link');
  const ar = locale === 'ar';
  const [order, setOrder] = useState<any>(null);
  const [currency, setCurrency] = useState<Currency | null>(null);
  /** The country's calling code, for the contact strip's `wa.me`. */
  const [dialCode, setDialCode] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [channelOpen, setChannelOpen] = useState(false);
  const [channelDraft, setChannelDraft] = useState('');
  /** تعديل · إلغاء · تأجيل on a confirmed order — see the card below. */
  const [askOpen, setAskOpen] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!isOpen || channels.length) return;
    apiJson<{ channels: { id: string; name: string; isActive: boolean }[] }>('/api/settings/channels')
      .then((d) => setChannels((d.channels ?? []).filter((c) => c.isActive)))
      .catch(() => setChannels([]));
  }, [isOpen, channels.length]);

  const saveChannel = async () => {
    if (!order?.id) return;
    try {
      const res = await patchOrder(order.id, { expectedVersion: order.version, channelId: channelDraft || null });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.errorAr || data.error || 'تعذر حفظ القناة');
      }
      setChannelOpen(false);
      await loadOrder(order.id);
      onRefresh();
    } catch (e) {
      setActionFeedback({ type: 'error', text: e instanceof Error ? e.message : 'تعذر حفظ القناة' });
    }
  };
  // The COD breakdown, computed server-side by the one cod function.
  const [cod, setCod] = useState<
    { subtotal: number; discount: number; deliveryFee: number; cod: number; includesDelivery: boolean } | null
  >(null);
  // Merged history: status logs, ownership, contact and delivery attempts,
  // notes, change requests and issues in one list.
  const [timeline, setTimeline] = useState<
    { id: string; title: string; detail?: string | null; at: string; actorName?: string | null }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // 30s tick so lockActive (expiry-based) re-renders and expired locks clear.
  // Stores the current server clock read inside the interval (not during render)
  // so render stays pure: expiry comparisons use this cached `nowMs`.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);
  const [navLoading, setNavLoading] = useState<'prev' | 'next' | null>(null);
  const [navIds, setNavIds] = useState<{ previousOrderId: string | null; nextOrderId: string | null }>({
    previousOrderId: null,
    nextOrderId: null,
  });
  // Phase C: ownership + editing lock client integration
  const ownership = useOrderOwnership(orderId);

  // Release the editing lock when the modal closes/unmounts while in edit mode.
  // keepalive lets the request survive page navigation during unmount.
  const { inEditMode, releaseLock } = ownership;
  const releaseLockRef = useRef(releaseLock);
  useEffect(() => { releaseLockRef.current = releaseLock; }, [releaseLock]);

  useEffect(() => {
    return () => {
      if (inEditMode && orderId) {
        // Exactly ONE release request on unmount — keepalive lets it survive
        // page navigation during unmount.
        fetch(`/api/orders/${orderId}/lock`, { method: 'DELETE', keepalive: true }).catch(() => {});
      }
    };
  }, [inEditMode, orderId]);
  // Also release when the modal is closed without unmounting (stays mounted)
  useEffect(() => {
    if (!isOpen && inEditMode && orderId) {
      releaseLockRef.current(orderId).catch(() => {});
    }
  }, [isOpen, inEditMode, orderId]);

  /**
   * THE CALL FORM THAT WAS NOT HERE.
   *
   * A result map, three pieces of state and a submit handler for
   * `/api/orders/[id]/call-logs` lived here and NOTHING RENDERED ANY OF IT —
   * the form itself had been removed and its machinery left behind. It read
   * as a feature to anybody looking at the file, and it kept a second door to
   * closing an order alive in the reader's mind while the real one is in
   * `ConfirmationActions`.
   *
   * Calls are logged where they are made: the confirmation screen, which
   * demands a structured reason before it will reject anything. The last of
   * its state — a note nothing read — went with the form.
   */


  /**
   * THE EDIT FORM THAT WAS NOT HERE EITHER.
   *
   * A hundred lines stood here — a lock acquirer, a seven-field draft, a
   * validator and a PATCH — and NOTHING CALLED ANY OF IT. openEditForm and
   * handleEditSave were each referenced exactly once, at their own
   * definitions. Editing moved into CustomerCard and OrderLinesCard, which
   * take the same server lock and ask the two questions separately; the
   * machinery for the form they replaced stayed behind and read, to anybody
   * opening this file, as a third way to edit an order.
   *
   * OrderRegionField went with it, and it was the worse of the two: a
   * complete, working governorate picker, never rendered, sitting beside the
   * live one in CustomerCard — two answers to «which governorate is this
   * order in», one of them unreachable.
   */

  useEffect(() => {
    if (isOpen && orderId) loadOrder(orderId);
  }, [isOpen, orderId]);

  // Monotonic request counter for loadOrder — guards against out-of-order
  // responses when navigating prev/next rapidly (stale response discarded)
  const loadOrderSeq = useRef(0);

  const loadOrder = async (id: string) => {
    const seq = ++loadOrderSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      // Forwarded by name rather than one line per filter: the line that
      // was missing is how the arrows came to walk a different list.
      for (const [key, value] of Object.entries(filters ?? {})) {
        if (value && value !== 'all') params.set(key, value);
      }
      const res = await apiFetch(`/api/orders/${id}?${params.toString()}`);
      // Discard stale response — a newer loadOrder (rapid prev/next) superseded it
      if (seq !== loadOrderSeq.current) return;
      if (res.ok) {
        const data = await res.json();
        setOrder(data.order);
        if (data.currency) setCurrency(data.currency);
        setDialCode(data.dialCode ?? null);
        setCod(data.cod ?? null);
        // The merged timeline is its own endpoint so every screen shows the
        // same history, not whatever one table happens to hold.
        apiJson<{ events: typeof timeline }>(`/api/orders/${id}/timeline`)
          .then((t) => seq === loadOrderSeq.current && setTimeline(t.events))
          .catch(() => setTimeline([]));
        setNavIds({
          previousOrderId: data.previousOrderId ?? null,
          nextOrderId: data.nextOrderId ?? null,
        });
        // The cards that actually hold forms — CustomerCard, OrderLinesCard,
        // ShippingSection — are keyed off the order they are handed and
        // reset themselves. What used to be reset here belonged to a form
        // that no longer exists.
      } else {
        // 403/404 (not found / not assigned) — show a clear error panel
        const data = await res.json().catch(() => ({}));
        setOrder(null);
        setLoadError(data.errorAr || data.error || `HTTP ${res.status}`);
      }
    } catch (e: any) {
      if (seq !== loadOrderSeq.current) return;
      console.error(e);
      setLoadError(e?.message || 'فشل تحميل الطلب');
    } finally {
      // Only the latest request may clear the shared loading flag
      if (seq === loadOrderSeq.current) setLoading(false);
    }
  };

  const navigateToOrder = async (targetId: string, direction: 'prev' | 'next') => {
    if (navLoading || loading) return;
    setNavLoading(direction);
    try {
      await loadOrder(targetId);
      // Scroll modal body back to top so the user sees the new order's header
      // By the attribute the dialog puts on its own scrolling body, not by the
      // class names it happens to wear this month.
      document.querySelector('[data-modal-body]')?.scrollTo({ top: 0 });
    } finally {
      setNavLoading(null);
    }
  };


  if (!order && loading) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={t.loading}>
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--sys-destructive)]"></div>
        </div>
      </Modal>
    );
  }
  if (loadError) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={t.orders} maxWidth="md">
        <div className="py-6 text-center space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>
          <p className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-3 py-2.5 inline-block">
            {loadError}
          </p>
          <div className="flex justify-center gap-2">
            <Button size="sm" variant="outline" onClick={onClose}>
              {ar ? 'إغلاق' : 'Close'}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }
  if (!order) return null;

  const isNavigating = navLoading !== null || loading;

  /**
   * HAS THE COURIER TAKEN THE PARCEL? — the press of «إغلاق الشحنة — سُلّمت
   * للشركة», not the printer. Until then cancelling and postponing are still
   * ours to do; after it they are a message to the company.
   */
  const handedOver = handedToCourier({
    shippingStatus: order.shippingStatus,
    shippedAt: order.shippedAt ?? null,
    batchStatus: order.shippingBatch?.status ?? null,
  });

  // ─── Phase C: lock state helpers ───
  const lockActive = !!order.lockedById && !!order.lockExpiresAt && new Date(order.lockExpiresAt).getTime() > nowMs;
  const editingLockedByOther = lockActive && order.lockedById !== currentUser?.id;
  const lockHolderName = order.lockHolder?.name || order.lockedById || '';

  /** Enter edit mode: acquire the backend lock first (Phase B), only then allow edits */
  const handleEnterEditMode = async () => {
    if (!order?.id) return;
    const lock = await ownership.acquireLock(order.id);
    if (lock.ok) {
      setOrder((prev: any) => ({
        ...prev,
        lockedById: currentUser?.id,
        lockHolder: { id: currentUser?.id, name: currentUser?.name },
        // Refresh the expiry from the server — otherwise lockActive stays false
        // when the previous lock had already expired and RiSaveLine never appears
        lockExpiresAt: lock.lockExpiresAt ?? prev.lockExpiresAt,
      }));
    } else if (lock.error) {
      // The door's refusal, in its words, where the other answers of this window are.
      setActionFeedback({ type: 'error', text: lock.error });
    }
  };

  // The store's currency, the same one the orders list prints.
  const money = (n: number) => amount(n, currency);

  const mayRecordCalls =
    userCan(currentUser, 'orders.confirm') || userCan(currentUser, 'confirmation.work');

  /*
   * AN AGENT WORKS ONLY THE ORDER SHE HOLDS (the owner, 1/11 — twenty orders confirmed straight from the orders list, never pulled).
   * The doors refuse an agent on an order that is not in her hands (`NOT_HELD`); a panel of call and confirm buttons whose every press
   * is refused is worse than a sentence that says what to do, so for her, on an order still waiting to be decided, the panel is replaced
   * by that sentence. A supervisor and the owner see the panel on any order, as before.
   */
  const mustPullFirst = agentMustPullFirst({
    holds: (permission) => userCan(currentUser, permission),
    userId: currentUser?.id,
    order,
  });

  // Derived here from the order the screen already holds — the same way the
  // state and the zone are derived, and never stored.
  const stages = orderStages(order, {
    contactAttempts: order._count?.contactAttempts,
    deliveryAttempts: order._count?.deliveryAttempts,
  });

  /*
   * THE CALL — DRAWN ONCE, PLACED BY THE WIDTH (ORD-06).
   *
   * On a desk it ends the left column, where it always has. On a phone the same column was ten cards long and
   * an agent who opened an order to confirm it scrolled past eight of them to reach the call outcome. So a phone
   * draws it right after the customer — the person she is about to ring — and the lines, the shipping, the stages
   * and the notes come after it. One copy: the block is built here and put in one place or the other.
   */
  const callBlock = (
    <>
            {/* Recording a call outcome is the confirmation agent's job. For an
                owner this screen is oversight, and a panel of buttons whose
                every press the server refuses is worse than no panel. The
                server still enforces it — this only stops offering it. */}
            {/*
              THE THREE THINGS A CUSTOMER SAYS AFTER CONFIRMATION.

              This door existed on one screen only — the agent's own queue,
              which lists orders still in her hands. The moment an order left
              them there was nowhere to ask anything about it, and this modal
              is where a confirmed, batched or dispatched order is actually
              opened. So the customer who rings to cancel a parcel that is
              already out reached a system with no door for it at all.

              A card, not a link in a corner: asking is the only thing anybody
              can do to a sealed order, so it is the one control that must be
              visible without hunting for it.
            */}
            {order.confirmationStatus === 'CONFIRMED' && mayRequestChange && (
              <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 shadow-raised space-y-2">
                <h4 className="text-xs font-black text-[var(--sys-foreground)]">
                  طلبٌ على هذا الطلب
                </h4>
                <p className="text-xs text-[var(--sys-muted-foreground)]">
                  {handedOver
                    ? 'الطرد عند شركة الشحن — التعديل والإلغاء يمرّان برسالةٍ إليهم بعد الموافقة.'
                    : 'الطلب مؤكَّد وللقراءة فقط — تعديلُه أو إلغاؤه أو تأجيلُه يمرّ بقرار.'}
                </p>
                <button
                  type="button"
                  onClick={() => setAskOpen(true)}
                  className="min-h-11 md:min-h-0 inline-flex items-center rounded-lg border border-[var(--sys-border)] px-4 py-1.5 text-xs font-medium text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
                >
                  تعديل · إلغاء · تأجيل
                </button>
              </div>
            )}

            {/*
              ABOVE THE BUTTONS, AND ONLY FOR WHOEVER WORKS THE PHONE.
              The courier's statements say 29.8% of this shop's parcels come
              back; once the waybill is printed that is a round trip whatever
              anybody learns afterwards. So the one place this belongs is the
              moment before the call ends. See orders/ShapeRiskPanel.
            */}
            {mayRecordCalls && order?.id && <DuplicateSuspectNotice orderId={order.id} />}
            {mayRecordCalls && order?.id && userCan(currentUser, 'insights.view') && <ShapeRiskPanel orderId={order.id} />}

            {mayRecordCalls && mustPullFirst && (
              <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 shadow-raised space-y-1">
                <h4 className="text-xs font-black text-[var(--sys-foreground)]">الطلب مو بين يديك</h4>
                <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  {NOT_HELD_MESSAGE}. اسحبه من «اسحب التالي» أو افتحه من «طلباتي»، وبعدها اتصل وأكّد.
                </p>
              </div>
            )}
            {mayRecordCalls && !mustPullFirst && (
            <ConfirmationActions
              order={order}
              ar={ar}
              isRtl={isRtl}
              onRefreshOrder={async () => {
                if (order?.id) await loadOrder(order.id);
                onRefresh();
              }}
            />
            )}
    </>
  );

  /*
   * WHERE THE ORDER CAME FROM, ONE FACT PER ENTRY.
   *
   * The header joined up to seven facts with « • » in one string — channel, source, landing page, offer, the
   * Telegram message and thread — which at 295px wrapped to four or six lines of mixed Arabic and Latin that
   * flip direction mid-line (ORD-10). A desk still reads them in the header, joined exactly as before; a phone
   * keeps the date and the channel there and lists the rest, one box each, in «جهة الطلب».
   */
  const telegramMessage = (order as any).telegramMessages?.[0];
  const originFacts = [
    `قناة الطلب: ${order.source.split(' → ')[0]}`,
    order.source.includes(' → ') ? `المصدر: ${order.source.split(' → ')[1]}` : null,
    order.source === 'Landing Page' && order.landingPage?.name ? `صفحة الهبوط: ${order.landingPage.name}` : null,
    order.offer?.name ? `العرض: ${order.offer.name}` : null,
    (order.source === 'Telegram' || order.source.startsWith('Telegram → ')) && telegramMessage
      ? `تيليجرام: رسالة #${telegramMessage.messageId}${telegramMessage.threadId ? ` • موضوع: ${telegramMessage.threadName || telegramMessage.threadId}` : ''}`
      : null,
  ].filter((fact): fact is string => !!fact);
  const subtitle = `أُنشئ في ${arDateTime(order.createdAt)}${(phone ? originFacts.slice(0, 1) : originFacts).map((fact) => ` • ${fact}`).join('')}`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`الطلب ${order.orderNumber}`}
      subtitle={subtitle}
      maxWidth="4xl"
    >
      {/* ─── Prev/Next order navigation (below the header, inside the modal) ───
        *
        * DRAWN ONLY WHEN THERE IS SOMEWHERE TO GO.
        *
        * The server stopped returning neighbour ids to anybody without
        * `orders.navigate`, and the two buttons went on rendering —
        * permanently grey, on every order, indistinguishable from the end
        * of a list. That is the same thing this change set out to stop on
        * «الطلبات»: a control that is visible and refuses reads as a broken
        * system rather than as a boundary.
        *
        * Keyed on the ids rather than on the permission, because the ids
        * are what the buttons DO. A person at the end of their list has
        * nothing to go to either, and the row has nothing to say to them.
        */}
      {(navIds.previousOrderId || navIds.nextOrderId) && (
      <div
        className={`flex items-center justify-between gap-2 mb-4 -mt-1 ${isRtl ? 'flex-row-reverse' : ''}`}
        dir={isRtl ? 'rtl' : 'ltr'}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={!navIds.nextOrderId || isNavigating}
          onClick={() => navIds.nextOrderId && navigateToOrder(navIds.nextOrderId, 'next')}
          title={ar ? 'الطلب التالي (الأحدث)' : 'Next order (newer)'}
        >
          {navLoading === 'next' ? (
            <span className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-[var(--sys-destructive)]" />
          ) : (
            <RiArrowRightSLine className="icon-mirror w-4 h-4" />
          )}
          <span className="hidden sm:inline">{ar ? 'الطلب التالي' : 'Next Order'}</span>
        </Button>

        <span className="text-xs text-[var(--sys-muted)] font-medium">
          {navLoading || loading ? (ar ? 'جارٍ التحميل…' : 'Loading…') : ''}
        </span>

        <Button
          size="sm"
          variant="outline"
          disabled={!navIds.previousOrderId || isNavigating}
          onClick={() => navIds.previousOrderId && navigateToOrder(navIds.previousOrderId, 'prev')}
          title={ar ? 'الطلب السابق (الأقدم)' : 'Previous order (older)'}
        >
          {navLoading === 'prev' ? (
            <span className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-[var(--sys-destructive)]" />
          ) : (
            <RiArrowLeftSLine className="icon-mirror w-4 h-4" />
          )}
          <span className="hidden sm:inline">{ar ? 'الطلب السابق' : 'Previous Order'}</span>
        </Button>
      </div>
      )}
      {/* Action feedback (status update / call log) */}
      {actionFeedback && (
        <div
          className={`mb-4 rounded-lg border p-2.5 text-xs flex items-center justify-between gap-2 ${
            actionFeedback.type === 'success'
              ? 'border-[var(--sys-success)]/60 bg-[var(--sys-success-soft)] text-[var(--sys-success)]'
              : 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]'
          }`}
          dir={isRtl ? 'rtl' : 'ltr'}
        >
          <span className="leading-relaxed">{actionFeedback.text}</span>
          <DismissButton onClick={() => setActionFeedback(null)} />
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5" dir={isRtl ? 'rtl' : 'ltr'}>
        {/* ─── Left column ─── */}
        <div className="lg:col-span-2 space-y-5">

          {/* Whose hands it is in, and the two things anyone wants to do
              about that. The six read-only ownership fields it replaced said
              "—" on nearly every order. */}
          <OrderResponsibility
            order={order}
            currentUserId={currentUser?.id}
            onChanged={async () => {
              if (order?.id) await loadOrder(order.id);
              onRefresh();
            }}
          />

          {/* The state, and the facts that travel with it. No button: the
              edit lock is taken by whichever card you actually edit, and a
              standalone "تعديل" here neither advanced nor stopped anything. */}
          <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-4 py-3 shadow-raised">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-xs font-semibold text-[var(--sys-muted)]">حالة الطلب</span>
              <OrderStateBadge state={order.state} />

              {order.deliveryProvider && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[var(--sys-border)] bg-[var(--sys-surface)] text-xs font-semibold text-[var(--sys-muted-foreground)]">
                  {order.deliveryProvider.kind === 'AGENT' ? (
                    <RiEBike2Line className="w-4 h-4 text-[var(--sys-primary)]" />
                  ) : (
                    <RiTruckLine className="w-4 h-4 text-[var(--sys-muted)]" />
                  )}
                  {order.deliveryProvider.name}
                </span>
              )}
              {order.trackingNumber && (
                <span className="px-2.5 py-1 rounded-full border border-[var(--sys-border)] bg-[var(--sys-surface)] text-xs font-mono text-[var(--sys-muted-foreground)]" dir="ltr">
                  {order.trackingNumber}
                </span>
              )}
              {order.settlementStatus && order.settlementStatus !== 'NOT_APPLICABLE' && (
                <span
                  className={`px-2.5 py-1 rounded-full border text-xs font-semibold ${
                    order.settlementStatus === 'SETTLED'
                      ? 'bg-[var(--sys-success-soft)] border-[var(--sys-success)]/40 text-[var(--sys-success)]'
                      : 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/40 text-[var(--sys-warning)]'
                  }`}
                >
                  {SETTLEMENT_AR[order.settlementStatus] ?? order.settlementStatus}
                </span>
              )}

              {/*
                IS IT FINISHED? — TWO STAGES, AND A PARTIAL RUNS BOTH.
                «الكاش لحال والمرتجع لحال». The chip beside this says what
                settlement CALLS the order; these say what the business is
                still waiting for. A delivered parcel whose money is in a
                courier's pocket is not finished, and a partly delivered one
                is unfinished twice: the money for what was kept, and the
                units that were refused. The rule is in lib/order-closing —
                this only renders it.
              */}
              {order.closing && (order.closing.cash !== 'NONE' || order.closing.goods !== 'NONE') && (
                <span className="inline-flex items-center gap-1.5">
                  {(['cash', 'goods'] as const)
                    .filter((k) => order.closing[k] !== 'NONE')
                    .map((k) => (
                      <span
                        key={k}
                        title={order.closing.why}
                        className={`px-2.5 py-1 rounded-full border text-xs font-semibold ${
                          order.closing[k] === 'DONE'
                            ? 'bg-[var(--sys-success-soft)] border-[var(--sys-success)]/40 text-[var(--sys-success)]'
                            : 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/40 text-[var(--sys-warning)]'
                        }`}
                      >
                        {STAGE_AR[k]}: {STAGE_STATE_AR[order.closing[k] as StageState]}
                      </span>
                    ))}
                </span>
              )}

              {editingLockedByOther && (
                <span className="ms-auto text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-2.5 py-1 inline-flex items-center gap-1.5">
                  <RiLockLine className="w-4 h-4" />
                  {t.editingBy} {lockHolderName}
                </span>
              )}
            </div>
          </div>

          {/* The figure to read aloud on the call, where the call is — the full summary is further down, as before. */}
          {phone && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-4 py-3 shadow-raised">
              <span className="text-xs font-bold text-[var(--sys-muted-foreground)]">المحصَّل عند الباب</span>
              <span className="font-black text-[var(--sys-heading)] text-sm" dir="ltr">
                {money(cod?.cod ?? order.totalAmount)}
              </span>
            </div>
          )}

          <CustomerCard
            order={order}
            dialCode={dialCode}
            canEdit={order.lockedById === currentUser?.id && lockActive}
            onAcquireLock={handleEnterEditMode}
            onSaved={async () => {
              if (order?.id) await loadOrder(order.id);
              onRefresh();
            }}
            onOpenHistory={() => setHistoryOpen(true)}
          />

          {phone && callBlock}

          <OrderLinesCard
            order={order}
            currency={currency}
            canEdit={order.lockedById === currentUser?.id && lockActive}
            onAcquireLock={handleEnterEditMode}
            onSaved={async () => {
              if (order?.id) await loadOrder(order.id);
              onRefresh();
            }}
          />

          {/* ─── Phase D2: Shipping & delivery section ─── */}
          <ShippingSection
            order={order}
            ar={ar}
            isRtl={isRtl}
            canEdit={mayChangeShipping}
            canChangeFee={mayChangeFee}
            canCopyRatingLink={mayCopyRatingLink}
            onRefreshOrder={async () => {
              if (order?.id) await loadOrder(order.id);
              onRefresh();
            }}
          />

          {/* How far it has got, when, and by whom. Not a control: a passed
              stage is a record, and a record you can edit is not a record. */}
          <OrderStages stages={stages} />

          {/* What was said about it, under what happened to it. */}
          <OrderNotes orderId={order.id} canWrite={mayWriteNote} />

          {!phone && callBlock}

        </div>

        {/* ─── Right column ─── */}
        <div className="space-y-5">
          {/* Financial overview */}
          <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 shadow-raised space-y-3">
            <h4 className="text-xs font-black text-[var(--sys-foreground)] flex items-center gap-2">
              <RiMoneyDollarCircleLine className="w-4 h-4 text-[var(--sys-destructive)]" />
              الملخص المالي
            </h4>

            <div className="flex items-center gap-3 p-2.5 bg-[var(--sys-surface)] rounded-lg">
              <ProductThumb
                src={order.productImageSnapshot || order.product?.image}
                alt={order.productNameSnapshot || order.product?.name}
                size="md"
              />
              <div className="min-w-0">
                <p className="text-xs text-[var(--sys-muted)]">المنتج</p>
                <p className="text-xs font-bold text-[var(--sys-heading)] line-clamp-2">
                  {order.productNameSnapshot || order.product?.name}
                </p>
              </div>
            </div>

            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-[var(--sys-muted-foreground)]">العرض / الكمية:</span>
                <span className="font-medium text-[var(--sys-heading)]">
                  {order.offer?.name || 'مباشر'} ({order.quantity} {t.units}{order.freeQuantity ? ` + ${order.freeQuantity} هدية` : ''})
                </span>
              </div>
              {/*
                  «زيادة بعد الطلب» — WHEN it happened, not only what it is.

                  Every `OrderAddOn` is a line the CUSTOMER added on the
                  thank-you screen after their order was taken: either from
                  the page's recommendation list or by accepting the
                  product's post-order offer. «منتجات إضافية» named the row
                  and said nothing about the moment, and the moment is the
                  whole of what the person on the phone needs — a line the
                  customer chose before anybody called is not a line this
                  agent sold, and the total they are about to read aloud
                  moved after the order was placed.

                  The words come from `POST_ORDER_ADDITION_AR`, the same
                  constant the server writes into the activity entry, so the
                  timeline and this row can never say two different things.
              */}
              {order.addOns?.length > 0 && (
                <div className="flex justify-between">
                  <span className="text-[var(--sys-muted-foreground)]">{POST_ORDER_ADDITION_AR}:</span>
                  <span className="font-medium text-[var(--sys-heading)] text-end">
                    {order.addOns.map((a: any) => `${a.productName} ×${a.quantity} (${money(a.total)})`).join(' + ')}
                  </span>
                </div>
              )}

              {/* What the customer pays. The figures come from the one COD
                  function on the server — a screen never adds up money. */}
              <div className="mt-2 rounded-lg border border-[var(--sys-border)] divide-y divide-[var(--sys-border)]">
                <p className="text-xs font-bold text-[var(--sys-muted-foreground)] px-2.5 py-1.5 bg-[var(--sys-surface)] rounded-t-lg">
                  ما يدفعه العميل
                </p>
                <div className="flex justify-between px-2.5 py-1.5">
                  <span className="text-[var(--sys-muted-foreground)]">قيمة البضاعة:</span>
                  <span className="text-[var(--sys-heading)]" dir="ltr">{money(cod?.subtotal ?? order.sellingPrice)}</span>
                </div>
                {!!cod?.discount && (
                  <div className="flex justify-between px-2.5 py-1.5">
                    <span className="text-[var(--sys-muted-foreground)]">الخصم:</span>
                    <span className="text-[var(--sys-foreground)]" dir="ltr">− {money(cod.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between px-2.5 py-1.5">
                  <span className="text-[var(--sys-muted-foreground)]">
                    أجرة التوصيل:
                    {cod?.includesDelivery && (
                      <span className="text-[var(--sys-muted)]"> (داخلة في السعر)</span>
                    )}
                  </span>
                  {/* The fee follows the courier, and the courier is chosen when
                      the shipment is created. Before that it is undecided, not
                      zero — printing 0.00 here reads as free delivery. */}
                  {!order.deliveryProvider && !Number(cod?.deliveryFee ?? 0) ? (
                    <span className="text-[var(--sys-muted)] text-xs">تُحدَّد عند إنشاء الشحنة</span>
                  ) : (
                    <span className="text-[var(--sys-foreground)]" dir="ltr">{money(cod?.deliveryFee ?? order.shippingCost)}</span>
                  )}
                </div>
                {/* The box from the order form, until the parcel leaves: an order written without it is a plain price and the fee
                    is added at the shipment. The door asks again; the figures it shows before the press are its own. */}
                {mayTellDelivery(order, mayChangeFee, handedOver) && (
                  <div className="px-2.5 py-1.5">
                    <DeliveryIncludedBox
                      orderId={order.id}
                      version={order.version}
                      included={order.priceIncludesDelivery === true}
                      currency={currency}
                      onChanged={async () => {
                        await loadOrder(order.id);
                        onRefresh();
                      }}
                    />
                  </div>
                )}
                <div className="flex justify-between px-2.5 py-2 bg-[var(--sys-surface)] rounded-b-lg">
                  <span className="font-bold">المحصَّل عند الباب:</span>
                  {/* Money coming IN, and the headline figure of the whole
                      order. It was painted with the colour that means "late,
                      or money lost" — which nobody noticed while the action
                      colour was a pink sitting next to that red. The list
                      shows the same number in the heading colour; this is
                      now the same number in the same colour. */}
                  <span className="font-black text-[var(--sys-heading)] text-sm" dir="ltr">
                    {money(cod?.cod ?? order.totalAmount)}
                  </span>
                </div>
              </div>

              {/* Costs are ours, not the customer's — kept apart so the column
                  above never reads as a sum that includes them. And only to
                  the finance key AND the cost key: the server sends them to nobody else. */}
              {userCan(currentUser, 'finance.view') && userCan(currentUser, 'costs.view') && (
              <div className="mt-2 rounded-lg border border-[var(--sys-border)] divide-y divide-[var(--sys-border)]">
                <p className="text-xs font-bold text-[var(--sys-muted-foreground)] px-2.5 py-1.5 bg-[var(--sys-surface)] rounded-t-lg">
                  تكاليفنا على هذا الطلب
                </p>
                <div className="flex justify-between px-2.5 py-1.5">
                  <span className="text-[var(--sys-muted-foreground)]">تكلفة البضاعة:</span>
                  <span className="text-[var(--sys-foreground)]" dir="ltr">{money(order.estimatedCostOfGoods)}</span>
                </div>
                <div className="flex justify-between px-2.5 py-1.5">
                  <span className="text-[var(--sys-muted-foreground)]">العمولة:</span>
                  <span className="text-[var(--sys-foreground)]" dir="ltr">{money(order.commission ?? 0)}</span>
                </div>
              </div>
              )}
            </div>
          </div>

          {/* Where the order came from. Editable, because the numbers are
              counted per channel and an order filed under the wrong one is a
              wrong number rather than a wrong label. */}
          <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 shadow-raised space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-black text-[var(--sys-foreground)] flex items-center gap-2">
                <RiUserFollowLine className="w-4 h-4 text-[var(--sys-primary)]" />
                جهة الطلب
              </h4>
              {/* The channel is the order's attribution — which campaign or
                  page the sale is credited to. Changing it moves that credit,
                  which is a different authority from fixing an address. The
                  server refuses it either way; hiding it just stops a button
                  that would only ever fail. */}
              {mayChangeChannel && (
                <button
                  onClick={() => { setChannelOpen((v) => !v); setChannelDraft(order.channelId ?? ''); }}
                  className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5"
                >
                  <RiPencilLine className="w-4 h-4" />
                  {channelOpen ? 'إغلاق' : 'تعديل'}
                </button>
              )}
            </div>

            {channelOpen ? (
              <div className="space-y-2">
                <select
                  value={channelDraft}
                  onChange={(e) => setChannelDraft(e.target.value)}
                  className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm focus:outline-none focus:border-[var(--sys-primary)]"
                >
                  <option value="">— بلا قناة —</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <button
                  onClick={saveChannel}
                  className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] font-medium"
                >
                  حفظ القناة
                </button>
                <p className="text-xs text-[var(--sys-muted)]">
                  القنوات تُدار من الإعدادات ← قنوات الطلبات.
                </p>
              </div>
            ) : (
              <>
                <p className="text-sm font-bold text-[var(--sys-heading)]">{order.source || '—'}</p>
                {order.moderator?.name && (
                  <p className="text-xs text-[var(--sys-muted)]">أدخله: {order.moderator.name}</p>
                )}
                {phone &&
                  originFacts.slice(1).map((fact) => (
                    <p key={fact} className="text-xs text-[var(--sys-muted)]" dir="auto">
                      {fact}
                    </p>
                  ))}
              </>
            )}
          </div>

          {/* Timeline — merged from every event table (src/lib/order-timeline.ts),
              not just the activity log, so it always matches the state above. */}
          <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 shadow-raised">
            <h4 className="text-xs font-black text-[var(--sys-foreground)] mb-3 flex items-center gap-2">
              <RiTimerLine className="w-4 h-4 text-[var(--sys-muted)]" />
              سجل الأحداث ({timeline.length})
              {timeline.length > 5 && (
                <button
                  onClick={() => setTimelineExpanded((v) => !v)}
                  className="ms-auto text-xs font-medium text-[var(--sys-primary)] hover:underline"
                >
                  {timelineExpanded ? 'إظهار الأحدث فقط' : `إظهار الكل (${timeline.length})`}
                </button>
              )}
            </h4>

            <div className="relative border-s-2 border-[var(--sys-border)] ms-2.5 space-y-4 text-xs">
              {/* Every order is created, so an empty timeline is not a
                  quiet order — it is a record whose events did not reach
                  the log. Saying «لا أحداث» invites somebody to shrug. */}
              {timeline.length === 0 && (
                <p className="ps-4 text-[var(--sys-muted-foreground)]">
                  لا حدثَ مسجَّلاً لهذا الطلب — ولو إنشاؤه. إن كان الطلب قديماً فقد سبق السجلّ؛ وإلّا فأبلغ عنه.
                </p>
              )}
              {(timelineExpanded ? timeline : timeline.slice(-5)).map((event) => (
                <div key={event.id} className="relative ps-4">
                  <span className="absolute -start-[7px] top-1 w-2.5 h-2.5 rounded-full bg-[var(--sys-destructive)] border-2 border-[var(--sys-card)]" />
                  <p className="font-bold text-[var(--sys-foreground)]">{event.title}</p>
                  {event.detail && <p className="text-[var(--sys-muted-foreground)] mt-0.5 break-words">{event.detail}</p>}
                  <p className="text-xs text-[var(--sys-muted)] mt-0.5">
                    {arDateShort(event.at)}
                    {event.actorName ? ` — ${event.actorName}` : ''}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/*
        «طلبات سابقة» DID NOTHING FROM THIS SCREEN.

        `CustomerCard`'s history button sets `historyOpen`, and the only place
        that read it was inside the `if (!order && loading)` early return —
        the loading skeleton, where `order` is null by definition. So on the
        one path where the button exists, pressing it rendered nothing; and
        had that branch ever been reached with the flag set, `order.customer`
        would have thrown. The customer's history was reachable from the list
        row and from «طلباتي», and not from the order itself, which is the
        screen somebody is looking at when they wonder whether this person has
        ordered before.

        It renders here, on the path where the order actually exists.
      */}
      {historyOpen && order.customer?.id && (
        <CustomerHistoryModal
          customerId={order.customer.id}
          orderId={order.id}
          holderId={userCan(currentUser, 'confirmation.work') ? currentUser?.id ?? null : null}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {askOpen && (
        <ChangeRequestDialog
          open
          orderNumber={order.orderNumber}
          busy={asking}
          handedToCourier={handedOver}
          onClose={() => setAskOpen(false)}
          onSubmit={(value: ChangeRequestValue) => {
            setAskOpen(false);
            setAsking(true);
            void raiseChangeRequest(order.id, value, order.version, {
              canOpenQueue: userCan(currentUser, 'control.change_requests'),
              order: { handed: handedOver, held: !!order.claimedById },
            })
              .then(async (answer) => {
                // The sentence says where the request went: carried out, waiting for a decision, or approved and waiting to be applied.
                setActionFeedback({ type: 'success', text: answer?.message ?? 'أُرسل الطلب — يصلك القرار إشعاراً.' });
                await loadOrder(order.id);
                onRefresh();
              })
              .catch((e) =>
                setActionFeedback({ type: 'error', text: e instanceof Error ? e.message : 'تعذر إرسال الطلب' })
              )
              .finally(() => setAsking(false));
          }}
        />
      )}
    </Modal>
  );
}
