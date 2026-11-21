'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { RiAddLine, RiCloseLine, RiLoader4Line, RiClipboardLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { PageShell } from '@/components/ui/PageShell';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input, Textarea } from '@/components/ui/Input';
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
import { CombinationBoxes, badBox, typedCombinations } from '@/components/inventory/CombinationBoxes';

/**
 * /inventory/counts — «الجرد» (the warehouse plan, request W5b): the count against the keeper. The doors and every rule are
 * W5a's (`/api/inventory/counts`, `…/:id`, `…/:id/submit|approve|void`, `lib/stock-counts.ts`); «كشف عهدة الأمين» is the
 * reports lane's (`/api/inventory/counts/statement`, `lib/keeper-statement.ts`).
 *
 * BLIND, AND THE SCREEN KEEPS IT BLIND. The keeper who counts is never shown a book figure: the doors leave every such field
 * out of her answer, and this screen prints only fields the answer carries — it never works one out (no «counted − x», no
 * shelf hint beside a combination box: the boxes are drawn from the sheet's own `combinations`, a word and an id each).
 * The approval table (expected · counted · difference · value at cost) is drawn only when the server sent those fields.
 *
 * TWO HANDS, VISIBLE. Whoever opened, counted or submitted a sheet never gets «اعتمد» on it — the server says so
 * (`youCounted`); the approval door refuses her by any route anyway.
 *
 * THIS FILE DOES NO ARITHMETIC ON A FIGURE. Every expected figure, difference, total and value at cost is the server's.
 *
 * The page opens on `inventory.view`; counting asks `inventory.count`, approving and the statement `inventory.count_approve`,
 * the value at cost `costs.view`.
 */

interface Warehouse {
  id: string;
  name: string;
}

export interface CountListItem {
  id: string;
  warehouseId: string;
  warehouseName: string | null;
  status: string;
  statusAr: string;
  scope: string;
  note: string | null;
  openedById: string;
  openedByName: string | null;
  openedAt: string;
  submittedByName: string | null;
  submittedAt: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  voidReason: string | null;
  lineCount: number;
}

interface ListAnswer {
  warehouses: Warehouse[];
  counts: CountListItem[];
}

interface SheetVariant {
  variantId: string;
  label?: string | null;
  counted: number;
  /** Present for the approver only. */
  expected?: number | null;
  difference?: number | null;
}

interface SheetLine {
  productId: string;
  productName: string | null;
  sku: string | null;
  counted: number | null;
  /** The product's active combinations: an id and a word each, never a figure. */
  combinations: { variantId: string; label: string }[];
  variants?: SheetVariant[];
  /** Present for the approver only. */
  expected?: number | null;
  difference?: number | null;
  applied?: number | null;
  unsourcedWithCourier?: number | null;
  /** Present for a holder of the cost key only. */
  valueAtCost?: number | null;
}

interface Sheet {
  id: string;
  warehouseId: string;
  warehouseName: string | null;
  status: string;
  statusAr: string;
  scope: string;
  note: string | null;
  openedById: string;
  openedAt: string;
  submittedAt: string | null;
  decidedAt: string | null;
  voidReason: string | null;
  youCounted: boolean;
  lines: SheetLine[];
}

interface StatementSheet {
  countId: string;
  day: string;
  countedByName: string | null;
  approvedByName: string | null;
  lines: number;
  surplus: number;
  shortfall: number;
  valueAtCost?: number;
}

interface StatementRow {
  countId: string;
  day: string;
  productId: string;
  productName: string | null;
  opening: number | null;
  openingDay: string | null;
  net: number | null;
  expected: number;
  counted: number;
  difference: number;
  unsourcedWithCourier: number;
  valueAtCost?: number;
}

interface StatementAnswer {
  warehouseName: string | null;
  keepers: string[];
  period: string;
  periodAr: string;
  truncated: boolean;
  seesCost: boolean;
  sheets: StatementSheet[];
  rows: StatementRow[];
  total: { sheets: number; surplus: number; shortfall: number; valueAtCost?: number };
}

