'use client';

import React from 'react';
import { RiCloseLine, RiSearchLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { OrderRef } from '@/components/orders/OrderRef';
import { CustomerHistoryButton } from '@/components/orders/CustomerHistory';
import { OrderGoods, OrderNotes, OrderPlace, streetOf } from '@/components/orders/OrderGoods';

/**
 * «أكّدتها» — THE THIRD TAB OF «طلباتي»: a day, a search, the table and its pages. Moved out of `ConfirmationMineScreen.tsx` in R8c
 * (18/11), on the kit, nothing else changed.
 *
 * PRESENTATION ONLY. The screen keeps the four states (`doneDay`, `doneTyped`, `doneQuery`, `donePage`), the read of
 * `/api/confirmation/mine` they go into, and every «may she»: it hands this the opening press only to a reader who may open the order,
 * the history's holder only on her own desk, whether she edits a confirmed order herself (the empty list's sentence), and the row's
 * presses only on her own desk — drawn by the screen, which decides them. Nothing here reads the session, asks a permission or calls
 * the server (`the-desk-tabs-and-the-done-list.test.tsx`).
 */

/** What a row of «أكّدتها» draws — the screen's order row carries these and more. */
export interface DoneRow {
  id: string;
  orderNumber: string;
  previousOrders: number;
  totalAmount: number;
  currency: string;
  deliveryAddress?: string | null;
  region?: { name: string } | null;
  customerNotes?: string | null;
  customer: { id: string; fullName: string; rawPhone: string; city: string; address: string };
  items: React.ComponentProps<typeof OrderGoods>['items'];
  addOns?: React.ComponentProps<typeof OrderGoods>['addOns'];
}

/** The server's page: the day it looked in, the search it ran, the page and how many are behind it. */
export interface DonePage<R extends DoneRow> {
  day: string;
  q: string;
  page: number;
  pages: number;
  total: number;
  rows: R[];
}

export function DoneList<R extends DoneRow>({
  confirmed,
  day,
  onDay,
  typed,
  onTyped,
  onSearch,
  canReset,
  onReset,
  onClearSearch,
  onNewer,
  onOlder,
  onOpenOrder,
  historyHolderId,
  editsItself,
  rowActions,
}: {
  confirmed: DonePage<R>;
  /** The day in the box: the one she picked, or the server's. */
  day: string;
  onDay: (day: string) => void;
  /** What she is typing — asked only on «ابحث». */
  typed: string;
  onTyped: (value: string) => void;
  onSearch: () => void;
  /** A day or a search was asked: «رجّعني لليوم» is drawn. */
  canReset: boolean;
  onReset: () => void;
  /** The empty search's «امسح البحث». */
  onClearSearch: () => void;
  onNewer: () => void;
  onOlder: () => void;
  /** The number opens the order on her desk — passed only to a reader who may read it; otherwise `OrderRef` decides. */
  onOpenOrder?: (orderId: string) => void;
  /** The customer history's holder: hers on her own desk, null on a colleague's. */
  historyHolderId: string | null;
  /** She changes a confirmed order herself (the key the screen asked) — only the empty list's sentence reads it. */
  editsItself: boolean;
  /** The row's presses, drawn by the screen. Absent on a colleague's desk. */
  rowActions?: (order: R) => React.ReactNode;
}) {
  return (
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
          onSearch();
        }}
      >
        {/* The kit's field (R8c, 18/11): ONE day, as it always was — the box hands its own `yyyy-MM-dd` to the same state, so the
            address the desk asks (`?day=`) is the same bytes (`the-desk-tabs-and-the-done-list.test.tsx`). */}
        <div className="w-56">
          <Input id="done-day" type="date" label="اليوم" value={day} onChange={(e) => onDay(e.target.value)} className="tabular-nums" />
        </div>
        <div className="w-56">
          <Input
            id="done-find"
            label="رقم الطلب أو الاسم أو الهاتف"
            value={typed}
            onChange={(e) => onTyped(e.target.value)}
            placeholder="ابحث في هذا اليوم"
          />
        </div>
        <Button type="submit">
          <RiSearchLine className="w-4 h-4" /> ابحث
        </Button>
        {canReset && (
          <Button type="button" variant="secondary" onClick={onReset}>
            <RiCloseLine className="w-4 h-4" /> رجّعني لليوم
          </Button>
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
      <Card plain className="overflow-hidden">
        <Rows
          rows={confirmed.rows}
          keyOf={(order) => order.id}
          columns={[
            { key: 'c0', label: "الطلب", primary: true,
              // The number opens the order's panel here, on her desk — only for
              // whoever may read it (the work key, or «عرض الطلبات»); else what
              // `OrderLink` decides. The copy button sits beside it either way.
              render: (order) => (
                <OrderRef
                  id={order.id}
                  number={order.orderNumber}
                  onOpen={onOpenOrder ? () => onOpenOrder(order.id) : undefined}
                  className="min-h-11 md:min-h-0"
                />
              ) },
            { key: 'c1', label: "العميل", primary: true,
              render: (order) => (
                <><span className="flex items-center gap-2">
                    {order.customer.fullName}
                    <CustomerHistoryButton
                      customerId={order.customer.id}
                      orderId={order.id}
                      previousOrders={order.previousOrders}
                      holderId={historyHolderId}
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
                action={{ label: 'امسح البحث', onClick: onClearSearch }}
              />
            ) : (
              <EmptyState
                title={`لم تؤكّد طلباً في ${confirmed.day}`}
                why={
                  editsItself
                    ? 'ما تؤكّده يظهر هنا — وتعدّل أو تؤجّل أو تلغي ما لم يدخل دفعة شحن بنفسك، وما دخل دفعة بيمرّ بطلبِ تعديل. غيِّر اليومَ أعلاه لترى يوماً آخر.'
                    : 'ما تؤكّده يظهر هنا للقراءة — وتعديلُه بعدها يمرّ بطلبِ تعديل، لا بتحريرٍ مباشر. غيِّر اليومَ أعلاه لترى يوماً آخر.'
                }
              />
            )
          }
          actions={rowActions}
        />
      </Card>
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
          <Button type="button" variant="secondary" size="sm" disabled={confirmed.page <= 1} onClick={onNewer}>
            الأحدث
          </Button>
          <span className="text-note text-[var(--sys-muted-foreground)] tabular-nums" dir="ltr">
            {confirmed.page} / {confirmed.pages}
          </span>
          <Button type="button" variant="secondary" size="sm" disabled={confirmed.page >= confirmed.pages} onClick={onOlder}>
            الأقدم
          </Button>
        </div>
      )}
    </section>
  );
}
