'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Input';
import { OrderNotesPeek } from '@/components/orders/OrderNotesPeek';
import { OrderRef } from '@/components/orders/OrderRef';
import { ParcelCopy } from '@/components/screens/tracking/ParcelCopy';
import { ParcelPhone } from '@/components/screens/tracking/ParcelPhone';
import { useTell } from '@/components/ui/Confirm';
import { PageShell } from '@/components/ui/PageShell';
import { routeLabel } from '@/lib/route-registry';
import { ScanButton } from '@/components/scan/ScanButton';
import { RiCheckLine, RiInboxUnarchiveLine, RiTimeLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { Rows } from '@/components/ui/Rows';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { useIsPhone } from '@/hooks/useIsPhone';
import { EmptyState } from '@/components/ui/EmptyState';
import { MissionDone } from '@/components/ui/NextStep';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Pager } from '@/components/ui/Pager';
import { ListToolbar, withChosen, type ToolbarFilter } from '@/components/ui/ListToolbar';
import { usePagedList, type PagedRead, type Paging } from '@/hooks/usePagedList';
import { arDate } from '@/lib/format';
import { barcodeToCopy } from '@/lib/copy-values';
import { arabicDays } from '@/lib/transit';
import { RETURN_REASON_LABELS } from '@/lib/shipping-workflow';
import { AGES, AGE_AR, DEFAULT_VIEW, RETURN_STATUSES, STATUS_AR, VIEWS, VIEW_AR, type View } from '@/lib/returns-filters';
import type { ReturnsFacts } from '@/lib/returns-list';
import { addAnswer, emptyTotals, receiveAllLine, skippedTotal, type ReceiveAllAnswer, type ReceiveAllTotals } from '@/lib/returns-receive-all';

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
  /**
   * «طلع من مخزن كذا» (W4d): the warehouse the parcel left from — the desk's default receiver, SHOWN only (choosing
   * where it is received is a later request). Sent only when the order has one, so an unplaced store draws nothing new.
   */
  sourceWarehouseName?: string;
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
  /** «استلام الكل»'s own key (`ops.returns_receive_all`). Only a server that says yes draws the button. */
  mayReceiveAll: boolean;
}

/** A warehouse a parcel may be received into (W2b). Names are unique within a country, so the source is found by name. */
interface ReceiveWarehouse {
  id: string;
  name: string;
}

/**
 * W2b: WHERE A PARCEL MAY BE RECEIVED — asked of its own door when a receipt dialog OPENS (the list itself asks nothing
 * new). Undefined for a store that is not placed, while the answer is on its way, or when it did not come: the dialog
 * then asks nothing new and sends nothing new — and the door still decides (the single receipt falls back to the
 * warehouse the parcel left from; «استلام الكل» refuses without one, in a sentence).
 */
