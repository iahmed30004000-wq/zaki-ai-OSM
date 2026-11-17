'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { RiExternalLinkLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Rows, type Column } from '@/components/ui/Rows';
import { Tabs } from '@/components/ui/Tabs';
import { ListToolbar, type ToolbarFilter } from '@/components/ui/ListToolbar';
import { Pager } from '@/components/ui/Pager';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { OrderRef } from '@/components/orders/OrderRef';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { apiJson } from '@/lib/api-client';
import { arDateTime } from '@/lib/format';
import { usePagedList, type PagedRead, type Paging } from '@/hooks/usePagedList';
import { CART_STATUSES, CART_STATUS_AR } from '@/lib/abandoned-cart-rules';
import {
  CartContact,
  CartStatusChip,
  CartStatusControls,
  ConvertCartButton,
  HasOrderMark,
  useCartConversion,
  type CartPowers,
  type CartRow,
} from '@/components/carts/cart-parts';

/**
 * «السلات المهجورة» — THE VISITORS WHO LEFT A NAME AND A PHONE ON A LANDING PAGE AND NO ORDER.
 *
 * Zaki pages sends each one fifteen minutes after the visitor went quiet (contract oms-lp.v1 §9); the team works them
 * like orders: a call, a WhatsApp message with the product already in it, «ما رد» that counts the attempts, a status,
 * and «حوّل لطلب» — the ordinary new-order form filled from the cart. «له طلب» says the same phone already ordered the
 * same product this week, so nobody rings a customer who bought.
 *
 * Who sees which carts is the orders' own key and scope (`orders.view`); every button is drawn only when the door behind
 * it would say yes (`may`, from the list's own answer).
 */

interface Facts {
  all: number;
  [status: string]: number;
}

interface Extra {
  facts: Facts;
  products: { id: string; name: string }[];
  people: { id: string; name: string }[];
  dialCode: string | null;
  may: CartPowers;
}

/** Module-level, so the hook's loader keeps one identity — see `usePagedList`. */
const read = (body: unknown): PagedRead<CartRow, Extra> => {
  const b = body as { carts: CartRow[]; pagination: Paging } & Extra;
  return {
    rows: b.carts,
    pagination: b.pagination,
    extra: { facts: b.facts, products: b.products, people: b.people, dialCode: b.dialCode, may: b.may },
  };
};

const TABS = [{ key: 'all', label: 'الكل' }, ...CART_STATUSES.map((s) => ({ key: s, label: CART_STATUS_AR[s].label }))];

const RANGES = [
  { value: '', label: 'كل الأوقات' },
  { value: 'today', label: 'اليوم' },
  { value: '7d', label: 'آخر 7 أيام' },
  { value: '30d', label: 'آخر 30 يوم' },
];

const NO_POWERS: CartPowers = { work: false, note: false, assign: false, convert: false, settings: false };

export function AbandonedCartsScreen() {
  const { currentUser } = useApp();
  if (!userCan(currentUser, 'orders.view')) {
    return <div className="p-8 text-center text-[var(--sys-muted-foreground)]">ما عندك صلاحية تشوف الطلبات — والسلات معها</div>;
  }
  return <AbandonedCartsList />;
}

