'use client';

import React, { useState } from 'react';
import { useOrderPatch } from '@/components/orders/useOrderPatch';
import { ProductThumb } from '@/components/ui/ProductThumb';
import { useProducts } from '@/hooks/useProducts';
import { amount, type Currency } from '@/lib/format';
import { previewOrderDiscount } from '@/lib/order-discount-preview';
import { ProductLinesEditor, type DraftLine } from '@/components/orders/ProductLinesEditor';
import { RiArchiveLine, RiLoader4Line, RiPencilLine } from '@remixicon/react';
import { raiseEditRequest } from '@/components/orders/raiseEditRequest';
import { TERMINAL_CONFIRMATION_STATUSES } from '@/lib/confirmation-workflow';
import type { ChangeableField } from '@/lib/change-request-fields';
import { MAX_REASON, MIN_REASON } from '@/lib/order-edit-reason';
import { useAsk } from '@/components/ui/Confirm';
import { useIsPhone } from '@/hooks/useIsPhone';


/**
 * What was ordered.
 *
 * Laid out as a list of lines even while an order can hold only one, because
 * that is what it is: the items table has always been per-line, and every
 * screen downstream — preparation, partial delivery, returns — already reads
 * it that way. Only intake and editing are still single-line, so the card is
 * ready for the rest without pretending the rest is finished.
 *
 * The shipping fee is deliberately not an input here. It follows the courier,
 * and the courier is chosen when the shipment is created; a box asking for it
 * at intake invites a number that the fee table will later contradict.
 */

interface Line {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  freeQuantity: number;
  unitPrice: number;
  discountShare: number;
  lineTotal: number;
  /**
   * What the line cost BEFORE the order's discount — the figure its price
   * box opens on, because that is what the door reads the box as. The
   * server sends it (`GET /api/orders/[id]`, `totalsBeforeDiscount`); this
   * card never adds the share back itself.
   */
  beforeDiscount: number;
}

interface Props {
  order: {
    id: string;
    version: number;
    /** Confirmation is the line after which an edit becomes a request. */
    confirmationStatus: string;
    /** The stored total — read, never recomputed in a screen. */
    totalAmount: number;
    quantity: number;
    sellingPrice: number;
    discountAmount: number;
    deliveryFee: number | null;
    priceIncludesDelivery: boolean;
    internalNotes: string | null;
    customerNotes: string | null;
    items?: Line[];
    product?: { name: string; image?: string | null } | null;
    productNameSnapshot?: string | null;
    productImageSnapshot?: string | null;
    offer?: { id: string; name: string; quantity: number; sellingPrice: number } | null;
    deliveryProvider?: { id: string; name: string } | null;
  };
  currency: Currency | null;
  canEdit: boolean;
  onAcquireLock: () => Promise<unknown> | void;
  onSaved: () => void;
}

