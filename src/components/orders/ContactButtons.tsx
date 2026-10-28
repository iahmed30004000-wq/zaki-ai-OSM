'use client';

import React, { useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { fillTemplate, whatsappLink, type FillContext, type MessageTemplate } from '@/lib/message-templates';
import { RiChat3Line, RiMessage3Line, RiPhoneLine } from '@remixicon/react';

/** Does a refusal already speak to her? (the Arabic block, as `api-error.ts` asks it) */
const ARABIC = /[؀-ۿ]/;

/**
 * CALL, SMS, WHATSAPP — from the row the parcel is on.
 *
 * Nothing goes through a gateway. The buttons open the phone's own apps
 * with the text already written, so the message leaves from the company's
 * number — the one the customer recognises and can reply to — and there is
 * no account, no key, no per-message cost and no delivery report nobody
 * reads.
 *
 * The templates are the company's own, edited in settings. Picking one is
 * two clicks because the alternative is typing the same sentence forty
 * times a day, which is where the wrong order number comes from.
 */

export function ContactButtons({
  phone,
  context,
  countryCode,
  compact,
  plain,
  orderId,
  onContacted,
}: {
  phone: string | null | undefined;
  context: FillContext;
  /**
   * The order this number belongs to — and the whole reason a press leaves
   * a trace.
   *
   * ── WHY THE LOGGING LIVES HERE AND NOT IN THE SCREENS ──
   *
   * It used to live in the screens, and exactly one of the four that show
   * a customer's number passed anything: «طلباتي». So a call placed from
   * the orders list, from the order window, from the tracking screen or
   * from the customers screen happened and the contact log never heard of
   * it — and the log is what the next agent reads before ringing the same
   * person again.
   *
   * Given an `orderId`, this component records the press itself. Nothing
   * to remember at the call site, and a screen added next year gets it by
   * passing the id it already has.
   *
   * Absent — a courier's office, a rep, a customer with no order in hand —
   * nothing is recorded, because there is nothing to record it against.
   */
  orderId?: string | null;
  /**
   * Called the moment something actually leaves — a message sent, a number
   * dialled. The queue screen counts contact attempts and closes an order
   * after three unanswered calls, so a contact it never hears about is a
   * contact that did not happen as far as every counter is concerned.
   *
   * Optional: the couriers screen contacts a rep, and there is no order to
   * count it against.
   */
  onContacted?: (method: 'PHONE' | 'SMS' | 'WHATSAPP') => void;
  /** Digits, e.g. "963" — wa.me needs the number in full international form. */
  countryCode?: string | null;
  compact?: boolean;
  /**
   * A number that is not a customer's — a courier's office, a rep.
   *
   * The ready-made messages are written about an order ("طلبك {رقم_الطلب}
   * خرج للتوصيل"), so offering them here would be offering nonsense. Call
   * and WhatsApp open empty, and SMS is dropped: there is nothing to pick.
   */
  plain?: boolean;
}) {
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [open, setOpen] = useState<'SMS' | 'WHATSAPP' | null>(null);
  /** The log refused this press — said beside the strip, see `noteContact`. */
  const [notLogged, setNotLogged] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || templates) return;
    apiJson<{ templates: MessageTemplate[] }>('/api/settings/messages')
      .then((d) => setTemplates(d.templates ?? []))
      .catch(() => setTemplates([]));
  }, [open, templates]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!phone) return null;

  /**
   * ONE LINE IN THE CONTACT LOG PER PRESS — AND NOT AN OUTCOME.
   *
   * `OPENED` says the dialler or WhatsApp was opened on this number, by
   * this employee, now. It is deliberately the weakest thing in
   * `CONTACT_RESULTS`: it is not counted toward the answer rate (that
   * reads `ANSWERED`) and not toward the 1/2/3 no-answer close (that reads
   * `NO_ANSWER` and `BUSY`). Whoever made the call still records what
   * happened with «لا يرد» or «تأكيد» afterwards.
   *
   * `MESSAGE_SENT` stays for a template actually chosen and handed to the
   * app with its text — more is known in that case, and it is already not
   * an outcome either.
   *
   * It never blocks the press. The dialler opens first and the line is
   * written after; a refusal (a role the owner has not given
   * `orders.contact_log`) or a dropped connection must not stop somebody
   * ringing a customer.
   *
   * BUT A REFUSED LINE IS SAID, NOT SWALLOWED. On «طلباتي» this line is what
   * unlocks «تأكيد» and «تأجيل», and a refusal (403, 404) used to vanish: she
   * rang, saw nothing wrong, and the buttons stayed shut. The server's own
   * Arabic goes beside the strip; an English one is not shown to her.
   */
  const noteContact = (method: 'PHONE' | 'SMS' | 'WHATSAPP', result: 'OPENED' | 'MESSAGE_SENT') => {
    onContacted?.(method);
    if (!orderId) return;
    void apiJson(`/api/orders/${orderId}/contact-attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactMethod: method, result }),
    })
      .then(() => setNotLogged(null))
      .catch((e: unknown) => {
        // The call matters more than its line in the log — but she is told the line is missing.
        const why = e instanceof Error && ARABIC.test(e.message) ? e.message : null;
        setNotLogged(why ? `ما انسجّلت المحاولة على الطلب — ${why}` : 'ما انسجّلت المحاولة على الطلب.');
      });
  };

  /**
   * Can this machine actually send an SMS?
   *
   * `sms:` is a phone thing. On a desktop browser the link resolves to
   * nothing at all: the button is pressed, the page does not move, and
   * there is no error — which reads as a broken screen rather than as "use
   * your phone for this". WhatsApp is different, because wa.me opens
   * WhatsApp Web perfectly well from a desk.
   */
  const onPhone =
    typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints > 1 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));

  /** WhatsApp with no message behind it — for a number that has no order. */
  const openPlainWhatsapp = () => {
    window.open(whatsappLink(phone!, countryCode), '_blank', 'noopener');
    noteContact('WHATSAPP', 'OPENED');
  };

  const send = (t: MessageTemplate) => {
    const text = fillTemplate(t.body, context);
    if (open === 'WHATSAPP') {
      window.open(whatsappLink(phone!, countryCode, text), '_blank', 'noopener');
    } else {
      // `?body=` is what both iOS and Android accept today; older Nokia-era
      // handsets wanted `?` vs `&` differently and are not a concern here.
      window.location.href = `sms:${phone}?body=${encodeURIComponent(text)}`;
    }
    noteContact(open === 'WHATSAPP' ? 'WHATSAPP' : 'SMS', 'MESSAGE_SENT');
    setOpen(null);
  };

  const btn = `inline-flex items-center justify-center rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] hover:border-[var(--sys-primary)]/50 transition-colors ${
    compact ? 'h-7 w-7' : 'h-8 px-2 gap-1 text-xs'
  }`;

  // Turned off means written but not offered — a template kept for next
  // season must not appear in the picker during this one.
  const shown = (templates ?? []).filter(
    (t) => t.active !== false && (t.channel === 'BOTH' || t.channel === open)
  );

  return (
    <div className="relative inline-flex items-center gap-1" ref={box}>
      {/* A dialler is handed digits, not a formatted number: "+962 6 000
          0000" is how a person reads it, and some phones refuse it as a
          tel: target. The leading + is kept; everything decorative goes. */}
      <a
        href={`tel:${phone.replace(/[^\d+]/g, '')}`}
        title="اتصال"
        className={btn}
        onClick={() => noteContact('PHONE', 'OPENED')}
      >
        <RiPhoneLine className="w-4 h-4" />
        {!compact && 'اتصال'}
      </a>
      {/*
        SMS, AND WHY IT IS NOT A GREY BUTTON ON A DESK.
        `sms:` is a phone thing: on a desktop browser the link resolves to
        nothing at all — pressed, the page does not move, no error. A
        permanently disabled button there reads as a broken system rather
        than as «use your phone for this», which is the same fault the
        order window's arrows had.
        So it is not drawn, and the REASON is drawn in its place — in
        words, where the button would have been. In a table row (`compact`)
        there is no room for a sentence and no room for a lie either, so
        the strip is simply shorter there.
      */}
      {!plain && onPhone && (
        <button
          type="button"
          title="رسالة نصية"
          onClick={() => setOpen(open === 'SMS' ? null : 'SMS')}
          className={btn}
        >
          <RiMessage3Line className="w-4 h-4" />
          {!compact && 'SMS'}
        </button>
      )}
      {!plain && !onPhone && !compact && (
        <span className="text-xs text-[var(--sys-muted)]">الرسائل النصية من الموبايل</span>
      )}
      <button
        type="button"
        title="واتساب"
        onClick={plain ? openPlainWhatsapp : () => setOpen(open === 'WHATSAPP' ? null : 'WHATSAPP')}
        className={btn}
      >
        <RiChat3Line className="w-4 h-4" />
        {!compact && 'واتساب'}
      </button>

      {notLogged && (
        <span role="alert" className="text-xs text-[var(--sys-destructive)]">
          {notLogged}
        </span>
      )}

      {open && (
        <>
          {/* On a phone the list is a sheet, so it needs something to sit on
              — and a tap anywhere outside it has to close it, the same as
              the click-away does on a desk. */}
          <div className="fixed inset-0 z-30 bg-[var(--sys-sidebar)]/20 sm:hidden" onClick={() => setOpen(null)} />
          <div
            dir="rtl"
            /**
             * RiPhoneLine: a sheet pinned to the bottom of the SCREEN. The row this
             * button sits in belongs to a table that scrolls sideways, so a
             * menu anchored to the cell lands half off the display — which is
             * exactly where an agent would be reading it from.
             * Desk: the ordinary dropdown under the button.
             */
            className="fixed inset-x-2 bottom-2 z-40 max-h-[60vh] overflow-y-auto rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] shadow-overlay p-1.5 sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-full sm:end-0 sm:z-30 sm:mt-1 sm:w-72 sm:max-h-none sm:shadow-overlay"
          >
            {templates === null ? (
              <p className="p-2 text-xs text-[var(--sys-muted)]">جارٍ التحميل…</p>
            ) : shown.length === 0 ? (
              <p className="p-2 text-xs text-[var(--sys-muted)]">
                لا رسائل جاهزة لهذه القناة — أضِفها من إعدادات النظام.
              </p>
            ) : (
              shown.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => send(t)}
                  className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 w-full text-start p-2.5 sm:p-2 rounded-lg hover:bg-[var(--sys-primary-soft)] active:bg-[var(--sys-primary-soft)] transition-colors"
                >
                  <span className="block text-xs font-semibold text-[var(--sys-heading)]">{t.name}</span>
                  {/* The filled text, not the template: what the customer will
                      actually read is the only useful preview. */}
                  <span className="block text-xs text-[var(--sys-muted-foreground)] line-clamp-2 mt-0.5">
                    {fillTemplate(t.body, context)}
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