const TONE: Record<string, StateTone> = {
  OPEN: 'neutral',
  SUBMITTED: 'warn',
  APPROVED: 'good',
  VOIDED: 'neutral',
};

/** The keeper's sentence: she counts what is in front of her; nobody tells her what the book says. */
export const BLIND_AR = 'اعدّ اللي قدامك عالرف واكتبه. ما في رقم دفتر هون — اللي بيعتمد هو اللي بيشوف الفرق.';

/** What the statement claims, and what it does not. */
export const STATEMENT_CLAIM_AR =
  'كل سطر: اللي انعدّ بالجرد اللي قبله + اللي صار بالدفتر بين الجردين = المفروض، مقابل اللي انعدّ هلّق. الداخل والطالع بينكتبوا رقم واحد صافي، لأن حركات المخزون لحالها ما بتقول بدقة شو دخل وطلع من كل مخزن. وما في رقم لمنتج قبل أول جرد إله، ولا للي صار بعد آخر جرد.';

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

/** A figure as the server sent it — nothing when it sent none. */
function Num({ v, signed }: { v: number | null | undefined; signed?: boolean }) {
  if (v === undefined || v === null) return <span className="text-[var(--sys-muted-foreground)]">—</span>;
  return (
    <span className="tabular-nums font-bold" dir="ltr">
      {signed && v > 0 ? `+${v}` : v}
    </span>
  );
}

const Loading = () => (
  <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--sys-muted-foreground)]">
    <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
  </div>
);

