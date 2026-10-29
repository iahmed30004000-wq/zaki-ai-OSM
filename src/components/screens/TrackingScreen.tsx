'use client';

import { lateLabel } from '@/lib/transit';
import React, { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { SHIPPING_STATUS_AR } from '@/lib/shipping-workflow';
import { ContactButtons } from '@/components/orders/ContactButtons';
import { TransferDialog } from '@/components/screens/tracking/TransferDialog';
import { CollectDialog } from '@/components/screens/tracking/CollectDialog';
import { DeliverDialog } from '@/components/screens/tracking/DeliverDialog';
import { WriteOffDialog } from '@/components/screens/tracking/WriteOffDialog';
import { apiJson } from '@/lib/api-client';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { Rows, type RowTone } from '@/components/ui/Rows';
import { RiAlertLine, RiChat1Line, RiCheckLine, RiCloseLine, RiEBike2Line, RiEyeLine, RiHandCoinLine, RiLoader4Line, RiTimerLine, RiTruckLine } from '@remixicon/react';
import { ALERT_AR, ALERT_CONFIRM_AR, type TrackingAlertKind } from '@/lib/tracking-alert';
import { useAsk, useConfirm } from '@/components/ui/Confirm';
import { EmptyState } from '@/components/ui/EmptyState';
import { HealthChip } from '@/components/ui/HealthChip';
import { NOT_LATE, NOT_LATE_FACTS, URGENCY, canCollect, trackingUrgency, type ChipKey } from '@/lib/tracking-priority';
import { Money } from '@/components/ui/Money';
import { Pager } from '@/components/ui/Pager';
import { NextStepButton } from '@/components/ui/NextStep';
import { ListToolbar, withChosen, type ToolbarFilter } from '@/components/ui/ListToolbar';
import { usePagedList, type PagedRead, type Paging } from '@/hooks/usePagedList';
import { AGES, AGE_AR } from '@/lib/age-piles';
import { EVERY_STATUS, TASKS } from '@/lib/tracking-filters';
import type { TrackingListFacts } from '@/lib/tracking-list';
import { FULL_SIGHT, NO_SIGHT, statesOffered, type TrackingSight } from '@/lib/tracking-sight';

/**
 * /ops/tracking — search by order, reference, barcode, customer or phone.
 * Days in transit and the late flag come from the API against each region's
 * own threshold. Collection status is its own column, never merged with the
 * delivery status.
 *
 * «متابعة الشحن — صفحات + فلاتر + بحث». The list is read in pages of 25 through the
 * list kit, worst first. The chips, the «late» badge and the numbers beside the
 * dropdowns are the SERVER'S, counted over every parcel the search and the state
 * match — this screen used to count them over the two hundred rows it happened to
 * hold, sort them itself and draw them all. A chip is a question put to the server
 * (`task`), not a filter over what the browser has.
 */

interface Row {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  trackingNumber: string | null;
  shippingStatus: string;
  /** The courier's money is taken off the row for whoever may not see it (`access.money`). */
  collectionStatus?: string;
  daysInTransit: number | null;
  /**
   * The region's late threshold in days, or `null` when this courier has no
   * fee row for this region at all — three states, not two. A stored `0` is
   * a decision («never call these late»); `null` is the absence of one.
   */
  lateThresholdDays: number | null;
  late: boolean;
  /** When it arrived / came back — the server stops the clock there, and the row's reason is judged by it. */
  deliveredAt?: string | null;
  returnedAt?: string | null;
  /** Whether this company hands out a barcode at all; a manual one does not, so it cannot be missing one. */
  barcodeExpected?: boolean;
  totalAmount: number;
  currency: string;
  deliveryFailureReason: string | null;
  customer: { fullName: string; phone: string; city: string };
  region: { name: string } | null;
  deliveryProvider: { id: string; name: string; kind?: string } | null;
  deliveryFee?: number | null;
  priceIncludesDelivery?: boolean;
  collectedAmount?: number | null;
  /**
   * What the courier owes for this parcel, from `expectedAmountFor` on the
   * server. The route has always sent it; this type did not declare it, so
   * the selection bar derived its own figure and printed a different one.
   */
  expectedCollection?: number | null;
  settlementStatus?: string;
  _count?: { deliveryAttempts: number; notes: number };
  /** Cancelled while the parcel moves, or changed after it left. */
  alert?: { kind: TrackingAlertKind; at: string; acknowledged: boolean } | null;
}

interface Extra {
  facts: TrackingListFacts;
  lateCount: number;
  dialCode: string | null;
  /** The read hit its bound: this is the first of a bigger list. */
  capped: boolean;
  /** Which level of the screen this person holds. The door decides; this only says what to draw. */
  access: TrackingSight;
}

/** Module-level, so the hook's loader keeps one identity — see `usePagedList`. */
const read = (body: unknown): PagedRead<Row, Extra> => {
  const b = body as { orders: Row[]; pagination: Paging; facts: TrackingListFacts; lateCount: number; dialCode?: string | null; capped?: boolean; access?: TrackingSight };
  // The door always says; an answer that does not is read as the whole screen, since drawing less would hide work, and the door is what refuses.
  return { rows: b.orders, pagination: b.pagination, extra: { facts: b.facts, lateCount: b.lateCount, dialCode: b.dialCode ?? null, capped: !!b.capped, access: b.access ?? FULL_SIGHT } };
};

/**
 * THE TWO THINGS THAT MAKE CHASING A PARCEL POINTLESS OR WRONG.
 *
 * Red: the order was cancelled and the parcel is still out. Orange: an
 * approved change was written onto it, so the address on this screen is
 * not the one she last read.
 *
 * Both fade once acknowledged — they do not disappear. The row still says
 * what happened; it stops shouting.
 */
const ALERT_TONE: Record<TrackingAlertKind, { live: string; seen: string }> = {
  CANCELLED: {
    live: 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]',
    seen: 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]',
  },
  CHANGED: {
    live: 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/40 text-[var(--sys-warning)]',
    seen: 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]',
  },
};

