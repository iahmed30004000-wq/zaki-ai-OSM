'use client';

import React, { useState } from 'react';
import { RiCheckLine, RiCloseLine, RiFileList3Line, RiHandCoinLine, RiLoader4Line } from '@remixicon/react';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { apiJson } from '@/lib/api-client';
import { SHIPPING_STATUS_AR } from '@/lib/shipping-workflow';
import { useProducts } from '@/hooks/useProducts';
import { ALERT_AR, type TrackingAlertKind } from '@/lib/parcel-tracking/alert';
import { canCollect } from '@/lib/parcel-tracking/priority';
import type { TrackingListFacts } from '@/lib/parcel-tracking/list';
import { usePagedList, type PagedRead, type Paging } from '@/hooks/usePagedList';
import { CollectDialog } from '@/components/screens/tracking/CollectDialog';
import { ManualStatementDialog } from '@/components/screens/finance/ManualStatementDialog';
import { useConfirm } from '@/components/ui/Confirm';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListToolbar, withChosen, type ToolbarFilter } from '@/components/ui/ListToolbar';
import { Money } from '@/components/ui/Money';
import { Pager } from '@/components/ui/Pager';
import { Rows } from '@/components/ui/Rows';
import { BulkBar } from '@/components/shell/BulkBar';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { useIsPhone } from '@/hooks/useIsPhone';
import { OrderLink } from '@/components/orders/OrderLink';
import { FULL_SIGHT, NO_SIGHT, statesOffered, type TrackingSight } from '@/lib/parcel-tracking/sight';

/**
 * «مطابقة يدوية» — a courier, or a company, that sends no statement and no file.
 *
 * The owner, 20/10 and again 22/10: «افرض ما عندي كشف، لازمني آلية للمطابقة
 * وإغلاق الطلب وتحصيله» — «افرض مندوب أو شركة ما عندها سيستم أو إكسل، شو أعمل؟».
 *
 * The mechanism was built (PR #52) and nobody found it: it was a button at the
 * bottom of the shipment follow-up, behind a list made for chasing parcels, on a
 * different permission from the matching screen where a person looks for the
 * word «مطابقة». This is the same mechanism where the word is.
 *
 * ── IT IS A SCREEN, NOT A NEW DOOR ──
 *
 * Nothing here writes money or decides anything. Three doors that already exist,
 * each behind its own permission and each refusing what it must:
 *
 *   • the list      GET  /api/ops/tracking          (ops.track) — the courier's open parcels
 *   • the outcome   POST /api/ops/tracking/deliver  (ops.deliver) — «all» or «none» of an order
 *   • the money     POST /api/ops/tracking/collect  (finance.cashbox) — through `CollectDialog`
 *
 * So the order of the work is the order of the doors: say what happened at the
 * door (the parcel was taken, or it came back) — which writes no money — and
 * then take the money for what was taken, which writes the wallet movement and
 * nowhere earlier. A delivered order whose cash is settled has both its stages
 * done and is closed; one that came back is closed when the returns desk counts
 * the goods (`order-closing.ts`).
 *
 * ── WHAT IT WILL NOT DO, AND SAYS SO ──
 *
 *   • It does not add up what a courier owes. The expected net is the SERVER's
 *     figure per order (`expectedCollection`), shown beside each row; the total the
 *     person is about to take is the dialog's, which sums those and lets the door
 *     answer for the rest. This screen holds no arithmetic of its own.
 *   • It does not offer a button a door always refuses. A parcel the door cannot
 *     settle (not shipped yet, already returned, waiting for pick-up) has no box;
 *     a cancelled-while-travelling one cannot be ticked «delivered»; and the money
 *     button is not drawn for somebody without the cash-box permission.
 *   • It does not pretend a bulk press is one transaction. Each order is its own
 *     call, one after another, and the answer says how many landed and which did
 *     not, with the door's own reason.
 */

/** The page: bigger than the follow-up's 25, because the work here is «these twenty, they all arrived». */
const PAGE = 50;

