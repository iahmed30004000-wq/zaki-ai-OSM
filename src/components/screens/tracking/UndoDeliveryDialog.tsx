'use client';

import React, { useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Money } from '@/components/ui/Money';
import { UNDO_REASON_MAX, UNDO_REASON_MIN, type UndoMeasure } from '@/lib/delivery-undo-words';
import type { ReturnUndoMeasure } from '@/lib/return-undo-words';
import type { TakeBackMeasure } from '@/lib/legacy-take-back-words';

/**
 * «تراجع عن التسليم» — taking back a delivery that was recorded by mistake (13/11).
 *
 *   «هاد الطلب بالغلط حطيتو تم والشركة بتقول تم ارجاعها لازم يكون في زر تراجع مش محدود بمدة زمنية ويكون عليه صلاحية للمالك متاح» (the owner)
 *
 * THE DIALOG SHOWS WHAT IT WILL DO BEFORE IT ASKS, as the closing dialogs do (`CloseLegacyDialog`). It measures first (a POST that writes
 * nothing): either why this delivery cannot be taken back — in words, with the reason — or EVERY line the press would reverse and, said
 * apart, what it would leave (the stock, the money, the history). The press sends back what was shown (a fingerprint of the order and its
 * plan); the door refuses if it is no longer that. There is no time to choose and nothing to compute: the sentences are the server's, and the
 * one figure — what comes off the customer's record — is drawn as money.
 *
 * It needs a reason (typed, at least five characters — the door's own bound) and one tick. A refusal to the press is said, the numbers are
 * read again and the tick is taken back; the reason typed is kept, so nothing is lost to a stale screen.
 *
 * WHAT WAS PRESSED WHEN IT OPENED IS WHAT IT ASKS ABOUT, and only that: the list behind may be read again, the question does not move.
 */

/**
 * «تراجع عن المرتجع» (25/11) IS THE SAME DIALOG FOR THE OTHER MISTAKE: a return «رجعت» recorded at the door by mistake. Same shape (measure,
 * reason, one tick, the fingerprint back), its own door and its own words. The sentences of the measure are the server's either way.
 */
/*
 * «تراجع عن إقفال القديمة» (25/11) is the same dialog a third time: the no-money «مسوّى» of the close, taken back on one order. Same shape,
 * its own door (the close's own key) and its own words.
 */
type Kind = 'delivery' | 'return' | 'legacy';
const WORDS: Record<Kind, { door: string; title: string; subtitle: string; what: string; when: string; refused: string; placeholder: string; ack: string; failed: string }> = {
  delivery: {
    door: '/api/ops/tracking/undo-delivery',
    title: 'تراجع عن التسليم',
    subtitle: 'بيرجع الطلب لحالتو قبل التسليم',
    what: 'بتلغي تسجيل التسليم اللي انكتب بالغلط، وبيرجع الطلب لحالتو قبل التسليم، وبعدها بيكمّل مساره العادي (إرجاع أو تسليم صح).',
    when: 'مفتوح بأي وقت — ما في مدة محددة. بس بيرفض إذا انسوّى حسابو أو ذكرو كشف أو انعدّ مرتجعو أو صارت عمولتو قابلة للدفع.',
    refused: 'ما بيتراجع عن هالتسليم:',
    placeholder: 'مثال: انسجّل تسليمو بالغلط — الشركة بتقول تم إرجاعها',
    ack: 'أقرّ: التراجع بيغيّر حالة الطلب وسجل الزبون وعمولتو، وبيتسجّل باسمي.',
    failed: 'تعذّر التراجع',
  },
  return: {
    door: '/api/ops/tracking/undo-return',
    title: 'تراجع عن المرتجع',
    subtitle: 'بيرجع الطلب لحالتو قبل «رجعت»',
    what: 'بتلغي تسجيل «رجعت» اللي انكتب بالغلط، وبيرجع الطلب لحالتو قبلها، وبعدها بيكمّل مساره العادي (كشف الشركة أو «استلم»).',
    when: 'مفتوح بأي وقت — ما في مدة محددة. بس بيرفض إذا انعدّ المرتجع بالقسم أو في مصاري عالطلب أو طلب إلغاء أو تأجيل مفتوح. الكشف اللي بيذكر الطلب مش مانع.',
    refused: 'ما بيتراجع عن هالمرتجع:',
    placeholder: 'مثال: انسجّل مرتجع بالغلط — الشركة بتقول تم توصيلها',
    ack: 'أقرّ: التراجع بيغيّر حالة الطلب وسجل الزبون، وبيتسجّل باسمي.',
    failed: 'تعذّر التراجع',
  },
  legacy: {
    door: '/api/ops/tracking/undo-legacy-close',
    title: 'تراجع عن الإقفال',
    subtitle: 'بترجع تسويتو لحالتها قبل «إقفال القديمة»',
    what: 'بتلغي «مسوّى» اللي كتبو «إقفال القديمة» بلا مصاري، وبترجع تسوية الطلب لحالتها قبلو. بعدها «تراجع عن التسليم» وقسم المرتجعات بياخدوه.',
    when: 'طلب واحد بكل ضغطة. بيرفض إذا الطلب مش مسوّى من الإقفال، أو عليه أي مصاري: حركة محفظة، «استلمت منه»، كشف سوّاه، أو عمولة اندفعت.',
    refused: 'ما بيرجع هالإقفال:',
    placeholder: 'مثال: الشركة بتقول الطرد رجع — سطرو بالكشف بصفر',
    ack: 'أقرّ: التراجع بيرجّع تسوية الطلب لحالتها قبل الإقفال، وبيتسجّل باسمي.',
    failed: 'تعذّر التراجع',
  },
};

