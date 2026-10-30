'use client';

import { batchTotal, batchUnitCost } from '@/lib/product-cost';
import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { RiAddCircleLine, RiCloseLine, RiLoader4Line } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { useToast } from '@/components/ui/Toast';
import { useIsPhone } from '@/hooks/useIsPhone';

/**
 * WHAT THIS RUN ACTUALLY COST.
 *
 * A batch could be created and never corrected, so most of this company's
 * stock sits at a cost of zero — and every profit figure in the system is
 * gross wearing the word "صافي". This is the only way to fix that.
 *
 * The unit cost is shown as it is typed, against what the batch costs now,
 * because that one number is what every margin in the system is built on:
 * it prices the remaining stock, and it is what each delivered order is
 * charged. Entering it blind is how a batch ends up at ten times its cost
 * and nobody notices until the month closes.
 *
 * The quantity is deliberately absent. Produced, sold and remaining belong
 * to the stock ledger, and this dialog changes cost only.
 */

export interface BatchForCost {
  id: string;
  batchNumber: string;
  quantityProduced: number;
  quantitySold: number;
  manufacturingCost: number;
  packagingCost: number;
  rawMaterialCost: number;
  otherCosts: number;
  costPerUnit: number;
  totalProductionCost: number;
  product?: { name: string; sku: string } | null;
  costLines?: { label: string; amount: number }[];
}

const FIELD =
  'w-full h-10 px-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] text-xs text-[var(--sys-foreground)] focus:outline-none focus:border-[var(--sys-primary)]';

const BUCKETS = [
  { key: 'rawMaterialCost', label: 'المواد الخام' },
  { key: 'manufacturingCost', label: 'التصنيع' },
  { key: 'packagingCost', label: 'التغليف' },
  { key: 'otherCosts', label: 'أخرى' },
] as const;