/**
 * THE SAME TWO MEANINGS, AS THE ROW'S OWN TINT.
 *
 * Beside `ALERT_TONE` and keyed by the same union, so a third alert kind
 * added to `TrackingAlertKind` fails to compile here rather than quietly
 * tinting its rows nothing.
 */
const ROW_TONE_FOR: Record<TrackingAlertKind, RowTone> = {
  CANCELLED: 'danger',
  CHANGED: 'warn',
};

/**
 * THE ROW'S TINT, AS A FUNCTION RATHER THAN A LAMBDA IN THE JSX.
 *
 * Exported and pure because the lambda it replaced could not be reached by
 * a test: mutating `CHANGED` to red, or swapping the two colours, broke
 * nothing — `Rows` was guarded and its CALLER was not, which is a guard on
 * a door nobody walks through.
 *
 * The fade is part of the rule, not a detail of the markup. An
 * acknowledged alert still SAYS what happened — the chip stays, greyed —
 * it just stops tinting the whole row, because a reader who has already
 * dealt with forty rows should see the ones still waiting.
 */
export function rowToneFor(
  alert: { kind: TrackingAlertKind; acknowledged: boolean } | null | undefined
): RowTone | null {
  if (!alert || alert.acknowledged) return null;
  return ROW_TONE_FOR[alert.kind];
}

/*
 * The words come from `SHIPPING_STATUS_AR`. This screen was the only one
 * saying «خارج للتوصيل» while five others said «خرج للتوصيل».
 */
const STATUS_LABEL: Record<string, string> = SHIPPING_STATUS_AR;

/**
 * The filter is «الكل» or one of the conditions, and the conditions are named
 * in one place so a chip cannot drift from the rank that sorts the list.
 */
type TaskFilter = 'all' | ChipKey;

/** A chip's colour, from the same four tones the whole product judges with. */
const TASK_TONE: Record<string, string> = {
  bad: 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]',
  ok: 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/40 text-[var(--sys-warning)]',
  good: 'bg-[var(--sys-success-soft)] border-[var(--sys-success)]/40 text-[var(--sys-success)]',
  unknown: 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]',
};

const COLLECTION_LABEL: Record<string, string> = {
  NOT_APPLICABLE: 'لا ينطبق',
  PENDING: 'بانتظار',
  PENDING_COLLECTION: 'لم يُحصَّل',
  COLLECTED: 'محصَّل',
  SETTLED: 'مسوّى',
  UNSETTLED: 'غير مسوّى',
};

