'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { useOrderPatch } from '@/components/orders/useOrderPatch';
import { useRegions } from '@/hooks/useRegions';
import { RiHistoryLine, RiLoader4Line, RiPencilLine, RiUserLine } from '@remixicon/react';
import { ContactButtons } from '@/components/orders/ContactButtons';
import { raiseEditRequest } from '@/components/orders/raiseEditRequest';
import { TERMINAL_CONFIRMATION_STATUSES } from '@/lib/confirmation-workflow';
import type { ChangeableField } from '@/lib/change-request-fields';
import { MAX_REASON, MIN_REASON } from '@/lib/order-edit-reason';
import { useAsk } from '@/components/ui/Confirm';
import { useIsPhone } from '@/hooks/useIsPhone';

/**
 * Who the order goes to, and the one button that edits all of it.
 *
 * Customer details and order lines used to share a single edit form, so
 * fixing a phone number opened price and quantity fields too and every save
 * touched both. They are separate questions asked by different people at
 * different moments, so they are separate cards with their own buttons.
 *
 * The phone rule for the store's country is enforced on the server; this
 * form just shows what it says rather than guessing its own rules.
 */

interface Props {
  order: {
    id: string;
    version: number;
    orderNumber: string;
    /** Confirmation is the line after which an edit becomes a request. */
    confirmationStatus: string;
    totalAmount: number;
    trackingNumber?: string | null;
    regionId: string | null;
    region?: { id: string; name: string } | null;
    /** The address this order went to; null = the customer's latest. */
    deliveryAddress?: string | null;
    customer: {
      id: string;
      fullName: string;
      phone: string;
      rawPhone?: string | null;
      altPhone?: string | null;
      address?: string | null;
      city?: string | null;
      totalOrders?: number;
      deliveredOrders?: number;
      cancelledOrders?: number;
    };
  };
  /** Held by this user with a live editing lock — the server demands it. */
  canEdit: boolean;
  /**
   * The country's calling code, from the server. `wa.me` takes full
   * international digits only, and the number on screen is local.
   */
  dialCode?: string | null;
  onAcquireLock: () => Promise<unknown> | void;
  onSaved: () => void;
  onOpenHistory: () => void;
}

