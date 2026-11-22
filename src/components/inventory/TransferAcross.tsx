'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { RiAddLine, RiCloseLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import { StatTile } from '@/components/ui/StatTile';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { useConfirm } from '@/components/ui/Confirm';
import { amount, plainNumber, type Currency } from '@/lib/format';

/**
 * THE PARTS OF «نقل البضاعة» THAT ONLY A TRANSFER ACROSS STORES HAS (the warehouse plan, request W7c):
 *
 *   `usePairs` + `TwinPicker`   the product's twin in the other store — proposed by the door (same code first, then the
 *                               same name), chosen by a person, saved, and removable (W7a's doors `/api/inventory/pairs`).
 *                               A product with no twin is not sent across: the form says so and keeps the press shut.
 *   `LandedCostLines`          at receipt, what bringing the goods cost — transport, customs, other — in the receiving
 *                               store's currency, as lines the receiver adds and removes. The SERVER puts them into the
 *                               unit cost (`stock-transfer-cost.arrivalCost`); nothing here adds them up.
 *   `RoadReport`               «بضاعة بالطريق» — the door's own report (`stock-transfer-road.roadReport`), drawn as it came.
 *
 * NO ARITHMETIC ON A FIGURE: every count and every cost is the server's; this file only prints them.
 */

const muted = 'text-note text-[var(--sys-muted-foreground)]';

/* ───────────────────────────── the twin ───────────────────────────── */

interface Shown {
  id: string;
  name: string | null;
  sku: string | null;
}

interface PairsAnswer {
  pairs: { id: string; product: Shown; otherProduct: Shown; otherStore: { id: string } }[];
  proposals: { hintAr: string; sure: boolean; product: Shown; candidates: Shown[] }[] | null;
  otherProducts: Shown[] | null;
}

