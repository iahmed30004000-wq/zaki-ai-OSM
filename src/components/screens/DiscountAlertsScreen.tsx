'use client';

import React, { useCallback, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Rows } from '@/components/ui/Rows';
import { OrderLink } from '@/components/orders/OrderLink';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiAlertLine, RiDiscountPercentLine, RiLoader4Line } from '@remixicon/react';
import { EmptyState } from '@/components/ui/EmptyState';
import { arDate } from '@/lib/format';
import { Money } from '@/components/ui/Money';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * /control/discount-alerts — what was given away, and by whom.
 *
 * One discount is a judgement call. The same person discounting every order
 * is a pattern, and a pattern is only visible when the discounts are read
 * together — so the per-person summary comes first and the orders second.
 *
 * Nothing is approved or reversed here. It is a place to look; the
 * correction happens on the order itself.
 */

interface Row {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  createdAt: string;
  customerName: string | null;
  discount: number;
  total: number;
  share: number;
  notable: boolean;
  currency: string;
  byName: string | null;
  confirmationStatus: string;
}

interface Person {
  id: string | null;
  name: string;
  orders: number;
  total: number;
  biggestShare: number;
}

interface Payload {
  days: number;
  currency: string;
  notableThreshold: number;
  totals: { orders: number; discount: number; notable: number };
  byPerson: Person[];
  orders: Row[];
}

export function DiscountAlertsScreen() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyNotable, setOnlyNotable] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      setData(await apiJson<Payload>(`/api/control/discount-alerts?days=${days}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [days]);

  useLiveRefresh(load, { key: days });

  const rows = (data?.orders ?? []).filter((r) => (onlyNotable ? r.notable : true));

  return (
    <div className="max-w-6xl space-y-3">
      <ScreenTitle />

      <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 flex flex-wrap gap-3 items-end">
        <label>
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">المدة</span>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
          >
            <option value={7}>آخر 7 أيام</option>
            <option value={30}>آخر 30 يوماً</option>
            <option value={90}>آخر 90 يوماً</option>
          </select>
        </label>
        {data && (
          <label className="flex items-center gap-2 h-10 text-sm text-[var(--sys-foreground)]">
            <input type="checkbox" checked={onlyNotable} onChange={(e) => setOnlyNotable(e.target.checked)} />
            الخصومات الكبيرة فقط (فوق {data.notableThreshold}%)
            {data.totals.notable > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] tabular-nums">
                {data.totals.notable}
              </span>
            )}
          </label>
        )}
      </div>

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}

      {!data ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : data.totals.orders === 0 ? (
        <EmptyState
          icon={RiDiscountPercentLine}
          title="لا خصومات في هذه المدة"
          why="لا منتج بلغ حدّ التنبيه خلال المدة المختارة. وسّع المدة، أو خفّض الحدّ من إعدادات الخصومات."
        />
      ) : (
        <>
          <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4">
            <p className="text-sm text-[var(--sys-foreground)] tabular-nums">
              <b>{data.totals.orders}</b> طلباً بخصم، بإجمالي{' '}
              <b className="text-[var(--sys-destructive)]"><Money value={data.totals.discount} currency={data.currency} /></b>
              {data.totals.notable > 0 && (
                <span className="text-[var(--sys-destructive)]">
                  {' '}— منها <b>{data.totals.notable}</b> فوق {data.notableThreshold}%
                </span>
              )}
            </p>
          </div>

          <section className="mb-3">
            <h2 className="mb-2 px-1 text-sm font-medium text-[var(--sys-heading)]">حسب الموظف</h2>
            <Rows
              rows={data.byPerson}
              keyOf={(p) => p.id ?? 'unknown'}
              empty="لا خصومات منحها أحد في هذه المدة."
              columns={[
                { key: 'name', label: 'الموظف', primary: true, render: (p) => p.name },
                { key: 'orders', label: 'عدد الطلبات', render: (p) => <span className="tabular-nums">{p.orders}</span> },
                {
                  key: 'total',
                  label: 'إجمالي الخصم',
                  render: (p) => (
                    <span className="font-medium tabular-nums text-[var(--sys-destructive)]">
                      <Money value={p.total} currency={data.currency} />
                    </span>
                  ),
                },
                {
                  key: 'biggest',
                  label: 'أكبر نسبة',
                  render: (p) => (
                    <span
                      className={`tabular-nums ${p.biggestShare >= data.notableThreshold ? 'font-semibold text-[var(--sys-destructive)]' : 'text-[var(--sys-muted-foreground)]'}`}
                    >
                      {p.biggestShare}%
                    </span>
                  ),
                },
              ]}
            />
          </section>

          <section>
            <h2 className="mb-2 px-1 text-sm font-medium text-[var(--sys-heading)]">
              الطلبات ({rows.length})
            </h2>
            {/* Seven columns is a table on a desk and a sideways scroll on a
                phone, where the order number is off-screen by the time you
                reach the discount. One description, read two ways. */}
            <Rows
              rows={rows}
              keyOf={(r) => r.id}
              empty="لا طلبات تحمل خصماً في هذه المدة."
              columns={[
                {
                  key: 'order',
                  label: 'الطلب',
                  primary: true,
                  render: (r) => (
                    <OrderLink id={r.id} number={r.merchantRef ?? r.orderNumber} className="text-[var(--sys-primary)]" />
                  ),
                },
                { key: 'customer', label: 'العميل', primary: true, render: (r) => r.customerName ?? '—' },
                {
                  key: 'discount',
                  label: 'الخصم',
                  render: (r) => (
                    <span className="font-medium tabular-nums text-[var(--sys-destructive)]">
                      <Money value={r.discount} currency={r.currency} />
                    </span>
                  ),
                },
                {
                  key: 'share',
                  label: 'النسبة',
                  render: (r) => (
                    <span
                      className={`tabular-nums ${r.notable ? 'font-semibold text-[var(--sys-destructive)]' : 'text-[var(--sys-muted-foreground)]'}`}
                    >
                      {r.notable && <RiAlertLine className="ml-1 inline h-4 w-4 align-[-1px]" />}
                      {r.share}%
                    </span>
                  ),
                },
                { key: 'total', label: 'الإجمالي بعده', render: (r) => <span className="tabular-nums">{r.total}</span> },
                { key: 'by', label: 'منحه', render: (r) => r.byName ?? '—' },
                {
                  key: 'at',
                  label: 'التاريخ',
                  // On a desk it is a column; on a card it is one more line
                  // between the agent's name and the number that matters.
                  hideOnPhone: true,
                  render: (r) => (
                    <span className="whitespace-nowrap text-xs text-[var(--sys-muted-foreground)]">
                      {arDate(r.createdAt)}
                    </span>
                  ),
                },
              ]}
            />
          </section>
        </>
      )}
    </div>
  );
}
