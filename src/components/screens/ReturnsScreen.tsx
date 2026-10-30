'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { OrderNotesPeek } from '@/components/orders/OrderNotesPeek';
import { OrderLink } from '@/components/orders/OrderLink';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { ScanButton } from '@/components/scan/ScanButton';
import { RiCheckLine, RiInboxUnarchiveLine, RiTimeLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { MissionDone } from '@/components/ui/NextStep';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Pager } from '@/components/ui/Pager';
import { ListToolbar, withChosen, type ToolbarFilter } from '@/components/ui/ListToolbar';
import { usePagedList, type PagedRead, type Paging } from '@/hooks/usePagedList';
import { arDate } from '@/lib/format';
import { arabicDays } from '@/lib/transit';
import { RETURN_REASON_LABELS } from '@/lib/shipping-workflow';
import { AGES, AGE_AR, DEFAULT_VIEW, RETURN_STATUSES, STATUS_AR, VIEWS, VIEW_AR, type View } from '@/lib/returns-filters';
import type { ReturnsFacts } from '@/lib/returns-list';

/**
 * The reason column. A CODE (CUSTOMER_REFUSED) is shown by its Arabic label, and a code nobody labelled reads «أخرى».
 * Anything that is not a code is a sentence somebody wrote — «أُغلق كخسارة — لم تُستلم البضاعة…», «نقل من … إلى …» — and
 * it is shown as written: hiding it behind «أخرى» would throw away the one thing the reader came for.
 */
function returnReasonText(value: string | null): string {
  if (!value) return '—';
  if (!/^[A-Z_]+$/.test(value)) return value;
  return RETURN_REASON_LABELS[value]?.ar ?? 'أخرى';
}

/**
 * /ops/returns — scan or pick a returned shipment, then record the physical
 * receipt. Missing units are computed by the server, and nothing enters stock
 * before the count-and-inspect acknowledgement.
 *
 * «المرتجعات — صفحات + فلاتر + بحث». Read in pages of 25 through the list kit;
 * a view (waiting to be counted in · already counted in), the state of the
 * parcel, the delivery company and how long it has waited — each with the
 * server's number beside it — and the search box, which is also where a scan
 * lands: a scan is a search typed by a camera, so it is subject to exactly the
 * permissions a typed search is.
 *
 * THIS DESK SETTLES ONE HALF OF A PARTIAL DELIVERY.
 *
 *   «بصير الطلب بيتمم مرتين — مرة بيتمم للمستلم ومرة للطلب الراجع. واذا اتمم
 *    واحد فهو اتمم جزءي، ما بنغلق غير كامل»
 *
 * So the dialog says which half it is closing and which one remains, and it
 * does not decide either: `completion` and `action` come from the server,
 * which reads `completionOf` in lib/partial-delivery.ts. A screen that
 * re-derives a rule is a second copy of it.
 */

/** One line of the parcel as the door left it. Shaped by `settledLines`. */
interface SettledLine {
  itemId: string;
  productName: string;
  /** Units that left the warehouse on this line, gifts included. */
  shipped: number;
  /** Units the customer kept — null when the door never spoke. */
  delivered: number | null;
  /** Units owed back to a shelf. */
  expectedBack: number;
}

interface Completion {
  halves: { key: 'MONEY' | 'GOODS'; label: string; settled: boolean; units: number }[];
  settledCount: number;
  degree: 'NONE' | 'PARTIAL' | 'FULL';
  complete: boolean;
  awaiting: ('MONEY' | 'GOODS')[];
  label: string;
}

/*
 * WHAT THE CLERK NEEDS TO HAVE READ. Not `settlement`: that kind is finance's
 * argument with the courier about money, and this desk is about the goods in
 * the box. Showing it here would hand a counting clerk a dispute to read.
 */
const GOODS_NOTES = ['follow_up', 'return', 'internal'] as const;

interface RowBase {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  trackingNumber: string | null;
  shippingStatus: string;
  returnReason: string | null;
  customer: { fullName: string; phone?: string | null };
  region: { name: string } | null;
  deliveryProvider: { name: string } | null;
}

/** A parcel waiting to be counted in. */
interface PendingRow extends RowBase {
  receipt?: undefined;
  expectedQty: number;
  /** Whole days since the courier last spoke of it — the server's count, cut into the age piles. */
  daysWaited: number | null;
  lines: SettledLine[];
  completion: Completion;
  /** The owner's «هل الطلب استلم؟ نعم / لا», or null when it does not apply. */
  action: { key: 'MONEY' | 'GOODS'; question: string; yes: string; no: string } | null;
}

