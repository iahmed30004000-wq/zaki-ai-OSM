'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { OrderStatusBadge } from '@/components/ui/Badge';
import { useRegions } from '@/hooks/useRegions';
import { useApp } from '@/context/AppContext';
import { useCreateIntent } from '@/hooks/useCreateIntent';
import { format } from 'date-fns';
import { RiAddCircleLine, RiArrowGoBackLine, RiMapPinLine, RiSearchLine } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { HealthChip } from '@/components/ui/HealthChip';
import { ContactButtons } from '@/components/orders/ContactButtons';
import { OrderLink } from '@/components/orders/OrderLink';
import type { CustomerFacts } from '@/lib/customer-insights';
import {
  DEFAULT_SORT,
  SEGMENTS,
  SEGMENT_AR,
  SORTS,
  SORT_AR,
  cleanCity,
  isSegment,
  isSort,
  segmentCount,
  type CustomerSort,
  type Segment,
} from '@/lib/customer-filters';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { AskAi } from '@/components/growth/AskAi';
import { userCan } from '@/lib/can';
import { GRADE_RANK, scoreCustomer } from '@/lib/customer-score';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiFetch } from '@/lib/api-client';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { Pager } from '@/components/ui/Pager';
import { useIsPhone } from '@/hooks/useIsPhone';

