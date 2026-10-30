'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { whatsappLink, whatsappReady } from '@/lib/message-templates';
import { RiChat3Line, RiFileCopyLine, RiCheckLine } from '@remixicon/react';

/**
 * THE PARCEL IS ALREADY WITH THE COURIER.
 *
 * An approved change used to be written straight onto the order, waybill or
 * no waybill. The seal's own comment says why that is worthless: once the
 * paper is on the box, the paper IS the address — changing it here only
 * makes our record disagree with the parcel on the van.
 *
 * So the approval still carries the authority, and this is the step it was
 * missing: the sentence to send, and somebody saying they sent it. Nothing
 * is written until they do, and what they did is recorded on the order with
 * their name.
 *
 * NO GATEWAY. It opens WhatsApp with the text already written — the same way
 * every other message in this product leaves, from the company's own number,
 * with no account, no key and no per-message cost. The copy button is for the
 * desk phone, the group the dispatcher actually watches, or a courier who
 * takes these by SMS.
 */

export interface CourierAsk {
  action: 'CONTACT_CHANGE' | 'CANCEL_AND_REORDER' | 'CANCEL_WAYBILL' | 'NONE';
  /** Why our record is not changing yet, in the reader's own words. */
  reason: string;
  message: string;
  courier: { name: string; phone: string | null } | null;
}

export function CourierNotifyDialog({
  orderNumber,
  ask,
  busy,
  countryCode,
  onClose,
  onNotified,
}: {
  orderNumber: string;
  ask: CourierAsk;
  busy: boolean;
  /** Dialling code, e.g. "963" — wa.me needs the number in full international form. */
  countryCode?: string | null;
  onClose: () => void;
  onNotified: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);

  const phone = ask.courier?.phone ?? null;
  /** A local number with no country behind it opens a stranger's chat (or none): shut, and say why. */
  const waReady = !!phone && whatsappReady(phone, countryCode);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ask.message);
      setCopied(true);
      setSent(true);
    } catch {
      // A browser that refuses the clipboard is not a reason to block the
      // work: the text is on screen and selectable.
      setSent(true);
    }
  };

  const openWhatsApp = () => {
    if (!phone) return;
    const link = whatsappLink(phone, countryCode, ask.message);
    // Nothing opened, nothing sent: «أُرسلت» is claimed only when a link really opened.
    if (!link) return;
    window.open(link, '_blank', 'noopener');
    setSent(true);
  };

  return (
    <Modal isOpen onClose={onClose} title={`${orderNumber} عند شركة الشحن`}>
      <div className="space-y-3">
        <p className="text-sm text-[var(--sys-foreground)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-3">
          {ask.reason}
        </p>

        <label className="block">
          <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">
            الرسالة الجاهزة {ask.courier?.name ? `— إلى ${ask.courier.name}` : ''}
          </span>
          <textarea
            value={ask.message}
            readOnly
            rows={7}
            className="w-full px-3 py-2 rounded-lg border border-[var(--sys-border-input)] text-sm leading-relaxed bg-[var(--sys-surface)]"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={openWhatsApp}
            disabled={!waReady}
            title={!phone ? 'لا رقم مسجَّل لشركة الشحن — انسخ الرسالة وأرسلها بنفسك' : waReady ? undefined : 'رمز الدولة ناقص — انسخ الرسالة وأرسلها بنفسك'}
            className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg bg-[var(--sys-success)] px-4 py-1.5 text-xs font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
          >
            <RiChat3Line className="w-4 h-4" aria-hidden />
            أرسِلها واتساب
          </button>
          {!!phone && !waReady && (
            <span className="text-xs text-[var(--sys-muted)]">رمز الدولة ناقص — انسخ الرسالة وأرسلها بنفسك</span>
          )}
          <button
            type="button"
            onClick={() => void copy()}
            className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-border)] px-4 py-1.5 text-xs font-medium text-[var(--sys-foreground)]"
          >
            {copied ? <RiCheckLine className="w-4 h-4" aria-hidden /> : <RiFileCopyLine className="w-4 h-4" aria-hidden />}
            {copied ? 'نُسخت' : 'انسخ الرسالة'}
          </button>
        </div>

        {/*
          THE WRITE WAITS FOR A PERSON TO SAY IT HAPPENED.
          Opening WhatsApp is not proof that anything was sent, so the button
          below is a statement, not a consequence — and it is recorded on the
          order with the name of whoever made it.
        */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--sys-border)]">
          <button
            type="button"
            onClick={onNotified}
            disabled={busy || !sent}
            title={sent ? undefined : 'أرسِل الرسالة أو انسخها أوّلاً'}
            className="min-h-11 md:min-h-0 inline-flex items-center rounded-lg bg-[var(--sys-primary)] px-4 py-1.5 text-xs font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
          >
            {/*
              THE BUTTON SAYS WHAT WILL HAPPEN.

              On a cancelled waybill nothing is «applied» to this order:
              the message above promised the courier a NEW waybill, and
              this is where that promise is kept. Calling it «طبّق التعديل»
              was the label on a button that did the wrong thing — it wrote
              the change onto the parcel we had just told them to cancel.
            */}
            {ask.action === 'CANCEL_AND_REORDER'
              ? 'أبلغتُهم — ألغِ البوليصة وارفع الطلب البديل'
              : ask.action === 'CANCEL_WAYBILL'
                ? 'أبلغتُهم — علّم الطلب منفَّذاً'
                : 'أبلغتُهم — طبّق التعديل الآن'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 md:min-h-0 inline-flex items-center rounded-lg border border-[var(--sys-border)] px-4 py-1.5 text-xs"
          >
            لاحقاً
          </button>
          <span className="text-xs text-[var(--sys-muted-foreground)]">
            {ask.action === 'CANCEL_AND_REORDER'
              ? 'يعود هذا الطلب مرتجعاً، ويصدر بديلٌ بالتعديل جاهزاً للتحضير.'
              : ask.action === 'CANCEL_WAYBILL'
                ? 'الطلب يبقى كما هو إلى أن يرجع الطرد ويتعدّ عند المرتجعات.'
                : 'يُسجَّل على الطلب أنّك أبلغتَهم قبل التطبيق.'}
          </span>
        </div>
      </div>
    </Modal>
  );
}