export function TrackingScreen() {
  /*
   * «شحنة مفقودة عند شركة الشحن» names one parcel and links here. The
   * link is the order's number, which is one of the things this screen's
   * own search matches — so clicking the alert shows that parcel, not
   * every parcel in the store.
   */
  const [term, setTerm] = useState(useSearchParams().get('order') ?? '');
  /** Nothing is the screen's own job description: what is moving, plus what arrived and is still owed. */
  const [status, setStatus] = useState('');
  const [courier, setCourier] = useState('all');
  const [region, setRegion] = useState('all');
  const [age, setAge] = useState('all');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [transferFor, setTransferFor] = useState<Row | null>(null);
  const [deliverFor, setDeliverFor] = useState<Row | null>(null);
  /** The parcel somebody is about to stop waiting for. */
  const [writeOffFor, setWriteOffFor] = useState<Row | null>(null);
  const [noting, setNoting] = useState<string | null>(null);
  /** The order whose door outcome is being written, so its buttons wait. */
  const [settling, setSettling] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [collecting, setCollecting] = useState(false);
  /** The row whose alert is being acknowledged right now. */
  const [acking, setAcking] = useState<string | null>(null);
  const [task, setTask] = useState<TaskFilter>('all');

  const ask = useAsk();
  // A plain yes/no: refusing a parcel needs a confirmation, not a sentence.
  const confirm = useConfirm();

  /**
   * «رأيتُ هذا» — recorded, not dismissed.
   *
   * It asks first and says exactly what it will write, because the one
   * thing this button must never be mistaken for is an action on the
   * order: the parcel is still out there either way.
   */
  const acknowledge = async (o: Row) => {
    if (!o.alert) return;
    const ok = await confirm({
      title: `${ALERT_AR[o.alert.kind]} — ${o.merchantRef ?? o.orderNumber}`,
      body: ALERT_CONFIRM_AR[o.alert.kind],
      confirmLabel: 'أدركتُ',
    });
    if (!ok) return;
    setAcking(o.id);
    try {
      await apiJson('/api/ops/tracking/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: o.id, kind: o.alert.kind }),
      });
      await list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تسجيل الإقرار');
    } finally {
      setAcking(null);
    }
  };

  /**
   * MOST OF WHAT A FOLLOW-UP AGENT LEARNS IS NOT AN OUTCOME.
   *
   * «رنّيت ثلاث مرّات ما ردّ», «المندوب قال بكرة الصبح», «الزبون طلب
   * يأجّلها ليوم الخميس». None of that is a delivery, a refusal or a
   * transfer, and the row offered nothing for it — so it was kept in a
   * notebook, or in the agent's head, and the next person to open the order
   * started from nothing.
   *
   * It writes through the order's own notes door, which already exists and
   * is already the immutable thread every screen reads. No second place for
   * notes to live, and nothing here settles anything.
   */
  const addNote = async (row: Row) => {
    const answer = await ask({
      title: `ملاحظة على ${row.orderNumber}`,
      body: 'تُضاف باسمك إلى ملاحظات الطلب ويقرؤها التأكيد والمرتجعات. لا تُغيّر حالة الطلب ولا تُسجّل تسليماً.',
      confirmLabel: 'أضِفها',
      input: { label: 'ما الذي حدث؟', placeholder: 'مثال: المندوب قال يسلّمها غداً صباحاً', multiline: true },
    });
    const body = (answer ?? '').trim();
    if (!body) return;

    setNoting(row.id);
    try {
      await apiJson(`/api/orders/${row.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, kind: 'follow_up' }),
      });
      setDone(`أُضيفت الملاحظة إلى ${row.orderNumber}`);
      setError(null);
      await list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر حفظ الملاحظة');
    } finally {
      setNoting(null);
    }
  };

  /**
   * «استلم» و«رفض» — نداءٌ واحد، والسيرفر يقرأ بنودَ الطلب بنفسه.
   *
   * Sending `outcome` rather than a line list keeps the screen from having
   * to know the lines to say something the order already knows, and keeps
   * the fee rule in the one place that has it.
   */
  const settle = async (o: Row, outcome: 'ALL' | 'NONE') => {
    if (outcome === 'NONE') {
      const ok = await confirm({
        title: `${o.merchantRef ?? o.orderNumber} — لم يستلم شيئاً؟`,
        body: 'يصير الطلبُ مرتجعاً. البضاعةُ لا تعود إلى المخزون الآن — تعود عند استلامها فعلياً في المرتجعات.',
        confirmLabel: 'نعم، رفضه',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setSettling(o.id);
    setError(null);
    try {
      const res = await apiJson<{ message: string }>('/api/ops/tracking/deliver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: o.id, outcome }),
      });
      setDone(res.message);
      await list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التسجيل');
    } finally {
      setSettling(null);
    }
  };

  /*
   * ── PAGES, AND WHAT WAS CHOSEN ──
   *
   * A page turn keeps the choices; a new CHOICE (the chip, a dropdown, a word) starts at page one, because page
   * seven of a different question is not where the reader was; coming back to the screen reloads the page the
   * agent is ON. The choices that are «nothing» — an empty state, `all` — are not sent: the door's default is the
   * screen's job description.
   */
  const list = usePagedList<Row, Extra>({
    url: '/api/ops/tracking',
    params: { q: term.trim() || undefined, status, task, courier, region, age },
    read,
  });
  const { extra, rows, pagination } = list;
  /** Until the first answer says what this person holds, nothing of the other level is offered. */
  const access = extra?.access ?? NO_SIGHT;

  /**
   * THE WORK WAITING, FROM ONE DEFINITION OF EACH CONDITION.
   *
   * Every predicate here used to be written inline, and `canCollect` was
   * written a second time for the checkbox. They live in
   * `tracking-priority.ts` now, which is also what ranks and sorts the rows —
   * so a chip and the order of the list can never disagree about what
   * «متأخرة» means.
   *
   * The two alert conditions are new chips. They were the most important
   * thing on the row and the only way to find them was to scroll: measured,
   * 9 rows of 171 carry one and all 9 were unacknowledged.
   *
   * A chip with nothing in it is not drawn. Seven greyed-out targets above
   * the list is most of a phone screen spent saying "nothing here", and
   * «الكل» already carries the total.
   */
  /**
   * WHO WE ARE RINGING AND ABOUT WHAT — described once.
   *
   * The same buttons are drawn in two places: a column on the desk and a
   * full-width row on the card. Two copies of this object is two message
   * templates that fill differently depending on which screen width somebody
   * happened to open.
   */
  const contactFor = (o: Row) => ({
    phone: o.customer.phone,
    countryCode: extra?.dialCode ?? null,
    // The strip was here and recorded nothing: a call placed from this
    // screen left no line in the contact log, so the next agent read «no
    // attempts» on an order somebody had already rung twice.
    orderId: o.id,
    context: {
      orderNumber: o.merchantRef ?? o.orderNumber,
      customerName: o.customer.fullName,
      amount: o.totalAmount,
      currency: o.currency,
      courier: o.deliveryProvider?.name ?? null,
      barcode: o.trackingNumber,
      region: o.region?.name ?? o.customer.city,
    },
  });

  /*
   * The chips are the SERVER'S counts, over everything the search and the state match; a chip nobody is in is not
   * drawn (seven greyed-out targets is most of a phone screen saying "nothing here").
   */
  const facts = extra?.facts;
  const tasks: { key: ChipKey; count: number }[] = facts
    ? [
        ...TASKS.map((key) => ({ key, count: facts.tasks[key] })),
        // «غير متأخرة» is the only chip that is not a fault: what is on the road and inside its time.
        { key: NOT_LATE, count: facts.notLate },
      ].filter((t) => t.count > 0)
    : [];
  const chipFacts = (key: ChipKey) => (key === NOT_LATE ? NOT_LATE_FACTS : URGENCY[key]);

  // A filter on a condition that no longer holds for any parcel is a dead end: its chip is gone, so the list reads as
  // empty with nothing highlighted to press back out of. Acknowledging the last alert does exactly that — so the
  // question is asked without the chip, and the chip is put back at «الكل».
  const openTask: TaskFilter = task !== 'all' && facts && !tasks.some((t) => t.key === task) ? 'all' : task;
  if (openTask !== task) setTask(openTask);

  // The rows are the page: already filtered by the chip, and worst first, by the server — see `byUrgency` for why
  // the oldest-shipped-first order is kept as the tiebreak.
  const visible = rows;
  // The boxes are for whoever may act on the money (the collect door's own key); the rows themselves are the door's.
  const collectable = access.collect ? visible.filter(canCollect) : [];
  /** Every owed parcel the question matches — counted by the server over the whole list, not over this page. */
  const collectOwed = facts?.tasks.COLLECT ?? 0;

  /** What narrows the list beyond the state it opens on: the word, the dropdowns, the chip. */
  const narrowing = [courier, region, age].filter((v) => v !== 'all').length + (term.trim() ? 1 : 0) + (task !== 'all' ? 1 : 0);
  const activeCount = narrowing + (status !== '' ? 1 : 0);
  /** A new question starts a new selection: the boxes ticked were on a page that is not on screen any more. */
  const choose = (set: (v: string) => void) => (v: string) => {
    set(v);
    setSelected({});
  };
  const reset = () => {
    setTerm('');
    setStatus('');
    setCourier('all');
    setRegion('all');
    setAge('all');
    setTask('all');
    setSelected({});
  };
  const filters: ToolbarFilter[] = [
    {
      key: 'status',
      label: 'الحالة',
      value: status,
      onChange: choose(setStatus),
      // THE DEFAULT SAYS WHAT IT ACTUALLY FETCHES. It used to say «قيد الشحن» and ask the door for in-flight only, so
      // «بانتظار التحصيل» — the chip below, and the «استلمت منه» button behind it — never had a single row to draw.
      options: [
        { value: '', label: access.money ? 'قيد الشحن وبانتظار التحصيل' : 'قيد الشحن' },
        // Only the states the door would answer: a delivered or returned parcel is another level's rows.
        ...statesOffered(Object.keys(STATUS_LABEL), access).map((k) => ({ value: k, label: STATUS_LABEL[k] })),
        { value: EVERY_STATUS, label: 'الكل' },
      ],
    },
    ...(facts
      ? [
          {
            key: 'courier',
            label: 'جهة الشحن',
            value: courier,
            onChange: choose(setCourier),
            options: withChosen(courier, [
              { value: 'all', label: 'كل الجهات' },
              ...facts.couriers.map((c) => ({ value: c.id, label: `${c.name} (${c.count})` })),
            ]),
          },
          {
            key: 'region',
            label: 'المحافظة',
            value: region,
            onChange: choose(setRegion),
            options: withChosen(region, [
              { value: 'all', label: 'كل المحافظات' },
              ...facts.regions.map((r) => ({ value: r.id, label: `${r.name} (${r.count})` })),
            ]),
          },
          {
            key: 'age',
            label: 'مدّة الشحن',
            value: age,
            onChange: choose(setAge),
            options: [
              { value: 'all', label: 'أيّ مدّة' },
              ...AGES.map((a) => ({ value: a, label: `${AGE_AR[a]} (${facts.ages[a]})` })),
            ],
          },
        ]
      : []),
  ];
  const chosen = collectable.filter((o) => selected[o.id]);
  /*
   * THE SERVER'S FIGURE, which was in the row all along and unread.
   *
   * This used to be `totalAmount − deliveryFee`, summed here. That is not
   * the settlement expectation and the two disagree TODAY, not someday:
   * `canCollect` includes PARTIALLY_DELIVERED, and `expectedAmountFor`
   * answers 0 for a returned parcel and, for a partial one, rebuilds the
   * figure from the DELIVERED LINES — net of the courier's fee and of any
   * return fee the returns desk charged him. (This comment used to say it
   * reads `collectedAmount`; it reads that column only once a statement
   * has written it, and the door deliberately leaves it NULL.) For 23
   * collected on a 40 order with a fee of 3 the server says 20 and this
   * bar printed 37 — then `CollectDialog`, which sums
   * `expectedCollection`, said 20 seconds later on the same selection.
   *
   * `?? 0` is the row the rule cannot answer: the route sends `null` for an
   * order with no lines rather than 500-ing the whole screen, and such a
   * row is never collectable anyway — `canCollect` wants DELIVERED.
   *
   * `CollectDialog` already carries the scar of exactly this bug in its own
   * comment; the fix landed on the dialog and missed the screen that opens
   * it. The route sends `expectedCollection` at
   * `api/ops/tracking/route.ts`, and the `Row` type did not even declare
   * it, which is why nobody noticed.
   *
   * The `.toFixed(3)` went with it: three places is a global rule on a
   * screen whose rows each know their own currency, and the server rounds
   * by the minor unit before sending.
   */
  const netOfChosen = chosen.reduce((sum, o) => sum + Number(o.expectedCollection ?? 0), 0);

  return (
    <div className="max-w-6xl space-y-3">
      <ScreenTitle />

      {/* Drawn from the first moment, with or without the numbers: the box is how a parcel is found. */}
      <ListToolbar
        search={term}
        onSearch={choose(setTerm)}
        placeholder="رقم الطلب، المرجع، الباركود، اسم العميل أو الهاتف"
        searchLabel="بحث"
        filters={filters}
        activeCount={activeCount}
        onReset={reset}
      />

      {extra && extra.lateCount > 0 && (
        <p className="flex w-fit items-center gap-1 text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-3 h-10">
          <RiTimerLine className="w-4 h-4" /> {extra.lateCount} شحنة متأخرة
        </p>
      )}

      {(error || list.error) && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error ?? list.error}</p>}
      {extra?.capped && (
        <p className="text-sm text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-3">
          القائمة أكبر مما تقرؤه الشاشة في طلبٍ واحد — هذه أقدم 20000 شحنة. ضيّق البحث أو اختر حالةً أو جهةً أو محافظةً.
        </p>
      )}
      {done && <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">{done}</p>}

      {facts && facts.total > 0 && (
        <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => { setTask('all'); setSelected({}); }}
            className={`min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1 rounded-full border ${
              openTask === 'all' ? 'bg-[var(--sys-heading)] text-[var(--sys-primary-foreground)] border-[var(--sys-heading)]' : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
            }`}
          >
            الكل {facts?.total}
          </button>
          {tasks.map((t) => (
            <button
              key={t.key}
              onClick={() => { setTask(t.key); setSelected({}); }}
              title={chipFacts(t.key).why}
              className={`min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1 rounded-full border ${
                openTask === t.key
                  ? 'bg-[var(--sys-heading)] text-[var(--sys-primary-foreground)] border-[var(--sys-heading)]'
                  : TASK_TONE[chipFacts(t.key).tone]
              }`}
            >
              {chipFacts(t.key).label} {t.count}
            </button>
          ))}
        </div>
      )}

      {/* Manual settlement: a مندوب — and any company that sends no file —
          has no statement to import, so collection is done by naming the
          orders here. Only delivered, unsettled ones can be chosen.

          THE NUMBER IS THE SERVER'S, NOT THIS PAGE'S. The bar counted the
          owed parcels on the page it held, and the list is worst-first with
          money waiting LAST — so on a board of late parcels the first page
          held none, and a bar saying «nothing to collect» hid fourteen
          delivered parcels. «اعرضها» asks the server for exactly them. */}
      {access.collect && collectOwed > 0 && (
        <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-3 flex flex-wrap items-center gap-3">
          <span className="text-xs text-[var(--sys-muted-foreground)]">
            {chosen.length > 0 ? `مختار ${chosen.length} طلب · صافي ${netOfChosen}` : `${collectOwed} مسلَّم بانتظار التحصيل${openTask !== 'COLLECT' ? ' —' : ''}`}
          </span>
          {openTask !== 'COLLECT' && chosen.length === 0 && (
            <button
              onClick={() => { setTask('COLLECT'); setSelected({}); }}
              className="min-h-11 md:min-h-0 text-xs text-[var(--sys-primary)] hover:underline"
            >
              اعرضها
            </button>
          )}
          {collectable.length > 0 && (
            <button
              onClick={() => setSelected(Object.fromEntries(collectable.map((o) => [o.id, true])))}
              className="text-xs text-[var(--sys-primary)] hover:underline"
            >
              اختر الكل
            </button>
          )}
          {chosen.length > 0 && (
            <>
              <button onClick={() => setSelected({})} className="text-xs text-[var(--sys-muted-foreground)] hover:underline">
                إلغاء الاختيار
              </button>
              <button
                onClick={() => setCollecting(true)}
                className="h-11 md:h-8 px-3 rounded-lg bg-[var(--sys-success)] text-[var(--sys-primary-foreground)] text-xs font-medium inline-flex items-center gap-1.5 mr-auto"
              >
                <RiHandCoinLine className="w-4 h-4" /> استلمت منه
              </button>
            </>
          )}
        </div>
      )}

      {!extra ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : (
        <Rows
          rows={visible}
          keyOf={(o) => o.id}
          empty={
            <EmptyState
              title="لا شحناتٍ في هذا المرشِّح"
              why={
                openTask === 'all'
                  ? 'لا شحنة تطابق البحث أو الحالة المختارة أعلاه. وسّع البحث أو اختر «الكل» في الحالة.'
                  : `لا شحنة ${chipFacts(openTask).label} الآن. اضغط «الكل» لترى كل ما هو قيد الشحن.`
              }
            />
          }
          /*
            THE RED MEANS THE ALERT NOW, NOT LATENESS.
            Measured: 152 of 171 rows are late, so tinting late rows red
            tinted nine rows in ten — which is not a signal, it is the
            background colour. The 9 rows carrying a live alert were the same
            red as everything else. Lateness is still said, loudly, in its own
            column: destructive colour, the day count, and «متأخرة N يوماً».
          */
          /*
            AND THE TWO ALERTS ARE TWO COLOURS, NOT ONE.
            «أحمر للملغى، برتقاليّ لمن فيه تعديل». They are two different
            sentences to the person scanning forty rows: cancelled means
            STOP CHASING THIS, changed means the address you just read is
            no longer the one that is true. `alert` returned a boolean, so
            both were the same red — and one colour for two meanings is a
            colour a reader learns to ignore.

            The tones come from `ALERT_TONE`'s own keys, not from a second
            list written here: the row and the chip inside it must never
            disagree about which of the two this is.
          */
          alert={(o) => rowToneFor(o.alert)}
          /*
            AND THE ALERT IS THE FIRST THING ON THE CARD, WITH ITS BUTTON.
            On a phone it used to be a small chip beside the reference and the
            button was a text link at the bottom of the card among five
            others. All 9 live alerts in the database are unacknowledged,
            which is what a button nobody can find looks like.
          */
          notice={(o) =>
            o.alert && (
              <div
                className={`rounded-lg border p-2.5 ${
                  o.alert.acknowledged ? ALERT_TONE[o.alert.kind].seen : ALERT_TONE[o.alert.kind].live
                }`}
              >
                <p className="text-sm font-bold leading-relaxed">
                  {ALERT_AR[o.alert.kind]}
                  {o.alert.acknowledged && ' · رآه'}
                </p>
                {!o.alert.acknowledged && (
                  <>
                    {/* What to DO, not what the button writes — the dialog
                        says that when it is pressed. A phone has room for one
                        sentence and it should be the actionable one. */}
                    <p className="mt-0.5 text-xs leading-relaxed">{URGENCY[o.alert.kind].why}</p>
                    <button
                      onClick={() => void acknowledge(o)}
                      disabled={acking === o.id}
                      className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-current px-3 text-sm font-bold disabled:opacity-50"
                    >
                      {acking === o.id ? (
                        <RiLoader4Line className="h-4 w-4 animate-spin" />
                      ) : (
                        <RiEyeLine className="h-4 w-4" aria-hidden />
                      )}
                      أدركتُ الإجراء
                    </button>
                  </>
                )}
              </div>
            )
          }
          selection={
            access.collect
              ? {
                  canSelect: canCollect,
                  isSelected: (o) => !!selected[o.id],
                  onToggle: (o, next) => setSelected((sel) => ({ ...sel, [o.id]: next })),
                }
              : undefined
          }
          columns={[
            {
              key: 'ref',
              label: 'المرجع',
              primary: true,
              render: (o) => (
                <>
                  <span dir="ltr" className="font-medium text-[var(--sys-heading)]">
                    {o.merchantRef ?? o.orderNumber}
                  </span>
                  {/*
                    WHY THIS ROW IS IN FRONT OF YOU, BESIDE ITS NAME.
                    The list is sorted by this, so the chip is also what
                    explains the order: a run of «أُلغي والطرد يسير», then
                    «تعذّر التوصيل», then «متأخرة». Without it the new order
                    would look arbitrary.
                  */}
                  {trackingUrgency(o) !== 'NONE' && (
                    <HealthChip
                      className="mt-1 flex"
                      health={{
                        tone: URGENCY[trackingUrgency(o)].tone,
                        label: URGENCY[trackingUrgency(o)].label,
                        why: URGENCY[trackingUrgency(o)].why,
                      }}
                    />
                  )}
                  {/*
                    On the desk the alert is a cell read at a glance beside
                    everything else. On a phone it is the card's notice, at the
                    top and full width with its own button — so this one is the
                    desk's copy and says so, rather than being drawn twice.
                  */}
                  {o.alert && (
                    <span
                      className={`mt-1 hidden w-fit rounded-md border px-2 py-0.5 text-xs font-semibold md:block ${
                        o.alert.acknowledged
                          ? ALERT_TONE[o.alert.kind].seen
                          : ALERT_TONE[o.alert.kind].live
                      }`}
                    >
                      {ALERT_AR[o.alert.kind]}
                      {o.alert.acknowledged && ' · رآه'}
                    </span>
                  )}
                </>
              ),
            },
            { key: 'customer', label: 'العميل', primary: true, render: (o) => o.customer.fullName },
            {
              key: 'barcode',
              label: 'الباركود',
              // Measured: null on 100% of the default in-flight view and 15%
              // overall, so on a phone this was a labelled line reading «—».
              // The «بلا باركود» chip is how the missing ones are found.
              hideOnPhone: true,
              render: (o) => (
                <span dir="ltr" className="text-[var(--sys-muted-foreground)]">
                  {o.trackingNumber ?? '—'}
                </span>
              ),
            },
            {
              key: 'region',
              label: 'المحافظة',
              render: (o) => o.region?.name ?? o.customer.city,
            },
            {
              key: 'courier',
              label: 'جهة الشحن',
              render: (o) =>
                o.deliveryProvider ? (
                  <span className="inline-flex items-center gap-1 text-[var(--sys-foreground)]">
                    {o.deliveryProvider.kind === 'AGENT' ? (
                      <RiEBike2Line className="h-4 w-4 text-[var(--sys-primary)]" />
                    ) : (
                      <RiTruckLine className="h-4 w-4 text-[var(--sys-muted)]" />
                    )}
                    {o.deliveryProvider.name}
                  </span>
                ) : (
                  <span className="text-[var(--sys-muted)]">—</span>
                ),
            },
            {
              key: 'status',
              label: 'حالة الشحن',
              render: (o) => (
                <>
                  {STATUS_LABEL[o.shippingStatus] ?? o.shippingStatus}
                  {o.deliveryFailureReason && (
                    <span className="block text-xs text-[var(--sys-destructive)]">
                      {o.deliveryFailureReason}
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'days',
              label: 'أيام الشحن',
              render: (o) => (
                <span
                  className={`tabular-nums ${o.late ? 'font-semibold text-[var(--sys-destructive)]' : 'text-[var(--sys-foreground)]'}`}
                >
                  {o.daysInTransit ?? '—'}
                  {/*
                    THREE STATES, AND THEY USED TO BE TWO.

                    The condition here was `o.lateThresholdDays > 0`, so a
                    stored threshold of ZERO printed nothing at all — exactly
                    what an unpriced region printed. A courier told «never
                    call these late» and a courier nobody has priced looked
                    identical on the screen an operator uses to decide which
                    parcel to chase.

                      · no fee row (null) → «بلا أجرة»: the lane is not
                        priced, so there is no threshold to miss, and the
                        cause is a missing row in the fees table.
                      · a row saying 0    → «بلا حد»: priced, and the
                        decision was «this one is never late».
                      · a row saying 3    → «/ 3», as before.

                    Shown only once the clock is running. An order that has
                    not shipped has no days in transit, and «/ 3» beside a
                    «—» was a threshold against a clock nobody started.
                  */}
                  {o.daysInTransit !== null &&
                    (o.lateThresholdDays === null ? (
                      <span
                        className="text-xs text-[var(--sys-warning)]"
                        title="لا أجرة توصيل لهذه المحافظة عند هذه الشركة، فلا حدَّ تأخيرٍ لها — عرّفها من «الإعدادات ← شركات الشحن وأجورها»."
                      >
                        {' '}
                        / بلا أجرة
                      </span>
                    ) : o.lateThresholdDays === 0 ? (
                      <span
                        className="text-xs text-[var(--sys-muted)]"
                        title="حدّ التأخير لهذه المحافظة مكتوب صفراً: هذا الطلب لا يُعلَّم متأخّراً أبداً."
                      >
                        {' '}
                        / بلا حد
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--sys-muted)]"> / {o.lateThresholdDays}</span>
                    ))}
                  {o.late && o.daysInTransit !== null && (
                    <span className="block text-xs font-medium">{lateLabel(o.daysInTransit)}</span>
                  )}
                </span>
              ),
            },
            {
              key: 'attempts',
              label: 'المحاولات',
              // Measured: 0 on 97% of 171 rows and never above 1. A line that
              // reads «0» on every card is a line nobody reads twice.
              hideOnPhone: true,
              render: (o) => (
                <span className="text-xs">
                  <span
                    className={`tabular-nums ${(o._count?.deliveryAttempts ?? 0) > 1 ? 'font-semibold text-[var(--sys-destructive)]' : 'text-[var(--sys-muted-foreground)]'}`}
                  >
                    {o._count?.deliveryAttempts ?? 0}
                  </span>
                  {(o._count?.notes ?? 0) > 0 && (
                    <span className="mr-2 text-[var(--sys-muted)]"> · {o._count?.notes} ملاحظة</span>
                  )}
                </span>
              ),
            },
            // The column is the courier's money — without the level that sees it there is nothing in it to read.
            ...(access.money
              ? [
                  {
                    key: 'collection',
                    label: 'حالة التحصيل',
                    // Measured: the same single value on 91% of rows. What actually
                    // varies is whether money is waiting, and that is now the
                    // «بانتظار التحصيل» chip, the row's own rank, and the collect
                    // bar above the list.
                    hideOnPhone: true,
                    render: (o: Row) => COLLECTION_LABEL[o.collectionStatus ?? ''] ?? o.collectionStatus,
                  },
                ]
              : []),
            {
              key: 'amount',
              label: 'المبلغ',
              render: (o) => (
                <span dir="ltr" className="tabular-nums">
                  <Money value={o.totalAmount} currency={o.currency} />
                </span>
              ),
            },
            {
              key: 'contact',
              label: 'تواصل',
              /*
                ON A DESK IT IS A COLUMN. ON A CARD IT IS A ROW OF ITS OWN.
                That is what the comment here always said, and it was not what
                happened: a card renders every visible column as a
                label/value line, so the one action this screen exists for was
                squeezed into the right half of a «تواصل» row. It is hidden
                here and rendered full width in `actions` below, from the one
                `contactFor` description of it — so the two cannot drift.
              */
              hideOnPhone: true,
              render: (o) => <ContactButtons compact {...contactFor(o)} />,
            },
          ]}
          actions={(o) => (
            <>
              {/*
                THE BUTTONS THIS SCREEN EXISTS FOR, WHERE A THUMB IS.
                Full width and first on the card, hidden on the desk where the
                «تواصل» column already carries them. Chasing a parcel is a
                phone call; it should not be the hardest thing to press.
              */}
              <div className="w-full md:hidden">
                <ContactButtons {...contactFor(o)} />
              </div>
              {/*
                «مجرد ما تشوف، لازم زر» — and pressing it records who saw
                it, on the order, rather than hiding a colour. A warning
                anybody can switch off is a warning people learn to switch
                off; this one asks first and says what it will write.

                On a phone the card's notice carries this button at the TOP,
                full width, so this copy is the desk's.
              */}
              {o.alert && !o.alert.acknowledged && (
                <button
                  onClick={() => void acknowledge(o)}
                  disabled={acking === o.id}
                  className="hidden min-h-11 items-center gap-1 text-xs font-semibold text-[var(--sys-primary)] hover:underline disabled:opacity-50 md:inline-flex md:min-h-0"
                >
                  {acking === o.id ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiEyeLine className="w-4 h-4" />}
                  أدركتُ الإجراء
                </button>
              )}
              {/*
                THE TWO ANSWERS THE DOOR ACTUALLY GIVES, AS TWO BUTTONS.

                This was one «تسجيل التسليم» that opened a dialog asking
                which lines were taken. Almost every parcel is all of it or
                none of it, and making somebody open a dialog and read a
                line list to say «استلم» is the reason it was reported as
                heavy. The partial case is real but rare, and it keeps the
                dialog — reached from the same place, one tap further.

                NEITHER SETTLES MONEY. What is written here is what
                HAPPENED at the door; the collected amount is written when
                the courier's statement is matched. Both buttons go to the
                one endpoint that has always known that.
              */}
              {['SHIPPED', 'OUT_FOR_DELIVERY'].includes(o.shippingStatus) && (
                <>
                  {/*
                    AND THEY STOP LOOKING LIKE THE SAME LINK.
                    «استلم» and «رفض / ملغى» sat next to each other as two
                    bare text links about sixteen pixels tall, eight pixels
                    apart. A mis-tap there marks a parcel returned. Each is a
                    bordered target now, 44px on a phone, sharing the row
                    evenly so neither is the small one.
                  */}
                  <button
                    onClick={() => void settle(o, 'ALL')}
                    disabled={settling === o.id}
                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--sys-success)]/40 bg-[var(--sys-success-soft)] px-3 text-xs font-bold text-[var(--sys-success)] disabled:opacity-50 md:min-h-0 md:flex-none md:border-0 md:bg-transparent md:px-0 md:hover:underline"
                    title="استلم الطلب كاملاً — يُسجَّل ما حدث، والمبلغ يُكتب عند مطابقة كشف الشركة"
                  >
                    {settling === o.id ? (
                      <RiLoader4Line className="w-4 h-4 animate-spin" />
                    ) : (
                      <RiCheckLine className="w-4 h-4" aria-hidden />
                    )}
                    استلم
                  </button>
                  <button
                    onClick={() => void settle(o, 'NONE')}
                    disabled={settling === o.id}
                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] px-3 text-xs font-bold text-[var(--sys-destructive)] disabled:opacity-50 md:min-h-0 md:flex-none md:border-0 md:bg-transparent md:px-0 md:hover:underline"
                    title="رفضه أو أُلغي — لم يستلم شيئاً، ويصير مرتجعاً"
                  >
                    <RiCloseLine className="w-4 h-4" aria-hidden />
                    رفض / ملغى
                  </button>
                  <button
                    onClick={() => setDeliverFor(o)}
                    className="inline-flex min-h-11 items-center text-xs text-[var(--sys-muted-foreground)] hover:text-[var(--sys-foreground)] hover:underline md:min-h-0"
                    title="استلم بعض البنود فقط — أشّر ما أخذه بالضبط"
                  >
                    استلم جزءاً
                  </button>
                </>
              )}
              {/*
                THE ONLY WAY OUT OF «مطلوب إرجاعه» WHEN NOTHING COMES BACK.

                `POST /api/ops/tracking/write-off` was built and tested with
                the transfer flow and then reached from nowhere:
                `nothing-unused-ships.test.ts` listed it as a door no button
                opens. So an order whose goods the company lost waited at
                `RETURN_REQUESTED` forever, its units reserved against a
                parcel that no longer exists — a shelf promising stock
                nobody can pick, with no screen able to say so.

                SHOWN ONLY ON THE ONE STATUS THE DOOR ACCEPTS. Anywhere else
                it answers 409, and a button that always refuses is a broken
                one. And it is a bordered destructive target rather than
                another bare link, because it consumes stock and cannot be
                undone — the same reason «رفض / ملغى» stopped being a link.
              */}
              {o.shippingStatus === 'RETURN_REQUESTED' && (
                <button
                  onClick={() => setWriteOffFor(o)}
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] px-3 text-xs font-bold text-[var(--sys-destructive)] md:min-h-0"
                  title="البضاعة لن تعود — تخرج من المخزون ويُغلق الطلب كخسارة بسبب مكتوب"
                >
                  <RiAlertLine className="w-4 h-4" aria-hidden />
                  أغلقه كخسارة
                </button>
              )}
              <button
                onClick={() => setTransferFor(o)}
                className="inline-flex min-h-11 items-center text-xs text-[var(--sys-primary)] hover:underline md:min-h-0"
                title={
                  o.deliveryProvider?.kind === 'AGENT'
                    ? 'استلام من المندوب وتحويلها لجهة أخرى'
                    : 'تحويل الشحنة لجهة أخرى — قبل التسليم نفس الطلب، وبعده طلب بديل'
                }
              >
                تحويل
              </button>
              {/* The third one, and the only one that settles nothing. */}
              <button
                onClick={() => void addNote(o)}
                disabled={noting === o.id}
                className="inline-flex min-h-11 items-center gap-1 text-xs text-[var(--sys-muted-foreground)] hover:text-[var(--sys-foreground)] hover:underline disabled:opacity-50 md:min-h-0"
                title="اكتب ما حدث — تُضاف كملاحظة داخلية على الطلب ولا تُغيّر حالته"
              >
                {noting === o.id ? (
                  <RiLoader4Line className="w-4 h-4 animate-spin" />
                ) : (
                  <RiChat1Line className="w-4 h-4" aria-hidden />
                )}
                ملاحظة
              </button>
            </>
          )}
        />
      )}

      {pagination.totalPages > 1 && (
        <Pager
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          shown={rows.length}
          noun="شحنة"
          loading={list.loading}
          onPage={(page) => {
            setSelected({});
            list.goTo(page);
          }}
        />
      )}

      <NextStepButton />

      {collecting && chosen.length > 0 && (
        <CollectDialog
          orders={chosen}
          onClose={() => setCollecting(false)}
          onDone={async (message) => {
            setCollecting(false);
            setSelected({});
            setDone(message);
            setError(null);
            await list.reload();
          }}
        />
      )}

      {deliverFor && (
        <DeliverDialog
          order={deliverFor}
          onClose={() => setDeliverFor(null)}
          onDone={async (message) => {
            setDeliverFor(null);
            setDone(message);
            setError(null);
            await list.reload();
          }}
        />
      )}

      {writeOffFor && (
        <WriteOffDialog
          order={writeOffFor}
          onClose={() => setWriteOffFor(null)}
          onDone={async (message) => {
            setWriteOffFor(null);
            setDone(message);
            setError(null);
            await list.reload();
          }}
        />
      )}

      {transferFor && (
        <TransferDialog
          order={transferFor}
          onClose={() => setTransferFor(null)}
          onDone={async (message) => {
            setTransferFor(null);
            setDone(message);
            setError(null);
            await list.reload();
          }}
        />
      )}
    </div>
  );
}
