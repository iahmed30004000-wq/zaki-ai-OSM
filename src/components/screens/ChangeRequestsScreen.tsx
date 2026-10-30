'use client';

import React, { useCallback, useRef, useState } from 'react';
import { apiFetch, apiJson } from '@/lib/api-client';
import { CourierNotifyDialog, type CourierAsk } from '@/components/orders/CourierNotifyDialog';
import { ChangeRequestReview } from '@/components/orders/ChangeRequestReview';
import { LinesRequestReview, type Verdict } from '@/components/orders/LinesRequestReview';
import { AUTO_CHECKED_CARDS, REVIEW_UNREADABLE_AR } from '@/lib/change-request-review';
import { OrderLink } from '@/components/orders/OrderLink';
import { useConfirm, useTell } from '@/components/ui/Confirm';
import { changeFieldLabel, describeLines, readLinesChange } from '@/lib/change-request-fields';
import { INTENT_AR, type ChangeIntent } from '@/lib/change-request-intent';
import { ATTESTATION_AR } from '@/lib/shipment-cancel';
import { PICKABLE_REJECTION_REASONS, REJECTION_REASON_AR } from '@/lib/confirmation-workflow';
import { deriveCoreState } from '@/lib/order-state';
import { OrderStateChip } from '@/components/ui/StatusChip';
import { ROLE_LABELS, type UserRole } from '@/types/auth';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiArrowGoBackLine, RiArrowLeftLine, RiCheckboxCircleLine, RiFileEditLine, RiLoader4Line } from '@remixicon/react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * /control/change-requests — the review queue, in its two halves.
 *
 * «بانتظار القرار»: somebody asked; somebody who can still reach the order
 * decides. Deciding opens the same dialog the packing line uses — a second
 * decision dialog would have been a second set of rules to keep in step.
 *
 * «بانتظار التطبيق»: decided, and not yet carried out. This half did not
 * exist. An approval recorded the decision and changed nothing on the
 * order, and on a sealed order — waybill printed, or on a van — the edit
 * that should have followed was refused by the very seal the request had
 * been raised to get past. Approved requests sat there, looking done.
 *
 * Applying sends the request's id and nothing else: the values are the
 * approved ones, taken on the server, and the edit runs through the order's
 * own money path.
 */

interface ChangeRequest {
  id: string;
  reason: string;
  status: string;
  blocking: boolean;
  /**
   * The parcel moved while this request was waiting to be decided. A feed
   * never blocks, so a courier can carry the order past the request — and
   * deciding one without knowing that is deciding about an order that no
   * longer exists in the shape it was raised against.
   */
  changedDuringReview: boolean;
  createdAt: string;
  slaDueAt: string | null;
  overdue: boolean;
  decisionNote: string | null;
  requestedByName: string | null;
  requestedRole: string;
  /** Raised by the person reading the screen. */
  isMine: boolean;
  /** EDIT | CANCEL | POSTPONE. Absent on rows raised before it existed. */
  intent?: ChangeIntent | null;
  postponeUntil: string | null;
  cancelReason: string | null;
  /** What pressing the button will actually do — decided by the server. */
  carryOut: { kind: string; reason?: string };
  /** Each field as a from/to pair; the key lines (a request that edits several lines) is the one that is not. */
  changes: Record<string, unknown>;
  /** The names behind the product ids of a lines request, from the server. */
  lineNames?: Record<string, string>;
  order: {
    id: string;
    orderNumber: string;
    confirmationStatus: string;
    shippingStatus: string;
    /** Optimistic concurrency — the order route refuses a write without it. */
    version: number;
    customer: { fullName: string; phone: string };
  };
}

type Tab = 'PENDING' | 'AWAITING_APPLY';

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

/**
 * WHAT EACH TAB MEANS, said under the tabs.
 *
 * «حتى لما رفعت طلب تعديل ما ظهر بطلبات التعديل»: a request its raiser may also decide is approved the moment it is
 * raised, so it never waits in «بانتظار القرار» — it goes straight to «بانتظار التطبيق», and the first tab read «0» while
 * the second held the request. Each tab now says what it holds, and a screen that opens on an empty tab points at the full one.
 */