export function StockCountsScreen() {
  const { currentUser } = useApp();
  const canCount = userCan(currentUser, 'inventory.count');
  const canApprove = userCan(currentUser, 'inventory.count_approve');

  const [view, setView] = useState('list');
  const [data, setData] = useState<ListAnswer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [only, setOnly] = useState('all');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setData(await apiJson<ListAnswer>('/api/inventory/counts'));
    } catch (e) {
      setLoadError(errorText(e, 'تعذّر تحميل أوراق الجرد'));
    }
  }, []);
  useLiveRefresh(load);

  const counts = useMemo(() => data?.counts ?? [], [data]);
  const count = (status: string) => counts.filter((c) => c.status === status).length;
  const shown = counts.filter((c) => (only === 'all' ? true : c.status === only));
  const warehouses = data?.warehouses ?? [];

  return (
    <PageShell
      title={routeLabel('/inventory/counts')}
      description="الأمين بيعدّ اللي بالمخزن بلا ما يشوف رقم الدفتر، وحدا تاني بيشوف الفرق وبيعتمده."
      width="wide"
      actions={
        canCount && warehouses.length > 0 ? (
          <Button type="button" onClick={() => setCreating(true)}>
            ورقة جرد جديدة
          </Button>
        ) : undefined
      }
      filters={
        <div className="flex flex-wrap items-center gap-2">
          {canApprove && (
            <Segmented
              aria-label="طريقة العرض"
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: 'list', label: 'أوراق الجرد' },
                { value: 'statement', label: 'كشف عهدة الأمين' },
              ]}
            />
          )}
          {view === 'list' && data && counts.length > 0 && (
            <Segmented
              aria-label="أي أوراق"
              size="sm"
              value={only}
              onChange={setOnly}
              options={[
                { value: 'all', label: 'الكل', count: counts.length },
                { value: 'OPEN', label: 'عم ينعدّ', count: count('OPEN') },
                { value: 'SUBMITTED', label: 'مستني اعتماد', count: count('SUBMITTED') },
                { value: 'APPROVED', label: 'معتمد', count: count('APPROVED') },
                { value: 'VOIDED', label: 'ملغى', count: count('VOIDED') },
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

      {view === 'statement' && canApprove ? (
        <StatementView warehouses={warehouses} />
      ) : loadError ? (
        <LoadFailed message={loadError} onRetry={() => void load()} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {warehouses.length === 0 && (
            <Card plain padding="sm">
              <p className="text-sm text-[var(--sys-muted-foreground)]">
                الجرد بيكون لمخزن. المخازن بتنعرّف من «البلدان والمدن» تحت كل بلد، وبعدين بيتوزّع رصيد المتجر عليها.
              </p>
            </Card>
          )}
          {counts.length === 0 ? (
            <EmptyState icon={RiClipboardLine} title="ما في أوراق جرد لسا" why="كل جرد على مخزن بيبين هون: مين عدّ، مين اعتمد، وحالته." />
          ) : (
            <Card plain className="overflow-hidden">
              <Rows
                rows={shown}
                keyOf={(c) => c.id}
                columns={[
                  { key: 'when', label: 'انفتحت', primary: true, render: (c) => arDateTime(c.openedAt) },
                  {
                    key: 'where',
                    label: 'المخزن',
                    primary: true,
                    render: (c) => (
                      <>
                        {c.warehouseName ?? '—'}
                        <span className="block text-note text-[var(--sys-muted)]">
                          {c.scope === 'CHOSEN' ? 'منتجات مختارة' : 'كل المنتجات'} · <span className="tabular-nums" dir="ltr">{c.lineCount}</span> سطر
                        </span>
                        {c.note && <span className="block text-note text-[var(--sys-muted-foreground)]">{c.note}</span>}
                      </>
                    ),
                  },
                  {
                    key: 'status',
                    label: 'الحالة',
                    render: (c) => (
                      <>
                        <StatusChip tone={TONE[c.status] ?? 'neutral'}>{c.statusAr}</StatusChip>
                        {c.status === 'VOIDED' && c.voidReason && (
                          <span className="block text-note text-[var(--sys-muted-foreground)]">السبب: {c.voidReason}</span>
                        )}
                      </>
                    ),
                  },
                  {
                    key: 'who',
                    label: 'مين',
                    hideOnPhone: true,
                    render: (c) => (
                      <>
                        فتحها: {c.openedByName ?? '—'}
                        {c.submittedByName && <span className="block text-note text-[var(--sys-muted)]">سلّمها: {c.submittedByName}</span>}
                        {c.decidedByName && (
                          <span className="block text-note text-[var(--sys-muted)]">
                            {c.status === 'VOIDED' ? 'ألغاها' : 'اعتمدها'}: {c.decidedByName}
                          </span>
                        )}
                      </>
                    ),
                  },
                ]}
                actions={(c) => (
                  <Button type="button" size="sm" variant="secondary" onClick={() => setOpenId(c.id)}>
                    افتح الورقة
                  </Button>
                )}
                empty={<EmptyState title="ولا ورقة بهالحالة" why="اختار «الكل» لتشوف كل الأوراق." />}
              />
            </Card>
          )}
        </>
      )}

      {creating && (
        <OpenDialog
          warehouses={warehouses}
          onClose={() => setCreating(false)}
          onDone={(id) => {
            setCreating(false);
            setSaid('انفتحت ورقة الجرد — المخزن واقف لحد ما تنعتمد أو تنلغى.');
            setOpenId(id);
            void load();
          }}
        />
      )}
      {openId && (
        <SheetDialog
          id={openId}
          canCount={canCount}
          canApprove={canApprove}
          me={(currentUser as { id?: string } | null | undefined)?.id ?? null}
          onClose={() => setOpenId(null)}
          onChanged={(sentence) => {
            setSaid(sentence);
            void load();
          }}
        />
      )}
    </PageShell>
  );
}

/* ───────────────────────────── open a sheet ───────────────────────────── */

function OpenDialog({ warehouses, onClose, onDone }: { warehouses: Warehouse[]; onClose: () => void; onDone: (id: string) => void }) {
  const { products } = useProducts();
  const [warehouseId, setWarehouseId] = useState(warehouses.length === 1 ? warehouses[0].id : '');
  const [scope, setScope] = useState('ALL');
  const [picked, setPicked] = useState<{ key: number; productId: string }[]>([{ key: 1, productId: '' }]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = picked.map((p) => p.productId).filter((x) => x !== '');
  const ready = warehouseId !== '' && (scope === 'ALL' || chosen.length > 0) && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const a = await apiJson<{ count: { id: string } }>('/api/inventory/counts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ warehouseId, note: note.trim() || null, ...(scope === 'CHOSEN' ? { productIds: chosen } : {}) }),
        timeoutMs: 60_000,
      });
      onDone(a.count.id);
    } catch (e) {
      setError(errorText(e, 'تعذّر فتح ورقة الجرد'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="ورقة جرد جديدة"
      subtitle="من لحظة فتحها المخزن ما بيستلم ولا بينقل ولا بيطلّع بضاعة لحد ما تنعتمد أو تنلغى. التوصيل بيضل ماشي."
      maxWidth="2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            رجوع
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!ready} loading={busy}>
            افتح الورقة
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-[var(--sys-foreground)]">المخزن</span>
          <Segmented aria-label="المخزن" value={warehouseId} onChange={setWarehouseId} options={warehouses.map((w) => ({ value: w.id, label: w.name }))} />
        </div>
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-[var(--sys-foreground)]">شو بينعدّ</span>
          <Segmented
            aria-label="شو بينعدّ"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'ALL', label: 'كل المنتجات' },
              { value: 'CHOSEN', label: 'منتجات مختارة' },
            ]}
          />
        </div>
        {scope === 'CHOSEN' && (
          <div className="space-y-2">
            {picked.map((p, i) => (
              <div key={p.key} className="flex flex-wrap items-end gap-2">
                <ProductPicker
                  products={products}
                  value={p.productId}
                  onChange={(productId) => setPicked((ps) => ps.map((x) => (x.key === p.key ? { ...x, productId } : x)))}
                  className="flex-1"
                />
                {picked.length > 1 && (
                  <IconButton label={`شيل المنتج ${i + 1}`} onClick={() => setPicked((ps) => ps.filter((x) => x.key !== p.key))}>
                    <RiCloseLine className="h-4 w-4" />
                  </IconButton>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setPicked((ps) => [...ps, { key: Math.max(...ps.map((x) => x.key)) + 1, productId: '' }])}
            >
              <RiAddLine className="h-4 w-4" /> زيد منتج
            </Button>
          </div>
        )}
        <Textarea label="ملاحظة" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        <Refusal text={error} />
      </div>
    </Modal>
  );
}

/* ───────────────────────────── one sheet ───────────────────────────── */

interface Typed {
  counted: string;
  combos: Record<string, string>;
}

const typedFrom = (l: SheetLine): Typed => ({
  counted: l.counted === null || l.counted === undefined ? '' : String(l.counted),
  combos: Object.fromEntries((l.variants ?? []).map((v) => [v.variantId, String(v.counted)])),
});

function SheetDialog({
  id,
  canCount,
  canApprove,
  me,
  onClose,
  onChanged,
}: {
  id: string;
  canCount: boolean;
  canApprove: boolean;
  me: string | null;
  onClose: () => void;
  onChanged: (sentence: string) => void;
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<string, Typed>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);

  /**
   * The sheet, again. What the keeper has typed is kept across the screen's own refreshes; only the first read and a read
   * after one of her presses fill the boxes from the server.
   */
  const load = useCallback(async (refill = false) => {
    setLoadError(null);
    try {
      const a = await apiJson<{ count: Sheet }>(`/api/inventory/counts/${encodeURIComponent(id)}`);
      setSheet(a.count);
      const fresh = Object.fromEntries(a.count.lines.map((l) => [l.productId, typedFrom(l)]));
      setTyped((prev) => (refill || Object.keys(prev).length === 0 ? fresh : prev));
    } catch (e) {
      setLoadError(errorText(e, 'تعذّر تحميل ورقة الجرد'));
    }
  }, [id]);
  useLiveRefresh(load);

  const counting = !!sheet && sheet.status === 'OPEN' && canCount;
  const mayVoid = !!sheet && (canApprove ? sheet.status === 'OPEN' || sheet.status === 'SUBMITTED' : sheet.status === 'OPEN' && sheet.openedById === me && canCount);
  const mayApprove = !!sheet && sheet.status === 'SUBMITTED' && canApprove && !sheet.youCounted;
  // The approval columns are drawn only when the server sent them (the blind rule is the door's).
  const seesBook = !!sheet && sheet.lines.some((l) => 'expected' in l);
  const seesCost = !!sheet && sheet.lines.some((l) => 'valueAtCost' in l);

  const bad = Object.values(typed).some((t) => (t.counted.trim() !== '' && !WHOLE.test(t.counted.trim())) || Object.values(t.combos).some(badBox));

  /** The typed lines as the answer door carries them: a blank line is not sent; combinations as typed, zeros included. */
  const answers = () =>
    (sheet?.lines ?? []).flatMap((l) => {
      const t = typed[l.productId];
      if (!t || !WHOLE.test(t.counted.trim())) return [];
      const variants = typedCombinations(l.combinations, t.combos, { dropZero: false });
      return [{ productId: l.productId, counted: Number(t.counted.trim()), ...(variants.length > 0 ? { variants } : {}) }];
    });

  async function press(run: () => Promise<unknown>, sentence: string, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await run();
      onChanged(sentence);
      await load(true);
    } catch (e) {
      setError(errorText(e, fallback));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    apiJson(`/api/inventory/counts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: answers() }),
      timeoutMs: 60_000,
    });

  const footer = sheet ? (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onClose}>
        رجوع
      </Button>
      {mayVoid && (
        <Button type="button" variant="danger" onClick={() => setVoiding(true)} disabled={busy}>
          ألغي الورقة
        </Button>
      )}
      {counting && (
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void press(save, 'انحفظ العدّ.', 'تعذّر حفظ العدّ')}
            disabled={busy || bad || answers().length === 0}
            loading={busy}
          >
            احفظ العدّ
          </Button>
          <Button
            type="button"
            onClick={() =>
              void press(
                async () => {
                  if (answers().length > 0) await save();
                  await apiJson(`/api/inventory/counts/${encodeURIComponent(id)}/submit`, { method: 'POST', timeoutMs: 60_000 });
                },
                'انسلّم الجرد — مستني حدا تاني يعتمده.',
                'تعذّر تسليم الجرد'
              )
            }
            disabled={busy || bad}
            loading={busy}
          >
            سلّم الجرد
          </Button>
        </>
      )}
      {sheet.status === 'SUBMITTED' && canApprove && sheet.youCounted && (
        <span className="self-center text-note text-[var(--sys-muted-foreground)]">إنت إلك إيد بهالجرد — بيعتمده حدا غيرك</span>
      )}
      {mayApprove && (
        <Button
          type="button"
          onClick={() =>
            void press(
              () => apiJson(`/api/inventory/counts/${encodeURIComponent(id)}/approve`, { method: 'POST', timeoutMs: 60_000 }),
              'انعتمد الجرد — الفرق انكتب بالمخزن.',
              'تعذّر الاعتماد'
            )
          }
          disabled={busy}
          loading={busy}
        >
          اعتمد الجرد
        </Button>
      )}
    </div>
  ) : undefined;

  return (
    <>
      <Modal
        isOpen
        onClose={onClose}
        title={sheet ? `جرد ${sheet.warehouseName ?? ''}` : 'ورقة الجرد'}
        subtitle={sheet ? `${sheet.statusAr} · انفتحت ${arDateTime(sheet.openedAt)}` : undefined}
        maxWidth="2xl"
        footer={footer}
      >
        {loadError ? (
          <LoadFailed message={loadError} onRetry={() => void load()} />
        ) : !sheet ? (
          <Loading />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={TONE[sheet.status] ?? 'neutral'}>{sheet.statusAr}</StatusChip>
              {sheet.note && <span className="text-note text-[var(--sys-muted-foreground)]">{sheet.note}</span>}
            </div>
            {sheet.status === 'VOIDED' && sheet.voidReason && <p className="text-sm text-[var(--sys-muted-foreground)]">انلغت: {sheet.voidReason}</p>}

            {counting ? (
              <>
                <p className="rounded-lg bg-[var(--sys-surface)] p-2.5 text-sm text-[var(--sys-foreground)]">{BLIND_AR}</p>
                <div className="space-y-3">
                  {sheet.lines.map((l, i) => {
                    const t = typed[l.productId] ?? { counted: '', combos: {} };
                    const set = (patch: Partial<Typed>) => setTyped((all) => ({ ...all, [l.productId]: { ...t, ...patch } }));
                    return (
                      <div key={l.productId} className="space-y-1.5" data-line={l.productId}>
                        <Input
                          label={l.productName ?? 'منتج'}
                          aria-label={`عدد «${l.productName ?? 'منتج'}»`}
                          inputMode="numeric"
                          dir="ltr"
                          value={t.counted}
                          onChange={(e) => set({ counted: e.target.value })}
                          helperText={l.sku ?? undefined}
                          error={t.counted.trim() !== '' && !WHOLE.test(t.counted.trim()) ? 'رقم صحيح من صفر وطالع' : undefined}
                        />
                        <CombinationBoxes
                          title="كم قطعة من كل خيار؟ اكتب لكل خيار (ولو صفر)، ومجموعهم لازم يساوي عدد المنتج."
                          combos={l.combinations.map((c) => ({ variantId: c.variantId, label: c.label }))}
                          values={t.combos}
                          onChange={(variantId, value) => set({ combos: { ...t.combos, [variantId]: value } })}
                          ariaOf={(label) => `عدد «${label}» بالسطر ${i + 1}`}
                        />
                      </div>
                    );
                  })}
                </div>
              </>
            ) : seesBook ? (
              <ApprovalTable sheet={sheet} seesCost={seesCost} />
            ) : (
              <Card plain className="overflow-hidden">
                <Rows
                  rows={sheet.lines}
                  keyOf={(l) => l.productId}
                  columns={[
                    { key: 'product', label: 'المنتج', primary: true, render: (l) => <LineName l={l} /> },
                    { key: 'counted', label: 'انعدّ', primary: true, render: (l) => <CountedCell l={l} /> },
                  ]}
                />
              </Card>
            )}
            <Refusal text={error} />
          </div>
        )}
      </Modal>
      {voiding && sheet && (
        <VoidDialog
          id={sheet.id}
          onClose={() => setVoiding(false)}
          onDone={() => {
            setVoiding(false);
            onChanged('انلغت ورقة الجرد — ما تغيّر شي، والمخزن رجع يشتغل.');
            void load();
          }}
        />
      )}
    </>
  );
}

function LineName({ l }: { l: SheetLine }) {
  return (
    <>
      {l.productName ?? 'منتج'}
      {l.sku && <span className="block text-note text-[var(--sys-muted)]">{l.sku}</span>}
    </>
  );
}

/** What was counted, and under it each combination's count — the keeper's own figures only. */
function CountedCell({ l }: { l: SheetLine }) {
  return (
    <>
      <Num v={l.counted} />
      {(l.variants ?? []).map((v) => (
        <span key={v.variantId} className="block ps-3 text-note" data-variant={v.variantId}>
          {v.label ?? 'خيار'}: <Num v={v.counted} />
        </span>
      ))}
    </>
  );
}

/** The approver's table: every figure is the server's (expected, counted, difference, value at cost for the cost key). */
function ApprovalTable({ sheet, seesCost }: { sheet: Sheet; seesCost: boolean }) {
  const approved = sheet.status === 'APPROVED';
  return (
    <div className="space-y-2">
      {sheet.status === 'SUBMITTED' && (
        <p className="rounded-lg bg-[var(--sys-surface)] p-2.5 text-sm text-[var(--sys-foreground)]">
          المفروض انحسب لحظة التسليم: رصيد المخزن بالدفتر ناقص اللي طالع منه مع شركة الشحن. الاعتماد بيكتب الفرق بالمخزن بالكلفة: الزيادة بكلفة آخر دفعة، والنقص من الأقدم.
        </p>
      )}
      <Card plain className="overflow-hidden">
        <Rows
          rows={sheet.lines}
          keyOf={(l) => l.productId}
          columns={[
            {
              key: 'product',
              label: 'المنتج',
              primary: true,
              render: (l) => (
                <>
                  <LineName l={l} />
                  {(l.unsourcedWithCourier ?? 0) > 0 && (
                    <span className="block text-note text-[var(--sys-warning)]">
                      في <span className="tabular-nums" dir="ltr">{l.unsourcedWithCourier}</span> قطعة مع شركة الشحن بلا مخزن مكتوب — ممكن المفروض أعلى منهم
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'expected',
              label: 'المفروض',
              render: (l) => (
                <>
                  <Num v={l.expected} />
                  {(l.variants ?? []).map((v) => (
                    <span key={v.variantId} className="block ps-3 text-note" data-variant={v.variantId}>
                      {v.label ?? 'خيار'}: <Num v={v.expected} />
                    </span>
                  ))}
                </>
              ),
            },
            { key: 'counted', label: 'انعدّ', primary: true, render: (l) => <CountedCell l={l} /> },
            {
              key: 'difference',
              label: 'الفرق',
              primary: true,
              render: (l) => (
                <>
                  <Num v={approved ? l.applied ?? l.difference : l.difference} signed />
                  {(l.variants ?? []).map((v) => (
                    <span key={v.variantId} className="block ps-3 text-note" data-variant={v.variantId}>
                      {v.label ?? 'خيار'}: <Num v={v.difference} signed />
                    </span>
                  ))}
                </>
              ),
            },
            ...(seesCost
              ? [
                  {
                    key: 'value',
                    label: 'القيمة بالكلفة',
                    render: (l: SheetLine) =>
                      approved && l.valueAtCost !== null && l.valueAtCost !== undefined ? (
                        <Money value={l.valueAtCost} />
                      ) : (
                        <span className="text-note text-[var(--sys-muted-foreground)]">بتنحسب عند الاعتماد</span>
                      ),
                  },
                ]
              : []),
          ]}
        />
      </Card>
    </div>
  );
}

function VoidDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/inventory/counts/${encodeURIComponent(id)}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      onDone();
    } catch (e) {
      setError(errorText(e, 'تعذّر الإلغاء'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="إلغاء ورقة الجرد"
      subtitle="ما بينكتب ولا فرق، والمخزن بيرجع يستلم وينقل"
      maxWidth="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            رجوع
          </Button>
          <Button type="button" variant="danger" onClick={() => void submit()} disabled={reason.trim().length < 3 || busy} loading={busy}>
            ألغي الورقة
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Textarea label="سبب الإلغاء *" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        <Refusal text={error} />
      </div>
    </Modal>
  );
}

/* ───────────────────────────── the keeper's statement ───────────────────────────── */

function StatementView({ warehouses }: { warehouses: Warehouse[] }) {
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [period, setPeriod] = useState('90');
  const [answer, setAnswer] = useState<StatementAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!warehouseId) return;
    setError(null);
    try {
      setAnswer(
        await apiJson<StatementAnswer>(
          `/api/inventory/counts/statement?warehouseId=${encodeURIComponent(warehouseId)}&period=${encodeURIComponent(period)}`
        )
      );
    } catch (e) {
      setError(errorText(e, 'تعذّر تحميل كشف العهدة'));
    }
  }, [warehouseId, period]);
  useLiveRefresh(load, { key: `${warehouseId}|${period}` });

  if (warehouses.length === 0) {
    return <EmptyState icon={RiClipboardLine} title="ما في مخازن لهالمتجر" why="كشف العهدة بيكون لمخزن إله أمين وجرد معتمد." />;
  }

  const cost = !!answer?.seesCost;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented aria-label="أي مخزن" size="sm" value={warehouseId} onChange={setWarehouseId} options={warehouses.map((w) => ({ value: w.id, label: w.name }))} />
        <Segmented
          aria-label="أي مدة"
          size="sm"
          value={period}
          onChange={setPeriod}
          options={[
            { value: '30', label: 'آخر 30 يوم' },
            { value: '90', label: 'آخر 90 يوم' },
            { value: 'all', label: 'الكل' },
          ]}
        />
      </div>

      {error ? (
        <LoadFailed message={error} onRetry={() => void load()} />
      ) : !answer ? (
        <Loading />
      ) : (
        <>
          <p className="text-sm text-[var(--sys-foreground)]">
            <span className="font-bold">{answer.warehouseName ?? '—'}</span>
            {' · '}
            {answer.keepers.length > 0 ? `الأمين: ${answer.keepers.join('، ')}` : 'ما إله أمين مسمّى'}
            {' · '}
            {answer.periodAr}
          </p>
          <p className="rounded-lg bg-[var(--sys-surface)] p-2.5 text-sm text-[var(--sys-foreground)]">{STATEMENT_CLAIM_AR}</p>
          {answer.truncated && <p className="text-note text-[var(--sys-warning)]">المخزن إله كتير أوراق جرد — هاد آخر جزء منها بس.</p>}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile label="جرد معتمد" value={answer.total.sheets} />
            <StatTile label="قطع زايدة" value={answer.total.surplus} />
            <StatTile label="قطع ناقصة" value={answer.total.shortfall} />
            {cost && <StatTile label="الفرق بالكلفة" value={<Money value={answer.total.valueAtCost ?? 0} />} />}
          </div>

          {answer.sheets.length === 0 ? (
            <EmptyState icon={RiClipboardLine} title="ما في جرد معتمد بهالمدة" why="الكشف بينبنى من أوراق الجرد المعتمدة بس." />
          ) : (
            <>
              <Card plain className="overflow-hidden">
                <Rows
                  rows={answer.sheets}
                  keyOf={(s) => s.countId}
                  columns={[
                    { key: 'day', label: 'اليوم', primary: true, render: (s) => <span dir="ltr">{s.day}</span> },
                    {
                      key: 'who',
                      label: 'مين',
                      primary: true,
                      render: (s) => (
                        <>
                          عدّها: {s.countedByName ?? '—'}
                          <span className="block text-note text-[var(--sys-muted)]">اعتمدها: {s.approvedByName ?? '—'}</span>
                        </>
                      ),
                    },
                    {
                      key: 'diff',
                      label: 'الفروقات',
                      render: (s) => (
                        <>
                          زايد <Num v={s.surplus} /> · ناقص <Num v={s.shortfall} />
                          <span className="block text-note text-[var(--sys-muted)]">
                            <span className="tabular-nums" dir="ltr">{s.lines}</span> منتج
                          </span>
                        </>
                      ),
                    },
                    ...(cost ? [{ key: 'value', label: 'بالكلفة', render: (s: StatementSheet) => <Money value={s.valueAtCost ?? 0} /> }] : []),
                  ]}
                />
              </Card>

              <Card plain className="overflow-hidden">
                <Rows
                  rows={answer.rows}
                  keyOf={(r) => `${r.countId}:${r.productId}`}
                  columns={[
                    {
                      key: 'product',
                      label: 'المنتج',
                      primary: true,
                      render: (r) => (
                        <>
                          {r.productName ?? 'منتج'}
                          <span className="block text-note text-[var(--sys-muted)]" dir="ltr">
                            {r.day}
                          </span>
                        </>
                      ),
                    },
                    {
                      key: 'opening',
                      label: 'البداية',
                      hideOnPhone: true,
                      render: (r) =>
                        r.opening === null ? (
                          <span className="text-note text-[var(--sys-muted-foreground)]">أول جرد</span>
                        ) : (
                          <>
                            <Num v={r.opening} />
                            <span className="block text-note text-[var(--sys-muted)]" dir="ltr">
                              {r.openingDay}
                            </span>
                          </>
                        ),
                    },
                    { key: 'net', label: 'داخل − طالع', hideOnPhone: true, render: (r) => <Num v={r.net} signed /> },
                    { key: 'expected', label: 'المفروض', render: (r) => <Num v={r.expected} /> },
                    { key: 'counted', label: 'انعدّ', primary: true, render: (r) => <Num v={r.counted} /> },
                    { key: 'difference', label: 'الفرق', primary: true, render: (r) => <Num v={r.difference} signed /> },
                    ...(cost ? [{ key: 'value', label: 'بالكلفة', render: (r: StatementRow) => <Money value={r.valueAtCost ?? 0} /> }] : []),
                  ]}
                />
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