function useReceiveWarehouses(): ReceiveWarehouse[] | undefined {
  const [into, setInto] = useState<ReceiveWarehouse[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    apiJson<{ placed?: boolean; warehouses?: ReceiveWarehouse[] }>('/api/ops/returns/warehouses')
      .then((a) => {
        if (live && a?.placed === true && Array.isArray(a.warehouses)) setInto(a.warehouses);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return into;
}

/** Module-level, so the hook's loader keeps one identity — see `usePagedList`. */
const read = (body: unknown): PagedRead<Row, Extra> => {
  const b = body as { orders: Row[]; pagination: Paging; facts: ReturnsFacts; applied: { view: View }; mayChargeFee?: boolean; mayReceiveAll?: boolean };
  return { rows: b.orders, pagination: b.pagination, extra: { facts: b.facts, view: b.applied.view, mayChargeFee: b.mayChargeFee !== false, mayReceiveAll: b.mayReceiveAll === true } };
};

/**
 * The list's frame. A desk: the page's card around the table. A phone: no frame — the cards ARE the list, and a card
 * inside a card is a second edge for nothing. Module-level, so the frame keeps one identity between renders.
 */
function ListFrame({ phone, children }: { phone: boolean; children: React.ReactNode }) {
  return phone ? <div>{children}</div> : <Card padding="sm">{children}</Card>;
}

const since = (days: number | null) => (days === null ? '—' : days === 0 ? 'اليوم' : `منذ ${arabicDays(days)}`);

/** The courier, and under it «طلع من مخزن كذا» when the server named one (W4d) — a row with none reads as it always did. */
const courierCell = (r: RowBase) =>
  r.sourceWarehouseName ? (
    <>
      {r.deliveryProvider?.name ?? '—'}
      <span className="block text-note text-[var(--sys-muted-foreground)]">طلع من مخزن {r.sourceWarehouseName}</span>
    </>
  ) : (
    r.deliveryProvider?.name ?? '—'
  );

/**
 * «المخزن» (the owner, 25/11: «اسم المخزن أظهره بمتابعة المرتجعات عشان أعرف»): the warehouse the parcel LEFT FROM, as its
 * own column — a placed store only. A parcel with no stamp (shipped before the placement) reads «—».
 */
const warehouseCell = (r: RowBase) => r.sourceWarehouseName ?? '—';
/** In a placed store the warehouse has its own column, so the courier cell is the courier alone. */
const courierOnly = (r: RowBase) => r.deliveryProvider?.name ?? '—';

export function ReturnsScreen() {
  const phone = useIsPhone();
  /*
   * F10 (25/11): the warehouses of a PLACED store this person reaches — the same door and rule as the receive dialog's
   * picker. Undefined for a store that is not placed: no column, no filter, and the list is asked what it always was.
   */
  const places = useReceiveWarehouses();
  /** «من أي مخزن طلع المرتجع»: `all`, a warehouse's id, or `none` (no stamp). Sent only for a placed store. */
  const [warehouse, setWarehouse] = useState('all');
  // A copy the browser refuses is handed to a field to select by hand, not to a warning that goes away (as on the shipment follow-up).
  const tell = useTell();
  const copyRefused = (value: string) => void tell({ title: 'تعذّر النسخ — انسخه يدوياً', value });
  const [term, setTerm] = useState('');
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [status, setStatus] = useState('all');
  const [courier, setCourier] = useState('all');
  const [age, setAge] = useState('all');
  /** «بلا باركود» (the owner, 13/11): `all`, or `none` — only the parcels the courier gave no barcode. */
  const [barcode, setBarcode] = useState('all');
  const [active, setActive] = useState<PendingRow | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [receivingAll, setReceivingAll] = useState(false);

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
    params: { q: term.trim() || undefined, view, status, courier, age, barcode, warehouse: places ? warehouse : undefined },
    read,
  });

  /** What narrows the view that is open: the state, the company, the age, the warehouse, the word typed or scanned. */
  const narrowing = [status, courier, age, barcode, places ? warehouse : 'all'].filter((v) => v !== 'all').length + (term.trim() ? 1 : 0);
  /** …and the view itself, when it is not the work — what «إعادة تعيين» counts. */
  const activeCount = narrowing + (view !== DEFAULT_VIEW ? 1 : 0);
  const reset = () => {
    setTerm('');
    setView(DEFAULT_VIEW);
    setStatus('all');
    setCourier('all');
    setAge('all');
    setBarcode('all');
    setWarehouse('all');
  };

  const { extra, rows, pagination } = list;
  /** Phones travel only to whoever may read them; with none on the page there is no column for them. */
  const showPhone = rows.some((r) => !!r.customer.phone);

  /*
   * THE PHONE AND THE BARCODE, WRITTEN ON THE ROW, EACH WITH THE SMALL BUTTON THAT COPIES IT (the owner, 13/11: «اظهار الباركود والرقم
   * وزر النسخ»). They are the shipment follow-up's own pieces, so a copy here is the same copy there — it writes nothing and counts
   * for nothing. The phone column is drawn only when the list carried phones: a person who may not read them (the warehouse) is sent
   * none, and a column of dashes is not a column. The barcode is always drawn: the text, and beside it the button, OFF when the
   * courier gave none — which is also what «بلا باركود» in the toolbar finds. What is written is what the button copies (`barcodeToCopy`):
   * a barcode of nothing but spaces or invisible marks is no barcode on the row, and the button is OFF for it.
   */
  const contactColumns = [
    ...(showPhone ? [{ key: 'phone', label: 'الهاتف', render: (r: Row) => <ParcelPhone phone={r.customer.phone} onRefused={copyRefused} /> }] : []),
    {
      key: 'barcode',
      label: 'الباركود',
      render: (r: Row) => (
        <span className="inline-flex items-center gap-1">
          <span dir="ltr" className="text-[var(--sys-muted-foreground)]">
            {barcodeToCopy(r.trackingNumber) || '—'}
          </span>
          <ParcelCopy row={r} onRefused={copyRefused} />
        </span>
      ),
    },
  ];

  /*
   * «استلام الكل» — DRAWN ONLY WHERE THE DOOR WOULD SAY YES.
   *
   * The server's own word (`mayReceiveAll`, the key `ops.returns_receive_all`), the work view, and something in it. A
   * control the door would refuse is not drawn. The number on it is the list's own total — every page of the filters
   * that are chosen now — because that is the set the door walks.
   */
  // F10: not while ONE warehouse is chosen — the press walks the list's other filters, not the warehouse, so the number on
  // it would be a promise the door does not keep. «كل المخازن» brings it back.
  const receiveAllTotal = extra?.mayReceiveAll && extra.view === 'pending' && (!places || warehouse === 'all') ? pagination.total : 0;

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
    {
      key: 'barcode',
      label: 'الباركود',
      value: barcode,
      onChange: setBarcode,
      options: [
        { value: 'all', label: 'كل الطرود' },
        // «بلا باركود (N)» promises N rows when it is chosen — over the open view, like the companies. An older server sends no number.
        { value: 'none', label: `بلا باركود (${extra.facts.noBarcode ?? 0})` },
      ],
    },
    // F10: a placed store only — the warehouses this person reaches, and «بلا مخزن» for what was shipped before the placement.
    ...(places
      ? [
          {
            key: 'warehouse',
            label: 'المخزن',
            value: warehouse,
            onChange: setWarehouse,
            options: withChosen(warehouse, [
              { value: 'all', label: 'كل المخازن' },
              ...places.map((w) => ({ value: w.id, label: w.name })),
              { value: 'none', label: 'بلا مخزن' },
            ]),
          },
        ]
      : []),
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
    <PageShell
      title={routeLabel('/ops/returns')}
      width="wide"
      // The frame's row of questions (R11e): the search, the scan, «استلام الكل» and the dropdowns. It was the first block of
      // the content; it is the same place on the screen, now the one every screen keeps its filters in.
      // Drawn from the first moment, with or without the numbers: a desk that scans must never open without its box.
      filters={
        <ListToolbar
          search={term}
          onSearch={setTerm}
          placeholder="امسح أو اكتب المرجع أو الاسم…"
          searchAutoFocus
          searchDir="ltr"
          // A phone is the scanner a warehouse already owns. It keeps
          // scanning: a returned pallet is twenty parcels, not one.
          searchExtra={
            <>
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
              {receiveAllTotal > 0 && (
                <Button size="md" className="shrink-0" onClick={() => setReceivingAll(true)}>
                  استلام الكل ({receiveAllTotal})
                </Button>
              )}
            </>
          }
          filters={filters ?? []}
          activeCount={activeCount}
          onReset={reset}
        />
      }
    >
      {list.error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{list.error}</p>}
      {done && <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">{done}</p>}

      {!extra ? (
        <SkeletonRows rows={4} />
      ) : (
        <ListFrame phone={phone}>
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
                        <OrderRef id={r.id} number={r.merchantRef ?? r.orderNumber} className="font-medium text-[var(--sys-heading)]" />
                      ),
                    },
                    { key: 'customer', label: 'العميل', primary: true, render: (r) => r.customer.fullName },
                    { key: 'courier', label: 'شركة الشحن', render: places ? courierOnly : courierCell },
                    // F10: the warehouse the parcel left from, a placed store only.
                    ...(places
                      ? [
                          { key: 'warehouse', label: 'المخزن', render: warehouseCell },
                        ]
                      : []),
                    ...contactColumns,
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
                        <OrderRef id={r.id} number={r.merchantRef ?? r.orderNumber} className="font-medium text-[var(--sys-heading)]" />
                      ),
                    },
                    { key: 'customer', label: 'العميل', primary: true, render: (r) => r.customer.fullName },
                    { key: 'courier', label: 'شركة الشحن', render: places ? courierOnly : courierCell },
                    // F10: the warehouse the parcel left from, a placed store only.
                    ...(places
                      ? [
                          { key: 'warehouse', label: 'المخزن', render: warehouseCell },
                        ]
                      : []),
                    ...contactColumns,
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
                ? (r) =>
                    // The one press this desk exists for. A phone: a button across the card that a thumb finds with a
                    // parcel in the other hand. A desk: the word it has always been.
                    phone ? (
                      <Button size="md" className="w-full" onClick={() => setActive(r as PendingRow)}>
                        استلام
                      </Button>
                    ) : (
                      <Button variant="quiet" size="sm" onClick={() => setActive(r as PendingRow)}>
                        استلام
                      </Button>
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
        </ListFrame>
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

      {receivingAll && (
        <ReceiveAllDialog
          total={receiveAllTotal}
          filters={{ view, status, courier, age, barcode, q: term.trim() || undefined }}
          onClose={() => setReceivingAll(false)}
          onDone={async (line) => {
            setReceivingAll(false);
            setDone(line);
            await list.reload();
          }}
        />
      )}
    </PageShell>
  );
}

