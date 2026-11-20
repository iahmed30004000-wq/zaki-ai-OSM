'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { RiAddLine, RiCloseLine, RiLoader4Line, RiRepeatLine } from '@remixicon/react';
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
import type { StateTone } from '@/lib/order-state';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { useProducts } from '@/hooks/useProducts';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { routeLabel } from '@/lib/route-registry';
import { arDateTime } from '@/lib/format';
import { NOT_BUILT_AR, readStockTransfer, stockTransferRefusal } from '@/lib/stock-transfer-kind';
// A client-made id, made once when the form opens: the same press sent twice is one transfer at the door.
import { newId } from '@/lib/client-id';
import {
  CombinationBoxes,
  PickedCombinations,
  badBox,
  mayHaveCombinations,
  shelfHint,
  typedCombinations,
  useProductCombinations,
} from '@/components/inventory/CombinationBoxes';

/**
 * /inventory/transfers — «نقل البضاعة» (the warehouse plan, request W3b): moving units between two warehouses of ONE store.
 * The doors and every rule are W3a's (`/api/inventory/transfers`, `…/:id/receive|cancel|difference`, `lib/stock-transfers.ts`).
 *
 * THE RECEIVER COUNTS BLIND. While a transfer is on the road the list door tells its sent quantities only to the person who
 * sent it (`stock-transfers.shownTo`); and the receive dialog below never reads `quantitySent` before the press — she types
 * what she counted, and only the door's answer AFTER the press shows sent · counted · difference.
 *
 * THIS FILE DOES NO ARITHMETIC ON A FIGURE. The difference of a line is the server's (`difference`); the kind of a transfer
 * and its sentence are `stock-transfer-kind.readStockTransfer`, the door's own reading, said before the press.
 *
 * The page opens on `inventory.view`; each press asks its own key (send and cancel: `inventory.transfer`; receive:
 * `inventory.transfer_receive`; the difference: `inventory.difference_approve`). Hiding a button is only manners: the door
 * asks the key again, and refuses the sender who tries to receive, and the sender or receiver who tries to approve.
 */

interface Warehouse {
  id: string;
  name: string;
  countryId: string;
}

/** 20/11 (W8c): one combination of a line, blind exactly as its line, with its label. */
interface LineVariant {
  variantId: string;
  label: string | null;
  quantitySent: number | null;
  quantityReceived: number | null;
  difference: number | null;
}

interface Line {
  productId: string;
  productName: string | null;
  /** Null while on the road for anybody but the sender (the door's blind rule). */
  quantitySent: number | null;
  quantityReceived: number | null;
  difference: number | null;
  /** Present only on a line of a product with combinations. */
  variants?: LineVariant[];
}

export interface StockTransferItem {
  id: string;
  kind: string;
  kindAr: string;
  status: string;
  statusAr: string;
  blind: boolean;
  note: string | null;
  fromName: string | null;
  toName: string | null;
  sentById: string;
  sentByName: string | null;
  sentAt: string;
  receivedById: string | null;
  receivedByName: string | null;
  receivedAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  differenceType: string | null;
  differenceReason: string | null;
  differenceApprovedAt: string | null;
  differenceApprovedByName: string | null;
  lines: Line[];
}

interface ListAnswer {
  warehouses: Warehouse[];
  transfers: StockTransferItem[];
}

const TONE: Record<string, StateTone> = {
  SENT: 'warn',
  RECEIVED: 'good',
  RECEIVED_WITH_DIFFERENCE: 'bad',
  CANCELLED: 'neutral',
};

const DIFF_TYPE_AR: Record<string, string> = { LOSS: 'ضايع', DAMAGE: 'تالف' };

const WHOLE = /^\d+$/;

const waitsForApproval = (t: StockTransferItem) => t.status === 'RECEIVED_WITH_DIFFERENCE' && !t.differenceApprovedAt;

const nameOf = (l: Line) => l.productName ?? 'منتج';

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function Refusal({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
      {text}
    </p>
  );
}

/** What a line says in the list: the sent figure only when the door told it, then what was counted and what is short. */
function LineText({ l }: { l: Line }) {
  return (
    <>
      <Figures name={nameOf(l)} f={l} />
      {/* 20/11 (W8c): its combinations under it, each as blind as the line. */}
      {(l.variants ?? []).map((v) => (
        <Figures key={v.variantId} name={v.label ?? 'خيار'} f={v} className="block ps-3 text-note" />
      ))}
    </>
  );
}

