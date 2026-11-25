'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { RiAddLine, RiArrowLeftSLine, RiArrowRightSLine, RiCloseLine, RiLoader4Line, RiInboxArchiveLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { PageShell } from '@/components/ui/PageShell';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadFailed } from '@/components/ui/LoadFailed';
import { StatusChip } from '@/components/ui/StatusChip';
import { StatTile } from '@/components/ui/StatTile';
import { Money } from '@/components/ui/Money';
import type { StateTone } from '@/lib/order-state';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { useProducts } from '@/hooks/useProducts';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { routeLabel } from '@/lib/route-registry';
import { arDateTime } from '@/lib/format';
import { newId } from '@/lib/client-id';
import { PickedCombinations, badBox, mayHaveCombinations, shelfHint, typedCombinations, useProductCombinations } from '@/components/inventory/CombinationBoxes';

/**
 * /inventory/exits — «إخراج بضاعة» (the warehouse plan, request W6b): goods that leave a warehouse for good, not by a sale.
 * The doors and every rule are W6a's (`/api/inventory/exits`, `…/:id/approve|reject`, `lib/stock-exits.ts`); the month's table
 * is the reports lane's (`/api/inventory/exits/month`, `lib/stock-exit-report.ts`).
 *
 * TWO HANDS, VISIBLE. The person who asked never gets «اعتمد» or «ارفض» on her own request — the row says somebody else decides.
 * Hiding the press is manners only: the door refuses her by any route, a replay included.
 *
 * THIS FILE DOES NO ARITHMETIC ON A FIGURE. Every quantity, total and value at cost is the server's; the value at cost reaches
 * only a holder of `costs.view` (the door decides — the screen prints only what it gets), and an uncosted line is «بلا كلفة».
 *
 * The page opens on `inventory.view`; the request asks `inventory.exit`, the decision `inventory.exit_approve`.
 */

interface Warehouse {
  id: string;
  name: string;
}

interface ExitLine {
  productId: string;
  productName: string | null;
  quantity: number;
  /** 20/11 (W8c): present only on a line of a product with combinations. */
  variants?: { variantId: string; label: string | null; quantity: number }[];
}

/** A line as the list and the decision dialogs say it: the product's quantity, and each of its combinations under it. */
function ExitLineText({ l }: { l: ExitLine }) {
  return (
    <>
      <span className="block text-sm">
        {l.productName ?? 'منتج'}:{' '}
        <span className="tabular-nums font-bold" dir="ltr">
          {l.quantity}
        </span>
      </span>
      {(l.variants ?? []).map((v) => (
        <span key={v.variantId} className="block ps-3 text-note" data-variant={v.variantId}>
          {v.label ?? 'خيار'}:{' '}
          <span className="tabular-nums font-bold" dir="ltr">
            {v.quantity}
          </span>
        </span>
      ))}
    </>
  );
}

export interface StockExitItem {
  id: string;
  warehouseId: string;
  warehouseName: string | null;
  reason: string;
  reasonAr: string;
  note: string | null;
  status: string;
  statusAr: string;
  requestedById: string;
  requestedByName: string | null;
  requestedAt: string;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
  lines: ExitLine[];
}

interface ListAnswer {
  warehouses: Warehouse[];
  reasons: { reason: string; ar: string }[];
  exits: StockExitItem[];
}

interface MonthSum {
  quantity: number;
  lines: number;
  /** Present for a holder of the cost key only. */
  valueAtCost?: number;
  uncostedLines?: number;
}

interface MonthLine {
  exitId: string;
  decidedAt: string;
  warehouseName: string | null;
  reasonAr: string;
  note: string | null;
  productId: string;
  productName: string | null;
  quantity: number;
  requestedByName: string | null;
  decidedByName: string | null;
  valueAtCost?: number | null;
  uncosted?: boolean;
}

