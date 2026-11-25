'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { apiJson } from '@/lib/api-client';

/**
 * «وزّع على الموظفات» — THE BULK WIN-BACK, on «ملغاة سابقاً» (/confirmation/follow-up).
 *
 * A manager picks the filters (product, reason, period), how many, and the agents; «اعرض الخطة» asks the server for the plan (nothing
 * is written), and «وزّع» makes exactly those orders through the one win-back door at the owner's win-back price, each held for her agent.
 * Every word and number comes from the server's answer; the price is never typed here. Below it, «أسعار الاسترجاع» — the price of each
 * product, for whoever may change the rule. Drawn only for who may run it (`canBulk`); on any failure it draws nothing and the lists
 * below are exactly what they were.
 */

interface Agent {
  id: string;
  name: string;
  room: number;
}
interface Meta {
  canBulk: boolean;
  max?: number;
  agents?: Agent[];
  reasons?: { code: string; label: string }[];
  periods?: { code: string; label: string }[];
}
interface Price {
  one: number;
  three: number;
  currency: string;
}
interface Prices {
  canEdit: boolean;
  currency: string;
  products: { id: string; name: string; price: Price | null }[];
}
interface Plan {
  planned: { orderId: string; orderNumber: string; agentId: string; price: number; tier: 'one' | 'three' }[];
  perAgent: { id: string; name: string; room: number; count: number }[];
  skipped: { code: string; count: number; reasonAr: string }[];
  scanned: number;
}
interface RunAnswer {
  created: number;
  failed: number;
  results: { orderId: string; orderNumber: string; ok: boolean; code?: string; reasonAr?: string; newOrderNumber?: string }[];
}

const field = 'h-11 md:h-8 w-full rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-card)] px-2 text-sm';