/**
 * «استلام الكل» — ASK, THEN WALK THE SET IN PIECES OF FIFTY, THEN SAY ONE LINE.
 *
 * It says, in plain words, what one press does to every parcel, and that it cannot be undone; the confirm stays off until
 * the tick. Then the same filters go back to the door with each answer's cursor until the cursor is null or «إيقاف» is
 * pressed. Nothing here picks the parcels: the door derives them from the filters, the same way the list did.
 */
function ReceiveAllDialog({
  total,
  filters,
  onClose,
  onDone,
}: {
  total: number;
  filters: Record<string, string | undefined>;
  onClose: () => void;
  onDone: (line: string) => void;
}) {
  /** W2b: a placed store — the press names ONE warehouse for every parcel. */
  const warehouses = useReceiveWarehouses();
  const toast = useToast();
  const [acknowledged, setAcknowledged] = useState(false);
  const [into, setInto] = useState('');
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<ReceiveAllTotals>(emptyTotals());
  const stop = useRef(false);
  // Leaving the screen is the same as «إيقاف»: the piece in flight finishes, no other piece is asked, and nothing is said to a
  // screen that is no longer there. (Set again on every mount, so a development double-mount does not leave it off.)
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current = true;
    };
  }, []);

  const run = async () => {
    setRunning(true);
    stop.current = false;
    let t = emptyTotals();
    let cursor: string | null = null;
    let broke = false;
    try {
      do {
        const answer: ReceiveAllAnswer = await apiJson<ReceiveAllAnswer>('/api/ops/returns/receive-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...filters, countedAndInspected: true, cursor, ...(warehouses ? { warehouseId: into } : {}) }),
        });
        t = addAnswer(t, answer);
        setTotals(t);
        cursor = answer.nextCursor;
      } while (cursor && !stop.current);
    } catch (e) {
      broke = true;
      toast.failed(e instanceof Error ? e.message : 'تعذّر إكمال الاستلام');
    }
    if (alive.current) onDone(receiveAllLine(t, { stopped: !broke && !!cursor && stop.current, broke }));
  };

  const progress = total > 0 ? Math.min(100, Math.round(((totals.received + skippedTotal(totals)) / total) * 100)) : 0;

  return (
    <Modal
      isOpen
      // While it runs, closing is the same as «إيقاف»: the piece in flight finishes and the line is said.
      onClose={() => (running ? (stop.current = true) : onClose())}
      title={`استلام الكل (${total})`}
      maxWidth="sm"
      footer={
        <div className="flex gap-2">
          {running ? (
            <Button key="stop" size="md" variant="secondary" className="flex-1" onClick={() => void (stop.current = true)}>
              إيقاف
            </Button>
          ) : (
            <>
              <Button key="yes" size="md" className="flex-1" disabled={!acknowledged || (!!warehouses && !into)} onClick={() => void run()}>
                نعم، استلم الكل
              </Button>
              <Button key="cancel" size="md" variant="secondary" onClick={onClose}>
                إلغاء
              </Button>
            </>
          )}
        </div>
      }
    >
      {running ? (
        <div className="space-y-2" aria-live="polite">
          <p className="text-sm font-medium text-[var(--sys-heading)] tabular-nums">
            استلمت {totals.received} من {total}
          </p>
          <div className="h-2 rounded-full bg-[var(--sys-surface)] overflow-hidden">
            <div className="h-2 rounded-full bg-[var(--sys-primary)]" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-xs text-[var(--sys-muted-foreground)] tabular-nums">تركت {skippedTotal(totals)} لحد هلق</p>
        </div>
      ) : (
        <div className="space-y-3 text-sm text-[var(--sys-foreground)]">
          <p className="font-medium text-[var(--sys-heading)]">رح أستلم {total} مرتجع، كل اللي بالقائمة بالفلاتر الحالية — مش بس هالصفحة.</p>
          <ul className="space-y-1">
            <li>كل طرد بينستلم كامل وسليم: لا تالف ولا ناقص.</li>
            <li>{warehouses ? 'البضاعة بترجع على المخزن اللي بتختاره تحت، كلها على نفس المخزن.' : 'البضاعة بترجع على الرف.'}</li>
            <li>عمولة الطلب بتنعكس.</li>
            <li>بلا أجرة إرجاع على شركة الشحن.</li>
            <li>التوصيل الجزئي بينترك، بينستلم من نافذته لحاله.</li>
          </ul>
          <p className="font-medium text-[var(--sys-destructive)]">ما في تراجع بعد الضغطة.</p>
          {warehouses && (
            <Select
              label="استلمتها بمخزن"
              value={into}
              onChange={(e) => setInto(e.target.value)}
              options={[{ value: '', label: 'اختار المخزن' }, ...warehouses.map((w) => ({ value: w.id, label: w.name }))]}
            />
          )}
          <div className="bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg px-2">
            <Checkbox id="returns-receive-all-ack" checked={acknowledged} onChange={setAcknowledged} label="أقرّ إني عددت وفحصت المرتجعات" />
          </div>
        </div>
      )}
    </Modal>
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
  /** W2b: a placed store — where the parcel is received; the warehouse it left from comes chosen. */
  const warehouses = useReceiveWarehouses();
  /** The warehouse it left from, when this person may receive into it (names are unique within a country). */
  const fromSource = warehouses?.find((w) => w.name === order.sourceWarehouseName);
  const [picked, setInto] = useState<string | null>(null);
  /** Until the person picks, the warehouse it left from is the choice. */
  const into = picked ?? fromSource?.id ?? '';
  const toast = useToast();
  const phone = useIsPhone();
  const formId = useId();
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

  // The two ends of the dialog, drawn once and placed by the layout: inside the form on a desk, in the footer of the
  // dialog on a phone (a submit button out there belongs to the form by its id).
  const actionRow = (
    <div className="flex gap-2 pt-1">
      {!gated && (
        <Button
          type="submit"
          form={phone ? formId : undefined}
          disabled={busy || !acknowledged || (!!warehouses && !into)}
          className={phone ? 'flex-1' : undefined}
        >
          {busy ? 'جارٍ الحفظ…' : 'تأكيد الاستلام'}
        </Button>
      )}
      <Button type="button" variant="secondary" onClick={onClose}>
        {arrived === false ? 'إغلاق' : 'إلغاء'}
      </Button>
    </div>
  );

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
          // W2b: a placed store's receipt names its warehouse. Absent otherwise — today's body.
          ...(warehouses ? { warehouseId: into } : {}),
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
    <Modal
      isOpen
      onClose={onClose}
      title="استلام مرتجع"
      subtitle={order.merchantRef ?? order.orderNumber}
      maxWidth="sm"
      // A phone: the two buttons stay at the foot of the dialog while the form scrolls — «تأكيد الاستلام» was the
      // last thing under a count, a tick, a note and an acknowledgement, and the keyboard covered it. A desk: in the form.
      footer={phone ? actionRow : undefined}
    >
      <form id={formId} onSubmit={submit} className="space-y-3">
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
          <div className={`${phone ? 'grid grid-cols-3' : 'grid grid-cols-[1fr_auto_auto_auto]'} gap-2 px-2 py-1.5 bg-[var(--sys-surface)] text-note font-medium text-[var(--sys-muted-foreground)]`}>
            {!phone && <span>المنتج</span>}
            <span className={phone ? 'text-center' : 'w-12 text-center'}>شُحن</span>
            <span className={phone ? 'text-center' : 'w-12 text-center'}>استلمه</span>
            <span className={phone ? 'text-center' : 'w-12 text-center'}>راجع</span>
          </div>
          {order.lines.map((l) => (
            <div
              key={l.itemId}
              className={`${phone ? 'grid grid-cols-3' : 'grid grid-cols-[1fr_auto_auto_auto]'} gap-2 px-2 py-1.5 border-t border-[var(--sys-border)] text-note items-center`}
            >
              {/* The name is the thing being checked. A phone gives it a line of its own, in full, with the three
                  numbers in a row under it; a desk keeps one row and the ellipsis. */}
              <span className={phone ? 'col-span-full text-[var(--sys-heading)]' : 'text-[var(--sys-heading)] truncate'}>{l.productName}</span>
              <span className={`${phone ? '' : 'w-12 '}text-center tabular-nums text-[var(--sys-muted-foreground)]`}>{l.shipped}</span>
              {/* A dash, not a zero: the door never spoke about this line, and
                  «0» would be a statement that the customer refused it. */}
              <span className={`${phone ? '' : 'w-12 '}text-center tabular-nums text-[var(--sys-foreground)]`}>
                {l.delivered === null ? '—' : l.delivered}
              </span>
              <span
                className={`${phone ? '' : 'w-12 '}text-center tabular-nums font-semibold ${
                  l.expectedBack > 0 ? 'text-[var(--sys-warning)]' : 'text-[var(--sys-muted)]'
                }`}
              >
                {l.expectedBack}
              </span>
            </div>
          ))}
        </div>

        {/* THE DEFAULT RECEIVER (W4d), SAID ONLY: the warehouse the parcel left from. Nothing here picks a warehouse or
            sends one — the receipt is written exactly as before. A parcel with no source warehouse draws nothing. */}
        {order.sourceWarehouseName && (
          <p className="text-note text-[var(--sys-muted-foreground)]">
            طلع من مخزن {order.sourceWarehouseName} — رجّعه عليه.
          </p>
        )}
        {/* W2b: WHERE IT IS RECEIVED — a placed store only. The warehouse it left from comes chosen; another may be picked. */}
        {warehouses && (
          <Select
            label="استلمته بمخزن"
            value={into}
            onChange={(e) => setInto(e.target.value)}
            options={[
              { value: '', label: 'اختار المخزن' },
              ...warehouses.map((w) => ({ value: w.id, label: w.id === fromSource?.id ? `${w.name} (طلع منه)` : w.name })),
            ]}
          />
        )}

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
          <Card plain padding="sm" className="space-y-2">
            <p className="text-sm font-medium text-[var(--sys-heading)]">{order.action.question}</p>
            {/*
              Two `Button`s, not a `Segmented`: the pair starts with no answer, and a second press on «نعم» puts the count
              back to the whole expected figure — a segmented bar calls its handler only on a CHANGE, so it would swallow it.
              The chosen answer wears its colour (the brand colour for yes since R19a, red no); the other stays framed.
            */}
            <div className="flex gap-2">
              <Button
                type="button"
                variant={arrived === true ? 'primary' : 'secondary'}
                aria-pressed={arrived === true}
                onClick={() => {
                  setArrived(true);
                  setReceived(order.expectedQty);
                }}
              >
                {order.action.yes}
              </Button>
              <Button
                type="button"
                variant={arrived === false ? 'danger' : 'secondary'}
                aria-pressed={arrived === false}
                onClick={() => {
                  setArrived(false);
                  setReceived(0);
                }}
              >
                {order.action.no}
              </Button>
            </div>
            {arrived === false && (
              <p className="text-note text-[var(--sys-destructive)]">
                لا يُسجَّل استلام إذن. الطلب يبقى مفتوحاً على نصفه الراجع، ويظهر في هذه القائمة حتى تصل القطع.
              </p>
            )}
          </Card>
        )}

        {/*
          «واذا اتمم واحد فهو اتمم جزءي، ما بنغلق غير كامل» — stated in the
          screen, not only in the note it writes. The clerk is about to finish
          their half and would otherwise leave believing the order is done.
        */}
        {order.completion.halves.length > 1 && (
          <ul className="text-note bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-2 space-y-1">
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
              checkbox, and nothing in the product set it — so every tick box
              on this desk drew the user agent's grey-and-white control. The
              kit's `Checkbox` (R11e, 18/11) carries the accent and the 44px
              row on a phone; each box has its own id, so a press on its words
              ticks it and no other.
            */}
            {mayChargeFee && (
              <Checkbox
                id={`returns-fee-${order.id}`}
                checked={courierFee}
                onChange={setCourierFee}
                label="احتساب أجرة إرجاع لشركة الشحن (تُؤخذ من جدول الأجور)"
              />
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
              <span className="text-note text-[var(--sys-muted-foreground)]">
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

            <div className="bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg px-2">
              <Checkbox
                id={`returns-ack-${order.id}`}
                checked={acknowledged}
                onChange={setAcknowledged}
                label="أقرّ بأنني عددت البضاعة وفحصتها. لا تدخل البضاعة للمخزون قبل هذا الإقرار."
              />
            </div>
          </>
        )}

        {!phone && actionRow}
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
