'use client';

import React, { useState } from 'react';
import { RiAddCircleLine, RiLoader4Line, RiSubtractLine } from '@remixicon/react';
import { Modal } from '@/components/ui/Modal';
import { useOrderPatch } from '@/components/orders/useOrderPatch';
import { useRegions } from '@/hooks/useRegions';

/**
 * «عدّل» ON A PARCEL OF AN OPEN TROLLEY — the packing table's own pen (`ops.edit_in_batch`, 30/10).
 *
 * The person at the trolley has the box in her hand and the customer on the phone: she corrects the name, the phone, the
 * governorate, the address or a quantity RIGHT HERE, and it is written on the order straight away — no request, nobody
 * deciding — for as long as the shipment is not closed. The form carries nothing else: not a price, not a discount, not
 * a fee, not another product. Those stay behind their own keys and the request.
 *
 * It does not work anything out. A quantity goes to the order's own door with the figures the screen was given, and the
 * door rebuilds the line's money from the piece price the line already had (the one calculator, on the server).
 * If the shipment was closed between her reading and her saving, the door says so in the seal's words and the list is
 * read again.
 */

export interface PrepParcel {
  id: string;
  orderNumber: string;
  version: number;
  regionId: string | null;
  customer: {
    fullName?: string | null;
    phone?: string | null;
    altPhone?: string | null;
    address?: string | null;
  } | null;
  items: { productId: string; productName: string; quantity: number; freeQuantity: number; unitPrice: number }[];
}

const inputClass =
  'w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-sm focus:outline-none focus:border-[var(--sys-primary)]';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--sys-muted-foreground)] mb-1">{label}</span>
      {children}
    </label>
  );
}

export function PrepEditSheet({
  order,
  onClose,
  onSaved,
  onStale,
}: {
  order: PrepParcel;
  onClose: () => void;
  /** Written: the list is read again. */
  onSaved: () => void;
  /** Refused because the trolley moved on (closed, or the order changed under her): the list is read again, the form stays to say why. */
  onStale: () => void;
}) {
  const patchOrder = useOrderPatch();
  const { regions, countryName } = useRegions();
  const was = {
    fullName: order.customer?.fullName ?? '',
    phone: order.customer?.phone ?? '',
    altPhone: order.customer?.altPhone ?? '',
    address: order.customer?.address ?? '',
    regionId: order.regionId ?? '',
  };
  const [form, setForm] = useState(was);
  const [quantities, setQuantities] = useState(() => order.items.map((l) => l.quantity));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const body: Record<string, unknown> = { expectedVersion: order.version };
    if (form.fullName.trim() !== was.fullName) body.customerName = form.fullName.trim();
    if (form.phone.trim() !== was.phone) body.customerPhone = form.phone.trim();
    if (form.altPhone.trim() !== was.altPhone) body.customerAltPhone = form.altPhone.trim() || null;
    if (form.address.trim() !== was.address) body.customerAddress = form.address.trim();
    // A governorate is chosen, never cleared from here: the delivery fee is keyed on it.
    if (form.regionId && form.regionId !== was.regionId) body.regionId = form.regionId;
    if (quantities.some((q, i) => q !== order.items[i].quantity)) {
      body.items = order.items.map((l, i) => ({ productId: l.productId, quantity: quantities[i], unitPrice: l.unitPrice }));
    }
    if (Object.keys(body).length === 1) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await patchOrder(order.id, body);
      if (res.ok) {
        onSaved();
        return;
      }
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      setError(String(data.errorAr || data.error || 'تعذّر الحفظ'));
      if (res.status === 409) onStale();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`تعديل ${order.orderNumber}`}
      subtitle="قبل إغلاق الشحنة فقط — يُكتب على الطلب مباشرةً ويُسجَّل باسمك"
      maxWidth="md"
      footer={
        <div className="flex gap-2">
          <button
            onClick={() => void save()}
            disabled={busy}
            className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {busy && <RiLoader4Line className="w-4 h-4 animate-spin" />}
            احفظ التعديل
          </button>
          <button
            onClick={onClose}
            className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]"
          >
            إلغاء
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="اسم العميل">
            <input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className={inputClass} />
          </Field>
          <Field label="رقم الهاتف">
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} dir="ltr" className={inputClass} />
          </Field>
          <Field label="رقم إضافي (اختياري)">
            <input value={form.altPhone} onChange={(e) => setForm({ ...form, altPhone: e.target.value })} dir="ltr" className={inputClass} />
          </Field>
          <Field label={`المحافظة${countryName ? ` — ${countryName}` : ''}`}>
            <select value={form.regionId} onChange={(e) => setForm({ ...form, regionId: e.target.value })} className={inputClass}>
              <option value="">— اختر المحافظة —</option>
              {regions.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="عنوان التوصيل">
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={inputClass} />
            </Field>
          </div>
        </div>

        {order.items.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-[var(--sys-muted-foreground)]">الكمية — السعر يبقى كما هو للقطعة</p>
            {order.items.map((l, i) => (
              <div key={`${l.productId}-${i}`} className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-[var(--sys-heading)] flex-1 min-w-[120px]">{l.productName}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setQuantities(quantities.map((q, j) => (j === i ? Math.max(1, q - 1) : q)))}
                    aria-label="أنقص الكمية"
                    title="أنقص الكمية"
                    className="h-11 md:h-9 w-9 min-w-11 md:min-w-0 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] disabled:opacity-40"
                  >
                    <RiSubtractLine className="w-4 h-4 mx-auto" />
                  </button>
                  <input
                    type="number" min={1} dir="ltr"
                    aria-label={`كمية ${l.productName}`}
                    value={quantities[i]}
                    onChange={(e) => setQuantities(quantities.map((q, j) => (j === i ? Math.max(1, Number(e.target.value) || 1) : q)))}
                    className={`${inputClass} w-16 text-center`}
                  />
                  <button
                    type="button"
                    onClick={() => setQuantities(quantities.map((q, j) => (j === i ? q + 1 : q)))}
                    aria-label="زد الكمية"
                    title="زد الكمية"
                    className="h-11 md:h-9 w-9 min-w-11 md:min-w-0 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] disabled:opacity-40"
                  >
                    <RiAddCircleLine className="w-4 h-4 mx-auto" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <p className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-2.5 py-1.5">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