/** The two statuses `recordPartialDelivery` accepts — a parcel anywhere else has no outcome to record. */
const AT_THE_DOOR = ['SHIPPED', 'OUT_FOR_DELIVERY'];

interface Row {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  trackingNumber: string | null;
  shippingStatus: string;
  settlementStatus?: string;
  daysInTransit: number | null;
  late: boolean;
  totalAmount: number;
  currency: string;
  customer: { fullName: string; phone: string; city: string };
  deliveryProvider: { id: string; name: string; kind?: string } | null;
  /** What this order owes, by the settlement rule, worked out on the server. */
  expectedCollection?: number | null;
  alert?: { kind: TrackingAlertKind; at: string; acknowledged: boolean } | null;
}

interface Extra {
  facts: TrackingListFacts;
  /** Which rows the follow-up door shows this person — the options below offer only what it would answer. */
  access: TrackingSight;
  /** `ops.deliver` (PR-8): whether «تم تسليمها» / «رجعت» are drawn. The door decides; an answer that does not say is read as «yes». */
  mayDeliver: boolean;
}

/** Module-level, so the hook's loader keeps one identity — see `usePagedList`. */
const read = (body: unknown): PagedRead<Row, Extra> => {
  const b = body as { orders: Row[]; pagination: Paging; facts: TrackingListFacts; access?: TrackingSight; acts?: { deliver?: boolean } };
  return { rows: b.orders, pagination: b.pagination, extra: { facts: b.facts, access: b.access ?? FULL_SIGHT, mayDeliver: b.acts?.deliver !== false } };
};

/**
 * WHAT A MANUAL MATCH CAN DO WITH A PARCEL.
 *
 *   DELIVER — it is out with the courier: record that it was taken, or that it came back.
 *   COLLECT — it was taken and the money is still with him: take it.
 *   null    — neither; the follow-up screen is where it is handled.
 *
 * The collect side is `canCollect`, the one predicate the follow-up's own checkbox asks.
 * The deliver side adds the one thing the follow-up lets through and a BULK press must
 * not: an order that was cancelled while the parcel travels is a parcel to stop chasing,
 * not one to mark «delivered».
 */
export type Step = 'DELIVER' | 'COLLECT';

export function stepFor(o: Pick<Row, 'shippingStatus' | 'settlementStatus' | 'trackingNumber' | 'daysInTransit' | 'late' | 'alert'>): Step | null {
  if (AT_THE_DOOR.includes(o.shippingStatus)) return o.alert?.kind === 'CANCELLED' ? null : 'DELIVER';
  return canCollect(o) ? 'COLLECT' : null;
}

/**
 * WHAT THE TICKED ROWS ASK FOR — OR WHY THEY CANNOT BE ASKED TOGETHER.
 *
 * One kind of work per press: a delivery is an event at the door, a collection is cash
 * from one party in one currency. Mixing them would mean a button whose meaning depends on
 * a row nobody is looking at. The money side is stricter than the outcome side — one
 * courier, because the dialog says «استلمت منه» and means him, and one currency, because
 * the door refuses a mixture.
 */
export function readChoice(chosen: Row[]): { step: Step | null; problem: string | null } {
  const steps = new Set(chosen.map(stepFor));
  if (steps.size === 0) return { step: null, problem: null };
  if (steps.size > 1) {
    return { step: null, problem: 'اخترتَ طلبات بانتظار التسليم مع طلبات بانتظار التحصيل. اختر نوعاً واحداً في كل مرة.' };
  }
  const step = [...steps][0];
  if (step === 'COLLECT') {
    if (new Set(chosen.map((o) => o.deliveryProvider?.id ?? 'none')).size > 1) {
      return { step, problem: 'الاستلام من جهة واحدة في كل مرة — اختر طلبات جهة واحدة.' };
    }
    if (new Set(chosen.map((o) => o.currency)).size > 1) {
      return { step, problem: 'في اختيارك أكثر من عملة — اختر طلبات بعملة واحدة.' };
    }
  }
  return { step, problem: null };
}