export interface PairsState {
  /** The pair of a product of this store with the other store, by product id. */
  twinOf: Map<string, { pairId: string; twin: Shown }>;
  proposalsOf: Map<string, { hintAr: string; sure: boolean; candidates: Shown[] }>;
  otherProducts: Shown[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** The pairs of this store with ONE other store (null = none chosen: nothing is asked). */
export function usePairs(otherStoreId: string | null): PairsState {
  // Each answer remembers which store it is for: a store changed meanwhile never shows the last one's pairs.
  const [got, setGot] = useState<{ storeId: string; answer: PairsAnswer | null; error: string | null } | null>(null);

  const reload = useCallback(async () => {
    if (!otherStoreId) return;
    try {
      const answer = await apiJson<PairsAnswer>(`/api/inventory/pairs?otherStoreId=${encodeURIComponent(otherStoreId)}`);
      setGot({ storeId: otherStoreId, answer, error: null });
    } catch (e) {
      setGot({ storeId: otherStoreId, answer: null, error: errorText(e, 'تعذّر تحميل ربط المنتجات') });
    }
  }, [otherStoreId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = got && got.storeId === otherStoreId ? got : null;
  const answer = current?.answer ?? null;
  const pairs = (answer?.pairs ?? []).filter((p) => p.otherStore.id === otherStoreId);
  return {
    twinOf: new Map(pairs.map((p) => [p.product.id, { pairId: p.id, twin: p.otherProduct }])),
    proposalsOf: new Map((answer?.proposals ?? []).map((x) => [x.product.id, { hintAr: x.hintAr, sure: x.sure, candidates: x.candidates }])),
    otherProducts: answer?.otherProducts ?? [],
    loading: !!otherStoreId && !current,
    error: current?.error ?? null,
    reload,
  };
}

const named = (p: Shown) => (p.sku ? `${p.name ?? 'منتج'} (${p.sku})` : p.name ?? 'منتج');

/**
 * The twin of ONE line's product. Paired: its name, and «فك الربط». Not paired: the sentence that it cannot go, the
 * door's proposals as one press each, and a picker of the other store's unpaired products with «احفظ الربط».
 */
export function TwinPicker({
  productId,
  productName,
  storeName,
  pairs,
  line,
}: {
  productId: string;
  productName: string;
  storeName: string;
  pairs: PairsState;
  line: number;
}) {
  const confirm = useConfirm();
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pair = pairs.twinOf.get(productId);
  const proposal = pairs.proposalsOf.get(productId);

  async function save(otherProductId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/inventory/pairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, otherProductId }),
      });
      setChosen('');
      await pairs.reload();
    } catch (e) {
      setError(errorText(e, 'تعذّر حفظ الربط'));
    } finally {
      setBusy(false);
    }
  }

  async function unpair(pairId: string, twinName: string) {
    // A pair is undone by saving it again, but it asks first, like every delete of the dashboard.
    const ok = await confirm({
      title: `فك ربط «${productName}» بـ«${twinName}»؟`,
      body: `بعدها ما بينبعت لـ${storeName} لحد ما تربطه من جديد.`,
      confirmLabel: 'فك الربط',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/inventory/pairs/${encodeURIComponent(pairId)}`, { method: 'DELETE' });
      await pairs.reload();
    } catch (e) {
      setError(errorText(e, 'تعذّر فك الربط'));
    } finally {
      setBusy(false);
    }
  }

  if (pairs.loading && !pair) return <p className={muted}>جارٍ البحث عن توأم «{productName}»…</p>;

  if (pair) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-twin={productId}>
        <span className="text-note text-[var(--sys-muted-foreground)]">
          بيدخل على توأمه بـ{storeName}: <span className="font-bold">{named(pair.twin)}</span>
        </span>
        <Button type="button" size="sm" variant="secondary" onClick={() => void unpair(pair.pairId, named(pair.twin))} disabled={busy}>
          فك الربط
        </Button>
        <Refusal text={error} />
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-no-twin={productId}>
      <p className="rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] p-2.5 text-sm text-[var(--sys-warning)]">
        «{productName}» ما إله توأم بـ{storeName}، وما بينبعت لمتجر تاني بلا توأم. اختار توأمه واحفظ الربط.
      </p>
      {proposal && proposal.candidates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className={muted}>اقتراح ({proposal.hintAr}):</span>
          {proposal.candidates.map((c) => (
            <Button key={c.id} type="button" size="sm" onClick={() => void save(c.id)} disabled={busy}>
              اربط بـ{named(c)}
            </Button>
          ))}
        </div>
      )}
      {pairs.otherProducts.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <ProductPicker
            products={pairs.otherProducts.map((p) => ({ id: p.id, name: p.name ?? 'منتج', sku: p.sku }))}
            value={chosen}
            onChange={setChosen}
            placeholder={`ابحث عن توأم السطر ${line} بـ${storeName}…`}
            className="flex-1"
          />
          <Button type="button" size="sm" onClick={() => void save(chosen)} disabled={!chosen || busy} loading={busy}>
            احفظ الربط
          </Button>
        </div>
      ) : (
        !pairs.loading && <p className={muted}>ما في منتج بـ{storeName} بلا ربط. ضيف المنتج هناك أول.</p>
      )}
      <Refusal text={error ?? pairs.error} />
    </div>
  );
}

/* ───────────────────────────── landed cost lines (receipt) ───────────────────────────── */

export const LANDED_KIND_AR: Record<string, string> = { TRANSPORT: 'شحن', CUSTOMS: 'جمرك', OTHER: 'غيره' };

export interface LandedDraft {
  key: number;
  kind: string;
  amount: string;
  note: string;
}

const MONEY = /^\d+(\.\d+)?$/;

/** A typed amount is a plain number of zero or more (the door checks it again, and rounds it to the currency). */
export const badAmount = (l: LandedDraft) => l.amount.trim() !== '' && !MONEY.test(l.amount.trim());
/** A line is ready when it has an amount, and «غيره» says what it was. */
export const landedReady = (l: LandedDraft) =>
  MONEY.test(l.amount.trim()) && (l.kind !== 'OTHER' || l.note.trim().length >= 2);

/** The lines as the door takes them: `{ kind, amount, note }`. Empty rows are not sent. */
export function landedBody(lines: readonly LandedDraft[]) {
  return lines
    .filter((l) => l.amount.trim() !== '')
    .map((l) => ({ kind: l.kind, amount: Number(l.amount.trim()), ...(l.note.trim() ? { note: l.note.trim() } : {}) }));
}

export function LandedCostLines({
  productName,
  currency,
  lines,
  onChange,
  inSource = false,
}: {
  productName: string;
  /** The receiving store's currency, when the door told it; otherwise the lines say «بعملة المتجر اللي استلم». */
  currency: Currency | null;
  lines: LandedDraft[];
  onChange: (lines: LandedDraft[]) => void;
  /** 22/11 (F2): between two currencies the lines are in the SENDING store's currency (`currency` is then that one). */
  inSource?: boolean;
}) {
  const fallback = inSource ? '(بعملة المتجر اللي بعت)' : '(بعملة المتجر اللي استلم)';
  const set = (key: number, patch: Partial<LandedDraft>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const add = () => onChange([...lines, { key: Math.max(0, ...lines.map((l) => l.key)) + 1, kind: 'TRANSPORT', amount: '', note: '' }]);
  return (
    <div className="space-y-1.5" data-landed={productName}>
      <span className="block text-sm font-medium text-[var(--sys-foreground)]">
        مصاريف وصول «{productName}» {currency ? `(بـ${currency.code})` : fallback}
      </span>
      <p className={muted}>شحن، جمرك، أو غيره. بتنزاد على كلفة القطعة هون، وما بتنحسب مصروف.</p>
      {lines.map((l, i) => (
        <div key={l.key} className="flex flex-wrap items-end gap-2">
          <Segmented
            aria-label={`نوع مصروف ${i + 1} لـ«${productName}»`}
            size="sm"
            value={l.kind}
            onChange={(kind) => set(l.key, { kind })}
            options={Object.entries(LANDED_KIND_AR).map(([value, label]) => ({ value, label }))}
          />
          <Input
            aria-label={`مبلغ مصروف ${i + 1} لـ«${productName}»`}
            inputMode="decimal"
            dir="ltr"
            placeholder="المبلغ"
            value={l.amount}
            onChange={(e) => set(l.key, { amount: e.target.value })}
          />
          <Input
            aria-label={`شو مصروف ${i + 1} لـ«${productName}»`}
            placeholder={l.kind === 'OTHER' ? 'شو هالمصروف؟' : 'ملاحظة (اختياري)'}
            value={l.note}
            maxLength={200}
            onChange={(e) => set(l.key, { note: e.target.value })}
          />
          <IconButton label={`شيل مصروف ${i + 1} لـ«${productName}»`} onClick={() => onChange(lines.filter((x) => x.key !== l.key))}>
            <RiCloseLine className="h-4 w-4" />
          </IconButton>
        </div>
      ))}
      {lines.some(badAmount) && <p className="text-note text-[var(--sys-destructive)]">المبلغ لازم يكون رقم من صفر وطالع.</p>}
      <Button type="button" variant="secondary" size="sm" onClick={add}>
        <RiAddLine className="h-4 w-4" /> زيد مصروف
      </Button>
    </div>
  );
}

/* ───────────────────────────── the exchange rate (F2, 22/11) ───────────────────────────── */

/** 22/11 (F2): the two currencies of a destination where they differ (the list door's `destinations[].rate`). */
export interface RateCurrencies {
  fromCode: string;
  toCode: string;
}

/** A typed rate the form may send: a plain number above zero (the door judges it again, and its upper bound). */
export const rateTyped = (text: string) => MONEY.test(text.trim()) && Number(text.trim()) > 0;

/**
 * «سعر الصرف» — asked ONLY when the two stores keep their costs in different currencies. One number: how much one unit
 * of the sending store's currency is worth in the receiving store's. The server converts; nothing here multiplies.
 */
export function ExchangeRateField({ currencies, value, onChange }: { currencies: RateCurrencies; value: string; onChange: (v: string) => void }) {
  const bad = value.trim() !== '' && !rateTyped(value);
  return (
    <div className="space-y-1.5" data-exchange-rate="ask">
      <Input
        label="سعر الصرف"
        aria-label="سعر الصرف"
        inputMode="decimal"
        dir="ltr"
        placeholder={`1 ${currencies.fromCode} = ؟ ${currencies.toCode}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className={muted}>
        المتجرين بعملتين: كم بتساوي 1 {currencies.fromCode} بـ{currencies.toCode}؟ الكلفة ومصاريف الوصول بتنكتب بـ{currencies.fromCode}، وبتتحوّل
        مرة وحدة لما ينستلم النقل. السعر بينحفظ مع النقل وما بيتغيّر.
      </p>
      {bad && <p className="text-note text-[var(--sys-destructive)]">سعر الصرف لازم يكون رقم أكبر من صفر.</p>}
    </div>
  );
}

/** «بسعر صرف R: X SYP = Y JOD» — the server's two figures of a received line between two currencies. */
export function ConvertedLine({
  converted,
  from,
  to,
  productId,
}: {
  converted: { rate: number; sourceTotal: number; total: number };
  from: Currency | null | undefined;
  to: Currency | null | undefined;
  productId: string;
}) {
  return (
    <span className="block text-note text-[var(--sys-muted-foreground)]" data-converted={productId}>
      بسعر صرف <span dir="ltr">{String(converted.rate)}</span>: {amount(converted.sourceTotal, from)} = {amount(converted.total, to)}
    </span>
  );
}

/* ───────────────────────────── «بضاعة بالطريق» ───────────────────────────── */

export interface RoadAnswer {
  onTheRoad: number;
  internal: number;
  across: number;
  totals: { storeId: string; storeName: string | null; currency: Currency | null; transfers: number; cost: number }[] | null;
  heldBack: number;
}

export function RoadReport({ road }: { road: RoadAnswer | null | undefined }) {
  if (!road || road.onTheRoad === 0) return null;
  return (
    <section aria-label="بضاعة بالطريق" className="space-y-2">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="بضاعة بالطريق"
          value={plainNumber(road.onTheRoad)}
          caption={`${plainNumber(road.internal)} داخل المتجر · ${plainNumber(road.across)} لمتجر تاني`}
        />
        {(road.totals ?? []).map((t) => (
          <StatTile
            key={t.storeId}
            label={`قيمة اللي طالع من ${t.storeName ?? 'متجر'}`}
            value={amount(t.cost, t.currency)}
            caption={`بكلفتها لما طلعت · ${plainNumber(t.transfers)} نقل`}
          />
        ))}
      </div>
      {road.heldBack > 0 && (
        <Card plain padding="sm">
          <p className={muted}>
            في {plainNumber(road.heldBack)} نقل قيمته مخفية عنك لأنك ممكن تستلمه — العدّ بيضل أعمى لحد ما ينستلم.
          </p>
        </Card>
      )}
    </section>
  );
}

export function Refusal({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
      {text}
    </p>
  );
}
