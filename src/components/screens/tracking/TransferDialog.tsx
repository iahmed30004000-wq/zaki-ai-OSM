'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch, apiJson } from '@/lib/api-client';
import { useAsk } from '@/components/ui/Confirm';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Input';
import { RiAlertLine, RiEBike2Line, RiTruckLine } from '@remixicon/react';

/**
 * Moving a parcel to another courier, from the tracking screen.
 *
 * The screen states the consequence before you commit, because the two moves
 * are not equivalent: away from a مندوب the same order simply changes hands,
 * away from a company that has TAKEN the parcel it is recalled and a REPLACEMENT
 * order is raised that re-enters preparation; away from a company that has not
 * (its trolley was never pressed) it is the SAME order, moved to the new
 * company's trolley. The server decides which applies; this only has to say so
 * plainly first.
 */

interface Provider {
  id: string;
  name: string;
  kind?: string;
}

export function TransferDialog({
  order,
  onClose,
  onDone,
}: {
  order: {
    id: string;
    orderNumber: string;
    merchantRef: string | null;
    deliveryProvider: { id: string; name: string; kind?: string } | null;
  };
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ask = useAsk();

  useEffect(() => {
    apiJson<{ providers: Provider[] }>('/api/ops/references')
      .then((d) => setProviders(d.providers.filter((p) => p.id !== order.deliveryProvider?.id)))
      .catch(() => undefined);
  }, [order.deliveryProvider?.id]);

  const fromAgent = order.deliveryProvider?.kind === 'AGENT';
  const to = providers.find((p) => p.id === target);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="تحويل الشحنة"
      subtitle={`${order.merchantRef ?? order.orderNumber} — حالياً مع ${order.deliveryProvider?.name ?? 'لا أحد'}`}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            // A printed waybill names the old company: it goes only on this person's word that it was destroyed.
            const send = async (parcelInHand: boolean): Promise<void> => {
              const res = await apiFetch('/api/ops/tracking/transfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  orderId: order.id,
                  toProviderId: target,
                  note: note.trim() || undefined,
                  ...(parcelInHand ? { parcelInHand: true } : {}),
                }),
              });
              const body = await res.json().catch(() => ({}));
              if (!res.ok && body?.code === 'ATTESTATION_REQUIRED') {
                const said = await ask({
                  title: `الطرد ${order.orderNumber} مطبوعة بوليصته`,
                  body: `${body.attestation ?? ''}`,
                  confirmLabel: 'أؤكد',
                  tone: 'danger',
                  input: { label: 'اكتب «أؤكد» بنفسك', required: true, maxLength: 20 },
                });
                if (said?.trim() === 'أؤكد') await send(true);
                return;
              }
              if (!res.ok) throw new Error(body?.errorAr || body?.error || 'تعذر التحويل');
              onDone(String(body.message ?? ''));
            };
            await send(false);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر التحويل');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <div
          className={`text-xs rounded-lg p-3 border ${
            fromAgent
              ? 'bg-[var(--sys-success-soft)] border-[var(--sys-success)]/40 text-[var(--sys-success)]'
              : 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/40 text-[var(--sys-warning)]'
          }`}
        >
          {fromAgent ? (
            <>
              المندوب فوري: بمجرد التحويل تُسجَّل الشحنة <b>مستلمة منه</b>، ويبقى الطلب بنفس رقمه
              ويُسنَد للجهة الجديدة مباشرة.
            </>
          ) : (
            <span className="flex gap-2">
              <RiAlertLine className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                قبل ما تُسلَّم الدفعة للشركة الحالية: <b>نفس الطلب</b> بنفس رقمه ينتقل لدفعة الجهة
                الجديدة، بلا طلب بديل، وبوليصته القديمة (لو انطبعت) بتنطبع من جديد. وبعد التسليم: سيُطلب{' '}
                <b>إرجاع الشحنة</b> من الشركة، ويُنشأ <b>طلب بديل</b> يدخل تجهيز الشحنة ليُسنَد من جديد؛
                والأصلي يبقى بسجله وباركوده لأنه سيظهر في كشف الشركة.
              </span>
            </span>
          )}
        </div>

        {/*
          The shared field, as on the returns desk and in CollectDialog. This
          `<select>` had `bg-[var(--sys-card)]` retyped onto it and the note
          box below did not, which is the same class string drifting in the
          same file — and neither carried the focus ring system.css leaves to
          the component.
        */}
        <Select
          label="الجهة الجديدة"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          required
        >
          <option value="">اختر…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.kind === 'AGENT' ? 'مندوب' : 'شركة شحن'}
            </option>
          ))}
        </Select>

        {to && (
          <p className="text-xs text-[var(--sys-muted-foreground)] flex items-center gap-1.5">
            {to.kind === 'AGENT' ? <RiEBike2Line className="w-4 h-4 text-[var(--sys-primary)]" /> : <RiTruckLine className="w-4 h-4" />}
            ستذهب إلى {to.name}
          </p>
        )}

        <Input
          label="ملاحظة (اختيارية)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="سبب التحويل"
        />

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving || !target}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'جارٍ التحويل…' : fromAgent ? 'استلام وتحويل' : 'تحويل الشحنة'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