function AbandonedCartsList() {
  const [tab, setTab] = useState<string>('NEW');
  const [search, setSearch] = useState('');
  const [range, setRange] = useState('');
  const [productId, setProductId] = useState('');
  const [assignee, setAssignee] = useState('');
  const [retention, setRetention] = useState<number | null>(null);
  const [autoConvert, setAutoConvert] = useState<boolean | null>(null);

  const list = usePagedList<CartRow, Extra>({
    url: '/api/abandoned-carts',
    params: {
      status: tab === 'all' ? undefined : tab,
      q: search.trim() || undefined,
      range: range || undefined,
      productId: productId || undefined,
      assignee: assignee || undefined,
    },
    read,
  });

  useEffect(() => {
    apiJson<{ retentionDays: number; autoConvert: boolean }>('/api/abandoned-carts/settings').then(
      (s) => {
        setRetention(s.retentionDays);
        setAutoConvert(s.autoConvert);
      },
      () => {
        setRetention(null);
        setAutoConvert(null);
      }
    );
  }, []);

  const { rows, pagination, extra } = list;
  const may = extra?.may ?? NO_POWERS;
  const dialCode = extra?.dialCode ?? null;
  const conversion = useCartConversion(() => list.reload());

  const filters: ToolbarFilter[] = [
    { key: 'range', label: 'التاريخ', value: range, options: RANGES, onChange: setRange },
    {
      key: 'product',
      label: 'المنتج',
      value: productId,
      options: [{ value: '', label: 'كل المنتجات' }, ...(extra?.products ?? []).map((p) => ({ value: p.id, label: p.name }))],
      onChange: setProductId,
    },
    {
      key: 'assignee',
      label: 'المسؤول',
      value: assignee,
      options: [
        { value: '', label: 'الكل' },
        { value: 'me', label: 'المسندة لي' },
        { value: 'none', label: 'غير مسندة' },
        ...(extra?.people ?? []).map((p) => ({ value: p.id, label: p.name })),
      ],
      onChange: setAssignee,
    },
  ];
  const activeCount = [search.trim(), range, productId, assignee].filter(Boolean).length;
  const reset = () => {
    setSearch('');
    setRange('');
    setProductId('');
    setAssignee('');
  };

  const columns: Column<CartRow>[] = [
    {
      key: 'lastSeenAt',
      label: 'آخر نشاط',
      primary: true,
      render: (c) => <span className="tabular-nums text-xs">{arDateTime(c.lastSeenAt)}</span>,
    },
    {
      key: 'customer',
      label: 'الزبون',
      primary: true,
      render: (c) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Link href={`/abandoned-carts/${c.id}`} className="font-semibold text-[var(--sys-heading)] hover:text-[var(--sys-primary)]">
            {c.customerName || 'بلا اسم'}
          </Link>
          <HasOrderMark cart={c} />
          {c.hasOrder && <OrderRef id={c.hasOrder.id} number={c.hasOrder.orderNumber} className="font-mono text-xs text-[var(--sys-primary)]" />}
        </div>
      ),
    },
    { key: 'phone', label: 'الهاتف', render: (c) => <span dir="ltr" className="tabular-nums">{c.phoneShown}</span> },
    { key: 'city', label: 'المدينة', render: (c) => c.region?.name ?? c.city ?? <span className="text-[var(--sys-muted)]">—</span> },
    { key: 'product', label: 'المنتج', render: (c) => c.productName || <span className="text-[var(--sys-muted)]">—</span> },
    {
      key: 'page',
      label: 'الصفحة',
      hideOnPhone: true,
      render: (c) =>
        c.landingPageUrl ? (
          <a href={c.landingPageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[var(--sys-primary)] hover:underline">
            {c.landingPageName || 'الصفحة'} <RiExternalLinkLine className="icon-mirror w-4 h-4" />
          </a>
        ) : (
          c.landingPageName || <span className="text-[var(--sys-muted)]">—</span>
        ),
    },
    {
      key: 'status',
      label: 'الحالة',
      render: (c) => (
        <div className="space-y-1">
          <CartStatusChip status={c.status} />
          {c.order && <OrderRef id={c.order.id} number={c.order.orderNumber} className="block font-mono text-xs text-[var(--sys-primary)]" />}
          {c.nextFollowUpAt && <p className="text-xs text-[var(--sys-muted-foreground)]">متابعة: {arDateTime(c.nextFollowUpAt)}</p>}
        </div>
      ),
    },
    { key: 'assignee', label: 'المسؤول', render: (c) => c.assignedTo?.name ?? <span className="text-[var(--sys-muted)]">غير مسندة</span> },
    { key: 'attempts', label: 'المحاولات', align: 'end', render: (c) => <span className="tabular-nums">{c.attempts}</span> },
  ];

  const actions = (c: CartRow) => (
    <div className="flex flex-wrap items-center gap-2">
      <CartContact cart={c} dialCode={dialCode} />
      <CartStatusControls cart={c} may={may} onChanged={() => list.reload()} />
      <ConvertCartButton cart={c} may={may} onStart={conversion.start} />
      <Link href={`/abandoned-carts/${c.id}`}>
        <Button size="sm" variant="ghost">التفاصيل</Button>
      </Link>
    </div>
  );

  const empty =
    activeCount > 0 ? (
      <EmptyState title="ما في سلات بهالفلاتر" why="جرّب فلتر تاني، أو امسح البحث." action={{ label: 'امسح الفلاتر', onClick: reset }} />
    ) : tab === 'NEW' ? (
      <EmptyState title="ما في سلات جديدة" why="كل سلة وصلت انشغل عليها. السلة بتوصل من صفحات الهبوط بعد ربع ساعة من آخر حركة للزائر." action={{ label: 'اعرض الكل', onClick: () => setTab('all') }} />
    ) : (
      <EmptyState title="ما في سلات هون" why="السلة المهجورة زائر كتب اسمه ورقم صالح بصفحة هبوط وما طلب خلال 15 دقيقة." />
    );

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto" dir="rtl">
      <PageHeader
        title="السلات المهجورة"
        description="زوار كتبوا اسمهم ورقمهم بصفحة الهبوط وما كملوا الطلب. اتصل فيهم أو ابعتلهم واتساب، وحوّل السلة لطلب."
        actions={
          <Button variant="ghost" size="sm" onClick={() => void list.reload()}>
            <RiRefreshLine className="w-4 h-4 ml-1" /> تحديث
          </Button>
        }
      />

      {retention !== null && (
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          السلات «غير مهتم» و«رقم غير صالح» و«طلب لحاله» بتنحذف بعد {retention} يوم من آخر تعديل.
          {may.settings && <RetentionEditor days={retention} onSaved={setRetention} />}
        </p>
      )}

      {autoConvert !== null && (
        <AutoConvertSwitch on={autoConvert} mayEdit={may.settings} onSaved={(on) => { setAutoConvert(on); void list.reload(); }} />
      )}

      <Tabs tabs={TABS.map((t) => ({ ...t, count: extra?.facts?.[t.key] }))} value={tab} onChange={setTab} />

      <ListToolbar
        search={search}
        onSearch={setSearch}
        placeholder="بحث برقم الهاتف أو الاسم…"
        filters={filters}
        activeCount={activeCount}
        onReset={reset}
      />

      {list.error && (
        <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">
          {list.error}
        </p>
      )}

      {extra === undefined ? (
        !list.error && <SkeletonRows rows={5} />
      ) : (
        <Rows
          rows={rows}
          keyOf={(c) => c.id}
          columns={columns}
          alert={(c) => (c.hasOrder ? 'warn' : null)}
          notice={(c) => (c.hasOrder ? <p className="text-xs text-[var(--sys-warning)]">نفس الرقم طلب نفس المنتج هالأسبوع — لا تتصل قبل ما تشوف الطلب.</p> : null)}
          actions={actions}
          empty={empty}
        />
      )}

      {pagination.total > 0 && (
        <Pager page={pagination.page} totalPages={pagination.totalPages} total={pagination.total} shown={rows.length} noun="سلة" loading={list.loading} onPage={list.goTo} />
      )}

      {conversion.modal}
    </div>
  );
}

