'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RiAlertLine, RiArrowLeftLine, RiLoader4Line } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Money } from '@/components/ui/Money';
import { Rows, type Column } from '@/components/ui/Rows';
import {
  REVIEW_UNAVAILABLE_AR,
  shutReason,
  type ReviewLine,
  type ReviewPreview,
  type ReviewTotals,
} from '@/lib/change-request-review';
import type { PublicStockEffect, StockStatus } from '@/lib/order-line-edit';

/**
 * A REQUEST THAT EDITS SEVERAL LINES, AS THE PERSON DECIDING IT NEEDS TO READ IT.
 *
 * «طلب التعديل أقدر أعدل كذا شغلة بنفس الوقت … والأهم الحساب والمخزون». Every figure on this screen came from the
 * server (`GET /api/control/change-requests/:id/preview`): what the order comes to now and what it would come to with
 * the request carried out, line by line, the shelf, the reasons it cannot be carried out, and what moved since it was
 * raised. This file adds nothing up and prices nothing; it lays the server's answer out, before ← after.
 *
 * It tells its parent ONE thing besides drawing: `shut` — the sentence for a button that must not be pressed, or `null`.
 * A request that cannot be checked is shut too: «اعتُمد ويستحيل تطبيقه» is the state this exists to prevent, and a
 * decider who could not see the check must not be the one who skips it. Rejecting is never shut by it.
 *
 * `variant="gate"` is the short form for a card in the queue: the total, the reasons and what moved — not the tables.
 */

export interface Verdict {
  /** The check is still in the air. */
  checking: boolean;
  /** The sentence that shuts the button, or `null` when nothing stops it. */
  shut: string | null;
}

type Loaded = { phase: 'loading' } | { phase: 'ready'; preview: ReviewPreview } | { phase: 'failed'; error: string };

