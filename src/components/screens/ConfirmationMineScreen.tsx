'use client';

import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiJson } from '@/lib/api-client';
import { CONTACT_FIRST_MESSAGE } from '@/lib/confirmation-queue';
import { humanMinutes, useElapsedMinutes } from '@/components/ui/Elapsed';
import { CustomerHistoryButton } from '@/components/orders/CustomerHistory';
import { OrderStateBadge } from '@/components/orders/OrderStateBadge';
import { ContactButtons } from '@/components/orders/ContactButtons';
import { OrderDetailModal } from '@/components/orders/OrderDetailModal';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import {
  ChangeRequestDialog,
  IssueDialog,
  PostponeDialog,
  RejectDialog,
  type ChangeRequestValue,
  type PostponeValue,
} from './confirmation/ActionDialogs';
import { raiseChangeRequest } from '@/components/orders/raiseChangeRequest';
import { AssistantDialog } from './confirmation/AssistantDialog';
import { RiAlertLine, RiCheckboxCircleLine, RiCloseCircleLine, RiCloseLine, RiLoader4Line, RiPencilLine, RiPhoneLockLine, RiSearchLine, RiShieldFlashLine, RiSparkling2Line, RiTimerLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { deskIsEmpty, openPreparationStep } from '@/lib/next-step';
import { useMayOpen } from '@/hooks/useMayOpen';
import { PullPanel, useQueue } from '@/components/confirmation/PullPanel';
import { ConfirmationPostponedScreen } from '@/components/screens/ConfirmationPostponedScreen';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { AI_ASSIST_KEY } from '@/lib/ai-assistants';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { arDate } from '@/lib/format';
import { Money } from '@/components/ui/Money';
import { cardTone, noAnswerWords } from '@/lib/no-answer-tone';
import { POST_ORDER_ADDITION_AR } from '@/lib/post-order-offer-copy';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useIsPhone } from '@/hooks/useIsPhone';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { OrderGoods, OrderNotes, OrderPlace, governorateOf, streetOf } from '@/components/orders/OrderGoods';

/**
 * /confirmation/mine — two sections: in-confirmation (workable) and
 * already-confirmed (read-only, with a change request per row).
 *
 * Every number here — COD, risk tier, attempt counter — comes from the API.
 * The screen renders and sends; it never decides.
 */

interface RiskInfo {
  tier: 'SAFE' | 'WATCH' | 'HIGH';
  returnRate: number;
  orders: number;
  returns: number;
  requiresPrepaymentOrApproval: boolean;
}

interface OrderRow {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  confirmationStatus: string;
  state: string;
  previousOrders: number;
  version: number;
  totalAmount: number;
  currency: string;
  claimedAt: string | null;
  /** First thing she did about this order; null means it is still waiting. */
  firstActionAt: string | null;
  postponedUntil: string | null;
  postponePreferredTime: string | null;
  postponeCount: number;
  noAnswerCount: number;
  /**
   * WHERE IT CAME FROM — four fields, because it takes four.
   *
   * `source` and `channel` name the door; `moderator` and `createdBy` name
   * the person. The card reads them together: «يدوي» entered by a
   * moderator and «يدوي» entered by a supervisor are different sentences,
   * and only the first can have an entry issue opened on it.
   */
  source: string | null;
  /** The address this order goes to; the customer's own is the fallback. */
  deliveryAddress?: string | null;
  /** The governorate and the customer note — absent on a response from before they were read. */
  region?: { name: string } | null;
  customerNotes?: string | null;
  moderatorId: string | null;
  moderator: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  channel: { id: string; name: string } | null;
  customer: { id: string; fullName: string; phone: string; rawPhone: string; city: string; address: string };
  items: { id: string; productName: string; quantity: number; freeQuantity: number; lineTotal: number }[];
  /** What the customer added after ordering — absent on a response from before this field existed. */
  addOns?: { id: string; productName: string; quantity: number; total: number }[];
  _count: { contactAttempts: number; notes: number };
  risk?: RiskInfo | null;
  changeRequests?: { id: string }[];
}

/** «أكّدتها» — a day, a search, a page, and the size of what is behind them. */
interface ConfirmedPage {
  day: string;
  q: string;
  page: number;
  pageSize: number;
  total: number;
  pages: number;
  rows: OrderRow[];
}

interface MineResponse {
  leadDays: number;
  /** Postponed to a later day — off her desk, not gone. */
  waitingLater: number;
  noAnswerLimit: number;
  /** The server's clock, so a wrong clock on her machine changes nothing. */
  serverNow: string;
  /** Nobody has failed to reach this customer yet — these are calls. */
  work: OrderRow[];
  /** One or two no-answers — these are decisions. */
  noAnswer: OrderRow[];
  /** The third no-answer closed it today. Read-only, and shown so it is not a surprise. */
  closedToday: OrderRow[];
  confirmed: ConfirmedPage;
}

