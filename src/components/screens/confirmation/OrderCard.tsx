'use client';

import React from 'react';
import {
  RiAlertLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiPencilLine,
  RiPhoneLockLine,
  RiShieldFlashLine,
  RiSparkling2Line,
  RiTimerLine,
} from '@remixicon/react';
import { REGION_REQUIRED_MESSAGE } from '@/lib/confirmation-queue';
import { humanMinutes, useElapsedMinutes } from '@/components/ui/Elapsed';
import { CustomerHistoryButton } from '@/components/orders/CustomerHistory';
import { OrderStateBadge } from '@/components/orders/OrderStateBadge';
import { CopyValue } from '@/components/orders/CopyValue';
import { orderNumberToCopy } from '@/lib/copy-values';
import { ContactButtons } from '@/components/orders/ContactButtons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { arDate } from '@/lib/format';
import { Money } from '@/components/ui/Money';
import { cardTone, noAnswerWords, roundWords } from '@/lib/no-answer-tone';
import { POST_ORDER_ADDITION_AR } from '@/lib/post-order-offer-copy';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { OrderNotes, governorateOf } from '@/components/orders/OrderGoods';
import { CALL_PROOF_WORDS } from '@/lib/call-proof-words';

/**
 * THE ORDER CARD OF «طلباتي» — the one card drawn in «اتصلي هلّق», in «بانتظار» and for the ones the last no-answer closed today.
 * Moved out of `ConfirmationMineScreen.tsx` in R8d (18/11), on the kit, nothing else changed: its head (the number, the state,
 * where it came from, the counters and the clock), its body, and its footer of presses.
 *
 * PRESENTATION ONLY. The screen keeps every handler, every read and every «may she»: it hands this the order, the desk's
 * numbers (`data`), the three keys as yes/no (`canLogContact`, `canRaiseIssue`, `canAskAssistant`), the proof's lock, whether
 * the card is busy, the governorate's select (drawn by the screen — it reads the country's list), and ONE object of presses.
 * Nothing here reads the session, asks a permission or calls the server (`the-order-card-is-presentation.test.tsx`).
 */

/** What the card draws — the screen's order row carries these and more. */
export interface CardOrder {
  id: string;
  orderNumber: string;
  callHelperLink?: string;
  closesOnNext?: boolean;
  attemptWords?: string;
  noAnswerHint?: string;
  closedWords?: string;
  state: string;
  testStore?: boolean;
  previousOrders: number;
  totalAmount: number;
  currency: string;
  claimedAt: string | null;
  firstActionAt: string | null;
  postponedUntil: string | null;
  postponePreferredTime: string | null;
  postponeCount: number;
  noAnswerCount: number;
  dueNow?: boolean;
  dueReason?: 'NEW' | 'PROMISE' | 'ROUND' | null;
  dueWords?: string | null;
  source: string | null;
  deliveryAddress?: string | null;
  region?: { name: string } | null;
  regionId?: string | null;
  customerNotes?: string | null;
  moderatorId: string | null;
  moderator: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  channel: { id: string; name: string } | null;
  customer: { id: string; fullName: string; rawPhone: string; city: string; address: string };
  items: { id: string; productName: string; quantity: number; freeQuantity: number; variantSummary?: string | null }[];
  addOns?: { id: string; productName: string; quantity: number; total: number }[];
  _count: { contactAttempts: number };
  risk?: { tier: 'SAFE' | 'WATCH' | 'HIGH'; returnRate: number; orders: number; requiresPrepaymentOrApproval: boolean } | null;
}

/** The desk's own numbers the card prints — the server's, from the same answer. */
export interface CardDesk {
  noAnswerLimit: number;
  rounds?: boolean;
  cadenceOn?: boolean;
  dialCode?: string | null;
  serverNow: string;
}

/** Every press of the card, each one the screen's handler — the card only says which order. */
export interface CardPresses<O> {
  onOpenOrder: (order: O) => void;
  onNoAnswer: (order: O) => void;
  onUnreachable: (order: O) => void;
  onConfirm: (order: O) => void;
  onDialog: (kind: 'postpone' | 'reject' | 'issue' | 'assist', order: O) => void;
  /** The contact strip's press — absent when the screen has nothing to do on it (no call sheet, no proof). */
  onContacted?: (order: O, method: 'PHONE' | 'SMS' | 'WHATSAPP') => void;
}

