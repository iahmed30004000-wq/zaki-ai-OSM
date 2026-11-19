'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { apiJson } from '@/lib/api-client';
import { CONTACT_FIRST_MESSAGE, REGION_REQUIRED_MESSAGE } from '@/lib/confirmation-queue-messages';
import { useRegions } from '@/hooks/useRegions';
import { matchRegion } from '@/lib/regions';
import { useOrderPatch } from '@/components/orders/useOrderPatch';
import { ContactButtons } from '@/components/orders/ContactButtons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageShell } from '@/components/ui/PageShell';
import { routeLabel } from '@/lib/route-registry';
import {
  ChangeRequestDialog,
  IssueDialog,
  PostponeDialog,
  RejectDialog,
  type ChangeRequestValue,
  type PostponeValue,
} from './confirmation/ActionDialogs';
import { raiseChangeRequest } from '@/components/orders/raiseChangeRequest';
import { onOpenTrolley, ON_TROLLEY_AR } from '@/lib/order-seal';
import { TwinConfirmedDialog } from '@/components/orders/TwinConfirmedDialog';
import { confirmAnywayBody, rejectAsDuplicateBody, twinsFromRefusal, type ConfirmedTwinView } from '@/lib/twin-refusal';
import { RiAddCircleLine, RiLoader4Line } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/Confirm';
import { deskIsEmpty, openPreparationStep } from '@/lib/next-step';
import { useMayOpen } from '@/hooks/useMayOpen';
import { PullPanel, useQueue } from '@/components/confirmation/PullPanel';
import { CustomerOnTheLine } from '@/components/confirmation/CustomerOnTheLine';
import { DeskHead } from './confirmation/DeskHead';
import { SectionHead, TabButton } from './confirmation/DeskTabs';
import { DoneList } from './confirmation/DoneList';
import { Action, OrderCard, lacksRegion, needsContact } from './confirmation/OrderCard';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { AI_ASSIST_KEY } from '@/lib/ai-assistants';
import { editsNow } from '@/lib/edit-confirmed-window';
import { EDIT_CONFIRMED_KEY } from '@/lib/edit-confirmed-key';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useIsPhone } from '@/hooks/useIsPhone';
import { CallOutcomeSheet, type LoggedOutcome } from '@/components/confirmation/CallOutcomeSheet';
import { WhatsAppAfterNoAnswer } from '@/components/confirmation/WhatsAppAfterNoAnswer';
import { useOutbox, usePendingCall, type SendAnswer } from '@/components/confirmation/useCallOutcome';
import { CallHelperCard } from '@/components/confirmation/CallHelperCard';
import { useHelperReading } from '@/components/confirmation/useHelperReading';
import { useCallProofClock } from '@/components/confirmation/useCallProofClock';
import { CALL_PROOF_WORDS, CLIENT_MARGIN_MS, MIN_CALL_MS, secondsLeft, type CallProofState } from '@/lib/call-proof-words';
import { flushContactLines, openedWaiting } from '@/lib/contact-line';
import { onAndroid } from '@/lib/call-helper/android';
import { LoadFailed } from '@/components/ui/LoadFailed';
import {
  ATTEMPT_RESULT,
  CALLBACK_REASON,
  alreadyLogged,
  attemptBody,
  followUpBody,
  isNetworkFailure,
  outgoingState,
  preferredClock,
  type CallbackChip,
  type Outgoing,
} from '@/lib/call-outcome';

/*
 * THE BIG WINDOWS LOAD WHEN ONE IS OPENED — the owner's ruling 4/11 («طلباتي أخف»).
 *
 * The order window, the create-order window, the assistant and the whole «مؤجّلة» tab were static imports, so every
 * agent downloaded all of them before the first card was drawn — on a phone, with a customer on the line. Each is drawn
 * only behind a press (or, for the create window, closed until one), so each comes in its own chunk the first time it
 * is rendered. Client-only (`ssr: false`): none has anything to say before the screen has loaded. While a chunk is on
 * its way the place shows the screen's own small spinner — or nothing, for the create window, which is rendered closed.
 *
 * NOT THE CALL SHEET. «شو صار؟» must be there ON the press, before the dialler takes the phone
 * (`the-call-sheet-waits-on-a-phone.test.tsx`); a chunk still on its way while the page is in the background is exactly
 * the wait this ruling is against. It stays a static import. `staff-confirmation-first-load.test.ts` holds both shapes.
 */
