'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { RiDraggable, RiGitMergeLine, RiDeleteBinLine, RiCloseLine } from '@remixicon/react';
import { BulkBar } from '@/components/shell/BulkBar';
import { Money } from '@/components/ui/Money';
import { NO_FILTER, QUICK_FILTERS, filterCampaigns, isFiltering, type CampaignFilter, type FilterableCampaign } from '@/lib/campaign-filters';

/**
 * THE CAMPAIGNS, ARRANGED THE SELLER'S WAY — «اسحب الحملات واعيد ترتيبها دراج اند دروب، كذا شكل لعرضهم، وفلاتر
 * وبطاقات ذكية» and «زر حذف المكرر، تحديد، زر حذف الكل».
 *
 * The board draws, filters and selects; it computes no money. The cards at the top are the server's (`insights`),
 * the filters compare figures the server sent, and every write — the order, a bulk delete, merging duplicates — is
 * the screen's to confirm and the server's to do. Dragging is offered only on the whole, unfiltered list: an order
 * dragged inside a filtered slice would say nothing about the campaigns hidden between.
 */

export interface BoardCampaign extends FilterableCampaign {
  id: string;
  money: { spend: number; revenue: number; net: number; roas: number | null; costPerDelivered: number | null; costPerOrder: number | null };
  funnel: { brought: number; delivered: number };
}

export interface BoardInsights {
  best: { id: string; name: string; roas: number } | null;
  worst: { id: string; name: string; net: number } | null;
  spentNoOrders: number;
  noProduct: number;
  duplicates: number;
}

type View = 'cards' | 'table' | 'compact';
const VIEWS: { key: View; label: string }[] = [
  { key: 'cards', label: 'بطاقات' },
  { key: 'table', label: 'جدول' },
  { key: 'compact', label: 'قائمة مختصرة' },
];

const CHIP_ON = 'bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]';
const CHIP_OFF = 'text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]';
const SELECT = 'h-8 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-xs text-[var(--sys-foreground)]';
const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