/** A parcel that was: what was counted, by whom and when. */
interface ReceivedRow extends RowBase {
  receipt: {
    expectedQty: number;
    receivedQty: number;
    damagedQty: number;
    missingQty: number;
    courierFeeCharged: boolean;
    inspectedAt: string;
    inspectedBy: string | null;
    note: string | null;
  } | null;
}

type Row = PendingRow | ReceivedRow;

interface Extra {
  facts: ReturnsFacts;
  /** The view these rows belong to — the answer's own word, so a column is never drawn for rows of the other kind. */
  view: View;
  /** The fee tick-box's own key (`ops.return_fee`). Absent from an older server: the door itself still asks. */
  mayChargeFee: boolean;
}

/** Module-level, so the hook's loader keeps one identity — see `usePagedList`. */
const read = (body: unknown): PagedRead<Row, Extra> => {
  const b = body as { orders: Row[]; pagination: Paging; facts: ReturnsFacts; applied: { view: View }; mayChargeFee?: boolean };
  return { rows: b.orders, pagination: b.pagination, extra: { facts: b.facts, view: b.applied.view, mayChargeFee: b.mayChargeFee !== false } };
};

const since = (days: number | null) => (days === null ? '—' : days === 0 ? 'اليوم' : `منذ ${arabicDays(days)}`);

