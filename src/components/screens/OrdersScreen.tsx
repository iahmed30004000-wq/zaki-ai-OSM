'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SavedViews } from '@/components/ui/SavedViews';
import { EMPTY_ORDER_FILTERS, orderFiltersFromQuery, orderFiltersToQuery } from '@/lib/order-filters';
import { DismissButton } from '@/components/ui/DismissButton';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { DateRange } from '@/components/ui/DateRange';
import { BulkBar } from '@/components/shell/BulkBar';
import { useIsPhone } from '@/hooks/useIsPhone';
import { LabelSizePicker, useLabelSize } from '@/components/labels/LabelSize';
import { BLOCKED_WAYBILLS, describeRefused, openWaybills, WaybillError } from '@/components/labels/openWaybills';
import { useTell } from '@/components/ui/Confirm';
import { ScanButton } from '@/components/scan/ScanButton';
import { userCan } from '@/lib/can';
import { useCreateIntent } from '@/hooks/useCreateIntent';
import { useRegions } from '@/hooks/useRegions';
import { useProducts } from '@/hooks/useProducts';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { OrderStateBadge } from '@/components/orders/OrderStateBadge';
import { CustomerHistoryButton } from '@/components/orders/CustomerHistory';
import { ContactButtons } from '@/components/orders/ContactButtons';
import { ProductThumb } from '@/components/ui/ProductThumb';
import { CreateOrderModal } from '@/components/orders/CreateOrderModal';
import { AiOrderModal } from '@/components/orders/AiOrderModal';
import { OrderDetailModal } from '@/components/orders/OrderDetailModal';
import { useApp } from '@/context/AppContext';
import { apiFetch } from '@/lib/api-client';
import { FILTERABLE_STATES, STATE_LABEL_AR } from '@/lib/order-state';
/*
 * «مغلق» sits beside the core states in the dropdown, though it is a zone
 * with both stages finished rather than a state — `ordersWhere` knows the
 * value and renders it as the `closingStages` query. One list, so the
 * dropdown, the URL validation and the API accept exactly the same values.
 */
const STATUS_FILTER_OPTIONS: readonly string[] = [...FILTERABLE_STATES, 'CLOSED'];
const STATUS_FILTER_LABELS: Record<string, string> = { ...STATE_LABEL_AR, CLOSED: 'مغلق' };
import { RiAddCircleLine, RiArrowGoBackLine, RiCloseLine, RiDownload2Line, RiEBike2Line, RiMagicLine, RiPrinterLine, RiSearchLine, RiTimerLine, RiTruckLine, RiUploadCloud2Line } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { arDateTime } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';
import { ImportOrdersDialog } from '@/components/orders/ImportOrdersDialog';
import { MigrateOrdersDialog } from '@/components/orders/MigrateOrdersDialog';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { Pager } from '@/components/ui/Pager';