export function CampaignsBoard<T extends BoardCampaign>({
  mayManage, campaigns, insights, currency, statuses, platforms, accounts,
  renderCard, onReorder, onBulkDelete, onMerge,
}: {
  /** «إدارة الحملات» (PR-11): the selection, the drag, the bulk delete and the merge are writes, drawn only for it. */
  mayManage: boolean;
  campaigns: T[];
  insights: BoardInsights | null;
  currency: string;
  statuses: readonly { key: string; label: string }[];
  platforms: readonly { key: string; label: string }[];
  accounts: { id: string; accountName: string | null; accountId: string }[];
  renderCard: (c: T) => React.ReactNode;
  onReorder: (ids: string[]) => Promise<void>;
  onBulkDelete: (ids: string[]) => Promise<void>;
  onMerge: (ids?: string[]) => Promise<void>;
}) {
  const [filter, setFilter] = useState<CampaignFilter>(NO_FILTER);
  const [view, setView] = useState<View>('cards');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<string[]>(campaigns.map((c) => c.id));

  // The view is a per-person convenience: remembered in this browser, never required.
  useEffect(() => {
    try {
      const v = localStorage.getItem('campaigns.view') as View | null;
      if (v && VIEWS.some((x) => x.key === v)) setView(v);
    } catch { /* storage refused — the default view still works */ }
  }, []);
  const pickView = (v: View) => {
    setView(v);
    try { localStorage.setItem('campaigns.view', v); } catch { /* ignore */ }
  };

  // A fresh list from the server is the truth; a selection of rows that no longer exist is dropped.
  useEffect(() => {
    setOrder(campaigns.map((c) => c.id));
    setSelected((s) => new Set([...s].filter((id) => campaigns.some((c) => c.id === id))));
  }, [campaigns]);

  const byId = useMemo(() => new Map(campaigns.map((c) => [c.id, c])), [campaigns]);
  const ordered = useMemo(() => order.map((id) => byId.get(id)).filter((c): c is T => !!c), [order, byId]);
  const shown = useMemo(() => filterCampaigns(ordered, filter), [ordered, filter]);
  const filtering = isFiltering(filter);
  const products = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of campaigns) if (c.product) m.set(c.product.id, (c.product as { id: string; name?: string }).name ?? c.product.id);
    return [...m.entries()];
  }, [campaigns]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!mayManage || !over || active.id === over.id) return;
    const next = arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)));
    setOrder(next);
    void onReorder(next);
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allShownSelected = shown.length > 0 && shown.every((c) => selected.has(c.id));
  const selectShown = () => setSelected(allShownSelected ? new Set() : new Set(shown.map((c) => c.id)));
  const selectedDuplicates = [...selected].filter((id) => byId.get(id)?.duplicateOf);
  const set = (patch: Partial<CampaignFilter>) => setFilter((f) => ({ ...f, ...patch }));

  const item = (c: T) => {
    const body =
      view === 'cards' ? renderCard(c)
      : view === 'compact' ? <CompactRow c={c} currency={currency} />
      : <TableRow c={c} currency={currency} />;
    return { id: c.id, body };
  };

  return (
    <div className="space-y-3">
      {/* The smart cards — the server's answers; a click narrows the list to them. */}
      {insights && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <Card label="أفضل عائد" value={insights.best ? `${fmt(insights.best.roas)}×` : '—'} hint={insights.best?.name} tone="good" />
          <Card label="أكبر خسارة" value={insights.worst ? `${fmt(insights.worst.net)} ${currency}` : '—'} hint={insights.worst?.name} tone="bad" />
          <Card label="صرفت بلا طلبات" value={String(insights.spentNoOrders)} tone={insights.spentNoOrders ? 'bad' : undefined} onClick={() => set({ quick: 'spentNoOrders' })} />
          <Card label="بلا منتج" value={String(insights.noProduct)} tone={insights.noProduct ? 'warn' : undefined} onClick={() => set({ quick: 'noProduct' })} />
          <Card label="مكررة" value={String(insights.duplicates)} tone={insights.duplicates ? 'warn' : undefined} onClick={() => set({ quick: 'duplicates' })} />
        </div>
      )}

      {/* The filters. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-2.5">
        <input
          aria-label="ابحث في الحملات"
          placeholder="ابحث بالاسم أو الرمز"
          value={filter.q}
          onChange={(e) => set({ q: e.target.value })}
          className={`${SELECT} w-40 flex-1`}
        />
        <select aria-label="الحالة" value={filter.status} onChange={(e) => set({ status: e.target.value })} className={SELECT}>
          <option value="">كل الحالات</option>
          {statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select aria-label="المنصة" value={filter.platform} onChange={(e) => set({ platform: e.target.value })} className={SELECT}>
          <option value="">كل المنصات</option>
          {platforms.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <select aria-label="الحساب الإعلاني" value={filter.account} onChange={(e) => set({ account: e.target.value })} className={SELECT}>
          <option value="">كل الحسابات</option>
          <option value="none">بلا حساب (يدوية)</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountName ?? a.accountId}</option>)}
        </select>
        <select aria-label="المنتج" value={filter.product} onChange={(e) => set({ product: e.target.value })} className={SELECT}>
          <option value="">كل المنتجات</option>
          <option value="none">بلا منتج</option>
          {products.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="flex flex-wrap gap-1">
          {QUICK_FILTERS.map((q) => (
            <button key={q.key} type="button" onClick={() => set({ quick: filter.quick === q.key ? '' : q.key })}
              className={`rounded-md px-2 py-1 text-xs font-semibold ${filter.quick === q.key ? CHIP_ON : CHIP_OFF}`}>
              {q.label}
            </button>
          ))}
        </div>
        {filtering && (
          <button type="button" onClick={() => setFilter(NO_FILTER)} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${CHIP_OFF}`}>
            <RiCloseLine className="h-4 w-4" /> امسح الفلاتر
          </button>
        )}
      </div>

      {/* The view, selection and the duplicates button. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {mayManage && (
          <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--sys-foreground)]">
            <input type="checkbox" aria-label="حدد كل المعروض" checked={allShownSelected} onChange={selectShown} />
            حدد كل المعروض ({shown.length})
          </label>
          )}
          {mayManage && insights && insights.duplicates > 0 && (
            <button type="button" onClick={() => void onMerge()}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--sys-warning)] px-2 py-1 text-xs font-semibold text-[var(--sys-warning)]">
              <RiGitMergeLine className="h-4 w-4" /> احذف المكرر ({insights.duplicates})
            </button>
          )}
        </div>
        <div className="flex rounded-lg border border-[var(--sys-border)] p-0.5" role="group" aria-label="شكل العرض">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" onClick={() => pickView(v.key)} aria-pressed={view === v.key}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold ${view === v.key ? CHIP_ON : CHIP_OFF}`}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {mayManage && filtering && <p className="text-xs text-[var(--sys-muted)]">الترتيب بالسحب متاح على القائمة كاملة — امسح الفلاتر لتسحب.</p>}

      {view === 'table' && <TableHead />}
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd}>
        <SortableContext items={shown.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <ul className={view === 'cards' ? 'space-y-2' : 'divide-y divide-[var(--sys-border)] rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]'}>
            {shown.map((c) => {
              const { id, body } = item(c);
              return (
                <SortableItem key={id} id={id} mayManage={mayManage} draggable={mayManage && !filtering} selected={selected.has(id)} onToggle={() => toggle(id)} name={c.name}>
                  {body}
                </SortableItem>
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
      {shown.length === 0 && <p className="py-6 text-center text-sm text-[var(--sys-muted-foreground)]">ما في حملة بهالفلاتر.</p>}

      <BulkBar show={mayManage && selected.size > 0}>
        <span className="text-xs font-semibold">{selected.size} محددة</span>
        <button type="button" onClick={() => void onBulkDelete([...selected])}
          className="inline-flex items-center gap-1 rounded-lg bg-[var(--sys-destructive)] px-3 py-1.5 text-xs font-semibold text-white">
          <RiDeleteBinLine className="h-4 w-4" /> احذف المحدد
        </button>
        {selectedDuplicates.length > 0 && (
          <button type="button" onClick={() => void onMerge(selectedDuplicates)}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--sys-border)] px-3 py-1.5 text-xs font-semibold">
            <RiGitMergeLine className="h-4 w-4" /> ادمج المكرر المحدد ({selectedDuplicates.length})
          </button>
        )}
        <button type="button" onClick={() => setSelected(new Set())} className="rounded-lg px-3 py-1.5 text-xs">إلغاء التحديد</button>
      </BulkBar>
    </div>
  );
}

function SortableItem({ id, mayManage, draggable, selected, onToggle, name, children }: {
  id: string; mayManage: boolean; draggable: boolean; selected: boolean; onToggle: () => void; name: string; children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !draggable });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }} className="flex items-start gap-1.5">
      <div className="flex shrink-0 flex-col items-center gap-1 pt-3">
        {mayManage && <input type="checkbox" aria-label={`حدد ${name}`} checked={selected} onChange={onToggle} />}
        {draggable && (
          <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={`اسحب ${name}`}
            style={{ touchAction: 'none' }} className="cursor-grab text-[var(--sys-muted-foreground)]">
            <RiDraggable className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function Card({ label, value, hint, tone, onClick }: { label: string; value: string; hint?: string; tone?: 'good' | 'warn' | 'bad'; onClick?: () => void }) {
  const colour = tone === 'good' ? 'text-[var(--sys-success)]' : tone === 'bad' ? 'text-[var(--sys-destructive)]' : tone === 'warn' ? 'text-[var(--sys-warning)]' : 'text-[var(--sys-heading)]';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3 text-start">
      <p className="text-xs font-semibold text-[var(--sys-muted-foreground)]">{label}</p>
      <p className={`mt-0.5 text-base font-bold tabular-nums ${colour}`} dir="ltr">{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-[var(--sys-muted)]" title={hint}>{hint}</p>}
    </Tag>
  );
}

const COLS = 'grid grid-cols-7 items-center gap-2 px-3 py-2 text-xs';

function TableHead() {
  return (
    <div className={`${COLS} font-semibold text-[var(--sys-muted-foreground)]`} style={{ paddingInlineStart: 40 }}>
      <span>الحملة</span><span>أُنفق</span><span>عاد</span><span>الفرق</span><span>العائد</span><span>طلبات · وصلت</span><span>كلفة الواصل</span>
    </div>
  );
}

function TableRow({ c, currency }: { c: BoardCampaign; currency: string }) {
  return (
    <div className={COLS}>
      <span className="truncate font-semibold text-[var(--sys-heading)]" title={c.name}>{c.name}</span>
      <span><Money value={c.money.spend} currency={currency} /></span>
      <span><Money value={c.money.revenue} currency={currency} /></span>
      <span dir="ltr" className={c.money.net >= 0 ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}>{fmt(c.money.net)}</span>
      <span dir="ltr">{c.money.roas === null ? '—' : `${fmt(c.money.roas)}×`}</span>
      <span>{c.funnel.brought} · {c.funnel.delivered}</span>
      <span dir="ltr">{fmt(c.money.costPerDelivered)}</span>
    </div>
  );
}

function CompactRow({ c, currency }: { c: BoardCampaign; currency: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
      <span className="truncate font-semibold text-[var(--sys-heading)]" title={c.name}>{c.name}</span>
      <span className="shrink-0 tabular-nums text-[var(--sys-muted-foreground)]" dir="ltr">
        <Money value={c.money.spend} currency={currency} /> · {c.money.roas === null ? '—' : `${fmt(c.money.roas)}×`} · {c.funnel.brought}
      </span>
    </div>
  );
}