interface MonthAnswer {
  month: string;
  monthAr: string;
  current: boolean;
  prev: string;
  next: string | null;
  truncated: boolean;
  exits: number;
  seesCost: boolean;
  lines: MonthLine[];
  reasons: (MonthSum & { reason: string; reasonAr: string })[];
  total: MonthSum;
}

const TONE: Record<string, StateTone> = {
  PENDING: 'warn',
  APPROVED: 'good',
  REJECTED: 'neutral',
};

/** The sentence that keeps an exit from being read as a sale: it adds to «خرج» on the balances screen, and is not one. */
export const NOT_SALES_AR = 'هالقطع بتنعدّ ضمن «خرج» بأرصدة المخزون، بس مش مبيعات: طلعت بلا بيع وبلا أي أثر على الربح.';

const WHOLE = /^\d+$/;

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function Refusal({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
      {text}
    </p>
  );
}

/** A value at cost as the server sent it: a figure, «بلا كلفة» for an uncosted line, nothing at all without the cost key. */
function Value({ value, uncosted }: { value: number | null | undefined; uncosted?: boolean }) {
  if (uncosted) return <span className="font-bold text-[var(--sys-warning)]">بلا كلفة</span>;
  if (value === undefined || value === null) return null;
  return <Money value={value} />;
}

/** A sum's value at cost, with its uncosted lines said beside it — never folded into the figure as a zero. */
function SumValue({ s }: { s: MonthSum }) {
  if (s.valueAtCost === undefined) return null;
  return (
    <>
      <Money value={s.valueAtCost} />
      {(s.uncostedLines ?? 0) > 0 && (
        <span className="block text-note text-[var(--sys-warning)]">
          و<span className="tabular-nums" dir="ltr">{s.uncostedLines}</span> سطر بلا كلفة
        </span>
      )}
    </>
  );
}

