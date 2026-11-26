'use client';

import React, { useCallback, useState } from 'react';
import { PageShell } from '@/components/ui/PageShell';
import { Card, CardContent } from '@/components/ui/Card';
import { Rows } from '@/components/ui/Rows';
import { Segmented } from '@/components/ui/Segmented';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { OrderRef } from '@/components/orders/OrderRef';
import { useToast } from '@/components/ui/Toast';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { apiJson } from '@/lib/api-client';
import { routeLabel } from '@/lib/route-registry';

/**
 * «قايمة الاسترجاع» — HER private win-back list (F12, the owner's ruling 25/11).
 *
 * The win-back orders a manager handed to her: never pulled, outside her hand limit, worked in idle time — NEW orders come first, from
 * «طلباتي». Each row opens its order (she holds it, so every door she works an order through opens). The option is 1 or 3 pieces at the
 * owner's two prices — switched here, never typed; the cancelled order's quantity is shown for information only. A row nobody touches
 * leaves her list on the day it says. Every word and number comes from the server's answer.
 */
interface Row {
  id: string;
  orderNumber: string;
  product: string | null;
  pieces: number;
  total: number;
  currency: string;
  touched: boolean;
  oldOrderNumber: string | null;
  oldPieces: number | null;
  options: { one: number; three: number } | null;
  leavesAt: string | null;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export function WinbackListScreen() {
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const a = await apiJson<{ rows: Row[] }>('/api/confirmation/winback/list');
      setRows(Array.isArray(a?.rows) ? a.rows : []);
    } catch (e) {
      setRows([]);
      toast.failed(e instanceof Error ? e.message : 'تعذّر جلب القايمة');
    }
  }, [toast]);
  useLiveRefresh(load);

  const switchTo = async (r: Row, pieces: number) => {
    if (pieces === r.pieces) return;
    setBusy(r.id);
    try {
      await apiJson(`/api/confirmation/winback/list/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pieces }) });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر التغيير');
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageShell
      title={routeLabel('/confirmation/winback-list')}
      description="طلبات استرجاع إلك لحالك، بتشتغلي عليها لما يخلص شغل الطلبات الجديدة. ما بتنحسب من حدّك وما حدا غيرك بيسحبها. اللي ما بتنلمس بترجع بعد 3 أيام."
    >
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-4" aria-busy>
              <SkeletonRows rows={4} />
            </div>
          ) : (
            <Rows
              rows={rows}
              keyOf={(r: Row) => r.id}
              empty="قايمتك فاضية."
              columns={[
                { key: 'n', label: 'الطلب', primary: true, render: (r: Row) => <OrderRef id={r.id} number={r.orderNumber} /> },
                { key: 'p', label: 'المنتج', render: (r: Row) => r.product ?? '—' },
                {
                  key: 'pieces',
                  label: 'العرض',
                  render: (r: Row) =>
                    r.options ? (
                      <Segmented
                        size="sm"
                        aria-label={`عدد القطع — ${r.orderNumber}`}
                        disabled={busy !== null}
                        value={String(r.pieces)}
                        onChange={(v) => void switchTo(r, Number(v))}
                        options={[
                          { value: '3', label: `3 قطع — ${r.options.three}` },
                          { value: '1', label: `قطعة — ${r.options.one}` },
                        ]}
                      />
                    ) : (
                      `${r.pieces} — ${r.total}`
                    ),
                },
                { key: 't', label: 'المجموع', render: (r: Row) => `${r.total} ${r.currency}` },
                { key: 'old', label: 'الطلب القديم', render: (r: Row) => (r.oldOrderNumber ? `${r.oldOrderNumber} — كان ${r.oldPieces ?? '—'} قطع` : '—') },
                { key: 'left', label: 'بترجع', render: (r: Row) => (r.touched ? 'اشتغلتي عليه' : day(r.leavesAt)) },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