export function BatchCostDialog({
  batch,
  onClose,
  onSaved,
}: {
  batch: BatchForCost;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const phone = useIsPhone();
  // A finger needs 44px; the shared field is 40 and 12px on every screen. The size of the text on a phone is the
  // stylesheet's (a field under 16px zooms the page on an iPhone).
  const INPUT = phone ? FIELD.replace('h-10', 'h-11') : FIELD;
  const [buckets, setBuckets] = useState({
    rawMaterialCost: batch.rawMaterialCost,
    manufacturingCost: batch.manufacturingCost,
    packagingCost: batch.packagingCost,
    otherCosts: batch.otherCosts,
  });
  const [lines, setLines] = useState<{ label: string; amount: number }[]>(batch.costLines ?? []);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  /*
   * THE TWO FUNCTIONS THE SERVER USES, not a second copy of them.
   *
   * This added the buckets and the lines by hand and divided, both
   * unrounded, while `/api/production` and `/api/production/[id]` record
   * four places. So `0.1 + 0.2` was 0.30000000000000004 here and 0.3 there,
   * and `10 / 3` was 3.3333333333333335 against a stored 3.3333.
   *
   * The CREATE form for these same two figures — `ManufacturingScreen` —
   * was corrected to call them and its comment records the defect: «the
   * unit cost somebody watched while typing could differ from the one
   * written down». This is the EDIT form for the same two figures and it
   * still did it the old way; the fix landed on one of a pair.
   *
   * It matters past the display: line 186 compares `perUnit` against the
   * stored four-place `costPerUnit` with `> 0.005` to decide whether a
   * «(كانت …)» chip appears, so an unrounded figure made that chip a
   * function of float noise.
   */
  const { total } = batchTotal({ ...buckets, costLines: lines });
  // Over what was PRODUCED, never over what was sold: dividing by the sold
  // count would price the remaining stock at several times its cost.
  const perUnit = batchUnitCost(total, batch.quantityProduced);

  const save = async () => {
    setBusy(true);
    try {
      await apiJson(`/api/production/${batch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...buckets,
          costLines: lines.filter((l) => l.label.trim()),
          reason: reason.trim() || null,
        }),
      });
      onSaved();
      onClose();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`كلفة التشغيلة ${batch.batchNumber}`}>
      <div className="space-y-4">
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          {batch.product?.name} · أُنتج {batch.quantityProduced} قطعة، بِيع منها {batch.quantitySold}.
          تسري الكلفة على المخزون المتبقي وعلى الطلبات الجديدة — الطلبات المكتوبة سابقاً
          تحمل كلفتها وقت البيع ولا تتغيّر. ولا تتأثر الكميات.
        </p>

        <div className="grid grid-cols-2 gap-3">
          {BUCKETS.map((b) => (
            <label key={b.key} className="block">
              <span className="block text-xs text-[var(--sys-muted-foreground)] mb-1">{b.label}</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={buckets[b.key]}
                onChange={(e) => setBuckets({ ...buckets, [b.key]: Number(e.target.value) })}
                className={INPUT}
                dir="ltr"
              />
            </label>
          ))}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-[var(--sys-muted-foreground)]">بنود إضافية</span>
            <button
              type="button"
              onClick={() => setLines([...lines, { label: '', amount: 0 }])}
              disabled={lines.length >= 30}
              className="inline-flex min-h-11 items-center gap-1 text-xs text-[var(--sys-primary)] hover:underline disabled:opacity-50 md:min-h-0"
            >
              <RiAddCircleLine className="w-4 h-4" /> بند
            </button>
          </div>
          {lines.length === 0 ? (
            <p className="text-xs text-[var(--sys-muted)]">لا بنود إضافية — «قالب»، «أجرة عامل»، «شحن المواد».</p>
          ) : (
            <div className="space-y-2">
              {lines.map((line, i) => (
                <div key={i} className={phone ? 'flex flex-wrap items-center gap-2' : 'flex items-center gap-2'}>
                  <input
                    value={line.label}
                    placeholder="اسم البند"
                    onChange={(e) =>
                      setLines(lines.map((l, n) => (n === i ? { ...l, label: e.target.value } : l)))
                    }
                    className={`${INPUT} ${phone ? 'w-full' : 'flex-1'}`}
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={line.amount}
                    onChange={(e) =>
                      setLines(lines.map((l, n) => (n === i ? { ...l, amount: Number(e.target.value) } : l)))
                    }
                    className={`${INPUT} ${phone ? 'min-w-0 flex-1' : 'w-28'}`}
                    dir="ltr"
                  />
                  <button
                    type="button"
                    onClick={() => setLines(lines.filter((_, n) => n !== i))}
                    className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1.5 rounded-lg text-[var(--sys-muted)] hover:text-[var(--sys-destructive)] hover:bg-[var(--sys-destructive-soft)]"
                    aria-label="احذف البند"
                  >
                    <RiCloseLine className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* The number every margin in the system is built on. */}
        <div className="flex items-center justify-between rounded-lg bg-[var(--sys-primary-soft)] border border-[var(--sys-primary-soft)] px-3 py-2.5">
          <span className="text-xs text-[var(--sys-muted-foreground)]">
            الكلفة الكلية <Money value={total} className="font-bold text-[var(--sys-heading)]" />
          </span>
          <span className="text-xs">
            كلفة الوحدة{' '}
            <Money value={perUnit} className="font-black text-[var(--sys-primary)]" />
            {batch.costPerUnit > 0 && Math.abs(perUnit - batch.costPerUnit) > 0.005 && (
              <span className="text-xs text-[var(--sys-muted)]"> (كانت <Money value={batch.costPerUnit} />)</span>
            )}
          </span>
        </div>

        <label className="block">
          <span className="block text-xs text-[var(--sys-muted-foreground)] mb-1">سبب التعديل</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً: كلفة المواد لم تُدخل عند الإنشاء"
            maxLength={200}
            className={INPUT}
          />
        </label>


        <div className="flex gap-2 justify-end pt-1">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button size="sm" onClick={save} disabled={busy}>
            {busy && <RiLoader4Line className="w-4 h-4 animate-spin" />}
            احفظ الكلفة
          </Button>
        </div>
      </div>
    </Modal>
  );
}
