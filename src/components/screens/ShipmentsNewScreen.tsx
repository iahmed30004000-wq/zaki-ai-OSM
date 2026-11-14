'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAsk } from '@/components/ui/Confirm';
import { apiFetch, apiJson } from '@/lib/api-client';
import { ATTESTATION_AR } from '@/lib/shipment-cancel';
import { CustomerHistoryButton } from '@/components/orders/CustomerHistory';
import { OrderRef } from '@/components/orders/OrderRef';
import { goodsLines } from '@/components/orders/OrderGoods';
import { CopyValue } from '@/components/orders/CopyValue';
import { orderNumberToCopy } from '@/lib/copy-values';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { BulkBar } from '@/components/shell/BulkBar';
import { useIsPhone } from '@/hooks/useIsPhone';
import { RiAlertLine, RiArrowGoBackLine, RiCloseCircleLine, RiDownload2Line, RiLoader4Line, RiPauseCircleLine, RiTruckLine } from '@remixicon/react';
import { RejectDialog } from '@/components/screens/confirmation/ActionDialogs';
import { DelayShipmentDialog, type DelayChoice } from '@/components/ops/DelayShipmentDialog';
import { useConfirm, useTell } from '@/components/ui/Confirm';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { useLabelSize } from '@/components/labels/LabelSize';
import { BLOCKED_WAYBILLS, describeRefused, openWaybills, WaybillError } from '@/components/labels/openWaybills';
import type { DispatchSummary } from '@/lib/couriers/dispatch';
import { DispatchResult } from '@/components/ops/DispatchResult';
import { DispatchInterrupted, dispatchInChunks, type DispatchProgress } from '@/components/ops/dispatchInChunks';
import { useToast } from '@/components/ui/Toast';
import { Rows } from '@/components/ui/Rows';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useMayOpen } from '@/hooks/useMayOpen';
import { NextStepButton, MissionDone } from '@/components/ui/NextStep';
import { printLabelsStep } from '@/lib/next-step';

/**
 * /ops/shipments/new — pick a courier, filter, review each row's COD and its
 * blocking warnings, then create the shipment. Select-all skips blocked rows;
 * soft warnings need an explicit acknowledgement per order; hard blocks land
 * in the exceptions panel and never produce a shipment row.
 */

interface Block { code: string; message: string; hard: boolean; hint?: string }
interface Row {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  customer: { id: string; fullName: string; phone: string; city: string };
  previousOrders: number;
  region: { id: string; name: string } | null;
  /**
   * Where the parcel goes. ABSENT unless the server sent it — it does, only to a holder of `customers.view` — and
   * `null` is «this order has none». The two are different news; see `ShipAddress`.
   */
  address?: string | null;
  items: { productName: string; quantity: number; freeQuantity: number }[];
  cod: { subtotal: number; discount: number; deliveryFee: number; cod: number; currency: string; feeSource: string };
  blocks: Block[];
  selectable: boolean;
  hardBlocked: boolean;
  shipHoldUntil: string | null;
  /** Why the order can no longer be stood down, from the server's own guard. */
  standDownBlocked: { code: string; message: string } | null;
  shipHoldReason: string | null;
}

/** What «CSV الجاهزة للشحن» says when it is pressed under «الكل»: the file's amount and city code are the courier's. */
const PICK_COURIER_FIRST = 'اختر شركة الشحن من «شركة الشحن (للشحنة)» فوق أولاً — المبلغ ورمز المدينة بالملف من أجورها.';
/** What «CSV المحدَّدة» is under «الكل» (the owner, 3/11: «الهدف اسحب الطلبات فقط اوزع المناطق ع شركات الشحن»). */
const NO_COURIER_FILE = 'بدون شركة: ملف للتوزيع بس — بلا مبلغ ولا رمز مدينة';

/**
 * WHERE THE PARCEL GOES, IN FULL (the owner, 8/11: «اظهر العنوان بالخانات»).
 *
 * An address is a sentence, so it wraps: nothing is cut with an ellipsis, because a packer who reads half a street
 * ships to half a street. The box is capped, so a long address makes its cell taller and never the table wider, and
 * the text picks its own direction, so a street typed in Latin letters reads left to right inside the Arabic page.
 *
 * NONE IS SAID, NOT LEFT BLANK. Dispatch refuses an order with no address (`NO_ADDRESS`), and an empty cell reads as
 * «not loaded», so the order says it in the colour the unset governorate beside it uses. `undefined` is another thing —
 * the server did not send it — and is a dash: «بلا عنوان» there would tell the packer an order has none when nobody looked.
 */
function ShipAddress({ address }: { address: string | null | undefined }) {
  if (address === undefined) return <span className="text-[var(--sys-muted)]">—</span>;
  const street = address?.trim();
  if (!street) return <span className="text-[var(--sys-destructive)]">بلا عنوان</span>;
  return (
    <div dir="auto" className="max-w-xs break-words">
      {street}
    </div>
  );
}

/**
 * WHAT IS IN THE PARCEL (the owner, 14/11: «حط المنتج بين المحافظة والعنوان» — the product that belongs to the order).
 *
 * The order's own lines, one under another, worded the way every other list words them (`goodsLines`: «الاسم × الكمية»,
 * a gift beside its line). Like the address it is read at the packing bench, so nothing is cut: every line is drawn —
 * there is no «+N أخرى» here — and a long name wraps and never ends in an ellipsis, because a packer who reads half a
 * name takes the wrong product. The box is capped, so a long name makes its cell taller and never the table wider.
 * An order that came with no lines is a dash: the list is whole, this order has nothing to show.
 */
function ShipGoods({ items }: { items: Row['items'] }) {
  // The list door sends no line id and the shared wording wants one for its key: a line's place in the order is its id.
  const { shown } = goodsLines(
    items.map((line, place) => ({ id: String(place), ...line })),
    null,
    Math.max(1, items.length)
  );
  if (shown.length === 0) return <span className="text-[var(--sys-muted)]">—</span>;
  // Lines are plain blocks, not a list: the phone tests take the first `li` of the page for a card, and the table is
  // drawn before the cards.
  return (
    <div className="max-w-xs break-words">
      {shown.map((line) => (
        <div key={line.key} dir="auto">
          {line.text}
        </div>
      ))}
    </div>
  );
}

