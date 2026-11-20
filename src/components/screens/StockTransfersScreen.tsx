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
import { amount, arDateTime, type Currency } from '@/lib/format';
import { isAcross, needsOwnerApproval, readStockTransfer, stockTransferRefusal, type StockTransferEnd } from '@/lib/stock-transfer-kind';
import {
  LANDED_KIND_AR,
  LandedCostLines,
  Refusal,
  RoadReport,
  TwinPicker,
  badAmount,
  landedBody,
  landedReady,
  usePairs,
  type LandedDraft,
  type RoadAnswer,
} from '@/components/inventory/TransferAcross';
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
 *
 * 21/11 (W7c): ACROSS STORES AND COUNTRIES (W7b's doors). The form names the destination store too — this one, or another
 * store she reaches (the list door's `destinations`, each with its country's warehouses) — and says the kind before the
 * press, «بدّو اعتماد المالك» for another country. Across stores every product needs its twin there: the twin picker
 * (`TransferAcross.TwinPicker`, W7a's doors) proposes, she chooses and saves, and a product with no twin keeps the press
 * shut with its sentence. A product with combinations is refused by the door, in its own sentence. A request to another
 * country waits for the owner's «اعتمد وابعت», offered only where the door said `mayApprove`. A receipt from another
 * store asks «وصلت كلها ولا لأ؟» and takes the landed cost lines (transport, customs, other); the server works out the unit
 * cost. «بضاعة بالطريق» is the door's report. Costs are drawn only where the door sent them (`costs.view`).
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
  /** 21/11 (W7c): a line across stores — its twin; and, only where the door sent them (`costs.view`), its costs. */
  toProductId?: string;
  toProductName?: string | null;
  costOut?: number | null;
  landedCosts?: { kind: string; amount: number; note?: string }[];
  unitCostIn?: number | null;
  missingValue?: number;
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
  /** 21/11 (W7c): present only on a transfer across stores. */
  fromStoreName?: string | null;
  toStoreName?: string | null;
  approvedByName?: string | null;
  /** The door's word: this viewer is the owner and the request waits for his press. */
  mayApprove?: boolean;
  fromCurrency?: Currency | null;
  toCurrency?: Currency | null;
}

/** 21/11 (W7c): another store she may send to, with its country's running warehouses. */
interface Destination {
  storeId: string;
  storeName: string;
  countryId: string;
  countryName: string | null;
  warehouses: Warehouse[];
}

interface ListAnswer {
  warehouses: Warehouse[];
  transfers: StockTransferItem[];
  /** 21/11 (W7c): absent from an older answer — the form then sends inside this store only, as before. */
  here?: { id: string; name: string | null; countryId: string | null; countryName: string | null };
  destinations?: Destination[];
  mayAbroad?: boolean;
  road?: RoadAnswer;
}

const TONE: Record<string, StateTone> = {
  AWAITING_APPROVAL: 'warn',
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

/** 21/11 (W7c): a transfer to or from another store (the kind the door stored). */
const across = (t: Pick<StockTransferItem, 'kind'>) => isAcross(t.kind);

/** What a line says in the list: the sent figure only when the door told it, then what was counted and what is short. */
function LineText({ l, t }: { l: Line; t?: StockTransferItem }) {
  return (
    <>
      <Figures name={nameOf(l)} f={l} />
      {/* 20/11 (W8c): its combinations under it, each as blind as the line. */}
      {(l.variants ?? []).map((v) => (
        <Figures key={v.variantId} name={v.label ?? 'خيار'} f={v} className="block ps-3 text-note" />
      ))}
      {/* 21/11 (W7c): across stores — the twin, and the costs only where the door sent them. */}
      {l.toProductId && (
        <span className="block ps-3 text-note text-[var(--sys-muted-foreground)]">بيدخل على: {l.toProductName ?? 'التوأم'}</span>
      )}
      {l.costOut != null && (
        <span className="block ps-3 text-note text-[var(--sys-muted-foreground)]" data-cost={l.productId}>
          طلع بكلفة {amount(l.costOut, t?.fromCurrency)}
          {l.unitCostIn != null && <> · القطعة هناك {amount(l.unitCostIn, t?.toCurrency)}</>}
        </span>
      )}
      {(l.landedCosts ?? []).map((c, i) => (
        <span key={i} className="block ps-3 text-note text-[var(--sys-muted-foreground)]">
          {LANDED_KIND_AR[c.kind] ?? c.kind}
          {c.note ? ` (${c.note})` : ''}: {amount(c.amount, t?.toCurrency)}
        </span>
      ))}
      {l.missingValue != null && (
        <span className="block ps-3 text-note text-[var(--sys-destructive)]">
          قيمة الناقص {amount(l.missingValue, t?.fromCurrency)} — تقرير بس، ما بتنحسب على حدا
        </span>
      )}
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
  /** 21/11 (W7c): the owner's press on a request to another country. */
  const [ownerPress, setOwnerPress] = useState<StockTransferItem | null>(null);
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
    setOwnerPress(null);
    setSaid(sentence);
    void load();
  };

  const transfers = useMemo(() => data?.transfers ?? [], [data]);
  const count = (pick: (t: StockTransferItem) => boolean) => transfers.filter(pick).length;
  const shown = transfers.filter((t) =>
    only === 'all' ? true : only === 'WAITING' ? waitsForApproval(t) : t.status === only
  );
  const warehouses = data?.warehouses ?? [];
  const destinations = data?.destinations ?? [];
  // 21/11 (W7c): a send is possible to a second warehouse here, or to a warehouse of another store she reaches.
  const canOpenForm = warehouses.length >= 2 || (warehouses.length >= 1 && destinations.some((d) => d.warehouses.length > 0));

  const actions = (t: StockTransferItem) => {
    const mine = me !== null && t.sentById === me;
    const out: React.ReactNode[] = [];
    // 21/11 (W7c): the owner's press — only where the door said so (it asks again).
    if (t.status === 'AWAITING_APPROVAL' && t.mayApprove === true) {
      out.push(
        <Button key="o" type="button" size="sm" onClick={() => setOwnerPress(t)}>
          اعتمد وابعت
        </Button>
      );
    }
    if (t.status === 'AWAITING_APPROVAL' && canSend) {
      out.push(
        <Button key="c" type="button" size="sm" variant="secondary" onClick={() => setCancelling(t)}>
          إلغاء
        </Button>
      );
    }
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
      description="نقل بضاعة بين مخزنين، لنفس المتجر أو لمتجر تاني أو لبلد تاني: بتطلع من الأول، بتصير بالطريق، وبتدخل التاني لما ينعدّ."
      width="wide"
      actions={
        canSend && canOpenForm ? (
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
              // 21/11 (W7c): a request to another country, before the owner's press.
              ...(transfers.some((t) => t.status === 'AWAITING_APPROVAL')
                ? [{ value: 'AWAITING_APPROVAL', label: 'مستني اعتماد المالك', count: count((t) => t.status === 'AWAITING_APPROVAL') }]
                : []),
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
          <RoadReport road={data.road} />
          {!canOpenForm && (
            <Card plain padding="sm">
              <p className="text-sm text-[var(--sys-muted-foreground)]">
                لتنقل بضاعة لازم يكون في مخزنين شغّالين ببلد هالمتجر، أو مخزن هون ومخزن لمتجر تاني بتوصليله. المخازن بتنعرّف من «البلدان والمدن» تحت كل بلد.
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
                        {/* 21/11 (W7c): across stores, each end names its store too. */}
                        {t.fromStoreName ? `${t.fromStoreName} — ` : ''}
                        {t.fromName ?? '—'} ← {t.toStoreName ? `${t.toStoreName} — ` : ''}
                        {t.toName ?? '—'}
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
                          <LineText key={l.productId} l={l} t={t} />
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
                        {t.status === 'AWAITING_APPROVAL' && (
                          <span className="block text-note text-[var(--sys-muted-foreground)]">البضاعة لسا ما طلعت — بدّو اعتماد المالك</span>
                        )}
                        {t.approvedByName && (
                          <span className="block text-note text-[var(--sys-muted-foreground)]">اعتمده: {t.approvedByName}</span>
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
        <SendDialog
          warehouses={warehouses}
          here={data?.here}
          destinations={destinations}
          mayAbroad={data?.mayAbroad === true}
          onClose={() => setCreating(false)}
          onDone={(awaiting) =>
            done(awaiting ? 'انكتب طلب النقل — مستني اعتماد المالك، والبضاعة لسا ما طلعت.' : 'انبعت النقل — البضاعة صارت بالطريق.')
          }
        />
      )}
      {ownerPress && (
        <OwnerApproveDialog transfer={ownerPress} onClose={() => setOwnerPress(null)} onDone={() => done('انعتمد النقل وانبعت — البضاعة صارت بالطريق.')} />
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

function SendDialog({
  warehouses,
  here,
  destinations,
  mayAbroad,
  onClose,
  onDone,
}: {
  warehouses: Warehouse[];
  here?: ListAnswer['here'];
  destinations: Destination[];
  mayAbroad: boolean;
  onClose: () => void;
  /** `awaiting`: the door wrote a request that waits for the owner (another country). */
  onDone: (awaiting: boolean) => void;
}) {
  const { products } = useProducts();
  const combinations = useProductCombinations();
  const [id] = useState(newId);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  /** 21/11 (W7c): the store the goods arrive in — this one ('' ) or another she reaches. */
  const [toStore, setToStore] = useState('');
  const dest = destinations.find((d) => d.storeId === toStore) ?? null;
  const pairs = usePairs(dest ? dest.storeId : null);
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
  // 21/11 (W7c): the destination's warehouses are this store's, or those of the chosen store's country.
  const toWarehouses = dest ? dest.warehouses : warehouses;
  const toW = toWarehouses.find((w) => w.id === to);
  const fromEnd = (w: Warehouse): StockTransferEnd => ({
    warehouseId: w.id,
    warehouseName: w.name,
    storeId: here?.id ?? 'this-store',
    storeName: here?.name ?? null,
    countryId: w.countryId,
    countryName: here?.countryName ?? null,
  });
  const toEnd = (w: Warehouse): StockTransferEnd =>
    dest
      ? { warehouseId: w.id, warehouseName: w.name, storeId: dest.storeId, storeName: dest.storeName, countryId: w.countryId, countryName: dest.countryName }
      : fromEnd(w);
  const pairRefusal = fromW && toW ? stockTransferRefusal(fromEnd(fromW), toEnd(toW)) : null;
  const reading = fromW && toW && !pairRefusal ? readStockTransfer(fromEnd(fromW), toEnd(toW)) : null;
  const goesAcross = !!reading && isAcross(reading.kind);
  const waitsForOwner = !!reading && needsOwnerApproval(reading.kind);
  // The abroad key is the door's to ask; the form says it before the press, and keeps the press shut.
  const keyMissing = waitsForOwner && !mayAbroad;

  const badQty = lines.some((l) => l.quantity.trim() !== '' && (!WHOLE.test(l.quantity.trim()) || Number(l.quantity) <= 0));
  const badCombo = lines.some((l) => Object.values(l.combos).some(badBox));
  const linesReady = lines.every((l) => l.productId !== '' && WHOLE.test(l.quantity.trim()) && Number(l.quantity) > 0);
  // 21/11 (W7c): across stores, every product needs its twin there (the door asks again).
  const unpaired = goesAcross ? lines.filter((l) => l.productId !== '' && !pairs.twinOf.has(l.productId)) : [];
  const ready = !!reading && !keyMissing && linesReady && unpaired.length === 0 && !badCombo && !busy;

  const setLine = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const warehouseOptions = warehouses.map((w) => ({ value: w.id, label: w.name }));
  const toOptions = toWarehouses.map((w) => ({ value: w.id, label: w.name }));
  const storeOptions = [
    { value: '', label: here?.name ? `${here.name} (هون)` : 'هالمتجر' },
    ...destinations.map((d) => ({ value: d.storeId, label: d.countryName && d.countryId !== here?.countryId ? `${d.storeName} — ${d.countryName}` : d.storeName })),
  ];
  const chooseStore = (value: string) => {
    setToStore(value);
    setTo('');
  };
  const productName = (productId: string) => products.find((p) => p.id === productId)?.name ?? 'منتج';

  async function submit() {
    if (!reading) return;
    setBusy(true);
    setError(null);
    try {
      const out = await apiJson<{ transfer?: { status?: string } }>('/api/inventory/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          fromWarehouseId: from,
          toWarehouseId: to,
          // 21/11 (W7c): the other store, only when the goods go there.
          ...(dest ? { toStoreId: dest.storeId } : {}),
          expectKind: reading.kind,
          note: note.trim() || null,
          lines: lines.map((l) => {
            // 20/11 (W8c): the combinations sent, as typed — a line without any goes out exactly as before.
            // 21/11 (W7c): across stores no combination is asked: the door refuses such a product in its own sentence.
            const variants = goesAcross ? [] : typedCombinations(combosOf(l.productId), l.combos, { dropZero: true });
            return { productId: l.productId, quantity: Number(l.quantity.trim()), ...(variants.length > 0 ? { variants } : {}) };
          }),
        }),
        timeoutMs: 60_000,
      });
      onDone(out?.transfer?.status === 'AWAITING_APPROVAL');
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
            {waitsForOwner ? 'اطلب الاعتماد' : 'أرسل'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-[var(--sys-foreground)]">من مخزن</span>
          <Segmented aria-label="من مخزن" value={from} onChange={setFrom} options={warehouseOptions} />
        </div>
        {/* 21/11 (W7c): the store the goods arrive in — asked only when there is another one she reaches. */}
        {destinations.length > 0 && (
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-[var(--sys-foreground)]">إلى متجر</span>
            <Segmented aria-label="إلى متجر" value={toStore} onChange={chooseStore} options={storeOptions} />
          </div>
        )}
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-[var(--sys-foreground)]">إلى مخزن</span>
          {toOptions.length > 0 ? (
            <Segmented aria-label="إلى مخزن" value={to} onChange={setTo} options={toOptions} />
          ) : (
            <p className="text-note text-[var(--sys-muted-foreground)]">ما في مخزن شغّال ببلد هالمتجر.</p>
          )}
        </div>

        {/* THE KIND, BEFORE THE PRESS — the door's own reading of the two ends. */}
        {pairRefusal ? (
          <Refusal text={pairRefusal} />
        ) : reading ? (
          <div className="space-y-1.5">
            <p data-kind={reading.kind} className="rounded-lg bg-[var(--sys-surface)] p-2.5 text-sm text-[var(--sys-foreground)]">
              <span className="font-bold">{reading.label}:</span> {reading.detail}
            </p>
            {waitsForOwner && (
              <p
                data-owner-approval="yes"
                className="rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] p-2.5 text-sm text-[var(--sys-warning)]"
              >
                بدّو اعتماد المالك: الطلب بينكتب هلّق، والبضاعة ما بتطلع لحد ما المالك يضغط «اعتمد وابعت».
              </p>
            )}
            {keyMissing && <Refusal text="النقل لبلد تاني بدّو صلاحية «نقل بضاعة لبلد تاني». اطلبها من المالك." />}
          </div>
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
              {goesAcross && dest ? (
                // 21/11 (W7c): across stores, the twin of this line's product in the other store.
                l.productId !== '' && (
                  <TwinPicker productId={l.productId} productName={productName(l.productId)} storeName={dest.storeName} pairs={pairs} line={i + 1} />
                )
              ) : (
                <PickedCombinations
                  state={combinations.known[l.productId]}
                  combos={combosOf(l.productId).map((c) => ({ variantId: c.variantId, label: c.label, hint: shelfHint(c, fromW) }))}
                  values={l.combos}
                  onChange={(variantId, value) => setLine(l.key, { combos: { ...l.combos, [variantId]: value } })}
                  line={i + 1}
                />
              )}
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
  transfer: {
    status: string;
    statusAr: string;
    lines: (Shown & { productId: string; variants?: (Shown & { variantId: string })[]; unitCostIn?: number | null })[];
  };
}

/** 21/11 (W7c): «وصلت كلها ولا لأ؟» — asked on a receipt from another store, before the press. */
const ARRIVAL_OPTIONS = [
  { value: 'ALL', label: 'وصلت كلها' },
  { value: 'SHORT', label: 'في ناقص أو تالف' },
];

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
  // 21/11 (W7c): a receipt from another store — the arrival question, the landed cost lines, and a zero cost's reason.
  const fromAfar = across(transfer);
  const [arrived, setArrived] = useState('');
  const [costs, setCosts] = useState<Record<string, LandedDraft[]>>({});
  const [zeroReason, setZeroReason] = useState<Record<string, string>>({});
  const [askReason, setAskReason] = useState<string[]>([]);
  const costLines = (productId: string) => costs[productId] ?? [];
  const typedCosts = (productId: string) => costLines(productId).filter((l) => l.amount.trim() !== '' || l.note.trim() !== '');

  const box = (id: string) => (counts[id] ?? '').trim();
  const comboBox = (productId: string, variantId: string) => (comboCounts[productId]?.[variantId] ?? '').trim();
  const bad =
    products.some((p) => box(p.productId) !== '' && !WHOLE.test(box(p.productId))) ||
    products.some((p) => p.combos.some((c) => badBox(comboBox(p.productId, c.variantId))));
  const costsBad = fromAfar && products.some((p) => costLines(p.productId).some(badAmount) || !typedCosts(p.productId).every(landedReady));
  // Every combination that was sent is counted — a zero is a count; a blank is not.
  const ready =
    products.every((p) => WHOLE.test(box(p.productId)) && p.combos.every((c) => WHOLE.test(comboBox(p.productId, c.variantId)))) &&
    (!fromAfar || arrived !== '') &&
    !costsBad &&
    !busy;
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
            // 21/11 (W7c): from another store only — the typed cost lines and, when the door asked for it, a zero's reason.
            const landed = fromAfar ? landedBody(costLines(p.productId)) : [];
            const why = (zeroReason[p.productId] ?? '').trim();
            return {
              productId: p.productId,
              quantity: Number(box(p.productId)),
              ...(p.combos.length > 0 ? { variants } : {}),
              ...(landed.length > 0 ? { costs: landed } : {}),
              ...(fromAfar && why ? { zeroCostReason: why } : {}),
            };
          }),
        }),
        timeoutMs: 60_000,
      });
      setAnswer(out.transfer);
    } catch (e) {
      setError(errorText(e, 'تعذّر الاستلام'));
      // 21/11 (W7c): a unit cost of zero needs a sentence — the door names the product; the box opens under it.
      const said = (e as { data?: { code?: string; productId?: string } }).data;
      if (said?.code === 'ZERO_COST_UNEXPLAINED' && said.productId) {
        const pid = said.productId;
        setAskReason((ids) => (ids.includes(pid) ? ids : [...ids, pid]));
      }
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
              {/* 21/11 (W7c): the unit cost the server worked out — only when the door sent it (`costs.view`). */}
              {l.unitCostIn != null && (
                <span className="block text-note text-[var(--sys-muted-foreground)]" data-unit-cost={l.productId}>
                  كلفة القطعة هون: {amount(l.unitCostIn, transfer.toCurrency)}
                </span>
              )}
            </Card>
          ))}
          {fromAfar && arrived === 'ALL' && answer.status === 'RECEIVED_WITH_DIFFERENCE' && (
            <p className="rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] p-2.5 text-note text-[var(--sys-warning)]">
              قلت «وصلت كلها»، بس اللي عدّيته أقل من اللي انبعت.
            </p>
          )}
          {answer.status === 'RECEIVED_WITH_DIFFERENCE' && (
            <p className="rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] p-2.5 text-note text-[var(--sys-warning)]">
              {fromAfar
                ? 'الناقص بيعتمده شخص تالت، وبينكتب بتقرير بس: ما بينحسب على حدا ولا على الربح.'
                : 'الناقص بيضل بالطريق لحد ما شخص تالت يعتمد الفرق.'}
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
      subtitle={`${transfer.fromStoreName ? `${transfer.fromStoreName} — ` : ''}${transfer.fromName ?? '—'} ← ${transfer.toName ?? '—'}`}
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
            {fromAfar && (
              <LandedCostLines
                productName={p.name}
                currency={transfer.toCurrency ?? null}
                lines={costLines(p.productId)}
                onChange={(next) => setCosts((c) => ({ ...c, [p.productId]: next }))}
              />
            )}
            {askReason.includes(p.productId) && (
              <Input
                label={`ليش كلفة «${p.name}» صفر؟`}
                value={zeroReason[p.productId] ?? ''}
                maxLength={300}
                onChange={(e) => setZeroReason((z) => ({ ...z, [p.productId]: e.target.value }))}
              />
            )}
          </div>
        ))}
        {fromAfar && (
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-[var(--sys-foreground)]">وصلت كلها ولا لأ؟</span>
            <Segmented aria-label="وصلت كلها ولا لأ؟" value={arrived} onChange={setArrived} options={ARRIVAL_OPTIONS} />
            {arrived === 'SHORT' && (
              <p className="text-note text-[var(--sys-muted-foreground)]">
                اكتب اللي وصل سليم بس. الناقص بيعتمده شخص تالت وبينكتب بتقرير، وما بينحسب على حدا.
              </p>
            )}
          </div>
        )}
        {bad && <p className="text-note text-[var(--sys-destructive)]">العدد لازم يكون رقم صحيح من صفر وطالع.</p>}
        {costsBad && <p className="text-note text-[var(--sys-destructive)]">كمّل سطور المصاريف: المبلغ رقم، و«غيره» بدّو كلمة.</p>}
        <Refusal text={error} />
      </div>
    </Modal>
  );
}

