'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { ORIGIN } from '@/lib/batch-grade';

/**
 * «استلام» — PUT BOUGHT STOCK IN, FROM THE CARD THAT SAYS IT IS RUNNING OUT.
 *
 * This used to be the whole of its own screen (`/inventory/receiving`): a
 * second list of the same products, read from the same `/api/inventory`, whose
 * only feature was this form. It lives on the balances card now — the place
 * you see «قارب على الانتهاء» is the place you act on it.
 *
 * Received units open a batch, because a batch is where units actually live:
 * on-hand is the sum of batch remainders, and anything that writes only a
 * ledger line leaves the shipment screen reporting a shortage for stock you
 * just entered. The cost you type is the cost of THIS delivery and stays
 * with its own batch, so receiving at a new price never rewrites the old
 * cost of goods.
 *
 * Only a product you BUY ready comes in through here. What you make comes in
 * through a production run, where its costs are broken down; the server
 * refuses the other way round (`WRONG_DOOR`) after the quantity was typed, so
 * the caller does not offer this dialog for a made product at all.
 */

export interface ReceiveProduct {
  id: string;
  name: string;
  remaining: number;
  /**
   * The newest costed price, or null when this product has never been costed. ABSENT (undefined) for a caller without
   * `costs.view`: the number is not shown and no claim is made about it — a blank is still the server's decision.
   */
  lastUnitCost?: number | null;
}

export function ReceiveDialog({
  product,
  onClose,
  onSaved,
}: {
  product: ReceiveProduct;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [zeroReason, setZeroReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <Modal isOpen onClose={onClose} title={`استلام بضاعة — ${product.name}`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await apiJson('/api/inventory', {
              method: 'POST',
              body: JSON.stringify({
                action: 'receive',
                productId: product.id,
                quantity: Number(quantity),
                // A BLANK IS A BLANK. Sending 0 for an empty field is how
                // this screen used to open batches at zero cost, and every
                // unit sold out of one reads as pure profit for ever. The
                // server decides what an empty price means — carry the last
                // one forward, or refuse.
                unitCost: unitCost === '' ? undefined : Number(unitCost),
                zeroCostReason: zeroReason.trim() || null,
                note: note.trim() || null,
              }),
            });
            onSaved(`أُضيفت ${quantity} وحدة إلى ${product.name}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر الاستلام');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <p className="text-sm text-[var(--sys-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 tabular-nums">
          الرصيد الحالي: <b>{product.remaining}</b> وحدة
        </p>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">الكمية المستلمة</span>
          <input
            type="number"
            min="1"
            step="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            required
            autoFocus
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
        </label>

        {/*
          NOT «(اختياري)» ANY MORE.
          For a bought product this is the only place its cost is recorded —
          the product row holds `basePrice`, which is what we SELL it for.
          A blank used to become a zero, and a zero-cost batch reports every
          unit sold out of it as pure profit, for ever, with no later
          correction. What a blank means is now the server's decision, and
          the line below says which of the two it will be.
        */}
        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">
            تكلفة الوحدة في هذه الدفعة {product.lastUnitCost === null && <b className="text-[var(--sys-destructive)]">(مطلوبة)</b>}
          </span>
          <input
            type="number"
            min="0"
            step="0.001"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            placeholder={typeof product.lastUnitCost === 'number' ? String(product.lastUnitCost) : product.lastUnitCost === undefined ? 'اتركها فارغة أو اكتب الكلفة' : 'اكتب الكلفة'}
            required={product.lastUnitCost === null}
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
          <span className="block text-xs text-[var(--sys-muted)] mt-1">
            {product.lastUnitCost === undefined ? (
              <>تُفتح دفعة جديدة بهذه التكلفة، فلا تتأثر تكلفة البضاعة القديمة. واتركها فارغةً لتدخل بكلفة آخر دفعة إن وُجدت، وإلا طلب منك النظام كتابتها.</>
            ) : product.lastUnitCost !== null ? (
              <>تُفتح دفعة جديدة بهذه التكلفة، فلا تتأثر تكلفة البضاعة القديمة. واتركها فارغةً لتدخل بكلفة آخر دفعة ({product.lastUnitCost}).</>
            ) : (
              <>لم تُسعَّر هذه البضاعة من قبل، فلا كلفةَ تُبنى عليها. تركُها فارغةً يُدخلها بصفر فيظهر كلُّ ما يُباع منها ربحاً صافياً.</>
            )}
          </span>
        </label>

        {/* A free sample is real, so the door is not shut — it asks for a sentence. */}
        {unitCost.trim() === '0' && (
          <label className="block">
            <span className="block text-xs font-medium text-[var(--sys-destructive)] mb-1">
              كلفتُها صفر — لماذا؟
            </span>
            <input
              value={zeroReason}
              onChange={(e) => setZeroReason(e.target.value)}
              placeholder="مثال: عيّنة مجّانية من المورّد"
              required
              className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-destructive-border)] text-sm"
            />
          </label>
        )}

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">ملاحظة</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="مثال: وصلت من المورّد"
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
        </label>

        {/* Where what you receive shows up afterwards — in the SAME words the
            production screen uses (`ORIGIN.RECEIVED.why`), because two screens
            explaining one fact in two wordings is how a reader learns to trust
            neither. */}
        <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          كل استلام يفتح دفعةً باسمه، وتظهر في «تشغيلات الإنتاج» موسومةً بأنها استلام لا تشغيلة: {ORIGIN.RECEIVED.why}
        </p>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'جارٍ الاستلام…' : 'استلام'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