const RISK_LABEL: Record<string, { text: string; cls: string }> = {
  SAFE: { text: 'خطورة منخفضة', cls: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/30' },
  WATCH: { text: 'تحت المراقبة', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30' },
  HIGH: { text: 'خطورة عالية', cls: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]' },
};

type DialogState =
  | { kind: 'postpone' | 'issue' | 'change' | 'reject' | 'assist'; order: OrderRow }
  | null;

/**
 * HAS ANYBODY TRIED TO REACH THIS CUSTOMER YET?
 *
 * One question, asked of the count the row already carries, so the three
 * buttons and the line under them can never disagree about it.
 */
const needsContact = (order: { _count: { contactAttempts: number } }) =>
  order._count.contactAttempts === 0;

/**
 * WHAT THE SERVER SAID NO TO, IN WORDS THAT SAY WHAT TO DO.
 *
 * Two refusals come back from the confirmation door often enough to need more than the bare sentence:
 * `CONTACT_FIRST` (no attempt on the order yet) and `INVALID_TRANSITION` (the order is no longer in the state the
 * card was drawn from — another person moved it, or the card is stale). Both used to land as one red line with no
 * next step. Anything else keeps the sentence the server wrote.
 */
function refusalText(e: unknown): string {
  const said = e instanceof Error && e.message ? e.message : 'تعذر تنفيذ الإجراء';
  const code = (e as { data?: { code?: unknown } } | null)?.data?.code;
  if (code === 'CONTACT_FIRST') {
    return `${CONTACT_FIRST_MESSAGE}. سجّل المحاولة بزر «لا يرد» أو «مغلق أو خارج التغطية» وبعدها بتفتح الأزرار.`;
  }
  if (code === 'INVALID_TRANSITION') {
    return `${said} حدّث الشاشة وافتح الطلب لتشوف وين صار.`;
  }
  return said;
}

/**
 * An order id from the address bar, or nothing. It goes into a request path,
 * so only the shape an id has is let through — never a slash or a dot.
 */
const ORDER_ID_SHAPE = /^[A-Za-z0-9-]{1,64}$/;
const askedOrderId = (value: string | null): string | null =>
  value && ORDER_ID_SHAPE.test(value) ? value : null;

/**
 * WHERE THE ORDER CAME FROM, IN THE WORDS THE AGENT USES.
 *
 * The card never said. And it decides what she can do about bad data: an
 * entry issue goes to the MODERATOR who typed it, so on an order nobody
 * typed there is nobody to send it to.
 *
 * Read in order of how much it tells her: a named moderator first, then a
 * named person who entered it by hand, then the channel's own name, then
 * the bare source. `source` values are the door's («LANDING_PAGE»,
 * «TELEGRAM», «POS»), and the unknown ones are passed through rather than
 * swallowed — a word she can ask about beats «أخرى».
 */
const SOURCE_AR: Record<string, string> = {
  LANDING_PAGE: 'المتجر',
  STORE: 'المتجر',
  STOREFRONT: 'المتجر',
  TELEGRAM: 'تيليجرام',
  WHATSAPP: 'واتساب',
  POS: 'نقطة بيع',
  MANUAL: 'إدخال يدوي',
};

function sourceLabel(order: OrderRow): string {
  if (order.moderator?.name) return `مودريتور: ${order.moderator.name}`;
  if (order.source === 'MANUAL' && order.createdBy?.name) return `إدخال يدوي: ${order.createdBy.name}`;
  if (order.channel?.name) return order.channel.name;
  if (order.source) return SOURCE_AR[order.source] ?? order.source;
  return 'مصدر غير مسجَّل';
}

export function ConfirmationMineScreen() {
  const toast = useToast();
  const mayOpen = useMayOpen();
  /**
   * ── THE PHONE STRIP FOLLOWS ITS OWN PERMISSION ──
   *
   * Gated HERE and not inside `ContactButtons`: that component is also
   * drawn by the couriers screen, the tracking screen and the storefront
   * shell, and none of those is the confirmation queue. Hiding it there
   * would take the call button off three screens that never asked for one.
   *
   * ⚠️ And note what stays visible: «تأكيد» · «تأجيل» · «ألغِ» are locked
   * by C1 until an attempt exists, so a role without `orders.contact_log`
   * can see them and never open them. That is why «الصلاحيات» warns about
   * exactly this combination.
   */
  const { currentUser } = useApp();
  const canLogContact = userCan(currentUser, 'orders.contact_log');
  // «مساعدة» is the confirmation assistant: it needs the assistants' box besides the desk (PR-5).
  const canAskAssistant = userCan(currentUser, AI_ASSIST_KEY);
  /**
   * «اسحب الطلب التالي» IS HERE, NOT ON ANOTHER SCREEN.
   *
   * The pull used to live on `/confirmation/queue` and sent her here after
   * it; from the empty desk below she was sent back. Now the panel stands at
   * the top of the desk and pulling leaves her where she is. Gated on the
   * door's own key (`confirmation.pull`): `GET /api/confirmation/queue` answers
   * 403 to anyone else, so for them nothing is asked and nothing is drawn.
   */
  const canPull = userCan(currentUser, 'confirmation.pull');
  // «إدخال إشكال» is its own box (`confirmation.raise_issue`, PR-7) — the agent's desk had the button for years and the
  // door asked for the issues LIST she was never given.
  const canRaiseIssue = userCan(currentUser, 'confirmation.raise_issue');
  const queue = useQueue(canPull);
  /* A phone lays the card's buttons in three rows and the tabs in one strip; a desk is as it was. */
  const phone = useIsPhone();
  // Her id, for the customer's history: one of its orders she holds opens here too (OrderLink).
  const holderId = userCan(currentUser, 'confirmation.work') ? currentUser?.id ?? null : null;
  const [data, setData] = useState<MineResponse | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  /**
   * `?open=<id>` — THE ORDER SHE HOLDS, OPENED ON HER OWN DESK.
   *
   * The pull panel's «افتح الطلب … وسجّل محاولة» lands here, and so does an
   * order number she holds on the postponed tab or in a customer's history.
   * The first pointed at `/orders/<id>` — the «الطلبات» screen, which asks
   * `orders.view`, a key an agent may now work without — and the other two
   * were plain text for her. Read once, as the desk is drawn; the window
   * below is the same one «افتح وعدّل» opens, and its door decides.
   */
  const asked = useSearchParams();
  const [openOrderId, setOpenOrderId] = useState<string | null>(() => askedOrderId(asked.get('open')));
  // Searching her own desk, not the whole store: she has a customer on the
  // phone reading out a number, and scrolling for it is the slow way.
  const [findOpen, setFindOpen] = useState('');
  /**
   * ── «أكّدتها» SEARCHES THE DATABASE, NOT THE PAGE ──
   *
   * The old box filtered the hundred rows the server had already cut, so
   * an agent searching for Tuesday's order found nothing and the screen
   * said «لا شيء يطابق» about a list it had never looked in. Three
   * controls now, and all three go to the server: `doneDay`, `doneQuery`
   * and `donePage`.
   *
   * `doneTyped` is what she is typing; `doneQuery` is what has been asked.
   * Keeping them apart is what lets the box hold a half-typed phone number
   * without firing a request per keystroke, and what makes the submit an
   * act she performs rather than a thing that happens to her.
   */
  const [doneDay, setDoneDay] = useState('');
  const [doneTyped, setDoneTyped] = useState('');
  const [doneQuery, setDoneQuery] = useState('');
  const [donePage, setDonePage] = useState(1);
  /**
   * WHICH OF THE THREE SHE IS LOOKING AT.
   *
   * «للشغل» first, because that is what the morning is: an order nobody
   * has reached yet is a call, and a call is the job.
   */
  // `?tab=postponed` — the old «الطلبات المؤجلة» address, a notification about a postponed
  // order that came due, and the supervisor-only page's redirect all land on the fourth tab.
  const askedTab = asked.get('tab');
  const [tab, setTab] = useState<'work' | 'noAnswer' | 'done' | 'postponed'>(askedTab === 'postponed' ? 'postponed' : 'work');

  /**
   * Returns what it loaded — or `null` — so a caller that needs to know what
   * is on her desk AFTER an action has the answer in hand. It used to return
   * nothing, and the only way to learn it was to wait for the next render and
   * read state, which is a render too late to decide what to say.
   */
  const load = useCallback(async (): Promise<MineResponse | null> => {
    try {
      const qs = new URLSearchParams();
      if (doneDay) qs.set('day', doneDay);
      if (doneQuery) qs.set('q', doneQuery);
      if (donePage > 1) qs.set('page', String(donePage));
      const suffix = qs.toString();
      const fresh = await apiJson<MineResponse>(`/api/confirmation/mine${suffix ? `?${suffix}` : ''}`);
      setData(fresh);
      return fresh;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
      return null;
    }
  }, [doneDay, doneQuery, donePage]);

  // The hook's loader answers nothing; ours answers the desk. Wrapped, not widened.
  useLiveRefresh(
    async () => {
      await load();
    },
    { key: `${doneDay}·${doneQuery}·${donePage}` }
  );

  const act = async (id: string, fn: () => Promise<unknown>, after?: (fresh: MineResponse | null) => void) => {
    setBusyId(id);
    setError(null);
    try {
      const result = await fn();
      const fresh = await load();
      // What she now holds changed the caps on the pull panel too.
      void queue.reload();
      // Only on SUCCESS — a refusal throws above and lands in `catch`, so
      // «what to say next» is never said about something that did not happen.
      after?.(fresh);
      return result;
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Dialling, and recording that she dialled, now both live in
   * `ContactButtons` — which does it for every screen rather than for this
   * one. A call nobody recorded is a call that did not happen as far as
   * every counter on this system is concerned, and that is true wherever
   * the call is made from.
   */
  const logAttempt = (order: OrderRow, method: 'PHONE' | 'WHATSAPP' | 'SMS', result: string) =>
    act(order.id, async () => {
      const res = await apiJson<{ autoClosed: boolean; noAnswerCount: number }>(
        `/api/orders/${order.id}/contact-attempts`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactMethod: method, result }),
        }
      );
      setNotice(
        res.autoClosed
          ? `أُغلق الطلب ${order.orderNumber} تلقائياً بعد ${res.noAnswerCount} محاولات بلا رد.`
          : null
      );
      return res;
    });

  /**
   * CONFIRMING WAS SILENT.
   *
   * The row vanished and that was all: no word that it had worked, and no
   * sign of what to do next. An agent working a list of forty confirms one
   * and cannot tell «done» from «the screen refreshed under me» — which is
   * the moment she presses it again on the next row, or looks away to check.
   *
   * It says so now, with the number. And when that was the LAST thing on her
   * desk — nothing to call, nothing to decide — it says so and points up at
   * the pull panel, which stands at the top of this very screen. Not before:
   * with forty rows still there, «اسحب الطلب التالي» would be an instruction to
   * take on more work while the work in front of her is not done.
   *
   * (It used to offer a link to the pull SCREEN from here; that screen is the
   * supervisor's now, and the panel needs no link.)
   */
  const confirm = (order: OrderRow) =>
    act(
      order.id,
      () =>
        apiJson(`/api/orders/${order.id}/confirmation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Optimistic concurrency: the version the screen loaded.
          body: JSON.stringify({ action: 'confirm', expectedVersion: order.version }),
        }),
      (fresh) =>
        toast.done(
          `تم تأكيد الطلب ${order.orderNumber}`,
          deskIsEmpty(fresh) ? 'لا شيء بقي على مكتبك. اسحب الطلب التالي من أعلى الشاشة.' : undefined,
          // The last one: what she confirmed is what the warehouse packs next — for whoever may open that desk.
          deskIsEmpty(fresh) ? openPreparationStep(mayOpen) : undefined
        )
    );

  const submitPostpone = (order: OrderRow, value: PostponeValue) => {
    const at = new Date(`${value.date}T10:00:00`);
    if (Number.isNaN(at.getTime())) {
      toast.failed('تاريخ غير صالح');
      return;
    }
    setDialog(null);
    void act(order.id, () =>
      apiJson(`/api/orders/${order.id}/confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'schedule_follow_up',
          nextFollowUpAt: at.toISOString(),
          followUpReason: value.reason,
          preferredTime: value.preferredTime,
          note: value.note || undefined,
          expectedVersion: order.version,
        }),
      })
    );
  };

  const submitIssue = (order: OrderRow, value: { reason: string; note: string }) => {
    setDialog(null);
    void act(order.id, () =>
      apiJson('/api/confirmation/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.id, reason: value.reason, note: value.note || undefined }),
      })
    );
  };

  /** The customer said no. Through the same rejection path as everywhere. */
  const submitReject = (order: OrderRow, value: { rejectionReason: string; note: string }) => {
    setDialog(null);
    void act(order.id, () =>
      apiJson(`/api/orders/${order.id}/confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reject',
          rejectionReason: value.rejectionReason,
          rejectionNote: value.note || undefined,
          note: value.note || undefined,
          expectedVersion: order.version,
        }),
      })
    );
  };

  /**
   * ONE PRESS, EVEN WHEN NO APPROVAL IS OWED.
   *
   * The door decides for itself whether the raiser may also decide it and
   * the parcel is still ours — and says so with `readyToApply`. When it is
   * true, waiting for somebody to open «بانتظار التطبيق» and press a second
   * button would be the queue we just removed, wearing a different hat.
   *
   * The write still goes through the one apply path, so the money rules,
   * the seal and the audit are exactly the ones a supervisor's approval
   * would have gone through. And if that second call fails, the request is
   * sitting in «بانتظار التطبيق» — visible and applicable, never lost.
   */
  /**
   * تعديل · إلغاء · تأجيل — through the one raiser, which the order
   * screen uses too. See src/components/orders/raiseChangeRequest.ts.
   */
  const submitChange = (order: OrderRow, value: ChangeRequestValue) => {
    setDialog(null);
    void act(order.id, () => raiseChangeRequest(order.id, value, order.version));
  };

  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  // Digits only, both sides: she types 0999 or 999 and the stored number
  // may be either. Matching on the bare digits means the shape of the
  // number — leading zero, country code, spaces — never hides a match.
  const digits = (v: string) => v.replace(/\D/g, '');
  const matches = (order: OrderRow, term: string) => {
    const q = term.trim();
    if (!q) return true;
    const d = digits(q);
    if (d && (digits(order.customer.rawPhone).includes(d) || digits(order.customer.phone).includes(d))) return true;
    if (digits(order.orderNumber).includes(d) && d) return true;
    const text = q.toLowerCase();
    return (
      order.orderNumber.toLowerCase().includes(text) ||
      order.customer.fullName.toLowerCase().includes(text)
    );
  };
  /*
   * ── THE TWO WORKING TABS SEARCH THEIR OWN ROWS ──
   *
   * Unlike «أكّدتها», these two hold everything she has: the server sent
   * all of it, so filtering here searches the whole of each tab and not a
   * cut of it. The customer is on the line reading out a number.
   */
  const work = data.work.filter((o) => matches(o, findOpen));
  const noAnswer = data.noAnswer.filter((o) => matches(o, findOpen));
  const closedToday = data.closedToday.filter((o) => matches(o, findOpen));
  const confirmed = data.confirmed;
  /** What each tab holds, in a sentence — under the tab's label on a desk, once under the strip on a phone. */
  const tabNotes = {
    work: 'ما حدا اتّصل فيهم بعد',
    noAnswer: `محاولة أو محاولتين — التالية تُغلق${data.closedToday.length > 0 ? ` · و${data.closedToday.length} أُغلقت اليوم` : ''}`,
    done: confirmed.q ? `بحث «${confirmed.q}»` : 'يوم واحد في كلّ مرّة',
    postponed: 'ما أجّلتَه لموعد — تعمل على ما حلّ موعده',
  };

  /*
   * ONE CARD, THREE PLACES.
   *
   * «لا يرد» shows the same card «للشغل» does — same buttons, same rules,
   * same source line — because it is the same order and the agent must not
   * have to learn a second card. What changes is the tone and, for the
   * ones the third no-answer closed, that there is no footer at all: they
   * are read-only, and a disabled row of buttons reads as «try again».
   */
  const rows: { order: OrderRow; closed?: boolean }[] =
    tab === 'work'
      ? work.map((order) => ({ order }))
      : tab === 'noAnswer'
        ? [...noAnswer.map((order) => ({ order })), ...closedToday.map((order) => ({ order, closed: true }))]
        : [];

  return (
    <div className="space-y-6 max-w-5xl">
      <ScreenTitle />
      {canPull && <PullPanel queue={queue} compact onPulled={async () => void (await load())} />}
      {error && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>
      )}
      {notice && (
        <p className="text-sm text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-3">{notice}</p>
      )}

      {/*
        ── THREE TABS, AND THE COUNT IS ON THE TAB ──

        One list held all three kinds: an order nobody had rung, an order
        rung twice with nothing, and a hundred she had already confirmed.
        The second kind was invisible — its only mark was «2/3» inside a
        button — and the third was a feed she could not search.

        The counts are on the tabs rather than inside them, because the
        decision «which of these do I do now» is made before she opens
        either list, and a count she has to click to see cannot inform it.
      */}
      {/*
        A PHONE: ONE STRIP THAT SCROLLS SIDEWAYS, AND ONE SENTENCE (ORD-16).

        Each tab printed its own sentence under its label, so every tab was as wide as its sentence and the four
        wrapped into four rows, with the underline lined up only on the last. Now the tabs keep their label and
        count and do not wrap; the sentence of the tab that is OPEN is printed once, under the strip. The other
        three are still the tab's title, as they were.
      */}
      <div role="tablist" aria-label="طلباتي" className={phone ? 'flex items-center gap-2 border-b border-[var(--sys-border)] overflow-x-auto' : 'flex flex-wrap items-center gap-2 border-b border-[var(--sys-border)]'}>
        <TabButton
          active={tab === 'work'}
          onClick={() => setTab('work')}
          label="للشغل"
          count={data.work.length}
          note={tabNotes.work}
          phone={phone}
        />
        <TabButton
          active={tab === 'noAnswer'}
          onClick={() => setTab('noAnswer')}
          label="لا يرد"
          count={data.noAnswer.length}
          tone={data.noAnswer.length > 0 ? 'warning' : undefined}
          note={tabNotes.noAnswer}
          phone={phone}
        />
        <TabButton
          active={tab === 'done'}
          onClick={() => setTab('done')}
          label="أكّدتها"
          count={confirmed.total}
          note={tabNotes.done}
          phone={phone}
        />
        {/* Her own postponed orders — the same list the supervisor reads in «المتابعة», drawn
            here so the agent is not sent to a page of her own for it. No count: the figure
            this screen has (`waitingLater`) is only the ones for a later day. */}
        <TabButton
          active={tab === 'postponed'}
          onClick={() => setTab('postponed')}
          label="المؤجلة"
          note={tabNotes.postponed}
          phone={phone}
        />
      </div>
      {phone && <p className="-mt-3 text-xs text-[var(--sys-muted)]">{tabNotes[tab]}</p>}

      {(tab === 'work' || tab === 'noAnswer') && (
      <section>
        <SectionHead
          title={tab === 'work' ? 'للشغل' : 'لا يرد'}
          count={rows.length}
          total={tab === 'work' ? data.work.length : data.noAnswer.length + data.closedToday.length}
          value={findOpen}
          onChange={setFindOpen}
          phone={phone}
          note={
            tab === 'work' && data.waitingLater > 0
              ? `و${data.waitingLater} مؤجّلة ليوم لاحق — تعود إلى هنا في موعدها`
              : tab === 'noAnswer'
                ? 'الملوَّنة بالأصفر محاولة، وبالبرتقالي محاولتان — والمغلقة للقراءة فقط'
                : undefined
          }
        />
        <div className="space-y-3">
          {/*
            AN EMPTY LIST AND A HIDDEN ONE ARE NOT THE SAME SENTENCE.

            «لا يوجد طلب بيدك الآن» was printed whenever this list rendered
            nothing — including while the search box above it was holding
            eleven orders out of view. She types a customer's number, misses
            a digit, and the screen tells her that her desk is empty. The
            count in the heading says «0 من 11» at the same moment, so the
            screen contradicted itself.
          */}
          {rows.length === 0 && (
            <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg">
              {findOpen.trim() ? (
                <EmptyState
                  title="لا طلبَ في هذا التبويب يطابق هذا البحث"
                  why={`لا شيءَ من الـ${tab === 'work' ? data.work.length : data.noAnswer.length + data.closedToday.length} في «${tab === 'work' ? 'للشغل' : 'لا يرد'}» يطابق «${findOpen.trim()}» — البحث يمرّ على رقم الطلب والاسم والهاتف.`}
                  action={{ label: 'امسح البحث', onClick: () => setFindOpen('') }}
                />
              ) : tab === 'noAnswer' ? (
                <EmptyState
                  title="ما في طلب ما ردّ عليه حدا"
                  why="هذا التبويب يجمع الطلبات التي جرت محاولة أو محاولتان معها بلا رد — ويخلو عندما تُجاب كلّها أو تُغلَق."
                />
              ) : (
                <EmptyState
                  title="لا يوجد طلب بيدك الآن"
                  why="اسحب طلباً من مركز التأكيد. ما تسحبه يبقى لك حتى تؤكّده أو ترفضه أو يُحرَّر تلقائيّاً."
                />
              )}
            </div>
          )}
          {rows.map(({ order, closed }) => {
            const remaining = Math.max(0, data.noAnswerLimit - order.noAnswerCount);
            /*
              EACH BUTTON OF THE CARD, DRAWN ONCE, PLACED BY THE WIDTH.

              A desk lays them in one wrapping row, in the order the work happens in; a phone groups them in
              three rows (see the footer below). Nothing about a button changes with the width — its handler,
              its lock and its words are the same — so the only thing the width decides is where it sits.
            */
            /*
              THE ORDER SHE IS WORKING ON, OPENED IN THE SAME SCREEN EVERYONE ELSE SEES IT IN.

              She fixes what the customer just told her — a wrong name, a wrong street, a second unit —
              without leaving the queue. The fields she has no authority over are not shown, and are refused
              by the server even if they were.

              AND THIS ONE WAS THE WAY AROUND THE OTHER THREE. «تأكيد» and «تأجيل» and «ألغِ» have been locked
              until the order carries a contact attempt since C1 — and «افتح وعدّل» was not. So an agent who
              had rung nobody could open the order, change the quantity, the price or the address, and save.
              The server refuses it now too (`CONTACT_FIRST`), so this is not the rule — it is her being told
              it before she retypes an address rather than after.
            */
            const openBtn = (
              <Action
                onClick={() => setOpenOrderId(order.id)}
                locked={needsContact(order)}
                lockedTitle={CONTACT_FIRST_MESSAGE}
                icon={<RiPencilLine className="w-4 h-4" />}
              >
                افتح وعدّل
              </Action>
            );
            /* 1/2/3 counter — the third no-answer closes the order by rule */
            const noAnswerBtn = (
              <Action
                onClick={() => logAttempt(order, 'PHONE', 'NO_ANSWER')}
                busy={busyId === order.id}
                icon={<RiPhoneLockLine className="w-4 h-4" />}
                danger={remaining <= 1}
                wide={phone}
              >
                لا يرد
                <span className="tabular-nums" dir="ltr">
                  {' '}
                  {order.noAnswerCount}/{data.noAnswerLimit}
                </span>
              </Action>
            );
            /*
              THE PHONE THAT CANNOT RING AT ALL.

              She calls, hears the network's own recording, and had to file it as «لا يرد» — which says the
              customer did not pick up, a different fact about a different person. The two read the same in a
              counter and differently to whoever opens the order next: one is somebody ignoring the phone, the
              other is what a wrong digit looks like. It counts toward the three like the others, because
              three calls that never reached anybody is the same evidence whichever way the line failed.
            */
            const unreachableBtn = (
              <Action
                onClick={() => logAttempt(order, 'PHONE', 'UNREACHABLE')}
                busy={busyId === order.id}
                icon={<RiPhoneLockLine className="w-4 h-4" />}
                danger={remaining <= 1}
                wide={phone}
              >
                مغلق أو خارج التغطية
              </Action>
            );
            const remainingHint = (
              <span className="text-xs text-[var(--sys-muted)]">
                {remaining === 0
                  ? 'بلغ الحد'
                  : remaining === 1
                    ? 'المحاولة القادمة تُغلق الطلب تلقائياً'
                    : `متبقٍ ${remaining} محاولات قبل الإغلاق التلقائي`}
              </span>
            );
            /*
              CALL, SMS AND WHATSAPP — THE SAME STRIP THE REST OF THE PRODUCT USES.
              Two buttons were hand-rolled here and both were poorer for it: the WhatsApp one opened NOTHING —
              it recorded a contact and left the agent to find the customer in WhatsApp themselves — and there
              was no SMS at all, on the one screen where the whole job is reaching somebody. `ContactButtons`
              already carries the ready-made messages, filtered by channel and filled with this order's own
              words, and the tracking and couriers screens already use it.

              THE PRESS IS LOGGED BY THE STRIP, AND IS NOT AN OUTCOME. This screen used to file a dialled call
              as `ANSWERED` — the strongest result there is — because it had nothing weaker to say. The answer
              rate then counted every dial as a conversation, which is the same inflation the note beside
              `MESSAGE_SENT` warns about for messages. The strip records `OPENED` on every screen now, so a
              call placed from the orders list leaves the same trace as one placed here. The outcome is still
              recorded by the person who knows it: «لا يرد» or «تأكيد».
            */
            const contact = (
              <ContactButtons
                phone={order.customer.rawPhone}
                context={{
                  orderNumber: order.orderNumber,
                  customerName: order.customer.fullName,
                  amount: order.totalAmount,
                  region: order.customer.city,
                }}
                orderId={order.id}
              />
            );
            /*
              IN THE ORDER THE WORK HAPPENS IN.

              She rings, and then one of four things is true. The confirmation is what most calls end in, and
              it was last — past «تأجيل», «ألغِ», «إشكال» and «مساعدة» — so the commonest press was the
              furthest from the thumb and sat beside the one that cancels. Confirm first, then postpone, then
              cancel. The two that are neither an outcome of the call — the entry issue and the assistant —
              come after them.

              THE THREE THAT DISPOSE OF THE ORDER, SHUT UNTIL SHE HAS TRIED TO REACH THE CUSTOMER. The server
              refuses them anyway (`needsContactFirst`), so this is not the rule — it is the agent being told
              the rule before she presses rather than after. The measured failure was «تأجيل» pressed with no
              call: the order went postponed, left her list, kept her claim, and blocked her next pull for
              ninety business minutes. «إدخال إشكال» and «مساعدة» stay open: neither decides anything about the
              order, and they are how she gets help when the call itself is the problem.
            */
            const confirmBtn = (
              <Action
                primary
                onClick={() => confirm(order)}
                busy={busyId === order.id}
                locked={needsContact(order)}
                lockedTitle={CONTACT_FIRST_MESSAGE}
                icon={<RiCheckboxCircleLine className="w-4 h-4" />}
                wide={phone}
              >
                تأكيد الطلب
              </Action>
            );
            const postponeBtn = (
              <Action
                onClick={() => setDialog({ kind: 'postpone', order })}
                busy={busyId === order.id}
                locked={needsContact(order)}
                lockedTitle={CONTACT_FIRST_MESSAGE}
                icon={<RiTimerLine className="w-4 h-4" />}
                wide={phone}
              >
                تأجيل {order.postponeCount > 0 && `(${order.postponeCount})`}
              </Action>
            );
            const rejectBtn = (
              <Action
                onClick={() => setDialog({ kind: 'reject', order })}
                busy={busyId === order.id}
                locked={needsContact(order)}
                lockedTitle={CONTACT_FIRST_MESSAGE}
                danger
                icon={<RiCloseCircleLine className="w-4 h-4" />}
                wide={phone}
              >
                ألغِ
              </Action>
            );
            const contactFirstHint = needsContact(order) && (
              <p className="w-full text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                اتصل بالزبون أول — بعدها بتفتح الأزرار
                {canLogContact
                  ? ' (سجّل المحاولة بـ«لا يرد» أو «مغلق أو خارج التغطية» إذا ما ردّ).'
                  : ' (تسجيل نتيجة الاتصال يحتاج صلاحية ما عندك — اطلبها من المسؤول).'}
              </p>
            );
            /*
              «إدخال إشكال», not «إشكال إدخال»: the button is the act she performs, and the old name read as the
              name of the thing — so it looked like a filter, not a door.

              AND ONLY ON AN ORDER A MODERATOR ENTERED. `POST /api/confirmation/issues` accepts `moderatorId`
              orders only: a store order — a landing page, Telegram, the POS — is refused with «لا يمكن فتح
              إشكال إدخال على طلب من مصدر خارجي». The button was drawn on every card, so the agent learned that
              by pressing it, and pressed it again on the next one. A button that exists in order to refuse
              teaches nothing the first four times. What replaces it on a store order is the note: the fact,
              and what to do instead.
            */
            const issueBtn = order.moderatorId && canRaiseIssue && (
              <Action onClick={() => setDialog({ kind: 'issue', order })} busy={busyId === order.id} icon={<RiAlertLine className="w-4 h-4" />}>
                إدخال إشكال
              </Action>
            );
            const storeOrderNote = !order.moderatorId && (
              <span className="w-full text-xs leading-relaxed text-[var(--sys-warning)]">
                طلب من المتجر — ما في مودريتور يصلّحه.
                <span className="text-[var(--sys-muted-foreground)]">
                  {' '}
                  إذا البيانات غلط: سجّل «رقم خطأ» أو ألغِ واكتب السبب.
                </span>
              </span>
            );
            /* Reads this order and this customer's history, and says what it would open with. It changes
               nothing — every button that does is on either side of it. */
            const assistBtn = canAskAssistant && (
              <Action onClick={() => setDialog({ kind: 'assist', order })} icon={<RiSparkling2Line className="w-4 h-4" />}>
                مساعدة
              </Action>
            );
            const moreHolds = ['افتح وعدّل', !!(order.moderatorId && canRaiseIssue) && 'إدخال إشكال', canAskAssistant && 'مساعدة']
              .filter(Boolean)
              .join(' · ');
            return (
              <article key={order.id} className={`border rounded-lg p-4 space-y-3 ${cardTone(order.noAnswerCount, data.noAnswerLimit, closed)}`}>
                <header className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-[var(--sys-heading)]" dir="ltr">{order.orderNumber}</span>
                  <OrderStateBadge state={order.state} />
                  {/* Where it came from — see `sourceLabel`. It decides what
                      she can do about bad data, so it belongs beside the
                      number rather than three cards deep. */}
                  <span className="text-xs text-[var(--sys-muted-foreground)]">{sourceLabel(order)}</span>
                  {/* ⚠️ The count in words, because the card's colour must
                      never be the only place it is said. */}
                  {order.noAnswerCount > 0 && !closed && (
                    <span className="text-xs font-medium text-[var(--sys-warning)]">
                      {noAnswerWords(order.noAnswerCount)}
                      <span className="tabular-nums" dir="ltr"> ({order.noAnswerCount}/{data.noAnswerLimit})</span>
                    </span>
                  )}
                  {closed && (
                    <span className="text-xs font-medium text-[var(--sys-destructive)]">
                      أُغلق اليوم تلقائيّاً — {noAnswerWords(order.noAnswerCount)}
                    </span>
                  )}
                  <CustomerHistoryButton
                    customerId={order.customer.id}
                    orderId={order.id}
                    previousOrders={order.previousOrders}
                    holderId={holderId}
                  />
                  {order.risk && (
                    <span className={`text-xs px-2 py-0.5 rounded-md border ${RISK_LABEL[order.risk.tier].cls}`}>
                      {RISK_LABEL[order.risk.tier].text} · {Math.round(order.risk.returnRate * 100)}% مرتجع من{' '}
                      {order.risk.orders} طلب
                    </span>
                  )}
                  <ResponseClock
                    claimedAt={order.claimedAt}
                    firstActionAt={order.firstActionAt}
                    serverNow={data.serverNow}
                  />
                  <span className="mr-auto text-sm font-semibold text-[var(--sys-heading)] tabular-nums" dir="ltr">
                    <Money value={order.totalAmount} currency={order.currency} />
                  </span>
                </header>

                <div className="text-sm text-[var(--sys-foreground)]">
                  {/* A PHONE: EACH FACT IN ITS OWN BOX (ORD-23). A name, a number and a city typed into one string are
                      one bidirectional run — the number lands against the name with its separator on the far side of
                      it, and the line breaks in the middle of a fact. The orders list fixed this exact defect; a desk's
                      line is left as it was. */}
                  {phone ? (
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span dir="auto">{order.customer.fullName}</span>
                      <span dir="ltr">{order.customer.rawPhone}</span>
                      <span dir="auto">{order.customer.city}</span>
                    </span>
                  ) : (
                    <>{order.customer.fullName} · <span dir="ltr">{order.customer.rawPhone}</span> · {order.customer.city}</>
                  )}
                  {governorateOf(order.region?.name, order.customer.city) && (
                    <p className="text-xs text-[var(--sys-muted-foreground)] mt-1">المحافظة: {governorateOf(order.region?.name, order.customer.city)}</p>
                  )}
                  <p className="text-xs text-[var(--sys-muted-foreground)] mt-1">{order.deliveryAddress ?? order.customer.address}</p>
                </div>

                <ul className="text-xs text-[var(--sys-muted-foreground)] space-y-0.5">
                  {order.items.map((it) => (
                    <li key={it.id}>
                      {it.productName} × {it.quantity}
                      {it.freeQuantity > 0 && ` (+${it.freeQuantity} هدية)`}
                    </li>
                  ))}
                  {order.addOns?.map((a) => (
                    <li key={a.id}>
                      {POST_ORDER_ADDITION_AR}: {a.productName} ×{a.quantity} ({a.total})
                    </li>
                  ))}
                </ul>
                <OrderNotes customer={order.customerNotes} />

                {order.postponedUntil && (
                  <p className="text-xs text-[var(--sys-warning)]">
                    مؤجل حتى{' '}
                    <span dir="ltr">{arDate(order.postponedUntil)}</span>
                    {order.postponePreferredTime && ` · ${order.postponePreferredTime}`} · تأجيل رقم{' '}
                    {order.postponeCount}
                  </p>
                )}

                {order.risk?.requiresPrepaymentOrApproval && (
                  <p className="flex items-center gap-2 text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-2">
                    <RiShieldFlashLine className="w-4 h-4" /> عميل عالي الخطورة: يتطلب دفعاً مسبقاً أو موافقة المشرف.
                  </p>
                )}

                {/*
                  ── AND NO FOOTER AT ALL ON A CLOSED ONE ──

                  A row of greyed buttons reads as «try again in a minute».
                  The order is cancelled: the only thing left to do about it
                  is in «مركز التأكيد», by somebody who can reopen it. It is
                  shown here, today only, so the agent who made the third
                  call sees what it did rather than watching the card vanish.
                */}
                {closed ? (
                  <p className="text-xs leading-relaxed text-[var(--sys-destructive)] pt-1 border-t border-[var(--sys-destructive-border)]">
                    للقراءة فقط — أُغلق بعد {data.noAnswerLimit} محاولات بلا رد. إعادةُ فتحِه من مركز التأكيد، بيد مَن يملك ذلك.
                  </p>
                ) : phone ? (
                /*
                  A PHONE: THREE ROWS, EACH ONE A DECISION (ORD-05).

                  The footer was one wrapping row of up to eleven things — the contact strip, two call results,
                  three outcomes, a hint, two helpers — and at 311px they piled into five or six rows of mixed
                  heights with the confirmation in the middle of the pile, beside «ألغِ». Now: reaching the
                  customer (the strip, then the two call results); then what the call decided — «تأكيد الطلب»
                  alone and full width, «تأجيل» and «ألغِ» side by side below it; and the rest behind one fold
                  that names what it holds. The same buttons, the same handlers, the same locks: `Action` is
                  drawn once per card and only the place it sits changes.
                */
                <footer className="space-y-3 pt-1 border-t border-[var(--sys-border)]">
                  {canLogContact && (
                    <div className="space-y-2">
                      {contact}
                      <div className="grid grid-cols-2 gap-2">
                        {noAnswerBtn}
                        {unreachableBtn}
                      </div>
                      {remainingHint}
                    </div>
                  )}
                  <div className="space-y-2">
                    {confirmBtn}
                    <div className="grid grid-cols-2 gap-2">
                      {postponeBtn}
                      {rejectBtn}
                    </div>
                    {contactFirstHint}
                  </div>
                  {storeOrderNote}
                  <AdvancedGroup label="المزيد" holds={moreHolds}>
                    {openBtn}
                    {issueBtn}
                    {assistBtn}
                  </AdvancedGroup>
                </footer>
                ) : (
                <footer className="flex flex-wrap items-center gap-2 pt-1 border-t border-[var(--sys-border)]">
                  {openBtn}
                  {canLogContact && (
                  <>
                  {noAnswerBtn}
                  {unreachableBtn}
                  {remainingHint}
                  {contact}
                  </>
                  )}
                  {confirmBtn}
                  {postponeBtn}
                  {rejectBtn}
                  {contactFirstHint}
                  {issueBtn}
                  {storeOrderNote}
                  {assistBtn}
                </footer>
                )}
              </article>
            );
          })}
        </div>
      </section>
      )}

      {tab === 'postponed' && <ConfirmationPostponedScreen embedded />}

      {tab === 'done' && (
      <section className="space-y-3">
        {/*
          ── A DAY, A SEARCH AND A PAGE — ALL THREE REAL CONTROLS ──

          This list was `take: 100` by `confirmedAt desc`: the last hundred
          she ever confirmed. An agent who has confirmed a thousand orders
          cannot reach Tuesday's from here, and the search box on top of it
          searched only those hundred — so it answered «لا شيء يطابق» about
          a list it had never looked in.

          «اليوم» is the question she actually asks of this list, so today
          is where it opens. The date, the text and the page all go to the
          server, and the heading says how many are behind them.
        */}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setDoneQuery(doneTyped.trim());
            setDonePage(1);
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-[var(--sys-muted-foreground)]">
            اليوم
            <input
              type="date"
              value={doneDay || confirmed.day}
              onChange={(e) => {
                setDoneDay(e.target.value);
                setDonePage(1);
              }}
              className="h-11 md:h-8 px-2.5 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-xs text-[var(--sys-foreground)] tabular-nums focus:outline-none focus:border-[var(--sys-primary)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--sys-muted-foreground)]">
            رقم الطلب أو الاسم أو الهاتف
            <input
              value={doneTyped}
              onChange={(e) => setDoneTyped(e.target.value)}
              placeholder="ابحث في هذا اليوم"
              className="h-11 md:h-8 w-56 px-2.5 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-xs text-[var(--sys-foreground)] focus:outline-none focus:border-[var(--sys-primary)]"
            />
          </label>
          <button
            type="submit"
            className="h-11 md:h-8 inline-flex items-center gap-1.5 px-3 rounded-lg text-xs font-medium bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] border border-[var(--sys-primary)]"
          >
            <RiSearchLine className="w-4 h-4" /> ابحث
          </button>
          {(doneQuery || doneDay) && (
            <button
              type="button"
              onClick={() => {
                setDoneTyped('');
                setDoneQuery('');
                setDoneDay('');
                setDonePage(1);
              }}
              className="h-11 md:h-8 inline-flex items-center gap-1.5 px-3 rounded-lg text-xs border border-[var(--sys-border)] bg-[var(--sys-card)] text-[var(--sys-foreground)]"
            >
              <RiCloseLine className="w-4 h-4" /> رجّعني لليوم
            </button>
          )}
        </form>
        <h2 className="text-sm font-bold text-[var(--sys-heading)]">
          أكّدتها{' '}
          <span className="tabular-nums font-normal text-[var(--sys-muted-foreground)]" dir="ltr">
            {confirmed.total}
          </span>
          <span className="font-normal text-[var(--sys-muted-foreground)]">
            {' '}· <span dir="ltr" className="tabular-nums">{confirmed.day}</span>
            {confirmed.q && ` · «${confirmed.q}»`}
            {confirmed.pages > 1 && ` · صفحة ${confirmed.page} من ${confirmed.pages}`}
          </span>
        </h2>
        <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
                    <Rows
            rows={confirmed.rows}
            keyOf={(order) => order.id}
            columns={[
              { key: 'c0', label: "الطلب", primary: true,
                // The number opens the order's panel here, on her desk — only for
                // whoever may read it (the work key, or «عرض الطلبات»); else text.
                render: (order) =>
                  holderId !== null || userCan(currentUser, 'orders.view') ? (
                    <button
                      type="button"
                      onClick={() => setOpenOrderId(order.id)}
                      className="min-h-11 md:min-h-0 underline"
                      dir="ltr"
                    >
                      {order.orderNumber}
                    </button>
                  ) : (
                    order.orderNumber
                  ) },
              { key: 'c1', label: "العميل", primary: true,
                render: (order) => (
                  <><span className="flex items-center gap-2">
                      {order.customer.fullName}
                      <CustomerHistoryButton
                        customerId={order.customer.id}
                        orderId={order.id}
                        previousOrders={order.previousOrders}
                        holderId={holderId}
                      />
                    </span></>
                ) },
              { key: 'c2', label: "الهاتف",
                render: (order) => (
                  <><a href={`tel:${order.customer.rawPhone}`} className="tabular-nums hover:text-[var(--sys-primary)]">
                      {order.customer.rawPhone}
                    </a></>
                ) },
              /* What is in the order and where it goes — on the row, so she does not open it to read it. Display only. */
              { key: 'goods', label: "المنتجات", wide: true,
                render: (order) => (
                  <><OrderGoods items={order.items} addOns={order.addOns} />
                    <OrderNotes customer={order.customerNotes} /></>
                ) },
              { key: 'place', label: "العنوان", wide: true,
                render: (order) => (
                  <OrderPlace region={order.region?.name} city={order.customer.city} address={streetOf(order.deliveryAddress, order.customer.address)} />
                ) },
              { key: 'c3', label: "المبلغ", align: 'end',
                render: (order) => (
                  <><Money value={order.totalAmount} currency={order.currency} /></>
                ) },
            ]}
            /* The CONFIRMED list's own words. It used to carry the copy of
               the section above it — «اسحب طلباً من الطابور» — which is
               advice about the other list, and it said it while a search
               was hiding rows too. */
            empty={
              confirmed.q ? (
                <EmptyState
                  title="لا طلبَ مؤكَّداً في هذا اليوم يطابق هذا البحث"
                  why={`البحث «${confirmed.q}» جرى على يوم ${confirmed.day} وحده — على رقم الطلب والاسم والهاتف. جرّبه على يومٍ آخر.`}
                  action={{ label: 'امسح البحث', onClick: () => { setDoneTyped(''); setDoneQuery(''); setDonePage(1); } }}
                />
              ) : (
                <EmptyState
                  title={`لم تؤكّد طلباً في ${confirmed.day}`}
                  why="ما تؤكّده يظهر هنا للقراءة — وتعديلُه بعدها يمرّ بطلبِ تعديل، لا بتحريرٍ مباشر. غيِّر اليومَ أعلاه لترى يوماً آخر."
                />
              )
            }
            actions={(order) => (
              <>{order.changeRequests && order.changeRequests.length > 0 ? (
                      <span className="text-xs text-[var(--sys-warning)]">طلب تعديل قيد المراجعة</span>
                    ) : (
                      <button
                        onClick={() => setDialog({ kind: 'change', order })}
                        disabled={busyId === order.id}
                        className="text-xs text-[var(--sys-primary)] hover:underline disabled:opacity-50"
                      >
                        طلب تعديل
                      </button>
                    )}</>
            )}
          />
        </div>
        {/*
          PAGES, AND THE NUMBER OF THEM.

          «السابق/التالي» with no total is a corridor: she cannot tell
          whether she is near the end or three hundred rows from it. The
          count and the page number are both said above, and the two
          buttons shut at the ends rather than asking for a page that is
          not there.
        */}
        {confirmed.pages > 1 && (
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={confirmed.page <= 1}
              onClick={() => setDonePage((p) => Math.max(1, p - 1))}
              className="h-11 md:h-8 px-3 rounded-lg text-xs border border-[var(--sys-border)] bg-[var(--sys-card)] text-[var(--sys-foreground)] disabled:opacity-50"
            >
              الأحدث
            </button>
            <span className="text-xs text-[var(--sys-muted-foreground)] tabular-nums" dir="ltr">
              {confirmed.page} / {confirmed.pages}
            </span>
            <button
              type="button"
              disabled={confirmed.page >= confirmed.pages}
              onClick={() => setDonePage((p) => p + 1)}
              className="h-11 md:h-8 px-3 rounded-lg text-xs border border-[var(--sys-border)] bg-[var(--sys-card)] text-[var(--sys-foreground)] disabled:opacity-50"
            >
              الأقدم
            </button>
          </div>
        )}
      </section>
      )}

      {dialog?.kind === 'postpone' && (
        <PostponeDialog
          open
          orderNumber={dialog.order.orderNumber}
          postponeCount={dialog.order.postponeCount}
          busy={busyId === dialog.order.id}
          onClose={() => setDialog(null)}
          onSubmit={(value) => submitPostpone(dialog.order, value)}
        />
      )}
      {dialog?.kind === 'issue' && (
        <IssueDialog
          open
          orderNumber={dialog.order.orderNumber}
          busy={busyId === dialog.order.id}
          onClose={() => setDialog(null)}
          onSubmit={(value) => submitIssue(dialog.order, value)}
        />
      )}
      {dialog?.kind === 'reject' && (
        <RejectDialog
          open
          orderNumber={dialog.order.orderNumber}
          busy={busyId === dialog.order.id}
          onClose={() => setDialog(null)}
          onSubmit={(value) => submitReject(dialog.order, value)}
        />
      )}
      {dialog?.kind === 'assist' && (
        <AssistantDialog
          orderId={dialog.order.id}
          orderNumber={dialog.order.orderNumber}
          customerName={dialog.order.customer.fullName}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'change' && (
        <ChangeRequestDialog
          open
          orderNumber={dialog.order.orderNumber}
          busy={busyId === dialog.order.id}
          onClose={() => setDialog(null)}
          onSubmit={(value) => submitChange(dialog.order, value)}
        />
      )}

      {/* The same modal the rest of the system opens an order in — not a
          second, smaller copy that would drift from it. */}
      {openOrderId && (
        <OrderDetailModal
          isOpen
          orderId={openOrderId}
          onClose={() => setOpenOrderId(null)}
          onRefresh={load}
        />
      )}
    </div>
  );
}

/**
 * How long this order has been waiting on her.
 *
 * An order pulled from the pool and not yet called is the most expensive
 * thing on this desk: the customer is still warm, and nobody else can take
 * it. Once she has done something, the clock stops and reports what it took
 * — a record, not a nag.
 */
function ResponseClock({
  claimedAt,
  firstActionAt,
  serverNow,
}: {
  claimedAt: string | null;
  firstActionAt: string | null;
  serverNow: string;
}) {
  const waiting = useElapsedMinutes(firstActionAt ? null : claimedAt, serverNow);

  if (firstActionAt && claimedAt) {
    const took = Math.max(0, Math.round((+new Date(firstActionAt) - +new Date(claimedAt)) / 60000));
    return (
      <span className="text-xs px-2 py-0.5 rounded-md border bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)] tabular-nums">
        رددت خلال {humanMinutes(took)}
      </span>
    );
  }
  if (waiting === null) return null;

  // Half an hour is the point at which a fresh order stops being fresh.
  const late = waiting >= 30;
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-md border tabular-nums ${
        late
          ? 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]'
          : 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30'
      }`}
    >
      بانتظار أول اتصال منذ {humanMinutes(waiting)}
    </span>
  );
}