export function OrdersScreen() {
  const { t, currentUser, locale } = useApp();
  const ar = locale === 'ar';
  const [orders, setOrders] = useState<any[]>([]);
  const [pagination, setPagination] = useState({ total: 0, page: 1, limit: 25, totalPages: 1 });
  const [loading, setLoading] = useState(true);

  // Filter state.
  // What is typed, and what has actually been searched for. They used to be
  // one value, so every keystroke sent a request.
  const [searchInput, setSearchInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [search, setSearch] = useState('');
  /*
    * TWO LINKS IN THE PRODUCT ALREADY POINT HERE WITH A FILTER ON THEM.
    *
    * The dashboard's «الإيراد المسلَّم» card, whose own subtitle counts
    * «N طلب موصّل», links to `/orders?state=DELIVERED`; and every order
    * number on تنبيهات الخصم links to `/orders?highlight=<id>`. Both
    * navigated, the address bar showed the filter, and this screen read
    * nothing from the URL — so a person asking for the delivered orders
    * landed on all of them, and a person clicking one order number landed
    * on the unfiltered list to look for it by hand.
    *
    * READ ONCE, at the start. The filters are not written back to the URL:
    * that would be saved views, which is a feature and not a repair.
    */
  const asked = useSearchParams();
  const askedState = asked.get('state');
  const [status, setStatus] = useState(
    // A URL is typed by anyone. An unknown state would reach the API and
    // come back 400 «حالة غير معروفة» — a filter nobody chose, refusing
    // to load the screen.
    askedState && STATUS_FILTER_OPTIONS.includes(askedState) ? askedState : 'all'
  );
  /*
   * AND TWO MORE FILTERS ARRIVE BY LINK NOW.
   *
   * The palette (Ctrl+K) answers «مؤجل» and «متأخر» and a product's name
   * with a COUNT, and every count is pressable: pressing it has to land on
   * the list whose length is the number that was just printed. `state` was
   * already read; «متأخرة» and «المنتج» were not, so two of the three
   * counts would have landed on the unfiltered list — the very defect the
   * note above records being fixed for `state`.
   *
   * `late=1` and not `lateDays=10`: the screen owns the number of days (it
   * is 10 in three places in this file), and a URL that could name its own
   * threshold would be a second rule for «متأخرة».
   */
  const [productId, setProductId] = useState(asked.get('productId') ?? 'all');
  const [source, setSource] = useState('all');
  const [courierId, setCourierId] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [lateOnly, setLateOnly] = useState(asked.get('late') === '1');
  const [regionId, setRegionId] = useState('all');
  // The governorates of the selected country — the same list the order forms use.
  const { regions } = useRegions();
  /** Show everything the filter matches, not just this page. */
  const [showAll, setShowAll] = useState(false);
  const [sources, setSources] = useState<{ name: string; count: number }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Metadata dropdowns
  const { products } = useProducts();
  const [couriers, setCouriers] = useState<any[]>([]);
  // The store's own currency, sent with the list — never assumed.
  const [currency, setCurrency] = useState({ code: '', minorUnit: 2 });
  /*
   * The country's calling code, sent with the list for the same reason.
   * The rows carry a local number and `wa.me` takes full international
   * digits only — a link built in the browser from `079…` opens a chat
   * with a number that does not exist. The country is known on the server.
   */
  const [dialCode, setDialCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ref mirror of pagination for polling without re-subscribing the interval
  const paginationRef = useRef({ page: 1 });
  useEffect(() => { paginationRef.current = pagination; }, [pagination]);
  // ref mirror of loadOrders so the 30s polling interval always calls the
  // latest closure (current filters) without re-subscribing the interval
  const loadOrdersRef = useRef<(page?: number) => Promise<void>>(async () => {});
  // Monotonic request counter — stale (out-of-order) responses are discarded
  // so an older poll can never overwrite a newer result
  const loadOrdersSeq = useRef(0);

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(asked.get('highlight'));
  const router = useRouter();
  const highlight = asked.get('highlight');
  /*
   * A LINK TO AN ORDER, FOLLOWED WHILE THIS SCREEN IS ALREADY OPEN.
   *
   * `/orders/<id>` lands here as `?highlight=<id>`, and the state above reads
   * that ONCE, at mount — right for a page load and wrong for the link that
   * matters most: «افتح الطلب» on the toast after making an order, pressed
   * on THIS screen. Next keeps the page mounted when only the query changes,
   * so nothing re-read it and the button did nothing at all.
   */
  useEffect(() => {
    if (highlight) setSelectedOrderId(highlight);
  }, [highlight]);
  /*
   * AND CLOSING IT CLEARS THE ADDRESS.
   *
   * The URL says what is open. Left behind, a refresh reopened a panel nobody
   * asked for, and a second link to the SAME order changed nothing — the
   * address already read what it was being asked to become, so the effect
   * above never fired. Filters read from the URL are read once and not
   * written back, and this does not change that: only the order is cleared.
   */
  const closeOrder = () => {
    setSelectedOrderId(null);
    if (highlight) router.replace('/orders', { scroll: false });
  };

  const loadMetadata = async () => {
    try {
      // The catalogue is no longer fetched here: `useProducts` owns it, so
      // the screen has one product list rather than a private copy that
      // could ask the route for a different slice of it.
      /*
       * `/api/moderators` used to be fetched here for a «كل المودريتورز»
       * dropdown. That filter was removed with the eleven-column table on
       * 2026-09-21 — the moderator's name moved into the row itself — and
       * the request stayed behind, asked on every page load, for a list
       * nothing rendered.
       */
      const [cRes, sRes] = await Promise.all([
        apiFetch('/api/delivery-providers'),
        apiFetch('/api/orders/sources'),
      ]);
      if (cRes.ok) {
        const cData = await cRes.json();
        setCouriers(cData.providers ?? cData.deliveryProviders ?? []);
      }
      if (sRes.ok) {
        const sData = await sRes.json();
        setSources(sData.sources ?? []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const loadOrders = useCallback(async (pageToLoad = 1) => {
    const seq = ++loadOrdersSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: pageToLoad.toString(),
        limit: '25',
        q: search,
        status,
        productId,
        source,
      });
      if (courierId !== 'all') params.set('courierId', courierId);
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      if (lateOnly) params.set('lateDays', '10');
      if (regionId !== 'all') params.set('regionId', regionId);
      if (showAll) params.set('limit', '500');

      const res = await apiFetch(`/api/orders?${params.toString()}`);
      // Discard stale response — a newer request (filter change / poll) started
      // while this one was in flight
      if (seq !== loadOrdersSeq.current) return;
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders || []);
        // A tick on a row that is no longer listed means nothing.
        setSelected(new Set());
        if (data.currency) setCurrency(data.currency);
        setDialCode(data.dialCode ?? null);
        setPagination(data.pagination || { total: 0, page: 1, limit: 25, totalPages: 1 });
      } else {
        // Show a visible error instead of silently keeping stale data
        // (401 is handled by apiFetch redirect)
        const data = await res.json().catch(() => ({}));
        setError(data.errorAr || data.error || `HTTP ${res.status}`);
      }
    } catch (e: any) {
      if (seq !== loadOrdersSeq.current) return;
      console.error('Failed to load orders:', e);
      setError(e?.message || 'فشل تحميل الطلبات');
    } finally {
      // Only the latest request may clear the shared loading flag
      if (seq === loadOrdersSeq.current) setLoading(false);
    }
  }, [search, status, productId, source, courierId, regionId, fromDate, toDate, lateOnly, showAll]);

  // Keep the ref in sync each render (after loadOrders exists)
  useEffect(() => { loadOrdersRef.current = loadOrders; }, [loadOrders]);

  useEffect(() => {
    loadMetadata();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadOrders(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [loadOrders]);

  /*
   * Light polling, and a refresh the moment the person comes back —
   * «claims by others appear without a manual refresh». The twelve lines
   * that did it here were a copy of the dashboard's twelve, and the
   * WhatsApp inbox had a third; they are one hook now, which also
   * catches coming back to the WINDOW. Alt-tab fires `focus` and not
   * `visibilitychange`, so the old copy missed most of a working day on
   * a desk.
   *
   * ⚠️ It reloads the page the person is ON, not page one — the refresh
   * is meant to keep what they are reading true, not to move them.
   */
  useLiveRefresh(() => loadOrdersRef.current(paginationRef.current.page), { everyMs: 30_000 });

  /** Run the typed search. Nothing goes to the server until this. */
  const runSearch = () => setSearch(searchInput.trim());

  const activeFilters =
    (search ? 1 : 0) + (status !== 'all' ? 1 : 0) + (source !== 'all' ? 1 : 0) +
    (productId !== 'all' ? 1 : 0) + (courierId !== 'all' ? 1 : 0) +
    (fromDate ? 1 : 0) + (toDate ? 1 : 0) + (lateOnly ? 1 : 0) + (regionId !== 'all' ? 1 : 0);

  /**
   * THE FILTERS AS THEY ARE NOW — and this string IS the saved view.
   *
   * `orderFiltersToQuery` lives beside the builder that reads it, so the
   * two halves of the grammar cannot drift. A filter added to this screen
   * and not to that interface fails to compile, which is the point.
   */
  const filterQuery = orderFiltersToQuery({
    q: search,
    status,
    productId,
    source,
    courierId,
    regionId,
    from: fromDate,
    to: toDate,
    lateDays: lateOnly ? '10' : '',
  });

  /**
   * RECALLING A VIEW REPLACES THE FILTERS — it does not add to them.
   *
   * `orderFiltersFromQuery` starts from `EMPTY_ORDER_FILTERS`, so «المتأخرة
   * — أرامكس» shows exactly that and not that plus whatever was already
   * set. And a stored state is checked the same way a URL's is: a view
   * saved before a state was renamed would otherwise reach the API and come
   * back 400 «حالة غير معروفة» — a filter nobody chose, refusing to load
   * the screen. `localStorage` is as typeable as an address bar.
   */
  const applyFilters = (query: string) => {
    const v = orderFiltersFromQuery(query);
    setSearchInput(v.q);
    setSearch(v.q);
    // The check is against the shared floor — FILTERABLE_STATES — with the
    // one derived state the product added on top spelled at its use: a view
    // saved with «مغلق» loads; anything the floor does not know is dropped
    // to the empty view, never handed to an API that will refuse it.
    setStatus(
      v.status === 'CLOSED' || (FILTERABLE_STATES as readonly string[]).includes(v.status)
        ? v.status
        : EMPTY_ORDER_FILTERS.status
    );
    setSource(v.source);
    setProductId(v.productId);
    setCourierId(v.courierId);
    setFromDate(v.from);
    setToDate(v.to);
    setLateOnly(v.lateDays !== '');
    setRegionId(v.regionId);
    setShowAll(false);
    setSelected(new Set());
  };

  /*
   * «إعادة تعيين» is the empty view, and saying so is what keeps the two
   * from disagreeing: this was thirteen setters repeating the same list of
   * defaults, and adding a filter meant remembering to clear it HERE as
   * well as everywhere else. One list, in `EMPTY_ORDER_FILTERS`.
   */
  const resetFilters = () => applyFilters('');

  /** Selection is per page: it clears whenever the rows underneath change. */
  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const firstOnPage = orders.length ? (pagination.page - 1) * pagination.limit + 1 : 0;
  const lastOnPage = (pagination.page - 1) * pagination.limit + orders.length;
  const allOnPageSelected = orders.length > 0 && orders.every((o) => selected.has(o.id));
  const toggleAll = () =>
    setSelected(allOnPageSelected ? new Set() : new Set(orders.map((o) => o.id)));

  /** Waybills for the ticked rows, on whatever paper this device prints on.
   *  The size used to be hard-coded here, so the same order came out
   *  thermal-sized from this screen and A4-sized from the labels screen. */
  const labelSize = useLabelSize();
  // The bar on the bottom edge of a phone is a different set of controls from the desk's (see useIsPhone).
  const phone = useIsPhone();
  const tell = useTell();
  const [printing, setPrinting] = useState(false);
  /*
   * THE LAST BATCH THAT FINISHED CLEANLY — for the picture, and for nothing
   * else. DISPLAY ONLY: nothing reads this back, no request depends on it,
   * and the print below runs exactly as it did before it existed. `serial`
   * counts up per batch so the moment can tell a second batch from a
   * re-render; whether the batch was big enough to earn the picture is the
   * moment's own rule (`MOMENT_MIN` in BulkDoneMoment), not this screen's.
   */
  const [batchDone, setBatchDone] = useState<{ serial: number; count: number } | null>(null);
  const canPrint = userCan(currentUser, 'ops.labels');
  const canPrintAny = userCan(currentUser, 'ops.labels_any');
  /**
   * ── EVERY BUTTON HERE ASKS WHAT ITS OWN DOOR ASKS ──
   *
   * Printing has been gated by `ops.labels` for a while; the other four
   * were drawn for anybody who could open the screen, and only the server
   * refused — so an agent saw «تصدير CSV» and «استيراد طلبات», pressed
   * them, and got an error in a language that is not hers. A control that
   * is visible and refuses is worse than one that is not there: it reads
   * as a broken system rather than as a boundary.
   *
   * These are UX only. The doors themselves still decide — `reports.export`
   * on the export route, `orders.create` and the new `orders.import` on
   * `POST /api/orders` — and that is the order of trust, not this file.
   */
  const canExport = userCan(currentUser, 'reports.export');
  const canCreate = userCan(currentUser, 'orders.create');
  // BOTH keys, as the door asks: `GET` and `POST /api/orders/import` and every row it sends through `POST /api/orders`
  // want `orders.create` besides. A grant of the first without the second opened a dialog that refused every row (RV98).
  const canImport = userCan(currentUser, 'orders.import') && userCan(currentUser, 'orders.create');
  // The migration door writes confirmed, shipped orders with a past date — the owner's, as the door itself insists.
  const canMigrate = canImport && userCan(currentUser, 'orders.migrate');
  /*
   * «+ أنشئ» IN CTRL+K ARRIVES AS `?new=…` AND OPENS THE SAME THREE FORMS THE THREE BUTTONS IN THE HEADER OPEN — for whoever those
   * buttons are drawn for, and nobody else: a handler is passed only where its button is.
   */
  useCreateIntent({
    order: canCreate ? () => setCreateModalOpen(true) : undefined,
    'ai-order': canCreate ? () => setAiModalOpen(true) : undefined,
    'import-orders': canImport ? () => setImporting(true) : undefined,
  });
  /**
   * Only confirmed orders with a courier get a waybill — printing seals an
   * order. The ones that were ticked and cannot be printed are named, not
   * silently left out of the stack of paper.
   */
  const handlePrintLabels = async (mode: 'print' | 'pdf' = 'print', only?: string[]) => {
    /**
     * `only` is one row's waybill, from the row itself.
     *
     * Printing lived ONLY in the bulk bar, and the bulk bar appears only
     * once something is ticked — so on a screen with nothing selected
     * there was no print anywhere, which is «الطباعة اختفت». And the
     * common act at a packing bench is one parcel, one label: reaching it
     * through a checkbox meant for batches is a step for nothing.
     */
    const ids = only ?? [...selected];
    if (ids.length === 0) return;
    setPrinting(true);
    setError(null);
    try {
      const out = await openWaybills({ orderIds: ids, ...labelSize.dims }, mode);
      /*
       * The finished-batch moment, after the waybills came back and only
       * when every one of them did. Not for «PDF»: saving a file marks no
       * order printed, so nothing was finished. Not when some were refused:
       * the dialog below is the message then, and a celebration beside a
       * list of refusals says two opposite things at once. And not when the
       * browser blocked the window the waybills open in: «12 طلبًا خلصوا»
       * over a screen that printed nothing says the job is done when the
       * person is still holding no paper — the message below tells them
       * to allow pop-ups instead.
       */
      if (mode === 'print' && out.refused.length === 0 && out.opened) {
        setBatchDone((prev) => ({ serial: (prev?.serial ?? 0) + 1, count: out.count }));
      }
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
        setError(e instanceof Error ? e.message : 'تعذر تجهيز البوالص');
      }
    } finally {
      setPrinting(false);
    }
  };

  /** Export only the ticked rows, by id, through the same report endpoint. */
  const handleExportSelected = () => {
    if (selected.size === 0) return;
    const params = new URLSearchParams({ ids: [...selected].join(',') });
    window.open(`/api/reports/export?${params.toString()}`, '_blank');
  };

  /** Everything the filters match — not the page in front of you. */
  const handleExportCSV = () => {
    const params = new URLSearchParams({ q: search, status, productId, source });
    if (courierId !== 'all') params.set('courierId', courierId);
    if (regionId !== 'all') params.set('regionId', regionId);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (lateOnly) params.set('lateDays', '10');
    window.open(`/api/reports/export?${params.toString()}`, '_blank');
  };

  /*
   * THE MAIN BUTTON, DRAWN ONCE AND PLACED BY THE WIDTH.
   *
   * On a desk it sits after the fold, where it always has. On a phone it comes FIRST: «متقدم» opens in
   * place and grows the row, and a main button that came after it slid down under four outline buttons
   * every time somebody opened the fold (ORD-27).
   */
  const quickCreate = (
    <Button
      size="sm"
      onClick={() => setCreateModalOpen(true)}
      className="flex items-center space-x-1.5"
    >
      <RiAddCircleLine className="w-4 h-4" />
      <span>{t.quickCreateOrder}</span>
    </Button>
  );

  /*
   * THE LATE TOGGLE AND THE RESET, DRAWN ONCE.
   *
   * On a desk they sit in the search row, as they always have. On a phone they go inside the filter fold
   * with the filters they belong to — the search row is the search and nothing else (ORD-01).
   */
  const lateToggle = (
    <Button
      variant={lateOnly ? undefined : 'outline'}
      onClick={() => setLateOnly((v) => !v)}
      title="شُحنت منذ 10 أيام أو أكثر ولم تُسلَّم بعد — من تاريخ الشحن"
      className="shrink-0 gap-1.5"
    >
      <RiTimerLine className="w-4 h-4" />
      {phone ? 'متأخرة +10 أيام' : 'متأخرة 10 أيام+ من الشحن'}
    </Button>
  );
  const resetButton = activeFilters > 0 && (
    <Button variant="outline" onClick={resetFilters} className="shrink-0 gap-1.5 text-[var(--sys-destructive)]">
      <RiArrowGoBackLine className="icon-mirror w-4 h-4" />
      إعادة تعيين ({activeFilters})
    </Button>
  );

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <PageHeader title={t.orders}
            description={phone ? 'كل الطلبات بحالتها ومَن يحملها' : 'كل الطلبات بحالتها ومَن يحملها — الحالة والفلتر يقرآن نفس الشيء'}
            actions={
              <><div className={phone ? 'flex flex-wrap items-center gap-2' : 'flex items-center space-x-2 rtl:space-x-reverse flex-wrap gap-y-2'}>
            {canCreate && (phone ? quickCreate : null)}
            {/* «holds» names only what THIS person finds inside: export, import and
                AI entry are each behind a grant. With none of the three there is
                nothing to fold, so there is no «متقدم» at all (the list refreshes
                itself, so a refresh button was the only thing left in it). */}
            {(canExport || canImport || canCreate) && (
            <AdvancedGroup
              holds={[canExport && 'تصدير', canImport && 'استيراد', canCreate && 'إدخال بالذكاء']
                .filter(Boolean)
                .join(' · ')}
            >
            {canExport && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCSV}
              className="flex items-center space-x-1.5"
            >
              <RiDownload2Line className="w-4 h-4" />
              <span>{t.export}</span>
            </Button>
            )}

            {/* Beside the export, because they are the same door in two
                directions and somebody looking for one looks here. */}
            {canImport && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImporting(true)}
              className="flex items-center space-x-1.5"
            >
              <RiUploadCloud2Line className="w-4 h-4" />
              <span>استيراد طلبات</span>
            </Button>
            )}

            {canMigrate && (
            <Button variant="outline" size="sm" onClick={() => setMigrating(true)} className="flex items-center space-x-1.5">
              <RiUploadCloud2Line className="w-4 h-4" />
              <span>ترحيل طلبات قديمة</span>
            </Button>
            )}

            {canCreate && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAiModalOpen(true)}
              className="items-center gap-1.5 text-[var(--sys-primary)] border-[var(--sys-primary)]/35 hover:bg-[var(--sys-primary-soft)]"
            >
              <RiMagicLine className="w-4 h-4" />
              <span>إدخال بالذكاء الاصطناعي</span>
            </Button>
            )}
            </AdvancedGroup>
            )}

            {canCreate && (phone ? null : quickCreate)}
          </div></>
            }
          />

        {/* One bar, three rows that each answer a different question:
            which queue am I in, what am I looking for, and how do I narrow
            it. The old grid mixed all three into six equal cells. */}
        <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg shadow-raised divide-y divide-[var(--sys-border)]">
          {/* RiSearchLine — pressing Enter or the button runs it; it no longer
              fires on every keystroke, which made a long phone number send
              a request per digit. */}
          <div className="flex flex-wrap items-center gap-2 p-3">
            <div className="relative flex-1 min-w-[220px]">
              <RiSearchLine className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--sys-muted)]" />
              {/* The accessible name does not depend on the placeholder,
                  which is gone the moment somebody types. */}
              <input
                type="text"
                placeholder="ابحث برقم الطلب، الرمز، اسم العميل، أو الهاتف…"
                aria-label="ابحث في الطلبات"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                className="h-11 md:h-10 w-full ps-9 pe-3 text-sm bg-[var(--sys-surface)] border border-[var(--sys-border-input)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/30 focus:border-[var(--sys-primary)]"
              />
            </div>
            <Button onClick={runSearch} className="shrink-0 gap-1.5">
              <RiSearchLine className="w-4 h-4" />
              بحث
            </Button>
            {/* The camera fills the same box a person types into, and the
                same request goes out. A scan is a search — it sees exactly
                the orders this account may see, and nothing more. */}
            <ScanButton
              title="امسح بوليصة الطلب — QR أو باركود"
              onScan={(code) => {
                setSearchInput(code);
                setSearch(code);
              }}
              className="shrink-0 h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5"
            />
            {!phone && lateToggle}
            {!phone && resetButton}
          </div>

          {/*
            A PHONE SHOWS THE SEARCH AND ONE BUTTON, NOT SIX DROPDOWNS (ORD-01).

            The first order started 750–850px down the page: the search row wrapped to three lines, then six
            full-width filters one to a line, then the saved views. The filters, the «متأخرة» toggle, the reset
            and the saved views now live behind one fold that says how many filters are doing something — they are
            all still here, one tap away, and a desk draws them exactly as it always has.
          */}
          <FilterFold
            phone={phone}
            count={activeFilters}
            footer={
              <>
                {lateToggle}
                {resetButton}
              </>
            }
          >
          {/* Narrowing */}
          <div className={phone ? 'grid grid-cols-2 gap-2 p-3' : 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2 p-3'}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="فلتر الحالة" className="text-xs py-2">
              <option value="all">كل الحالات</option>
              {STATUS_FILTER_OPTIONS.map((st) => (
                <option key={st} value={st}>{STATUS_FILTER_LABELS[st] ?? st}</option>
              ))}
            </Select>

            <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="فلتر الجهة" className="text-xs py-2">
              <option value="all">كل الجهات</option>
              {sources.map((sc) => (
                <option key={sc.name} value={sc.name}>{sc.name} ({sc.count})</option>
              ))}
            </Select>

            {/*
              A HUNDRED AND FOURTEEN PRODUCTS IS NOT A DROPDOWN.

                «لما أضيف منتج … ما بطلع بحث»

              Measured on this database: 114 products, every one of them
              ACTIVE and every one with a SKU. As a native `<select>` that is
              115 rows to scroll past on a phone, and the popup list a
              `<select>` opens is drawn by the browser — which is the other
              half of «لما أجي أختار منتج يتضوي بيضا».

              A filter, not a line-item chooser: `anyOption` is what makes it
              one. «كل المنتجات» is where it starts, where the ✕ returns it,
              and it is never forced to hold a product just because somebody
              opened the box.
            */}
            <ProductPicker
              products={products}
              value={productId}
              onChange={setProductId}
              anyOption={{ value: 'all', label: 'كل المنتجات' }}
              placeholder="ابحث عن منتج…"
              /*
                ONE CELL OF THE GRID, AND NO WIDER. It carried `min-w-[200px]`, but the six cells of this row are
                (width − 40) ÷ 6 — 177px at a 1180px window and 190px at the width of a desk with the menu open — so
                the box was wider than its own cell and ran UNDER «كل المحافظات», which is the one beside it
                («الطلبات الفلاتر داخلين ببعضص»). `min-w-0` lets the cell decide, as the four dropdowns beside it do.
              */
              className="min-w-0"
            />

            <Select value={regionId} onChange={(e) => setRegionId(e.target.value)} aria-label="فلتر المحافظة" className="text-xs py-2">
              <option value="all">كل المحافظات</option>
              {regions.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </Select>

            <Select value={courierId} onChange={(e) => setCourierId(e.target.value)} aria-label="فلتر شركة الشحن" className="text-xs py-2">
              <option value="all">كل شركات الشحن</option>
              <option value="none">بلا شركة شحن بعد</option>
              {couriers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.kind === 'AGENT' ? `مندوب · ${c.name}` : c.name}
                </option>
              ))}
            </Select>

            <DateRange
              label="تاريخ الطلب"
              value={{ from: fromDate, to: toDate }}
              onChange={(r) => { setFromDate(r.from); setToDate(r.to); }}
            />
          </div>

          {/* THE SAME SIX FILTERS, NOT SET AGAIN EVERY MORNING.
              «المتأخرة أكثر من عشرة أيام، أرامكس، إربد» is what somebody
              opens this screen to see, and it cost nine controls before any
              work started. Stored in THIS browser, as a query string and a
              name — no results, no counts, no customer. Recalling a view
              re-asks the question; it never replays an answer. */}
          <div className="border-t border-[var(--sys-border)] px-3 pb-3 pt-2">
            <SavedViews screen="orders" current={filterQuery} onApply={applyFilters} />
          </div>
          </FilterFold>
        </div>

        {/* Load error banner */}
        {error && (
          <div className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] px-3 py-2.5 text-xs flex items-center justify-between gap-2">
            <span>{error}</span>
            <DismissButton onClick={() => setError(null)} />
          </div>
        )}

        {/* On a desk this sits where it always has. On a phone the shell
            hands it the bottom strip, because selecting five rows and then
            scrolling four screens up to act on them is why nobody did. */}
        <BulkBar show={selected.size > 0} done={batchDone}>
          {!phone ? (
          <>
            <span className="text-xs font-semibold text-[var(--sys-primary)]">
              محدَّد: {selected.size} طلب
            </span>
            {/* The paper sits beside the button that uses it, so nobody
                prints thirty labels before discovering the size. */}
            <LabelSizePicker compact className="ms-auto flex items-center" />
            {/* Shown only to whoever may print: the server refuses anyone
                else, and a button that always answers 403 is a broken one. */}
            {canPrint && (
              <>
                <Button size="sm" variant="outline" onClick={() => void handlePrintLabels('print')} loading={printing}>
                  <RiPrinterLine className="w-4 h-4" />
                  طباعة البوالص
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handlePrintLabels('pdf')}
                  disabled={printing}
                  title="نفس البوالص كملف PDF — الحفظ لا يعلّم الطلبات مطبوعة"
                >
                  <RiDownload2Line className="w-4 h-4" />
                  PDF
                </Button>
              </>
            )}
            {canExport && (
            <Button size="sm" variant="outline" onClick={handleExportSelected}>
              <RiDownload2Line className="w-4 h-4" />
              تصدير المحدَّد
            </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>
              إلغاء التحديد
            </Button>
          </>
          ) : (
          <>
            {/*
              A PHONE: TWO ROWS, NOT THREE OR FOUR.
              The bar held the count, the paper size, four buttons and the
              cancel at one weight, and at 44px each they wrapped into a
              strip of about 190px that covered the bottom of the list. Now
              the count and the way out are the first row, and the one thing
              this bar is for — the labels — is the second, beside a fold
              that names what it holds. Nothing is removed: the paper, the
              PDF and the export are one tap away, and the paper still sits
              beside the button that uses it.
            */}
            <span className="me-auto text-xs font-semibold text-[var(--sys-primary)]">
              محدَّد: {selected.size} طلب
            </span>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} title="إلغاء التحديد">
              <RiCloseLine className="w-4 h-4" />
            </Button>
            {/* Shown only to whoever may print: the server refuses anyone
                else, and a button that always answers 403 is a broken one. */}
            {canPrint && (
              <Button size="sm" onClick={() => void handlePrintLabels('print')} loading={printing} className="flex-1 md:flex-none">
                <RiPrinterLine className="w-4 h-4" />
                طباعة البوالص
              </Button>
            )}
            <AdvancedGroup label="المزيد" holds="مقاس الورق · PDF · تصدير" className="self-start">
              <LabelSizePicker compact className="flex flex-wrap items-center gap-2" />
              {canPrint && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handlePrintLabels('pdf')}
                  disabled={printing}
                  title="نفس البوالص كملف PDF — الحفظ لا يعلّم الطلبات مطبوعة"
                >
                  <RiDownload2Line className="w-4 h-4" />
                  PDF
                </Button>
              )}
              {canExport && (
                <Button size="sm" variant="outline" onClick={handleExportSelected}>
                  <RiDownload2Line className="w-4 h-4" />
                  تصدير المحدَّد
                </Button>
              )}
            </AdvancedGroup>
          </>
          )}
        </BulkBar>

        {/* Orders — rows, not a table.
            Eleven columns could not fit any screen: the product name broke
            one word per line, the date stacked into three, and the whole
            thing scrolled sideways. A row that reflows says the same things
            in the order somebody reads them — who, what, where it stands,
            how much — and never runs off the edge. */}
        <Card>
          {/*
            A PLAIN BOX, NOT `CardContent className="p-0"`.

            `CardContent` is `clsx('p-6', className)`, so that call carried BOTH `p-6` and `p-0` — and when two
            utilities set the same property the one LATER in the stylesheet wins, which is `p-6`. The padding this list
            asked to drop was never dropped: twenty-four pixels on each side of every row, which on a phone is
            48 of 358 and is most of what the row had left for its words once the checkbox, the picture and the money
            had taken theirs («نسخة الهاتف بالطلبات كله داخل ببعضو»).
          */}
          <div>
            <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-[var(--sys-border)] bg-[var(--sys-surface)] text-xs text-[var(--sys-muted-foreground)]">
              {/* A 16px box is a 44px target on a phone: the label carries the
                  hit area (a checkbox draws no pseudo-element of its own). */}
              <label className="tap-safe flex shrink-0">
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={toggleAll}
                  aria-label="تحديد كل الطلبات في هذه الصفحة"
                  className="w-4 h-4 accent-[var(--sys-primary)] cursor-pointer"
                />
              </label>
              {orders.length > 0 && (
                <span className="tabular-nums">
                  عرض {firstOnPage}–{lastOnPage} من أصل {pagination.total} طلب
                  {activeFilters > 0 && <span className="text-[var(--sys-primary)]"> (مفلترة)</span>}
                </span>
              )}
              {/* Twenty-five at a time is right for reading and wrong for
                  acting: printing or exporting a filtered batch means having
                  all of it in front of you. */}
              {!showAll && pagination.totalPages > 1 && (
                <button
                  onClick={() => setShowAll(true)}
                  className="tap-safe ms-auto text-xs font-medium text-[var(--sys-primary)] hover:underline"
                >
                  إظهار كل النتائج ({pagination.total})
                </button>
              )}
              {showAll && (
                <button
                  onClick={() => setShowAll(false)}
                  className="tap-safe ms-auto text-xs font-medium text-[var(--sys-muted-foreground)] hover:underline"
                >
                  العودة للعرض بالصفحات
                </button>
              )}
            </div>

            {orders.length === 0 ? (
              loading ? (
                // The rows are the height the page is about to be. Saying
                // «جارٍ التحميل» in one line and then growing to twenty-five
                // rows moves every control under it.
                <div className="p-4">
                  <SkeletonRows rows={8} />
                </div>
              ) : (
                <EmptyState
                  title={activeFilters > 0 ? 'لا طلبَ يطابق هذه الفلاتر' : 'لا طلبات في هذا المتجر بعد'}
                  why={
                    activeFilters > 0
                      ? 'الفلاتر أضيق من أن تُطابق شيئاً — وأكثرُ قائمةٍ فارغةٍ سببُها فلترٌ ضُبط قبل ساعةٍ ونُسي.'
                      : 'الطلبات تصل من صفحات الهبوط والقنوات، أو تُدخَل يدويّاً من الزرّ أعلاه.'
                  }
                  // Filtered: the way out of the filter. Not filtered: the first step — and only for
                  // somebody who may take it (the header's button has the same gate).
                  action={
                    activeFilters > 0
                      ? { label: 'امسح الفلاتر', onClick: resetFilters }
                      : canCreate
                        ? { label: 'أنشئ أول طلب', onClick: () => setCreateModalOpen(true) }
                        : undefined
                  }
                />
              )
            ) : (
              <ul className="divide-y divide-[var(--sys-border)]">
                {orders.map((order) => (
                  /*
                   * OPENING AN ORDER IS THE POINT OF THIS SCREEN, AND IT WAS
                   * REACHABLE ONLY BY MOUSE.
                   *
                   * A row is not a control until it says so: with no
                   * `tabIndex` the Tab key walks straight past every order
                   * on the page, and with no key handler Enter and Space do
                   * nothing. A person working the queue from the keyboard —
                   * or anyone using a screen reader, which announces a bare
                   * `<li>` as a list item and offers no way to activate it —
                   * could not open a single order from here.
                   *
                   * Space is prevented as well as handled, or it scrolls the
                   * page under the person instead of opening the row.
                   */
                  <li
                    key={order.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`افتح الطلب ${order.orderNumber}`}
                    onClick={() => setSelectedOrderId(order.id)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedOrderId(order.id);
                      }
                    }}
                    className={`px-4 py-3 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sys-primary)] focus-visible:ring-inset ${
                      selected.has(order.id) ? 'bg-[var(--sys-primary-soft)]' : 'hover:bg-[var(--sys-surface)]'
                    }`}
                  >
                    {/*
                      A LINE THAT WRAPS, NOT A FIXED ROW OF FOUR THINGS.

                      Checkbox, picture, words, money-and-buttons. On a desk all four fit and the words take what is
                      left. On a phone they did not: the money-and-buttons column refuses to shrink, so the words were
                      left about 40px beside it and every line of them crushed or ran under the next («نسخة الهاتف
                      بالطلبات كله داخل ببعضو»). So the line may WRAP — the words keep a floor of 180px, and what cannot
                      fit beside them goes to a second line instead of taking their room. From `lg` it never wraps.
                    */}
                    <div className="flex flex-wrap lg:flex-nowrap items-start gap-3">
                      {/*
                        A MISSED TICK OPENED THE ORDER.
                        The box is 16px and the row is a button, so on a phone
                        a thumb that landed beside the box opened the order
                        sheet instead. The label is the target — pressing a
                        label presses the box inside it — and `tap-safe` grows
                        it to 44px without moving anything (a checkbox cannot
                        grow its own).
                      */}
                      <label onClick={(e) => e.stopPropagation()} className="tap-safe flex pt-1 shrink-0">
                        <input
                          type="checkbox"
                          checked={selected.has(order.id)}
                          onChange={() => toggleRow(order.id)}
                          aria-label={`تحديد الطلب ${order.orderNumber}`}
                          className="w-4 h-4 accent-[var(--sys-primary)] cursor-pointer"
                        />
                      </label>

                      <ProductThumb
                        src={order.productImageSnapshot || order.product?.image}
                        alt={order.productNameSnapshot || order.product?.name}
                        size="md"
                      />

                      <div className="min-w-[180px] flex-1 space-y-1">
                        {/* Line 1 — which order, and where it stands. The number never breaks at its hyphens. */}
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-bold text-[var(--sys-heading)] text-xs shrink-0 whitespace-nowrap" dir="ltr">{order.orderNumber}</span>
                          <OrderStateBadge state={order.state} />
                          {/* where it ended up, in the owner's words — sent by the server */}
                          {order.outcome && (
                            <span className={`text-xs font-medium ${order.outcomeClosed ? 'text-[var(--sys-success)]' : 'text-[var(--sys-muted-foreground)]'}`}>
                              {order.outcome}
                            </span>
                          )}
                          {order.deliveryProvider && (
                            <span className="inline-flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
                              {order.deliveryProvider.kind === 'AGENT' ? (
                                <RiEBike2Line className="w-4 h-4 text-[var(--sys-primary)]" />
                              ) : (
                                <RiTruckLine className="w-4 h-4 text-[var(--sys-muted)]" />
                              )}
                              {order.deliveryProvider.name}
                            </span>
                          )}
                          {order.trackingNumber && (
                            <span className="text-xs font-mono text-[var(--sys-muted)] shrink-0 whitespace-nowrap" dir="ltr">
                              {order.trackingNumber}
                            </span>
                          )}
                        </div>

                        {/*
                          Lines 2, 3 and 4 — EACH FACT IN ITS OWN BOX, with a gap between boxes instead of a « · »
                          typed between pieces of one string.

                          A name, a number and a place written into one paragraph are ONE bidirectional run: the
                          number is left-to-right inside a right-to-left line, so it was drawn flush against the name
                          with its separator on the far side of it («محمد احسن937881204»), and «Sheet import · 20
                          أكتوبر 2026» shuffled its Latin and Arabic halves. A box per fact cannot mix with its
                          neighbour, `dir="auto"` gives each one the direction of its own first letter, and a line that
                          is too long WRAPS between boxes where `truncate` used to cut it off silently.
                        */}
                        {/* Line 2 — who it goes to. */}
                        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-[var(--sys-heading)]">
                          <span dir="auto">{order.customer?.fullName}</span>
                          <span className="text-xs text-[var(--sys-muted-foreground)]" dir="ltr">
                            {order.customer?.rawPhone || order.customer?.phone}
                          </span>
                          <span className="text-xs text-[var(--sys-muted)]" dir="auto">
                            {order.region?.name ?? order.customer?.city ?? '—'}
                          </span>
                        </p>

                        {/* Line 3 — what is in it. */}
                        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-[var(--sys-muted-foreground)]">
                          <span dir="auto" className="break-words">{order.productNameSnapshot || order.product?.name}</span>
                          <span className="text-[var(--sys-muted)] whitespace-nowrap">× {order.quantity}</span>
                          {order.offer?.name && (
                            <span className="text-[var(--sys-muted)]" dir="auto">{order.offer.name}</span>
                          )}
                        </p>

                        {/* Line 4 — where it came from and when. */}
                        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-[var(--sys-muted)]">
                          <span dir="auto">{order.source || '—'}</span>
                          {order.moderator?.name && <span dir="auto">{order.moderator.name}</span>}
                          <span className="whitespace-nowrap">{arDateTime(order.createdAt)}</span>
                        </p>
                      </div>

                      {/* The money and the two things you do with a row. On a phone it is the second line, at the end. */}
                      <div className="flex flex-col items-end gap-1.5 shrink-0 ms-auto">
                        <Money
                          value={order.totalAmount}
                          currency={currency.code || undefined}
                          minorUnit={currency.code ? currency.minorUnit : undefined}
                          className="font-bold text-[var(--sys-heading)] text-sm"
                        />
                        <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
                          {/*
                            ONE PARCEL, ONE LABEL — FROM THE ROW.

                            Printing lived only in the bulk bar, which
                            appears once something is ticked. So a screen
                            with nothing selected had no print anywhere on
                            it, which is «الطباعة اختفت». And the common
                            act at a bench is a single waybill: reaching it
                            through a checkbox meant for batches was a step
                            for nothing.

                            Shown on the rows that can actually produce one
                            — a waybill needs a confirmed order with a
                            courier — so it is never a button that answers
                            with a refusal. Whoever holds the owner's key
                            (`ops.labels_any`) prints any order in any
                            state, so for her every row can produce one.
                          */}
                          {canPrint && (canPrintAny || order.confirmationStatus === 'CONFIRMED') && (
                            <button
                              type="button"
                              onClick={() => void handlePrintLabels('print', [order.id])}
                              disabled={printing}
                              aria-label={`اطبع بوليصة ${order.orderNumber}`}
                              title="اطبع بوليصة هذا الطلب"
                              className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-primary-soft)] hover:text-[var(--sys-primary)] disabled:opacity-40"
                            >
                              <RiPrinterLine className="w-4 h-4" />
                            </button>
                          )}
                          {/*
                            CALL, SMS, WHATSAPP — FROM THE ROW.

                            This screen showed the customer's number as
                            plain text and offered no way to use it. The
                            number was right there and the agent read it
                            off the screen and typed it into a phone, with
                            the transposed digit that goes with that, and
                            nothing in the contact log said a call had been
                            made at all.

                            It is the shared strip, so it carries the
                            company's own ready-made messages filled with
                            THIS order's words, it builds `wa.me` from the
                            country's calling code rather than from a local
                            number that opens an empty chat, and — given
                            the order id — it writes one line in the
                            contact log per press.
                          */}
                          <ContactButtons
                            compact
                            phone={order.customer?.rawPhone || order.customer?.phone}
                            orderId={order.id}
                            countryCode={dialCode}
                            context={{
                              orderNumber: order.orderNumber,
                              customerName: order.customer?.fullName,
                              amount: order.totalAmount,
                              currency: currency.code || undefined,
                              region: order.region?.name ?? order.customer?.city,
                              courier: order.deliveryProvider?.name ?? null,
                              barcode: order.trackingNumber,
                            }}
                          />
                          <CustomerHistoryButton
                            customerId={order.customer?.id}
                            orderId={order.id}
                            previousOrders={order.previousOrders ?? 0}
                          />
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* Pagination Bar — the shared one (`ui/Pager`); the count is on the line above the list already («عرض 1–25 من أصل N»). */}
            <div className="px-6 py-3 border-t border-[var(--sys-border)]">
              <Pager
                page={pagination.page}
                totalPages={pagination.totalPages}
                total={pagination.total}
                shown={orders.length}
                noun="طلب"
                label={null}
                onPage={(page) => loadOrders(page)}
              />
            </div>
          </div>
        </Card>
      </div>

      {/* Modals */}
      <CreateOrderModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onSuccess={() => loadOrders(1)}
      />

      <AiOrderModal
        isOpen={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
        onSuccess={() => loadOrders(1)}
      />

      <OrderDetailModal
        orderId={selectedOrderId}
        isOpen={!!selectedOrderId}
        onClose={closeOrder}
        onRefresh={() => loadOrders(pagination.page)}
        /*
         * EVERY filter, not three of them. The arrows walk the list behind
         * the dialog, and they used to be handed `q`, `status` and
         * `productId` only — so with a governorate or a courier selected,
         * ‹next› left the list the person was reading.
         */
        filters={{
          q: search,
          status,
          productId,
          source,
          regionId,
          courierId,
          from: fromDate,
          to: toDate,
          lateDays: lateOnly ? '10' : '',
        }}
      />

      {/* Reads the file, shows every row, then creates through the ordinary
          order door one at a time — see the dialog's own note. */}
      {migrating && (
        <MigrateOrdersDialog
          onClose={() => setMigrating(false)}
          onDone={() => {
            setMigrating(false);
            void loadOrders(1);
          }}
        />
      )}

      {importing && (
        <ImportOrdersDialog
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void loadOrders(1);
          }}
        />
      )}
    </>
  );
}

/**
 * THE FILTERS OF THE ORDERS LIST, FOLDED ON A PHONE (ORD-01).
 *
 * On a desk this draws its children untouched. On a phone it draws ONE fold that says how many filters
 * are doing something, and the filters, the late toggle (`footer`) and the saved views inside it — the
 * same controls, the same handlers, one tap away instead of a screen and a half in front of the first
 * order. It is a fold and not a second copy: exactly one set of controls is in the page.
 */
function FilterFold({
  phone,
  count,
  footer,
  children,
}: {
  phone: boolean;
  count: number;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!phone) return <>{children}</>;
  return (
    <div className="p-3">
      <AdvancedGroup label={count > 0 ? `فلاتر (${count})` : 'فلاتر'} holds="الحالة · الجهة · المنتج · التاريخ">
        <div className="w-full">{children}</div>
        <div className="flex flex-wrap items-center gap-2">{footer}</div>
      </AdvancedGroup>
    </div>
  );
}
