'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { reviewReasonText } from '@/lib/telegram/review-reasons';
import { LABELED_FIELDS, LABEL_OF, type LabeledField, type MessageColumns } from '@/lib/telegram/labeled-order';

/**
 * «تعديل وترحيل» — A HELD MESSAGE, CORRECTED BY HAND AND PUSHED ON.
 *
 * The owner, 29/10: «اريد يكون في خيار تعديل على الطلبات اللي بخانة المراجعة … تعديل يدوي وترحيل لخانة صارت طلبات».
 *
 * Eight real boxes, one per label, filled with what the seller wrote (or with what is known when the message was no order at
 * all: the arrival time for the date, the rest empty). «رقم الطلب» is not here — it is dropped everywhere. Saving sends the
 * eight values to `/correct`, which writes them back as a message in the nine-label format and reads it through the SAME door
 * as any message: so a correction changes the text a rule is applied to, never the rule. When the message still waits the
 * dialog stays open and says why, with what was typed kept in the boxes; when it became an order the dialog closes.
 */

export interface CorrectTarget {
  id: string;
  reading: MessageColumns;
  /** When the message arrived (ISO) — the date to start from when the seller wrote none. */
  createdAt: string;
  /** What the row says now, so the person sees it while editing. */
  reason: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The arrival time in the shape the format asks for: 2026-10-28 15:40:01. */
const stamp = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** What each box is for the keyboard: the number boxes open the number pad, and read left to right. */
const BOX: Record<LabeledField, { inputMode?: 'numeric' | 'decimal' | 'tel'; ltr?: boolean; hint?: string }> = {
  orderedAt: { ltr: true, hint: 'مثل 2026-10-28 15:40:01' },
  customer: {},
  phone: { inputMode: 'tel', ltr: true },
  address: {},
  product: {},
  offer: {},
  price: { inputMode: 'decimal', ltr: true, hint: 'إجمالي الطلب' },
  quantity: { inputMode: 'numeric', ltr: true, hint: 'قطع المنتج' },
};

export function TelegramCorrectDialog({
  target,
  onClose,
  onSaved,
}: {
  target: CorrectTarget;
  onClose: () => void;
  /** The correction is stored: `true` when the message became an order, `false` when it still waits (the list reads again either way). */
  onSaved: (becameOrder: boolean) => void | Promise<void>;
}) {
  const [values, setValues] = useState<Record<LabeledField, string>>(() => {
    const r = target.reading;
    return {
      orderedAt: r.orderedAt ?? stamp(target.createdAt),
      customer: r.customer ?? '',
      phone: r.phone ?? '',
      address: r.address ?? '',
      product: r.product ?? '',
      offer: r.offer ?? '',
      price: r.price ?? '',
      quantity: r.quantity ?? '',
    };
  });
  const [error, setError] = useState<string | null>(target.reason || null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const blank = LABELED_FIELDS.find((f) => !values[f].trim());
    if (blank) {
      setError(`ناقص: ${LABEL_OF[blank]}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await apiJson<{ status: string; reason?: string }>(`/api/telegram/messages/${target.id}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const became = r.status === 'PROCESSED';
      await onSaved(became);
      if (became) onClose();
      // Saved, and still waiting: the reason is the NEW one, and the boxes keep what was typed.
      else setError(reviewReasonText(r.reason) || 'لسا ما صارت طلب');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="تعديل وترحيل" subtitle="صحّح الحقول وبتنقرأ كأنها رسالة جديدة، وإذا زبطت بتصير طلب" maxWidth="2xl">
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {LABELED_FIELDS.map((field) => (
            <Input
              key={field}
              label={LABEL_OF[field]}
              type="text"
              inputMode={BOX[field].inputMode}
              dir={BOX[field].ltr ? 'ltr' : undefined}
              value={values[field]}
              helperText={BOX[field].hint}
              onChange={(e) => setValues((cur) => ({ ...cur, [field]: e.target.value }))}
            />
          ))}
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={busy}>
            احفظ وحوّلها لطلب
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </form>
    </Modal>
  );
}