export function ShipmentsNewScreen() {
  const ask = useAsk();
  const toast = useToast();
  const mayOpen = useMayOpen();
  const confirm = useConfirm();
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [regions, setRegions] = useState<{ id: string; name: string }[]>([]);
  /** The row whose cancellation is being given a reason. */
  const [cancelling, setCancelling] = useState<Row | null>(null);
  /** The row whose delay is being chosen — one dialog, two ways out. */
  const [delaying, setDelaying] = useState<Row | null>(null);
  const [standingDown, setStandingDown] = useState<string | null>(null);
  const [filters, setFilters] = useState({ q: '', courier: '', region: '', from: '', to: '' });
  const [rows, setRows] = useState<Row[] | null>(null);
  /** How many are being held back, shown on the tab so none can seem to vanish. */
  const [heldCount, setHeldCount] = useState(0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [exceptions, setExceptions] = useState<{ orderNumber: string; reasons: string[] }[]>([]);
  /** Looking at what is ready, or at what is being held back. */
  const [view, setView] = useState<'ready' | 'held'>('ready');
  /** Whether the list is showing fewer than all of it — see the next-step button. */
  const narrowed =
    view === 'held' || Object.entries(filters).some(([key, v]) => key !== 'courier' && v !== '');
  const [holding, setHolding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** The batch the banner above is about — what «اطبع البوالص» prints. */
  const [justMade, setJustMade] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  /** The batch's courier is sent to by API — «رحّل» comes before «اطبع». */
  const [courierApi, setCourierApi] = useState(false);
  /** The batch being sent right now — by id, so an answer lands on its own batch. */
  const [dispatching, setDispatching] = useState<string | null>(null);
  /** How far the send has got — a big batch goes a few orders at a time (`dispatchInChunks`), and the button says how many. */
  const [dispatchProgress, setDispatchProgress] = useState<DispatchProgress | null>(null);
  /** What the courier answered, order by order, and for which batch. */
  const [dispatched, setDispatched] = useState<{ batchId: string; summary: DispatchSummary } | null>(null);
  const { currentUser } = useApp();
  const tell = useTell();
  const labelSize = useLabelSize();
  const mayPrint = userCan(currentUser, 'ops.labels');
  // The file is names, phones and addresses: its door asks the screen's key AND the address-book key, so the button is
  // drawn only for whoever it will answer.
  const mayExport = userCan(currentUser, 'ops.ship') && userCan(currentUser, 'customers.view');
  // The «العنوان» column is drawn for the address-book key alone, as the list door gives the street to nobody else
  // (`GET /api/ops/shipments`): the packing key does not open it, and a column the server fills for no one is not drawn.
  const mayReadAddress = userCan(currentUser, 'customers.view');
  const [exporting, setExporting] = useState(false);
  /** What the last file held and what it left out, said under the tabs until the next file. */
  const [fileNote, setFileNote] = useState<string | null>(null);

  useEffect(() => {
    apiJson<{ providers: { id: string; name: string }[]; regions: { id: string; name: string }[] }>(
      '/api/ops/references'
    )
      .then((d) => {
        setProviders(d.providers);
        setRegions(d.regions);
      })
      .catch(() => undefined);
  }, []);

  /**
   * THE ORDER STOPS, NOT ONLY THE SHIPMENT.
   *
   * Different from the postponement beside it, and the difference is the
   * whole point: postponing keeps the order confirmed and brings it back to
   * the shipment list on the day. This is for when the ORDER has to stop —
   * the confirmation is undone and it returns to the people whose job is
   * talking to customers.
   *
   * ITS POSTPONE OUTCOME IS GONE. The delay dialog used to reach this door
   * too, with `outcome: 'POSTPONE'`, and no longer does: postponing is one
   * action now and it goes to the hold door. Leaving the branch here would
   * be a path nobody can reach and nobody can check, and the next reader
   * would take it for a second way of postponing that still works.
   */
  const standDown = async (
    row: Row,
    body: { outcome: 'CANCEL'; reason: string; note: string },
    parcelInHand = false
  ) => {
    setStandingDown(row.id);
    try {
      const res = await apiFetch('/api/ops/shipments/stand-down', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: row.id, ...body, ...(parcelInHand ? { parcelInHand: true } : {}) }),
      });
      const answer = await res.json().catch(() => ({}));
      /*
       * A PACKED PARCEL (waybill printed, or on the pickup shelf): its goods
       * go back on the shelf only on this person's word that the box was
       * opened. The server names the sentence; the same press is repeated
       * with it, recorded with the name of whoever said it.
       */
      if (!res.ok && answer?.code === 'ATTESTATION_REQUIRED') {
        setStandingDown(null);
        const said = await confirm({
          title: `الطرد ${row.orderNumber} مطبوعة بوليصته`,
          body: answer.attestation ?? ATTESTATION_AR,
          confirmLabel: 'أؤكد',
          tone: 'danger',
        });
        if (said) await standDown(row, body, true);
        return;
      }
      if (!res.ok) throw new Error(answer?.errorAr || answer?.error || 'تعذّر التنفيذ');
      toast.done(`${row.orderNumber} أُلغي — وبضاعته رجعت للبيع`);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر التنفيذ');
    } finally {
      setStandingDown(null);
    }
  };

  /**
   * NOT SHIPPING TODAY.
   *
   * One action with a date on it. The date is what the two older controls
   * both lacked — the hold stored the year 2999 when nobody typed one, and
   * «للمتابعة» was a second button saying the same word as the first — and
   * the choice between them is the one the owner removed.
   */
  const delay = async (row: Row, choice: DelayChoice) => {
    setHolding(row.id);
    try {
      await apiJson('/api/ops/shipments/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: row.id, until: choice.until, reason: choice.reason }),
      });
      toast.done(
        `${row.orderNumber} مؤجَّل حتى ${choice.until.slice(0, 10)} — وبضاعته عادت للبيع`
      );
      setDelaying(null);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر التنفيذ');
    } finally {
      setHolding(null);
    }
  };

  /**
   * «CSV الجاهزة للشحن» (the owner, 3/11: «csv عند انشاء الشحنة استخرج الطلبات الجاهزة للشحن مش المؤجلة»).
   *
   * The orders of the «جاهزة للشحن» tab under the filters and the search on the screen, as the file for making the parcels
   * at the courier's portal; never one of «مؤجَّلة الشحن» unless it is ticked. The server decides what goes in and says how many it left out
   * and why, and the line under the tabs repeats it. Fetched, not linked: a refusal is said here, not saved as a file.
   */
  const exportReady = async () => {
    setFileNote(null);
    // The press is never dead: with «الكل» as the courier the button says what is missing, on the line under the tabs
    // where the file's own answer is said, and puts the cursor on the very list to pick from (the owner, 3/11: «ليش تنزيل
    // ال CSV مش شغال» — a greyed button with its reason only in a hover title reads as broken).
    // TICKED ROWS ARE THE FILE (the owner, 3/11: «خليها تنزل الي بحددو من المؤجل او جاهز»): from whichever tab is open,
    // exactly those, in a body. With nothing ticked it is the whole «جاهزة للشحن» tab under the filters, as before.
    const picked = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
    // Ticked rows go without a courier too — a sheet for sharing them out, with no money in it; the whole tab does not.
    if (!filters.courier && picked.length === 0) {
      setFileNote(PICK_COURIER_FIRST);
      document.querySelector<HTMLSelectElement>('[data-courier-pick] select')?.focus();
      return;
    }
    setExporting(true);
    try {
      let res: Response;
      if (picked.length > 0) {
        res = await apiFetch('/api/ops/shipments/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(filters.courier ? { courier: filters.courier, ids: picked } : { ids: picked }),
        });
      } else {
        const q = new URLSearchParams();
        Object.entries(filters).forEach(([k, v]) => v && q.set(k, v));
        res = await apiFetch(`/api/ops/shipments/export?${q}`);
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          errorAr?: string; error?: string; held?: number; unready?: number; blocked?: number; gone?: number;
        };
        const said = data.errorAr || data.error || 'تعذّر تجهيز الملف';
        if (res.status === 409) {
          setFileNote([said, ...leftOutParts(data.held ?? 0, data.unready ?? 0, data.blocked ?? 0, data.gone ?? 0)].join(' · '));
        }
        else toast.failed(said);
        return;
      }
      const count = Number(res.headers.get('X-Rows') ?? 0);
      const held = Number(res.headers.get('X-Left-Held') ?? 0);
      const unready = Number(res.headers.get('X-Left-Unready') ?? 0);
      const blocked = Number(res.headers.get('X-Left-Blocked') ?? 0);
      const gone = Number(res.headers.get('X-Left-Gone') ?? 0);
      const noCourier = res.headers.get('X-No-Courier') === '1';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${noCourier ? 'picked-no-courier' : picked.length > 0 ? 'picked' : 'ready'}-to-ship-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const what = noCourier
        ? `نزل الملف بدون شركة: ${count} طلب من المحدَّدة — للتوزيع بس، بلا مبلغ ولا رمز مدينة`
        : picked.length > 0 ? `نزل الملف: ${count} طلب من المحدَّدة` : `نزل الملف: ${count} طلب جاهز للشحن`;
      setFileNote([what, ...leftOutParts(held, unready, blocked, gone)].join(' · '));
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر تجهيز الملف');
    } finally {
      setExporting(false);
    }
  };

  /** Lifting a hold is the only half of it that carries no date. */
  const releaseHold = async (row: Row) => {
    setHolding(row.id);
    try {
      await apiJson('/api/ops/shipments/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: row.id, release: true }),
      });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر التنفيذ');
    } finally {
      setHolding(null);
    }
  };

  /*
   * THE LATEST QUESTION WINS (RV34).
   *
   * The search box fires a load a quarter-second after each keystroke, and a slow answer to an older question could land
   * after the newer one — the list then showed an old result beside a newer search. Each load takes a number, and only
   * the newest number may write to the screen.
   */
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    setError(null);
    const q = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && q.set(k, v));
    if (view === 'held') q.set('held', 'only');
    try {
      const data = await apiJson<{ orders: Row[]; heldCount?: number }>(`/api/ops/shipments?${q}`);
      if (mine !== loadSeq.current) return;
      setRows(data.orders);
      setHeldCount(data.heldCount ?? 0);
      setSelected({});
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [filters, view]);

  /**
   * ── A QUARTER-SECOND, AND NOT FOR SMOOTHNESS ──
   *
   * `load` is in the dependency list and `load` changes with `filters`, so
   * before the search box this effect fired on a dropdown — a few times an
   * hour. A text input fires it on every keystroke, and this particular
   * request is an expensive one: the route prices every row
   * (`resolveDeliveryFee`) and asks `shipmentBlocks` about it, several
   * queries each, for up to three hundred rows.
   *
   * ⚠️ AND EVERY RESPONSE COUNTS TOWARD A SECURITY ALERT.
   * `noteCustomersHandedOut` adds that response's distinct customers to a
   * running fifteen-minute tally per person; past five hundred it writes a
   * `CUSTOMER_BULK_VIEW` audit row and alerts everybody holding
   * `users.manage`.
   *
   * Said precisely, because the first version of this comment was not:
   * this list takes up to 300 rows, so the FIRST load already carries up
   * to 300 — one more sizeable response crosses the threshold, with or
   * without typing. The debounce turns six requests into two for a
   * five-letter search; it narrows that path, it does not close it. What
   * closes it is counting a re-read of the same list differently from a
   * new one, which is nobody's job in this file. Recorded as RV36.
   *
   * 🔧 250ms, the same figure and the same shape `OrdersScreen` uses for
   * its own search.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 250);
    return () => clearTimeout(timer);
  }, [load]);

  /*
   * And again when the person comes back. This screen builds a shipment
   * out of orders that are «ready to ship» — a list another agent is
   * changing at the same time. Reading it from twenty minutes ago is how
   * an order already in somebody else's batch gets picked a second time.
   *
   * The debounce above stays: it is about the search box, not about
   * returning to the screen.
   */
  useLiveRefresh(() => void load(), { initial: false });

  const create = async () => {
    const orderIds = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
    if (orderIds.length === 0 || !filters.courier) {
      toast.failed('اختر شركة الشحن وطلباً واحداً على الأقل');
      return;
    }
    /**
     * ASKED BEFORE, BECAUSE THERE IS NO AFTER.
     *
     * This books the selected orders with a courier, opens a batch and
     * commits their delivery fees. There is no endpoint that undoes it —
     * the domain forbids deleting a financial record, and a reversal is a
     * separate movement somebody has to write.
     *
     * Every other bulk action that changes money or state in this product
     * asks first (collect, deliver, transfer are all dialogs). This one
     * fired on a single click, and the only thing standing between a
     * mis-tap and thirty booked parcels was the person's own attention.
     *
     * The count and the courier are in the question, because «هل أنت
     * متأكّد» is a question nobody reads.
     */
    const courierName = providers.find((c) => c.id === filters.courier)?.name ?? 'شركة الشحن';
    const ok = await confirm({
      title: `شحن ${orderIds.length} طلباً مع ${courierName}؟`,
      body: 'تُحجز لدى الشركة وتُحمَّل أجورُها، ولا تراجع بعدها — الإلغاء حركةٌ منفصلة.',
      confirmLabel: 'أنشئ الشحنة',
    });
    if (!ok) return;

    setBusy(true);
    try {
      const res = await apiJson<{
        batch: { id: string; batchNumber: string };
        shipped: number;
        exceptions: { orderNumber: string; reasons: string[] }[];
        courierApi?: boolean;
      }>(
        '/api/ops/shipments',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deliveryProviderId: filters.courier,
            orderIds,
            acknowledgedOrderIds: orderIds.filter((id) => acknowledged[id]),
          }),
        }
      );
      setDone(`تم إنشاء الدفعة ${res.batch.batchNumber} بـ ${res.shipped} طلب`);
      setJustMade(res.batch.id);
      setCourierApi(res.courierApi === true);
      setExceptions(res.exceptions);
      await load();
    } catch (e) {
      /*
       * THE DOOR'S REAL REASONS, NOT ITS GENERIC LINE.
       *
       * «لا يوجد طلب صالح للشحن ضمن الاختيار» came back with the reason of each order in `exceptions` and the screen
       * kept only the sentence. They go to the same panel a partial success fills — order number and why — and the
       * list is read again, because the row that said «جاهز» was out of date or wrong.
       */
      const refused = (e as { data?: { exceptions?: unknown } } | null)?.data?.exceptions;
      if (Array.isArray(refused) && refused.length > 0) {
        setExceptions(refused as { orderNumber: string; reasons: string[] }[]);
        toast.failed('لم يُشحن أي طلب — أسباب كل طلب مكتوبة في «طلبات لم تُشحن»');
        await load();
      } else {
        toast.failed(e instanceof Error ? e.message : 'تعذر إنشاء الشحنة');
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * «اطبع البوالص» — the batch just made, printed from the banner that says it was made.
   *
   * The same call the batches screen makes (`openWaybills` by batch id, on this device's
   * paper), run inside the click so the browser lets the sheet open. The permission is
   * `ops.labels`, the door's own; the screen does not hold an arithmetic or a list of its own.
   */
  const printJustMade = async () => {
    if (!justMade) return;
    setPrinting(true);
    setError(null);
    try {
      const out = await openWaybills({ batchId: justMade, ...labelSize.dims }, 'print');
      if (!out.opened) setError(BLOCKED_WAYBILLS);
      if (out.refused.length) {
        void tell({
          title: `جُهِّزت ${out.count} بوليصة، ولم تُجهَّز ${out.refused.length}`,
          body: describeRefused(out.refused),
        });
      }
    } catch (e) {
      if (e instanceof WaybillError && e.refused.length) {
        void tell({ title: e.message, body: describeRefused(e.refused), tone: 'danger' });
      } else {
        setError(e instanceof Error ? e.message : 'تعذر الطباعة');
      }
    } finally {
      setPrinting(false);
    }
  };

  /**
   * «رحّل إلى الشركة واجلب الباركود» — the batch just made, sent from the banner.
   *
   * BEFORE THE PRINT, BECAUSE THE PRINT CARRIES WHAT IT WAS GIVEN. A waybill
   * printed before dispatch has our reference where the courier's barcode
   * goes (`courierCode` falls back to it), so the warehouse was handed a
   * label the courier cannot scan — and reached for the courier's own label,
   * which has no QR of ours. The print door now refuses such an order. The same door and the same body the batches
   * screen uses; the answer is shown per order, with the same sentences.
   */
  const dispatchJustMade = async () => {
    const id = justMade;
    if (!id) return;
    setDispatching(id);
    setDispatchProgress(null);
    try {
      // A few orders per request, with the count on the button: a hundred and sixty orders are minutes, and one request is not.
      const summary = await dispatchInChunks(id, setDispatchProgress);
      setDispatched({ batchId: id, summary });
    } catch (e) {
      if (e instanceof DispatchInterrupted) {
        // What was done is shown, the rest is listed as not sent (the banner offers «أعد ترحيل الباقي»), and the sentence says what to do.
        setDispatched({ batchId: id, summary: e.summary });
        toast.failed(e.message);
      } else {
        toast.failed(e instanceof Error ? e.message : 'تعذر الترحيل');
      }
    } finally {
      setDispatching((d) => (d === id ? null : d));
      setDispatchProgress(null);
    }
  };

  /*
   * WHAT THE BANNER OFFERS, FROM WHAT CAME BACK FOR THIS BATCH.
   * An answer for an earlier batch is not this one's. «رحّل» stays while any
   * order is still without their barcode — a retry is safe, the door skips
   * what already went — and the print waits while none has a barcode.
   */
  const shown = dispatched && dispatched.batchId === justMade ? dispatched.summary : null;
  const unsent = shown ? shown.outcomes.filter((o) => !o.ok && o.skipped !== 'ALREADY_SENT').length : 0;
  const offerSend = !!justMade && courierApi && (!shown || unsent > 0);
  const noBarcodeYet =
    !!justMade && courierApi && !(shown && shown.outcomes.some((o) => o.ok || o.skipped === 'ALREADY_SENT'));
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const phone = useIsPhone();
  const labelsStep = printLabelsStep(mayOpen);
  /**
   * HOW MANY OF THE FOLDED FILTERS ARE NARROWING THE LIST (phone).
   * A closed fold that hides a chosen province or date hides why parcels are missing; the count is on the row
   * that closes over them, so a narrowed list is never silent.
   */
  const narrowedInFold = [filters.region, filters.from, filters.to].filter(Boolean).length;

  /*
   * THE TWO WAYS ON FROM THE BANNER, drawn once and placed by the layout. The words, the doors and the order they
   * come in are the same on both: «رحّل» first, then «اطبع البوالص».
   */
  const sendLabel =
    dispatching === justMade
      ? dispatchProgress && dispatchProgress.total > 0
        ? `جارٍ الترحيل… ${dispatchProgress.done} من ${dispatchProgress.total}`
        : 'جارٍ الترحيل…'
      : shown
        ? `أعد ترحيل الباقي (${unsent})`
        : 'رحّل إلى الشركة واجلب الباركود';
  const sendNode = offerSend ? (
    phone ? (
      <Button size="md" className="w-full" onClick={dispatchJustMade} disabled={dispatching === justMade}>
        {sendLabel}
      </Button>
    ) : (
      <>
        {' — '}
        <button type="button" onClick={dispatchJustMade} disabled={dispatching === justMade} className="font-bold underline disabled:opacity-50">
          {sendLabel}
        </button>
      </>
    )
  ) : null;
  const printLabel = printing ? 'جارٍ التجهيز…' : 'اطبع البوالص';
  const printNode =
    justMade && mayPrint ? (
      /* The door refuses an order that has no barcode from its courier (it would print our reference twice). So
         while none has one, there is nothing to print, and the line above says what to press first. */
      noBarcodeYet ? null : phone ? (
        <Button size="md" variant={sendNode ? 'outline' : 'primary'} className="w-full" onClick={printJustMade} disabled={printing}>
          {printLabel}
        </Button>
      ) : (
        <>
          {' — '}
          <button type="button" onClick={printJustMade} disabled={printing} className="font-bold underline disabled:opacity-50">
            {printLabel}
          </button>
        </>
      )
    ) : labelsStep ? (
      phone ? (
        <Link href={labelsStep.href} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-current px-3 font-bold">
          {labelsStep.label}
        </Link>
      ) : (
        <>
          {' — '}
          <Link href={labelsStep.href} className="font-bold underline">
            {labelsStep.label}
          </Link>
        </>
      )
    ) : null;

  /**
   * THE WARNINGS OF ONE ORDER AND THE BOX THAT ACKNOWLEDGES THEM — one drawing, placed by the layout.
   * `boxed` is the phone's card notice: the same lines in the tone of the card, and the acknowledgement as a 44px
   * label around a 20px box (a bare native box is 13px, and a miss here leaves the order in «طلبات لم تُشحن»).
   */
  const blocksView = (r: Row, boxed: boolean) => {
    const lines = (
      <span className="block space-y-1">
        {r.blocks.map((b) => (
          <span
            key={b.code}
            className={`text-xs flex items-center gap-1 ${
              b.hard ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-warning)]'
            }`}
          >
            <RiAlertLine className="w-4 h-4" /> {b.message}
            {b.hint && <span className="text-[var(--sys-muted-foreground)]"> — {b.hint}</span>}
          </span>
        ))}
        {!r.hardBlocked && (
          <label
            className={`flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]${boxed ? ' min-h-11 gap-2' : ''}`}
          >
            <input
              type="checkbox"
              className={boxed ? 'h-5 w-5 accent-[var(--sys-primary)]' : undefined}
              checked={!!acknowledged[r.id]}
              onChange={(e) => setAcknowledged({ ...acknowledged, [r.id]: e.target.checked })}
            />
            أقرّ بالتنبيه وأتابع
          </label>
        )}
      </span>
    );
    if (!boxed) return lines;
    return (
      <div
        className={`rounded-lg border p-2.5 ${
          r.hardBlocked
            ? 'border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)]'
            : 'border-[var(--sys-warning)]/40 bg-[var(--sys-warning-soft)]/40'
        }`}
      >
        {lines}
      </div>
    );
  };

  return (
    <div className="max-w-5xl space-y-3">
      <ScreenTitle />

      {/*
        FIRST, BECAUSE IT IS THE FIRST THING A PERSON DOES.
        The courier rings about one parcel. Before this box the only way to
        it was the eye, down a list of a hundred confirmed orders — the
        filters below narrow by where and when, and neither of those is
        «the one he just named».
      */}
      {/*
        ITS OWN ROW, ABOVE THE GRID — AND NOT A FIVE-COLUMN SPAN INSIDE IT.
        The span read better in the markup and cost a Tailwind utility this
        repository uses nowhere else, which pushed the first-load stylesheet
        0.04 KB past the budget `quality-gates.test.ts` holds. The gate's own
        doctrine is to reuse what the product already has; a box on its own
        line needs no column arithmetic at all.
      */}
      <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 space-y-3">
        <SearchField
          value={filters.q}
          onChange={(v) => setFilters({ ...filters, q: v })}
        />
        <div className="grid gap-3 md:grid-cols-5">
        <div data-courier-pick>
          <Select label="شركة الشحن (للشحنة)" value={filters.courier} onChange={(v) => setFilters({ ...filters, courier: v })} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
        </div>
        {/* On a phone the province and the dates fold behind one row that says what is inside: the search and the
            courier are what the next press cannot do without. On a desk the three cells are where they have always been. */}
        {phone ? (
          <AdvancedGroup holds={`المحافظة · التاريخ${narrowedInFold > 0 ? ` (${narrowedInFold})` : ''}`}>
            <Select className="w-full" label="المحافظة" value={filters.region} onChange={(v) => setFilters({ ...filters, region: v })} options={regions.map((r) => ({ value: r.id, label: r.name }))} />
            <DateField className="min-w-0 flex-1" label="من" value={filters.from} onChange={(v) => setFilters({ ...filters, from: v })} />
            <DateField className="min-w-0 flex-1" label="إلى" value={filters.to} onChange={(v) => setFilters({ ...filters, to: v })} />
          </AdvancedGroup>
        ) : (
          <>
            <Select label="المحافظة" value={filters.region} onChange={(v) => setFilters({ ...filters, region: v })} options={regions.map((r) => ({ value: r.id, label: r.name }))} />
            <DateField label="من" value={filters.from} onChange={(v) => setFilters({ ...filters, from: v })} />
            <DateField label="إلى" value={filters.to} onChange={(v) => setFilters({ ...filters, to: v })} />
          </>
        )}
        {/* On a desk the button is the grid's last cell, where it has always been. On a phone it is in the bar. */}
        {!phone && (
        <div className="self-end">
          <button
            onClick={create}
            disabled={busy || selectedCount === 0}
            className="w-full h-11 md:h-10 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            {busy ? 'جارٍ الإنشاء…' : `إنشاء شحنة (${selectedCount})`}
          </button>
        </div>
        )}
        </div>
      </div>

      {/*
        «إنشاء شحنة» WHERE THE THUMB IS, NOT AT THE TOP OF A FORM.
        The button used to be the last cell of the filter grid. On a phone the
        grid is one column, so the button was 450px down the page and the
        orders it ships were below it: a worker ticked parcels far down the
        list and the only thing that ships them was back at the top. While
        anything is ticked the bar owns the bottom of the phone; on a desk it
        is not drawn (the button is in the filters, as it always was). The courier stays in the filters, drawn from
        the first moment — it is the choice the shipment cannot do without.
      */}
      <BulkBar show={phone && selectedCount > 0}>
        <span className="me-auto text-xs font-semibold text-[var(--sys-primary)]">
          محدَّد: {selectedCount} طلب
        </span>
        {!filters.courier && (
          <span className="w-full text-xs text-[var(--sys-muted-foreground)]">اختر شركة الشحن من الأعلى أولاً.</span>
        )}
        <button
          onClick={create}
          disabled={busy || selectedCount === 0}
          className="flex-1 md:flex-none h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'جارٍ الإنشاء…' : `إنشاء شحنة (${selectedCount})`}
        </button>
      </BulkBar>

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}
      {done && (
        <p className="text-sm text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-success)]/30 rounded-lg p-3">
          {done}
          {/*
            THE LABELS ARE PRINTED FROM HERE, AT THE PLACE THE EYE IS.
            «تم إنشاء الدفعة X» ended there and printing lived on the batches
            screen, so the person went back to the menu and looked for it.
            Whoever holds `ops.labels` prints the batch just made from this
            line; whoever does not is still pointed at the screen that has it.
          */}
          {/* The next step is a sentence's underlined word on a desk, as it has always been. On a phone it is a button of
              its own under the sentence: an underlined word 20px tall inside a green line is not the main action. */}
          {phone ? (
            (sendNode || printNode) && <span className="mt-2 flex flex-col gap-2">{sendNode}{printNode}</span>
          ) : (
            <>
              {sendNode}
              {printNode}
            </>
          )}
        </p>
      )}

      {offerSend && !shown && (
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          رحّل أولاً، ثم اطبع: تخرج البوليصة وعليها باركود الشركة بجانب رمزنا. طلب بلا باركود الشركة لا يُطبع.
        </p>
      )}
      {shown && (
        <DispatchResult
          summary={shown}
          savedNote="الباركودات محفوظة على الطلبات — اطبع الآن فتظهر على البوليصة بجانب رمزنا."
        />
      )}

      {exceptions.length > 0 && (
        <section className="bg-[var(--sys-card)] border border-[var(--sys-destructive-border)] rounded-lg p-4">
          <h3 className="text-sm font-bold text-[var(--sys-destructive)] mb-2">طلبات لم تُشحن ({exceptions.length})</h3>
          <ul className="text-xs text-[var(--sys-foreground)] space-y-1">
            {exceptions.map((e) => (
              <li key={e.orderNumber}>
                {/* The door sends the number without the order's id, so not `OrderRef` — only its copy button. */}
                <span className="inline-flex items-center gap-1">
                  <span dir="ltr">{e.orderNumber}</span>
                  <CopyValue text={orderNumberToCopy(e.orderNumber)} noun="رقم الطلب" shown={e.orderNumber} />
                </span>{' '}
                — {e.reasons.join(' · ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!rows ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : (
        <>
        <div className="flex gap-1.5 mb-2">
        {/*
          «مؤجَّلة» ALONE WAS THE SAME WORD AS A SCREEN IN THE MENU.
          «الطلبات المؤجلة» there is a customer who asked to be called
          later; this is a parcel held back from a van. Somebody who
          postponed a shipment went looking in the other one, did not find
          it, and reported the postpone as broken — which it was not.
        */}
        {([['ready', 'جاهزة للشحن'], ['held', 'مؤجَّلة الشحن']] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setView(k)}
            className={`min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
              view === k
                ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] border-[var(--sys-primary)]'
                : 'bg-[var(--sys-card)] text-[var(--sys-foreground)] border-[var(--sys-border)] hover:border-[var(--sys-primary)]/40'
            }`}
          >
            {label}
            {k === 'held' && heldCount > 0 && (
              <span
                title="كل المؤجَّل بالمتجر — مش حسب البحث"
                className={`ms-1.5 rounded-full px-1.5 py-0.5 text-xs font-bold tabular-nums ${
                  view === k
                    ? 'bg-[var(--sys-primary-foreground)]/20'
                    : 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]'
                }`}
              >
                {heldCount}
              </span>
            )}
          </button>
        ))}
        {/* The ticked rows of either tab, or — nothing ticked — the whole ready tab, which never carries a postponed order. */}
        {mayExport && (
          <button
            type="button"
            onClick={() => void exportReady()}
            disabled={exporting}
            title={
              !filters.courier
                ? selectedCount > 0
                  ? NO_COURIER_FILE
                  : 'اختر شركة الشحن أولاً — المبلغ ورمز المدينة بالملف من أجورها'
                : selectedCount > 0
                  ? 'الطلبات المحدَّدة بس بملف CSV — جاهزة أو مؤجَّلة'
                  : 'الطلبات الجاهزة للشحن بالفلاتر الحالية بملف CSV — بلا المؤجَّلة. حدّد طلبات لتنزّلها هي بس'
            }
            className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5 disabled:opacity-40 ms-auto"
          >
            {exporting ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiDownload2Line className="w-4 h-4" />}
            {selectedCount > 0
              ? `CSV المحدَّدة (${selectedCount})${filters.courier ? '' : ' · للتوزيع بلا مبلغ'}`
              : 'CSV الجاهزة للشحن'}
          </button>
        )}
      </div>
      {fileNote && (
        <p role="status" className="text-xs text-[var(--sys-muted-foreground)]">
          {fileNote}
        </p>
      )}
      <div className={phone ? undefined : 'bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden'}>
          {/* The picking list: eight columns, read on a phone at the
              packing bench. `selection` puts the checkbox where a thumb is
              — in the card's heading — instead of in a first column
              somebody has to aim at. */}
          <Rows
            rows={rows}
            keyOf={(r) => r.id}
            alert={(r) => r.hardBlocked}
            /*
              THE WARNINGS ARE READ BEFORE THE CARD, NOT BESIDE ITS FIELDS.
              In the table they are a cell. On a card a cell is a label and a value on one line, so the warnings, the
              box that says «I have read them» and the reason a parcel cannot be shipped at all were squeezed into
              the left half of a «تنبيهات» line — a 13px box and a 16px label for the press that decides whether the
              order ships. Here they are one full-width box at the top, in the tone of the card.
            */
            notice={phone ? (r) => (r.blocks.length > 0 ? blocksView(r, true) : null) : undefined}
            selection={{
              // A hard-blocked order has no checkbox rather than one that
              // refuses: a control that cannot work is worse than none.
              canSelect: (r) => !r.hardBlocked,
              isSelected: (r) => !!selected[r.id],
              onToggle: (r, next) => setSelected({ ...selected, [r.id]: next }),
              onToggleAll: (next) => {
                const all: Record<string, boolean> = {};
                // Select-all skips blocked rows by design.
                for (const row of rows) if (row.selectable) all[row.id] = next;
                setSelected(all);
              },
            }}
            columns={[
              {
                key: 'order',
                label: 'الطلب',
                primary: true,
                render: (r) => (
                  <OrderRef id={r.id} number={r.orderNumber} className="font-medium text-[var(--sys-heading)]" />
                ),
              },
              {
                key: 'customer',
                label: 'العميل',
                primary: true,
                render: (r) => (
                  <span className="flex items-center gap-2">
                    {r.customer.fullName}
                    <CustomerHistoryButton
                      customerId={r.customer.id}
                      orderId={r.id}
                      previousOrders={r.previousOrders}
                    />
                  </span>
                ),
              },
              {
                key: 'region',
                label: 'المحافظة',
                // A governorate is a row of the fee table. The city the customer typed is NOT one: it used to be printed
                // under this heading when the order had none, and read as settled while the fee could not be priced.
                render: (r) =>
                  r.region?.name ?? (
                    <span>
                      <span className="text-[var(--sys-destructive)]">لم تُحدَّد</span>
                      {r.customer.city?.trim() && (
                        <span className="text-xs text-[var(--sys-muted-foreground)]">
                          {' '}
                          · المكتوب: <span dir="auto">{r.customer.city.trim()}</span>
                        </span>
                      )}
                    </span>
                  ),
              },
              // WHAT IS IN IT, between the governorate and the address (the owner, 14/11). Whoever opens this screen sees it: the
              // order's lines are already in the list's payload and no extra key is needed to read what is being shipped. `wide`:
              // a product name is a sentence, so on a card its label sits above it and it takes the card's full width.
              {
                key: 'goods',
                label: 'المنتج',
                wide: true,
                render: (r) => <ShipGoods items={r.items} />,
              },
              // WHERE IT GOES, after the product. Only for the address-book key (`mayReadAddress`). `wide`:
              // an address is a sentence, so on a card its label sits above it and it takes the card's full width.
              ...(mayReadAddress
                ? [
                    {
                      key: 'address',
                      label: 'العنوان',
                      wide: true,
                      render: (r: Row) => <ShipAddress address={r.address} />,
                    },
                  ]
                : []),
              {
                key: 'cod',
                label: 'تفصيل التحصيل',
                render: (r) =>
                  // On a card the figure the courier collects comes first, and the sum it came from is the small
                  // line under it. The arithmetic itself is the server's and is the same in both.
                  phone ? (
                    <span className="block" dir="ltr">
                      <strong className="tabular-nums">
                        <Money value={r.cod.cod} currency={r.cod.currency} />
                      </strong>
                      {r.cod.feeSource === 'NONE' && (
                        <span className="text-[var(--sys-destructive)]"> (بلا أجرة)</span>
                      )}
                      <span className="block text-[var(--sys-muted)]">
                        {r.cod.subtotal} − {r.cod.discount} + {r.cod.deliveryFee}
                      </span>
                    </span>
                  ) : (
                    <span className="text-xs" dir="ltr">
                      {r.cod.subtotal} − {r.cod.discount} + {r.cod.deliveryFee} ={' '}
                      <strong className="tabular-nums">
                        <Money value={r.cod.cod} currency={r.cod.currency} />
                      </strong>
                      {r.cod.feeSource === 'NONE' && (
                        <span className="text-[var(--sys-destructive)]"> (بلا أجرة)</span>
                      )}
                    </span>
                  ),
              },
              {
                key: 'blocks',
                label: 'تنبيهات',
                // The card carries them in its notice (above); the table has this cell.
                hideOnPhone: phone,
                render: (r) =>
                  r.blocks.length === 0 ? (
                    <span className="text-xs text-[var(--sys-success)]">جاهز</span>
                  ) : (
                    blocksView(r, false)
                  ),
              },
            ]}
            actions={(r) => {
              /*
                ONE CONTROL FOR «NOT TODAY».
                There used to be two, «أجّل» and «للمتابعة», and both read
                as postponing. The first asked for a reason and never a
                date — a missing date stored the year 2999, so the order
                left the shipment list and nothing brought it back. The
                choice between keeping the goods reserved and letting them
                go is real, but it belongs in a sentence at the moment of
                choosing, not in two button labels to be decoded first.
              */
              const first =
                view === 'held' ? (
                  <button
                    type="button"
                    onClick={() => void releaseHold(r)}
                    disabled={holding === r.id}
                    title="أعِده إلى قائمة الشحن"
                    className="min-h-11 md:min-h-0 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-[var(--sys-border)] text-[var(--sys-success)] transition-colors hover:border-[var(--sys-success)] disabled:opacity-50"
                  >
                    {holding === r.id ? (
                      <RiLoader4Line className="w-4 h-4 animate-spin" />
                    ) : (
                      <RiArrowGoBackLine className="icon-mirror w-4 h-4" />
                    )}
                    أرجِعه
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDelaying(r)}
                    disabled={holding === r.id}
                    title="لن يُشحن اليوم — تختار موعداً، وتعود بضاعتُه للبيع حتى ذلك الموعد"
                    className="min-h-11 md:min-h-0 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] transition-colors hover:border-[var(--sys-warning)] hover:text-[var(--sys-warning)] disabled:opacity-50"
                  >
                    {holding === r.id ? (
                      <RiLoader4Line className="w-4 h-4 animate-spin" />
                    ) : (
                      <RiPauseCircleLine className="w-4 h-4" />
                    )}
                    أجّل
                  </button>
                );
              /*
                THE REASON IS READ IN FULL ON A CARD.
                Ten rem and an ellipsis is a tooltip's job, and a phone has no tooltip: the sentence the packer needs
                («ينتظر ردّ الزبون…») was cut at its third word. On a desk it stays one line with the full text on hover.
              */
              const reason = r.shipHoldReason ? (
                <span
                  className={
                    phone
                      ? 'block text-xs text-[var(--sys-muted)] mt-0.5'
                      : 'block text-xs text-[var(--sys-muted)] mt-0.5 max-w-[10rem] truncate'
                  }
                  title={r.shipHoldReason}
                >
                  {r.shipHoldReason}
                </span>
              ) : null;
              /* It is over. The reason comes from the same structured list
                  every other cancellation uses — one with no reason is one
                  nothing can be learned from. */
              const cancel =
                view !== 'held' ? (
                  <button
                    type="button"
                    onClick={() => setCancelling(r)}
                    disabled={standingDown === r.id || !!r.standDownBlocked}
                    /* THE VERDICT BELONGS TO THIS CONTROL NOW.
                       It was spent disabling half of the postpone dialog,
                       and that half is gone — but the rule it carries was
                       always about CANCELLING: `cancelVerdict` is what the
                       stand-down door runs. Since M6 a printed waybill no
                       longer blocks it (the door asks for the person's word
                       that the box was opened); only a parcel the courier
                       has taken does. */
                    title={r.standDownBlocked?.message ?? 'ألغِ الطلب — تعود بضاعتُه للبيع'}
                    className={`min-h-11 md:min-h-0 ${phone ? 'justify-center' : 'ms-1'} inline-flex items-center gap-1 rounded-md border border-[var(--sys-border)] px-2 py-1 text-xs text-[var(--sys-muted-foreground)] transition-colors hover:border-[var(--sys-destructive-border)] hover:text-[var(--sys-destructive)] disabled:opacity-50`}
                  >
                    <RiCloseCircleLine className="w-4 h-4" aria-hidden />
                    ألغِ
                  </button>
                ) : null;
              // A phone: the two presses side by side and the same width, 8px apart (they were 4px apart in a
              // no-wrap line, and one of them cancels an order); the reason under both. A desk: the line it always was.
              return phone ? (
                <span className="block w-full">
                  <span className={cancel ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-1'}>
                    {first}
                    {cancel}
                  </span>
                  {reason}
                </span>
              ) : (
                <span className="whitespace-nowrap">
                  {first}
                  {reason}
                  {cancel}
                </span>
              );
            }}
            empty={
              narrowed ? (
                <EmptyState
                  icon={RiTruckLine}
                  title="لا طلبات جاهزة للشحن بهذه الفلاتر"
                  why="الطلب يصل هنا بعد تأكيده وتجهيزه. إن كنت تنتظر طلباً، فراجع الفلاتر أعلاه أو شاشةَ التجهيز."
                />
              ) : (
                <MissionDone why="لا طلبات جاهزة للشحن الآن: كل ما تأكّد وتجهّز صار دفعةً أو شُحن." />
              )
            }
          />
        </div>

        {/* The road goes on from here: «دفعات الشحن». Only when this list is
            not narrowed — a clerk who has filtered down to three rows has not
            finished the errand, and a «next» button over a filtered list says
            the opposite. */}
        {!narrowed && <NextStepButton />}
        </>
      )}

      {/*
        THE SAME REASON DIALOG THE CONFIRMATION TEAM USES.
        Not a second one written here: a cancellation's reason is read by the
        report that says why orders are lost, and two pickers offering two
        lists is how that report comes to compare things that were never the
        same question.
      */}
      {delaying && (
        <DelayShipmentDialog
          orderNumber={delaying.orderNumber}
          busy={holding === delaying.id}
          onClose={() => setDelaying(null)}
          onChoose={(choice) => void delay(delaying, choice)}
        />
      )}

      <RejectDialog
        open={!!cancelling}
        orderNumber={cancelling?.orderNumber ?? ''}
        busy={standingDown === cancelling?.id}
        onClose={() => setCancelling(null)}
        onSubmit={({ rejectionReason, note }) => {
          const row = cancelling;
          setCancelling(null);
          if (row) void standDown(row, { outcome: 'CANCEL', reason: rejectionReason, note });
        }}
      />
    </div>
  );
}

/** What the file left out and why, in the words the line under the tabs says them. */
function leftOutParts(held: number, unready: number, blocked: number, gone = 0): string[] {
  return [
    ...(held > 0 ? [`${held} ${held === 1 ? 'مؤجّل' : 'مؤجّلين'} برّا الملف`] : []),
    ...(unready > 0 ? [`${unready} غير محجوز برّا الملف`] : []),
    ...(blocked > 0 ? [`${blocked} بلا محافظة أو أجرة توصيل برّا الملف`] : []),
    ...(gone > 0 ? [`${gone} طلع من القائمة من وقت ما تحدّد (انشحن أو انلغى)`] : []),
  ];
}

function Select({
  label,
  value,
  onChange,
  options,
  className = 'block',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <label className={className}>
      <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm"
      >
        <option value="">الكل</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The one control that is not a filter but a question: «where is this
 * parcel». It names what it matches, because a search box that says
 * «بحث» leaves the person guessing whether the phone will work.
 */
function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">
        بحث
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="رقم الطلب · اسم الزبون · رقم التلفون · رقم التتبّع · المدينة"
        className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm"
      />
    </label>
  );
}

function DateField({
  label,
  value,
  onChange,
  className = 'block',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <label className={className}>
      <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        dir="ltr"
        className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm"
      />
    </label>
  );
}