/**
 * «حوّل السلات اللي فيها اسم ورقم لطلبات تلقائيًا» (the owner, 17/11) — the company's switch, ON by default. Everybody who
 * sees the carts reads which way it is; whoever may edit the system's settings flips it.
 */
function AutoConvertSwitch({ on, mayEdit, onSaved }: { on: boolean; mayEdit: boolean; onSaved: (on: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const flip = async (next: boolean) => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await apiJson<{ autoConvert: boolean }>('/api/abandoned-carts/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoConvert: next }),
      });
      onSaved(r.autoConvert);
      setSaid('انحفظت');
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'ما انحفظت');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="text-xs text-[var(--sys-muted-foreground)] space-y-1">
      <label className="inline-flex items-center gap-2">
        <input type="checkbox" checked={on} disabled={!mayEdit || busy} onChange={(e) => void flip(e.target.checked)} />
        <span className="font-semibold text-[var(--sys-heading)]">حوّل السلات اللي فيها اسم ورقم لطلبات تلقائيًا</span>
        {said && <span>{said}</span>}
      </label>
      <p>
        {on
          ? 'السلة اللي فيها اسم ورقم بتصير طلب جديد بطابور التأكيد، بدون عنوان — أكّد العنوان والمحافظة مع الزبون. السلة اللي فيها رقم بس بتضل هون.'
          : 'موقوف: كل السلات بتضل هون لحتى حدا يحوّلها باليد.'}
      </p>
    </div>
  );
}

/** «مدة الحفظ» — for whoever may edit the system's settings, beside the sentence that states it. */
function RetentionEditor({ days, onSaved }: { days: number; onSaved: (days: number) => void }) {
  const [value, setValue] = useState(String(days));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await apiJson<{ retentionDays: number }>('/api/abandoned-carts/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays: Number(value) }),
      });
      onSaved(r.retentionDays);
      setSaid('انحفظت');
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'ما انحفظت');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="ms-2 inline-flex items-center gap-1">
      <input
        type="number"
        inputMode="numeric"
        aria-label="مدة الحفظ بالأيام"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-16 rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-card)] px-1 py-0.5 text-xs tabular-nums"
      />
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void save()}>
        احفظ المدة
      </Button>
      {said && <span>{said}</span>}
    </span>
  );
}
