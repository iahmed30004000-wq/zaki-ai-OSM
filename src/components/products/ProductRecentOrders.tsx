'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { OrderStateBadge } from '@/components/orders/OrderStateBadge';
import { CopyValue } from '@/components/orders/CopyValue';
import { orderNumberToCopy } from '@/lib/copy-values';
import { apiFetch } from '@/lib/api-client';
import { arDate } from '@/lib/format';
import { RiArrowUpCircleLine } from '@remixicon/react';

/**
 * «أحدث الطلبات على هذا المنتج» — THE LATEST ORDERS ON THIS PRODUCT, AND THEY ARE THERE NOW.
 *
 * «أحدث الطلبات على هذا المنتج شغالة؟» — it was not. The card read `product.orders`, a key `GET /api/products/[id]` has
 * never sent, so it said «لا طلبات على هذا المنتج بعد» about a product with 305 orders, 124 of them delivered.
 * It asks `GET /api/products/[id]/orders` now (a name and a city of each customer, never a phone), and says what it
 * could not do instead of drawing the empty state: «لا تملك صلاحية عرض الطلبات» is a different sentence from «لا طلبات».
 */

interface RecentOrder {
  id: string;
  orderNumber: string;
  state: string;
  totalAmount: number | string;
  createdAt: string;
  customer: { fullName: string | null; city: string | null };
  moderator: string | null;
}

interface Answer {
  total: number;
  orders: RecentOrder[];
  currency: { code: string; minorUnit: number };
}

/** `failed` is a refusal too: the door says «لا تملك صلاحية عرض الطلبات» in its own words, and the card prints them. */
type Read = { kind: 'loading' } | { kind: 'failed'; why: string } | { kind: 'ready'; answer: Answer };

export function ProductRecentOrders({ productId }: { productId: string }) {
  const [read, setRead] = useState<Read>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    // Another product: nothing of the last one stays on the card while this one is read.
    setRead({ kind: 'loading' });
    (async () => {
      try {
        const res = await apiFetch(`/api/products/${encodeURIComponent(productId)}/orders`);
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) setRead({ kind: 'failed', why: body?.errorAr || body?.error || 'تعذّرت قراءة الطلبات' });
        else setRead({ kind: 'ready', answer: body as Answer });
      } catch (e) {
        if (alive) setRead({ kind: 'failed', why: e instanceof Error ? e.message : 'تعذّرت قراءة الطلبات' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [productId]);

  const answer = read.kind === 'ready' ? read.answer : null;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center space-x-2 rtl:space-x-reverse">
            <RiArrowUpCircleLine className="w-4 h-4 text-[var(--sys-destructive)]" />
            <span>أحدث الطلبات على هذا المنتج</span>
          </span>
        }
        subtitle={answer && answer.total > 0 ? `${answer.orders.length} من ${answer.total} طلب` : undefined}
        action={
          answer && answer.total > answer.orders.length ? (
            // The orders screen opens on the same filter this card is built from, so the two cannot disagree.
            <Link
              href={`/orders?productId=${encodeURIComponent(productId)}`}
              className="text-xs font-semibold text-[var(--sys-primary)] hover:underline"
            >
              كل الطلبات ({answer.total})
            </Link>
          ) : undefined
        }
      />
      <CardContent className="overflow-x-auto">
        {read.kind === 'loading' && <p className="text-xs text-[var(--sys-muted-foreground)]">جارٍ القراءة…</p>}
        {read.kind === 'failed' && <p className="text-xs text-[var(--sys-muted-foreground)]">{read.why}</p>}
        {answer && (
          <Rows
            rows={answer.orders}
            keyOf={(o: RecentOrder) => o.id}
            columns={[
              {
                key: 'number',
                label: 'الطلب',
                primary: true,
                // Its own link (the list, with the row lit), so not `OrderRef` — only its copy button beside it.
                render: (o: RecentOrder) => (
                  <span className="inline-flex items-center gap-1">
                    <Link
                      href={`/orders?highlight=${encodeURIComponent(o.id)}`}
                      className="font-medium text-[var(--sys-primary)] hover:underline"
                      dir="ltr"
                    >
                      {o.orderNumber}
                    </Link>
                    <CopyValue text={orderNumberToCopy(o.orderNumber)} noun="رقم الطلب" shown={o.orderNumber} />
                  </span>
                ),
              },
              {
                key: 'customer',
                label: 'العميل',
                primary: true,
                render: (o: RecentOrder) => (
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span dir="auto">{o.customer.fullName ?? '—'}</span>
                    {o.customer.city && (
                      <span className="text-[var(--sys-muted)]" dir="auto">
                        {o.customer.city}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'amount',
                label: 'المبلغ',
                render: (o: RecentOrder) => (
                  <Money value={o.totalAmount} currency={answer.currency.code} minorUnit={answer.currency.minorUnit} className="font-bold" />
                ),
              },
              { key: 'state', label: 'الحالة', render: (o: RecentOrder) => <OrderStateBadge state={o.state} /> },
              { key: 'moderator', label: 'الموديريتور', render: (o: RecentOrder) => o.moderator || '—' },
              { key: 'date', label: 'التاريخ', render: (o: RecentOrder) => arDate(o.createdAt) },
            ]}
            empty={
              <EmptyState
                title="لا طلبات على هذا المنتج بعد"
                why="آخرُ طلباته تظهر هنا. فراغُها يعني أنّ لا أحد طلبه — أو أنّه لم يُنشر بعد."
              />
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
