'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/Confirm';

/**
 * «تكلفة المنتج الثابتة» ON THE PRODUCT PAGE (the owner, 1/11).
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… اللي بيقدر يغيرو الادمنة فقط من قائمة المنتجات.» One figure per product, typed by an
 * admin, that nothing recomputes; without it the product costs what its batches say (the weighted average), as it always did. This
 * says which of the two it is, and gives the admin — only the admin — the three things she may do: type a figure, take the
 * average the batches give today as the figure («ثبّت»), or clear it.
 *
 * THE FIGURES COME FROM THE SERVER. The average offered by «ثبّت» is the one the stock read answered; nothing is worked out here.
 * The door (`PUT /api/products/[id]/fixed-cost`) asks the key again, and writes the before and the after to the audit log.
 *
 * WHAT IT SAYS ABOUT ORDERS IS THE TRUTH OF `product-fixed-cost.ts` (Stage 2): an order raised from now on, a line that is edited
 * and an order that is delivered from now on are costed from the figure; an order already delivered keeps the cost it was written
 * with. The first release said «الطلبات لسا بتنحسب من الدفعات» because it changed no order — that sentence is gone with the reason for it.
 */
export function FixedCostEditor({
  productId,
  fixedCost,
  batchAverage,
  money,
  canChange,
  onSaved,
}: {
  productId: string;
  /** The figure an admin set, or null when none has. */
  fixedCost: number | null;
  /** What the batches on hand say one unit costs today — what the product costs while there is no fixed figure. */
  batchAverage: number;
  money: (n: number) => string;
  canChange: boolean;
  onSaved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const url = `/api/products/${productId}/fixed-cost`;

  async function save(amount: number | null, ask?: { title: string; body: string; confirmLabel: string }) {
    if (ask && !(await confirm({ ...ask, tone: amount === null ? 'danger' : undefined }))) return;
    setBusy(true);
    try {
      await apiJson(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });
      toast.done(amount === null ? 'انمسحت التكلفة الثابتة — التكلفة رجعت متوسط المخزون.' : 'انحفظت التكلفة الثابتة.');
      setTyped('');
      await onSaved();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
      <p className="text-xs font-semibold text-[var(--sys-heading)]">
        {fixedCost !== null ? (
          <>
            تكلفة الوحدة الثابتة: <span className="tabular-nums" dir="ltr">{money(fixedCost)}</span>
          </>
        ) : (
          <>بلا تكلفة ثابتة — التكلفة هلّق متوسط المخزون (<span className="tabular-nums" dir="ltr">{money(batchAverage)}</span>) وبتتغيّر مع كل دفعة.</>
        )}
      </p>
      <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        {fixedCost !== null
          ? 'تكلفة الوحدة بشاشات المنتجات والمخزون هي هالرقم، وما بتتغيّر مع الدفعات. الطلب الجديد بينكتب بهالرقم، وكمان القطع اللي بتنزاد على طلب موجود، والطلب اللي بيتسلّم من هلّق إذا كفّى المخزون. الطلب اللي تسلّم قبل بيضل بتكلفته.'
          : 'لما تحدّد رقماً، بتصير تكلفة الوحدة هو بدل المتوسط: بالشاشات، وبالطلب الجديد، وبالقطع اللي بتنزاد على طلب موجود، وبالطلب اللي بيتسلّم من هلّق إذا كفّى المخزون. الطلب اللي تسلّم قبل بيضل بتكلفته.'}
      </p>

      {canChange && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <Input
              label="التكلفة الثابتة"
              type="number"
              step="0.0001"
              min="0"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
            />
          </div>
          <Button
            size="sm"
            disabled={busy || typed.trim() === '' || !(Number(typed) >= 0)}
            onClick={() => void save(Number(typed))}
          >
            احفظ
          </Button>
          {fixedCost === null && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void save(batchAverage, {
                  title: 'تثبيت التكلفة على متوسط المخزون؟',
                  body: `بتصير التكلفة الثابتة ${money(batchAverage)} وما بتتغيّر مع الدفعات بعد هلّق.`,
                  confirmLabel: 'ثبّت',
                })
              }
            >
              ثبّت على المتوسط الحالي
            </Button>
          )}
          {fixedCost !== null && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void save(null, {
                  title: 'مسح التكلفة الثابتة؟',
                  body: 'بترجع التكلفة متوسط المخزون وبتتغيّر مع الدفعات، وبترجع الطلبات الجديدة والمتسلَّمة من هلّق تنحسب منها. الطلب اللي تسلّم قبل ما بيتغيّر.',
                  confirmLabel: 'امسح',
                })
              }
            >
              امسح
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