export function UndoDeliveryDialog({
  order,
  onClose,
  onDone,
  kind = 'delivery',
}: {
  order: { id: string; orderNumber: string; merchantRef: string | null };
  onClose: () => void;
  onDone: (message: string) => void;
  /** Which mistake is taken back: a delivery (the default, as it always was), a return «رجعت», or a no-money «إقفال القديمة». */
  kind?: Kind;
}) {
  const [w] = useState(() => WORDS[kind]);
  const DOOR = w.door;
  const [id] = useState(() => order.id);
  const [label] = useState(() => order.merchantRef ?? order.orderNumber);
  /** Asking again after a refusal. */
  const [again, setAgain] = useState(0);
  /**
   * EVERY ANSWER, THE TICK AND THE FAILURE ARE KEYED BY THE QUESTION THAT PRODUCED THEM (how many times it was asked).
   *
   * A re-read is a new key, so what belonged to the old question simply stops matching: the numbers are gone until the new answer lands,
   * the tick is taken back, and a late answer to an old question can never be drawn — with nothing reset by hand.
   */
  const key = again;
  const [loaded, setLoaded] = useState<{ key: number; measure: UndoMeasure | ReturnUndoMeasure | TakeBackMeasure } | null>(null);
  const [failed, setFailed] = useState<{ key: number; message: string } | null>(null);
  const [ackKey, setAckKey] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  /** What the door said to a press. Not cleared by the re-read that follows it: that is exactly when it is read. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** A press goes once: after a success the parent closes this dialog, so it is never released. */
  const sent = useRef(false);

  useEffect(() => {
    let current = true;
    apiJson<UndoMeasure | ReturnUndoMeasure | TakeBackMeasure>(DOOR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'measure', orderId: id }),
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
  }, [id, again, DOOR]);

  const measure = loaded?.key === key ? loaded.measure : null;
  const loadError = failed?.key === key ? failed.message : null;
  const acknowledged = ackKey === key;
  const ready = reason.trim().length >= UNDO_REASON_MIN;
  const canPress = !!measure && measure.allowed && !!measure.fingerprint && ready && acknowledged;

  const press = async () => {
    if (!measure || !measure.fingerprint || sent.current) return;
    sent.current = true;
    setRefusal(null);
    try {
      const res = await apiJson<{ message: string }>(DOOR, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'undo',
          orderId: id,
          reason: reason.trim(),
          fingerprint: measure.fingerprint,
          acknowledged: true,
        }),
      });
      onDone(res.message);
    } catch (e) {
      sent.current = false;
      setRefusal(e instanceof Error ? e.message : w.failed);
      // What changed is what the person must see: the numbers are read again, and the tick is taken back.
      setAgain((n) => n + 1);
      throw e;
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={w.title}
      subtitle={`${label} — ${w.subtitle}`}
      maxWidth="md"
      footer={
        <div className="flex gap-2">
          <Button size="md" className="flex-1" disabled={!canPress} onClick={press}>
            {w.title}
          </Button>
          <Button size="md" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-[var(--sys-foreground)]">
        <Card plain padding="sm" className="text-note space-y-1">
          <p className="text-[var(--sys-foreground)]">{w.what}</p>
          <p className="text-[var(--sys-muted)]">{w.when}</p>
        </Card>

        {loadError && <p className="text-sm text-[var(--sys-destructive)]">{loadError}</p>}
        {!measure && !loadError && (
          <p className="text-note text-[var(--sys-muted-foreground)]" aria-live="polite">
            عم أعدّ…
          </p>
        )}

        {measure && !measure.allowed && measure.refusal && (
          <div
            role="alert"
            className="flex gap-2 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-note leading-relaxed text-[var(--sys-destructive)]"
          >
            <span>
              <b>{w.refused}</b> {measure.refusal.text}
            </span>
          </div>
        )}

        {measure && measure.allowed && (
          <div className="space-y-3" aria-live="polite">
            <div className="space-y-1">
              <p className="text-note font-medium text-[var(--sys-heading)]">اللي رح يرجع:</p>
              <div className="border border-[var(--sys-border)] rounded-lg divide-y divide-[var(--sys-border)]">
                {measure.lines.map((l) => (
                  <div key={l.key} className="px-3 py-1.5 text-note text-[var(--sys-foreground)]">
                    {l.text}
                    {'amount' in l && l.amount && (
                      <>
                        {' '}
                        <b className="tabular-nums">
                          <Money value={l.amount.value} currency={l.amount.currency} />
                        </b>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <Card plain padding="sm" className="text-note space-y-1">
              <p className="font-medium text-[var(--sys-heading)]">واللي ما رح يتغيّر:</p>
              {measure.stays.map((l) => (
                <p key={l.key} className="text-[var(--sys-muted-foreground)]">
                  {l.text}
                </p>
              ))}
            </Card>

            <Textarea
              label="سبب التراجع *"
              rows={2}
              maxLength={UNDO_REASON_MAX}
              placeholder={w.placeholder}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              helperText="بينكتب على الطلب وبسجل التدقيق باسمك."
            />

            <Checkbox
              id="undo-delivery-ack"
              className="bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg px-2"
              checked={acknowledged}
              onChange={(checked) => setAckKey(checked ? key : null)}
              label={w.ack}
            />
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