export function StockExitsScreen() {
  const { currentUser } = useApp();
  const me = (currentUser as { id?: string } | null | undefined)?.id ?? null;
  const canAsk = userCan(currentUser, 'inventory.exit');
  const canDecide = userCan(currentUser, 'inventory.exit_approve');

  const [view, setView] = useState('list');
  const [data, setData] = useState<ListAnswer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [only, setOnly] = useState('all');
  const [creating, setCreating] = useState(false);
  const [approving, setApproving] = useState<StockExitItem | null>(null);
  const [rejecting, setRejecting] = useState<StockExitItem | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setData(await apiJson<ListAnswer>('/api/inventory/exits'));
    } catch (e) {
      setLoadError(errorText(e, 'تعذّر تحميل طلبات الإخراج'));
    }
  }, []);
  useLiveRefresh(load);

  const done = (sentence: string) => {
    setCreating(false);
    setApproving(null);
    setRejecting(null);
    setSaid(sentence);
    void load();
  };

  const exits = useMemo(() => data?.exits ?? [], [data]);
  const count = (status: string) => exits.filter((e) => e.status === status).length;
  const shown = exits.filter((e) => (only === 'all' ? true : e.status === only));
  const warehouses = data?.warehouses ?? [];

  const actions = (e: StockExitItem) => {
    if (e.status !== 'PENDING') return null;
    const mine = me !== null && e.requestedById === me;
    // TWO HANDS: the requester is never offered the decision on her own request.
    if (mine) return <span className="text-note text-[var(--sys-muted-foreground)]">بيعتمده حدا غيرك</span>;
    if (!canDecide) return null;
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => setApproving(e)}>
          اعتمد
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setRejecting(e)}>
          ارفض
        </Button>
      </div>
    );
  };

  return (
    <PageShell
      title={routeLabel('/inventory/exits')}
      description="بضاعة بتطلع من المخزن نهائياً بلا بيع: تالف، منتهي، عيّنات، مرتجع للمورّد… ما بتطلع إلا لما حدا تاني يعتمد."
      width="wide"
      actions={
        canAsk && warehouses.length > 0 ? (
          <Button type="button" onClick={() => setCreating(true)}>
            طلب إخراج
          </Button>
        ) : undefined
      }
      filters={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            aria-label="طريقة العرض"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: 'الطلبات' },
              { value: 'month', label: 'تقرير الشهر' },
            ]}
          />
          {view === 'list' && data && exits.length > 0 && (
            <Segmented
              aria-label="أي طلبات"
              size="sm"
              value={only}
              onChange={setOnly}
              options={[
                { value: 'all', label: 'الكل', count: exits.length },
                { value: 'PENDING', label: 'مستني اعتماد', count: count('PENDING') },
                { value: 'APPROVED', label: 'طلع', count: count('APPROVED') },
                { value: 'REJECTED', label: 'مرفوض', count: count('REJECTED') },
              ]}
            />
          )}
        </div>
      }
    >
      {said && (
        <p role="status" className="rounded-lg border border-[var(--sys-success)]/30 bg-[var(--sys-success-soft)] p-2.5 text-sm text-[var(--sys-success)]">
          {said}
        </p>
      )}

      {view === 'month' ? (
        <MonthReport />
      ) : loadError ? (
        <LoadFailed message={loadError} onRetry={() => void load()} />
      ) : !data ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : (
        <>
          {warehouses.length === 0 && (
            <Card plain padding="sm">
              <p className="text-sm text-[var(--sys-muted-foreground)]">
                الإخراج بيكون من مخزن. المخازن بتنعرّف من «البلدان والمدن» تحت كل بلد، وبعدين بيتوزّع رصيد المتجر عليها.
              </p>
            </Card>
          )}
          {exits.length === 0 ? (
            <EmptyState
              icon={RiInboxArchiveLine}
              title="ما في طلبات إخراج لسا"
              why="كل بضاعة بتطلع من مخزن بلا بيع بتبين هون: من وين، ليش، مين طلب، ومين اعتمد."
            />
          ) : (
            <Card plain className="overflow-hidden">
              <Rows
                rows={shown}
                keyOf={(e) => e.id}
                columns={[
                  { key: 'when', label: 'التاريخ', primary: true, render: (e) => arDateTime(e.requestedAt) },
                  {
                    key: 'why',
                    label: 'السبب',
                    primary: true,
                    render: (e) => (
                      <>
                        {e.reasonAr}
                        <span className="block text-note text-[var(--sys-muted)]">{e.warehouseName ?? '—'}</span>
                        {e.note && <span className="block text-note text-[var(--sys-muted-foreground)]">{e.note}</span>}
                      </>
                    ),
                  },
                  {
                    key: 'lines',
                    label: 'البضاعة',
                    render: (e) => (
                      <>
                        {e.lines.map((l) => (
                          <ExitLineText key={l.productId} l={l} />
                        ))}
                      </>
                    ),
                  },
                  {
                    key: 'status',
                    label: 'الحالة',
                    render: (e) => (
                      <>
                        <StatusChip tone={TONE[e.status] ?? 'neutral'}>{e.statusAr}</StatusChip>
                        {e.status === 'REJECTED' && e.rejectReason && (
                          <span className="block text-note text-[var(--sys-muted-foreground)]">السبب: {e.rejectReason}</span>
                        )}
                      </>
                    ),
                  },
                  {
                    key: 'who',
                    label: 'مين',
                    hideOnPhone: true,
                    render: (e) => (
                      <>
                        طلبه: {e.requestedByName ?? '—'}
                        {e.decidedByName && (
                          <span className="block text-note text-[var(--sys-muted)]">
                            {e.status === 'REJECTED' ? 'رفضه' : 'اعتمده'}: {e.decidedByName}
                          </span>
                        )}
                      </>
                    ),
                  },
                ]}
                actions={actions}
                empty={<EmptyState title="ولا طلب بهالحالة" why="اختار «الكل» لتشوف كل الطلبات." />}
              />
            </Card>
          )}
        </>
      )}

      {creating && data && (
        <RequestDialog
          warehouses={warehouses}
          reasons={data.reasons}
          onClose={() => setCreating(false)}
          onDone={() => done('انطلب الإخراج — البضاعة موقوفة لحد ما حدا تاني يعتمد.')}
        />
      )}
      {approving && <ApproveDialog exit={approving} onClose={() => setApproving(null)} onDone={() => done('انعتمد الإخراج — البضاعة طلعت من المخزن.')} />}
      {rejecting && <RejectDialog exit={rejecting} onClose={() => setRejecting(null)} onDone={() => done('انرفض الإخراج — البضاعة رجعت حرّة بمخزنها.')} />}
    </PageShell>
  );
}