/**
 * ONE OF THE THREE, WITH ITS COUNT AND WHAT IT HOLDS.
 *
 * The count and the note are on the tab and not inside it, because «which
 * of these do I do now» is decided before either list is open.
 *
 * `role="tab"` and `aria-selected` and not three styled buttons: the strip
 * announces itself as one choice of three to a screen reader, and arrow
 * keys move through it. A coloured underline alone would say nothing.
 */
function TabButton({
  active,
  onClick,
  label,
  count,
  note,
  tone,
  phone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  note?: string;
  tone?: 'warning';
  /** A phone keeps the tab to its label and count, on one line that never wraps. */
  phone?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={note}
      className={`${phone ? 'shrink-0 whitespace-nowrap ' : ''}min-h-11 md:min-h-0 px-3 py-2 -mb-px border-b-2 text-start ${
        active
          ? 'border-[var(--sys-primary)] text-[var(--sys-heading)]'
          : 'border-transparent text-[var(--sys-muted-foreground)] hover:text-[var(--sys-foreground)]'
      }`}
    >
      <span className="flex items-center gap-1.5 text-sm font-bold">
        {label}
        {count !== undefined && (
        <span
          className={`text-xs px-1.5 py-0.5 rounded-md border tabular-nums font-normal ${
            tone === 'warning'
              ? 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/40'
              : 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]'
          }`}
          dir="ltr"
        >
          {count}
        </span>
        )}
      </span>
      {note && !phone && <span className="block text-xs font-normal text-[var(--sys-muted)]">{note}</span>}
    </button>
  );
}

