'use client';

import React, { useCallback, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Rows } from '@/components/ui/Rows';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { OrderRef } from '@/components/orders/OrderRef';
import { apiJson } from '@/lib/api-client';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useToast } from '@/components/ui/Toast';
import { CALL_RESULTS, CALL_RESULT_AR, DAILY_KIND_AR, type CallResult } from '@/lib/winback-daily-words';
import type { DailyItem } from '@/lib/winback-daily';

/**
 * «اتصالات اليوم» — THE DAILY WINBACK LIST, above the winback list (step F1 of Confirmation Center v2).
 *
 * Orders lost for a changed mind, a price or five unanswered calls, and postponed orders whose date was missed, each 24 to 72 hours after it happened: who should call, and what the last call came
 * to. Two small actions — name who calls (the key of handing an order over) and record what a call came to (the winback's own key) — each one line in the audit; nothing is offered,
 * discounted, closed or sent from here. A missed-date order is a call list only: no offer exists for it. When the owner's switch is off, or on any failure or odd answer, this draws NOTHING and the
 * winback list below is exactly what it was. No customer field is on this screen: the order opens under the usual access.
 */
interface Answer {
  enabled: boolean;
  window?: { fromHours: number; toHours: number };
  canAssign?: boolean;
  canCall?: boolean;
  assignees?: { id: string; name: string }[];
  items?: DailyItem[];
}

const valid = (x: unknown): x is Answer => !!x && typeof x === 'object' && typeof (x as Answer).enabled === 'boolean';

export function WinbackDaily() {
  const toast = useToast();
  const [data, setData] = useState<Answer | null | 'none'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, CallResult>>({});

  const load = useCallback(async () => {
    try {
      const a = await apiJson<unknown>('/api/confirmation/winback/daily');
      setData(valid(a) && a.enabled && Array.isArray(a.items) ? a : 'none');
    } catch {
      setData('none');
    }
  }, []);

  // loads on mount and again whenever she comes back to the screen: the list is a day's work and must not go stale under an open tab
  useLiveRefresh(load);

  if (data === 'none') return null;

  const post = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    try {
      await apiJson('/api/confirmation/winback/daily', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(null);
    }
  };

  const field = 'h-11 md:h-8 rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-card)] px-2 text-sm';

  return (
    <Card>
      <CardHeader
        title="اتصالات اليوم"
        subtitle={
          data
            ? `طلبات ملغاة أو مؤجّلة فات موعدها، من ${data.window?.fromHours} لحد ${data.window?.toHours} ساعة بعد ما صار. حدّد مين بيتصل وسجّل النتيجة. القايمة ما بتعرض خصم ولا بتسكّر شي؛ والمؤجّلة للاتصال بس.`
            : undefined
        }
      />
      <CardContent className="p-0">
        {data === null ? (
          <div className="p-4" aria-busy>
            <SkeletonRows rows={4} />
          </div>
        ) : (
          <Rows
            rows={data.items ?? []}
            keyOf={(r: DailyItem) => r.orderId}
            empty="ما في طلبات لاتصال اليوم."
            columns={[
              { key: 'n', label: 'الطلب', primary: true, render: (r: DailyItem) => <OrderRef id={r.orderId} number={r.orderNumber} /> },
              { key: 'kind', label: 'النوع', render: (r: DailyItem) => DAILY_KIND_AR[r.kind] },
              { key: 'reason', label: 'السبب', render: (r: DailyItem) => r.reasonAr },
              {
                key: 'who',
                label: 'مين بيتصل',
                render: (r: DailyItem) =>
                  data.canAssign ? (
                    <select aria-label={`مين بيتصل — ${r.orderNumber}`} className={field} value={r.assignee?.id ?? ''} disabled={busy !== null} onChange={(e) => e.target.value && void post(`a${r.orderId}`, { action: 'assign', orderId: r.orderId, userId: e.target.value })}>
                      <option value="">— حدّد —</option>
                      {(data.assignees ?? []).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    r.assignee?.name ?? '—'
                  ),
              },
              {
                key: 'call',
                label: 'نتيجة الاتصال',
                render: (r: DailyItem) => (
                  <span className="space-y-1">
                    {r.lastCall && (
                      <span className="block text-note text-[var(--sys-muted-foreground)]">
                        آخر اتصال: {CALL_RESULT_AR[r.lastCall.result]} — {r.lastCall.by}
                      </span>
                    )}
                    {data.canCall && (
                      <span className="flex items-center gap-1">
                        <select aria-label={`نتيجة الاتصال — ${r.orderNumber}`} className={field} value={picked[r.orderId] ?? ''} disabled={busy !== null} onChange={(e) => setPicked({ ...picked, [r.orderId]: e.target.value as CallResult })}>
                          <option value="">— النتيجة —</option>
                          {CALL_RESULTS.map((c) => (
                            <option key={c} value={c}>
                              {CALL_RESULT_AR[c]}
                            </option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={busy !== null || !picked[r.orderId]}
                          loading={busy === `c${r.orderId}`}
                          onClick={() => {
                            void post(`c${r.orderId}`, { action: 'call', orderId: r.orderId, result: picked[r.orderId] });
                          }}
                        >
                          سجّل
                        </Button>
                      </span>
                    )}
                  </span>
                ),
              },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}
