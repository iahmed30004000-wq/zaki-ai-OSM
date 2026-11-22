'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input, Select } from '@/components/ui/Input';
import { Rows } from '@/components/ui/Rows';
import { apiJson } from '@/lib/api-client';
import { RiAddLine, RiCloseLine, RiInformationLine, RiPaletteLine } from '@remixicon/react';

/**
 * المقاسات والألوان — A PRODUCT'S OPTIONS AND ITS COMBINATIONS (the owner, 2026-11-18).
 *
 * The seller names the option types («المقاس»، «اللون») and their values; every combination is drawn below as a row
 * with its own price difference, its own counted stock and its own SKU, and may be switched off when it is not made
 * (no «XL · كحلي»). Saved through `PUT /api/products/[id]/variants`, which keeps a combination's id while it is edited
 * and archives — never deletes — one that leaves the list, because an order may name it.
 *
 * A product with no options is a product without variants and sells exactly as before.
 *
 * 22/11 (F1) — A STORE PLACED IN WAREHOUSES. A combination's count is a WAREHOUSE's there (W8a), so the screen asks
 * which warehouse was counted — the choices are the server's (`warehouses`, the list the count's own check accepts;
 * `defaultWarehouseId` = the one she keeps) — and each box holds what THAT warehouse has of the combination, with a
 * reason for a change. Without a warehouse the boxes are shut and the totals go back as they are, so a price, a SKU or
 * a name still saves. Under each box: where the pieces are («بلا مكان», «بالطريق» for a transfer's road — never mixed).
 * A store that is NOT placed: the screen and the request are the ones they were.
 */

interface Value {
  id: string;
  label: string;
  swatch: string | null;
}
interface Option {
  id: string;
  name: string;
  values: Value[];
}
interface Combo {
  id?: string;
  values: string[];
  label?: string;
  sku: string | null;
  priceDelta: number;
  onHand: number;
  held?: number;
  free?: number;
  status?: string;
  active?: boolean;
  /** A placed store only: where the pieces are (`warehouseId` null = «بلا مكان»; `inTransit` = on a transfer's road). */
  places?: Place[];
}
interface Place {
  warehouseId: string | null;
  onHand: number;
  inTransit?: boolean;
}
interface Warehouse {
  id: string;
  name: string;
}
interface ComboRow {
  values: string[];
  label: string;
  combo: Combo;
}