const Opening = () => <RiLoader4Line className="w-4 h-4 animate-spin" aria-label="جارٍ التحميل…" />;
const OrderDetailModal = dynamic(() => import('@/components/orders/OrderDetailModal').then((m) => m.OrderDetailModal), {
  ssr: false,
  loading: Opening,
});
const CreateOrderModal = dynamic(() => import('@/components/orders/CreateOrderModal').then((m) => m.CreateOrderModal), {
  ssr: false,
  loading: () => null,
});
const AssistantDialog = dynamic(() => import('./confirmation/AssistantDialog').then((m) => m.AssistantDialog), {
  ssr: false,
  loading: Opening,
});
const ConfirmationPostponedScreen = dynamic(
  () => import('@/components/screens/ConfirmationPostponedScreen').then((m) => m.ConfirmationPostponedScreen),
  { ssr: false, loading: Opening }
);

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
  /** «مساعد الاتصال»: the signed link «اتصل» opens when her phone is paired (`/api/confirmation/mine`). Absent = `tel:`. */
  callHelperLink?: string;
  /** «جدول المحاولات» is on: a press made NOW would close this order — a fact of the server's clock. Absent = the count decides, as it always did. */
  closesOnNext?: boolean;
  /** «جدول المحاولات» is on: the attempt the next press will be, in the one counter's words («محاولة 2 من 5», `attempt-words.ts`), written by the server. Absent = the old counters. */
  attemptWords?: string;
  /** The hint beside «لا يرد», only where it is true for the rule in force (`noAnswerHint`, written by the server). Absent = nothing. */
  noAnswerHint?: string;
  /** RV2391: the server's number-free sentence for a closed card whose count is not the close's. Absent = print the count as always. */
  closedWords?: string;
  merchantRef: string | null;
  confirmationStatus: string;
  state: string;
  /** A bench store's order (B2): «مؤكَّد — تيست، ما بينشحن». Absent = a real store's. */
  testStore?: boolean;
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
   * «الشغل أول» (`work-first.ts`): a call is owed on this order right now, why, when it falls due if it is waiting — and the
   * line the card prints about it («جديد — سحبتيه هلّق», «جاهز الساعة 14:00»…). Decided and worded on the server, with the very
   * verdict the pull's refusal asks; the screen only prints them. Absent on a response from before they were sent.
   */
  dueNow?: boolean;
  dueReason?: 'NEW' | 'PROMISE' | 'ROUND' | null;
  dueAt?: string | null;
  dueWords?: string | null;
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
  /** The governorate's id — null/empty means the order has none; absent on a response from before it was read. */
  regionId?: string | null;
  customerNotes?: string | null;
  moderatorId: string | null;
  moderator: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  channel: { id: string; name: string } | null;
  customer: { id: string; fullName: string; phone: string; rawPhone: string; city: string; address: string };
  items: { id: string; productName: string; quantity: number; freeQuantity: number; lineTotal: number; variantSummary?: string | null }[];
  /** What the customer added after ordering — absent on a response from before this field existed. */
  addOns?: { id: string; productName: string; quantity: number; total: number }[];
  _count: { contactAttempts: number; notes: number };
  /** «إثبات المكالمات» (only while it is on, only on a held card of her own desk): what her «لا يرد» waits for — the server's word, ticked here. */
  callProof?: CallProofState;
  risk?: RiskInfo | null;
  changeRequests?: { id: string }[];
  /**
   * WHERE A CONFIRMED ORDER IS — only the «أكّدتها» rows carry them (`orders.edit_confirmed`, 2/11): who holds it, the trolley it
   * sits on, and whether it has shipped or its waybill is printed. With them the row can say «تعديل» for the orders she changes
   * herself; without them (an older response, another tab) it says what it always said.
   */
  claimedById?: string | null;
  shippingStatus?: string;
  shippingBatchId?: string | null;
  /** The trolley's status — on one still being filled nothing is asked of the order (the owner's ruling 4/11). */
  shippingBatch?: { status: string } | null;
  shippedAt?: string | null;
  labelPrintedAt?: string | null;
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
  /** «نظام الجولات» is on: the counter is a round («جولة n من 3»). */
  rounds?: boolean;
  /** «جدول المحاولات» is on: the limit is 5 and the cards carry the server's words («محاولة 2 من 5 — جاهز الساعة 17:30»). */
  cadenceOn?: boolean;
  /** «الشغل أول»: how many calls she owes right now, the oldest of them, and the banner's sentence — the banner and the pull button. */
  due?: { count: number; first: { id: string; orderNumber: string } | null; sentence?: string | null; button?: string | null };
  /** The country's calling code («963») — WhatsApp needs the number in full. */
  dialCode?: string | null;
  /** «ابعت من رقم الشركة» is offered on the call sheet for this country (`after-no-answer.ts`). Absent = her own WhatsApp. */
  whatsappRoute?: 'COMPANY';
  /** The server's clock, so a wrong clock on her machine changes nothing. */
  serverNow: string;
  /** «إثبات المكالمات» is on: each held card carries `callProof`. Absent = off, and nothing below reads or draws anything new. */
  callProofOn?: boolean;
  /** How long «لا يرد» waits after «اتصال» — the rule in force's seconds (request Q3b). Absent = the default in `call-proof-words.ts`. */
  proofSeconds?: number;
  /** «اتصلي هلّق» — a call is owed on these right now (and the orders whose last call reached the customer and need a decision). */
  work: OrderRow[];
  /** «بانتظار» — they did not answer and are not due to be rung again yet. */
  noAnswer: OrderRow[];
  /** The third no-answer closed it today. Read-only, and shown so it is not a surprise. */
  closedToday: OrderRow[];
  confirmed: ConfirmedPage;
  /** Present only on a colleague's desk read through «شاشة موظفة» — whose it is. Never on her own. */
  viewing?: { id: string; name: string; readOnly: true };
  /**
   * What «أرجِع «لا يرد» للطابور» would do from here — the server's count and arithmetic (`return-no-answer-pile.ts`), present only
   * on a colleague's desk and only for a holder of the key its door asks. The screen draws the button from it and never counts.
   */
  returnPile?: { eligible: number; limit: number; thisPress: number; remainingAfter: number };
}

/** One name in the «شاشة موظفة» picker, with what she holds open now. */
interface WatchableAgent {
  id: string;
  name: string;
  holding: number;
}

type DialogState =
  | { kind: 'postpone' | 'issue' | 'change' | 'reject' | 'assist'; order: OrderRow }
  // The door held her yes back: this customer already has a confirmed order for the same product (`TWIN_CONFIRMED`).
  | { kind: 'twin'; order: OrderRow; twins: ConfirmedTwinView[] }
  | null;

/** Why the call sheet's «تأكيد الطلب» is shut — the card's own two locks, in the card's own words. */
const sheetConfirmLock = (order: { _count: { contactAttempts: number }; regionId?: string | null }, first = CONTACT_FIRST_MESSAGE) =>
  needsContact(order) ? first : lacksRegion(order) ? REGION_REQUIRED_MESSAGE : null;

const ONE_ANSWER_PER_CALL = 'جواب هالمكالمة انبعت — ما بينحفظ جواب تاني لنفس المكالمة.';
const SEND_BEFORE_REJECT = '«رقم غلط» لسا ما انبعت — استني الخط وبعدين ألغِ، حتى ما يوصل بعد الإلغاء.';