/* ───────────────────────────── the owner's press (another country) ───────────────────────────── */

/**
 * 21/11 (W7c): «اعتمد وابعت» — the owner's press on a request to another country (`/:id/approve`). Offered only where the
 * list door said `mayApprove`; the door asks again (the owner only), then the units leave the source and are on the road.
 */
function OwnerApproveDialog({ transfer, onClose, onDone }: { transfer: StockTransferItem; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/inventory/transfers/${transfer.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        timeoutMs: 60_000,
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
      title="اعتماد نقل لبلد تاني"
      subtitle={`${transfer.fromStoreName ?? '—'} — ${transfer.fromName ?? '—'} ← ${transfer.toStoreName ?? '—'} — ${transfer.toName ?? '—'}`}
      maxWidth="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            رجوع
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy} loading={busy}>
            اعتمد وابعت
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-note text-[var(--sys-muted-foreground)]">
          لما تضغط، البضاعة بتطلع من المخزن بكلفتها وبتصير بالطريق. بتدخل البلد التاني بكلفتها مع مصاريف الوصول اللي بيكتبها المستلم.
        </p>
        {transfer.lines.map((l) => (
          <LineText key={l.productId} l={l} t={transfer} />
        ))}
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
      subtitle={
        // 21/11 (W7c): across stores the missing units left the source at the send — the approval is a report only.
        across(transfer)
          ? 'الناقص طلع من المتجر الأول لما انبعت. الاعتماد تقرير بس: ما بينحسب على حدا ولا على الربح أو المحافظ.'
          : 'الناقص بيطلع من المخزون كضايع أو تالف. ما في شي بينحسب على الربح أو المحافظ.'
      }
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
          <LineText key={l.productId} l={l} t={transfer} />
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
