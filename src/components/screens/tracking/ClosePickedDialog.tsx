'use client';

import React, { useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { arDate } from '@/lib/format';
import { PICKED_NOTHING_AR, type PickedMeasure } from '@/lib/legacy-closeout-words';

/**
 * «أقفل المحدّد بلا حركة مال» — closing the orders the owner TICKED as collected, WITHOUT moving any money (13/11).
 *
 *   «اقدر اعمل هالحركة هاي لاي طلب حتى لو عليه باركود، بس بدي الزر هاد متاح للمالك فقط» (the owner)
 *
 * THE DIALOG SHOWS THE NUMBER BEFORE IT ASKS, as the old-ones dialog does (`CloseLegacyDialog`). It measures first (a POST that
 * writes nothing): how many of the ticked orders the press would close, whose they are, what they are worth, how many carry a
 * barcode or arrived lately — and, said apart and ORDER BY ORDER, the ones it would leave and why (a statement speaks for it, money
 * is already recorded on it, it is not delivered yet). The press sends back what was shown (a fingerprint of the orders and their
 * count); the door refuses if they are no longer those.
 *
 * WHAT WAS TICKED WHEN IT OPENED IS WHAT IT ASKS ABOUT, and only that: the list behind may be read again, the question does not
 * move. There is no age to choose and no barcode rule: the orders are his choice.
 */

const TOP_COURIERS = 6;
const LEFT_SHOWN = 8;
const PICKED_URL = '/api/ops/tracking/close-legacy/picked';

export function ClosePickedDialog({
  orders,
  onClose,
  onDone,
}: {
  orders: { id: string }[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [ids] = useState(() => orders.map((o) => o.id));
  /** Asking again after a refusal. */
  const [again, setAgain] = useState(0);
  /**
   * EVERY ANSWER, THE TICK AND THE FAILURE ARE KEYED BY THE QUESTION THAT PRODUCED THEM (how many times it was asked).
   *
   * A re-read is a new key, so what belonged to the old question simply stops matching: the numbers are gone until the new answer
   * lands, the tick is taken back, and a late answer to an old question can never be drawn — with nothing reset by hand.
   */
  const key = again;
  const [loaded, setLoaded] = useState<{ key: number; measure: PickedMeasure } | null>(null);
  const [failed, setFailed] = useState<{ key: number; message: string } | null>(null);
  const [ackKey, setAckKey] = useState<number | null>(null);
  /** What the door said to a press. Not cleared by the re-read that follows it: that is exactly when it is read. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** A press goes once: after a success the parent closes this dialog, so it is never released. */
  const sent = useRef(false);

  useEffect(() => {
    let current = true;
    apiJson<PickedMeasure>(PICKED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'measure', orderIds: ids }),
    })
      .then((m) => {
        if (current) setLoaded({ key: again, measure: m });
      })
      .catch((e) => {
        if (current) setFailed({ key: again, message: e instanceof Error ? e.message : 'تعذّر القياس' });
      });
    return () => {
      current = false;
    };
  }, [ids, again]);

  const measure = loaded?.key === key ? loaded.measure : null;
  const loadError = failed?.key === key ? failed.message : null;
  const acknowledged = ackKey === key;

  const count = measure?.closeable.count ?? 0;
  const recent = measure?.closeable.recent ?? 0;
  const canPress = !!measure && count > 0 && acknowledged;

  const press = async () => {
    if (!measure || sent.current) return;
    sent.current = true;
    setRefusal(null);
    try {
      const res = await apiJson<{ message: string }>(PICKED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'close',
          orderIds: ids,
          fingerprint: measure.closeable.fingerprint,
          count: measure.closeable.count,
          acknowledged: true,
        }),
      });
      onDone(res.message);
    } catch (e) {
      sent.current = false;
      setRefusal(e instanceof Error ? e.message : 'تعذّر القفل');
      // What changed is what the person must see: the numbers are read again, and the tick is taken back.
      setAgain((n) => n + 1);
      throw e;
    }
  };

  const couriers = measure?.closeable.byCourier ?? [];
  const shown = couriers.slice(0, TOP_COURIERS);
  const rest = couriers.slice(TOP_COURIERS).reduce((sum, c) => sum + c.count, 0);
  const left = measure?.left ?? [];
  const leftMore = measure ? measure.leftTotal - Math.min(left.length, LEFT_SHOWN) : 0;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="أقفل المحدّد بلا حركة مال"
      subtitle={`${ids.length} طلب محدّد — بلا أي حركة مصاري`}
      maxWidth="md"
      footer={
        <div className="flex gap-2">
          <Button size="md" className="flex-1" disabled={!canPress} onClick={press}>
            {count > 0 ? `أقفل ${count} طلب` : 'أقفل'}
          </Button>
          <Button size="md" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-[var(--sys-foreground)]">
        <div className="text-xs bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-1">
          <p className="text-[var(--sys-foreground)]">بتحوّل الطلبات المحدّدة لـ«مسوّى» (تم تحصيلها) — أي طلب، عليه باركود أو لأ.</p>
          <p className="text-[var(--sys-muted)]">
            ما بينزل ولا قرش بأي محفظة، وعمولتها ما بتصير قابلة للدفع. حالة الشحن بتضل «مسلَّم».
          </p>
          <p className="text-[var(--sys-muted)]">
            بتطلع من «بانتظار التحصيل» ومن حساب «عند شركات الشحن»، وما بتنفتح من الشاشة بعد القفل.
          </p>
        </div>

        {loadError && <p className="text-sm text-[var(--sys-destructive)]">{loadError}</p>}
        {!measure && !loadError && (
          <p className="text-xs text-[var(--sys-muted-foreground)]" aria-live="polite">
            عم أعدّ…
          </p>
        )}

        {measure && (
          <div className="space-y-3" aria-live="polite">
            {count === 0 ? (
              <p className="text-sm text-[var(--sys-muted-foreground)]">{PICKED_NOTHING_AR}</p>
            ) : (
              <>
                <div>
                  <p className="text-2xl font-bold text-[var(--sys-heading)] tabular-nums leading-none">{count}</p>
                  <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">طلب رح ينقفل كمحصَّل</p>
                  <p className="mt-1 text-xs text-[var(--sys-muted)]">
                    من {arDate(measure.closeable.oldestAt)} لـ {arDate(measure.closeable.newestAt)}
                    {measure.closeable.value.length > 0 && (
                      <>
                        {' '}· بقيمة{' '}
                        {measure.closeable.value.map((v, i) => (
                          <React.Fragment key={v.currency}>
                            {i > 0 && ' + '}
                            <b className="tabular-nums">
                              <Money value={v.amount} currency={v.currency} />
                            </b>
                          </React.Fragment>
                        ))}{' '}
                        (قيمة الطلبات، مش مصاري رح تنزل)
                      </>
                    )}
                  </p>
                </div>

                <div className="border border-[var(--sys-border)] rounded-lg divide-y divide-[var(--sys-border)]">
                  {shown.map((c) => (
                    <div key={c.name} className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-[var(--sys-foreground)]">{c.name}</span>
                      <span className="tabular-nums text-[var(--sys-muted-foreground)]">{c.count}</span>
                    </div>
                  ))}
                  {rest > 0 && (
                    <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-[var(--sys-muted-foreground)]">شركات تانية</span>
                      <span className="tabular-nums text-[var(--sys-muted-foreground)]">{rest}</span>
                    </div>
                  )}
                </div>

                {measure.closeable.withBarcode > 0 && (
                  <p className="text-xs text-[var(--sys-muted-foreground)]">
                    <b className="tabular-nums text-[var(--sys-foreground)]">{measure.closeable.withBarcode}</b> منها عليها باركود — لو ذكرها كشف بعدين بيطلع «حُصّل يدوياً».
                  </p>
                )}

                {recent > 0 && (
                  <p role="alert" className="text-xs text-[var(--sys-destructive)]">
                    خد بالك: <b className="tabular-nums">{recent}</b> منها وصلت من أقل من {measure.recentDays} يوم — ممكن لسا مصاريها عند المندوب، ولو انقفلت ما بتقدر تسجّل استلامها بعدين.
                  </p>
                )}
              </>
            )}

            {left.length > 0 && (
              <div className="text-xs bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-1">
                <p className="font-medium text-[var(--sys-heading)]">اللي ما رح ينقفل:</p>
                {left.slice(0, LEFT_SHOWN).map((l, i) => (
                  <p key={`${l.orderNumber ?? 'x'}:${i}`} className="text-[var(--sys-muted-foreground)]">
                    {l.text}
                  </p>
                ))}
                {leftMore > 0 && (
                  <p className="text-[var(--sys-muted-foreground)]">
                    و <b className="tabular-nums text-[var(--sys-foreground)]">{leftMore}</b> كمان.
                  </p>
                )}
              </div>
            )}

            {count > 0 && (
              <label className="flex min-h-11 items-start gap-2 text-sm text-[var(--sys-heading)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-2 md:min-h-0">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAckKey(e.target.checked ? key : null)}
                  className="h-5 w-5 mt-1 shrink-0 accent-[var(--sys-primary)]"
                />
                <span>
                  {recent > 0
                    ? `أقرّ: القفل بلا حركة مصاري وما بيرجع من الشاشة، وإنو ${recent} منها حديثة وبقفلها بحكمي.`
                    : 'أقرّ: القفل بلا حركة مصاري، وما بيرجع من الشاشة.'}
                </span>
              </label>
            )}
          </div>
        )}

        {refusal && (
          <p role="alert" className="text-sm text-[var(--sys-destructive)]">
            {refusal}
          </p>
        )}
      </div>
    </Modal>
  );
}