export function WinbackBulkCard() {
  const toast = useToast();
  const [meta, setMeta] = useState<Meta | null | 'none'>(null);
  const [prices, setPrices] = useState<Prices | null>(null);
  const [productId, setProductId] = useState('');
  const [reason, setReason] = useState('');
  const [period, setPeriod] = useState('');
  const [count, setCount] = useState('50');
  const [agents, setAgents] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [run, setRun] = useState<RunAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPrices = useCallback(async () => {
    try {
      setPrices(await apiJson<Prices>('/api/confirmation/winback/prices'));
    } catch {
      setPrices(null);
    }
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const m = await apiJson<Meta>('/api/confirmation/winback/bulk');
        if (!live) return;
        setMeta(m && m.canBulk === true && Array.isArray(m.agents) ? m : 'none');
        if (m?.canBulk === true) await loadPrices();
      } catch {
        if (live) setMeta('none');
      }
    })();
    return () => {
      live = false;
    };
  }, [loadPrices]);

  if (meta === null || meta === 'none') return null;

  const priced = (prices?.products ?? []).filter((p) => p.price);
  const max = meta.max ?? 200;
  const n = Number(count);
  const countOk = Number.isInteger(n) && n >= 1 && n <= max;

  const preview = async () => {
    setBusy(true);
    setRun(null);
    try {
      const body = {
        action: 'bulk-preview',
        count: n,
        agentIds: agents,
        ...(productId ? { productId } : {}),
        ...(reason ? { reason } : {}),
        ...(period ? { period } : {}),
      };
      setPlan(await apiJson<Plan>('/api/confirmation/winback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    } catch (e) {
      setPlan(null);
      toast.failed(e instanceof Error ? e.message : 'تعذّر جلب الخطة');
    } finally {
      setBusy(false);
    }
  };

  const go = async () => {
    if (!plan || plan.planned.length === 0) return;
    setBusy(true);
    try {
      const body = { action: 'bulk-run', orderIds: plan.planned.map((p) => p.orderId), agentIds: agents };
      const a = await apiJson<RunAnswer>('/api/confirmation/winback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setRun(a);
      setPlan(null);
      toast.done(`انعمل ${a.created} طلب استرجاع`);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر التوزيع');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="وزّع على الموظفات"
        subtitle={`طلب استرجاع جديد لكل طلب ملغى جاهز، بسعر الاسترجاع المحدد للمنتج (شامل التوصيل)، ومحجوز للموظفة. طلب واحد لكل زبون، والأحدث أول. لحد ${max} طلب بالضغطة.`}
      />
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-sm space-y-1">
            <span className="block">المنتج</span>
            <select aria-label="المنتج" className={field} value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">كل المنتجات اللي إلها سعر</option>
              {priced.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm space-y-1">
            <span className="block">سبب الإلغاء</span>
            <select aria-label="سبب الإلغاء" className={field} value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">كل الأسباب</option>
              {(meta.reasons ?? []).map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm space-y-1">
            <span className="block">المدة</span>
            <select aria-label="المدة" className={field} value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="">كل المدة</option>
              {(meta.periods ?? []).map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <Input label={`العدد (لحد ${max})`} type="number" inputMode="numeric" min={1} max={max} value={count} onChange={(e) => setCount(e.target.value)} />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">وزّع على</legend>
          {(meta.agents ?? []).length === 0 ? (
            <p className="text-sm text-[var(--sys-muted-foreground)]">ما في موظفات تأكيد بيقدروا يستلموا بهالمتجر.</p>
          ) : (
            <div className="grid gap-2 md:grid-cols-3">
              {(meta.agents ?? []).map((a) => (
                <Checkbox
                  key={a.id}
                  checked={agents.includes(a.id)}
                  onChange={(on) => {
                    setPlan(null);
                    setAgents(on ? [...agents, a.id] : agents.filter((x) => x !== a.id));
                  }}
                  label={a.name}
                  hint={`بتقدر تاخد ${a.room} كمان`}
                />
              ))}
            </div>
          )}
        </fieldset>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" disabled={busy || !countOk || agents.length === 0} loading={busy && !plan} onClick={() => void preview()}>
            اعرض الخطة
          </Button>
          {plan && (
            <Button type="button" disabled={busy || plan.planned.length === 0} loading={busy} onClick={() => void go()}>
              {`وزّع ${plan.planned.length} طلب`}
            </Button>
          )}
        </div>

        {plan && (
          <div className="space-y-2 text-sm" aria-label="الخطة">
            <p>{`انقرا ${plan.scanned} طلب ملغى جاهز — رح ينعمل ${plan.planned.length} طلب استرجاع:`}</p>
            <ul className="space-y-1">
              {plan.perAgent.map((a) => (
                <li key={a.id}>{`${a.name}: ${a.count}`}</li>
              ))}
            </ul>
            {plan.skipped.length > 0 && (
              <>
                <p className="font-medium">انتركوا:</p>
                <ul className="space-y-1 text-[var(--sys-muted-foreground)]">
                  {plan.skipped.map((s) => (
                    <li key={s.code}>{`${s.reasonAr}: ${s.count}`}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {run && (
          <div className="space-y-2 text-sm" aria-label="النتيجة">
            <p>{`انعمل ${run.created} — وما انعمل ${run.failed}`}</p>
            {run.results.some((r) => !r.ok) && (
              <ul className="space-y-1 text-[var(--sys-muted-foreground)]">
                {run.results
                  .filter((r) => !r.ok)
                  .map((r) => (
                    <li key={r.orderId}>{`${r.orderNumber || '—'}: ${r.reasonAr ?? r.code ?? ''}`}</li>
                  ))}
              </ul>
            )}
          </div>
        )}

        {prices?.canEdit && <PricesEditor prices={prices} onSaved={loadPrices} />}
      </CardContent>
    </Card>
  );
}

/** «أسعار الاسترجاع» — one row per product: the total for one or two pieces, the total for three or more, and the currency. */
function PricesEditor({ prices, onSaved }: { prices: Prices; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, { one: string; three: string; currency: string }>>({});
  const [open, setOpen] = useState(false);

  const row = (id: string, p: Price | null) => draft[id] ?? { one: p ? String(p.one) : '', three: p ? String(p.three) : '', currency: p?.currency ?? prices.currency };

  const save = async (id: string, remove = false) => {
    const d = row(id, prices.products.find((p) => p.id === id)?.price ?? null);
    const body = remove ? { productId: id, remove: true } : { productId: id, one: Number(d.one), three: Number(d.three), currency: d.currency.trim().toUpperCase() };
    try {
      await apiJson('/api/confirmation/winback/prices', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setDraft((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== id)));
      await onSaved();
    } catch (e) {
      // Shown here and swallowed: the press must not leave an unhandled rejection behind it.
      toast.failed(e instanceof Error ? e.message : 'تعذّر الحفظ');
    }
  };

  return (
    <section className="space-y-2 border-t border-[var(--sys-border)] pt-4" aria-label="أسعار الاسترجاع">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">أسعار الاسترجاع</h4>
        <Button type="button" variant="quiet" size="sm" onClick={() => setOpen(!open)}>
          {open ? 'سكّر' : 'عدّل الأسعار'}
        </Button>
      </div>
      <p className="text-note text-[var(--sys-muted-foreground)]">السعر هو إجمالي الطلب شامل التوصيل. قطعة أو قطعتين = سعر القطعة؛ 3 قطع = سعر الـ3. طلب فيه أكتر من 3 قطع ما بينعرض لهلّق. منتج بلا سعر ما بينعرض.</p>
      {open &&
        prices.products.map((p) => {
          const d = row(p.id, p.price);
          const set = (k: 'one' | 'three' | 'currency', v: string) => setDraft({ ...draft, [p.id]: { ...d, [k]: v } });
          return (
            <div key={p.id} className="grid items-end gap-2 md:grid-cols-5">
              <span className="text-sm">{p.name}</span>
              <Input label="قطعة أو قطعتين" type="number" inputMode="decimal" value={d.one} onChange={(e) => set('one', e.target.value)} />
              <Input label="3 قطع أو أكتر" type="number" inputMode="decimal" value={d.three} onChange={(e) => set('three', e.target.value)} />
              <Input label="العملة" value={d.currency} maxLength={3} onChange={(e) => set('currency', e.target.value)} />
              <span className="flex gap-1">
                <Button type="button" size="sm" variant="secondary" onClick={() => save(p.id)}>
                  احفظ
                </Button>
                {p.price && (
                  <Button type="button" size="sm" variant="quiet" onClick={() => save(p.id, true)}>
                    شيل
                  </Button>
                )}
              </span>
            </div>
          );
        })}
    </section>
  );
}
