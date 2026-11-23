'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';
import { formatDate } from '@/lib/screen-api';
import { kindWord, type EffectiveRate } from '@/lib/exchange-rates-core';

/**
 * «أسعار الصرف» — THE RATES A PARTNER'S DRAW IS CONVERTED AT, ON «قواعد المال» (23/11, F8).
 *
 * «إذا بتقدر تحط سعر صرف تلقائي يشيك الإنترنت تمام» (the owner). One row per currency the company uses: today's rate as
 * «1 دولار = …», where it came from («تلقائي» + the source, or «يدوي»), its date, and a box for the owner's own rate, which wins.
 * The Syrian pound is never taken from the internet: its box is «سعر الليرة السورية بالدولار» and, until it is typed, the row says
 * «اكتب السعر». A code no source knows behaves the same. An automatic rate older than three days says so.
 *
 * Drawn only for who holds `finance.partners` (the door asks it again). The figures are the server's; this card only types.
 */

interface Row {
  code: string;
  label: string;
  effective: EffectiveRate | null;
  auto: EffectiveRate | null;
  manual: { perUsd: number; at: string } | null;
  ownerOnly: boolean;
  missingSentence: string | null;
}
interface Answer {
  rows: Row[];
  attemptedAt: string | null;
  failed: { fiat?: string; usdt?: string };
  staleSentence: string;
}

const shown = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });

export function ExchangeRatesCard() {
  const may = useCan('finance.partners');
  return may ? <RatesForm /> : null;
}

function RatesForm() {
  const toast = useToast();
  const [data, setData] = useState<Answer | null>(null);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((a: Answer) => {
    setData(a);
    setTyped(Object.fromEntries(a.rows.map((r) => [r.code, r.manual ? String(r.manual.perUsd) : ''])));
  }, []);

  useEffect(() => {
    let alive = true;
    apiJson<Answer>('/api/finance/exchange-rates')
      .then((a) => alive && adopt(a))
      .catch(() => alive && setFailedToLoad(true));
    return () => {
      alive = false;
    };
  }, [adopt]);

  const changes = (data?.rows ?? [])
    .filter((r) => r.code !== 'USD')
    .filter((r) => (typed[r.code] ?? '').trim() !== (r.manual ? String(r.manual.perUsd) : ''))
    .map((r) => ({ code: r.code, perUsd: (typed[r.code] ?? '').trim() === '' ? null : typed[r.code].trim() }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || changes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const a = await apiJson<Answer>('/api/finance/exchange-rates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rates: changes }),
      });
      adopt(a);
      toast.done('انحفظت أسعار الصرف');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="أسعار الصرف"
        subtitle="بسعر اليوم بينحسب «ما يعادله بعملة المتجر» لسحب الشريك من محفظة بعملة تانية. السعر بينجاب من الإنترنت مرة باليوم، والسعر اللي بتكتبه إنت بيغلب. الليرة السورية ما بتنجاب من الإنترنت أبداً."
      />
      <CardContent>
        {failedToLoad ? (
          <p className="text-note text-[var(--sys-destructive)]">تعذّر تحميل الأسعار — حدّث الصفحة وجرّب من جديد.</p>
        ) : data === null ? (
          <p className="text-note text-[var(--sys-muted-foreground)]">جارٍ التحميل…</p>
        ) : (
          <form onSubmit={save} className="space-y-4">
            <ul className="divide-y divide-[var(--sys-border)]">
              {data.rows.map((r) => (
                <li key={r.code} className="flex flex-wrap items-end gap-3 py-3" data-code={r.code}>
                  <div className="min-w-[220px] flex-1 space-y-1">
                    <p className="text-sm font-medium">{r.label}</p>
                    {r.effective ? (
                      <p className="text-note text-[var(--sys-muted-foreground)] tabular-nums">
                        {r.code === 'USD'
                          ? 'ثابت — 1'
                          : `1 دولار = ${shown(r.effective.perUsd)} ${r.code} · ${kindWord(r.effective.kind)}${
                              r.effective.source ? ` · ${r.effective.source}` : ''
                            }${r.effective.asOf ? ` · ${formatDate(r.effective.asOf)}` : ''}`}
                      </p>
                    ) : (
                      <p className="text-note text-[var(--sys-warning)]">اكتب السعر</p>
                    )}
                    {r.effective?.stale && <p className="text-note text-[var(--sys-warning)]">{data.staleSentence}</p>}
                    {r.manual && r.auto && (
                      <p className="text-note text-[var(--sys-muted-foreground)] tabular-nums">
                        {`التلقائي: 1 دولار = ${shown(r.auto.perUsd)} ${r.code} — سعرك بيغلب`}
                      </p>
                    )}
                  </div>
                  {r.code !== 'USD' && (
                    <div className="w-28">
                      <Input
                        label={r.code === 'SYP' ? 'سعر الليرة السورية بالدولار' : `سعرك (كم ${r.code} للدولار)`}
                        placeholder={r.ownerOnly ? 'اكتب السعر' : 'تلقائي'}
                        type="number"
                        inputMode="decimal"
                        dir="ltr"
                        value={typed[r.code] ?? ''}
                        onChange={(e) => setTyped((t) => ({ ...t, [r.code]: e.target.value }))}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {(data.failed.fiat || data.failed.usdt) && (
              <p className="text-note text-[var(--sys-warning)]">
                آخر محاولة لجلب السعر من الإنترنت ما زبطت — بقي آخر سعر محفوظ.
              </p>
            )}
            <p className="text-note text-[var(--sys-muted-foreground)]">
              امسح السعر من الخانة ليرجع التلقائي. السعر بينحفظ مع كل سحب وقت تسجيله — تغيير السعر ما بيغيّر سحوبات قديمة.
            </p>

            {error && (
              <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-note text-[var(--sys-destructive)]">
                {error}
              </p>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={changes.length === 0} loading={busy}>
                حفظ
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