/** The preview of one request. `refreshKey` re-asks when the order moved under the screen. */
export function useRequestPreview(requestId: string, refreshKey?: unknown): { state: Loaded; reload: () => void } {
  const [state, setState] = useState<Loaded>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    apiJson<ReviewPreview>(`/api/control/change-requests/${requestId}/preview`)
      .then((preview) => {
        if (live) setState({ phase: 'ready', preview });
      })
      .catch((e: unknown) => {
        if (live) setState({ phase: 'failed', error: e instanceof Error ? e.message : REVIEW_UNAVAILABLE_AR });
      });
    return () => {
      live = false;
    };
  }, [requestId, refreshKey, attempt]);

  const reload = useCallback(() => {
    setState({ phase: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  return { state, reload };
}

/** What the parent is told, derived once so the card and the dialog read the same answer. */
export function verdictOf(state: Loaded): Verdict {
  if (state.phase === 'loading') return { checking: true, shut: null };
  if (state.phase === 'failed') return { checking: false, shut: REVIEW_UNAVAILABLE_AR };
  return { checking: false, shut: shutReason(state.preview.problems) };
}

/* ───────────────────────────── the pieces ───────────────────────────── */

const ARROW = <RiArrowLeftLine className="icon-mirror w-4 h-4 text-[var(--sys-primary)] shrink-0" />;

/** `from ← to` when it moved, the figure alone when it did not. Equality of two numbers the server rounded, nothing more. */
function Pair({ from, to, show }: { from: number; to: number; show: (n: number) => React.ReactNode }) {
  if (from === to) return <span className="text-[var(--sys-heading)]">{show(to)}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-[var(--sys-muted)] line-through">{show(from)}</span>
      {ARROW}
      <span className="font-semibold text-[var(--sys-heading)]">{show(to)}</span>
    </span>
  );
}

function TextPair({ from, to }: { from: string; to: string }) {
  if (from === to) return <span className="text-[var(--sys-heading)]">{to}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-[var(--sys-muted)] line-through">{from}</span>
      {ARROW}
      <span className="font-semibold text-[var(--sys-heading)]">{to}</span>
    </span>
  );
}

const STOCK_AR: Record<StockStatus, string> = {
  UNCHANGED: 'ما تغيّر',
  FREES: 'يرجع للرف',
  ENOUGH: 'يكفي',
  SHORT_ALLOWED: 'ما بيكفي — مسموح',
  SHORT_BLOCKED: 'ما بيكفي',
  ALREADY_SHORT: 'النقص قديم وما زاد',
  NOT_HELD: 'غير محجوز بعد',
};

const TOTAL_ROWS: Array<{ key: keyof ReviewTotals; label: string; money: boolean; strong?: boolean }> = [
  { key: 'subtotal', label: 'مجموع الأسطر', money: true },
  { key: 'discount', label: 'الخصم', money: true },
  { key: 'deliveryFee', label: 'أجرة التوصيل', money: true },
  { key: 'cod', label: 'المطلوب من الزبون', money: true, strong: true },
  { key: 'giftUnits', label: 'القطع المجانية', money: false },
];

const box = 'rounded-lg border border-[var(--sys-border)]';
const sectionTitle = 'text-xs font-semibold text-[var(--sys-muted-foreground)] mb-1';

export function LinesRequestReview({
  requestId,
  variant = 'full',
  refreshKey,
  onVerdict,
}: {
  requestId: string;
  variant?: 'full' | 'gate';
  /** When this changes the check is made again (the order's version, on the queue). */
  refreshKey?: unknown;
  onVerdict?: (v: Verdict) => void;
}) {
  const { state, reload } = useRequestPreview(requestId, refreshKey);
  const tell = useRef(onVerdict);
  useEffect(() => {
    tell.current = onVerdict;
  });

  const { checking, shut } = verdictOf(state);
  useEffect(() => {
    tell.current?.({ checking, shut });
  }, [checking, shut]);

  if (state.phase === 'loading') {
    return (
      <p className="flex items-center gap-2 text-xs text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ حساب أثر الطلب على الطلب الحالي…
      </p>
    );
  }

  if (state.phase === 'failed') {
    return (
      <div className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-2.5 space-y-2">
        <p>{state.error}</p>
        <p>{REVIEW_UNAVAILABLE_AR}</p>
        <button
          type="button"
          onClick={reload}
          className="min-h-11 md:min-h-0 inline-flex items-center px-4 py-1.5 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] text-[var(--sys-foreground)] text-xs font-medium"
        >
          أعد الفحص
        </button>
      </div>
    );
  }

  const { preview } = state;
  const after = preview.after;
  const mu = preview.minorUnit;
  const money = (n: number) => <Money value={n} minorUnit={mu} />;
  const blocking = preview.problems.filter((p) => p.blocking);
  const warnings = preview.problems.filter((p) => !p.blocking);
  const shown = preview.lines.filter((l) => l.changed);
  const unchanged = preview.lines.filter((l) => !l.changed).length;
  const stockMoved = preview.stock.filter((s) => s.status !== 'UNCHANGED');

  const lineColumns: Column<ReviewLine>[] = [
    { key: 'product', label: 'المنتج', primary: true, render: (l) => <TextPair from={l.productName.from} to={l.productName.to} /> },
    { key: 'qty', label: 'الكمية', render: (l) => <Pair from={l.quantity.from} to={l.quantity.to} show={(n) => <span className="tabular-nums">{n}</span>} /> },
    { key: 'total', label: 'سعر السطر', render: (l) => <Pair from={l.lineTotal.from} to={l.lineTotal.to} show={money} /> },
    { key: 'gift', label: 'الهدية', render: (l) => <Pair from={l.freeQuantity.from} to={l.freeQuantity.to} show={(n) => <span className="tabular-nums">{n}</span>} /> },
  ];

  const stockColumns: Column<PublicStockEffect>[] = [
    { key: 'product', label: 'المنتج', primary: true, render: (s) => s.productName || 'منتج' },
    { key: 'units', label: 'القطع بالطلب', render: (s) => <Pair from={s.before} to={s.after} show={(n) => <span className="tabular-nums">{n}</span>} /> },
    {
      key: 'verdict',
      label: 'المخزون',
      render: (s) => (
        <span className={s.enough ? 'text-[var(--sys-heading)]' : 'font-semibold text-[var(--sys-destructive)]'}>
          {STOCK_AR[s.status]}
          {s.status === 'FREES' && <span className="tabular-nums"> ({s.freed})</span>}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {blocking.length > 0 && (
        <div className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-2.5 space-y-1">
          <p className="font-semibold">ما ينفع تنفيذ هذا الطلب الآن:</p>
          <ul className="space-y-1">
            {blocking.map((p, i) => (
              <li key={`${p.code}-${p.lineId ?? i}`}>{p.messageAr}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.drift.known && preview.drift.moved && (
        <div className="text-xs bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 text-[var(--sys-warning)] rounded-lg p-2.5 space-y-1">
          <p className="flex items-center gap-1.5 font-semibold">
            <RiAlertLine className="w-4 h-4 shrink-0" />
            تغيّر شيء منذ رفع الطلب:
          </p>
          <ul className="space-y-1">
            {preview.drift.items.map((d, i) => (
              <li key={`${d.kind}-${i}`}>{d.messageAr}</li>
            ))}
          </ul>
        </div>
      )}
      {!preview.drift.known && (
        <p className="text-xs text-[var(--sys-muted-foreground)]">هذا الطلب مرفوع بلا سجل لحالة الطلب وقت الرفع، فما بنقدر نقول إذا تغيّر شيء.</p>
      )}

      {/* The one figure a decision turns on, in both forms of the card. */}
      <p className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-[var(--sys-muted-foreground)]">المطلوب من الزبون:</span>
        {after ? <Pair from={preview.before.cod} to={after.cod} show={money} /> : <span className="text-[var(--sys-heading)]">{money(preview.before.cod)}</span>}
      </p>

      {variant === 'full' && (
        <>
          {after ? (
            <div>
              <p className={sectionTitle}>الحساب</p>
              <ul className={`${box} divide-y divide-[var(--sys-border)]`}>
                {TOTAL_ROWS.map((row) => (
                  <li key={row.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                    <span className="w-28 shrink-0 font-semibold text-[var(--sys-muted-foreground)]">{row.label}</span>
                    <Pair
                      from={preview.before[row.key]}
                      to={after[row.key]}
                      show={row.money ? money : (n) => <span className="tabular-nums">{n}</span>}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-[var(--sys-muted-foreground)]">ما في حساب لما بعد التعديل: الأسطر تغيّرت. هذا ما سُجّل في الطلب:</p>
          )}

          <div>
            <p className={sectionTitle}>الأسطر</p>
            <Rows
              columns={lineColumns}
              rows={shown}
              keyOf={(l) => l.lineId}
              empty={<p className="p-3 text-xs text-[var(--sys-muted)]">ما في سطر تغيّر.</p>}
            />
            {unchanged > 0 && <p className="pt-2 text-xs text-[var(--sys-muted-foreground)]">{unchanged} سطر بلا تغيير.</p>}
          </div>

          {stockMoved.length > 0 && (
            <div>
              <p className={sectionTitle}>المخزون</p>
              <Rows columns={stockColumns} rows={stockMoved} keyOf={(s) => s.productId} />
            </div>
          )}

          {warnings.length > 0 && (
            <div>
              <p className={sectionTitle}>للعلم</p>
              <ul className={`${box} divide-y divide-[var(--sys-border)]`}>
                {warnings.map((p, i) => (
                  <li key={`${p.code}-${p.lineId ?? i}`} className="flex items-start gap-1.5 px-3 py-2 text-xs text-[var(--sys-foreground)]">
                    <RiAlertLine className="w-4 h-4 text-[var(--sys-warning)] shrink-0 mt-0.5" />
                    {p.messageAr}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