export function CustomersScreen() {
  const { t, currentUser } = useApp();
  /* A phone scrolls the facts sideways, wraps the history and stacks the form; a desk is as it was. */
  const onPhone = useIsPhone();
  // The assistant's own gate: a panel that opens onto a refusal is noise.
  const canAskAi = userCan(currentUser, 'ai.use');
  // Governorates of the selected country, not a hard-coded country list.
  const { regions, countryName } = useRegions();
  const regionNames = regions.map((r) => r.name);
  const [customers, setCustomers] = useState<any[]>([]);
  /** The whole book's figures, from the server — not a count of this page. */
  const [facts, setFacts] = useState<CustomerFacts | null>(null);
  /** The country's calling code, for the contact strip's `wa.me`. */
  const [dialCode, setDialCode] = useState<string | null>(null);
  /*
   * WHAT POINTS HERE, READ ONCE.
   *
   * The WhatsApp inbox links to `/customers?search=<the number>` — a link
   * that has carried a filter to this screen for as long as it has existed,
   * and this screen read nothing from the address, so the person landed on
   * the whole book to look for the customer by hand. Read at the start and
   * not written back: the orders list's rule, because keeping the filters
   * in the address bar is saved views, which is a feature and not a repair.
   *
   * A URL is typed by anyone. A value this screen does not know would
   * reach the API and come back 400, so it is checked against the same
   * lists the API checks against.
   */
  const asked = useSearchParams();
  const askedSegment = asked.get('segment');
  const askedSort = asked.get('sort');
  const [search, setSearch] = useState(asked.get('search') ?? asked.get('q') ?? '');
  /** «طلبوا», «رفضوا طرداً» … — the strip's own words, as a filter. `all` is no filter. */
  const [segment, setSegment] = useState<Segment | 'all'>(isSegment(askedSegment) ? askedSegment : 'all');
  const [cityFilter, setCityFilter] = useState(cleanCity(asked.get('city')) ?? 'all');
  const [sort, setSort] = useState<CustomerSort>(isSort(askedSort) ? askedSort : DEFAULT_SORT);
  /**
   * The limited view (`customers.view_basic`) gets no filters and no figures:
   * the server ignores them for it, and so does this screen — it neither
   * sends them nor draws the controls.
   */
  const [limited, setLimited] = useState(false);
  const [loading, setLoading] = useState(true);
  /** 25 to a page, like the orders screen — the book is read in pages. */
  const [pagination, setPagination] = useState({ total: 0, page: 1, limit: 25, totalPages: 1 });

  // Selected customer for order history
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null);

  // Create modal
  const [createModalOpen, setCreateModalOpen] = useState(false);
  // «+ أنشئ» in Ctrl+K arrives as `?new=customer` and opens the form the «إضافة عميل» button opens.
  useCreateIntent({ customer: () => setCreateModalOpen(true) });
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [altPhone, setAltPhone] = useState('');
  const [address, setAddress] = useState('');
  // No default governorate. It was 'دمشق', in a system that runs Syrian,
  // Jordanian and Egyptian stores — so a customer added in Amman was born
  // in Damascus unless somebody noticed and changed it, and nobody notices
  // a field that is already filled in.
  const [city, setCity] = useState('');
  const [notes, setNotes] = useState('');
  const [modalLoading, setModalLoading] = useState(false);
  const [modalMsg, setModalMsg] = useState<string | null>(null);

  /** Latest wins: a second press while a page is in the air replaces it. */
  const seqRef = useRef(0);

  const loadCustomers = async (pageToLoad = 1) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const query = new URLSearchParams({ q: search, page: String(pageToLoad), limit: String(pagination.limit) });
      // Only what was chosen is sent, and nothing at all for the limited view.
      if (!limited) {
        if (segment !== 'all') query.set('segment', segment);
        if (cityFilter !== 'all') query.set('city', cityFilter);
        if (sort !== DEFAULT_SORT) query.set('sort', sort);
      }
      const res = await apiFetch(`/api/customers?${query}`);
      if (seq !== seqRef.current) return; // a newer page already answered
      if (res.ok) {
        const data = await res.json();
        setCustomers(data.customers || []);
        setLimited(!!data.limited);
        setFacts(data.facts ?? null);
        setDialCode(data.dialCode ?? null);
        setPagination(data.pagination || { total: 0, page: 1, limit: pagination.limit, totalPages: 1 });
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  };

  /*
   * The typed search is debounced by 250ms and starts again at page one
   * — page 7 of a different world is not where the reader was. The
   * debounce stays here; what the hook adds is the refresh on return,
   * reloading the page they are ON rather than sending them to the
   * first one.
   *
   * A filter or a sort starts again at page one for the same reason, and
   * rides the same timer: a reader who changes two dropdowns in a row
   * asks once, for the pair.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      loadCustomers(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search, segment, cityFilter, sort]);

  /*
   * The page lives in a ref as well, for the same reason the loader does:
   * the hook's listeners are attached once, so reading `pagination`
   * through the closure would refresh page one forever.
   */
  const pageRef = useRef(pagination.page);
  useEffect(() => {
    pageRef.current = pagination.page;
  }, [pagination.page]);

  useLiveRefresh(() => loadRef.current(pageRef.current), { initial: false });

  /** Page turns go through a stable reference, like the orders screen. */
  const loadRef = useRef(loadCustomers);
  useEffect(() => { loadRef.current = loadCustomers; }, [loadCustomers]);

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalLoading(true);
    setModalMsg(null);
    try {
      const res = await apiFetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, phone, altPhone, address, city, notes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.isExisting) {
        setModalMsg(`عميل موجود مسبقاً بهذا الرقم — تم ربط الطلب بنفس الملف.`);
      } else {
        setCreateModalOpen(false);
        setFullName('');
        setPhone('');
        setAltPhone('');
        setAddress('');
        setNotes('');
      }
      loadCustomers();
    } catch (err: any) {
      setModalMsg(err.message);
    } finally {
      setModalLoading(false);
    }
  };

  /**
   * GRADED HERE, AND SORTED BY WHAT IS WORTH SEEING FIRST.
   *
   * `now` is taken once per render rather than inside the loop, so two
   * cards on the same screen cannot land on different sides of the dormancy
   * line — and the clock is read once, not once per row.
   */
  const now = new Date();
  const scored = customers.map((c) => ({ customer: c, score: scoreCustomer(c, now) }));
  /*
   * A reader who asked for an order gets THAT order. Re-sorting each page by
   * grade is the default's way of putting the people worth seeing first, and
   * on «الأعلى قيمة» it would shuffle every page of 25 against the very
   * order that was chosen — the page would say it was sorted by value and
   * not be.
   */
  const graded =
    sort === DEFAULT_SORT
      ? scored.sort((a, b) => GRADE_RANK[a.score.grade] - GRADE_RANK[b.score.grade])
      : scored;

  /** What is narrowing or re-ordering the list now, for the reset button's count. */
  const activeFilters = limited
    ? 0
    : (segment !== 'all' ? 1 : 0) + (cityFilter !== 'all' ? 1 : 0) + (sort !== DEFAULT_SORT ? 1 : 0);
  const resetFilters = () => {
    setSegment('all');
    setCityFilter('all');
    setSort(DEFAULT_SORT);
  };

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <PageHeader title={t.customers}
            description="سِجلّ العملاء: توحيدُ الأرقام، وكشفُ التكرار، وسجلُّ الطلبات — ومن يستلم ومن يرفض"
            actions={
              <><Button
            size="sm"
            onClick={() => setCreateModalOpen(true)}
            className="flex items-center space-x-1.5 bg-[var(--sys-destructive)] hover:bg-[var(--sys-destructive)]/85"
          >
            <RiAddCircleLine className="w-4 h-4" />
            <span>إضافة عميل</span>
          </Button></>
            }
          />

        {/* The search, and under it the three dropdowns that narrow the same list. */}
        <div className="space-y-2">
        {/* RiSearchLine */}
        <div className="relative max-w-md">
          <RiSearchLine className="absolute left-3 rtl:left-auto rtl:right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--sys-muted)]" />
          <input
            type="text"
            placeholder="بحث بالاسم، رقم الهاتف، المحافظة..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-11 md:h-auto w-full pl-9 pr-4 rtl:pl-4 rtl:pr-9 md:py-2 text-xs bg-[var(--sys-card)] border border-[var(--sys-border-input)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/30 focus:border-[var(--sys-primary)] shadow-raised"
          />
        </div>

        {/*
          THE FILTERS ARE ON THE SCREEN, NOT BEHIND A BUTTON.

            «العملاء بدي الهم فلاتر»

          Three dropdowns, always drawn, each one a question the strip below
          already asks and could not answer: who has ordered, who repeated,
          who refused — and where, and in what order. The counts beside the
          words are the book's, the same figures the strip prints, so
          «رفضوا طرداً (3)» is a promise that three rows will appear.

          Only for the full view. The limited one (`customers.view_basic`)
          gets no figures, and a filter by refusals or a sort by purchase
          value would give it the history it is deliberately not shown —
          the server ignores the parameters for it, and so does this.
        */}
        {facts && !limited && (
          <div className="grid grid-cols-2 items-end gap-2 md:grid-cols-4">
            <Select
              label="الفئة"
              value={segment}
              onChange={(e) => setSegment(e.target.value as Segment | 'all')}
              className="text-xs py-2"
            >
              <option value="all">كل العملاء ({facts.total})</option>
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {SEGMENT_AR[s]} ({segmentCount(s, facts)})
                </option>
              ))}
            </Select>

            <Select
              label="المحافظة"
              value={cityFilter}
              onChange={(e) => setCityFilter(e.target.value)}
              className="text-xs py-2"
            >
              <option value="all">كل المحافظات</option>
              {/* A governorate a link asked for that this book has none of
                  still shows, so the box never says «كل» over a list that
                  is narrowed to nothing. */}
              {cityFilter !== 'all' && !facts.cities.some((c) => c.city.toLowerCase() === cityFilter.toLowerCase()) && (
                <option value={cityFilter}>{cityFilter} (0)</option>
              )}
              {facts.cities.map(({ city: name, count }) => (
                <option key={name} value={name}>
                  {name} ({count})
                </option>
              ))}
            </Select>

            <Select
              label="الترتيب"
              value={sort}
              onChange={(e) => setSort(e.target.value as CustomerSort)}
              className="text-xs py-2"
            >
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {SORT_AR[s]}
                </option>
              ))}
            </Select>

            {activeFilters > 0 && (
              <Button variant="outline" onClick={resetFilters} className="w-full gap-1.5 text-[var(--sys-destructive)]">
                <RiArrowGoBackLine className="icon-mirror w-4 h-4" />
                إعادة تعيين ({activeFilters})
              </Button>
            )}
          </div>
        )}
        </div>

        {/*
          WHAT THE BOOK SAYS, ABOVE WHAT THE PAGE SHOWS.

          Measured before this was written: 178 customers, 167 have
          ordered, 111 have received something, ONE has refused and ONE has
          ordered twice. A per-customer verdict needs three decided orders,
          so 178 chips reading «لا يكفي» would have been 178 pieces of
          noise. These five counts are real, and they are the ones a seller
          asks about. The figures come from the server over the WHOLE book,
          not over the hundred rows a search happened to return.
        */}
        {facts && (
          <div className={onPhone ? 'flex gap-2 overflow-x-auto pb-1' : 'grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5'}>
            <Fact label="عميل" value={facts.total} strip={onPhone} />
            <Fact label="طلبوا" value={facts.ordered} hint={`${facts.total - facts.ordered} لم يطلبوا بعد`} strip={onPhone} />
            <Fact label="كرّروا الطلب" value={facts.repeat} tone="success" strip={onPhone} />
            <Fact label="رفضوا طرداً" value={facts.refused} tone={facts.refused > 0 ? 'danger' : undefined} strip={onPhone} />
            <Fact
              label="نسبة الاستلام"
              value={facts.deliveryRate === null ? '—' : `${facts.deliveryRate}%`}
              hint={facts.deliveryRate === null ? 'لا طلبَ محسوماً بعد' : 'من الطلبات المحسومة'}
              strip={onPhone}
            />
          </div>
        )}

        {/*
          ONE LIST COMPONENT, LIKE EVERY OTHER SCREEN.

          This was a three-column grid of bespoke cards: a fourth way of
          drawing a list in a product that has one, with no phone layout of
          its own and nothing shared with the rest. `Rows` gives the same
          table on a desk, the same cards on a phone, and one place to fix
          any of it.
        */}
        <div className="overflow-hidden rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
          <Rows
            rows={graded}
            keyOf={({ customer }) => customer.id}
            onRowClick={({ customer }) => setSelectedCustomer(customer)}
            alert={({ customer }) => (customer.cancelledOrders ?? 0) > 0}
            columns={[
              {
                key: 'name',
                label: 'العميل',
                primary: true,
                render: ({ customer: c, score }) => (
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-[var(--sys-heading)]">{c.fullName}</span>
                    {/*
                      The grade only where it means something. Below the
                      floor it says «لا يكفي», which is true of almost
                      every row here and worth saying once in the strip
                      above, not 178 times down the page.
                    */}
                    {score.grade !== 'new' && (
                      <span className="mt-0.5 block">
                        <HealthChip health={{ tone: score.tone, label: score.label, why: score.why }} />
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'phone',
                label: 'الهاتف',
                primary: true,
                render: ({ customer: c }) => (
                  /*
                   * THE NUMBER, AND THE THREE WAYS TO USE IT.
                   *
                   * This was a bare `tel:` link and nothing else: no
                   * WhatsApp on the screen whose whole subject is the
                   * customer, and no ready-made message anywhere near it.
                   * A `wa.me` link written here would also have been built
                   * from a local number, which opens a chat with a number
                   * that does not exist — the strip builds it from the
                   * country's calling code.
                   *
                   * No `orderId`: this row is a person, not a parcel.
                   * There is no order to file an attempt against, so
                   * nothing is written to any contact log from here —
                   * which is the honest answer, not a missing feature.
                   */
                  <span
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex flex-wrap items-center gap-2"
                  >
                    <span className="font-mono text-[var(--sys-heading)]" dir="ltr">
                      {c.rawPhone || c.phone}
                    </span>
                    <ContactButtons
                      compact
                      plain
                      phone={c.rawPhone || c.phone}
                      countryCode={dialCode}
                      context={{ customerName: c.fullName, region: c.city }}
                    />
                  </span>
                ),
              },
              {
                key: 'city',
                label: 'المحافظة',
                render: ({ customer: c }) => (
                  <span className="inline-flex items-center gap-1 text-[var(--sys-muted-foreground)]">
                    <RiMapPinLine className="h-4 w-4 text-[var(--sys-muted)]" />
                    {c.city || '—'}
                  </span>
                ),
              },
              {
                key: 'orders',
                label: 'طلبات',
                align: 'end',
                render: ({ customer: c }) => (
                  <span className="tabular-nums">
                    <span className="font-semibold text-[var(--sys-heading)]">{c.totalOrders ?? 0}</span>
                    <span className="text-[var(--sys-muted)]"> · </span>
                    <span className="text-[var(--sys-success)]">{c.deliveredOrders ?? 0}</span>
                    {(c.cancelledOrders ?? 0) > 0 && (
                      <>
                        <span className="text-[var(--sys-muted)]"> · </span>
                        <span className="font-semibold text-[var(--sys-destructive)]">{c.cancelledOrders}</span>
                      </>
                    )}
                  </span>
                ),
              },
              {
                key: 'value',
                label: 'قيمة المشتريات',
                align: 'end',
                render: ({ customer: c }) => <Money value={c.totalPurchaseValue ?? 0} />,
              },
            ]}
            empty={
              /* A filter is the likeliest reason a book that HAS customers
                 shows none, so it is answered first, with the way out. */
              activeFilters > 0 ? (
                <EmptyState
                  title="لا عميلَ يطابق الفلاتر"
                  why="خفّف فلتراً أو امسحها كلّها. الأرقامُ بين القوسين في القوائم هي عددُ العملاء في كلّ خيار."
                  action={{ label: 'امسح الفلاتر', onClick: resetFilters }}
                />
              ) : (
              <EmptyState
                title={search ? 'لا عميلَ يطابق بحثك' : 'لا عملاءَ بعد'}
                why={
                  search
                    ? 'جرّب رقماً أو جزءاً من اسم. الأرقامُ موحَّدة، فصيغةُ كتابتها لا تهمّ.'
                    : 'يُنشأ العميلُ من أوّل طلبٍ له، أو أضِفه بنفسك من الزرّ أعلاه.'
                }
                action={search ? undefined : { label: 'أضف أول عميل', onClick: () => setCreateModalOpen(true) }}
              />
              )
            }
          />
        </div>

        {/*
          THE PAGE BAR — the shared one (`ui/Pager`), the same on every list.
          25 rows to a page; the count describes what is shown against the whole
          book, not this page alone. The screen's own `loading` drives the two
          arrows: an ignored click while a load is in the air is exactly right,
          the rows are still the truth of the page in hand.
        */}
        <Pager
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          shown={customers.length}
          noun="عميل"
          loading={loading}
          onPage={(page) => { void loadRef.current(page); }}
        />

        {/*
          AND THE ASSISTANT, READING THESE CUSTOMERS.

          The one assistant panel the intelligence screen uses, pointed at
          the customers source — not a second chat box. What it is given is
          the object above: counts, rates and governorates. No name, no
          phone, no address ever reaches a model.
        */}
        {canAskAi && <AskAi preselect={['CUSTOMERS']} />}
      </div>

      {/* Customer Details & History Modal */}
      {selectedCustomer && (
        <Modal
          isOpen={!!selectedCustomer}
          onClose={() => setSelectedCustomer(null)}
          title={selectedCustomer.fullName}
          subtitle={`ملف العميل • الرقم الموحد: ${selectedCustomer.phone}`}
          maxWidth="2xl"
        >
          <div className="space-y-4">
            <div className="p-4 bg-[var(--sys-surface)] rounded-lg grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-[var(--sys-muted)]">رقم الهاتف:</span>
                <p className="font-bold font-mono text-[var(--sys-heading)] text-sm" dir="ltr">
                  {selectedCustomer.rawPhone || selectedCustomer.phone}
                </p>
              </div>
              <div>
                <span className="text-[var(--sys-muted)]">إجمالي المشتريات:</span>
                <p className="font-bold text-[var(--sys-destructive)] text-sm">
                  <Money value={selectedCustomer.totalPurchaseValue ?? 0} />
                </p>
              </div>
              <div>
                <span className="text-[var(--sys-muted)]">العنوان:</span>
                <p className="font-medium text-[var(--sys-heading)]">{selectedCustomer.address}</p>
              </div>
              <div>
                <span className="text-[var(--sys-muted)]">المحافظة / الدولة:</span>
                <p className="font-medium text-[var(--sys-heading)]">
                  {selectedCustomer.city}، {selectedCustomer.country}
                </p>
              </div>
            </div>

            <h4 className="text-xs font-bold text-[var(--sys-foreground)] mt-2">
              سجل الطلبات ({selectedCustomer.orders?.length || 0})
            </h4>

            {/* A phone lets the history run down the dialog's own scroll: a list that scrolls inside a list that
                scrolls traps the thumb (ORD-21). A desk keeps the 15rem window. */}
            <div className={onPhone ? 'divide-y divide-[var(--sys-border)]' : 'divide-y divide-[var(--sys-border)] max-h-60 overflow-y-auto'}>
              {selectedCustomer.orders?.map((ord: any) => (
                <div key={ord.id} className={onPhone ? 'py-2.5 flex flex-wrap items-center justify-between gap-y-1 text-xs' : 'py-2.5 flex items-center justify-between text-xs'}>
                  <div className={onPhone ? 'min-w-0' : undefined}>
                    <OrderLink id={ord.id} number={ord.orderNumber} className="font-bold text-[var(--sys-destructive)]" />
                    <span className="text-[var(--sys-muted-foreground)] ml-2 rtl:ml-0 rtl:mr-2">{ord.product?.name}</span>
                  </div>
                  <div className="flex items-center space-x-2 rtl:space-x-reverse">
                    <Money value={ord.totalAmount} className="font-bold text-[var(--sys-heading)]" />
                    <OrderStatusBadge status={ord.status} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* Add Customer Modal */}
      <Modal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="إضافة عميل جديد"
        subtitle="توحيد رقم الهاتف يمنع تسجيل العميل مرتين"
        maxWidth="lg"
      >
        <form onSubmit={handleCreateCustomer} className="space-y-4">
          {modalMsg && (
            <div className="p-3 bg-[var(--sys-surface)] border border-[var(--sys-primary-soft)] text-[var(--sys-primary)] text-xs rounded-lg">
              {modalMsg}
            </div>
          )}

          <Input
            label="الاسم الكامل *"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />

          <div className={onPhone ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-2 gap-3'}>
            <Input
              label="رقم الهاتف *"
              placeholder="مثال: 0936654998"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
            <Input
              label="رقم بديل"
              value={altPhone}
              onChange={(e) => setAltPhone(e.target.value)}
            />
          </div>

          <div className={onPhone ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-2 gap-3'}>
            <Select
              label={`المحافظة${countryName ? ` — ${countryName}` : ''}`}
              value={regionNames.includes(city) ? city : 'أخرى'}
              onChange={(e) => setCity(e.target.value)}
              required
            >
              {regionNames.map((gov) => (
                <option key={gov} value={gov}>
                  {gov}
                </option>
              ))}
              <option value="أخرى">أخرى</option>
            </Select>
            {city === 'أخرى' && (
              <Input
                label="المحافظة / المدينة"
                value={city === 'أخرى' ? '' : city}
                onChange={(e) => setCity(e.target.value)}
              />
            )}
            <Input
              label="العنوان التفصيلي"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              required
            />
          </div>

          <div className="flex justify-end space-x-2 rtl:space-x-reverse pt-2">
            <Button type="button" variant="outline" onClick={() => setCreateModalOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" loading={modalLoading}>
              حفظ العميل
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/**
 * One figure from the book, with the sentence that makes it readable.
 * Small on purpose: five of these are a strip, not a dashboard.
 */
function Fact({
  label,
  value,
  hint,
  tone,
  strip,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: 'success' | 'danger';
  /** A phone draws the five as one strip that scrolls sideways, so each keeps a width of its own. */
  strip?: boolean;
}) {
  const colour =
    tone === 'success'
      ? 'text-[var(--sys-success)]'
      : tone === 'danger'
        ? 'text-[var(--sys-destructive)]'
        : 'text-[var(--sys-heading)]';
  return (
    <div className={`${strip ? 'w-36 shrink-0 ' : ''}rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3`}>
      <p className="text-xs text-[var(--sys-muted-foreground)]">{label}</p>
      <p className={`mt-0.5 text-lg font-bold tabular-nums ${colour}`} dir="ltr">
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs leading-relaxed text-[var(--sys-muted)]">{hint}</p>}
    </div>
  );
}
