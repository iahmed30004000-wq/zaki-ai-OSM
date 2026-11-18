'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';

/**
 * المقاس واللون لكل قطعة — on the order card, for the lines of products with variants (the owner, 2026-11-18).
 *
 * Shows what each piece is, and lets the team set it when the order came without a choice (an older page, an abandoned
 * cart, a lines edit that changed the units) or when the customer changes a size on the call. Writes the pieces only
 * (`PUT /api/orders/[id]/pieces`): the price is never changed here — a different price difference is said, and the
 * line's price is changed in the lines edit, where prices are changed. Draws nothing for an order with no such line.
 */

interface Combination {
  id: string;
  label: string;
  priceDelta: number;
  available: boolean;
}
interface PiecesLine {
  id: string;
  productName: string;
  quantity: number;
  freeQuantity: number;
  variantSummary: string | null;
  units: { variantId: string | null; label: string; free: boolean }[];
  variants: { combinations: Combination[] } | null;
}

export function OrderPieces({ orderId, canEdit, onSaved }: { orderId: string; canEdit: boolean; onSaved?: () => void }) {
  const [lines, setLines] = useState<PiecesLine[]>([]);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});

  const load = useCallback(async () => {
    try {
      const r = await apiJson<{ lines?: PiecesLine[] }>(`/api/orders/${orderId}/pieces`);
      const got = Array.isArray(r?.lines) ? r.lines : [];
      setLines(got);
      setDraft(Object.fromEntries(got.map((l) => [l.id, Array.from({ length: l.quantity + l.freeQuantity }, (_, i) => l.units[i]?.variantId ?? '')])));
    } catch {
      setLines([]);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (lines.length === 0) return null;

  async function save(line: PiecesLine) {
    const units = draft[line.id] ?? [];
    if (units.some((u) => !u)) {
      setMsg((m) => ({ ...m, [line.id]: { ok: false, text: 'اختر المقاس واللون لكل قطعة.' } }));
      throw new Error('incomplete');
    }
    try {
      const r = await apiJson<{ variantDelta: number }>(`/api/orders/${orderId}/pieces`, { method: 'PUT', body: JSON.stringify({ itemId: line.id, units }) });
      const before = line.units.reduce((n, u) => n + (line.variants?.combinations.find((c) => c.id === u.variantId)?.priceDelta ?? 0), 0);
      setMsg((m) => ({
        ...m,
        [line.id]: {
          ok: true,
          text:
            Math.abs((r?.variantDelta ?? 0) - before) > 1e-9
              ? 'تم الحفظ. فرق السعر بين القطع تغيّر — السعر ما تغيّر تلقائيًا، عدّله من «تعديل» إذا لزم.'
              : 'تم الحفظ',
        },
      }));
      await load();
      onSaved?.();
    } catch (e) {
      setMsg((m) => ({ ...m, [line.id]: { ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' } }));
      throw e;
    }
  }

  return (
    <div className="rounded-lg border border-[var(--sys-border)] p-3 space-y-3">
      <h4 className="text-sm font-bold text-[var(--sys-heading)]">المقاس واللون لكل قطعة</h4>
      {lines.map((line) => {
        const combos = line.variants?.combinations ?? [];
        const pieces = draft[line.id] ?? [];
        return (
          <div key={line.id} className="space-y-2">
            <p className="text-sm text-[var(--sys-heading)]">
              {line.productName}
              {!line.variantSummary && <span className="ms-2 text-sm font-bold text-[var(--sys-warning)]">لم تُحدَّد القطع بعد</span>}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {pieces.map((value, i) => (
                <Select
                  key={i}
                  label={`القطعة ${i + 1}${i >= line.quantity ? ' (مجانًا)' : ''}`}
                  value={value}
                  disabled={!canEdit}
                  onChange={(e) => setDraft((d) => ({ ...d, [line.id]: pieces.map((p, j) => (j === i ? e.target.value : p)) }))}
                >
                  <option value="">—</option>
                  {combos.map((c) => (
                    <option key={c.id} value={c.id} disabled={!c.available && c.id !== value}>
                      {c.label}
                      {c.priceDelta ? ` (${c.priceDelta > 0 ? '+' : ''}${c.priceDelta})` : ''}
                      {!c.available ? ' — نفدت' : ''}
                    </option>
                  ))}
                </Select>
              ))}
            </div>
            {canEdit && (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => save(line)}>
                  حفظ القطع
                </Button>
                {msg[line.id] && (
                  <span className={`text-sm ${msg[line.id].ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg[line.id].text}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