const TAB_AR: Record<Tab, { label: string; means: string }> = {
  PENDING: { label: 'بانتظار القرار', means: 'طلبات لسا ما حدا بتّ فيها: وافق أو ارفض.' },
  AWAITING_APPLY: { label: 'بانتظار التطبيق', means: 'طلبات اعتُمدت ولسا ما انكتبت على الطلب — اضغط التنفيذ.' },
};

/** The fields of a request that are from/to pairs — everything but the lines, which have their own section. */
function fieldPairs(r: ChangeRequest): Array<[string, { from?: unknown; to?: unknown }]> {
  return Object.entries(r.changes ?? {}).filter(([f]) => f !== 'lines') as Array<[string, { from?: unknown; to?: unknown }]>;
}

/** A request that edits lines, read strictly — null for any other, and for one whose lines cannot be read. */
function linesOf(r: ChangeRequest) {
  const read = readLinesChange(r.changes);
  return read.ok ? read.value : null;
}

/**
 * A request that CARRIES lines the apply door cannot read (a hand-edited row, a shape from before the schema): the door
 * answers 422 when pressed, so the button is shut now, with the sentence — failing closed, not failing on the press.
 */
function linesUnreadable(r: ChangeRequest): boolean {
  return 'lines' in (r.changes ?? {}) && !readLinesChange(r.changes).ok;
}

/** One sentence per edited line, with the product names the server sent. */
function lineSentences(r: ChangeRequest): string[] {
  const change = linesOf(r);
  if (!change) return [];
  const snap = change.snapshot as { minorUnit?: unknown } | undefined;
  return describeLines(change, {
    ...(typeof snap?.minorUnit === 'number' ? { minorUnit: snap.minorUnit } : {}),
    names: r.lineNames ?? {},
  });
}