/** What the call sheet's answers are called in the line that says one is on its way. */
const LOGGED_WORDS: Record<LoggedOutcome, string> = {
  NO_ANSWER: 'ما رد',
  BUSY: 'مشغول',
  UNREACHABLE: 'مسكّر',
  WRONG_NUMBER: 'رقم غلط',
};

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
    // With «إثبات المكالمات» on the door says its own sentence (`contactFirstV2`), and «لا يرد» is no way out of it: that sentence, alone.
    return said === CALL_PROOF_WORDS.contactFirstV2
      ? said
      : `${CONTACT_FIRST_MESSAGE}. سجّل المحاولة بزر «لا يرد» أو «مغلق أو خارج التغطية» وبعدها بتفتح الأزرار.`;
  }
  // «إثبات المكالمات»: the three refusals say what the server said (its Arabic); the screen's own words only if that did not arrive in Arabic.
  if (code === 'CALL_NOT_STARTED' || code === 'CALL_TOO_SOON' || code === 'CALL_NOT_LOGGED') {
    return /[؀-ۿ]/.test(said)
      ? said
      : code === 'CALL_NOT_LOGGED'
        ? CALL_PROOF_WORDS.notLogged
        : code === 'CALL_TOO_SOON'
          ? CALL_PROOF_WORDS.refusedTooSoon(Number((e as { data?: { waitSeconds?: unknown } }).data?.waitSeconds) || 30)
          : CALL_PROOF_WORDS.refusedNotStarted;
  }
  if (code === 'REGION_REQUIRED') {
    return `${REGION_REQUIRED_MESSAGE}. اختر المحافظة من الخانة بالبطاقة.`;
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

/** The DOM id of an order's card on her desk — what the refusal's link scrolls to. */
const deskCardId = (orderId: string) => `desk-order-${orderId}`;

/**
 * THE GOVERNORATE, ASKED ON THE CARD THAT NEEDS IT (the owner, 30/10).
 *
 * An order with no `regionId` cannot be confirmed (`REGION_REQUIRED`), so the field that sets it is drawn on the card
 * itself — a real select, visible, not behind «افتح وعدّل». The governorates are the country's own (`useRegions`, the list
 * every order form reads); no second source.
 *
 * WHAT THE CUSTOMER TYPED IS A CLUE, NOT AN ANSWER. `customer.city` is free text, so it is printed as «المكتوب» — never
 * under the word «المحافظة» — and `matchRegion` (the matcher every intake path uses) turns it into a SUGGESTION: the select
 * starts on it and a line says so, but nothing is written until she presses «احفظ المحافظة». Ambiguity gives no suggestion.
 *
 * Shut while no call has been logged: the save is an edit, and the door refuses an edit by the holder before the first
 * attempt (`CONTACT_FIRST`) — the line under the buttons already says how to open it.
 */
function RegionGate({
  order,
  locked,
  busy,
  onSave,
  contactFirst = CONTACT_FIRST_MESSAGE,
}: {
  order: OrderRow;
  locked: boolean;
  busy: boolean;
  onSave: (regionId: string) => void;
  /** The «call first» sentence — the proof's own when «إثبات المكالمات» is on. */
  contactFirst?: string;
}) {
  const { regions, countryName } = useRegions();
  const fieldId = React.useId();
  const written = order.customer.city?.trim() ?? '';
  const guess = matchRegion(regions, written);
  // `null` = she has not touched it, so it follows the suggestion; her own choice (even «none») wins from then on.
  const [picked, setPicked] = useState<string | null>(null);
  const value = picked ?? guess?.id ?? '';
  return (
    <div className="rounded-lg border border-[var(--sys-warning)]/40 bg-[var(--sys-warning-soft)] p-2 space-y-2">
      <label htmlFor={fieldId} className="block text-note font-medium text-[var(--sys-warning)]">
        المحافظة — لازم قبل التأكيد{countryName ? ` (${countryName})` : ''}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={fieldId}
          value={value}
          disabled={locked || busy}
          onChange={(e) => setPicked(e.target.value)}
          className="min-w-0 flex-1 h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm"
        >
          <option value="">— اختر المحافظة —</option>
          {regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <Action
          onClick={() => onSave(value)}
          busy={busy}
          locked={locked || !value}
          lockedTitle={locked ? contactFirst : 'اختر المحافظة أولاً'}
        >
          احفظ المحافظة
        </Action>
      </div>
      {written && (
        <p className="text-note text-[var(--sys-muted-foreground)]">
          المكتوب: <span dir="auto">{written}</span>
        </p>
      )}
      {guess && picked === null && (
        <p className="text-note text-[var(--sys-muted-foreground)]">
          اقتراح من المكتوب: {guess.name} — لم يُحفظ بعد، اضغط «احفظ المحافظة».
        </p>
      )}
    </div>
  );
}

/** The phone's clock, read ONLY inside an event handler (a «اتصال» press) — never during a render. */
const phoneClock = (): number => Date.now();

export function ConfirmationMineScreen() {
  const toast = useToast();
  // The shared yes/no dialog — «أرجِع «لا يرد» للطابور» asks before it lets a pile go. (Not `confirm`: that is the order's «تأكيد» below.)
  const askFirst = useConfirm();
  // Saves the governorate the way the order screen saves it — and asks why when the server says this authority owes a reason.
  const patchOrder = useOrderPatch();
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
  /*
   * «الزبون على الخط» (customer-on-the-line.ts): the customer rang back and she takes his released order by his number. Drawn for
   * the three keys its door asks — pull, work and «عرض الطلبات» (the search reads orders inside her envelope).
   */
  const canTakeOnTheLine =
    canPull && userCan(currentUser, 'confirmation.work') && userCan(currentUser, 'orders.view');
  /*
   * «+ إنشاء طلب» ON HER OWN DESK (the owner, 2/11: «بنات التأكيد و المشرفة يظهرلهم انشاء طلب وتحت في خيار انو طلب مؤكد»).
   *
   * The same form as the Orders screen — with its «الزبون على الخط — أكّده الآن» box — drawn where she works, for whoever holds
   * «إنشاء طلبات». The door asks the same key; this is its answer drawn early, never a way past it.
   */
  const canCreate = userCan(currentUser, 'orders.create');
  const [creating, setCreating] = useState(false);
  // «إدخال إشكال» is its own box (`confirmation.raise_issue`, PR-7) — the agent's desk had the button for years and the
  // door asked for the issues LIST she was never given.
  const canRaiseIssue = userCan(currentUser, 'confirmation.raise_issue');
  /**
   * «شاشة موظفة» — THE OWNER READS A COLLEAGUE'S DESK. THE ONE PRESS HE MAY MAKE ON IT IS «أرجِع «لا يرد» للطابور» (below).
   *
   * Asked of `team.monitor` here only to spare a request; the door
   * (`/api/confirmation/desks`) decides, and the picker is drawn only when it
   * answers. `watched` is whose desk is open: null is the reader's own.
   */
  const mayWatch = userCan(currentUser, 'team.monitor');
  const [desks, setDesks] = useState<WatchableAgent[] | null>(null);
  const [watched, setWatched] = useState<{ id: string; name: string } | null>(null);
  const loadDesks = useCallback(async (): Promise<WatchableAgent[] | null> => {
    try {
      const r = await apiJson<{ agents: WatchableAgent[] }>('/api/confirmation/desks');
      setDesks(r.agents ?? []);
      return r.agents ?? [];
    } catch {
      setDesks(null);
      return null;
    }
  }, []);
  /**
   * THE DESK BEING READ SURVIVES A REFRESH (the owner, 3/11: «بس اعمل ريفريش بيوديني ع طلباتي»).
   *
   * Whose desk is open is kept in the address as `?agent=<id>`, written with `replaceState` (no navigation, no history
   * entry), and read back once the picker's list is in — only an id the door listed opens; anything else is the reader's own.
   */
  useEffect(() => {
    if (!mayWatch) return;
    let live = true;
    void loadDesks().then((agents) => {
      if (!live || !agents) return;
      const wanted = new URLSearchParams(window.location.search).get('agent');
      const agent = wanted ? agents.find((d) => d.id === wanted) : undefined;
      if (agent) setWatched((w) => w ?? { id: agent.id, name: agent.name });
    });
    return () => {
      live = false;
    };
  }, [mayWatch, loadDesks]);
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
  const serverOffset = useRef(0);
  /** The same offset, as state, for what a render reads (a render never reads a ref). */
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  /** «إثبات المكالمات»: a card's own wait, set by her «اتصال» press (no reload follows it) or by the door's «too soon». `at` is the phone's clock. */
  const [localProof, setLocalProof] = useState<Record<string, CallProofState & { at: number }>>({});
  /**
   * ── THE REFUSAL'S LINK TAKES HER DOWN TO THE CARD ──
   *
   * «افتح الطلب … وسجّل محاولة» opened the order window, over the desk. What
   * she needs is the card: its contact buttons are where the attempt is
   * written. So the pull panel hands the id to `showOrder` (below), which
   * moves the desk to the tab that holds it and clears a search that could
   * hide it; once that is drawn, this scrolls the card into the middle of
   * the screen and rings it for a moment. An order that is on no card of
   * hers (postponed, say) still opens in its window, as before.
   */
  const [focusId, setFocusId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusId) return;
    const t = window.setTimeout(() => {
      document.getElementById(deskCardId(focusId))?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      setFlashId(focusId);
      setFocusId(null);
    }, 0);
    return () => window.clearTimeout(t);
  }, [focusId]);
  useEffect(() => {
    if (!flashId) return;
    const t = window.setTimeout(() => setFlashId(null), 2500);
    return () => window.clearTimeout(t);
  }, [flashId]);

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
      if (watched) qs.set('agent', watched.id);
      const suffix = qs.toString();
      const askedAt = Date.now();
      const fresh = await apiJson<MineResponse>(`/api/confirmation/mine${suffix ? `?${suffix}` : ''}`);
      // The server's clock against this phone's — what «since the call started» means in the contact log.
      const serverAt = Date.parse(fresh.serverNow);
      if (!Number.isNaN(serverAt)) {
        serverOffset.current = serverAt - Date.now();
        setServerOffsetMs(serverAt - Date.now());
      }
      setData(fresh);
      // The server's number replaces what a press made locally — unless the press came after this request left.
      setLocalProof((p) => (Object.keys(p).length ? Object.fromEntries(Object.entries(p).filter(([, v]) => v.at > askedAt)) : p));
      return fresh;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
      // A colleague's desk the door refused: back to her own, with the reason above it.
      if (watched) setWatched(null);
      return null;
    }
  }, [doneDay, doneQuery, donePage, watched]);

  // The hook's loader answers nothing; ours answers the desk. Wrapped, not widened.
  useLiveRefresh(
    async () => {
      await load();
    },
    { key: `${doneDay}·${doneQuery}·${donePage}·${watched?.id ?? ''}` }
  );

  /** Open a colleague's desk (or `''`, her own). The old desk is cleared so it is never read as hers. */
  const watch = (id: string) => {
    const agent = desks?.find((d) => d.id === id) ?? null;
    setData(null);
    setError(null);
    setNotice(null);
    setDonePage(1);
    setTab((t) => (t === 'postponed' ? 'work' : t));
    setWatched(agent ? { id: agent.id, name: agent.name } : null);
    const url = new URL(window.location.href);
    if (agent) url.searchParams.set('agent', agent.id);
    else url.searchParams.delete('agent');
    window.history.replaceState(window.history.state, '', url);
  };

  /** «تحديث»: the desk on screen and the counts in the picker, read again — without leaving the desk being read. */
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([load(), loadDesks()]);
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * «أرجِع «لا يرد» للطابور» — THE ONE PRESS A WATCHER MAKES ON A COLLEAGUE'S DESK (the owner, 8/11: «واذا ساحبيتو رجعهم»).
   *
   * One agent held 479 «لا يرد» orders and the others had nothing to pull. The count and the arithmetic are the server's
   * (`data.returnPile`); this asks in the shared dialog, naming how many the press returns and what happens to them, sends the
   * one request, says what came back — and how many remain, because a press returns at most 200 — and reads the desk again.
   * Everything else on the desk stays unpressable, and the door decides who may (`desk-watch.ts` and `orders.unlock`).
   */
  const [returning, setReturning] = useState(false);
  const returnHerPile = async () => {
    const viewing = data?.viewing;
    const plan = data?.returnPile;
    if (!viewing || !plan || plan.eligible === 0 || returning) return;
    const ok = await askFirst({
      title: `إرجاع ${plan.thisPress} طلب «لا يرد» للطابور`,
      body:
        `من شاشة ${viewing.name}. بيرجعوا للطابور وبتنبّه الموظفة، وبتضل بإيدها اللي عليهم موعد أو اللي ردّ زبونهم.` +
        (plan.remainingAfter > 0
          ? `\nهالضغطة بترجع ${plan.thisPress} من ${plan.eligible}، وبيضل ${plan.remainingAfter} — اضغط تاني لباقيهم.`
          : ''),
      confirmLabel: 'أرجِعهم للطابور',
    });
    if (!ok) return;
    setReturning(true);
    try {
      const res = await apiJson<{ returned: number; message: string }>(
        `/api/confirmation/desks/${encodeURIComponent(viewing.id)}/return-no-answer`,
        { method: 'POST', timeoutMs: 60_000 }
      );
      if (res.returned > 0) toast.done(res.message);
      else toast.warn(res.message);
      // The desk, and the picker's counts, as they are now.
      await refresh();
    } catch (e) {
      toast.failed(e instanceof Error && e.message ? e.message : 'تعذّر إرجاع الطلبات');
    } finally {
      setReturning(false);
    }
  };

  /**
   * `answered` is for a refusal that is not an error: it takes the thrown thing, does what that refusal means (a dialog, a question)
   * and returns `true` — and then no red line is drawn. Anything it does not recognise returns `false` and is said as it always was.
   */
  const act = async (
    id: string,
    fn: () => Promise<unknown>,
    after?: (fresh: MineResponse | null) => void,
    answered?: (e: unknown) => boolean
  ) => {
    // A colleague's desk is read, never worked: nothing below is drawn on it, and nothing runs from it either.
    if (watched) return;
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
      if (!answered?.(e)) setError(refusalText(e));
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
  /** One line in the contact log — the card's buttons and the call sheet send it through here, with `attemptBody`. */
  const postAttempt = async (order: { id: string; orderNumber: string }, body: string) => {
    const res = await apiJson<{ autoClosed: boolean; noAnswerCount: number; cadence?: { words?: string } }>(
      `/api/orders/${order.id}/contact-attempts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }
    );
    setNotice(
      res.autoClosed
        ? `أُغلق الطلب ${order.orderNumber} تلقائياً بعد ${res.noAnswerCount} محاولات بلا رد.`
        : (res.cadence?.words ?? null)
    );
    return res;
  };
  const logAttempt = (order: OrderRow, method: 'PHONE' | 'WHATSAPP' | 'SMS', result: string) =>
    act(order.id, () => postAttempt(order, attemptBody(method, result)), undefined, (e) => {
      // «too soon»: nothing was written, and the card waits again for exactly what the server said. The red line is still drawn.
      const d = (e as { data?: { code?: unknown; waitSeconds?: unknown; unlocksAt?: unknown } } | null)?.data;
      if (d?.code === 'CALL_TOO_SOON') {
        const ms = typeof d.waitSeconds === 'number' ? d.waitSeconds * 1000 : Date.parse(String(d.unlocksAt)) - (Date.now() + serverOffset.current);
        if (Number.isFinite(ms)) holdFor(order.id, Math.max(0, ms));
      }
      return false;
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
   *
   * AND IT CAN BE REFUSED WITH A QUESTION. «الزبون عنده طلب مؤكَّد بنفس المنتج» (`TWIN_CONFIRMED`) writes nothing and names the
   * other orders; it is not a red line but a dialog (`TwinConfirmedDialog`), and `anyway` is the second try after she answered
   * «طلب تاني فعلاً — أكّد» — the body of which is `twin-refusal.ts`'s, the one the order window sends too.
   */
  const confirm = (order: OrderRow, anyway = false) =>
    act(
      order.id,
      () =>
        apiJson(`/api/orders/${order.id}/confirmation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Optimistic concurrency: the version the screen loaded.
          body: JSON.stringify(anyway ? confirmAnywayBody(order.version) : { action: 'confirm', expectedVersion: order.version }),
        }),
      (fresh) =>
        toast.done(
          `تم تأكيد الطلب ${order.orderNumber}`,
          deskIsEmpty(fresh) ? 'لا شيء بقي على مكتبك. اسحب الطلب التالي من أعلى الشاشة.' : undefined,
          // The last one: what she confirmed is what the warehouse packs next — for whoever may open that desk.
          deskIsEmpty(fresh) ? openPreparationStep(mayOpen) : undefined
        ),
      (e) => {
        const twins = twinsFromRefusal((e as { data?: unknown } | null)?.data);
        if (!twins) return false;
        setDialog({ kind: 'twin', order, twins });
        return true;
      }
    );

  /** «رفضه كمكرر»: the same order sent again. The door's own reject with the reason that already exists, at the version the card was drawn at. */
  const rejectAsDuplicate = (order: OrderRow) => {
    setDialog(null);
    void act(
      order.id,
      () =>
        apiJson(`/api/orders/${order.id}/confirmation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rejectAsDuplicateBody(order.version)),
        }),
      () => toast.done(`رُفض الطلب ${order.orderNumber} كمكرر`)
    );
  };

  /**
   * THE GOVERNORATE, WRITTEN BY HER PRESS AND BY NOTHING ELSE.
   *
   * The ordinary `PATCH regionId` of the order screen — the suggestion on the card is only what the select starts on.
   * The door's own refusals (`CONTACT_FIRST`, a foreign lock, a version that moved) are said by `refusalText`.
   */
  const saveRegion = (order: OrderRow, regionId: string) =>
    act(
      order.id,
      async () => {
        const res = await patchOrder(order.id, { expectedVersion: order.version, regionId });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { errorAr?: string; error?: string; code?: string };
          throw Object.assign(new Error(data.errorAr || data.error || 'تعذر حفظ المحافظة'), { data });
        }
        return res;
      },
      () => toast.done(`تم تحديد محافظة الطلب ${order.orderNumber}`)
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
        body: followUpBody({
          at,
          reason: value.reason,
          preferredTime: value.preferredTime,
          note: value.note,
          expectedVersion: order.version,
        }),
      })
    );
  };

  /*
   * «شو صار؟» — THE CALL SHEET OF A PHONE (the owner's plan: «اسحب التالي» → «اتصل» → back → one tap → «التالي»).
   *
   * Drawn only where the desk's own call buttons are: a phone, her own desk, `orders.contact_log`. A desk is as it was.
   * Every answer on it goes through a door this screen already uses, with the body its buttons already send
   * (`attemptBody` · `followUpBody`), after five seconds that «تراجع» can cancel — see `useOutbox`. Nothing new is
   * counted: the doors count what they always counted.
   */
  const sheetOn = phone && canLogContact && !watched && !data?.viewing;
  const call = usePendingCall(sheetOn ? currentUser?.id ?? null : null);
  /** The order as it was when she rang — the sheet keeps its name even after the third no-answer closes it. */
  const [callOrder, setCallOrder] = useState<OrderRow | null>(null);
  const [sheetRefusal, setSheetRefusal] = useState<string | null>(null);
  const workable = (id: string) => data?.work.find((o) => o.id === id) ?? data?.noAnswer.find((o) => o.id === id) ?? null;
  const startCall = (order: OrderRow) => {
    setCallOrder(order);
    setSheetRefusal(null);
    call.start(order.id);
  };
  const endCall = () => {
    call.clear();
    setCallOrder(null);
    setSheetRefusal(null);
  };
  // Back after a reload: the call kept in the phone is the sheet again — if the order is still hers to work.
  useEffect(() => {
    if (!data || !call.pending || callOrder) return;
    const order = workable(call.pending.orderId);
    if (order) setCallOrder(order);
    else call.clear();
    // `workable` reads `data`, which is in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, call.pending, callOrder]);

  /*
   * «إثبات المكالمات» — WHAT HER «لا يرد» / «مغلق أو خارج التغطية» WAIT FOR, ON THE CARD.
   *
   * The server says (`order.callProof`: NO_OPENED · WAIT until a server-clock instant · READY); the screen prints it and ticks the seconds
   * against the server's clock (`serverOffset`). It never decides the rule. A press of «اتصال» does not reload the desk, so it sets the wait
   * itself (server now + thirty seconds + the clocks' margin) until the next reload brings the server's own number.
   */
  const proofOn = !!data?.callProofOn;
  const holdFor = (orderId: string, ms: number) => {
    const at = phoneClock();
    setLocalProof((p) => ({ ...p, [orderId]: { state: 'WAIT', unlocksAtMs: at + serverOffset.current + ms, at } }));
  };
  // The one-second tick runs only until the last waiting card unlocks, and stops by itself (the instants are server-clock; the hook wants the phone's).
  const proofUntil = proofOn && data
    ? Math.max(0, ...[...data.work, ...data.noAnswer].map((o) => {
        const p = localProof[o.id] ?? o.callProof;
        return p?.state === 'WAIT' && p.unlocksAtMs !== null ? p.unlocksAtMs - serverOffsetMs : 0;
      }))
    : 0;
  const clockNow = useCallProofClock(proofUntil > 0 ? proofUntil : null);
  /** The wait after a press: the rule's seconds as the server said them (request Q3b; the default without them) and the clocks' margin. */
  const waitMs = ((data?.proofSeconds ?? 0) * 1000 || MIN_CALL_MS.NO_ANSWER) + CLIENT_MARGIN_MS;
  /** A wait is never longer than that: a stale first frame cannot print a wild number. */
  const MAX_WAIT_S = Math.ceil(waitMs / 1000);
  const proofLock = (order: OrderRow): { text: string | null; wait: boolean } => {
    const p = proofOn ? localProof[order.id] ?? order.callProof : undefined;
    const left = p?.state === 'WAIT' && p.unlocksAtMs !== null ? Math.min(MAX_WAIT_S, secondsLeft(p.unlocksAtMs, clockNow + serverOffsetMs)) : 0;
    return { text: p?.state === 'NO_OPENED' ? CALL_PROOF_WORDS.noOpened : left > 0 ? CALL_PROOF_WORDS.wait(left) : null, wait: left > 0 };
  };
  /** The «call first» sentence: the proof's own when on (the old one said «أو اكبس لا يرد», no longer a way out). */
  const contactFirstText = proofOn ? CALL_PROOF_WORDS.contactFirstV2 : CONTACT_FIRST_MESSAGE;

  /** Outbox items the door refused for «too soon» / «no press yet»: NOTHING was written, so their retry skips the «already logged?» question. */
  const nothingWritten = useRef(new Set<string>());
  const sendOutgoing = async (item: Outgoing): Promise<SendAnswer> => {
    const mine = call.pending && item.key === `${call.pending.orderId}:${call.pending.startedAt}`;
    const skipAsk = nothingWritten.current.delete(item.key);
    try {
      if (item.door === 'attempt') {
        // Its first answer was lost on the way: ask the log before writing the same line twice.
        if (item.uncertain && !skipAsk) {
          const r = await apiJson<{ attempts?: { result?: string; employeeId?: string; createdAt?: string }[] }>(
            `/api/orders/${item.orderId}/contact-attempts`
          );
          if (alreadyLogged(r.attempts ?? [], item, serverOffset.current)) {
            await load();
            return 'sent';
          }
        }
        await postAttempt({ id: item.orderId, orderNumber: item.orderNumber }, item.body);
      } else {
        await apiJson(`/api/orders/${item.orderId}/confirmation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: item.body,
        });
      }
      await load();
      void queue.reload();
      return 'sent';
    } catch (e) {
      if (isNetworkFailure(e)) return 'network';
      // «إثبات المكالمات»: «too soon» is kept and sent again. «No press logged» is kept too while her «اتصال» line is still queued
      // (the press and the outcome travel in two queues, and after a reconnect the outcome can arrive first): the press is sent
      // now, and the outcome tried again. Without a press waiting it is final, like «not logged».
      const code = (e as { data?: { code?: unknown } } | null)?.data?.code;
      if (code === 'CALL_TOO_SOON' || (code === 'CALL_NOT_STARTED' && openedWaiting(item.orderId))) {
        if (code === 'CALL_NOT_STARTED') await flushContactLines(true);
        nothingWritten.current.add(item.key);
        return 'network';
      }
      const said = refusalText(e);
      setError(said);
      if (mine) setSheetRefusal(said);
      return 'refused';
    }
  };
  const outbox = useOutbox(sheetOn ? currentUser?.id ?? null : null, sendOutgoing);
  // «مساعد الاتصال»: back from a call the app placed — what the phone's call log said, once it has said it. Only on an
  // Android phone: anywhere else «اتصال» was `tel:` (ContactButtons) and no app read anything. `call.pending` exists only
  // after mount, so the browser is never asked during the server's render.
  const helperReading = useHelperReading(
    sheetOn && call.pending && callOrder?.callHelperLink && call.awayMs !== null && onAndroid()
      ? { orderId: call.pending.orderId, startedAt: call.pending.startedAt }
      : null
  );
  const callKey = call.pending ? `${call.pending.orderId}:${call.pending.startedAt}` : null;
  const waitingItem = callKey ? outbox.items.find((o) => o.key === callKey) ?? null : null;

  /** One answer per call: refused (and said) once this call's answer has left or can no longer be taken back. */
  const queued = (ok: boolean) => {
    if (ok) call.settle();
    else setSheetRefusal(ONE_ANSWER_PER_CALL);
    return ok;
  };
  const queueLogged = (order: OrderRow, outcome: LoggedOutcome): boolean => {
    if (!call.pending) return false;
    setSheetRefusal(null);
    const result = ATTEMPT_RESULT[outcome]!;
    return queued(outbox.add({
      key: `${order.id}:${call.pending.startedAt}`,
      userId: call.pending.userId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      door: 'attempt',
      body: attemptBody('PHONE', result),
      result,
      label: LOGGED_WORDS[outcome],
      startedAt: call.pending.startedAt,
    }));
  };
  const queueCallback = (order: OrderRow, chip: CallbackChip): boolean => {
    if (!call.pending) return false;
    setSheetRefusal(null);
    return queued(outbox.add({
      key: `${order.id}:${call.pending.startedAt}`,
      userId: call.pending.userId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      door: 'followUp',
      body: followUpBody({
        at: chip.at,
        reason: CALLBACK_REASON,
        preferredTime: preferredClock(chip.at),
        expectedVersion: order.version,
      }),
      label: `اتصل لاحقاً ${chip.label}`,
      startedAt: call.pending.startedAt,
    }));
  };
  /**
   * «ألغِ» FROM THE SHEET: the call's own line goes BEFORE the cancellation is asked — never after it. If it cannot leave
   * now (no line), the cancellation waits and the sheet says why.
   */
  const rejectFromSheet = async (order: OrderRow) => {
    if (callKey && outbox.has(callKey)) {
      await outbox.sendNow();
      if (outbox.has(callKey)) {
        setSheetRefusal(SEND_BEFORE_REJECT);
        return;
      }
    }
    endCall();
    setDialog({ kind: 'reject', order });
  };
  /**
   * Take her to an order's card: the tab that holds it, a search that cannot hide it, and the scroll and ring — or its window when
   * no card of hers holds it. `desk` is the desk as it is NOW (a reload's answer), so a card that has only just arrived is found.
   */
  const openCard = (desk: Pick<MineResponse, 'work' | 'noAnswer' | 'closedToday'> | null, orderId: string) => {
    const holds = (list: { id: string }[]) => list.some((o) => o.id === orderId);
    const wanted = !desk ? null : holds(desk.work) ? 'work' : holds(desk.noAnswer) || holds(desk.closedToday) ? 'noAnswer' : null;
    if (!wanted) {
      setOpenOrderId(orderId);
      return;
    }
    setTab(wanted);
    setFindOpen('');
    setFocusId(orderId);
  };
  /**
   * «التالي»: what she said goes now, then the next order is pulled — the desk's own pull.
   *
   * «الشغل أول»: unless she still owes calls. The desk is read again once her answer has left; if a call is owed, «التالي» is the
   * next of them (the oldest), not a pull. And a pull the server refuses for that reason anyway (a desk that had not heard) is
   * answered the same way: the desk is read and the order it names is opened.
   */
  const callNext = async () => {
    await outbox.sendNow();
    let desk = await load();
    let owed = desk?.due?.count ? desk.due.first?.id : undefined;
    if (!owed) {
      const refused = (await queue.pull()) ? null : queue.lastRefusal?.current;
      if (refused === null) {
        await queue.reload();
        await load();
        // What she has just pulled is a call she owes: it is under «اتصلي هلّق».
        setTab('work');
        setFindOpen('');
      } else if (refused?.code === 'WORK_FIRST') {
        owed = refused.orderId ?? undefined;
        desk = await load();
      }
    }
    endCall();
    if (owed) openCard(desk, owed);
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
    void act(order.id, async () => {
      // Where the request went, in a sentence: carried out, waiting for a decision, or approved and waiting to be applied.
      const answer = await raiseChangeRequest(order.id, value, order.version, {
        canOpenQueue: userCan(currentUser, 'control.change_requests'),
        // Her own queue: she holds the order, and the courier has not taken it.
        order: { handed: false, held: true },
      });
      setNotice(answer.message);
    });
  };

  if (!data) {
    // The first load failed: say so, with a way to ask again — never a spinner that turns forever (LoadFailed.tsx).
    if (error) {
      return (
        <LoadFailed
          message={error}
          onRetry={() => {
            setError(null);
            void load();
          }}
        />
      );
    }
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  /** A colleague's desk, opened through «شاشة موظفة»: drawn whole, and none of HER presses is drawn on it — the viewer's own «أرجِع «لا يرد» للطابور» is the one. */
  const readOnly = watched !== null || !!data.viewing;
  const watchedName = data.viewing?.name ?? watched?.name ?? '';
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
    work: 'اللي لازم ترني عليه هلّق',
    // With «نظام الجولات» off nothing falls due by the clock: the old sentence is the true one.
    noAnswer: `${data.rounds || data.cadenceOn ? 'ما ردّ — بيصير جاهز بوقتو' : 'محاولة أو محاولتين — التالية تُغلق'}${data.closedToday.length > 0 ? ` · و${data.closedToday.length} أُغلقت اليوم` : ''}`,
    done: confirmed.q ? `بحث «${confirmed.q}»` : 'يوم واحد في كلّ مرّة',
    postponed: 'ما أجّلتَه لموعد — تعمل على ما حلّ موعده',
  };

  /*
   * ONE CARD, THREE PLACES.
   *
   * «بانتظار» shows the same card «اتصلي هلّق» does — same buttons, same rules,
   * same source line — because it is the same order and the agent must not
   * have to learn a second card. What changes is the tone and, for the
   * ones the third no-answer closed, that there is no footer at all: they
   * are read-only, and a disabled row of buttons reads as «try again».
   */
  /** The refusal's link: down to the order's card on the tab that holds it, or its window if no card does. */
  const showOrder = (orderId: string) => openCard(data, orderId);

  const rows: { order: OrderRow; closed?: boolean }[] =
    tab === 'work'
      ? work.map((order) => ({ order }))
      : tab === 'noAnswer'
        ? [...noAnswer.map((order) => ({ order })), ...closedToday.map((order) => ({ order, closed: true }))]
        : [];

  return (
    <PageShell
      title={routeLabel('/confirmation/mine')}
      width="wide"
      actions={
        canCreate &&
        !readOnly && (
          <Button size="sm" onClick={() => setCreating(true)} className="flex items-center space-x-1.5">
            <RiAddCircleLine className="w-4 h-4" />
            <span>إنشاء طلب</span>
          </Button>
        )
      }
    >
      {canCreate && !readOnly && (
        <CreateOrderModal
          isOpen={creating}
          onClose={() => setCreating(false)}
          onSuccess={() => {
            void load();
            void queue.reload();
          }}
        />
      )}
      {/*
        THE HEAD OF THE DESK — the watcher's picker and «تحديث», «قراءة بس», «الشغل أول» and the watcher's return press — drawn by
        `DeskHead` (R8b, 18/11). Every condition stays here, word for word: the banner only on her own desk and only when the server
        sent `due` and there is something owed or something to pull; the return press only on a colleague's desk, with the server's
        plan, for the holder of the key its door asks — the door decides again.
      */}
      <DeskHead
        desks={desks}
        watchedId={watched?.id ?? ''}
        onWatch={watch}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        readOnly={readOnly}
        watchedName={watchedName}
        due={!readOnly && data.due && (data.due.count > 0 || (queue.data?.canPull && queue.data.waiting > 0)) ? data.due : null}
        returnPile={data.viewing && data.returnPile && userCan(currentUser, 'orders.unlock') ? data.returnPile : null}
        returning={returning}
        onReturnPile={() => void returnHerPile()}
      />
      {canPull && !readOnly && (
        <PullPanel
          queue={queue}
          compact
          onPulled={async () => {
            await load();
            // What she has just pulled is a call she owes: it is under «اتصلي هلّق», and she is looking at it.
            setTab('work');
            setFindOpen('');
          }}
          onShowOrder={showOrder}
          workFirst={data.due}
          onWorkFirst={async (orderId) => openCard(await load(), orderId)}
        />
      )}
      {/* «مساعد الاتصال» — on a phone (where the call sheet is), her own desk only, for the holder of «طلباتي»'s key (the
          pair door asks the same). A desk at a computer has no phone to pair. */}
      {phone && holderId && !readOnly && <CallHelperCard onChange={() => void load()} />}
      {canTakeOnTheLine && !readOnly && (
        <CustomerOnTheLine
          onTaken={async (orderId) => {
            await load();
            void queue.reload();
            setOpenOrderId(orderId);
          }}
        />
      )}
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
          label="اتصلي هلّق"
          count={data.work.length}
          note={tabNotes.work}
          phone={phone}
        />
        <TabButton
          active={tab === 'noAnswer'}
          onClick={() => setTab('noAnswer')}
          label="بانتظار"
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
        {/* Not on a colleague's desk: that tab is the READER's own postponed list, and under her name it would lie. */}
        {!readOnly && (
          <TabButton
            active={tab === 'postponed'}
            onClick={() => setTab('postponed')}
            label="المؤجلة"
            note={tabNotes.postponed}
            phone={phone}
          />
        )}
      </div>
      {phone && <p className="-mt-3 text-note text-[var(--sys-muted)]">{tabNotes[tab]}</p>}

      {(tab === 'work' || tab === 'noAnswer') && (
      <section>
        <SectionHead
          title={tab === 'work' ? 'اتصلي هلّق' : 'بانتظار'}
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
            <Card plain>
              {findOpen.trim() ? (
                <EmptyState
                  title="لا طلبَ في هذا التبويب يطابق هذا البحث"
                  why={`لا شيءَ من الـ${tab === 'work' ? data.work.length : data.noAnswer.length + data.closedToday.length} في «${tab === 'work' ? 'اتصلي هلّق' : 'بانتظار'}» يطابق «${findOpen.trim()}» — البحث يمرّ على رقم الطلب والاسم والهاتف.`}
                  action={{ label: 'امسح البحث', onClick: () => setFindOpen('') }}
                />
              ) : tab === 'noAnswer' ? (
                <EmptyState
                  title="ما في طلب ما ردّ عليه حدا"
                  why="هذا التبويب يجمع الطلبات التي جرت محاولة أو محاولتان معها بلا رد — ويخلو عندما تُجاب كلّها أو تُغلَق."
                />
              ) : data.noAnswer.length > 0 ? (
                /* Orders she holds, none of them due: they are under «بانتظار» — «no order in your hands» would be false. */
                <EmptyState
                  title="ما في طلب لازم ترني عليه هلّق"
                  why="الباقي بينتظر وقته في «بانتظار»."
                />
              ) : (
                <EmptyState
                  title="لا يوجد طلب بيدك الآن"
                  why="اسحب طلباً من مركز التأكيد. ما تسحبه يبقى لك حتى تؤكّده أو ترفضه أو يُحرَّر تلقائيّاً."
                />
              )}
            </Card>
          )}
          {rows.map(({ order, closed }) => (
            <OrderCard
              key={order.id}
              order={order}
              closed={closed}
              domId={deskCardId(order.id)}
              flash={flashId === order.id}
              data={data}
              readOnly={readOnly}
              watchedName={watchedName}
              phone={phone}
              busy={busyId === order.id}
              canLogContact={canLogContact}
              canRaiseIssue={canRaiseIssue}
              canAskAssistant={canAskAssistant}
              proofOn={proofOn}
              lock={proofLock(order)}
              contactFirstText={contactFirstText}
              holderId={holderId}
              regionGate={
                lacksRegion(order) &&
                !readOnly && (
                  <RegionGate
                    order={order}
                    locked={needsContact(order)}
                    contactFirst={contactFirstText}
                    busy={busyId === order.id}
                    onSave={(regionId) => void saveRegion(order, regionId)}
                  />
                )
              }
              presses={{
                onOpenOrder: (o) => setOpenOrderId(o.id),
                onNoAnswer: (o) => logAttempt(o, 'PHONE', 'NO_ANSWER'),
                onUnreachable: (o) => logAttempt(o, 'PHONE', 'UNREACHABLE'),
                onConfirm: (o) => confirm(o),
                onDialog: (kind, o) => setDialog({ kind, order: o }),
                onContacted:
                  sheetOn || proofOn
                    ? (o, method) => {
                        if (method !== 'PHONE') return;
                        // Every phone press, sheet or not: the card's «لا يرد» starts its thirty seconds now.
                        if (proofOn) holdFor(o.id, waitMs);
                        if (sheetOn) startCall(o);
                      }
                    : undefined,
              }}
            />
          ))}
        </div>
      </section>
      )}

      {tab === 'postponed' && !readOnly && <ConfirmationPostponedScreen embedded />}

      {/*
        «أكّدتها» — a day, a search, the table and its pages, drawn by `DoneList` (R8c, 18/11). The four states, the read they go into
        and every «may she» stay here: the number opens the order only for a reader who may read it, the history's holder is hers only
        on her own desk, and the row's presses (drawn below) are not on a colleague's desk at all.
      */}
      {tab === 'done' && (
        <DoneList
          confirmed={confirmed}
          day={doneDay || confirmed.day}
          onDay={(day) => {
            setDoneDay(day);
            setDonePage(1);
          }}
          typed={doneTyped}
          onTyped={setDoneTyped}
          onSearch={() => {
            setDoneQuery(doneTyped.trim());
            setDonePage(1);
          }}
          canReset={!!(doneQuery || doneDay)}
          onReset={() => {
            setDoneTyped('');
            setDoneQuery('');
            setDoneDay('');
            setDonePage(1);
          }}
          onClearSearch={() => { setDoneTyped(''); setDoneQuery(''); setDonePage(1); }}
          onNewer={() => setDonePage((p) => Math.max(1, p - 1))}
          onOlder={() => setDonePage((p) => p + 1)}
          onOpenOrder={!readOnly && (holderId !== null || userCan(currentUser, 'orders.view')) ? (orderId) => setOpenOrderId(orderId) : undefined}
          historyHolderId={readOnly ? null : holderId}
          editsItself={userCan(currentUser, EDIT_CONFIRMED_KEY)}
          rowActions={readOnly ? undefined : (order) => (
            <>{order.changeRequests && order.changeRequests.length > 0 ? (
                    <span className="text-note text-[var(--sys-warning)]">طلب تعديل قيد المراجعة</span>
                  ) : onOpenTrolley({ shippingBatchId: order.shippingBatchId, batchStatus: order.shippingBatch?.status }) ? (
                    /* On a trolley still being filled: nothing to ask (the owner's ruling 4/11) — said, with the whole sentence on hover. */
                    <span className="text-note text-[var(--sys-muted-foreground)]" title={ON_TROLLEY_AR}>
                      على دفعة شحن — ما في تعديل
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="quiet"
                      size="sm"
                      onClick={() => setDialog({ kind: 'change', order })}
                      disabled={busyId === order.id}
                    >
                      {/* «تعديل» for the orders she changes herself (`orders.edit_confirmed`, 2/11) — the same word the order window's button uses. */}
                      {editsNow(currentUser, order, 'CANCEL') ? 'تعديل' : 'طلب تعديل'}
                    </Button>
                  )}</>
          )}
        />
      )}

      {dialog?.kind === 'postpone' && (
        <PostponeDialog
          open
          orderNumber={dialog.order.orderNumber}
          postponeCount={dialog.order.postponeCount}
          busy={busyId === dialog.order.id}
          noAnswerLock={proofOn ? proofLock(dialog.order).text : null}
          planOn={!!data?.cadenceOn}
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
          hasAttempt={!needsContact(dialog.order)}
          canLogContact={canLogContact}
          onClose={() => setDialog(null)}
          onSubmit={(value) => submitReject(dialog.order, value)}
        />
      )}
      {dialog?.kind === 'twin' && (
        <TwinConfirmedDialog
          open
          orderNumber={dialog.order.orderNumber}
          twins={dialog.twins}
          busy={busyId === dialog.order.id}
          onRejectAsDuplicate={() => rejectAsDuplicate(dialog.order)}
          onConfirmAnyway={() => {
            setDialog(null);
            void confirm(dialog.order, true);
          }}
          onBack={() => setDialog(null)}
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
          onOpenTrolley={onOpenTrolley({ shippingBatchId: dialog.order.shippingBatchId, batchStatus: dialog.order.shippingBatch?.status })}
          appliesNow={{
            EDIT: editsNow(currentUser, dialog.order, 'EDIT'),
            CANCEL: editsNow(currentUser, dialog.order, 'CANCEL'),
            POSTPONE: editsNow(currentUser, dialog.order, 'POSTPONE'),
          }}
          mayChangePrice={userCan(currentUser, 'orders.change_price')}
          onClose={() => setDialog(null)}
          onSubmit={(value) => submitChange(dialog.order, value)}
        />
      )}

      {sheetOn && call.pending && callOrder && (
        <CallOutcomeSheet
          key={callKey ?? undefined}
          customerName={callOrder.customer.fullName}
          awayMs={call.awayMs}
          reading={helperReading}
          closesOnNext={(workable(callOrder.id) ?? callOrder).closesOnNext ?? (!data.rounds && (workable(callOrder.id) ?? callOrder).noAnswerCount + 1 >= data.noAnswerLimit)}
          confirmLock={sheetConfirmLock(workable(callOrder.id) ?? callOrder, contactFirstText)}
          proofOn={proofOn}
          proofMs={waitMs}
          orderId={callOrder.id}
          startedAt={call.pending.startedAt}
          waiting={
            waitingItem
              ? {
                  label: waitingItem.label,
                  state: outgoingState(waitingItem, outbox.offline, outbox.now),
                  secondsLeft: Math.max(0, Math.ceil((waitingItem.sendAt - outbox.now) / 1000)),
                }
              : null
          }
          refused={sheetRefusal}
          offline={outbox.offline}
          canPull={canPull}
          pulling={queue.pulling}
          whatsapp={
            <WhatsAppAfterNoAnswer key={callOrder.id} fromCompany={data.whatsappRoute === 'COMPANY'} orderId={callOrder.id}>
              <ContactButtons
                only="WHATSAPP"
                preferApp
                phone={callOrder.customer.rawPhone}
                countryCode={data.dialCode}
                context={{
                  orderNumber: callOrder.orderNumber,
                  customerName: callOrder.customer.fullName,
                  amount: callOrder.totalAmount,
                  region: callOrder.customer.city,
                }}
                orderId={callOrder.id}
              />
            </WhatsAppAfterNoAnswer>
          }
          onAnswered={() => void load()}
          onLogged={(outcome) => queueLogged(workable(callOrder.id) ?? callOrder, outcome)}
          onCallback={(chip) => queueCallback(workable(callOrder.id) ?? callOrder, chip)}
          onNotCalled={endCall}
          onConfirm={() => {
            const order = workable(callOrder.id) ?? callOrder;
            endCall();
            void confirm(order);
          }}
          onPostpone={() => {
            const order = workable(callOrder.id) ?? callOrder;
            endCall();
            setDialog({ kind: 'postpone', order });
          }}
          onReject={() => void rejectFromSheet(workable(callOrder.id) ?? callOrder)}
          onUndo={() => {
            const undone = !!callKey && outbox.undo(callKey);
            if (undone) call.unsettle();
            return undone;
          }}
          onNext={() => void callNext()}
          onClose={endCall}
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
    </PageShell>
  );
}
