'use client';

import React from 'react';
import { Tabs } from '@/components/ui/Tabs';
import { Money } from '@/components/ui/Money';
import { STATE_LABEL_AR, type CoreState } from '@/lib/order-state';

/**
 * THE COUNTS ABOVE THE ORDERS LIST, AND THE FIGURES BESIDE THEM.
 *
 * Both come from `GET /api/orders/summary`, which asks the list's own question (`orderListQuery`) — so a chip never counts an
 * order the person cannot open, and pressing «مؤكد 12» shows twelve rows. The chips leave the state filter out (a chip says
 * what pressing it would show); the cards are the list as it stands, state included.
 *
 * The profit is drawn only when the server sent it — it sends it only to whoever the list itself hands an order's profit
 * to — so this file decides nothing about who sees money.
 */

export interface OrdersSummaryData {
  counts: { state: CoreState; count: number }[];
  countsTotal: number;
  cards: {
    orders: number;
    value: number;
    average: number | null;
    profit?: { value: number; orders: number };
  };
}

/** What came back, or null when it is not a summary (an error body, an older server, a test that answered `{}`). */
export function readSummary(data: unknown): OrdersSummaryData | null {
  const d = data as Partial<OrdersSummaryData> | null;
  if (!d || !Array.isArray(d.counts) || !d.cards || typeof d.cards.orders !== 'number') return null;
  return d as OrdersSummaryData;
}

export function OrdersSummary({
  summary,
  status,
  onStatus,
  currency,
}: {
  summary: OrdersSummaryData;
  status: string;
  onStatus: (status: string) => void;
  currency: { code: string; minorUnit: number };
}) {
  // A state with nothing in it is not a chip — unless it is the one selected, so the selection never disappears.
  const tabs = [
    { key: 'all', label: 'الكل', count: summary.countsTotal },
    ...summary.counts
      .filter((c) => c.count > 0 || c.state === status)
      .map((c) => ({ key: c.state, label: STATE_LABEL_AR[c.state] ?? c.state, count: c.count })),
  ];
  const money = (v: number) => (
    <Money
      value={v}
      currency={currency.code || undefined}
      minorUnit={currency.code ? currency.minorUnit : undefined}
      className="font-bold tabular-nums text-[var(--sys-heading)]"
    />
  );
  const { cards } = summary;

  return (
    <div className="space-y-3">
      <Tabs tabs={tabs} value={status} onChange={(key) => onStatus(key === status ? 'all' : key)} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Figure label="عدد الطلبات">
          <span className="font-bold tabular-nums text-[var(--sys-heading)]">{cards.orders}</span>
        </Figure>
        <Figure label="إجمالي القيمة">{money(cards.value)}</Figure>
        <Figure label="متوسط الطلب">{cards.average === null ? '—' : money(cards.average)}</Figure>
        {cards.profit !== undefined && (
          <Figure label="صافي الربح" hint={`من ${cards.profit.orders} طلب أُقفل مالياً`}>
            {money(cards.profit.value)}
          </Figure>
        )}
      </div>
    </div>
  );
}

function Figure({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
      <p className="text-xs font-semibold text-[var(--sys-muted-foreground)]">{label}</p>
      <p className="mt-0.5 text-base">{children}</p>
      {hint && <p className="mt-0.5 text-xs text-[var(--sys-muted)]">{hint}</p>}
    </div>
  );
}