export function ChangeRequestsScreen() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('PENDING');
  /** The tab is picked once, on the first load, and never moved under a hand that already chose. */
  const tabChosen = useRef(false);
  /** What the check of each lines request waiting to be carried out says, by request. */
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [lists, setLists] = useState<Record<Tab, ChangeRequest[]> | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  /** The request whose parcel is already with the courier, and what to send them. */
  /** The country's calling code, for the courier's WhatsApp. */
  const [dialCode, setDialCode] = useState<string | null>(null);
  const [courierFor, setCourierFor] = useState<{ request: ChangeRequest; ask: CourierAsk } | null>(null);
  /** The reason picked on each old cancellation that was stored without one, by request. */
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const confirm = useConfirm();
  const tell = useTell();

  const load = useCallback(async () => {
    try {
      // Both at once: the tab counts are the point, so a decision that just
      // moved a request from one list to the other shows on both.
      const [pending, awaiting] = await Promise.all([
        apiJson<{ requests: ChangeRequest[]; dialCode?: string | null }>('/api/control/change-requests?status=PENDING'),
        apiJson<{ requests: ChangeRequest[] }>('/api/control/change-requests?status=AWAITING_APPLY'),
      ]);
      setLists({ PENDING: pending.requests, AWAITING_APPLY: awaiting.requests });
      // Open on the tab that has something: a request approved on the spot never waits in the first one.
      if (!tabChosen.current) {
        tabChosen.current = true;
        if (pending.requests.length === 0 && awaiting.requests.length > 0) setTab('AWAITING_APPLY');
      }
      setDialCode(pending.dialCode ?? null);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  /**
   * TAKE BACK A REQUEST YOU RAISED.
   *
   * A pending request is not inert: a blocking one stops the order from
   * moving forward, and any pending one refuses a second request on the same
   * order. So the corrected request could not be raised until somebody else
   * cleared the wrong one.
   */
  async function withdraw(r: ChangeRequest) {
    const ok = await confirm({
      title: `اسحب طلبك على ${r.order.orderNumber}؟`,
      body: 'يُلغى الطلب ويعود الطلبُ إلى التقدّم الطبيعي، ويمكنك رفعُ طلبٍ مصحَّح بعده. يُسجَّل السحب على الطلب.',
      confirmLabel: 'اسحبه',
      tone: 'danger',
    });
    if (!ok) return;

    setWithdrawing(r.id);
    try {
      await apiJson(`/api/control/change-requests/${r.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      await tell({
        title: 'تعذر سحب الطلب',
        body: e instanceof Error ? e.message : 'حدث خطأ',
        tone: 'danger',
      });
    } finally {
      setWithdrawing(null);
    }
  }

  /**
   * WHAT THE BUTTON SAYS, AND WHERE IT PRESSES.
   *
   * «طبّق التعديل على الطلب» on a cancellation is a lie about what is
   * about to happen, and the edit endpoint would have answered it with
   * «لا حقول لتطبيقها». Each ask is carried out through the door that
   * already does that thing, and the confirmation names the act.
   */
  const CARRY_LABEL: Record<string, string> = {
    EDIT_ORDER: 'طبّق التعديل على الطلب',
    CANCEL_ORDER: 'ألغِ الطلب',
    CANCEL_VIA_COURIER: 'أبلغ شركة الشحن بالإلغاء',
    HOLD_SHIPMENT: 'أجّل الشحن',
  };

  /**
   * AN OLD CANCELLATION STORED WITHOUT ITS REASON.
   *
   * Raised before the reason was saved, approved, and refused on every press
   * with «سبب الإلغاء مطلوب». Nothing guesses a reason for it: the person
   * carrying it out picks one here, from the same list, before the button
   * works. A cancellation that is a message to the courier needs none.
   */
  const needsReason = (r: ChangeRequest) =>
    (r.intent ?? 'EDIT') === 'CANCEL' && !r.cancelReason && r.carryOut?.kind !== 'CANCEL_VIA_COURIER';

  /**
   * THE SENTENCE THAT SHUTS «نفِّذ» FOR A LINES REQUEST, or null.
   *
   * The check is the server's (the request's preview): the request is carried out only if the order, as it stands now,
   * can still take it. While the check is in the air the button waits too, so nobody presses it on a guess.
   */
  const gateShut = (r: ChangeRequest): string | null => {
    if (linesUnreadable(r)) return REVIEW_UNREADABLE_AR;
    if (!linesOf(r)) return null;
    const v = verdicts[r.id];
    // A card nobody has asked about (or one the budget said «wait» to) is not shut: the apply door judges it on the press,
    // and the card carries an «افحص» button (its verdict has no sentence, so nothing shuts it). A check that FAILED is shut.
    return !v || v.checking ? 'جارٍ فحص الطلب…' : v.shut;
  };

  async function apply(r: ChangeRequest) {
    const intent = (r.intent ?? 'EDIT') as ChangeIntent;
    if (needsReason(r) && !chosen[r.id]) return;
    // Built first, and not nested three templates deep inside the ternary:
    // the currency guard walks the source blanking templates, and a
    // template inside a template inside a template is where it loses the
    // thread and reports an innocent line as a typed «$».
    const lines = [
      ...fieldPairs(r).map(([f, v]) => `${changeFieldLabel(f)}: ${v?.from !== undefined ? `${show(v.from)} ← ` : ''}${show(v?.to)}`),
      ...lineSentences(r),
    ].join('\n');
    const body =
      intent === 'EDIT'
        ? `${lines}\n\nيُكتب على الطلب بالقيم المعتمدة كما هي، ويُسجَّل في سجل التدقيق مع سببه.`
        : intent === 'CANCEL'
          ? r.carryOut?.kind === 'CANCEL_VIA_COURIER'
            ? 'الطرد عند شركة الشحن: ستظهر لك رسالة جاهزة لها لتوقف الطرد. الطلب يبقى كما هو، ويرجع الطرد عبر المرتجعات ويتعدّ.'
            : `سبب الإلغاء: ${REJECTION_REASON_AR[r.cancelReason ?? chosen[r.id] ?? ''] ?? r.cancelReason ?? '—'}\n\n` +
              'تعود البضاعةُ المحجوزة إلى المخزون في المعاملة نفسها. وإن كانت بوليصتُه مطبوعة سنسألك إن كان الطرد بين يديك.'
          : `يُؤجَّل الشحن حتى ${String(r.postponeUntil ?? '').slice(0, 10)}\n\n` +
            'يبقى الطلب مؤكَّداً وتبقى بضاعتُه وبوليصتُه، ويخرج من الدفعة المفتوحة ويعود إلى قائمة الشحن يومَه.';

    const ok = await confirm({
      title: `${CARRY_LABEL[r.carryOut?.kind] ?? 'نفِّذ'} — ${r.order.orderNumber}؟`,
      body,
      confirmLabel: 'نفِّذ',
      tone: intent === 'CANCEL' ? 'danger' : undefined,
    });
    if (!ok) return;

    if (intent === 'EDIT') {
      await send(r, false);
      return;
    }
    await standDown(r, intent);
  }

  /**
   * A cancellation or a postponement, through the door that does it.
   *
   * The id and nothing else: the date and the structured reason come from
   * the approved request, on the server. Once the courier has the parcel
   * (the press of «إغلاق الشحنة — سُلّمت للشركة») the door refuses — and its
   * refusal is the message to the courier, which is the real remedy there.
   */
  async function standDown(r: ChangeRequest, intent: ChangeIntent, courierNotified = false, parcelInHand = false) {
    // The reason picked on the card, for an old request stored without one.
    const pickedReason = intent === 'CANCEL' && needsReason(r) ? chosen[r.id] : undefined;
    setApplying(r.id);
    try {
      /*
       * A POSTPONEMENT IS A HOLD, A CANCELLATION IS A STAND-DOWN.
       *
       * «أأجلو» means the customer still wants it, on a later day: the order
       * stays confirmed, its goods and waybill stay, and it leaves the open
       * trolley (`/api/ops/shipments/hold`). The stand-down's POSTPONE sends
       * the order back to the confirmation desk to be called again — a second
       * call the customer did not ask for.
       */
      const res = await apiFetch(intent === 'CANCEL' ? '/api/ops/shipments/stand-down' : '/api/ops/shipments/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          intent === 'CANCEL'
            ? {
                orderId: r.order.id,
                outcome: 'CANCEL',
                changeRequestId: r.id,
                ...(courierNotified ? { courierNotified: true } : {}),
                ...(parcelInHand ? { parcelInHand: true } : {}),
                // Only for a request stored without its reason: the server
                // ignores it for any request that has one.
                ...(pickedReason ? { reason: pickedReason } : {}),
              }
            : { orderId: r.order.id, changeRequestId: r.id }
        ),
      });
      const body = await res.json().catch(() => ({}));
      /*
       * A PACKED PARCEL: the units come back on a person's word. The server
       * names the sentence; the person ticks it, by name, and the same press
       * is repeated with it.
       */
      if (!res.ok && body?.code === 'ATTESTATION_REQUIRED') {
        setApplying(null);
        const said = await confirm({
          title: `الطرد ${r.order.orderNumber} مطبوعة بوليصته`,
          body: `${body.attestation ?? ATTESTATION_AR}\n\nبتأكيدك ينسجَّل اسمك على الطلب وتعود قطعه للمخزون.`,
          confirmLabel: 'أؤكد',
          tone: 'danger',
        });
        if (said) await standDown(r, intent, courierNotified, true);
        return;
      }
      /*
       * A PARCEL THE COMPANY HOLDS: the answer is the message to send them,
       * not a refusal. The same dialog the edit path uses, and the same two
       * steps — send it, then say you did.
       */
      if (!res.ok && body?.code === 'COURIER_ACTION_REQUIRED') {
        setCourierFor({
          request: r,
          ask: {
            action: body.action ?? 'CANCEL_WAYBILL',
            reason: body.errorAr ?? body.error ?? '',
            message: body.message ?? '',
            courier: body.courier ?? null,
          },
        });
        return;
      }
      if (!res.ok) throw new Error(body?.errorAr || body?.error || 'تعذر تنفيذ القرار');
      setCourierFor(null);
      await load();
    } catch (e) {
      await tell({
        title: 'تعذر تنفيذ القرار',
        body: e instanceof Error ? e.message : 'حدث خطأ',
        tone: 'danger',
      });
    } finally {
      setApplying(null);
    }
  }

  /**
   * THE WRITE, AND THE ONE THING THAT CAN STOP IT.
   *
   * `apiFetch` rather than `apiJson`, because the refusal that matters here
   * carries a body — which action, which courier, and the sentence to send
   * them — and `apiJson` throws away everything but the message.
   *
   * `courierNotified` is not a permission. It is a person saying the parcel's
   * holder has been told, and the server records that on the order with their
   * name before it writes anything.
   */
  async function send(r: ChangeRequest, courierNotified: boolean) {
    setApplying(r.id);
    try {
      /**
       * A CANCEL THE COMPANY HAS BEEN TOLD ABOUT IS NOT AN EDIT EITHER.
       *
       * The dialog is the same one and its button lands here; what it says
       * «done» to is the stand-down door, which marks the request carried
       * out and touches nothing on the order.
       */
      if (courierNotified && courierFor?.ask.action === 'CANCEL_WAYBILL') {
        await standDown(r, 'CANCEL', true);
        return;
      }

      /**
       * A CANCELLED WAYBILL IS NOT AN EDIT.
       *
       * The message the courier was just sent promises them a new waybill.
       * Writing the change onto this order instead would leave our record
       * saying a quantity that was never in the carton, on a parcel we
       * asked them to stop. The reorder door closes this one as a return
       * and raises the order we promised.
       */
      if (courierNotified && courierFor?.ask.action === 'CANCEL_AND_REORDER') {
        const made = await apiFetch(`/api/orders/${r.order.id}/reorder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ changeRequestId: r.id, courierNotified: true }),
        });
        const out = await made.json().catch(() => ({}));
        if (!made.ok) throw new Error(out?.errorAr || out?.error || 'تعذر إصدار الطلب البديل');
        setCourierFor(null);
        await load();
        toast.done(`صدر الطلب البديل ${out?.replacement?.orderNumber ?? ''}`);
        return;
      }

      const res = await apiFetch(`/api/orders/${r.order.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // The id, the version it was loaded at, and nothing else that is
        // a field of the order. The server rebuilds the edit from what was
        // approved; `expectedVersion` is on the short list of keys allowed
        // to ride along precisely because it changes nothing about WHAT is
        // applied, and the order route refuses any write without it.
        body: JSON.stringify({
          changeRequestId: r.id,
          expectedVersion: r.order.version,
          ...(courierNotified ? { courierNotified } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (body?.code === 'COURIER_ACTION_REQUIRED') {
          setCourierFor({
            request: r,
            ask: {
              action: body.action ?? 'CONTACT_CHANGE',
              reason: body.errorAr ?? body.error ?? '',
              message: body.message ?? '',
              courier: body.courier ?? null,
            },
          });
          return;
        }
        throw new Error(body?.errorAr || body?.error || 'تعذر تطبيق التعديل');
      }

      setCourierFor(null);
      await load();
    } catch (e) {
      await tell({
        title: 'تعذر تطبيق التعديل',
        body: e instanceof Error ? e.message : 'حدث خطأ',
        tone: 'danger',
      });
    } finally {
      setApplying(null);
    }
  }

  if (!lists) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  const rows = lists[tab];
  // The first cards of a long queue are checked on arrival; every other one waits for its «افحص» (a page of two hundred
  // checks at once would spend the person's whole budget before they had pressed anything).
  const checkedCards = new Set(lists.AWAITING_APPLY.filter((q) => linesOf(q)).slice(0, AUTO_CHECKED_CARDS).map((q) => q.id));
  const other: Tab = tab === 'PENDING' ? 'AWAITING_APPLY' : 'PENDING';

  return (
    <div className="max-w-4xl space-y-3">
      <ScreenTitle />


      <div className="flex gap-1 rounded-lg bg-[var(--sys-surface-strong)] p-0.5 w-fit">
        {(
          [
            ['PENDING', TAB_AR.PENDING.label],
            ['AWAITING_APPLY', TAB_AR.AWAITING_APPLY.label],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              tabChosen.current = true;
              setTab(key);
            }}
            className={`min-h-11 md:min-h-0 inline-flex items-center flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              tab === key ? 'bg-[var(--sys-card)] text-[var(--sys-primary)] shadow-raised' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-foreground)]'
            }`}
          >
            {label}
            <span
              className={`tabular-nums rounded-lg px-1.5 text-xs ${
                lists[key].length > 0 ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]' : 'bg-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
              }`}
            >
              {lists[key].length}
            </span>
          </button>
        ))}
      </div>

      <p className="text-xs text-[var(--sys-muted-foreground)]">{TAB_AR[tab].means}</p>

      {rows.length === 0 && (
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
          <EmptyState
            title={tab === 'PENDING' ? 'لا طلبَ ينتظر المراجعة' : 'لا قرارَ معتمَداً ينتظر التنفيذ'}
            why={
              tab === 'PENDING'
                ? 'الطلب المؤكَّد للقراءة فقط بالنسبة للموظّف: تغييرُه يمرّ من هنا. فراغُ القائمة يعني أنّ لا أحد طلب تغييراً.'
                : 'ما يُعتمد هنا يُطبَّق على الطلب مباشرةً. فراغُ القائمة يعني أنّ كلّ ما اعتُمد طُبِّق.'
            }
          />
        </div>
      )}

      {/* The other tab holds requests while this one is empty: say so, with the way there. */}
      {rows.length === 0 && lists[other].length > 0 && (
        <button
          type="button"
          onClick={() => {
            tabChosen.current = true;
            setTab(other);
          }}
          className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] text-[var(--sys-foreground)] text-xs font-medium"
        >
          افتح «{TAB_AR[other].label}» — فيه {lists[other].length} طلب
        </button>
      )}

      {rows.map((r) => {
        const role = ROLE_LABELS[r.requestedRole as UserRole]?.ar ?? r.requestedRole;
        const state = deriveCoreState(r.order);
        return (
          <article key={r.id} className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 space-y-3">
            <header className="flex flex-wrap items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] flex items-center justify-center">
                {tab === 'PENDING' ? (
                  <RiFileEditLine className="w-4 h-4 text-[var(--sys-primary)]" />
                ) : (
                  <RiCheckboxCircleLine className="w-4 h-4 text-[var(--sys-success)]" />
                )}
              </span>
              <OrderLink id={r.order.id} number={r.order.orderNumber} className="font-semibold text-[var(--sys-heading)]" />
              {/* WHICH OF THE THREE. Every row said «طلب تعديل» and a
                  cancellation read as a field edit — answered like one. */}
              <span
                className={`text-xs px-2 py-0.5 rounded-md border ${
                  (r.intent ?? 'EDIT') === 'CANCEL'
                    ? 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]'
                    : (r.intent ?? 'EDIT') === 'POSTPONE'
                      ? 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/30 text-[var(--sys-warning)]'
                      : 'bg-[var(--sys-surface)] border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                }`}
              >
                {INTENT_AR[(r.intent ?? 'EDIT') as ChangeIntent]}
              </span>
              {/* The one chip. Drawn here by hand it was always grey, so a
                  cancelled order and a delivered one looked the same. */}
              <OrderStateChip state={state} />
              {tab === 'PENDING' && r.blocking && (
                <span className="text-xs px-2 py-0.5 rounded-md bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]">
                  يوقف تقدّم الطلب
                </span>
              )}
              {tab === 'PENDING' && r.overdue && (
                <span className="text-xs px-2 py-0.5 rounded-md bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 text-[var(--sys-warning)]">
                  تجاوز مهلة المراجعة
                </span>
              )}
              {/* Beside the state chip on purpose: the sentence is about that
                  chip having changed, not about the request. */}
              {tab === 'PENDING' && r.changedDuringReview && (
                <span className="text-xs px-2 py-0.5 rounded-md bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 text-[var(--sys-warning)]">
                  تغيّرت حالة الطلب أثناء المراجعة
                </span>
              )}
              <span className="mr-auto text-xs text-[var(--sys-muted-foreground)]">
                {r.requestedByName ?? '—'} · {role}
              </span>
            </header>

            <p className="text-sm text-[var(--sys-heading)]">{r.reason}</p>

            {/* A cancellation has no fields and a postponement has a date;
                the empty box that used to sit here on both said nothing. */}
            {(r.intent ?? 'EDIT') === 'CANCEL' && (
              <p className="text-xs rounded-lg border border-[var(--sys-border)] px-3 py-2">
                <span className="font-semibold text-[var(--sys-muted-foreground)]">سبب الإلغاء: </span>
                <span className="font-semibold text-[var(--sys-heading)]">
                  {REJECTION_REASON_AR[r.cancelReason ?? ''] ?? r.cancelReason ?? '—'}
                </span>
              </p>
            )}
            {(r.intent ?? 'EDIT') === 'POSTPONE' && (
              <p className="text-xs rounded-lg border border-[var(--sys-border)] px-3 py-2">
                <span className="font-semibold text-[var(--sys-muted-foreground)]">يُؤجَّل حتى: </span>
                <span className="font-semibold text-[var(--sys-heading)]" dir="ltr">
                  {String(r.postponeUntil ?? '').slice(0, 10) || '—'}
                </span>
              </p>
            )}

            {/* What changes, in words the person deciding reads: the field's
                Arabic name, and the value before and after. */}
            <ul
              className={`rounded-lg border border-[var(--sys-border)] divide-y divide-[var(--sys-border)] ${
                fieldPairs(r).length === 0 ? 'hidden' : ''
              }`}
            >
              {fieldPairs(r).map(([field, value]) => (
                <li key={field} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                  <span className="w-28 shrink-0 font-semibold text-[var(--sys-muted-foreground)]">{changeFieldLabel(field)}</span>
                  {value?.from !== undefined && (
                    <>
                      <span className="text-[var(--sys-muted)] line-through">{show(value.from)}</span>
                      <RiArrowLeftLine className="icon-mirror w-4 h-4 text-[var(--sys-primary)] shrink-0" />
                    </>
                  )}
                  <span className="font-semibold text-[var(--sys-heading)]">{show(value?.to)}</span>
                </li>
              ))}
            </ul>

            {/* A request that edits lines: one sentence per line here; the full before ← after is in the review. */}
            {lineSentences(r).length > 0 && (
              <ul className="rounded-lg border border-[var(--sys-border)] divide-y divide-[var(--sys-border)]">
                {lineSentences(r).map((sentence, i) => (
                  <li key={i} className="px-3 py-2 text-xs text-[var(--sys-heading)]">
                    {sentence}
                  </li>
                ))}
              </ul>
            )}

            {/* And before it is carried out, the order as it stands now: the gate the button below waits for. */}
            {tab === 'AWAITING_APPLY' && linesUnreadable(r) && (
              <p className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-2.5">
                {REVIEW_UNREADABLE_AR}
              </p>
            )}

            {tab === 'AWAITING_APPLY' && linesOf(r) && (
              <LinesRequestReview
                requestId={r.id}
                variant="gate"
                auto={checkedCards.has(r.id)}
                refreshKey={r.order.version}
                onVerdict={(v) =>
                  setVerdicts((prev) =>
                    prev[r.id]?.checking === v.checking && prev[r.id]?.shut === v.shut ? prev : { ...prev, [r.id]: v }
                  )
                }
              />
            )}

            {tab === 'AWAITING_APPLY' && r.decisionNote && (
              <p className="text-xs text-[var(--sys-foreground)] bg-[var(--sys-success-soft)] rounded-lg px-3 py-2">
                <b className="text-[var(--sys-success)]">القرار:</b> {r.decisionNote}
              </p>
            )}

            <p className="text-xs text-[var(--sys-muted-foreground)]">
              {r.order.customer.fullName} · <span dir="ltr">{r.order.customer.phone}</span>
            </p>

            {/* An old cancellation with no reason: the choice is on the card,
                not behind a press, and the button waits for it. */}
            {tab === 'AWAITING_APPLY' && needsReason(r) && (
              <label className="block">
                <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">
                  رُفع هذا الطلب بلا سبب إلغاء — اختر السبب قبل التنفيذ
                </span>
                <select
                  value={chosen[r.id] ?? ''}
                  onChange={(e) => setChosen((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm focus:outline-none focus:border-[var(--sys-primary)]"
                >
                  <option value="">اختر سبب الإلغاء</option>
                  {PICKABLE_REJECTION_REASONS.map((key) => (
                    <option key={key} value={key}>
                      {REJECTION_REASON_AR[key] ?? key}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <footer className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--sys-border)]">
              {tab === 'PENDING' ? (
                /* Nobody decides their own request — the route refuses it,
                   and a button that always fails teaches people the screen
                   is lying. What she has on her own row is the withdrawal. */
                r.isMine ? (
                  <>
                    <button
                      onClick={() => void withdraw(r)}
                      disabled={withdrawing === r.id}
                      className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-foreground)] text-xs font-medium transition-colors hover:border-[var(--sys-destructive-border)] hover:text-[var(--sys-destructive)] disabled:opacity-50"
                    >
                      {withdrawing === r.id ? (
                        <RiLoader4Line className="w-4 h-4 animate-spin" />
                      ) : (
                        <RiArrowGoBackLine className="icon-mirror w-4 h-4" />
                      )}
                      اسحب طلبي
                    </button>
                    <span className="text-xs text-[var(--sys-muted-foreground)]">
                      طلبُك — ينتظر قرارَ من يستطيع الوصولَ إلى الطلب، ويصلك القرارُ إشعاراً.
                    </span>
                  </>
                ) : (
                  <button
                    onClick={() => setReviewing(r.id)}
                    className="min-h-11 md:min-h-0 inline-flex items-center px-4 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium"
                  >
                    مراجعة واتخاذ القرار
                  </button>
                )
              ) : (
                <button
                  onClick={() => void apply(r)}
                  disabled={applying === r.id || (needsReason(r) && !chosen[r.id]) || gateShut(r) !== null}
                  title={gateShut(r) ?? undefined}
                  className="min-h-11 md:min-h-0 inline-flex items-center flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[var(--sys-success)] text-[var(--sys-primary-foreground)] text-xs font-medium disabled:opacity-50"
                >
                  {applying === r.id && <RiLoader4Line className="w-4 h-4 animate-spin" />}
                  {CARRY_LABEL[r.carryOut?.kind] ?? 'نفِّذ القرار'}
                </button>
              )}
            </footer>
          </article>
        );
      })}

      {courierFor && (
        <CourierNotifyDialog
          orderNumber={courierFor.request.order.orderNumber}
          ask={courierFor.ask}
          countryCode={dialCode}
          busy={applying === courierFor.request.id}
          onClose={() => setCourierFor(null)}
          onNotified={() => void send(courierFor.request, true)}
        />
      )}

      {reviewing && (
        <ChangeRequestReview
          requestId={reviewing}
          onClose={() => setReviewing(null)}
          onDecided={() => void load()}
        />
      )}
    </div>
  );
}
