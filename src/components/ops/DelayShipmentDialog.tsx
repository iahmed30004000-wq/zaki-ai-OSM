'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { RiPauseCircleLine } from '@remixicon/react';

/**
 * «هذا الطلب لن يُشحن اليوم» — one moment, one dialog, ONE way out.
 *
 * The row used to carry two buttons that both read as postponing. «أجّل»
 * asked for a reason and never a date, kept the order confirmed with its
 * goods reserved, and stored the year 2999 when no date came — so a parcel
 * held «for now» left the shipment list and nothing ever brought it back.
 * «للمتابعة» asked for a date and un-confirmed the order. Nobody at a
 * packing table can be expected to decode that from two labels before
 * pressing one.
 *
 * So the distinction moved out of the button names and into the moment of
 * choosing, where it can be said in a sentence. One date, asked first
 * because both outcomes need it, and then the real question: does the
 * customer still want it?
 *
 * ── AND THEN THE OWNER RULED THE QUESTION AWAY ──
 *
 * «ما زال الزبون يريده؟ الغيها ك خيار، وما تحجز رصيد الا بعد ما اشيلو من
 * التأجيل وارجعو لانشاء شحنة.»
 *
 * He is right, and the reason is worth writing down: the question asked a
 * packer to predict a customer's mind, and then charged the shop for the
 * guess. Answering «yes» reserved goods for as long as the date said, so a
 * hopeful yes on a three-week postponement took real stock off the shelf
 * that a customer ready to buy today could not be sold. And the answer was
 * never knowledge — the person pressing it had not spoken to anybody.
 *
 * So there is one action. The shipment is postponed, the order stays
 * confirmed and comes back to the shipment list on the day by itself, and
 * **its goods go back on sale in the meantime**. The stock is taken again
 * when the shipment is actually built, against whatever is on the shelf
 * then — which is the only moment anybody knows it is really there.
 *
 * What that costs is said out loud instead of being chosen: the goods may
 * not be there on the day. That is a risk the shop takes knowingly, and it
 * is smaller than the certainty of stock frozen for a fortnight.
 */

/** Past this the reserved goods cost more than the kept sale is worth. */
export const HOLD_ADVICE_DAYS = 7;

export type DelayChoice = { kind: 'POSTPONE'; until: string; reason?: string };

export function DelayShipmentDialog({
  orderNumber,
  busy,
  onClose,
  onChoose,
}: {
  orderNumber: string;
  busy: boolean;
  onClose: () => void;
  onChoose: (choice: DelayChoice) => void;
}) {
  /**
   * IT OPENS ON A DAY, NOT ON AN EMPTY BOX.
   *
   * The field started blank with no minimum, so the commonest answer —
   * tomorrow — was four interactions away, a date already past could be
   * typed, and the only sign of that was two buttons that quietly refused
   * to work. Reported as «ما في تقويم أختار منه تاريخ».
   */
  const [day, setDay] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [reason, setReason] = useState('');

  /**
   * NOW, FIXED AT THE MOMENT THE DIALOG OPENED.
   *
   * Reading the clock while rendering is impure — React may re-render for
   * any reason — and it is also wrong here: the boundary between «valid» and
   * «in the past», and the number of days shown beside it, must not shift
   * under somebody in the middle of typing a date.
   */
  const [openedAt] = useState(() => Date.now());
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  /**
   * The four answers people actually give, as one press each.
   *
   * A calendar is the right control for «the fourteenth», and the wrong
   * one for «tomorrow» — which is most of them.
   */
  const QUICK: { label: string; days: number }[] = [
    { label: 'غداً', days: 1 },
    { label: 'بعد يومين', days: 2 },
    { label: 'بعد 3 أيام', days: 3 },
    { label: 'بعد أسبوع', days: 7 },
  ];
  const dayAfter = (n: number) => new Date(openedAt + n * 86_400_000).toISOString().slice(0, 10);

  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T09:00:00`) : null;
  const valid = !!parsed && !isNaN(parsed.getTime()) && parsed.getTime() > openedAt - 60_000;
  const days = parsed ? Math.round((parsed.getTime() - openedAt) / 86_400_000) : 0;
  const longWait = valid && days > HOLD_ADVICE_DAYS;

  const postpone = () => {
    if (!valid || !parsed) return;
    onChoose({ kind: 'POSTPONE', until: parsed.toISOString(), reason: reason.trim() || undefined });
  };

  return (
    <Modal isOpen onClose={onClose} title={`${orderNumber} لن يُشحن اليوم`}>
      <div className="space-y-3">
        <label className="block">
          <span className="block text-sm font-medium text-[var(--sys-foreground)] mb-1">
            إلى متى؟
          </span>
          <input
            type="date"
            value={day}
            min={today}
            onChange={(e) => setDay(e.target.value)}
            autoFocus
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
            dir="ltr"
          />
          {/* One press for the four answers people actually give. */}
          <span className="mt-2 flex flex-wrap gap-1.5">
            {QUICK.map((q) => {
              const value = dayAfter(q.days);
              const on = day === value;
              return (
                <button
                  key={q.days}
                  type="button"
                  onClick={() => setDay(value)}
                  className={`min-h-11 md:min-h-0 rounded-lg border px-3 py-1 text-xs font-semibold transition-colors ${
                    on
                      ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]'
                      : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]'
                  }`}
                >
                  {q.label}
                </button>
              );
            })}
          </span>
          <span className="block text-note text-[var(--sys-muted)] mt-1">
            الموعد إلزاميّ — بلا موعدٍ يختفي الطلبُ ولا يُعيده شيء.
          </span>
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-[var(--sys-foreground)] mb-1">
            السبب <span className="text-[var(--sys-muted)]">(اختياري)</span>
          </span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثال: الزبون مسافر حتى الخميس"
            className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm"
          />
        </label>

        {/* WHAT THE DATE COSTS, before it is pressed. The goods are not
            held during a postponement, so a long one no longer freezes
            stock — the risk moved to the other side, and it is stated. */}
        {longWait && (
          <p className="text-note text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg px-3 py-2">
            {days} يوماً مدّةٌ طويلة — البضاعةُ تعود للبيع خلالها، وقد لا تجدها يوم الموعد.
          </p>
        )}

        <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)] pt-1">
          يبقى الطلبُ مؤكَّداً ويعود إلى قائمة الشحن في الموعد وحدَه — وبضاعتُه تعود للبيع الآن،
          فتُحجَز من جديد حين تُبنى الشحنةُ فعلاً.
        </p>

        <button
          type="button"
          disabled={!valid || busy}
          onClick={postpone}
          className="min-h-11 w-full text-start flex items-start gap-2 p-3 rounded-lg border border-[var(--sys-border)] transition-colors hover:border-[var(--sys-primary)] disabled:opacity-50"
        >
          <RiPauseCircleLine className="w-5 h-5 shrink-0 text-[var(--sys-primary)]" aria-hidden />
          <span>
            <b className="block text-sm text-[var(--sys-heading)]">
              {busy ? 'جارٍ التأجيل…' : 'أجِّل شحنَه إلى هذا الموعد'}
            </b>
            <span className="block text-note text-[var(--sys-muted-foreground)]">
              تجده في تبويب «مؤجَّلة الشحن» حتى الموعد.
            </span>
          </span>
        </button>
      </div>
    </Modal>
  );
}
