'use client';

import React, { useCallback, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { RiArrowDownLine, RiArrowUpLine, RiHistoryLine, RiLoader4Line, RiSearchLine } from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { arDateTime } from '@/lib/format';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * /inventory/movements — how the stock got to where it is.
 *
 * A ledger, read by hunting: filter to one product or one kind of movement
 * rather than scrolling. Nothing is editable, because a movement is never
 * edited — a wrong one is corrected by another movement the other way, the
 * same rule the wallet ledger follows.
 */

interface Movement {
  id: string;
  type: string;
  quantity: number;
  balanceAfter: number;
  reason: string | null;
  createdAt: string;
  product: { id: string; name: string; sku: string | null } | null;
  batchNumber: string | null;
  createdByName: string | null;
}

const TYPE_AR: Record<string, string> = {
  PRODUCTION: 'إدخال / إنتاج',
  SALE: 'بيع',
  RETURN: 'مرتجع',
  MANUAL_ADJUSTMENT: 'تسوية يدوية',
  DAMAGE: 'تالف',
  LOSS: 'ناقص — ما رجع',
  TRANSFER: 'نقل',
};

export function InventoryMovementsScreen() {
  const [data, setData] = useState<{ movements: Movement[]; types: { type: string; count: number }[]; hasMore: boolean } | null>(null);
  const [term, setTerm] = useState('');
  const [type, setType] = useState('all');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const q = new URLSearchParams();
    if (term.trim()) q.set('q', term.trim());
    if (type !== 'all') q.set('type', type);
    try {
      setData(await apiJson(`/api/inventory/movements?${q}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [term, type]);

  useLiveRefresh(load, { key: `${term}·${type}` });

  return (
    <div className="max-w-6xl space-y-3">
      <ScreenTitle />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
        className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 flex flex-wrap gap-3 items-end"
      >
        <label className="flex-1 min-w-[220px]">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">بحث</span>
          <div className="relative">
            <RiSearchLine className="w-4 h-4 text-[var(--sys-muted)] absolute right-3 top-3" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="اسم المنتج، الرمز، رقم الدفعة أو السبب"
              className="w-full h-11 md:h-10 pr-9 pl-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            />
          </div>
        </label>
        <label>
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">النوع</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
          >
            <option value="all">الكل</option>
            {(data?.types ?? []).map((t) => (
              <option key={t.type} value={t.type}>
                {TYPE_AR[t.type] ?? t.type} ({t.count})
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium">بحث</button>
      </form>

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}

      {!data ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : data.movements.length === 0 ? (
        <EmptyState
          icon={RiHistoryLine}
          title="لا حركات مطابقة"
          why="لا حركة مخزون تطابق ما تبحث عنه. وسّع البحث أو امسحه لتعود كل الحركات."
        />
      ) : (
        <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
                    <Rows
            rows={data.movements}
            keyOf={(m) => m.id}
            columns={[
              { key: 'c0', label: "التاريخ", primary: true,
                render: (m) => (
                  <>{arDateTime(m.createdAt)}</>
                ) },
              { key: 'c1', label: "المنتج", primary: true,
                render: (m) => (
                  <>{m.product?.name ?? '—'}
                    {m.product?.sku && <span className="block text-xs text-[var(--sys-muted)]" dir="ltr">{m.product.sku}</span>}</>
                ) },
              { key: 'c2', label: "النوع",
                render: (m) => (TYPE_AR[m.type] ?? m.type) },
              { key: 'c3', label: "الكمية",
                render: (m) => (
                  <><span
                      className={`inline-flex items-center gap-1 tabular-nums font-medium ${
                        m.quantity >= 0 ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'
                      }`}
                    >
                      {m.quantity >= 0 ? <RiArrowUpLine className="w-4 h-4" /> : <RiArrowDownLine className="w-4 h-4" />}
                      {Math.abs(m.quantity)}
                    </span></>
                ) },
              { key: 'c4', label: "الرصيد بعدها", align: 'end',
                render: (m) => (m.balanceAfter) },
              { key: 'c5', label: "الدفعة",
                render: (m) => (m.batchNumber ?? '—') },
              { key: 'c6', label: "السبب",
                render: (m) => (m.reason ?? '—') },
              { key: 'c7', label: "سجّلها",
                render: (m) => (m.createdByName ?? '—') },
            ]}
            empty={
              <EmptyState
                title="لا حركاتِ مخزونٍ في هذه الفترة"
                why="كلُّ استلامٍ وشحنةٍ ومرتجعٍ يكتب حركةً هنا. إن كنت تنتظر حركةً، فوسّع الفترة أو راجع الفلاتر."
              />
            }
          />
          {data.hasMore && (
            <p className="text-xs text-[var(--sys-muted)] px-3 py-2 border-t border-[var(--sys-border)]">
              تُعرض أحدث الحركات — ضيّق البحث لرؤية أقدم منها.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