function Figures({
  name,
  f: l,
  className = 'block text-sm',
}: {
  name: string;
  f: { quantitySent: number | null; quantityReceived: number | null; difference: number | null };
  className?: string;
}) {
  return (
    <span className={className}>
      {name}:{' '}
      {l.quantitySent === null ? (
        <span className="text-[var(--sys-muted-foreground)]">العدد مخفي لحد ما ينعدّ</span>
      ) : (
        <span className="tabular-nums font-bold" dir="ltr">
          {l.quantitySent}
        </span>
      )}
      {l.quantityReceived !== null && (
        <span className="text-[var(--sys-muted-foreground)]">
          {' '}
          · انعدّ <span className="tabular-nums" dir="ltr">{l.quantityReceived}</span>
        </span>
      )}
      {l.difference !== null && l.difference > 0 && (
        <span className="text-[var(--sys-destructive)]">
          {' '}
          · ناقص <span className="tabular-nums" dir="ltr">{l.difference}</span>
        </span>
      )}
    </span>
  );
}

export function StockTransfersScreen() {
  const { currentUser } = useApp();
  const me = (currentUser as { id?: string } | null | undefined)?.id ?? null;
  const canSend = userCan(currentUser, 'inventory.transfer');
  const canReceive = userCan(currentUser, 'inventory.transfer_receive');
  const canApprove = userCan(currentUser, 'inventory.difference_approve');

  const [data, setData] = useState<ListAnswer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [only, setOnly] = useState('all');
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<StockTransferItem | null>(null);
  const [cancelling, setCancelling] = useState<StockTransferItem | null>(null);
  const [approving, setApproving] = useState<StockTransferItem | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setData(await apiJson<ListAnswer>('/api/inventory/transfers'));
    } catch (e) {
      setLoadError(errorText(e, 'تعذّر تحميل النقلات'));
    }
  }, []);
  useLiveRefresh(load);

  const done = (sentence: string) => {
    setCreating(false);
    setReceiving(null);
    setCancelling(null);
    setApproving(null);
    setSaid(sentence);
    void load();
  };

  const transfers = useMemo(() => data?.transfers ?? [], [data]);
  const count = (pick: (t: StockTransferItem) => boolean) => transfers.filter(pick).length;
  const shown = transfers.filter((t) =>
    only === 'all' ? true : only === 'WAITING' ? waitsForApproval(t) : t.status === only
  );
  const warehouses = data?.warehouses ?? [];

  const actions = (t: StockTransferItem) => {
    const mine = me !== null && t.sentById === me;
    const out: React.ReactNode[] = [];
    if (t.status === 'SENT' && canReceive && !mine) {
      out.push(
        <Button key="r" type="button" size="sm" onClick={() => setReceiving(t)}>
          استلم
        </Button>
      );
    }
    if (t.status === 'SENT' && canSend) {
      out.push(
        <Button key="c" type="button" size="sm" variant="secondary" onClick={() => setCancelling(t)}>
          إلغاء
        </Button>
      );
    }
    if (waitsForApproval(t) && canApprove && !mine && t.receivedById !== me) {
      out.push(
        <Button key="d" type="button" size="sm" onClick={() => setApproving(t)}>
          اعتمد الفرق
        </Button>
      );
    }
    if (out.length === 0 && t.status === 'SENT' && mine && canReceive) {
      return <span className="text-note text-[var(--sys-muted-foreground)]">بيستلمه حدا غيرك</span>;
    }
    return out.length ? <div className="flex flex-wrap gap-2">{out}</div> : null;
  };

  return (
    <PageShell
      title={routeLabel('/inventory/transfers')}
      description="نقل بضاعة بين مخزنين لنفس المتجر: بتطلع من الأول، بتصير بالطريق، وبتدخل التاني لما ينعدّ."
      width="wide"
      actions={
        canSend && warehouses.length >= 2 ? (
          <Button type="button" onClick={() => setCreating(true)}>
            نقل جديد
          </Button>
        ) : undefined
      }
      filters={
        data && transfers.length > 0 ? (
          <Segmented
            aria-label="أي نقلات"
            size="sm"
            value={only}
            onChange={setOnly}
            options={[
              { value: 'all', label: 'الكل', count: transfers.length },
              { value: 'SENT', label: 'بالطريق', count: count((t) => t.status === 'SENT') },
              { value: 'WAITING', label: 'فرق بدو اعتماد', count: count(waitsForApproval) },
              { value: 'RECEIVED', label: 'مستلم', count: count((t) => t.status === 'RECEIVED') },
              { value: 'CANCELLED', label: 'ملغى', count: count((t) => t.status === 'CANCELLED') },
            ]}
          />
        ) : undefined
      }
    >
      {said && (
        <p role="status" className="rounded-lg border border-[var(--sys-success)]/30 bg-[var(--sys-success-soft)] p-2.5 text-sm text-[var(--sys-success)]">
          {said}
        </p>
      )}

      {loadError ? (
        <LoadFailed message={loadError} onRetry={() => void load()} />
      ) : !data ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : (
        <>
          {warehouses.length < 2 && (
            <Card plain padding="sm">
              <p className="text-sm text-[var(--sys-muted-foreground)]">
                لتنقل بضاعة لازم يكون في مخزنين شغّالين ببلد هالمتجر. المخازن بتنعرّف من «البلدان والمدن» تحت كل بلد.
              </p>
            </Card>
          )}
          {transfers.length === 0 ? (
            <EmptyState icon={RiRepeatLine} title="ما في نقلات لسا" why="كل نقل بين مخزنين بيبين هون: من وين، لوين، شو انبعت، وشو انعدّ." />
          ) : (
            <Card plain className="overflow-hidden">
              <Rows
                rows={shown}
                keyOf={(t) => t.id}
                columns={[
                  { key: 'when', label: 'التاريخ', primary: true, render: (t) => arDateTime(t.sentAt) },
                  {
                    key: 'road',
                    label: 'من ← إلى',
                    primary: true,
                    render: (t) => (
                      <>
                        {t.fromName ?? '—'} ← {t.toName ?? '—'}
                        <span className="block text-note text-[var(--sys-muted)]">{t.kindAr}</span>
                      </>
                    ),
                  },
                  {
                    key: 'lines',
                    label: 'البضاعة',
                    render: (t) => (
                      <>
                        {t.lines.map((l) => (
                          <LineText key={l.productId} l={l} />
                        ))}
                      </>
                    ),
                  },
                  {
                    key: 'status',
                    label: 'الحالة',
                    render: (t) => (
                      <>
                        <StatusChip tone={TONE[t.status] ?? 'neutral'}>{t.statusAr}</StatusChip>
                        {t.status === 'RECEIVED_WITH_DIFFERENCE' && (
                          <span className="block text-note text-[var(--sys-muted-foreground)]">
                            {t.differenceApprovedAt
                              ? `انعتمد الفرق (${DIFF_TYPE_AR[t.differenceType ?? ''] ?? ''}) — ${t.differenceApprovedByName ?? ''}`
                              : 'الفرق بدو اعتماد شخص تالت'}
                          </span>
                        )}
                        {t.status === 'CANCELLED' && t.cancelReason && (
                          <span className="block text-note text-[var(--sys-muted-foreground)]">السبب: {t.cancelReason}</span>
                        )}
                      </>
                    ),
                  },
                  {
                    key: 'who',
                    label: 'مين',
                    hideOnPhone: true,
                    render: (t) => (
                      <>
                        بعته: {t.sentByName ?? '—'}
                        {t.receivedByName && <span className="block text-note text-[var(--sys-muted)]">استلمه: {t.receivedByName}</span>}
                        {t.cancelledByName && <span className="block text-note text-[var(--sys-muted)]">ألغاه: {t.cancelledByName}</span>}
                      </>
                    ),
                  },
                  { key: 'note', label: 'ملاحظة', hideOnPhone: true, render: (t) => t.note ?? '—' },
                ]}
                actions={actions}
                empty={<EmptyState title="ولا نقل بهالحالة" why="اختار «الكل» لتشوف كل النقلات." />}
              />
            </Card>
          )}
        </>
      )}

      {creating && (
        <SendDialog warehouses={warehouses} onClose={() => setCreating(false)} onDone={() => done('انبعت النقل — البضاعة صارت بالطريق.')} />
      )}
      {receiving && (
        <ReceiveDialog transfer={receiving} onClose={() => setReceiving(null)} onDone={() => done('انستلم النقل.')} />
      )}
      {cancelling && (
        <CancelDialog transfer={cancelling} onClose={() => setCancelling(null)} onDone={() => done('انلغى النقل — البضاعة رجعت لمخزنها.')} />
      )}
      {approving && (
        <DifferenceDialog transfer={approving} onClose={() => setApproving(null)} onDone={() => done('انعتمد الفرق.')} />
      )}
    </PageShell>
  );
}