/* ───────────────────────────── the month's table ───────────────────────────── */

function MonthReport() {
  // The month asked; null is the store's current month, which the server names.
  const month = useRef<string | null>(null);
  const [answer, setAnswer] = useState<MonthAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const m = month.current;
    setError(null);
    try {
      setAnswer(await apiJson<MonthAnswer>(m ? `/api/inventory/exits/month?month=${encodeURIComponent(m)}` : '/api/inventory/exits/month'));
    } catch (e) {
      setError(errorText(e, 'تعذّر تحميل تقرير الشهر'));
    }
  }, []);
  useLiveRefresh(load);
  const go = (m: string) => {
    month.current = m;
    void load();
  };

  if (error) return <LoadFailed message={error} onRetry={() => void load()} />;
  if (!answer) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  const cost = answer.seesCost;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconButton label="الشهر اللي قبله" onClick={() => go(answer.prev)}>
          <RiArrowLeftSLine className="icon-mirror h-4 w-4" />
        </IconButton>
        <span className="text-sm font-bold text-[var(--sys-heading)]" data-month={answer.month}>
          {answer.monthAr}
        </span>
        <IconButton label="الشهر اللي بعده" onClick={() => answer.next && go(answer.next)} disabled={!answer.next}>
          <RiArrowRightSLine className="icon-mirror h-4 w-4" />
        </IconButton>
      </div>

      <p className="rounded-lg bg-[var(--sys-surface)] p-2.5 text-sm text-[var(--sys-foreground)]">{NOT_SALES_AR}</p>
      {answer.truncated && (
        <p className="text-note text-[var(--sys-warning)]">الشهر فيه كتير إخراجات — هاد أول جزء منها بس.</p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="طلبات طلعت" value={answer.exits} />
        <StatTile label="قطع طلعت" value={answer.total.quantity} />
        {cost && (
          <StatTile
            label="قيمتها بالكلفة"
            value={<Money value={answer.total.valueAtCost ?? 0} />}
            caption={(answer.total.uncostedLines ?? 0) > 0 ? `و${answer.total.uncostedLines} سطر بلا كلفة` : undefined}
          />
        )}
      </div>

      {answer.lines.length === 0 ? (
        <EmptyState icon={RiInboxArchiveLine} title="ما طلع شي بهالشهر" why="بس الإخراج المعتمد بينعدّ هون، بشهر اعتماده." />
      ) : (
        <>
          <Card plain className="overflow-hidden">
            <Rows
              rows={answer.reasons}
              keyOf={(r) => r.reason}
              columns={[
                { key: 'reason', label: 'السبب', primary: true, render: (r) => r.reasonAr },
                {
                  key: 'qty',
                  label: 'القطع',
                  primary: true,
                  render: (r) => (
                    <span className="tabular-nums font-bold" dir="ltr">
                      {r.quantity}
                    </span>
                  ),
                },
                ...(cost ? [{ key: 'value', label: 'القيمة بالكلفة', render: (r: MonthSum) => <SumValue s={r} /> }] : []),
              ]}
            />
          </Card>

          <Card plain className="overflow-hidden">
            <Rows
              rows={answer.lines}
              keyOf={(l) => `${l.exitId}:${l.productId}`}
              columns={[
                { key: 'when', label: 'اعتُمد', primary: true, render: (l) => arDateTime(l.decidedAt) },
                {
                  key: 'what',
                  label: 'البضاعة',
                  primary: true,
                  render: (l) => (
                    <>
                      {l.productName ?? 'منتج'}:{' '}
                      <span className="tabular-nums font-bold" dir="ltr">
                        {l.quantity}
                      </span>
                    </>
                  ),
                },
                {
                  key: 'why',
                  label: 'السبب',
                  render: (l) => (
                    <>
                      {l.reasonAr}
                      <span className="block text-note text-[var(--sys-muted)]">{l.warehouseName ?? '—'}</span>
                      {l.note && <span className="block text-note text-[var(--sys-muted-foreground)]">{l.note}</span>}
                    </>
                  ),
                },
                {
                  key: 'who',
                  label: 'مين',
                  hideOnPhone: true,
                  render: (l) => (
                    <>
                      طلبه: {l.requestedByName ?? '—'}
                      <span className="block text-note text-[var(--sys-muted)]">اعتمده: {l.decidedByName ?? '—'}</span>
                    </>
                  ),
                },
                ...(cost
                  ? [{ key: 'value', label: 'القيمة بالكلفة', render: (l: MonthLine) => <Value value={l.valueAtCost} uncosted={l.uncosted} /> }]
                  : []),
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}

/* ───────────────────────────── request ───────────────────────────── */

interface DraftLine {
  key: number;
  productId: string;
  quantity: string;
  /** 20/11 (W8c): the combination boxes as typed, by combination id (a product without combinations: always empty). */
  combos: Record<string, string>;
}

function RequestDialog({
  warehouses,
  reasons,
  onClose,
  onDone,
}: {
  warehouses: Warehouse[];
  reasons: { reason: string; ar: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { products } = useProducts();
  const [id] = useState(newId);
  const [warehouseId, setWarehouseId] = useState(warehouses.length === 1 ? warehouses[0].id : '');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ key: 1, productId: '', quantity: '', combos: {} }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const combinations = useProductCombinations();

  /** The active combinations of a line's product — none for a product without options (it is never asked about). */
  const combosOf = (productId: string) => {
    const k = combinations.known[productId];
    return Array.isArray(k) ? k : [];
  };
  const pick = (key: number, productId: string) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, productId, combos: {} } : l)));
    if (mayHaveCombinations(products.find((p) => p.id === productId) as { variantOptions?: string | null } | undefined)) combinations.ask(productId);
  };
  const source = warehouses.find((w) => w.id === warehouseId);

  const other = reason === 'OTHER';
  const badQty = lines.some((l) => l.quantity.trim() !== '' && (!WHOLE.test(l.quantity.trim()) || Number(l.quantity) <= 0));
  const badCombo = lines.some((l) => Object.values(l.combos).some(badBox));
  const linesReady = lines.every((l) => l.productId !== '' && WHOLE.test(l.quantity.trim()) && Number(l.quantity) > 0);
  const ready = warehouseId !== '' && reason !== '' && (!other || note.trim().length >= 3) && linesReady && !badCombo && !busy;

  const setLine = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/inventory/exits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          warehouseId,
          reason,
          note: note.trim() || null,
          lines: lines.map((l) => {
            // 20/11 (W8c): the combinations asked out, as typed — a line without any goes out exactly as before.
            const variants = typedCombinations(combosOf(l.productId), l.combos, { dropZero: true });
            return { productId: l.productId, quantity: Number(l.quantity.trim()), ...(variants.length > 0 ? { variants } : {}) };
          }),
        }),
        timeoutMs: 60_000,
      });
      onDone();
    } catch (e) {
      setError(errorText(e, 'تعذّر الطلب'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="طلب إخراج"
      subtitle="البضاعة بتنوقف هلّق، وما بتطلع من المخزن إلا لما حدا تاني يعتمد"
      maxWidth="2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            رجوع
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!ready} loading={busy}>
            اطلب
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-[var(--sys-foreground)]">من مخزن</span>
          <Segmented aria-label="من مخزن" value={warehouseId} onChange={setWarehouseId} options={warehouses.map((w) => ({ value: w.id, label: w.name }))} />
        </div>

        <Select label="سبب الإخراج" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">اختار السبب</option>
          {reasons.map((r) => (
            <option key={r.reason} value={r.reason}>
              {r.ar}
            </option>
          ))}
        </Select>

        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={l.key} className="space-y-1.5">
              <div className="flex flex-wrap items-end gap-2">
                <ProductPicker products={products} value={l.productId} onChange={(productId) => pick(l.key, productId)} className="flex-1" />
                <Input
                  aria-label={`كمية السطر ${i + 1}`}
                  inputMode="numeric"
                  dir="ltr"
                  placeholder="الكمية"
                  value={l.quantity}
                  onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                />
                {lines.length > 1 && (
                  <IconButton label={`شيل السطر ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    <RiCloseLine className="h-4 w-4" />
                  </IconButton>
                )}
              </div>
              <PickedCombinations
                state={combinations.known[l.productId]}
                combos={combosOf(l.productId).map((c) => ({ variantId: c.variantId, label: c.label, hint: shelfHint(c, source) }))}
                values={l.combos}
                onChange={(variantId, value) => setLine(l.key, { combos: { ...l.combos, [variantId]: value } })}
                line={i + 1}
              />
            </div>
          ))}
          {badQty && <p className="text-note text-[var(--sys-destructive)]">الكمية لازم تكون رقم صحيح أكبر من صفر.</p>}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setLines((ls) => [...ls, { key: Math.max(...ls.map((x) => x.key)) + 1, productId: '', quantity: '', combos: {} }])}
          >
            <RiAddLine className="h-4 w-4" /> زيد منتج
          </Button>
        </div>

        <Textarea
          label={other ? 'ليش طالعة البضاعة؟ *' : 'ملاحظة'}
          helperText={other ? 'سبب «أخرى» بدّو جملة بتشرح ليش.' : undefined}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
        <Refusal text={error} />
      </div>
    </Modal>
  );
}

/* ───────────────────────────── approve ───────────────────────────── */

function Summary({ exit }: { exit: StockExitItem }) {
  return (
    <div className="space-y-1">
      <span className="block text-sm">
        <span className="font-bold">{exit.reasonAr}</span> · {exit.warehouseName ?? '—'} · طلبه {exit.requestedByName ?? '—'}
      </span>
      {exit.lines.map((l) => (
        <ExitLineText key={l.productId} l={l} />
      ))}
      {exit.note && <span className="block text-note text-[var(--sys-muted-foreground)]">{exit.note}</span>}
    </div>
  );
}

function ApproveDialog({ exit, onClose, onDone }: { exit: StockExitItem; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/inventory/exits/${exit.id}/approve`, { method: 'POST', timeoutMs: 60_000 });
      onDone();
    } catch (e) {
      setError(errorText(e, 'تعذّر الاعتماد'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="اعتماد إخراج"
      subtitle="البضاعة بتطلع من المخزن نهائياً، الأقدم أول. ما في شي بينحسب على الربح أو المحافظ."
      maxWidth="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            رجوع
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy} loading={busy}>
            اعتمد الإخراج
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Summary exit={exit} />
        <Refusal text={error} />
      </div>
    </Modal>
  );
}

/* ───────────────────────────── reject ───────────────────────────── */

function RejectDialog({ exit, onClose, onDone }: { exit: StockExitItem; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/inventory/exits/${exit.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      onDone();
    } catch (e) {
      setError(errorText(e, 'تعذّر الرفض'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="رفض إخراج"
      subtitle="البضاعة بترجع حرّة بمخزنها، وما بينمحى شي"
      maxWidth="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            رجوع
          </Button>
          <Button type="button" variant="danger" onClick={() => void submit()} disabled={reason.trim().length < 3 || busy} loading={busy}>
            ارفض الإخراج
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Summary exit={exit} />
        <Textarea label="سبب الرفض *" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        <Refusal text={error} />
      </div>
    </Modal>
  );
}