const newId = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}`;

function cartesian(options: Option[]): string[][] {
  if (options.length === 0) return [];
  return options.reduce<string[][]>((acc, o) => acc.flatMap((row) => o.values.map((v) => [...row, v.id])), [[]]);
}

const keyOf = (values: string[]) => JSON.stringify(values);
const blank = (values: string[]): Combo => ({ values, sku: null, priceDelta: 0, onHand: 0, active: true });

/** What one warehouse holds of a combination — a shelf place, never the road. */
const heldIn = (combo: Combo, warehouseId: string) =>
  combo.places?.find((p) => p.warehouseId === warehouseId && !p.inTransit)?.onHand ?? 0;

/** «مخزن أ 4 · بلا مكان 2 · بالطريق 1» — the server's places, by name. */
function placesLine(combo: Combo, warehouses: readonly Warehouse[]): string {
  const parts = (combo.places ?? [])
    .filter((p) => p.onHand !== 0)
    .map((p) => {
      const name = p.inTransit
        ? 'بالطريق'
        : p.warehouseId === null
          ? 'بلا مكان'
          : (warehouses.find((w) => w.id === p.warehouseId)?.name ?? 'مخزن تاني');
      return `${name} ${p.onHand}`;
    });
  return parts.length > 0 ? parts.join(' · ') : 'ولا قطعة';
}

export function ProductVariants({
  productId,
  canManage,
  canChangePrice,
  currency,
}: {
  productId: string;
  canManage: boolean;
  canChangePrice: boolean;
  currency: string;
}) {
  const [options, setOptions] = useState<Option[]>([]);
  const [combos, setCombos] = useState<Map<string, Combo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 22/11 (F1): a placed store only — null for any other, and then nothing below is drawn or sent.
  const [placed, setPlaced] = useState<{ warehouses: Warehouse[] } | null>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [reason, setReason] = useState('');
  const [counted, setCounted] = useState<Map<string, number>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const v = await apiJson<{
        options: Option[];
        combinations: Combo[];
        placed?: boolean;
        warehouses?: Warehouse[];
        defaultWarehouseId?: string | null;
      }>(`/api/products/${productId}/variants`);
      // An answer without the two lists (an older server, a failed read) is a product without variants, never a crash.
      setOptions(Array.isArray(v?.options) ? v.options : []);
      const saved = Array.isArray(v?.combinations) ? v.combinations : [];
      setCombos(new Map(saved.map((c) => [keyOf(c.values), { ...c, active: c.status === 'ACTIVE' }])));
      if (v?.placed === true) {
        const warehouses = Array.isArray(v.warehouses) ? v.warehouses : [];
        setPlaced({ warehouses });
        // The warehouse she was counting stays chosen after a save; otherwise the server's choice for her, or none.
        setWarehouseId((was) => (warehouses.some((w) => w.id === was) ? was : (v.defaultWarehouseId ?? '')));
        setCounted(new Map());
        setReason('');
      } else {
        setPlaced(null);
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر التحميل' });
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every combination the options make, each with what is saved for it — or a fresh row, active, with no stock.
  const rows = useMemo<ComboRow[]>(
    () =>
      cartesian(options).map((values) => ({
        values,
        label: options.map((o, i) => o.values.find((v) => v.id === values[i])?.label ?? '').join(' · '),
        combo: combos.get(keyOf(values)) ?? blank(values),
      })),
    [options, combos]
  );

  const setCombo = (values: string[], patch: Partial<Combo>) =>
    setCombos((m) => {
      const next = new Map(m);
      const k = keyOf(values);
      next.set(k, { ...(m.get(k) ?? blank(values)), ...patch });
      return next;
    });

  const setOption = (i: number, patch: Partial<Option>) => setOptions((os) => os.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const setValue = (i: number, k: number, patch: Partial<Value>) =>
    setOption(i, { values: options[i].values.map((v, j) => (j === k ? { ...v, ...patch } : v)) });

  /**
   * 22/11 (F1): the placed store's PUT — the door's own shape (W8a). With a warehouse: each combination's number is what
   * THAT warehouse holds of it, with the warehouse and the reason. Without one: the totals as the server gave them (a new
   * combination: 0), so only the options, names, prices and SKUs change.
   */
  const placedBody = () =>
    JSON.stringify({
      options: options.map((o) => ({ ...o, name: o.name.trim(), values: o.values.map((v) => ({ ...v, label: v.label.trim() })) })),
      combinations: rows.map((r) => ({
        values: r.values,
        sku: r.combo.sku || null,
        priceDelta: Number(r.combo.priceDelta) || 0,
        onHand: warehouseId ? Math.max(0, Math.trunc(Number(countOf(r)) || 0)) : r.combo.id ? r.combo.onHand : 0,
        active: r.combo.active !== false,
      })),
      ...(warehouseId ? { warehouseId, reason: reason.trim() } : {}),
    });
  const countOf = (r: ComboRow) => counted.get(keyOf(r.values)) ?? heldIn(r.combo, warehouseId);

  async function save() {
    setMsg(null);
    try {
      await apiJson(`/api/products/${productId}/variants`, {
        method: 'PUT',
        body: placed ? placedBody() : JSON.stringify({
          options: options.map((o) => ({ ...o, name: o.name.trim(), values: o.values.map((v) => ({ ...v, label: v.label.trim() })) })),
          combinations: rows.map((r) => ({
            values: r.values,
            sku: r.combo.sku || null,
            priceDelta: Number(r.combo.priceDelta) || 0,
            onHand: Math.max(0, Math.trunc(Number(r.combo.onHand) || 0)),
            active: r.combo.active !== false,
          })),
        }),
      });
      setMsg({ ok: true, text: 'تم الحفظ' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
      throw e;
    }
  }

  if (loading) return <p className="text-sm text-[var(--sys-muted-foreground)]">جارٍ التحميل…</p>;

  return (
    <div className="space-y-4">
      {options.length === 0 && (
        <p className="flex items-start gap-1.5 text-sm text-[var(--sys-muted-foreground)]">
          <RiInformationLine className="mt-0.5 h-4 w-4 shrink-0" />
          <span>هذا المنتج بلا مقاسات أو ألوان، ويُباع كما هو. أضف خيارًا (مثل «المقاس» أو «اللون») ليختار الزبون لكل قطعة.</span>
        </p>
      )}

      {options.map((o, i) => (
        <div key={o.id} className="rounded-lg border border-[var(--sys-border)] p-3 space-y-2">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input label="اسم الخيار" value={o.name} disabled={!canManage} maxLength={40} onChange={(e) => setOption(i, { name: e.target.value })} />
            </div>
            {canManage && (
              <IconButton label="احذف هذا الخيار" onClick={() => setOptions((os) => os.filter((_, j) => j !== i))}>
                <RiCloseLine className="h-4 w-4" />
              </IconButton>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {o.values.map((v, k) => (
              <div key={v.id} className="flex items-end gap-1">
                <div className="w-24">
                  <Input
                    aria-label={`قيمة ${k + 1} من ${o.name || 'الخيار'}`}
                    value={v.label}
                    maxLength={40}
                    disabled={!canManage}
                    onChange={(e) => setValue(i, k, { label: e.target.value })}
                  />
                </div>
                {/* The swatch: a colour value draws as a dot on the page; a value without one draws as text. */}
                <input
                  type="color"
                  aria-label={`لون ${v.label || 'القيمة'}`}
                  title="لون العيّنة (اختياري)"
                  className={`h-11 md:h-10 w-11 md:w-10 cursor-pointer rounded-md bg-transparent ${v.swatch ? '' : 'opacity-30'}`}
                  value={v.swatch ?? '#000000'}
                  disabled={!canManage}
                  onChange={(e) => setValue(i, k, { swatch: e.target.value })}
                />
                {canManage && v.swatch && (
                  <IconButton label={`بلا لون لـ ${v.label || 'القيمة'}`} onClick={() => setValue(i, k, { swatch: null })}>
                    <RiPaletteLine className="h-4 w-4" />
                  </IconButton>
                )}
                {canManage && (
                  <IconButton label={`احذف ${v.label || 'القيمة'}`} onClick={() => setOption(i, { values: o.values.filter((_, j) => j !== k) })}>
                    <RiCloseLine className="h-4 w-4" />
                  </IconButton>
                )}
              </div>
            ))}
            {canManage && o.values.length < 30 && (
              <Button variant="secondary" size="sm" onClick={() => setOption(i, { values: [...o.values, { id: newId('v'), label: '', swatch: null }] })}>
                <RiAddLine className="h-4 w-4" /> قيمة
              </Button>
            )}
          </div>
        </div>
      ))}

      {canManage && options.length < 3 && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setOptions((os) => [...os, { id: newId('o'), name: os.length === 0 ? 'المقاس' : os.length === 1 ? 'اللون' : '', values: [{ id: newId('v'), label: '', swatch: null }] }])
          }
        >
          <RiAddLine className="h-4 w-4" /> أضف خيارًا
        </Button>
      )}

      {rows.length > 0 && (
        <>
          {placed && canManage && (
            // 22/11 (F1): which warehouse was counted — only the ones the server says she may count in.
            <div className="space-y-2">
              {placed.warehouses.length === 0 ? (
                <p className="text-sm text-[var(--sys-destructive)]">
                  هالمتجر موزّع على مخازن، وما إلك وصول على ولا مخزن منها. بتقدر تغيّر الأسعار والأسماء، والعدّ بيعمله أمين المخزن.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Select
                    label="المخزن اللي عدّيته"
                    value={warehouseId}
                    onChange={(e) => {
                      setWarehouseId(e.target.value);
                      setCounted(new Map());
                    }}
                    options={[
                      { value: '', label: 'بلا عدّ — أسعار وأسماء بس' },
                      ...placed.warehouses.map((w) => ({ value: w.id, label: w.name })),
                    ]}
                  />
                  {warehouseId && (
                    <Input label="سبب العدّ" value={reason} maxLength={300} placeholder="مثال: جرد آخر الشهر" onChange={(e) => setReason(e.target.value)} />
                  )}
                </div>
              )}
            </div>
          )}
          <Rows<ComboRow>
            rows={rows}
            keyOf={(r) => keyOf(r.values)}
            columns={[
              { key: 'label', label: 'التركيبة', primary: true, render: (r) => <span className="font-bold">{r.label}</span> },
              {
                key: 'active',
                label: 'متاحة',
                render: (r) => (
                  <Checkbox
                    aria-label={`${r.label} متاحة للبيع`}
                    checked={r.combo.active !== false}
                    disabled={!canManage}
                    onChange={(checked) => setCombo(r.values, { active: checked })}
                  />
                ),
              },
              {
                key: 'delta',
                label: `فرق السعر (${currency})`,
                render: (r) => (
                  <Input
                    type="number"
                    step="any"
                    aria-label={`فرق سعر ${r.label}`}
                    value={r.combo.priceDelta}
                    disabled={!canManage || !canChangePrice}
                    onChange={(e) => setCombo(r.values, { priceDelta: e.target.value === '' ? 0 : Number(e.target.value) })}
                  />
                ),
              },
              {
                key: 'onHand',
                label: 'المخزون',
                render: (r) =>
                  placed ? (
                    // 22/11 (F1): a placed store — the chosen warehouse's count, and under it where every piece is.
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`عدد ${r.label} بالمخزن`}
                          value={warehouseId ? countOf(r) : r.combo.onHand}
                          disabled={!canManage || !warehouseId}
                          onChange={(e) =>
                            setCounted((m) => new Map(m).set(keyOf(r.values), e.target.value === '' ? 0 : Number(e.target.value)))
                          }
                        />
                        {r.combo.free !== undefined && r.combo.free <= 0 && r.combo.active !== false && (
                          <span className="text-sm font-bold text-[var(--sys-destructive)]">نفدت</span>
                        )}
                      </div>
                      <p className="text-note text-[var(--sys-muted-foreground)]">
                        الكل {r.combo.onHand}: {placesLine(r.combo, placed.warehouses)}
                      </p>
                    </div>
                  ) : (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      aria-label={`مخزون ${r.label}`}
                      value={r.combo.onHand}
                      disabled={!canManage}
                      onChange={(e) => setCombo(r.values, { onHand: e.target.value === '' ? 0 : Number(e.target.value) })}
                    />
                    {r.combo.free !== undefined && r.combo.free <= 0 && r.combo.active !== false && (
                      <span className="text-sm font-bold text-[var(--sys-destructive)]">نفدت</span>
                    )}
                  </div>
                  ),
              },
              { key: 'held', label: 'محجوز', align: 'end', render: (r) => <span className="tabular-nums">{r.combo.held ?? 0}</span> },
              {
                key: 'sku',
                label: 'SKU',
                render: (r) => (
                  <Input
                    aria-label={`SKU ${r.label}`}
                    value={r.combo.sku ?? ''}
                    maxLength={80}
                    disabled={!canManage}
                    onChange={(e) => setCombo(r.values, { sku: e.target.value })}
                  />
                ),
              },
            ]}
          />
          {placed && (
            <p className="text-sm text-[var(--sys-muted-foreground)]">
              هالمتجر موزّع على مخازن: كل خانة عدد هي اللي بالمخزن اللي اخترته. تغيير عدد بدّو سبب. «بلا مكان» قطع ما انعدّت بمخزن لسا، و«بالطريق» قطع بنقل ما وصل.
            </p>
          )}
          <p className="text-sm text-[var(--sys-muted-foreground)]">
            فرق السعر يُضاف على سعر العرض لكل قطعة من هذه التركيبة (القطع المجانية أيضًا). المخزون هو العدد الموجود على الرف لهذه التركيبة، و«محجوز» ما تحجزه الطلبات المؤكدة منها.
          </p>
        </>
      )}

      {canManage && (
        <div className="flex items-center gap-3">
          <Button onClick={save}>حفظ المقاسات والألوان</Button>
          {msg && <span className={`text-sm ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</span>}
        </div>
      )}
      {!canManage && msg && <p className="text-sm text-[var(--sys-destructive)]">{msg.text}</p>}
    </div>
  );
}