/* ───────────────────────────── send ───────────────────────────── */

interface DraftLine {
  key: number;
  productId: string;
  quantity: string;
  /** 20/11 (W8c): the combination boxes as typed, by combination id (a product without combinations: always empty). */
  combos: Record<string, string>;
}

function SendDialog({ warehouses, onClose, onDone }: { warehouses: Warehouse[]; onClose: () => void; onDone: () => void }) {
  const { products } = useProducts();
  const combinations = useProductCombinations();
  const [id] = useState(newId);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ key: 1, productId: '', quantity: '', combos: {} }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The active combinations of a line's product — none for a product without options (it is never asked about). */
  const combosOf = (productId: string) => {
    const k = combinations.known[productId];
    return Array.isArray(k) ? k : [];
  };
  const pick = (key: number, productId: string) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, productId, combos: {} } : l)));
    if (mayHaveCombinations(products.find((p) => p.id === productId) as { variantOptions?: string | null } | undefined)) combinations.ask(productId);
  };

  const fromW = warehouses.find((w) => w.id === from);
  const toW = warehouses.find((w) => w.id === to);
  const end = (w: Warehouse) => ({ warehouseId: w.id, warehouseName: w.name, storeId: 'this-store', countryId: w.countryId });
  const pairRefusal = fromW && toW ? stockTransferRefusal(end(fromW), end(toW)) : null;
  const reading = fromW && toW && !pairRefusal ? readStockTransfer(end(fromW), end(toW)) : null;

  const badQty = lines.some((l) => l.quantity.trim() !== '' && (!WHOLE.test(l.quantity.trim()) || Number(l.quantity) <= 0));
  const badCombo = lines.some((l) => Object.values(l.combos).some(badBox));
  const linesReady = lines.every((l) => l.productId !== '' && WHOLE.test(l.quantity.trim()) && Number(l.quantity) > 0);
  // 20/11 (W7b): the doors send every kind; this form has no destination-store or twin field yet (W7c), so it sends
  // only between two warehouses of this store and says so for the rest.
  const onThisForm = !!reading && reading.kind === 'INTERNAL';
  const ready = !!reading && onThisForm && linesReady && !badCombo && !busy;

  const setLine = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const warehouseOptions = warehouses.map((w) => ({ value: w.id, label: w.name }));

  async function submit() {
    if (!reading) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/inventory/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          fromWarehouseId: from,
          toWarehouseId: to,
          expectKind: reading.kind,
          note: note.trim() || null,
          lines: lines.map((l) => {
            // 20/11 (W8c): the combinations sent, as typed — a line without any goes out exactly as before.
            const variants = typedCombinations(combosOf(l.productId), l.combos, { dropZero: true });
            return { productId: l.productId, quantity: Number(l.quantity.trim()), ...(variants.length > 0 ? { variants } : {}) };
          }),
        }),
        timeoutMs: 60_000,
      });
      onDone();
    } catch (e) {
      setError(errorText(e, 'تعذّر الإرسال'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="نقل جديد"
      subtitle="البضاعة بتطلع من المخزن الأول وبتصير بالطريق، لحد ما حدا تاني يعدّها ويستلمها"
      maxWidth="2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            رجوع
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!ready} loading={busy}>
            أرسل
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-[var(--sys-foreground)]">من مخزن</span>
          <Segmented aria-label="من مخزن" value={from} onChange={setFrom} options={warehouseOptions} />
        </div>
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-[var(--sys-foreground)]">إلى مخزن</span>
          <Segmented aria-label="إلى مخزن" value={to} onChange={setTo} options={warehouseOptions} />
        </div>

        {/* THE KIND, BEFORE THE PRESS — the door's own reading of the two ends. */}
        {pairRefusal ? (
          <Refusal text={pairRefusal} />
        ) : reading ? (
          <p
            data-kind={reading.kind}
            className={
              onThisForm
                ? 'rounded-lg bg-[var(--sys-surface)] p-2.5 text-sm text-[var(--sys-foreground)]'
                : 'rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] p-2.5 text-sm text-[var(--sys-warning)]'
            }
          >
            <span className="font-bold">{reading.label}:</span> {onThisForm ? reading.detail : NOT_BUILT_AR}
          </p>
        ) : (
          <p className="text-note text-[var(--sys-muted-foreground)]">اختار المخزنين، والشاشة بتقلّك شو نوع هالنقل قبل ما تبعت.</p>
        )}

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
                combos={combosOf(l.productId).map((c) => ({ variantId: c.variantId, label: c.label, hint: shelfHint(c, fromW) }))}
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

        <Input label="ملاحظة" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        <Refusal text={error} />
      </div>
    </Modal>
  );
}