const RISK_LABEL: Record<string, { text: string; cls: string }> = {
  SAFE: { text: 'خطورة منخفضة', cls: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/30' },
  WATCH: { text: 'تحت المراقبة', cls: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30' },
  HIGH: { text: 'خطورة عالية', cls: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]' },
};

/**
 * HAS ANYBODY TRIED TO REACH THIS CUSTOMER YET?
 *
 * One question, asked of the count the row already carries, so the three
 * buttons and the line under them can never disagree about it.
 */
export const needsContact = (order: { _count: { contactAttempts: number } }) =>
  order._count.contactAttempts === 0;

/**
 * DOES THIS ORDER LACK ITS GOVERNORATE? (the owner, 30/10 — «ما يسمح لموظفة التأكيد تأكّد غير لما تحدد المحافظة»)
 *
 * Asked of the id and never of the written city: `customer.city` is free text, and a town typed there is not a row in
 * the fee table. An answer that has not arrived (`undefined`, a response from before the id was read) is NOT «none» —
 * the door is the authority and refuses it anyway; the screen only avoids shutting a button on a guess.
 */
export const lacksRegion = (order: { regionId?: string | null }) =>
  order.regionId === null || (typeof order.regionId === 'string' && order.regionId.trim() === '');

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

function sourceLabel(order: CardOrder): string {
  if (order.moderator?.name) return `مودريتور: ${order.moderator.name}`;
  if (order.source === 'MANUAL' && order.createdBy?.name) return `إدخال يدوي: ${order.createdBy.name}`;
  if (order.channel?.name) return order.channel.name;
  if (order.source) return SOURCE_AR[order.source] ?? order.source;
  return 'مصدر غير مسجَّل';
}

export function OrderCard<O extends CardOrder>({
  order,
  closed,
  domId,
  flash,
  data,
  readOnly,
  watchedName,
  phone,
  busy,
  canLogContact,
  canRaiseIssue,
  canAskAssistant,
  proofOn,
  lock,
  contactFirstText,
  holderId,
  regionGate,
  presses,
}: {
  order: O;
  /** Closed today by the last no-answer: read-only, and no footer at all. */
  closed?: boolean;
  /** The card's DOM id — what the refusal's link and «الشغل أول» scroll to. */
  domId: string;
  /** Rung by the screen when a link or a press brought her here. */
  flash: boolean;
  data: CardDesk;
  /** A colleague's desk, read through «شاشة موظفة»: not one press of hers. */
  readOnly: boolean;
  watchedName: string;
  phone: boolean;
  /** The screen's `busyId` is this order. */
  busy: boolean;
  canLogContact: boolean;
  canRaiseIssue: boolean;
  canAskAssistant: boolean;
  proofOn: boolean;
  /** «إثبات المكالمات»: why «لا يرد» is shut now, in words — or nothing. */
  lock: { text: string | null };
  contactFirstText: string;
  /** The history's holder: hers on her own desk. */
  holderId: string | null;
  /** The governorate's select, drawn by the screen on the card that needs it (or nothing). */
  regionGate?: React.ReactNode;
  presses: CardPresses<O>;
}) {
  const remaining = Math.max(0, data.noAnswerLimit - order.noAnswerCount);
  /*
    THE «لا يرد» BUTTON AND THE HINT BESIDE IT SAY WHAT THE SERVER KNOWS (the owner, 17/11 — «أزرار بتناقض بطاقاتها»).

    Under the plan (`cadenceOn`) the button prints the attempt THIS press will be — «محاولة 2 من 5», the very words of the card's tag (`attemptWords`, written by the server through `nextAttemptWords`,
    one function) — and it is red only when the server said a press now would close the order (`closesOnNext`). Under the rounds the number of presses
    left is not the number of rounds left, so the card says nothing it cannot know: no countdown, no red. Only the base rule (neither switch) keeps
    the client's arithmetic, because there every press counts and the arithmetic is true.
  */
  const planned = !!data.cadenceOn;
  const closesNow = planned ? !!order.closesOnNext : !data.rounds && remaining <= 1;
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
      onClick={() => presses.onOpenOrder(order)}
      locked={needsContact(order)}
      lockedTitle={contactFirstText}
      icon={<RiPencilLine className="w-4 h-4" />}
    >
      افتح وعدّل
    </Action>
  );
  /* 1/2/3 counter — the third no-answer closes the order by rule */
  const lockProps = lock.text ? { locked: true, lockedTitle: lock.text } : {};
  const noAnswerBtn = (
    <Action
      onClick={() => presses.onNoAnswer(order)}
      {...lockProps}
      busy={busy}
      icon={<RiPhoneLockLine className="w-4 h-4" />}
      danger={closesNow}
      wide={phone}
    >
      لا يرد
      {order.attemptWords ? (
        ` — ${order.attemptWords}`
      ) : (
        <span className="tabular-nums" dir="ltr">
          {' '}
          {order.noAnswerCount}/{data.noAnswerLimit}
        </span>
      )}
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
      onClick={() => presses.onUnreachable(order)}
      {...lockProps}
      busy={busy}
      icon={<RiPhoneLockLine className="w-4 h-4" />}
      danger={closesNow}
      wide={phone}
    >
      مغلق أو خارج التغطية
    </Action>
  );
  // Said only where it is true: the base rule's arithmetic, or the plan's own fact for this card (`closesOnNext`). Under the rounds, and under the plan when a press now would not close it: nothing.
  // The server's words (`noAnswerHint`): only what is true for the rule in force — the desk counts nothing (finding #11, and its bundle is at its ceiling).
  const remainingHint = order.noAnswerHint && <span className="text-note text-[var(--sys-muted)]">{order.noAnswerHint}</span>;
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
      countryCode={data.dialCode}
      context={{
        orderNumber: order.orderNumber,
        customerName: order.customer.fullName,
        amount: order.totalAmount,
        region: order.customer.city,
      }}
      orderId={order.id}
      callHref={order.callHelperLink}
      onContacted={presses.onContacted ? (method) => presses.onContacted?.(order, method) : undefined}
    />
  );
  /*
    IN THE ORDER THE WORK HAPPENS IN.

    She rings, and then one of four things is true. The confirmation is what most calls end in, and
    it was last — past «تأجيل», «ألغِ», «إشكال» and «مساعدة» — so the commonest press was the
    furthest from the thumb and sat beside the one that cancels. Confirm first, then postpone, then
    cancel. The two that are neither an outcome of the call — the entry issue and the assistant —
    come after them.

    THE ONES THAT DISPOSE OF THE ORDER, SHUT UNTIL SHE HAS TRIED TO REACH THE CUSTOMER («ألغِ» is not among
    them: it opens the dialog, which shuts only the reasons that need a word — the owner, 30/10). The server
    refuses them anyway (`needsContactFirst`), so this is not the rule — it is the agent being told
    the rule before she presses rather than after. The measured failure was «تأجيل» pressed with no
    call: the order went postponed, left her list, kept her claim, and blocked her next pull for
    ninety business minutes. «إدخال إشكال» and «مساعدة» stay open: neither decides anything about the
    order, and they are how she gets help when the call itself is the problem.
  */
  /*
    AND SHUT UNTIL IT HAS ITS GOVERNORATE (the owner, 30/10). The door refuses it too (`REGION_REQUIRED`); the
    line under the button says what opens it, and the select that does is on this very card.
  */
  const confirmBtn = (
    <Action
      primary
      onClick={() => presses.onConfirm(order)}
      busy={busy}
      locked={needsContact(order) || lacksRegion(order)}
      lockedTitle={needsContact(order) ? contactFirstText : REGION_REQUIRED_MESSAGE}
      icon={<RiCheckboxCircleLine className="w-4 h-4" />}
      wide={phone}
    >
      تأكيد الطلب
    </Action>
  );
  const postponeBtn = (
    <Action
      onClick={() => presses.onDialog('postpone', order)}
      busy={busy}
      locked={needsContact(order)}
      lockedTitle={contactFirstText}
      icon={<RiTimerLine className="w-4 h-4" />}
      wide={phone}
    >
      تأجيل {order.postponeCount > 0 && `(${order.postponeCount})`}
    </Action>
  );
  const rejectBtn = (
    <Action
      onClick={() => presses.onDialog('reject', order)}
      busy={busy}
      danger
      icon={<RiCloseCircleLine className="w-4 h-4" />}
      wide={phone}
    >
      ألغِ
    </Action>
  );
  const contactFirstHint = needsContact(order) && (
    <p className="w-full text-note leading-relaxed text-[var(--sys-muted-foreground)]">
      {proofOn && canLogContact ? (
        CALL_PROOF_WORDS.contactFirstV2
      ) : (
        <>
          اتصل بالزبون أول — بعدها بتفتح الأزرار
          {canLogContact
            ? ' (سجّل المحاولة بـ«لا يرد» أو «مغلق أو خارج التغطية» إذا ما ردّ).'
            : ' (تسجيل نتيجة الاتصال يحتاج صلاحية ما عندك — اطلبها من المسؤول).'}
        </>
      )}
    </p>
  );
  /* «إثبات المكالمات»: why «لا يرد» and «مغلق أو خارج التغطية» are shut — in words, because a phone has no tooltip. */
  const proofHint = canLogContact && lock.text && (
    <p className="w-full text-note leading-relaxed tabular-nums text-[var(--sys-warning)]">{lock.text}</p>
  );
  const regionHint = lacksRegion(order) && (
    <p className="w-full text-note leading-relaxed text-[var(--sys-warning)]">اختر المحافظة لتفتح التأكيد</p>
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
    <Action onClick={() => presses.onDialog('issue', order)} busy={busy} icon={<RiAlertLine className="w-4 h-4" />}>
      إدخال إشكال
    </Action>
  );
  const storeOrderNote = !order.moderatorId && (
    <span className="w-full text-note leading-relaxed text-[var(--sys-warning)]">
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
    <Action onClick={() => presses.onDialog('assist', order)} icon={<RiSparkling2Line className="w-4 h-4" />}>
      مساعدة
    </Action>
  );
  const moreHolds = ['افتح وعدّل', !!(order.moderatorId && canRaiseIssue) && 'إدخال إشكال', canAskAssistant && 'مساعدة']
    .filter(Boolean)
    .join(' · ');
  return (
    <article
      id={domId}
      className={`scroll-mt-24 rounded-lg${flash ? ' ring-2 ring-[var(--sys-primary)]' : ''}`}
    >
      <Card padding="md" className={`space-y-3 ${cardTone(order.noAnswerCount, data.noAnswerLimit, closed)}`}>
      <header className="flex flex-wrap items-center gap-2">
        {/* Text, not `OrderRef`: a number that opened the order would be the way around «افتح وعدّل»,
            which stays locked until she has rung the customer. Only the copy button is added. */}
        <span className="inline-flex items-center gap-1">
          <span className="font-semibold text-[var(--sys-heading)]" dir="ltr">{order.orderNumber}</span>
          <CopyValue text={orderNumberToCopy(order.orderNumber)} noun="رقم الطلب" shown={order.orderNumber} />
        </span>
        <OrderStateBadge state={order.state} testStore={order.testStore} />
        {/* Where it came from — see `sourceLabel`. It decides what
            she can do about bad data, so it belongs beside the
            number rather than three cards deep. */}
        <span className="text-note text-[var(--sys-muted-foreground)]">{sourceLabel(order)}</span>
        {/* ⚠️ The count in words, because the card's colour must
            never be the only place it is said. */}
        {/* Under the plan the server's own line (`dueWords`, below) already says «محاولة N من 5»; the chip would be a second counter beside it («ما ردّ مرّتين (2/5)»). It is drawn only where
            that line is not (a colleague's desk, a complete plan) — and then in the same words, from the same function. */}
        {order.noAnswerCount > 0 && !closed && !(order.dueNow && order.dueReason === 'ROUND' && !readOnly) && !(planned && !readOnly && order.dueWords) && (
          <span className="text-note font-medium text-[var(--sys-warning)]">
            {planned ? (
              order.attemptWords
            ) : (
              <>
                {data.rounds ? roundWords(order.noAnswerCount, data.noAnswerLimit) : noAnswerWords(order.noAnswerCount)}
                <span className="tabular-nums" dir="ltr"> ({order.noAnswerCount}/{data.noAnswerLimit})</span>
              </>
            )}
          </span>
        )}
        {/* «الشغل أول»: what she pulled, in a few words (written by the server) — a new order, a «لا يرد» that came back
            (with its round, so the chip above is not said twice), a customer's date that arrived; a waiting card says when
            it is ready. */}
        {!closed && !readOnly && order.dueWords && (
          <span
            className={`text-note px-2 py-0.5 rounded-md border ${
              order.dueNow
                ? 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30'
                : 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)] tabular-nums'
            }`}
          >
            {order.dueWords}
          </span>
        )}
        {closed && (
          <span className="text-note font-medium text-[var(--sys-destructive)]">
            أُغلق اليوم تلقائيّاً — {order.closedWords ?? noAnswerWords(order.noAnswerCount)}
          </span>
        )}
        <CustomerHistoryButton
          customerId={order.customer.id}
          orderId={order.id}
          previousOrders={order.previousOrders}
          holderId={readOnly ? null : holderId}
        />
        {order.risk && (
          <span className={`text-note px-2 py-0.5 rounded-md border ${RISK_LABEL[order.risk.tier].cls}`}>
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
          <p className="text-note text-[var(--sys-muted-foreground)] mt-1">المحافظة: {governorateOf(order.region?.name, order.customer.city)}</p>
        )}
        <p className="text-note text-[var(--sys-muted-foreground)] mt-1">{order.deliveryAddress ?? order.customer.address}</p>
      </div>
      {/* An order with no governorate cannot be confirmed: the select that sets it is HERE, drawn without a click. */}
      {regionGate}

      <ul className="text-note text-[var(--sys-muted-foreground)] space-y-0.5">
        {order.items.map((it) => (
          <li key={it.id}>
            {it.productName} × {it.quantity}
            {it.freeQuantity > 0 && ` (+${it.freeQuantity} هدية)`}
            {/* The size and colour of every piece — read out on the call (product variants). */}
            {it.variantSummary && <span className="font-semibold text-[var(--sys-heading)]"> — {it.variantSummary}</span>}
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
        <p className="text-note text-[var(--sys-warning)]">
          مؤجل حتى{' '}
          <span dir="ltr">{arDate(order.postponedUntil)}</span>
          {order.postponePreferredTime && ` · ${order.postponePreferredTime}`} · تأجيل رقم{' '}
          {order.postponeCount}
        </p>
      )}

      {order.risk?.requiresPrepaymentOrApproval && (
        <p className="flex items-center gap-2 text-note text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-2">
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
        <p className="text-note leading-relaxed text-[var(--sys-destructive)] pt-1 border-t border-[var(--sys-destructive-border)]">
          للقراءة فقط — أُغلق {order.closedWords ?? `بعد ${data.cadenceOn ? order.noAnswerCount : data.noAnswerLimit} محاولات بلا رد`}. إعادةُ فتحِه من مركز التأكيد، بيد مَن يملك ذلك.
        </p>
      ) : readOnly ? (
        /* A colleague's desk: not one button of hers — no call, no result, no confirm, no postpone, no cancel. */
        <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)] pt-1 border-t border-[var(--sys-border)]">
          للقراءة فقط — هذا الطلب بيد {watchedName}.
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
            {proofHint}
          </div>
        )}
        <div className="space-y-2">
          {confirmBtn}
          <div className="grid grid-cols-2 gap-2">
            {postponeBtn}
            {rejectBtn}
          </div>
          {contactFirstHint}
          {regionHint}
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
        {proofHint}
        {regionHint}
        {issueBtn}
        {storeOrderNote}
        {assistBtn}
      </footer>
      )}
      </Card>
    </article>
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
      <span className="text-note px-2 py-0.5 rounded-md border bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)] tabular-nums">
        رددت خلال {humanMinutes(took)}
      </span>
    );
  }
  if (waiting === null) return null;

  // Half an hour is the point at which a fresh order stops being fresh.
  const late = waiting >= 30;
  return (
    <span
      className={`text-note px-2 py-0.5 rounded-md border tabular-nums ${
        late
          ? 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]'
          : 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30'
      }`}
    >
      بانتظار أول اتصال منذ {humanMinutes(waiting)}
    </span>
  );
}

export function Action({
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
  /*
    THE KIT'S BUTTON (R8d, 18/11), AND THE PRESS IS STILL THE SCREEN'S. The handler returns nothing to the kit (`{ onClick(); }`): a
    promise handed to `Button` would make it run its own busy flag beside the screen's `busyId`, and the screen's is the one every
    press of the card shares. The tone is the old one's: the confirmation `primary`, a press that closes or cancels `danger`, the
    rest `secondary`. `type="button"`: it is never a form's submit.
  */
  return (
    <Button
      type="button"
      size="sm"
      variant={primary ? 'primary' : danger ? 'danger' : 'secondary'}
      onClick={() => {
        onClick();
      }}
      disabled={busy || locked}
      title={locked ? lockedTitle : undefined}
      aria-disabled={locked || undefined}
      className={wide ? 'w-full' : undefined}
    >
      {icon}
      {children}
    </Button>
  );
}