export function CustomerCard({ order, canEdit, dialCode, onAcquireLock, onSaved, onOpenHistory }: Props) {
  // Saves, and asks why when the server says this authority owes a reason.
  const patchOrder = useOrderPatch();
  const ask = useAsk();
  /* A phone lets the card's title and its two buttons wrap onto a second line (ORD-13); a desk keeps the one row. */
  const phone = useIsPhone();
  const { regions, countryName } = useRegions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** «بانتظار الموافقة» — said out loud, not left to be guessed. */
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    fullName: order.customer.fullName ?? '',
    phone: order.customer.rawPhone || order.customer.phone || '',
    altPhone: order.customer.altPhone ?? '',
    regionId: order.regionId ?? '',
    address: order.customer.address ?? '',
  });

  async function openForm() {
    // The button says إغلاق once the form is open, so pressing it again has
    // to close it — it used to re-open the form onto itself and look dead.
    if (open) {
      setOpen(false);
      setError(null);
      return;
    }
    setForm({
      fullName: order.customer.fullName ?? '',
      phone: order.customer.rawPhone || order.customer.phone || '',
      altPhone: order.customer.altPhone ?? '',
      regionId: order.regionId ?? '',
      address: order.customer.address ?? '',
    });
    setError(null);
    setNotice(null);
    if (!canEdit) await onAcquireLock();
    setOpen(true);
  }

  /**
   * ONCE IT IS CONFIRMED, THIS SAVE IS A REQUEST.
   *
   * The owner's rule: «لما يتأكد الطلب، الموظف ما بيقدر يعدله — التعديل
   * يصير طلب تعديل، والقرار إلي». Before confirmation the order is still
   * the agent's and the save goes straight through, exactly as it did.
   *
   * The server refuses the direct path either way
   * (`CHANGE_REQUEST_REQUIRED`), so this is not the rule — it is the
   * person being told the rule BEFORE they have retyped a street, rather
   * than after.
   *
   * Only the fields that actually changed travel: a request that says «the
   * name, to the same name» is a row a supervisor has to read and decide
   * for nothing.
   */
  const pastConfirmation = (TERMINAL_CONFIRMATION_STATUSES as string[]).includes(order.confirmationStatus);

  function changedFields(): Partial<Record<ChangeableField, string | number | null>> {
    const now = {
      customerName: form.fullName,
      customerPhone: form.phone,
      customerAltPhone: form.altPhone.trim() || null,
      customerAddress: form.address,
      regionId: form.regionId || null,
    } as const;
    const before = {
      customerName: order.customer.fullName ?? '',
      customerPhone: order.customer.rawPhone || order.customer.phone || '',
      customerAltPhone: order.customer.altPhone ?? null,
      customerAddress: order.customer.address ?? '',
      regionId: order.regionId ?? null,
    } as const;
    const diff: Partial<Record<ChangeableField, string | number | null>> = {};
    for (const key of Object.keys(now) as (keyof typeof now)[]) {
      if ((now[key] ?? null) !== (before[key] ?? null)) diff[key] = now[key] ?? null;
    }
    return diff;
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (pastConfirmation) {
        const changes = changedFields();
        if (Object.keys(changes).length === 0) {
          setOpen(false);
          return;
        }
        const reason = await ask({
          title: 'طلب تعديل',
          body: 'الطلب مؤكَّد، فالتعديل بيروح كطلب لمن يبتّ فيه. السبب بينحفظ مع الطلب وبيقراه اللي بيوافق.',
          confirmLabel: 'ارفع الطلب',
          input: {
            label: 'ليش بدّه يتعدّل؟',
            placeholder: 'مثال: الزبون غيّر العنوان بالتلفون',
            required: true,
            multiline: true,
            maxLength: MAX_REASON,
          },
        });
        const trimmed = (reason ?? '').trim();
        if (trimmed.length < MIN_REASON) return; // cancelled, or too short to mean anything
        const { applied } = await raiseEditRequest(order.id, changes, trimmed, order.version);
        setOpen(false);
        if (applied) onSaved();
        else setNotice('بانتظار الموافقة — التعديل انرفع كطلب، والطلب ما تغيّر لحتى حدا يوافق.');
        return;
      }

      const res = await patchOrder(order.id, {
        expectedVersion: order.version,
        customerName: form.fullName,
        customerPhone: form.phone,
        customerAltPhone: form.altPhone.trim() || null,
        customerAddress: form.address,
        regionId: form.regionId || null,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.errorAr || data.error || 'تعذر الحفظ');
      }
      setOpen(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  }

  const previous = Math.max(0, (order.customer.totalOrders ?? 1) - 1);
  const inputClass =
    'w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-sm focus:outline-none focus:border-[var(--sys-primary)]';

  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 shadow-raised space-y-3">
      <div className={phone ? 'flex flex-wrap items-center justify-between gap-2' : 'flex items-center justify-between gap-2'}>
        <h4 className="text-xs font-black text-[var(--sys-foreground)] flex items-center gap-2">
          <RiUserLine className="w-4 h-4 text-[var(--sys-primary)]" />
          معلومات العميل
        </h4>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onOpenHistory}
            className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5"
          >
            <RiHistoryLine className="w-4 h-4" />
            طلبات سابقة ({previous})
          </button>
          <button
            onClick={openForm}
            className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5"
          >
            <RiPencilLine className="w-4 h-4" />
            {open ? 'إغلاق' : 'تعديل'}
          </button>
        </div>
      </div>

      {/*
        «بانتظار الموافقة» — SAID, NOT LEFT TO BE GUESSED.
        A save that raises a request closes the form and changes nothing on
        the order. Without this line the card looks exactly like a save that
        did not work, and the person presses «تعديل» again.
      */}
      {notice && (
        <p className="text-xs text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg px-2.5 py-1.5">
          {notice}
        </p>
      )}

      {!open ? (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Row label="الاسم" value={order.customer.fullName} />
          <Row label="رقم الهاتف" value={order.customer.rawPhone || order.customer.phone} ltr />
          {/*
            AND SOMETHING TO DO WITH THE NUMBER.

            The window printed it as text and offered nothing. Whoever
            opened an order to ring the customer read the digits off the
            screen and typed them into a phone — with the transposed digit
            that goes with that — and the contact log never heard that a
            call had been made from here at all.

            The shared strip: the company's own ready-made messages filled
            with this order's words, `wa.me` built from the country's
            calling code rather than from a local number that opens an
            empty chat, and one line in the contact log per press.
          */}
          <div className="sm:col-span-2 flex items-center gap-2">
            <span className="text-xs text-[var(--sys-muted)]">تواصل</span>
            <ContactButtons
              phone={order.customer.rawPhone || order.customer.phone}
              orderId={order.id}
              countryCode={dialCode}
              context={{
                orderNumber: order.orderNumber,
                customerName: order.customer.fullName,
                amount: order.totalAmount,
                region: order.region?.name ?? order.customer.city,
                barcode: order.trackingNumber,
              }}
            />
          </div>
          <Row label="رقم إضافي" value={order.customer.altPhone || '—'} ltr />
          {/*
            A GOVERNORATE IS A ROW IN THE FEE TABLE, NOT A WORD SOMEBODY TYPED.

            This printed `region?.name ?? customer.city`, so an order that
            never resolved a Region showed the free text the customer's file
            happened to carry — «دمشق» — under the label «المحافظة», and read
            as settled. It is not: the delivery fee and the late threshold are
            keyed on `regionId`, and with none the shipment screen answers «لا
            يمكن حساب أجرة التوصيل». Measured on this database: 2 orders of
            171 are in exactly that state, and both have a city written on
            them, so both of them looked fine.

            The typed city is still shown — it is the clue for whoever fixes
            it — but it is named as what it is, and «تعديل» above sets the
            real one.
          */}
          {order.regionId ? (
            <Row label="المحافظة" value={order.region?.name ?? '—'} />
          ) : (
            <div>
              <dt className="text-xs text-[var(--sys-muted)]">المحافظة</dt>
              <dd className="text-xs text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-md px-2 py-0.5 inline-block font-medium">
                لم تُحدَّد — لا يمكن حساب أجرة التوصيل
                {order.customer.city ? ` · المكتوب: ${order.customer.city}` : ''}
              </dd>
            </div>
          )}
          <div className="sm:col-span-2">
            <Row label="عنوان التوصيل" value={order.deliveryAddress || order.customer.address || '—'} />
          </div>
        </dl>
      ) : (
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

          {error && <p className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-2.5 py-1.5">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy}
              className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {busy && <RiLoader4Line className="w-4 h-4 animate-spin" />}
              حفظ بيانات العميل
            </button>
            <button onClick={() => setOpen(false)} className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]">
              إلغاء
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-[var(--sys-muted)]">{label}</dt>
      <dd className="text-[var(--sys-heading)] font-medium" dir={ltr ? 'ltr' : undefined}>{value}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--sys-muted-foreground)] mb-1">{label}</span>
      {children}
    </label>
  );
}
