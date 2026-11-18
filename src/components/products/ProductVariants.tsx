'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const v = await apiJson<{ options: Option[]; combinations: Combo[] }>(`/api/products/${productId}/variants`);
      // An answer without the two lists (an older server, a failed read) is a product without variants, never a crash.
      setOptions(Array.isArray(v?.options) ? v.options : []);
      const saved = Array.isArray(v?.combinations) ? v.combinations : [];
      setCombos(new Map(saved.map((c) => [keyOf(c.values), { ...c, active: c.status === 'ACTIVE' }])));
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

  async function save() {
    setMsg(null);
    try {
      await apiJson(`/api/products/${productId}/variants`, {
        method: 'PUT',
        body: JSON.stringify({
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
                render: (r) => (
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