export function OrderLinesCard({ order, currency, canEdit, onAcquireLock, onSaved }: Props) {
  const patchOrder = useOrderPatch();
  /* A phone wraps a product's name over two lines where a desk cuts it with an ellipsis (ORD-24). */
  const phone = useIsPhone();
  const ask = useAsk();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** «بانتظار الموافقة» — said out loud, not left to be guessed. */
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    discountAmount: String(order.discountAmount ?? 0),
    // What the customer asked for, or what this order needs. Internal notes
    // are a thread of their own below, not a box one person overwrites.
    customerNotes: order.customerNotes ?? '',
  });
  const [draft, setDraft] = useState<DraftLine[]>([]);
  /*
   * The catalogue comes from the one place that fetches it. This card had
   * a bare `fetch` of its own, and a bare fetch does not redirect on an
   * expired session: the person got an empty product list instead of the
   * login screen, which reads as «المنتج مش موجود».
   */
  const { products } = useProducts({ enabled: open });

  const offerName = order.offer?.name || null;
  /**
   * THE LINES THE SERVER WROTE, AND NO LINE IT DID NOT.
   *
   * A synthetic line stood here for an order with no `items`, and its unit
   * price was `sellingPrice / quantity` — rounded by nothing.
   * `the-frontend-invariants.test.ts` carried it on the DIVERGED list, and
   * its entry ends «the remedy is to delete the branch, not to re-justify
   * it».
   *
   * THE DISAGREEMENT, measured by restoring the branch rather than quoted
   * from the old entry: 3 units over a selling price of 50 drew
   * «3 × 16.667 JOD», while the server derives a unit price as
   * `lineTotal / quantity` to TWO places (`settlement.ts`) and stores
   * 16.67. The «50.01» the DIVERGED entry named was the OTHER half of this
   * branch — `unitPrice × quantity` — deleted on 2026-10-03; repeating it
   * here would have been a number carried over from a different
   * expression.
   *
   * Deleted. And it was not reachable while it stood: measured on this
   * database, **0 of 56 orders have no items** — `assertReadyToShip`
   * refuses a lineless order and `e92df25` closed the last door that could
   * make one. A second copy of a money rule that cannot currently run is
   * still a second copy; it waits for the day something makes a lineless
   * order and then prints a figure nobody can trace.
   *
   * AN ORDER WITH NO LINES NOW SAYS SO. The summary underneath already
   * shows `sellingPrice`, `quantity` and the discount as the SERVER holds
   * them, so nothing a reader needs is lost — what goes is a per-unit
   * breakdown this card was inventing.
   */
  const lines: Line[] = order.items ?? [];

  async function openForm() {
    // The button says إغلاق once the form is open, so pressing it again has
    // to close it — it used to re-open the form onto itself and look dead.
    if (open) {
      setOpen(false);
      setError(null);
      return;
    }
    setForm({
      discountAmount: String(order.discountAmount ?? 0),
      customerNotes: order.customerNotes ?? '',
    });
    setDraft(
      lines.map((l) => ({
        key: l.id,
        productId: l.productId,
        offerId: null,
        quantity: l.quantity,
        /*
         * The editor works in line totals, as the API does — and it opens on
         * THE LINE BEFORE THE ORDER'S DISCOUNT, as the server states it,
         * never on a reconstruction of it.
         *
         * IT OPENED ON `lineTotal`, WHICH IS AFTER THE DISCOUNT. `save()`
         * posts this figure as `items[].unitPrice`, the door reads that as
         * the line BEFORE the discount, and spreads the discount box over the
         * lines again — so every press of حفظ with nothing touched took the
         * discount off once more: 64.200, then 57.400, then 50.600. And once
         * the discount was more than the lines left after it, the door
         * refused the save outright, so not even a note could be kept.
         *
         * `beforeDiscount` comes from `GET /api/orders/[id]`
         * (`totalsBeforeDiscount`): `lineTotal + discountShare` when the
         * shares are the order's own discount, and the line total as it
         * stands when they are an offer's reduction the order does not carry
         * as a discount of its own. The card adds nothing: a line total is
         * money, money is computed on the server, and a second opinion about
         * it here is how two numbers start disagreeing. That rule is also why
         * `|| Number(l.unitPrice) * l.quantity` stays gone — the stored
         * `unitPrice` is rounded, so 3 × 16.67 reads 50.01 against a stored
         * 50, and a 0 is a real 0, never a gap to fill.
         *
         * `String(…)` and not `Number(…)` SINCE THE EDITOR'S PRICE BOX HOLDS
         * CHARACTERS. It had to, so that «I cleared this box» could be said
         * at all — `Number('')` is `0` and the box was redrawing a cleared
         * price as a free line. `Number()` here is only the parse of what
         * came over the wire, written back as the digits a person would have
         * typed.
         */
        price: String(Number(l.beforeDiscount)),
        /*
         * AND THE EDITOR TREATS IT AS AGREED. A quantity change never
         * rewrites a saved total; the editor names the base price beside it
         * and a person chooses (see `DraftLine.pricing`).
         */
        pricing: 'saved' as const,
      }))
    );
    setError(null);
    if (!canEdit) await onAcquireLock();
    setOpen(true);
  }

  /**
   * ONCE IT IS CONFIRMED, THIS SAVE IS A REQUEST.
   *
   * Same rule as the customer card. What is different here is WHAT can be
   * asked for: the change-request pipeline carries single values —
   * `productId`, `quantity`, `sellingPrice`, `discountAmount`,
   * `customerNotes` — and `CHANGEABLE_FIELDS` says so for a reason
   * («offerId» was removed from it precisely because one id moved five
   * money inputs through a path built for none of them).
   *
   * A ONE-LINE order maps onto those fields exactly, and that is nearly
   * every order here. A MULTI-LINE one does not: «line 2's quantity» is
   * not sayable in that vocabulary, and inventing a shape for it would
   * mean a request a supervisor can approve and the apply path then
   * refuses — the city bug and the offer bug, for the third time.
   *
   * So a multi-line confirmed order is refused in words that say what to
   * do instead, and it is recorded as RV44 rather than half-built.
   */
  const pastConfirmation = (TERMINAL_CONFIRMATION_STATUSES as string[]).includes(order.confirmationStatus);

  function lineChanges():
    | { ok: true; changes: Partial<Record<ChangeableField, string | number | null>> }
    | { ok: false; why: string } {
    const changes: Partial<Record<ChangeableField, string | number | null>> = {};
    if (Number(form.discountAmount) !== order.discountAmount) {
      changes.discountAmount = Number(form.discountAmount);
    }
    const notes = form.customerNotes.trim() || null;
    if (notes !== (order.customerNotes ?? null)) changes.customerNotes = notes;

    if (draft.length > 1) {
      // Only a refusal if the lines are what changed; a discount edit on a
      // multi-line order is still sayable. The price is compared with the
      // figure its box opened on, in the same notation, so an untouched box
      // reads as untouched.
      const linesTouched =
        draft.length !== (order.items?.length ?? 1) ||
        draft.some((l, i) => {
          const was = order.items?.[i];
          return (
            !was ||
            was.productId !== l.productId ||
            was.quantity !== l.quantity ||
            String(Number(was.beforeDiscount)) !== String(l.price ?? '')
          );
        });
      if (linesTouched) {
        return {
          ok: false,
          why: 'الطلب مؤكَّد وفيه أكتر من سطر — تعديل السطور بينعمل بطلب إلغاء وطلب جديد، أو بموافقة مشرف على كلّ سطر لحاله.',
        };
      }
      return { ok: true, changes };
    }

    const line = draft[0];
    const was = order.items?.[0];
    if (line) {
      if (line.productId !== (was?.productId ?? null)) changes.productId = line.productId;
      if (line.quantity !== (was?.quantity ?? order.quantity)) changes.quantity = line.quantity;
      /*
       * AND THE PRICE IS NOT MAPPED FROM THIS BOX — ON PURPOSE.
       *
       * `DraftLine.price` is the characters in the LINE TOTAL box: the
       * total for that line's quantity, not a unit price. The request
       * pipeline carries `sellingPrice`, which IS per unit. Turning one
       * into the other here would be money arithmetic in a screen, and
       * this product forbids that for a good reason — the totals come
       * from one path and a second opinion in a card is how two numbers
       * start disagreeing.
       *
       * So a price change on a confirmed order is refused with the door
       * that CAN carry it: «تعديل» in the change-request card asks for the
       * new price directly, as one value the person types. Recorded as
       * RV45 rather than half-built.
       */
      /*
       * THE FIGURE THE BOX OPENED ON, READ — not `unitPrice × quantity`
       * computed here. «No money arithmetic in a screen» is a rule in this
       * product, and the first version of this comparison broke it (the
       * frontend-invariants guard caught it). A second opinion about a
       * total in a card is how two numbers start disagreeing.
       *
       * And the SAME figure the box opened on: this read `was.lineTotal`,
       * which is the line after the discount while the box now holds it
       * before — and which arrives as a string, so `!==` against a number
       * called every confirmed one-line save a price change, a note alone
       * included. Both sides are now one server figure, parsed alike.
       */
      const totalWas = was ? Number(was.beforeDiscount) : order.totalAmount;
      if (line.price !== undefined && Number(line.price) !== totalWas) {
        return {
          ok: false,
          why: 'الطلب مؤكَّد — تغيير السعر بينعمل من «تعديل» بكرت طلبات التعديل، لأنّه بيطلب السعر الجديد للوحدة مباشرةً.',
        };
      }
    }
    return { ok: true, changes };
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (pastConfirmation) {
        const mapped = lineChanges();
        if (!mapped.ok) {
          setError(mapped.why);
          return;
        }
        if (Object.keys(mapped.changes).length === 0) {
          setOpen(false);
          return;
        }
        const reason = await ask({
          title: 'طلب تعديل',
          body: 'الطلب مؤكَّد، فالتعديل بيروح كطلب لمن يبتّ فيه. السبب بينحفظ مع الطلب وبيقراه اللي بيوافق.',
          confirmLabel: 'ارفع الطلب',
          input: {
            label: 'ليش بدّه يتعدّل؟',
            placeholder: 'مثال: الزبون زاد الكمية بالتلفون',
            required: true,
            multiline: true,
            maxLength: MAX_REASON,
          },
        });
        const trimmed = (reason ?? '').trim();
        if (trimmed.length < MIN_REASON) return;
        const { applied } = await raiseEditRequest(order.id, mapped.changes, trimmed, order.version);
        setOpen(false);
        if (applied) onSaved();
        else setNotice('بانتظار الموافقة — التعديل انرفع كطلب، والطلب ما تغيّر لحتى حدا يوافق.');
        return;
      }

      const res = await patchOrder(order.id, {
        expectedVersion: order.version,
        items: draft.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.price,
        })),
        discountAmount: Number(form.discountAmount),
        customerNotes: form.customerNotes.trim() || null,
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

  const inputClass =
    'w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-sm focus:outline-none focus:border-[var(--sys-primary)]';

  /*
   * «بعد الخصم» — WHAT THE DISCOUNT BOX WILL DO, BEFORE THE PRESS.
   *
   * The boxes above are handed to the server's own `computeCod` (`order-discount-preview.ts`), the same call the door
   * makes on حفظ, so the figure here is the figure that will be written — to the last decimal, in every currency. This
   * card still adds and subtracts nothing: it draws what the function returns. A discount bigger than the goods, or one
   * the door would refuse, is said here and locks the button, instead of being answered with a 400 after the press.
   */
  const preview = previewOrderDiscount({
    lines: draft.map((l) => ({ quantity: l.quantity, price: l.price })),
    discount: form.discountAmount,
    minorUnit: currency?.minorUnit,
  });
  const refused = preview.kind === 'tooBig' || preview.kind === 'invalid';
  const nameOf = (productId: string) => products.find((p) => p.id === productId)?.name ?? '';

  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 shadow-raised space-y-3">
      <div className={phone ? 'flex flex-wrap items-center justify-between gap-2' : 'flex items-center justify-between gap-2'}>
        <h4 className="text-xs font-black text-[var(--sys-foreground)] flex items-center gap-2">
          <RiArchiveLine className="w-4 h-4 text-[var(--sys-primary)]" />
          بيانات الطلب
          {offerName && (
            <span className="text-xs font-medium text-[var(--sys-primary)] bg-[var(--sys-primary-soft)] border border-[var(--sys-primary-soft)] rounded-md px-1.5 py-0.5">
              عرض: {offerName}
            </span>
          )}
        </h4>
        <button
          onClick={openForm}
          className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)] inline-flex items-center gap-1.5"
        >
          <RiPencilLine className="w-4 h-4" />
          {open ? 'إغلاق' : 'تعديل'}
        </button>
      </div>

      <div className="border border-[var(--sys-border)] rounded-lg divide-y divide-[var(--sys-border)]">
        {lines.length === 0 && (
          <p className="px-3 py-2.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            لا أسطرَ مسجَّلةٌ على هذا الطلب. الأرقام أدناه هي ما يحمله الطلب نفسه —
            اضغط «تعديل» لتسجيل ما فيه.
          </p>
        )}
        {lines.map((line) => (
          <div key={line.id} className="flex items-center gap-3 px-3 py-2.5">
            <ProductThumb
              src={order.productImageSnapshot || order.product?.image}
              alt={line.productName}
              size="sm"
            />
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-medium text-[var(--sys-heading)] ${phone ? 'line-clamp-2' : 'truncate'}`}>{line.productName}</p>
              <p className="text-xs text-[var(--sys-muted)] tabular-nums" dir="ltr">
                {line.quantity} × {amount(line.unitPrice, currency)}
                {line.freeQuantity > 0 && ` + ${line.freeQuantity} هدية`}
              </p>
            </div>
            <span className="text-sm font-bold text-[var(--sys-heading)] tabular-nums shrink-0" dir="ltr">
              {amount(line.lineTotal, currency)}
            </span>
          </div>
        ))}
      </div>

      {!open && (
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
          <Small label="سعر البيع" value={amount(order.sellingPrice, currency)} />
          <Small label="الكمية" value={String(order.quantity)} />
          <Small label="الخصم" value={amount(order.discountAmount, currency)} />
          <Small
            label="أجرة التوصيل"
            value={
              order.deliveryProvider || Number(order.deliveryFee ?? 0)
                ? amount(order.deliveryFee ?? 0, currency)
                : 'تُحدَّد مع الشحنة'
            }
          />
        </dl>
      )}

      {order.priceIncludesDelivery && !open && (
        <p className="text-xs text-[var(--sys-muted)]">سعر البيع شامل التوصيل.</p>
      )}

      {order.customerNotes && !open && (
        <p className="text-xs text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg px-2.5 py-1.5 whitespace-pre-line">
          <span className="text-[var(--sys-warning)]">ملاحظات الطلب: </span>
          {order.customerNotes}
        </p>
      )}

      {open && (
        <div className="space-y-3">
          <ProductLinesEditor
            lines={draft}
            products={products}
            currency={currency}
            onChange={setDraft}
            disabled={busy}
          />

          <label className="block max-w-xs">
            <span className="block text-xs font-medium text-[var(--sys-muted-foreground)] mb-1">الخصم على الطلب</span>
            <input
              type="number" min="0" step="0.01" dir="ltr"
              value={form.discountAmount}
              onChange={(e) => setForm({ ...form, discountAmount: e.target.value })}
              className={inputClass}
            />
          </label>
          {preview.kind === 'tooBig' && (
            <p role="alert" className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-2.5 py-1.5">
              الخصم أكبر من قيمة البضاعة (<span dir="ltr">{amount(preview.goods, currency)}</span>) — صغّره لتقدر تحفظ.
            </p>
          )}
          {preview.kind === 'invalid' && (
            <p role="alert" className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-2.5 py-1.5">
              اكتب خصماً صحيحاً — رقم من صفر وما فوق.
            </p>
          )}
          {/*
            Said, because the price box above holds a different figure from
            the line in the list: the line before the discount, which is what
            the save reads it as. One rule, in the open: each line is priced
            before the discount, and the discount is taken ONCE, off the
            whole order.
          */}
          <p className="text-xs text-[var(--sys-muted)]">
            سعر كل سطر قبل الخصم؛ الخصم مرة واحدة على مجموع الطلب.
          </p>
          <div aria-live="polite">
            <p className="text-xs text-[var(--sys-muted-foreground)]">
              بعد الخصم:{' '}
              <span className="font-bold text-[var(--sys-heading)] tabular-nums" dir="ltr">
                {preview.kind === 'ok' ? amount(preview.after, currency) : '—'}
              </span>
            </p>
            {preview.kind === 'ok' && draft.length > 1 && preview.discount > 0 &&
              draft.map((l, i) => (
                <p key={l.key} className="text-xs text-[var(--sys-muted)]">
                  حصة {nameOf(l.productId) || `السطر ${i + 1}`} من الخصم:{' '}
                  <span dir="ltr">{amount(preview.shares[i] ?? 0, currency)}</span>
                </p>
              ))}
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-[var(--sys-muted-foreground)] mb-1">ملاحظات الطلب</span>
            <textarea
              rows={2}
              value={form.customerNotes}
              onChange={(e) => setForm({ ...form, customerNotes: e.target.value })}
              placeholder="ما طلبه العميل: وقت التوصيل المفضل، تفاصيل العنوان…"
              className="w-full px-3 py-2 rounded-lg border border-[var(--sys-border-input)] text-sm focus:outline-none focus:border-[var(--sys-primary)]"
            />
          </label>

          <p className="text-xs text-[var(--sys-muted)]">
            أجرة التوصيل لا تُكتب هنا — تُحسب من جدول الأجور حين يُسند الطلب لشركة شحن.
          </p>

          {error && <p className="text-xs text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-2.5 py-1.5">{error}</p>}
          {/*
            «بانتظار الموافقة» — said, not left to be guessed. A save that
            raises a request closes the form and changes nothing on the
            order, which otherwise looks exactly like a save that failed.
          */}
          {notice && <p className="text-xs text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg px-2.5 py-1.5">{notice}</p>}

          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy || refused}
              className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-3 py-1.5 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {busy && <RiLoader4Line className="w-4 h-4 animate-spin" />}
              حفظ بيانات الطلب
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

function Small({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--sys-muted)]">{label}</dt>
      <dd className="text-[var(--sys-heading)] font-medium tabular-nums" dir="ltr">{value}</dd>
    </div>
  );
}
