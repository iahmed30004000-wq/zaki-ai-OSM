'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { RiAlertLine } from '@remixicon/react';

/**
 * GIVING UP ON A PARCEL THAT IS NOT COMING BACK.
 *
 * `POST /api/ops/tracking/write-off` has existed, tested, since the day the
 * transfer flow was built — and `nothing-unused-ships.test.ts` named it:
 * «أخواتُه collect وdeliver وtransfer تُستدعى من الشاشات؛ شطبُ الشحنة
 * المفقودة لا يُستدعى من أيِّ زرّ». A door that writes money and consumes
 * stock, reachable only by someone who knows the URL.
 *
 * WHAT IT IS FOR. When an order is pulled away from a shipping company a
 * replacement is raised at once and the original waits at
 * `RETURN_REQUESTED` for the goods to come back. Sometimes they never do.
 * Until somebody says so, the order waits forever: it sits in the returns
 * list and its units stay reserved against a parcel that no longer exists,
 * so the shelf keeps promising stock nobody can pick.
 *
 * WHY THE DIALOG SAYS WHAT IT SAYS. Writing off CONSUMES the stock rather
 * than restoring it, because the goods left and are not coming back —
 * restoring them would put units on a shelf that does not have them and
 * every count from then on would be wrong by exactly this order. That is
 * the one consequence a person must understand before pressing, so it is
 * the first thing in the dialog and it is stated in units and money, not
 * as «سيتم تحديث المخزون».
 *
 * AND IT IS NOT A DELETION. The order keeps its number, its barcode and
 * its history — it has to, because it will still appear on the courier's
 * statement. What changes is that we stop waiting.
 *
 * The reason is required by the door (`min(5)`), and it is required here
 * too rather than being left to a 400: a loss that cannot be explained
 * later is a loss somebody will have to explain later.
 */

/** The door's own bounds, so the button and the 400 cannot disagree. */
const MIN_REASON = 5;
const MAX_REASON = 300;

export function WriteOffDialog({
  order,
  onClose,
  onDone,
}: {
  order: {
    id: string;
    orderNumber: string;
    merchantRef: string | null;
    trackingNumber: string | null;
    totalAmount: number;
    currency: string;
    daysInTransit: number | null;
    deliveryProvider: { name: string } | null;
  };
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const ready = reason.trim().length >= MIN_REASON;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="إغلاق كخسارة"
      subtitle={`${order.merchantRef ?? order.orderNumber} — مطلوب إرجاعه ولم يصل`}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready) return;
          setSaving(true);
          setError(null);
          try {
            const res = await apiJson<{ message: string }>('/api/ops/tracking/write-off', {
              method: 'POST',
              body: JSON.stringify({ orderId: order.id, reason: reason.trim() }),
            });
            /*
             * THE BUTTON DOES NOT COME BACK AFTER A SUCCESS.
             *
             * `saving` was released in a `finally`, and a second click
             * landing between the answer and the parent unmounting this
             * dialog sent the write a second time — caught by this file's
             * own test. The door survives it (the parcel is `RETURNED` by
             * then, so the second call is a 409), but a request that
             * consumes stock must not be SENT twice on the strength of
             * what the server happens to do about it. Closing is the
             * parent's job; staying shut is this one's.
             */
            onDone(res.message);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر الإغلاق كخسارة');
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        {/* THE CONSEQUENCE FIRST, IN MONEY — not «سيتم تحديث المخزون». */}
        <div className="flex gap-2 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-note leading-relaxed text-[var(--sys-destructive)]">
          <RiAlertLine className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            بضاعةُ هذا الطلب{' '}
            <b>
              <Money value={order.totalAmount} currency={order.currency} />
            </b>{' '}
            <b>تخرج من المخزون ولا تعود</b> — لأنها خرجت فعلاً. لا تُعاد إلى الرف، فإعادتُها
            تَعِدُ برصيدٍ غير موجود ويصير كلُّ جردٍ بعدها ناقصاً بمقدار هذا الطلب بالضبط.
          </span>
        </div>

        <div className="rounded-lg bg-[var(--sys-surface)] p-3 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          مع <b className="text-[var(--sys-foreground)]">{order.deliveryProvider?.name ?? 'جهة غير معروفة'}</b>
          {order.daysInTransit !== null && (
            <> منذ <b className="text-[var(--sys-foreground)] tabular-nums" dir="ltr">{order.daysInTransit}</b> يوماً</>
          )}
          {order.trackingNumber && (
            <> · باركود <span className="font-mono tabular-nums" dir="ltr">{order.trackingNumber}</span></>
          )}
          <span className="mt-1.5 block">
            ليس حذفاً ولا إلغاءً: يبقى الطلب برقمه وباركوده وسجلّه — لأنه سيظهر في كشف الشركة.
            الذي يتغيّر أننا توقّفنا عن الانتظار.
          </span>
        </div>

        <Textarea
          label="سبب الخسارة *"
          rows={2}
          maxLength={MAX_REASON}
          placeholder="مثال: الشركة أقرّت بفقدان الشحنة ولم تعوّضها بعد مراجعتين"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          helperText="يُكتب على الطلب وفي سجل التدقيق — خسارةٌ لا يمكن شرحُها لاحقاً هي خسارةٌ سيُطلب شرحُها لاحقاً."
        />

        {error && <p className="text-xs text-[var(--sys-destructive)]">{error}</p>}

        {/* The same footer `TransferDialog` has, to the pixel — two dialogs
            reached from the same row should not be two shapes. Only the
            fill differs, because only one of them cannot be undone. */}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!ready || saving}
          >
            {saving ? 'جارٍ الإغلاق…' : 'أغلقه كخسارة'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