/**
 * THE STATES A PARCEL CAN BE IN AND STILL BE MATCHED BY HAND — the ones the screen opens on, one by one.
 * The words come from `SHIPPING_STATUS_AR`; the list is only which of them are worth asking for.
 */
const MATCHING_STATUSES = [
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'READY_FOR_PICKUP',
  'FAILED_DELIVERY',
  'RETURN_REQUESTED',
  'DELIVERED',
  'PARTIALLY_DELIVERED',
] as const satisfies readonly (keyof typeof SHIPPING_STATUS_AR)[];

/* The words come from `SHIPPING_STATUS_AR`, like every other screen that says a status. */
const STATUS_LABEL: Record<string, string> = SHIPPING_STATUS_AR;

/** What the person is told a parcel needs, beside its status — and why a row has no box. */
const NEXT_AR: Record<Step, string> = {
  DELIVER: 'تسجيل التسليم أو الرجوع',
  COLLECT: 'استلام المبلغ',
};

const GREEN =
  'h-11 md:h-8 px-3 rounded-lg bg-[var(--sys-success)] text-[var(--sys-primary-foreground)] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50';
const RED =
  'h-11 md:h-8 px-3 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50';

interface Failure {
  ref: string;
  why: string;
}

export function ManualMatching() {
  const phone = useIsPhone();
  const { currentUser } = useApp();
  // UX only: the door refuses a person without the permission whatever this draws.
  const mayCollect = userCan(currentUser, 'finance.cashbox');
  // The permission that makes a statement: «مطابق يدوي» writes lines of one, and moves no money.
  const mayGather = userCan(currentUser, 'settlement.upload');
  const confirm = useConfirm();

  const [term, setTerm] = useState('');
  const [courier, setCourier] = useState('all');
  /** `all` — what the screen opens on (open parcels + delivered and still owed); otherwise ONE shipping status. */
  const [status, setStatus] = useState('all');
  /** `all`, or one product's id: only the parcels of orders for that product. */
  const [product, setProduct] = useState('all');
  /** '' — everything open with the courier; `COLLECT` — only what arrived and is still owed. */
  const [view, setView] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [working, setWorking] = useState(false);
  /** The choice the money dialog was opened for (its ids, sorted) — see below. */
  const [collectingFor, setCollectingFor] = useState<string | null>(null);
  /** The same, for the dialog of «مطابق يدوي». */
  const [gatheringFor, setGatheringFor] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failure[]>([]);

  const list = usePagedList<Row, Extra>({
    url: '/api/ops/tracking',
    params: { q: term.trim() || undefined, courier, task: view, status, product },
    read,
    limit: PAGE,
  });
  const { extra, rows, pagination } = list;
  const facts = extra?.facts;
  // UX only, like `mayCollect`: the door refuses a state or a view that is not this person's, whatever is drawn.
  const access = extra?.access ?? NO_SIGHT;
  // After the list, so the list's own read is the screen's FIRST: a failure of the first answer is the list's to show.
  const { products } = useProducts();

  const pickable = (o: Row): boolean => {
    const step = stepFor(o);
    return step === 'DELIVER' || (step === 'COLLECT' && mayCollect);
  };
  const atDoor = rows.filter((o) => stepFor(o) === 'DELIVER');
  const owed = rows.filter((o) => stepFor(o) === 'COLLECT' && mayCollect);
  const owedNoPermission = rows.some((o) => stepFor(o) === 'COLLECT') && !mayCollect;

  const chosen = rows.filter((o) => selected[o.id] && pickable(o));
  const { step, problem } = readChoice(chosen);

  /*
   * THE MONEY DIALOG IS THE CHOICE IT WAS OPENED FOR — AND IS CLOSED, NOT JUST HIDDEN, WHEN THAT STOPS BEING TRUE.
   *
   * The page is read again whenever the person comes back to the window, which is exactly when they have been to
   * ask the courier how much he sent. If in the meantime somebody else took one of those parcels' money, or a
   * parcel moved to another courier, the dialog must not sit there with a total typed for the old set; and a
   * dialog that was only left undrawn kept its «open» flag, so the next money choice opened it by itself.
   * Setting state while rendering, guarded by the condition that ends it, is React's own way to say «this state
   * belongs to that value».
   */
  const choiceKey = chosen
    .map((o) => o.id)
    .sort()
    .join(',');
  if (collectingFor !== null && (collectingFor !== choiceKey || step !== 'COLLECT' || problem)) setCollectingFor(null);
  if (gatheringFor !== null && (gatheringFor !== choiceKey || step !== 'COLLECT' || problem)) setGatheringFor(null);

  /** A new question starts a new selection: the boxes ticked were on a page that is not on screen any more. */
  const choose = (set: (v: string) => void) => (v: string) => {
    set(v);
    setSelected({});
  };
  const reset = () => {
    setTerm('');
    setCourier('all');
    setView('');
    setStatus('all');
    setProduct('all');
    setSelected({});
  };
  const pick = (these: Row[]) => setSelected(Object.fromEntries(these.map((o) => [o.id, true])));
  /** «All» means all of THIS page: the boxes are the page's, and a second page is a second question. */
  const here = pagination.totalPages > 1 ? ' في هذه الصفحة' : '';

  const filters: ToolbarFilter[] = [
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
        ]
      : []),
    {
      key: 'status',
      label: 'الحالة',
      value: status,
      onChange: choose(setStatus),
      options: [
        { value: 'all', label: 'كل الحالات المفتوحة' },
        ...statesOffered(MATCHING_STATUSES, access).map((s) => ({ value: s, label: SHIPPING_STATUS_AR[s] })),
      ],
    },
    {
      key: 'product',
      label: 'المنتج',
      value: product,
      onChange: choose(setProduct),
      options: withChosen(product, [
        { value: 'all', label: 'كل المنتجات' },
        ...products.map((p) => ({ value: p.id, label: p.name })),
      ]),
    },
    {
      key: 'view',
      label: 'ما أعرضه',
      value: view,
      onChange: choose(setView),
      options: [
        { value: '', label: 'كل ما عند الجهة' },
        ...(access.money ? [{ value: 'COLLECT', label: 'المسلَّم بانتظار التحصيل فقط' }] : []),
      ],
    },
  ];
  const activeCount = [courier !== 'all', view !== '', status !== 'all', product !== 'all', term.trim() !== ''].filter(Boolean).length;

  /**
   * THE OUTCOME, ONE ORDER AT A TIME.
   *
   * Each call is its own transaction with its own stock effects, so they run one after
   * another and a refusal does not stop the rest: the answer is «7 of 8, and this one
   * because…», which is what a person at the end of a day with a courier needs to read.
   */
  const settle = async (outcome: 'ALL' | 'NONE') => {
    const these = chosen;
    const ok =
      outcome === 'ALL'
        ? await confirm({
            title: `تسجيل تسليم ${these.length} طلب؟`,
            body: 'يُسجَّل أنّ الزبون استلم كل واحد منها كاملاً. لا يدخل مالٌ المحفظة الآن — يدخل حين تضغط «استلمت منه».',
            confirmLabel: 'نعم، تم تسليمها',
          })
        : await confirm({
            title: `${these.length} طلب لم يستلمها الزبون؟`,
            body: 'تصير مرتجعة. البضاعة لا تعود إلى المخزون الآن — تعود عند عدّها فعلياً في «المرتجعات».',
            confirmLabel: 'نعم، رجعت',
            tone: 'danger',
          });
    if (!ok) return;

    setWorking(true);
    setDone(null);
    setFailed([]);
    const refused: Failure[] = [];
    let landed = 0;
    for (const o of these) {
      try {
        await apiJson('/api/ops/tracking/deliver', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: o.id, outcome }),
        });
        landed += 1;
      } catch (e) {
        refused.push({ ref: o.merchantRef ?? o.orderNumber, why: e instanceof Error ? e.message : 'تعذّر التسجيل' });
      }
    }
    setFailed(refused);
    if (landed > 0) {
      const count = refused.length === 0 ? `${landed} طلب` : `${landed} من ${these.length}`;
      setDone(
        outcome === 'ALL'
          ? `سُجِّل تسليم ${count}. لتحصيل مالها علّمها واضغط «استلمت منه».`
          : `سُجِّل رجوع ${count}. تُعدّ بضاعتها في «المرتجعات».`
      );
    }
    setSelected({});
    setWorking(false);
    await list.reload();
  };

  /*
   * THE RULES, WRITTEN ONCE.
   * A desk reads all five lines in the card. On a phone five paragraphs were ~220px before the first parcel (with the
   * tabs, the title, the search and the filters the list began below the fold), so the card keeps a title and a
   * one-line stepper and the same five paragraphs wait in a fold that says what it holds.
   */
  const rules = (
    <>
      <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        1 — اختر الجهة، أو ابحث برقم الطلب أو الباركود أو اسم العميل.
      </p>
      <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        2 — ما سلّمه وما رجع: علّمه واضغط «تم تسليمها» أو «رجعت». يُسجَّل ما حدث فقط، ولا يدخل مالٌ المحفظة.
      </p>
      <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        3 — المال: علّم المسلَّم واضغط «استلمت منه»، واكتب المبلغ الذي استلمته فعلاً. أيّ فرق عن المتوقَّع يُسجَّل كما هو.
      </p>
      <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        بعد الاستلام يُغلق الطلب مالياً. والراجع يُغلق بعد عدّ بضاعته في «المرتجعات».
      </p>
      <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        «استلمت منه» لنقد بعملة الطلب نفسها إلى محفظة فعّالة. أيّ عملة ثانية، أو سعر صرف، أو كشف واحد تعتمده: «مطابق يدوي»
        لإضافة الطلبات إلى مسوّدة، ثم «تجميع» في «التحصيل والكشوف».
      </p>
    </>
  );

  return (
    <div className="space-y-3">
      <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 space-y-2">
        <p className="text-sm font-medium text-[var(--sys-heading)]">مطابقة يدوية — لشركة أو مندوب لا يرسل كشفاً ولا ملفاً</p>
        {phone ? (
          <>
            <p className="text-xs leading-relaxed text-[var(--sys-foreground)]">
              1 اختر الجهة · 2 سجّل التسليم أو الرجوع · 3 استلم المال
            </p>
            <AdvancedGroup label="كيف تعمل؟" holds="الخطوات بالتفصيل">
              <div className="w-full space-y-2">{rules}</div>
            </AdvancedGroup>
          </>
        ) : (
          rules
        )}
      </div>

      <ListToolbar
        search={term}
        onSearch={choose(setTerm)}
        placeholder="رقم الطلب، المرجع، الباركود، اسم العميل أو الهاتف"
        searchLabel="بحث"
        filters={filters}
        activeCount={activeCount}
        onReset={reset}
      />

      {list.error && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">
          {list.error}
        </p>
      )}
      {done && (
        <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">
          {done}
        </p>
      )}
      {failed.length > 0 && (
        <div className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3 space-y-1">
          <p className="font-medium">تعذّر تسجيل {failed.length} طلب:</p>
          {failed.map((f) => (
            <p key={f.ref} className="text-xs">
              <span dir="ltr">{f.ref}</span> — {f.why}
            </p>
          ))}
        </div>
      )}

      {(atDoor.length > 0 || owed.length > 0 || owedNoPermission) && (
        <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-3 flex flex-wrap items-center gap-3">
          {/* On a desk this strip is what it always was: the count, the way out and the buttons, in a row above the
              list. On a phone it keeps only what is asked BEFORE anything is ticked; the rest is in the bar below. */}
          <span className="text-xs text-[var(--sys-muted-foreground)]">
            {chosen.length === 0 || phone ? 'علّم الطلبات التي تريد تسجيلها.' : `مختار ${chosen.length} طلب`}
          </span>
          {chosen.length === 0 && atDoor.length > 0 && (
            <button onClick={() => pick(atDoor)} className="min-h-11 md:min-h-0 text-xs text-[var(--sys-primary)] hover:underline">
              اختر كل ما بانتظار التسليم ({atDoor.length}){here}
            </button>
          )}
          {chosen.length === 0 && owed.length > 0 && (
            <button onClick={() => pick(owed)} className="min-h-11 md:min-h-0 text-xs text-[var(--sys-primary)] hover:underline">
              اختر كل ما بانتظار التحصيل ({owed.length}){here}
            </button>
          )}
          {owedNoPermission && (
            <span className="text-xs text-[var(--sys-muted-foreground)]">
              استلام المبلغ يحتاج صلاحية الصندوق، فلا مربع على الطلبات المسلَّمة.
            </span>
          )}
          {!phone && chosen.length > 0 && (
            <button onClick={() => setSelected({})} className="text-xs text-[var(--sys-muted-foreground)] hover:underline">
              إلغاء الاختيار
            </button>
          )}
          {!phone && problem && <span className="text-xs text-[var(--sys-destructive)]">{problem}</span>}
          {/* A problem only ever belongs to a mixed choice (no step) or to money (one courier, one currency). */}
          {!phone && step === 'DELIVER' && extra?.mayDeliver !== false && (
            <span className="flex items-center gap-2 mr-auto">
              <button onClick={() => void settle('NONE')} disabled={working} className={RED}>
                <RiCloseLine className="w-4 h-4" aria-hidden /> رجعت ({chosen.length})
              </button>
              <button onClick={() => void settle('ALL')} disabled={working} className={GREEN}>
                {working ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiCheckLine className="w-4 h-4" aria-hidden />}
                تم تسليمها ({chosen.length})
              </button>
            </span>
          )}
          {!phone && !problem && step === 'COLLECT' && (
            <span className="flex items-center gap-2 mr-auto">
              {mayGather && (
                <button onClick={() => setGatheringFor(choiceKey)} className={GREEN}>
                  <RiFileList3Line className="w-4 h-4" aria-hidden /> مطابق يدوي ({chosen.length})
                </button>
              )}
              <button onClick={() => setCollectingFor(choiceKey)} className={GREEN}>
                <RiHandCoinLine className="w-4 h-4" aria-hidden /> استلمت منه ({chosen.length})
              </button>
            </span>
          )}
        </div>
      )}

      {/*
        THE BUTTONS THAT RECORD THE TICKED PARCELS, WHERE THE THUMB IS.
        Parcels are ticked far down a list of cards, and the strip that
        recorded them sat above the list — off the screen by then, so the
        person scrolled back up and lost the place. While anything is ticked
        the bar owns the bottom of the phone. On a desk there is no bar: the
        strip above is where it always was. Same buttons, same doors, same names.
      */}
      <BulkBar show={phone && chosen.length > 0}>
        <span className="me-auto text-xs font-semibold text-[var(--sys-primary)]">مختار {chosen.length} طلب</span>
        <button onClick={() => setSelected({})} className="min-h-11 md:min-h-0 text-xs text-[var(--sys-muted-foreground)] hover:underline">
          إلغاء الاختيار
        </button>
        {problem && <span className="w-full text-xs text-[var(--sys-destructive)]">{problem}</span>}
        {/* A problem only ever belongs to a mixed choice (no step) or to money (one courier, one currency). */}
        {step === 'DELIVER' && (
          <span className="flex grow items-center justify-end gap-2">
            <button onClick={() => void settle('NONE')} disabled={working} className={`${RED} flex-1 justify-center`}>
              <RiCloseLine className="w-4 h-4" aria-hidden /> رجعت ({chosen.length})
            </button>
            <button onClick={() => void settle('ALL')} disabled={working} className={`${GREEN} flex-1 justify-center`}>
              {working ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiCheckLine className="w-4 h-4" aria-hidden />}
              تم تسليمها ({chosen.length})
            </button>
          </span>
        )}
        {!problem && step === 'COLLECT' && (
          <span className="flex grow items-center justify-end gap-2">
            {mayGather && (
              <button onClick={() => setGatheringFor(choiceKey)} className={`${GREEN} flex-1 justify-center`}>
                <RiFileList3Line className="w-4 h-4" aria-hidden /> مطابق يدوي ({chosen.length})
              </button>
            )}
            <button onClick={() => setCollectingFor(choiceKey)} className={`${GREEN} flex-1 justify-center`}>
              <RiHandCoinLine className="w-4 h-4" aria-hidden /> استلمت منه ({chosen.length})
            </button>
          </span>
        )}
      </BulkBar>

      {!extra ? (
        // A first answer that failed is already said above; a spinner that never stops would unsay it.
        list.loading && (
          <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
            <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
          </div>
        )
      ) : (
        <Rows
          rows={rows}
          keyOf={(o) => o.id}
          empty={
            <EmptyState
              title="لا طلبات مفتوحة تطابق اختيارك"
              why="هنا ما هو عند الجهة، وما سُلِّم ولم يُستلم مالُه. وسّع البحث أو اختر «كل الجهات»."
            />
          }
          selection={{
            canSelect: pickable,
            isSelected: (o) => !!selected[o.id],
            onToggle: (o, next) => setSelected((sel) => ({ ...sel, [o.id]: next })),
          }}
          columns={[
            {
              key: 'ref',
              label: 'المرجع',
              primary: true,
              render: (o) => (
                <>
                  <OrderLink id={o.id} number={o.merchantRef ?? o.orderNumber} className="font-medium text-[var(--sys-heading)]" />
                  {o.alert && (
                    <span className="block text-xs text-[var(--sys-destructive)]">
                      {ALERT_AR[o.alert.kind]}
                    </span>
                  )}
                </>
              ),
            },
            { key: 'customer', label: 'العميل', primary: true, render: (o) => o.customer.fullName },
            { key: 'courier', label: 'جهة الشحن', render: (o) => o.deliveryProvider?.name ?? '—' },
            {
              key: 'status',
              label: 'حالة الشحن',
              render: (o) => STATUS_LABEL[o.shippingStatus] ?? o.shippingStatus,
            },
            {
              key: 'next',
              label: 'المطلوب',
              render: (o) => {
                const s = stepFor(o);
                return s ? (
                  NEXT_AR[s]
                ) : (
                  <span className="text-xs text-[var(--sys-muted)]">من شاشة متابعة الشحن</span>
                );
              },
            },
            {
              key: 'amount',
              label: 'المبلغ',
              align: 'end',
              render: (o) => (
                <span dir="ltr" className="tabular-nums">
                  <Money value={o.totalAmount} currency={o.currency} />
                </span>
              ),
            },
            {
              key: 'owed',
              label: 'المتوقَّع منه',
              align: 'end',
              render: (o) =>
                stepFor(o) === 'COLLECT' ? (
                  <span dir="ltr" className="tabular-nums">
                    <Money value={Number(o.expectedCollection ?? 0)} currency={o.currency} />
                  </span>
                ) : (
                  <span className="text-[var(--sys-muted)]">—</span>
                ),
            },
          ]}
        />
      )}

      {pagination.totalPages > 1 && (
        <Pager
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          shown={rows.length}
          noun="طلب"
          loading={list.loading}
          onPage={(page) => {
            setSelected({});
            list.goTo(page);
          }}
        />
      )}

      {gatheringFor !== null && (
        <ManualStatementDialog
          orders={chosen}
          onClose={() => setGatheringFor(null)}
          onDone={async (message) => {
            setGatheringFor(null);
            setSelected({});
            setFailed([]);
            setDone(message);
            await list.reload();
          }}
        />
      )}

      {collectingFor !== null && (
        <CollectDialog
          orders={chosen}
          onClose={() => setCollectingFor(null)}
          onDone={async (message) => {
            setCollectingFor(null);
            setSelected({});
            setFailed([]);
            setDone(message);
            await list.reload();
          }}
        />
      )}
    </div>
  );
}
