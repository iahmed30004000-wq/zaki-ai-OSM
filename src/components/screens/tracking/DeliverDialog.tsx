'use client';

import React, { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { RiArchiveDrawerLine } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { useIsPhone } from '@/hooks/useIsPhone';

/**
 * Settling a parcel at the door.
 *
 * One dialog for all three outcomes, because they are the same event seen
 * from different line counts: everything taken, some taken, nothing taken.
 * Three separate buttons would invite three different fee rules.
 *
 * The fee line is stated plainly and does not move as lines are unticked,
 * because it does not move in reality — the courier travelled to that door
 * whichever lines came back.
 *
 * EVERY FIELD HERE IS THE SHARED `Input`, and that is not tidiness. A
 * native control that names no background of its own is painted by the user
 * agent, and this screen's report — «إذا كانت بيضا فتكون أزرق» — was that
 * white box on a dark card. `color-scheme` is declared per palette now
 * (system.css, guarded in system-themes.test.ts), so the user agent draws
 * the widget in the right scheme and that half of it is fixed at the root.
 *
 * The shared field is still the right one for the other half: system.css
 * paints `:focus-visible` only, by design, so a field a clerk TAPS has no
 * state at all unless the component brings
 * `focus:ring-[var(--sys-primary)]/25` with it. The shell was never the
 * problem: this has always been the system `Modal`.
 */

interface Line {
  id: string;
  productName: string;
  quantity: number;
  freeQuantity: number;
  unitPrice: number;
  discountShare: number;
}

export function DeliverDialog({
  order,
  onClose,
  onDone,
}: {
  order: { id: string; orderNumber: string; merchantRef: string | null; currency: string; deliveryFee?: number | null; priceIncludesDelivery?: boolean };
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const phone = useIsPhone();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [taken, setTaken] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiJson<{ order: { items: Line[] } }>(`/api/orders/${order.id}`)
      .then((d) => {
        setLines(d.order.items);
        // Everything taken is the common case; unticking is the exception.
        setTaken(Object.fromEntries(d.order.items.map((i) => [i.id, i.quantity + i.freeQuantity])));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'تعذر تحميل البنود'));
  }, [order.id]);

  const anyTaken = Object.values(taken).some((n) => n > 0);
  const allTaken = (lines ?? []).every((l) => (taken[l.id] ?? 0) === l.quantity + l.freeQuantity);

  /**
   * THE MONEY IS THE DOOR'S, ASKED FOR — NOT WORKED OUT HERE.
   *
   * This screen used to compute it: a loop over the lines, the discount
   * share divided back out per unit, the fee added unless it was already
   * in the price. A second copy of `doorMoney`, and
   * `the-frontend-invariants.test.ts` carried it on the DIVERGED list.
   *
   * MEASURED, the two copies apart:
   *
   *   an order with a thank-you-page upsell   door 29.5   screen 24.5
   *   the same, one of two units refused      door 18.5   screen 13.5
   *   Syrian pounds, whole units              door 21     screen 21.333…
   *
   * The upsell has no LINE, so a loop over lines could never see it — the
   * courier was told to collect five dinars less than the door would
   * record. And nothing here rounded by the store's currency.
   *
   * The contract forbids computing a COD in a browser, so this is not a
   * corrected copy: `POST …/deliver` answers `{ preview }` for the ticks
   * as they stand, running the same `doorMoney` the submit will run, and
   * writing nothing. Until it answers, the figures are a dash — never a
   * confident zero over a sum nobody has made.
   */
  const [money, setMoney] = useState<{ goods: number; fee: number; collected: number } | null>(null);
  const [pricing, setPricing] = useState(false);

  useEffect(() => {
    if (!lines) return;
    const body = {
      orderId: order.id,
      lines: lines.map((l) => ({ itemId: l.id, deliveredQty: taken[l.id] ?? 0 })),
      preview: true as const,
    };
    let current = true;
    setPricing(true);
    apiJson<{ preview: { goods: number; fee: number; collected: number } }>(
      '/api/ops/tracking/deliver',
      { method: 'POST', body: JSON.stringify(body) }
    )
      .then((d) => { if (current) setMoney(d.preview); })
      // A failed price is a dash, not a stale figure from the last tick.
      .catch(() => { if (current) setMoney(null); })
      .finally(() => { if (current) setPricing(false); });
    return () => { current = false; };
  }, [lines, taken, order.id]);

  /** A figure the server sent, or a dash. Never one this screen made. */
  const figure = (v: number | undefined) =>
    v === undefined ? <span className="text-[var(--sys-muted)]">—</span> : <Money value={v} currency={order.currency} />;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="تسجيل التسليم"
      subtitle={`${order.merchantRef ?? order.orderNumber} — أشّر ما استلمه العميل فعلاً`}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            const res = await apiJson<{ message: string }>('/api/ops/tracking/deliver', {
              method: 'POST',
              body: JSON.stringify({
                orderId: order.id,
                lines: (lines ?? []).map((l) => ({ itemId: l.id, deliveredQty: taken[l.id] ?? 0 })),
                note: note.trim() || undefined,
              }),
            });
            onDone(res.message);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر التسجيل');
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        {!lines ? (
          <p className="text-sm text-[var(--sys-muted-foreground)] py-6 text-center">جارٍ التحميل…</p>
        ) : (
          <>
            <div className="border border-[var(--sys-border)] rounded-lg divide-y divide-[var(--sys-border)]">
              {lines.map((l) => {
                const shipped = l.quantity + l.freeQuantity;
                const value = taken[l.id] ?? 0;
                return (
                  <div key={l.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      {/* In 271px the name is what is being checked; an ellipsis hid the size or the variant. A desk keeps one line. */}
                      <p className={phone ? 'text-sm text-[var(--sys-heading)]' : 'text-sm text-[var(--sys-heading)] truncate'}>{l.productName}</p>
                      <p className="text-xs text-[var(--sys-muted)] tabular-nums">
                        شُحن {shipped}
                        {l.freeQuantity > 0 && ` (منها ${l.freeQuantity} هدية)`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {/* h-11 md:h-10, the scale — it was `min-h-11
                          md:min-h-0` with `py-1`, which on a desk collapsed
                          to the text's own height and stood a few pixels
                          shorter than the box beside it. Two controls in one
                          row at two heights is «غير متناسبة مع التصميم» in
                          its plainest form. */}
                      <button
                        type="button"
                        onClick={() => setTaken((t) => ({ ...t, [l.id]: 0 }))}
                        className={`h-11 md:h-10 inline-flex items-center text-xs px-3 rounded-lg border transition-colors ${
                          value === 0 ? 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]' : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
                        }`}
                      >
                        رفضه
                      </button>
                      {/* The system's field, in a 64px box. The raw input it
                          replaces named no background and fell back to the
                          user agent's — «لما أجي أختار منتج يتضوي بيضا» —
                          which `color-scheme` per palette now answers at the
                          root. It also had `md:h-8`, off the scale in both
                          directions, which is this component's own job. */}
                      <div className="w-16">
                        <Input
                          type="number"
                          min={0}
                          max={shipped}
                          value={value}
                          onChange={(e) =>
                            setTaken((t) => ({ ...t, [l.id]: Math.max(0, Math.min(shipped, Number(e.target.value))) }))
                          }
                          className="px-2 text-center tabular-nums"
                          dir="ltr"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="text-xs bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3 space-y-1 tabular-nums">
              <p className="flex justify-between text-[var(--sys-foreground)]">
                <span>قيمة ما استُلم</span>
                <span>{figure(money?.goods)}</span>
              </p>
              <p className="flex justify-between text-[var(--sys-foreground)]">
                <span>
                  أجرة التوصيل
                  {order.priceIncludesDelivery && <span className="text-[var(--sys-muted)]"> (داخلة في السعر)</span>}
                </span>
                <span>{figure(money?.fee)}</span>
              </p>
              {/*
                «المتوقَّع», not «المحصَّل».
                Nobody at this screen knows what money arrived — a follow-up
                agent is repeating what the courier said on the phone. The
                figure that lands on the order is the one on the courier's
                statement, and until it comes in this is what we expect.
              */}
              <p className="flex justify-between font-semibold text-[var(--sys-heading)] border-t border-[var(--sys-border)] pt-1">
                <span>المتوقَّع تحصيله</span>
                <span>{figure(money?.collected)}</span>
              </p>
              <p className="text-xs text-[var(--sys-muted)]">
                {pricing
                  ? 'جارٍ حساب المتوقَّع على الخادم…'
                  : 'المبلغ الفعليّ يُسجَّل من كشف شركة الشحن عند المطابقة — لا من هنا.'}
              </p>

              {!allTaken && anyTaken && (
                <p className="text-xs text-[var(--sys-warning)] pt-1">
                  الأجرة تُحتسب كاملة رغم رفض بعض البنود — المندوب قطع الطريق فعلاً.
                </p>
              )}
              {!anyTaken && (
                <p className="text-xs text-[var(--sys-destructive)] pt-1">
                  لم يُستلم شيء — سيُسجَّل الطلب مرتجعاً بلا أجرة.
                </p>
              )}
            </div>

            {/*
              A PARTIAL DELIVERY IS THE FIRST OF TWO COMPLETIONS.

                «بصير الطلب بيتمم مرتين — مرة بيتمم للمستلم ومرة للطلب
                 الراجع. واذا اتمم واحد فهو اتمم جزءي، ما بنغلق غير كامل»

              The person at this screen finishes their half and closes the
              dialog, so this is the only moment they can be told there is a
              second one. It is stated only when it applies — some taken and
              some refused — because saying it on a full delivery would make
              it noise people learn to skip.
            */}
            {!allTaken && anyTaken ? (
              <ul className="text-xs bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-2 space-y-1">
                <li className="font-medium text-[var(--sys-heading)]">
                  هذا الطلب يُتَمَّم مرتين — لا يُغلق إلا بإتمامهما:
                </li>
                <li className="text-[var(--sys-foreground)]">• تحصيل مال ما استلمه العميل — من كشف شركة الشحن</li>
                <li className="text-[var(--sys-foreground)]">• استلام القطع المرفوضة وعدّها في شاشة المرتجعات</li>
              </ul>
            ) : (
              <p className="text-xs text-[var(--sys-muted)]">
                البنود المرفوضة لا تعود للمخزون من هنا — تُستلم وتُفحص في شاشة المرتجعات.
              </p>
            )}

            {/*
              NOT «ملاحظة (اختيارية)».
              It used to be written into the delivery attempt and this
              event's metadata — three machine places and no human one. It
              is now an internal note on the order itself, in the thread the
              confirmation team, the returns desk and the owner all read, so
              the label says that rather than «optional».
            */}
            <label className="block">
              <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">
                ملاحظة داخلية على الطلب
              </span>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="مثال: رفض القطعة الثانية — اللون غير المطلوب"
              />
              <span className="block text-xs text-[var(--sys-muted)] mt-1">
                تُضاف باسمك إلى ملاحظات الطلب، ويقرؤها التأكيد والمرتجعات.
              </span>
            </label>
          </>
        )}

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={saving || !lines}
            className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-success)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <RiArchiveDrawerLine className="w-4 h-4" />
            {saving ? 'جارٍ التسجيل…' : !anyTaken ? 'تسجيل كمرتجع' : allTaken ? 'تسليم كامل' : 'تسليم جزئي'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
