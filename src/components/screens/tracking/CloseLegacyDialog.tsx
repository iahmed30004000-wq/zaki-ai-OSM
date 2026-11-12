'use client';

import React, { useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { arDate } from '@/lib/format';
import {
  DEFAULT_LEGACY_AGE,
  LEGACY_AGES,
  LEGACY_AGE_AR,
  LEGACY_MOST,
  NOTHING_TO_CLOSE_AR,
  readLegacyAge,
  type LegacyAge,
  type LegacyMeasure,
} from '@/lib/legacy-closeout-words';

/**
 * «أقفل القديمة بلا باركود» — closing the old delivered orders that no statement will ever name, WITHOUT moving any money.
 *
 *   «كل الطلبات الي بانتظار التحصيل وما الها بار كود سويها تم تحصيلها بدون ما تأثر على المالية» (the owner, 12/11)
 *
 * THE DIALOG SHOWS THE NUMBER BEFORE IT ASKS. It measures first (`GET`, which writes nothing): how many orders the press would
 * close, whose they are, what they are worth, how old, and — said apart — what it would LEAVE and why. The press sends back
 * what was shown (a fingerprint of the orders and their count); the door refuses if they are no longer those.
 *
 * THE AGE IS A CHOICE, NOT A NUMBER TYPED. «Awaiting collection, no barcode» is also what a RECENT order of an agent looks
 * like, and his cash may still be in his hand; the dialog opens on the cut that leaves the most behind, and every cut shows how
 * many it would close. A new cut is a new question: the tick is taken back and asked again.
 */

const TOP_COURIERS = 6;

export function CloseLegacyDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const [age, setAge] = useState<LegacyAge>(DEFAULT_LEGACY_AGE);
  /** Asking again after a refusal. */
  const [again, setAgain] = useState(0);
  /**
   * EVERY ANSWER, THE TICK AND THE FAILURE ARE KEYED BY THE QUESTION THAT PRODUCED THEM (the cut, and how many times it was asked again).
   *
   * A new cut or a re-read is a new key, so what belonged to the old question simply stops matching: the numbers are gone until the
   * new answer lands, the tick is taken back, and a late answer to an old question can never be drawn — with nothing reset by hand.
   */
  const key = `${age}:${again}`;
  const [loaded, setLoaded] = useState<{ key: string; measure: LegacyMeasure } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [ackKey, setAckKey] = useState<string | null>(null);
  /** Kept across a new question, so the choice never loses its numbers while the next answer is on its way. */
  const [options, setOptions] = useState<LegacyMeasure['options'] | null>(null);
  /** What the door said to a press. Not cleared by the re-read that follows it: that is exactly when it is read. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** A press goes once: after a success the parent closes this dialog, so it is never released. */
  const sent = useRef(false);

  useEffect(() => {
    let current = true;
    apiJson<LegacyMeasure>(`/api/ops/tracking/close-legacy?age=${age}`)
      .then((m) => {
        if (!current) return;
        setLoaded({ key, measure: m });
        setOptions(m.options);
      })
      .catch((e) => {
        if (current) setFailed({ key, message: e instanceof Error ? e.message : 'تعذّر القياس' });
      });
    return () => {
      current = false;
    };
  }, [age, key]);

  const measure = loaded?.key === key ? loaded.measure : null;
  const loadError = failed?.key === key ? failed.message : null;
  const acknowledged = ackKey === key;

  const count = measure?.closeable.count ?? 0;
  const canPress = !!measure && !measure.tooMany && count > 0 && acknowledged;

  const press = async () => {
    if (!measure || sent.current) return;
    sent.current = true;
    setRefusal(null);
    try {
      const res = await apiJson<{ message: string }>('/api/ops/tracking/close-legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          age: measure.age,
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

  const left = measure?.left;
  const couriers = measure?.closeable.byCourier ?? [];
  const shown = couriers.slice(0, TOP_COURIERS);
  const rest = couriers.slice(TOP_COURIERS).reduce((sum, c) => sum + c.count, 0);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="أقفل القديمة بلا باركود"
      subtitle="مسلَّمة وبانتظار التحصيل — بلا أي حركة مصاري"
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
          <p className="text-[var(--sys-foreground)]">
            بتحوّل الطلبات المسلَّمة اللي لسا «بانتظار التحصيل» وما إلها باركود لـ«محصَّلة».
          </p>
          <p className="text-[var(--sys-muted)]">
            ما بينزل ولا قرش بأي محفظة، وعمولتها ما بتصير قابلة للدفع. للطلبات اللي انحصّلت قبل الباركود والتسوية المالية.
          </p>
          <p className="text-[var(--sys-muted)]">
            بتطلع من «بانتظار التحصيل» ومن حساب «عند شركات الشحن»، وما بتنفتح من الشاشة بعد القفل.
          </p>
        </div>

        <Select
          label="اقفل اللي أقدم من"
          value={String(age)}
          onChange={(e) => {
            const next = readLegacyAge(e.target.value);
            if (next === null) return;
            setRefusal(null);
            // A tick given to an earlier look is not given to this one — not even if the cut comes back to the same age.
            setAckKey(null);
            setAge(next);
          }}
        >
          {LEGACY_AGES.map((a) => {
            const n = options?.find((o) => o.age === a)?.count;
            return (
              <option key={a} value={a}>
                {LEGACY_AGE_AR[a]}
                {n === undefined ? '' : ` — ${n} طلب`}
              </option>
            );
          })}
        </Select>

        {loadError && <p className="text-sm text-[var(--sys-destructive)]">{loadError}</p>}
        {!measure && !loadError && (
          <p className="text-xs text-[var(--sys-muted-foreground)]" aria-live="polite">
            عم أعدّ…
          </p>
        )}

        {measure && (
          <div className="space-y-3" aria-live="polite">
            {measure.tooMany ? (
              <p className="text-sm text-[var(--sys-destructive)]">
                أكثر من {LEGACY_MOST} طلب بانتظار التحصيل وبلا باركود — هالضغطة مش لهالحجم.
              </p>
            ) : count === 0 ? (
              <p className="text-sm text-[var(--sys-muted-foreground)]">{NOTHING_TO_CLOSE_AR}</p>
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
              </>
            )}

            {left && (left.tooRecent > 0 || left.moneyRecorded > 0 || left.onAStatement > 0) && (
              <div className="text-xs bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-1">
                <p className="font-medium text-[var(--sys-heading)]">اللي ما رح ينقفل:</p>
                {left.tooRecent > 0 && (
                  <p className="text-[var(--sys-muted-foreground)]">
                    <b className="tabular-nums text-[var(--sys-foreground)]">{left.tooRecent}</b> أحدث من العمر المختار — ممكن لسا مصاريها عند المندوب.
                  </p>
                )}
                {left.moneyRecorded > 0 && (
                  <p className="text-[var(--sys-muted-foreground)]">
                    <b className="tabular-nums text-[var(--sys-foreground)]">{left.moneyRecorded}</b> تسويتها بحالة تانية (محصَّلة عند الشركة أو جزئياً أو مرتجعة).
                  </p>
                )}
                {left.onAStatement > 0 && (
                  <p className="text-[var(--sys-muted-foreground)]">
                    <b className="tabular-nums text-[var(--sys-foreground)]">{left.onAStatement}</b> ذكرها كشف — الكشف هو اللي بيسوّيها.
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
                <span>أقرّ: القفل بلا حركة مصاري، وما بيرجع من الشاشة.</span>
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