/**
 * A section's title, its count, and a box to find one row in it.
 *
 * The count says "3 of 12" while a search is running, because a filtered
 * list that says 3 with no context reads as "you only have three".
 */
function SectionHead({
  title,
  count,
  total,
  value,
  onChange,
  note,
  phone,
}: {
  title: string;
  count: number;
  total: number;
  value: string;
  onChange: (v: string) => void;
  note?: string;
  /** A phone drops the sentence (the open tab already says it) and gives the search box the whole line. */
  phone?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <h2 className="text-sm font-bold text-[var(--sys-heading)]">
        {title} ({value.trim() ? `${count} من ${total}` : total})
      </h2>
      {note && !phone && <span className="text-xs text-[var(--sys-muted)]">{note}</span>}
      <div className={phone ? 'relative w-full' : 'relative ms-auto'}>
        <RiSearchLine className="w-4 h-4 text-[var(--sys-muted)] absolute top-1/2 -translate-y-1/2 end-2.5" />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="رقم الهاتف أو الطلب أو الاسم"
          className={`h-11 md:h-8 ${phone ? 'w-full' : 'w-56'} ps-2.5 pe-8 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-xs text-[var(--sys-foreground)] focus:outline-none focus:border-[var(--sys-primary)]`}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="امسح البحث"
            className="absolute top-1/2 -translate-y-1/2 start-1.5 text-[var(--sys-muted)] hover:text-[var(--sys-destructive)]"
          >
            <RiCloseLine className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function Action({
  children,
  onClick,
  busy,
  /**
   * SHUT, AND NOT MERELY WAITING.
   *
   * Separate from `busy` on purpose: `busy` is «this is saving, a moment»
   * and `locked` is «you have not earned this yet». Folding the second
   * into the first would give the agent a button that looks like it is
   * thinking and never comes back, with no way to learn why.
   */
  locked,
  lockedTitle,
  primary,
  danger,
  icon,
  wide,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  locked?: boolean;
  lockedTitle?: string;
  primary?: boolean;
  danger?: boolean;
  icon?: React.ReactNode;
  /** A phone's button fills the cell it is in (a full row, or half of one). */
  wide?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || locked}
      title={locked ? lockedTitle : undefined}
      aria-disabled={locked || undefined}
      className={`${wide ? 'w-full justify-center ' : ''}min-h-11 md:min-h-0 inline-flex items-center flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50 ${
        primary
          ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] border-[var(--sys-primary)]'
          : danger
            ? 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]'
            : 'bg-[var(--sys-card)] text-[var(--sys-foreground)] border-[var(--sys-border)] hover:border-[var(--sys-primary)]'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