/* ───────────────────────────── receive (blind) ───────────────────────────── */

type Shown = { quantitySent: number | null; quantityReceived: number | null; difference: number | null };

interface Answer {
  transfer: { status: string; statusAr: string; lines: (Shown & { productId: string; variants?: (Shown & { variantId: string })[] })[] };
}

export function ReceiveDialog({ transfer, onClose, onDone }: { transfer: StockTransferItem; onClose: () => void; onDone: () => void }) {
  // Only the product of each line — and the NAMES of its combinations — are read here before the press, NEVER a sent quantity.
  const products = transfer.lines.map((l) => ({
    productId: l.productId,
    name: nameOf(l),
    combos: (l.variants ?? []).map((v) => ({ variantId: v.variantId, label: v.label ?? 'خيار' })),
  }));
  const [counts, setCounts] = useState<Record<string, string>>({});
  /** 20/11 (W8c): the combination boxes, by product then combination. */
  const [comboCounts, setComboCounts] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer['transfer'] | null>(null);

  const box = (id: string) => (counts[id] ?? '').trim();
  const comboBox = (productId: string, variantId: string) => (comboCounts[productId]?.[variantId] ?? '').trim();
  const bad =
    products.some((p) => box(p.productId) !== '' && !WHOLE.test(box(p.productId))) ||
    products.some((p) => p.combos.some((c) => badBox(comboBox(p.productId, c.variantId))));
  // Every combination that was sent is counted — a zero is a count; a blank is not.
  const ready =
    products.every((p) => WHOLE.test(box(p.productId)) && p.combos.every((c) => WHOLE.test(comboBox(p.productId, c.variantId)))) && !busy;
  const labelOf = new Map(products.flatMap((p) => p.combos.map((c) => [c.variantId, c.label] as const)));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const out = await apiJson<Answer>(`/api/inventory/transfers/${transfer.id}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: products.map((p) => {
            const variants = typedCombinations(p.combos, comboCounts[p.productId] ?? {}, { dropZero: false });
            return { productId: p.productId, quantity: Number(box(p.productId)), ...(p.combos.length > 0 ? { variants } : {}) };
          }),
        }),
        timeoutMs: 60_000,
      });
      setAnswer(out.transfer);
    } catch (e) {
      setError(errorText(e, 'تعذّر الاستلام'));
    } finally {
      setBusy(false);
    }
  }

  if (answer) {
    const name = new Map(products.map((p) => [p.productId, p.name]));
    return (
      <Modal
        isOpen
        onClose={onDone}
        title="انستلم النقل"
        subtitle={`الحالة: ${answer.statusAr}`}
        maxWidth="lg"
        footer={
          <div className="flex justify-end">
            <Button type="button" onClick={onDone}>
              تم
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          <p className="text-note text-[var(--sys-muted-foreground)]">هلّق بس بيبين شو انبعت، جنب اللي عدّيته:</p>
          {answer.lines.map((l) => (
            <Card key={l.productId} padding="sm">
              <span className="block text-sm font-bold text-[var(--sys-heading)]">{name.get(l.productId) ?? 'منتج'}</span>
              <span className="block text-sm" data-figures={l.productId}>
                انبعت <span className="tabular-nums font-bold" dir="ltr">{l.quantitySent ?? '—'}</span> · انعدّ{' '}
                <span className="tabular-nums font-bold" dir="ltr">{l.quantityReceived ?? '—'}</span> · الفرق{' '}
                <span className="tabular-nums font-bold" dir="ltr">{l.difference ?? '—'}</span>
              </span>
              {(l.variants ?? []).map((v) => (
                <span key={v.variantId} className="block ps-3 text-note" data-figures={v.variantId}>
                  {labelOf.get(v.variantId) ?? 'خيار'}: انبعت <span className="tabular-nums font-bold" dir="ltr">{v.quantitySent ?? '—'}</span> ·
                  انعدّ <span className="tabular-nums font-bold" dir="ltr">{v.quantityReceived ?? '—'}</span> · الفرق{' '}
                  <span className="tabular-nums font-bold" dir="ltr">{v.difference ?? '—'}</span>
                </span>
              ))}
            </Card>
          ))}
          {answer.status === 'RECEIVED_WITH_DIFFERENCE' && (
            <p className="rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] p-2.5 text-note text-[var(--sys-warning)]">
              الناقص بيضل بالطريق لحد ما شخص تالت يعتمد الفرق.
            </p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="استلام نقل"
      subtitle={`${transfer.fromName ?? '—'} ← ${transfer.toName ?? '—'}`}
      maxWidth="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            رجوع
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!ready} loading={busy}>
            استلمت
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          عدّ اللي وصل فعلاً من كل منتج واكتبه. الكمية المبعوتة بتبين بعد ما تضغط «استلمت». إذا ما وصل شي من منتج اكتب صفر.
        </p>
        {products.map((p) => (
          <div key={p.productId} className="space-y-1.5">
            <Input
              label={p.name}
              aria-label={`عدد «${p.name}» اللي وصل`}
              inputMode="numeric"
              dir="ltr"
              value={counts[p.productId] ?? ''}
              onChange={(e) => setCounts((c) => ({ ...c, [p.productId]: e.target.value }))}
            />
            <CombinationBoxes
              title="وكم وصل من كل خيار؟ اكتب صفر للخيار اللي ما وصل منه شي. المجموع لازم يساوي عدد المنتج."
              combos={p.combos}
              values={comboCounts[p.productId] ?? {}}
              onChange={(variantId, value) => setComboCounts((c) => ({ ...c, [p.productId]: { ...c[p.productId], [variantId]: value } }))}
              ariaOf={(label) => `عدد «${p.name}» «${label}» اللي وصل`}
            />
          </div>
        ))}
        {bad && <p className="text-note text-[var(--sys-destructive)]">العدد لازم يكون رقم صحيح من صفر وطالع.</p>}
        <Refusal text={error} />
      </div>
    </Modal>
  );
}

/* ───────────────────────────── cancel ───────────────────────────── */

function CancelDialog({ transfer, onClose, onDone }: { transfer: StockTransferItem; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/inventory/transfers/${transfer.id}/cancel`, {
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
      title="إلغاء النقل"
      subtitle="قبل الاستلام بس: البضاعة اللي بالطريق بترجع لمخزنها، وما في شي بينمحى"
      maxWidth="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            رجوع
          </Button>
          <Button type="button" variant="danger" onClick={() => void submit()} disabled={reason.trim().length < 3 || busy} loading={busy}>
            ألغِ النقل
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

/* ───────────────────────────── the difference ───────────────────────────── */

function DifferenceDialog({ transfer, onClose, onDone }: { transfer: StockTransferItem; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState('LOSS');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/inventory/transfers/${transfer.id}/difference`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, reason: reason.trim() }),
      });
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
      title="اعتماد فرق النقل"
      subtitle="الناقص بيطلع من المخزون كضايع أو تالف. ما في شي بينحسب على الربح أو المحافظ."
      maxWidth="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            رجوع
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={reason.trim().length < 3 || busy} loading={busy}>
            اعتمد الفرق
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {transfer.lines.map((l) => (
          <LineText key={l.productId} l={l} />
        ))}
        <Segmented
          aria-label="نوع الفرق"
          value={type}
          onChange={setType}
          options={[
            { value: 'LOSS', label: 'ضايع' },
            { value: 'DAMAGE', label: 'تالف' },
          ]}
        />
        <Textarea label="سبب الفرق *" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        <Refusal text={error} />
      </div>
    </Modal>
  );
}