export function ReturnsScreen() {
  const [term, setTerm] = useState('');
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [status, setStatus] = useState('all');
  const [courier, setCourier] = useState('all');
  const [age, setAge] = useState('all');
  const [active, setActive] = useState<PendingRow | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /*
   * ── PAGES, AND WHAT WAS CHOSEN ──
   *
   * The owner, 20/10: «المرتجعات صفحات اعملها», 21/10: «صفحات + فلاتر + بحث».
   * A page turn keeps the choices; a new CHOICE starts at page one, because
   * page seven of a different question is not where the reader was; and
   * coming back to the screen reloads the page the clerk is ON — all of it in
   * `usePagedList`, the same hook the other lists read through.
   */
  const list = usePagedList<Row, Extra>({
    url: '/api/ops/returns',
    params: { q: term.trim() || undefined, view, status, courier, age },
    read,
  });

  /** What narrows the view that is open: the state, the company, the age, the word typed or scanned. */
  const narrowing = [status, courier, age].filter((v) => v !== 'all').length + (term.trim() ? 1 : 0);
  /** …and the view itself, when it is not the work — what «إعادة تعيين» counts. */
  const activeCount = narrowing + (view !== DEFAULT_VIEW ? 1 : 0);
  const reset = () => {
    setTerm('');
    setView(DEFAULT_VIEW);
    setStatus('all');
    setCourier('all');
    setAge('all');
  };

  const { extra, rows, pagination } = list;

  const filters: ToolbarFilter[] | undefined = extra && [
    {
      key: 'view',
      label: 'العرض',
      value: view,
      // The state and the age describe a parcel that has not been counted in; they are not carried into the record.
      onChange: (v) => {
        setView(v as View);
        setStatus('all');
        setAge('all');
      },
      options: VIEWS.map((v) => ({ value: v, label: `${VIEW_AR[v]} (${extra.facts.views[v]})` })),
    },
    ...(view === DEFAULT_VIEW
      ? [
          {
            key: 'status',
            label: 'الحالة',
            value: status,
            onChange: setStatus,
            options: [
              { value: 'all', label: 'كل الحالات' },
              ...RETURN_STATUSES.map((s) => ({ value: s, label: `${STATUS_AR[s]} (${extra.facts.statuses[s]})` })),
            ],
          },
        ]
      : []),
    {
      key: 'courier',
      label: 'شركة الشحن',
      value: courier,
      onChange: setCourier,
      options: withChosen(courier, [
        { value: 'all', label: 'كل الشركات' },
        ...extra.facts.couriers.map((c) => ({ value: c.id, label: `${c.name} (${c.count})` })),
      ]),
    },
    ...(view === DEFAULT_VIEW
      ? [
          {
            key: 'age',
            label: 'مدّة الانتظار',
            value: age,
            onChange: setAge,
            options: [
              { value: 'all', label: 'أيّ مدّة' },
              ...AGES.map((a) => ({ value: a, label: `${AGE_AR[a]} (${extra.facts.ages[a]})` })),
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="max-w-5xl space-y-3">
      <ScreenTitle />

      {/* Drawn from the first moment, with or without the numbers: a desk that scans must never open without its box. */}
      <ListToolbar
        search={term}
        onSearch={setTerm}
        placeholder="امسح أو اكتب المرجع أو الاسم…"
        searchAutoFocus
        searchDir="ltr"
        // A phone is the scanner a warehouse already owns. It keeps
        // scanning: a returned pallet is twenty parcels, not one.
        searchExtra={
          <ScanButton
            title="امسح بوليصة المرتجع — QR أو باركود"
            continuous
            onScan={(code) => {
              // Putting it in the box IS the search — the list reloads whenever the
              // box changes, so there is one request and one code path, the same
              // one a typed search takes.
              setTerm(code);
              return code;
            }}
          />
        }
        filters={filters ?? []}
        activeCount={activeCount}
        onReset={reset}
      />

      {list.error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{list.error}</p>}
      {done && <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">{done}</p>}

      {!extra ? (
        <SkeletonRows rows={4} />
      ) : (
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
          {/* A returns clerk reads this at the door with a parcel in one
              hand. Six columns on a phone is unreadable; the card leads
              with the reference on the label and whose parcel it is. */}
          <Rows
            rows={rows}
            keyOf={(r) => r.id}
            columns={
              extra.view === 'pending'
                ? [
                    {
                      key: 'ref',
                      label: 'المرجع',
                      primary: true,
                      render: (r) => (
                        <OrderLink id={r.id} number={r.merchantRef ?? r.orderNumber} className="font-medium text-[var(--sys-heading)]" />
                      ),
                    },
                    { key: 'customer', label: 'العميل', primary: true, render: (r) => r.customer.fullName },
                    { key: 'courier', label: 'شركة الشحن', render: (r) => r.deliveryProvider?.name ?? '—' },
                    { key: 'reason', label: 'السبب', render: (r) => returnReasonText(r.returnReason) },
                    { key: 'since', label: 'المدّة', render: (r) => since((r as PendingRow).daysWaited) },
                    // NOT «المشحون». This column has always been what is coming
                    // BACK — the parcel less whatever the customer kept — and
                    // calling it "shipped" made a partial return look like a
                    // shortage to the one person counting the units. (The comment
                    // sits outside the object because `scripts/ui-inventory.ts`
                    // counts a column by `{ key:` and a comment between the two
                    // reads as a deleted column.)
                    {
                      key: 'qty',
                      label: 'المتوقَّع رجوعه',
                      align: 'end',
                      render: (r) => <span className="tabular-nums">{(r as PendingRow).expectedQty}</span>,
                    },
                  ]
                : [
                    {
                      key: 'ref',
                      label: 'المرجع',
                      primary: true,
                      render: (r) => (
                        <OrderLink id={r.id} number={r.merchantRef ?? r.orderNumber} className="font-medium text-[var(--sys-heading)]" />
                      ),
                    },
                    { key: 'customer', label: 'العميل', primary: true, render: (r) => r.customer.fullName },
                    { key: 'courier', label: 'شركة الشحن', render: (r) => r.deliveryProvider?.name ?? '—' },
                    {
                      key: 'counted',
                      label: 'الاستلام',
                      render: (r) => {
                        const c = r.receipt;
                        if (!c) return '—';
                        return (
                          <span className="tabular-nums">
                            {c.receivedQty} من {c.expectedQty}
                            {c.damagedQty > 0 && ` · تالف ${c.damagedQty}`}
                            {c.missingQty > 0 && ` · ناقص ${c.missingQty}`}
                          </span>
                        );
                      },
                    },
                    {
                      key: 'when',
                      label: 'عُدَّ في',
                      render: (r) => (r.receipt ? `${arDate(r.receipt.inspectedAt)}${r.receipt.inspectedBy ? ` · ${r.receipt.inspectedBy}` : ''}` : '—'),
                    },
                  ]
            }
            actions={
              extra.view === 'pending'
                ? (r) => (
                    <button
                      onClick={() => setActive(r as PendingRow)}
                      className="text-xs font-semibold text-[var(--sys-primary)] hover:underline"
                    >
                      استلام
                    </button>
                  )
                : undefined
            }
            empty={
              narrowing > 0 ? (
                <EmptyState
                  icon={RiInboxUnarchiveLine}
                  title="لا مرتجعات بهذه الشروط"
                  why="ما من طرد يطابق العرض والبحث والفلاتر المختارة معاً."
                  action={{ label: 'امسح الفلاتر', onClick: reset }}
                />
              ) : extra.view === 'pending' ? (
                <MissionDone why="المرتجع يظهر هنا حين تُعلن شركةُ الشحن فشلَ التسليم أو إرجاعَ الطرد. فراغُ القائمة يعني أنّ لا طردَ في طريق العودة." />
              ) : (
                <EmptyState
                  icon={RiInboxUnarchiveLine}
                  title="لم يُستلم أيّ مرتجع بعد"
                  why="ما يُعدّ في هذه الشاشة يُسجَّل هنا: كم استُلم، وكم كان تالفاً أو ناقصاً، ومن عدّه ومتى."
                />
              )
            }
          />

          {/*
            THE PAGER, AND IT ONLY APPEARS WHEN THERE IS A SECOND PAGE.
            A clerk with eleven returns should not be shown «صفحة ١ من ١»
            and two dead arrows — that is furniture telling them nothing.

            The sentence above the arrows is «عرض ١٢ من ٨٧» and not a page
            number, because «كم ضايل» is the question a returns desk
            actually asks of this screen.
          */}
          {pagination.totalPages > 1 && (
            <div className="mt-3 border-t border-[var(--sys-border)] pt-3">
              <Pager
                page={pagination.page}
                totalPages={pagination.totalPages}
                total={pagination.total}
                shown={rows.length}
                noun="مرتجع"
                loading={list.loading}
                onPage={list.goTo}
              />
            </div>
          )}
        </div>
      )}

      {active && (
        <ReceiveDialog
          order={active}
          mayChargeFee={extra?.mayChargeFee !== false}
          onClose={() => setActive(null)}
          onDone={async (message) => {
            setActive(null);
            setDone(message);
            await list.reload();
          }}
        />
      )}
    </div>
  );
}

function ReceiveDialog({
  order,
  mayChargeFee,
  onClose,
  onDone,
}: {
  order: PendingRow;
  mayChargeFee: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const toast = useToast();
  const [received, setReceived] = useState(order.expectedQty);
  const [damaged, setDamaged] = useState(0);
  const [courierFee, setCourierFee] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * THE EXTRA ACTION'S ANSWER — «هل الطلب استلم؟ نعم / لا».
   *
   * Null until it is answered, and the count below it stays closed until
   * then. The dialog used to pre-fill «سليم» with the whole expected
   * quantity, which answers the question on the clerk's behalf and with the
   * commonest wrong answer: a parcel that is listed as coming back has very
   * often not arrived yet, and a receipt written for it puts units on a
   * shelf that nobody has ever held.
   *
   * Only asked where the owner asks for it: a split parcel of more than one
   * unit. Everything else keeps the one-step flow it had.
   */
  const [arrived, setArrived] = useState<boolean | null>(null);
  const gated = order.action !== null && arrived !== true;

  const missing = Math.max(0, order.expectedQty - received - damaged);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiJson<{ missingQty: number; courierFeeAmount: number; completion: Completion }>('/api/ops/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.id,
          receivedQty: received,
          damagedQty: damaged,
          countedAndInspected: acknowledged,
          chargeCourierFee: courierFee,
          note: note || undefined,
        }),
      });
      onDone(
        `تم استلام ${order.merchantRef ?? order.orderNumber}: سليم ${received}، تالف ${damaged}، ناقص ${res.missingQty}` +
          (res.courierFeeAmount ? ` — أجرة إرجاع ${res.courierFeeAmount}` : '') +
          // «ما بنغلق غير كامل». Without this the clerk reads their own
          // receipt as the end of the order, and for a partial delivery the
          // money the customer paid at the door is still outstanding.
          (res.completion.complete ? '' : ` — ${res.completion.label}`)
      );
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر حفظ الاستلام');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="استلام مرتجع" subtitle={order.merchantRef ?? order.orderNumber} maxWidth="sm">
      <form onSubmit={submit} className="space-y-3">
        {/*
          WHICH PRODUCT, HOW MANY TAKEN, HOW MANY DUE BACK.

            «شو المنتج الي استلمو وكم قطعة وشو الي رجع»

          This was one line per product at its full shipped quantity — «ماء
          الكمأ × 3» for a parcel where the customer kept two and one is
          coming back. The clerk has the box open in front of them, so the
          list is the figure they trust, and it was the wrong one: the total
          in the row behind this dialog said 1 while the list said 3.
        */}
        <div className="border border-[var(--sys-border)] rounded-lg overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-2 py-1.5 bg-[var(--sys-surface)] text-xs font-medium text-[var(--sys-muted-foreground)]">
            <span>المنتج</span>
            <span className="w-12 text-center">شُحن</span>
            <span className="w-12 text-center">استلمه</span>
            <span className="w-12 text-center">راجع</span>
          </div>
          {order.lines.map((l) => (
            <div
              key={l.itemId}
              className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-2 py-1.5 border-t border-[var(--sys-border)] text-xs items-center"
            >
              <span className="text-[var(--sys-heading)] truncate">{l.productName}</span>
              <span className="w-12 text-center tabular-nums text-[var(--sys-muted-foreground)]">{l.shipped}</span>
              {/* A dash, not a zero: the door never spoke about this line, and
                  «0» would be a statement that the customer refused it. */}
              <span className="w-12 text-center tabular-nums text-[var(--sys-foreground)]">
                {l.delivered === null ? '—' : l.delivered}
              </span>
              <span
                className={`w-12 text-center tabular-nums font-semibold ${
                  l.expectedBack > 0 ? 'text-[var(--sys-warning)]' : 'text-[var(--sys-muted)]'
                }`}
              >
                {l.expectedBack}
              </span>
            </div>
          ))}
        </div>

        {/*
          THE EXTRA ACTION.

            «إذا الأوردر فيه أكثر من كمية واستلم أو رفض قطعة، حط إجراء إضافي
             مثل: هل الطلب استلم؟ نعم / لا»

          Asked before the count, because it decides whether there is a count
          to make. The question and its two answers are the server's words —
          the same ones the route records — so the screen cannot ask one thing
          and the record say another.
        */}
        {order.action && (
          <div className="bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-2">
            <p className="text-sm font-medium text-[var(--sys-heading)]">{order.action.question}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setArrived(true);
                  setReceived(order.expectedQty);
                }}
                className={`h-11 md:h-10 px-3 rounded-lg border text-sm ${
                  arrived === true
                    ? 'bg-[var(--sys-success-soft)] border-[var(--sys-success)] text-[var(--sys-success)] font-medium'
                    : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                }`}
              >
                {order.action.yes}
              </button>
              <button
                type="button"
                onClick={() => {
                  setArrived(false);
                  setReceived(0);
                }}
                className={`h-11 md:h-10 px-3 rounded-lg border text-sm ${
                  arrived === false
                    ? 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] font-medium'
                    : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                }`}
              >
                {order.action.no}
              </button>
            </div>
            {arrived === false && (
              <p className="text-xs text-[var(--sys-destructive)]">
                لا يُسجَّل استلام إذن. الطلب يبقى مفتوحاً على نصفه الراجع، ويظهر في هذه القائمة حتى تصل القطع.
              </p>
            )}
          </div>
        )}

        {/*
          «واذا اتمم واحد فهو اتمم جزءي، ما بنغلق غير كامل» — stated in the
          screen, not only in the note it writes. The clerk is about to finish
          their half and would otherwise leave believing the order is done.
        */}
        {order.completion.halves.length > 1 && (
          <ul className="text-xs bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-2 space-y-1">
            <li className="font-medium text-[var(--sys-heading)]">
              هذا الطلب يُتَمَّم مرتين — لا يُغلق إلا بإتمام النصفين:
            </li>
            {order.completion.halves.map((h) => (
              <li key={h.key} className="flex items-center gap-1.5 text-[var(--sys-foreground)] tabular-nums">
                {/* An icon, not a typed checkmark: «✓» is the operating
                    system's glyph and renders differently on every device
                    this desk runs on. */}
                {h.settled ? (
                  <RiCheckLine className="w-4 h-4 shrink-0 text-[var(--sys-success)]" />
                ) : (
                  <RiTimeLine className="w-4 h-4 shrink-0 text-[var(--sys-warning)]" />
                )}
                <span>
                  {h.label} ({h.units} قطعة)
                </span>
              </li>
            ))}
          </ul>
        )}

        {!gated && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Num label="سليم" value={received} onChange={setReceived} max={order.expectedQty} />
              <Num label="تالف" value={damaged} onChange={setDamaged} max={order.expectedQty} />
              {/*
                A COMPUTED FIGURE IS NOT AN INPUT, BUT IT STANDS IN A ROW OF
                THEM. So it borrows the field's measurements exactly — the
                `--sys-heading` label at `mb-1.5` and `h-11 md:h-10` — because
                it had `--sys-foreground` at `mb-1` and a flat `h-10`, which
                put its label two pixels high and its box a pixel short of the
                two beside it. Three boxes in a row at three heights is what
                «غير متناسبة مع التصميم» looks like from a desk.

                It is deliberately NOT a disabled `Input`: nobody typed this,
                and a greyed-out box invites somebody to try.
              */}
              <div className="w-full min-w-0">
                <span className="block text-xs font-medium text-[var(--sys-heading)] mb-1.5">ناقص (محسوب)</span>
                <p className={`h-11 md:h-10 flex items-center px-3 rounded-lg border text-sm tabular-nums ${missing > 0 ? 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]' : 'border-[var(--sys-border)] bg-[var(--sys-surface)] text-[var(--sys-foreground)]'}`} dir="ltr">
                  {missing}
                </p>
              </div>
            </div>

            {/*
              A TICK BOX NAMES ITS OWN COLOUR, OR THE BROWSER PICKS WHITE.

                «إذا كانت بيضا فتكون أزرق»

              `accent-color` is the one property that tints a native
              checkbox, and nothing in the product set it — not here and not
              in system.css. So every tick box on this desk drew the user
              agent's own grey-and-white control, on a surface built out of
              `--sys-*` tokens, and a checked box did not read as checked.
              `min-h-11 min-w-11` on the label keeps the phone tap target at
              44px while the box itself stays 20px.
            */}
            {mayChargeFee && (
            <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--sys-foreground)] md:min-h-0">
              <input
                type="checkbox"
                checked={courierFee}
                onChange={(e) => setCourierFee(e.target.checked)}
                className="h-5 w-5 shrink-0 accent-[var(--sys-primary)]"
              />
              احتساب أجرة إرجاع لشركة الشحن (تُؤخذ من جدول الأجور)
            </label>
            )}

            {/*
              READ BEFORE WRITING. The contract surfaces notes on «settlement
              exceptions, return receiving, tracking and order detail» and this
              desk was the one place that had the INPUT and no way to read what
              anybody had already written — so the clerk with the box open
              could not see last week's «الزبون قال إنّ القطعة مكسورة».

              Above the input on purpose: the order is read, then added to.
            */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-[var(--sys-muted-foreground)]">
                ما كُتب على هذا الطلب قبل الآن
              </span>
              <OrderNotesPeek
                orderId={order.id}
                orderNumber={order.merchantRef ?? order.orderNumber}
                kinds={GOODS_NOTES}
                showKind
                label="التعليقات"
                emptyText="لا تعليق على هذا الطلب — لم يكتب أحد شيئاً عن هذه القطع."
              />
            </div>

            <Input
              label="ملاحظة (اختياري)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />

            <label className="flex min-h-11 items-start gap-2 text-sm text-[var(--sys-heading)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-2 md:min-h-0">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="h-5 w-5 mt-1 shrink-0 accent-[var(--sys-primary)]"
              />
              <span>أقرّ بأنني عددت البضاعة وفحصتها. لا تدخل البضاعة للمخزون قبل هذا الإقرار.</span>
            </label>
          </>
        )}

        <div className="flex gap-2 pt-1">
          {!gated && (
            <button type="submit" disabled={busy || !acknowledged} className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50">
              {busy ? 'جارٍ الحفظ…' : 'تأكيد الاستلام'}
            </button>
          )}
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)]">
            {arrived === false ? 'إغلاق' : 'إلغاء'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * A counted quantity, on the system's field.
 *
 * It hand-rolled the input and named no background, so the browser used its
 * own — white, whatever theme the clerk was in. Three white boxes on a dark
 * card is «التنبيهات المنبثقة … غير متناسبة مع التصميم» exactly. That half
 * is answered at the root now: `color-scheme` is declared per palette in
 * system.css and guarded in system-themes.test.ts.
 *
 * The shared `Input` is still what belongs here, for the half the root
 * cannot reach: it brings the focus ring — `--sys-primary` at 25% — which a
 * hand-rolled field has no way to inherit, because system.css styles
 * `:focus-visible` only, deliberately, so a TAPPED field showed nothing at
 * all. «إذا كانت بيضا فتكون أزرق».
 */
function Num({ label, value, onChange, max }: { label: string; value: number; onChange: (v: number) => void; max: number }) {
  return (
    <Input
      label={label}
      type="number"
      min={0}
      max={max}
      value={value}
      onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value))))}
      dir="ltr"
    />
  );
}
