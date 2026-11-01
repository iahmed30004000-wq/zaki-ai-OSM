'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { onTheWire, typedFigure } from '@/lib/typed-box';
import { offerCeiling } from '@/lib/offer-ceiling';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { screenApi as crmApi } from '@/lib/screen-api';
import { useConfirm } from '@/components/ui/Confirm';
import { RiAddCircleLine, RiArrowDownSLine, RiArrowUpSLine, RiDeleteBinLine, RiDraggable, RiEyeOffLine, RiLoader4Line, RiMagicLine, RiPencilLine, RiPriceTag3Line, RiStarLine } from '@remixicon/react';
import { moneyText } from '@/lib/money';
import { minorUnitFor } from '@/lib/currencies';
import { moveAfterDrag, moveOffer, type OfferMove } from '@/lib/offer-order';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * A product's offers, edited where the product is.
 *
 * They used to be managed on a separate screen and copied again onto every
 * landing page — three places to change one price, and nothing to tell you
 * when they disagreed. Here there is one list: the landing page, the quick
 * order and the order screen all read it.
 *
 * Deliberately NOT the option/value matrix a big storefront uses. For a
 * one-product cash-on-delivery store the whole catalogue of choices is
 * "how many, and for how much", and a matrix makes you build a grid to
 * express three rows.
 */

interface Offer {
  id: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  sellingPrice: number;
  compareAtPrice: number | null;
  endsAt: string | null;
  discount: number;
  deliveryIncluded: boolean;
  /** The one bundle shown on the thank-you screen — and on no door. */
  postOrderOffer: boolean;
  isDefault: boolean;
  sortOrder: number;
  status: string;
  /**
   * The most this bundle may cost, and whether it costs more — worked out by the door (`GET /api/offers`) with the
   * function the doors refuse with. Printed as sent: the screen does no arithmetic of its own on a stored row.
   */
  maxPrice?: number | null;
  aboveBase?: boolean;
}

/**
 * WHAT A BOX PUTS ON THE WIRE: ITS CHARACTERS, OR NOTHING AT ALL.
 *
 * The reader `CourierFees.tsx` got in `17cbe93` and `ManufacturingScreen.tsx`
 * in `509306a`. Three boxes on this form were the defect it names —
 * `Number(e.target.value) || 0` on the selling price, `|| 0` on the free
 * quantity, `|| 1` on the quantity — so a cleared box and a typed zero were
 * the same request, and the component wrote the fabricated figure back into
 * the box (clearing «25» and typing «30» produced «030»).
 *
 * `undefined` is the answer for an empty box and `JSON.stringify` drops it,
 * so the field is ABSENT on the wire — and `compareAtPrice` just below has
 * said the equivalent in this file all along (`e.target.value === '' ? null
 * : …`), which is why nothing new is imported here. The three fields differ
 * only in WHAT ABSENT MEANS, and each answer is the column's:
 *
 *   quantity      `Int @default(1)`   NOT NULL → absent legitimately IS 1,
 *                                     and `offerFields` says so once:
 *                                     `count(999, 1).default(1)`.
 *   freeQuantity  `Int @default(0)`   NOT NULL → absent legitimately IS 0.
 *   sellingPrice  `Float`             NOT NULL, NO DEFAULT → absent is not a
 *                                     value this column can hold, so the
 *                                     door REFUSES it: «سعر البيع مطلوب».
 *   compareAtPrice `Float?`           NULLABLE → three states, hence `null`
 *                                     rather than absence. Unchanged.
 *
 * So no number in this file is a copy of a default any more. On a PATCH the
 * absent field is left alone (`omittedMeansOmitted`, see `lib/offers.ts`),
 * and on a POST the column's own default decides — one copy, in
 * `schema.prisma`, read once by `offerFields`.
 *
 * AND IT IS THE CHARACTERS, NOT A NUMBER: `money()`/`count()` in
 * `numeric-input.ts` are stricter than `Number()` and refuse `'0x10'` and
 * `''` by name, so handing them what was typed is the only way their refusal
 * can be about what a person typed.
 */

/**
 * The draft of one offer. The three numeric boxes hold CHARACTERS so that
 * «I have not written anything» is sayable; everything else is the stored
 * row's own shape.
 */
type Draft = Omit<Partial<Offer>, 'quantity' | 'freeQuantity' | 'sellingPrice'> & {
  quantity: string;
  freeQuantity: string;
  sellingPrice: string;
};

export function ProductOffers({
  productId, basePrice, currency, canManage = true, canChangePrice = false,
}: {
  productId: string;
  basePrice: number;
  currency: string;
  canManage?: boolean;
  /** `products.change_price` — whether «تعديل المنتج» is a door this person can use to write a base price. */
  canChangePrice?: boolean;
}) {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /*
   * THE STORE'S OWN DECIMALS, FROM THE DOOR THAT WILL MEASURE THE OFFER.
   *
   * The line an offer must stay under is rounded by the store's currency, and the door rounds it with the store's
   * own setting. The table of currencies is only a default for that setting, so until the door has answered it is
   * the stand-in — and afterwards the hint, the generator and every figure on this card round the way the door does.
   */
  const [storeUnit, setStoreUnit] = useState<number | null>(null);
  const unit = storeUnit ?? minorUnitFor(currency) ?? 2;

  const load = useCallback(async () => {
    try {
      const d = await crmApi(`/api/offers?productId=${encodeURIComponent(productId)}`);
      setOffers(d.offers || []);
      if (typeof d.minorUnit === 'number') setStoreUnit(d.minorUnit);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message || 'تعذر تحميل العروض' });
      setOffers([]);
    }
  }, [productId]);

  /*
   * AND AGAIN WHEN THE BASE PRICE MOVES. Each row's «أغلى من السعر الأساسي» is the door's answer for the base price it
   * read, and «تعديل المنتج» on this same page changes that price without unmounting this card. Without a new read,
   * a raise that fixes «3 بـ80» would leave the flag up, and the owner would think the fix failed. `basePrice` sits
   * on this effect, not on `load`: a callback may not list what it does not read, an effect may.
   */
  useEffect(() => { void load(); }, [load, basePrice]);

  async function save() {
    if (!draft?.name?.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      /*
       * NOT ONE `?? <literal>` LEFT ON THIS WIRE.
       *
       * Six of them stood here, and every one was a copy of a default that
       * `schema.prisma` already declares: `?? 0` over `freeQuantity Int
       * @default(0)`, `?? 0` over `discount Float @default(0)`, `?? true`
       * over `deliveryIncluded Boolean @default(true)`, `?? false` over
       * `isDefault Boolean @default(false)`, `?? 'ACTIVE'` over `status
       * String @default("ACTIVE")`. Harmless on a POST, where they merely
       * repeated the column — and a live hazard on the PATCH this same
       * function sends for an EXISTING offer: `discount: draft.discount ??
       * 0` over an offer stored with a discount of 3 writes 0 the moment
       * anything leaves that key off the draft. `323e95a` stripped the
       * defaults out of the patch schema precisely so that omitted could
       * mean omitted; sending a fabricated value re-opens the door it shut.
       *
       * `sortOrder` stays because it is NOT a copy of the column's default:
       * the column says 0 («first») and this screen means «append», which is
       * a positional decision only the list can make. It is set once, in the
       * initialiser below, and sent as it stands.
       */
      const body = JSON.stringify({
        productId,
        name: draft.name,
        quantity: onTheWire(draft.quantity),
        freeQuantity: onTheWire(draft.freeQuantity),
        sellingPrice: onTheWire(draft.sellingPrice),
        compareAtPrice: draft.compareAtPrice ?? null,
        discount: draft.discount,
        deliveryIncluded: draft.deliveryIncluded,
        postOrderOffer: draft.postOrderOffer,
        isDefault: draft.isDefault,
        sortOrder: draft.sortOrder,
        status: draft.status,
      });
      if (draft.id) {
        await crmApi(`/api/offers/${draft.id}`, { method: 'PATCH', body });
      } else {
        await crmApi('/api/offers', { method: 'POST', body });
      }
      setDraft(null);
      await load();
      setMsg({ ok: true, text: 'تم الحفظ' });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message || 'تعذر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, data: Record<string, unknown>) {
    setBusy(true);
    try {
      await crmApi(`/api/offers/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message || 'تعذر التعديل' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    // This one went straight through: a price tier somebody spent a minute on, gone by a slip of the thumb. The door either deletes
    // it or — when an order was placed on it — retires it, and it says so afterwards; the question says both.
    const ok = await confirm({
      title: `حذف العرض «${name}»؟`,
      body: 'إن كانت عليه طلبات يُوقَف بدل الحذف كي تبقى الطلبات مقروءة؛ وإلا يُحذف نهائياً.',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await crmApi(`/api/offers/${id}`, { method: 'DELETE' });
      await load();
      if (res?.retired) setMsg({ ok: true, text: res.message });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message || 'تعذر الحذف' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Three tiers from the base price, so a new product is sellable in one click.
   *
   * AND NO TIER ABOVE ITS LINE — the owner's rule, «العرض ما بصير يكون اكثر من السعر الاساسي». The multipliers round
   * to whole units, and a base price with a fraction rounds UP past its own line: 12.5 made a first tier of 13,
   * which the door refuses now, and the button would have stopped at its first offer with two still to write. So
   * each tier is capped at `offerCeiling` — the function the door measures it with, at the store's own decimals. A
   * whole base price is untouched by the cap: 25 still makes 25, 45 and 63.
   */
  async function generate() {
    setBusy(true);
    setMsg(null);
    try {
      const tiers = [
        { n: 1, free: 0, mult: 1, label: 'قطعة واحدة' },
        { n: 2, free: 0, mult: 1.8, label: 'قطعتان' },
        { n: 3, free: 1, mult: 2.5, label: 'ثلاث قطع + واحدة هدية' },
      ];
      for (const [i, t] of tiers.entries()) {
        const proposed = Math.round(basePrice * t.mult);
        const line = offerCeiling(basePrice, t.n, unit);
        await crmApi('/api/offers', {
          method: 'POST',
          body: JSON.stringify({
            productId,
            name: t.label,
            quantity: t.n,
            freeQuantity: t.free,
            sellingPrice: line === null ? proposed : Math.min(proposed, line),
            // NO «was» PRICE. It used to be generated here as
            // `basePrice × (quantity + free)` — arithmetic about a price the
            // shop may never have charged — and the comment beside it called
            // that a real comparison. A struck-through price is now shown
            // only as far as real delivered orders support it, so generating
            // one would have produced a number that is simply never drawn.
            compareAtPrice: null,
            isDefault: i === 1,
            sortOrder: i,
          }),
        });
      }
      await load();
      setMsg({ ok: true, text: 'تم توليد ثلاثة عروض — عدّلها كما تشاء' });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message || 'تعذر التوليد' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * ONE MOVE, FOR THE GRIP AND FOR THE ARROWS — `lib/offer-order.ts` says what it is; this puts it on the screen and on the server.
   *
   * It shows the new order AT ONCE (a drop that waited for the server would snap back and then forward), writes only the offers
   * whose stored number changed — in ONE `PATCH /api/offers`, all or none — and then reads the list
   * back: the server's own order is the truth, after a success and after a failure alike. A write that failed says so, and the
   * list reads back as it really is rather than as it was drawn.
   */
  async function applyMove(m: OfferMove) {
    if (!offers) return;
    const byId = new Map(offers.map((o) => [o.id, o]));
    setOffers(m.ids.map((id) => byId.get(id)!));
    setBusy(true);
    setMsg(null);
    try {
      // One request, one transaction on the server: every offer holds its new place or none does.
      if (m.writes.length > 0) {
        await crmApi('/api/offers', { method: 'PATCH', body: JSON.stringify({ productId, order: m.writes }) });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e.message || 'تعذر حفظ الترتيب' });
    } finally {
      await load();
      setBusy(false);
    }
  }

  function move(i: number, dir: -1 | 1) {
    if (!offers) return;
    const m = moveOffer(offers, i, i + dir);
    if (m) void applyMove(m);
  }

  const money = (n: number) => moneyText(Number(n), currency, unit);

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <RiPriceTag3Line className="w-4 h-4 text-[var(--sys-primary)]" />
            <span>عروض المنتج</span>
          </span>
        }
        action={
          canManage && (
            <div className="flex items-center gap-2">
              {offers?.length === 0 && basePrice > 0 && (
                <Button size="sm" variant="outline" onClick={generate} disabled={busy}>
                  <RiMagicLine className="w-4 h-4" /> توليد سريع
                </Button>
              )}
              <Button
                size="sm"
                disabled={busy}
                /*
                 * A NEW OFFER OPENS WITH EVERY NUMERIC BOX EMPTY.
                 *
                 * `quantity: 1`, `freeQuantity: 0`, `discount: 0`,
                 * `deliveryIncluded: true` and `status: 'ACTIVE'` were five
                 * copies of defaults that live in `schema.prisma` —
                 * transcribed into a browser and then saved as though a
                 * person had chosen them. They are gone, and absence now
                 * reaches the column that owns each one.
                 *
                 * `sellingPrice` opens empty too, and that is the one worth
                 * pausing on: `sellingPrice: basePrice` was not invention —
                 * the product's own price is a real figure — but it was the
                 * price of ONE PIECE pre-filled into the price of A BUNDLE.
                 * Press «عرض جديد», type «ثلاث قطع + واحدة هدية», press
                 * حفظ, and the shop sells four units for the price of one.
                 * The placeholder names the base price instead, so the
                 * seller SEES the figure and has to choose it.
                 *
                 * What stays is what is not a default: `isDefault` (the
                 * first offer of a product is its default — a decision only
                 * this list can make) and `sortOrder` (append, where the
                 * column says «first»).
                 */
                onClick={() =>
                  setDraft({
                    name: '',
                    quantity: '',
                    freeQuantity: '',
                    sellingPrice: '',
                    compareAtPrice: null,
                    isDefault: (offers?.length ?? 0) === 0,
                    sortOrder: offers?.length ?? 0,
                  })
                }
              >
                <RiAddCircleLine className="w-4 h-4" /> عرض جديد
              </Button>
            </div>
          )
        }
      />
      <CardContent className="space-y-3">
        <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          هذه العروض هي المصدر الوحيد للأسعار — صفحات الهبوط والطلب السريع تقرأ منها،
          فتغيير السعر هنا يصل إلى كل مكان يبيع هذا المنتج.
        </p>

        {msg && (
          <p className={`text-xs ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</p>
        )}

        {offers === null ? (
          <p className="flex items-center gap-2 text-xs text-[var(--sys-muted-foreground)]">
            <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
          </p>
        ) : offers.length === 0 ? (
          <p className="text-xs text-[var(--sys-muted)]">
            لا عروض بعد — النموذج سيعرض سعر المنتج الأساسي فقط.
          </p>
        ) : (
          <ReorderFrame enabled={canManage} offers={offers} onMove={applyMove}>
          <ul className="space-y-2">
            {offers.map((o, i) => {
              const units = o.quantity + o.freeQuantity;
              const inactive = o.status !== 'ACTIVE';
              const Item = canManage ? SortableLi : PlainLi;
              return (
                <Item
                  key={o.id}
                  id={o.id}
                  name={o.name}
                  disabled={busy}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5 ${
                    inactive
                      ? 'border-[var(--sys-border)] bg-[var(--sys-surface)] opacity-60'
                      : o.isDefault
                        ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)]'
                        : 'border-[var(--sys-border)] bg-[var(--sys-card)]'
                  }`}
                >
                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1">
                      <GripSlot />
                      <div className="flex shrink-0 flex-col">
                        <button
                          onClick={() => move(i, -1)}
                          disabled={i === 0 || busy}
                          className="cursor-pointer text-[var(--sys-muted)] hover:text-[var(--sys-primary)] disabled:opacity-25"
                          aria-label="لأعلى" title="لأعلى"
                        >
                          <RiArrowUpSLine className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => move(i, 1)}
                          disabled={i === offers.length - 1 || busy}
                          className="cursor-pointer text-[var(--sys-muted)] hover:text-[var(--sys-primary)] disabled:opacity-25"
                          aria-label="لأسفل" title="لأسفل"
                        >
                          <RiArrowDownSLine className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="min-w-0 flex-1 basis-[55%]">
                    <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--sys-heading)]">
                      <span className="truncate">{o.name}</span>
                      {o.isDefault && <RiStarLine className="w-4 h-4 shrink-0 fill-[var(--sys-warning)] text-[var(--sys-warning)]" />}
                      {inactive && <RiEyeOffLine className="w-4 h-4 shrink-0 text-[var(--sys-muted)]" />}
                      {/* A WORD, NOT AN ICON. This row already carries two
                          glyphs whose meaning a seller learns by hovering;
                          «بعد الطلب» is a third meaning and the one most
                          easily mistaken for an ordinary bundle, because its
                          price is the lowest in the list and it is the only
                          row the page does not show. */}
                      {o.postOrderOffer && (
                        <span className="shrink-0 rounded-md bg-[var(--sys-primary-soft)] px-1.5 py-0.5 text-xs font-bold text-[var(--sys-primary)]">
                          بعد الطلب
                        </span>
                      )}
                    </p>
                    {/* Every run of digits + Latin currency is isolated, or
                        Arabic bidi reorders "100 USD · 50 USD/قطعة" into
                        something that reads like a different price. */}
                    <p className="text-xs text-[var(--sys-muted-foreground)]">
                      {o.quantity} قطعة
                      {o.freeQuantity > 0 && <span className="text-[var(--sys-primary)]"> + {o.freeQuantity} مجاناً</span>}
                      {' — '}
                      <bdi className="font-semibold tabular-nums">{money(o.sellingPrice)}</bdi>
                      {o.compareAtPrice && o.compareAtPrice > o.sellingPrice && (
                        <> <bdi className="text-[var(--sys-muted)] line-through">{money(o.compareAtPrice)}</bdi></>
                      )}
                      {units > 1 && (
                        <span className="text-[var(--sys-muted)]">
                          {' · '}
                          <bdi>{money(o.sellingPrice / units)}</bdi> للقطعة
                        </span>
                      )}
                    </p>
                    {/* AN OFFER SAVED ABOVE ITS LINE BEFORE THE RULE EXISTED. It stays on sale exactly as it is — the
                        owner decides each one — so the row says so, with the line the DOOR worked out. On a line of
                        its own, because the name beside the star already truncates on a phone. */}
                    {o.aboveBase && typeof o.maxPrice === 'number' && (
                      <p className="mt-1 text-xs leading-relaxed">
                        <span className="rounded-md bg-[var(--sys-destructive-soft)] px-1.5 py-0.5 font-bold text-[var(--sys-destructive)]">
                          أغلى من السعر الأساسي — الحدّ <bdi className="tabular-nums">{money(o.maxPrice)}</bdi>
                        </span>
                      </p>
                    )}
                  </div>

                  {canManage && (
                    <div className="ms-auto flex shrink-0 items-center gap-1">
                      {!o.isDefault && o.status === 'ACTIVE' && (
                        <button
                          aria-label="اجعله الافتراضي" title="اجعله الافتراضي"
                          onClick={() => patch(o.id, { isDefault: true })}
                          disabled={busy}
                          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface-strong)]"
                        >
                          <RiStarLine className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        title={inactive ? 'تفعيل' : 'إيقاف'}
                        onClick={() => patch(o.id, { status: inactive ? 'ACTIVE' : 'INACTIVE' })}
                        disabled={busy}
                        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface-strong)]"
                      >
                        <RiEyeOffLine className="w-4 h-4" />
                      </button>
                      <button
                        aria-label="تعديل" title="تعديل"
                        /*
                         * EDITING OPENS ON THE STORED ROW, including a
                         * stored `0` — which is a value, not a blank. The
                         * three numeric boxes hold characters, so the row's
                         * own figures are written in as digits.
                         */
                        onClick={() =>
                          setDraft({
                            ...o,
                            quantity: String(o.quantity),
                            freeQuantity: String(o.freeQuantity),
                            sellingPrice: String(o.sellingPrice),
                          })
                        }
                        disabled={busy}
                        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-foreground)] hover:bg-[var(--sys-surface-strong)]"
                      >
                        <RiPencilLine className="w-4 h-4" />
                      </button>
                      <button
                        aria-label="حذف" title="حذف"
                        onClick={() => remove(o.id, o.name)}
                        disabled={busy}
                        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-1.5 text-[var(--sys-destructive)] hover:bg-[var(--sys-destructive-soft)]"
                      >
                        <RiDeleteBinLine className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </Item>
              );
            })}
          </ul>
          </ReorderFrame>
        )}

        {draft && (
          <div className="space-y-2 rounded-lg border border-[var(--sys-primary)]/30 bg-[var(--sys-primary-soft)] p-3">
            <Input
              label="اسم العرض"
              name="name"
              placeholder="مثال: ثلاث قطع + واحدة هدية"
              value={draft.name ?? ''}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              {/* THE PLACEHOLDERS SAY «الافتراضي» AND NOT THE NUMBER.
                  Printing «1» or «0» here would put the schema's default
                  back into the browser, which is the duplication this
                  change removes. The operator sees the real figure the
                  moment the offer exists and they press تعديل. */}
              <Input
                label="الكمية"
                name="quantity"
                type="number" min="1" dir="ltr"
                placeholder="الافتراضي"
                title="اتركها فارغة ليأخذ العرض الجديد افتراضي النظام، أو لتبقى كمية عرضٍ قائم على ما هي عليه."
                value={draft.quantity}
                onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
              />
              <Input
                label="كمية مجانية"
                name="freeQuantity"
                type="number" min="0" dir="ltr"
                placeholder="الافتراضي"
                title="اتركها فارغة ليأخذ العرض الجديد افتراضي النظام (لا هدية)، أو لتبقى هديّة عرضٍ قائم على ما هي عليه. واكتب صفراً إن أردت إلغاء هديّةٍ مسجَّلة."
                value={draft.freeQuantity}
                onChange={(e) => setDraft({ ...draft, freeQuantity: e.target.value })}
              />
              {/* One cell of the grid: the box, and under it the line it must stay under. */}
              <div className="min-w-0">
                <Input
                  label={`السعر (${currency})`}
                  name="sellingPrice"
                  type="number" min="0" step="0.01" dir="ltr"
                  // The base price as a SUGGESTION the seller reads, not a
                  // value the form saves behind their back.
                  placeholder={basePrice > 0 ? `سعر القطعة ${basePrice}` : 'مطلوب'}
                  value={draft.sellingPrice}
                  onChange={(e) => setDraft({ ...draft, sellingPrice: e.target.value })}
                />
                <CeilingHint
                  basePrice={basePrice}
                  pieces={typedFigure(draft.quantity)}
                  currency={currency}
                  unit={unit}
                  canChangePrice={canChangePrice}
                />
              </div>
              <Input
                label="السعر قبل الخصم"
                type="number" min="0" step="0.01" dir="ltr"
                placeholder="اختياري"
                value={draft.compareAtPrice ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, compareAtPrice: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
              <Input
                label="ينتهي العرض"
                type="datetime-local" dir="ltr"
                placeholder="بلا نهاية"
                value={draft.endsAt ? draft.endsAt.slice(0, 16) : ''}
                onChange={(e) =>
                  setDraft({ ...draft, endsAt: e.target.value === '' ? null : new Date(e.target.value).toISOString() })
                }
              />
            </div>
            <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              «السعر» هو ما يدفعه الزبون فعلاً. «السعر قبل الخصم» للعرض فقط — لا يدخل في أي
              حساب مال، ولا يظهر مشطوباً إلا بقدر ما تسنده طلباتٌ مُسلَّمة فعلاً بهذا السعر
              من قبل: فإن لم يُبَع بهذا السعر خمس مرات على الأقل، لا يظهر شيء. ورقمٌ أعلى مما
              تسنده الطلبات يُعرض بما تسنده، لا بما كُتب.
            </p>
            {/* The one sentence that makes an empty box mean something.
                Before it, an empty box and a typed zero were the same
                request — and the price box could not say «مطلوب» at all. */}
            <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              خانة <b>فارغة</b> تعني «لم تُحدَّد»: العرض القائم يبقى على ما هو عليه، والعرض الجديد يأخذ
              افتراضي النظام. و<b>صفر مكتوب</b> يُحفَظ صفراً ويُحاسَب صفراً. أمّا «السعر» فلا افتراضيَّ
              له: عرضٌ جديد بلا سعر <b>مرفوض</b> والموقع يقول لك ذلك عند الحفظ، وتفريغُ سعرِ عرضٍ قائم
              يتركه على سعره المحفوظ — فالتخفيض إلى الصفر يُكتَب صفراً ولا يُفهَم من خانةٍ فارغة.
            </p>
            <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              «ينتهي العرض» اختياري. حين تضعه، يتوقّف العرض عن البيع في تلك اللحظة — والعدّاد
              الذي يراه الزبون يقرأ الوقت نفسه، فلا يصل إلى الصفر بينما العرض ما زال قائماً.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--sys-foreground)]">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[var(--sys-primary)]"
                  checked={!!draft.isDefault}
                  onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
                />
                العرض الافتراضي
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--sys-foreground)]">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[var(--sys-primary)]"
                  checked={draft.deliveryIncluded !== false}
                  onChange={(e) => setDraft({ ...draft, deliveryIncluded: e.target.checked })}
                />
                السعر شامل التوصيل
              </label>
              {/*
                «العرض بعد الطلب» — the one bundle the thank-you screen may
                show, and the only one withheld from the page itself.

                It sits beside the other two because it IS the same kind of
                decision about the same bundle, and putting it on a screen of
                its own would have been a second place a price lives — which
                is the defect this whole file exists to have fixed.
              */}
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--sys-foreground)]">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[var(--sys-primary)]"
                  checked={!!draft.postOrderOffer}
                  onChange={(e) => setDraft({ ...draft, postOrderOffer: e.target.checked })}
                />
                العرض بعد الطلب
              </label>
            </div>
            {/*
              THE «NO» IS HEARD — ON THE SALES PAGE (the owner, 1/11: «من اللاندنج … أحدد إذا شامل ولا لأ بظبط»). An unticked box used to
              be overridden whenever the store's «السعر المُعلن يشمل التوصيل» was on. On the sales page it is not any more; the screen says
              exactly where, rather than leaving it to be found in an order total. Not said for the bundle shown after the order: its
              paragraph below says the flag has no effect there.
            */}
            {draft.deliveryIncluded === false && !draft.postOrderOffer && (
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                «السعر شامل التوصيل» غير مؤشَّر: لما الزبون يطلب من صفحة البيع وكل عروض سلّته غير مؤشَّرة، تُضاف أجرة التوصيل عليه
                <b> حتى لو</b> كان إعداد المتجر «السعر المُعلن يشمل التوصيل» مفعَّلاً. وسلّة فيها عرض مؤشَّر تُحسب شاملة، وأي منتج
                بلا عرض بيتبع إعداد المتجر.
              </p>
            )}
            {/*
              THE RULES OF THIS BOX, ON THE SCREEN AND NOT ONLY IN THE CODE.

              Each sentence is a server rule the seller would otherwise meet
              as a refusal: the bundle disappears from the page, only one
              product may carry it, the window is a company setting, gift
              units are refused, and the delivery flag has no effect on an
              order whose fee policy was already decided.
            */}
            {draft.postOrderOffer && (
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                «العرض بعد الطلب» يظهر على شاشة الشكر وحده — بعد أن يصير الطلب، لا قبله: هذا
                العرض <b>لا يظهر</b> في صفحة الهبوط ولا في المتجر ولا يمكن للزبون اختياره عند
                الطلب. <b>عرضٌ واحد</b> لكل منتج: تأشيره هنا يرفع التأشير عن أيّ عرضٍ آخر لنفس
                المنتج. الزبون يقدر يزيده <b>مرة واحدة</b>، وما دام الطلب جديداً لم يتواصل معه
                أحدٌ بعد، وخلال مهلةٍ من لحظة الطلب (15 دقيقة افتراضاً — تُضبَط من إعدادات النظام). ولا
                يقبل <b>كمية مجانية</b>، لأنّ الزيادة تُسجَّل كسطرٍ بسعرٍ وكمية لا مكان للهدية
                فيه. و«السعر شامل التوصيل» لا أثر له هنا: أجرة التوصيل حُسِمت مع الطلب الأول
                ولا تتغيّر بزيادةٍ بعده.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDraft(null)}>إلغاء</Button>
              <Button size="sm" onClick={save} disabled={busy || !draft.name?.trim()}>
                {busy ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiAddCircleLine className="w-4 h-4" />} حفظ العرض
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ───────────────────────────── the line under the price box ───────────────────────────── */

/**
 * «العرض ما بصير يكون اكثر من السعر الاساسي» — SAID UNDER THE BOX, BEFORE THE DOOR HAS TO SAY IT.
 *
 * Worked out with `offerCeiling`, the function the door refuses with, from the quantity being typed — so the figure
 * here is the door's figure and not a second copy of the rule. Three sentences for three cases:
 *
 *   · a quantity typed → the line, and the arithmetic that makes it, so the seller can check it;
 *   · the quantity box empty → the rule with no number. An empty box is the door's default to fill, and printing
 *     «1» here would put that default back in the browser, which this form refuses to do (see its placeholders);
 *   · no base price yet → no line at all, and the door that writes one is named only for somebody who holds
 *     `products.change_price` — for anybody else «تعديل المنتج» would end in a refusal.
 */
function CeilingHint({
  basePrice, pieces, currency, unit, canChangePrice,
}: {
  basePrice: number;
  /** What the quantity box holds, as a number — or nothing. */
  pieces: number | undefined;
  currency: string;
  unit: number;
  canChangePrice: boolean;
}) {
  const look = 'mt-1 text-xs leading-relaxed text-[var(--sys-muted-foreground)]';
  if (!(basePrice > 0)) {
    return (
      <p className={look}>
        ما في سعر أساسي لهذا المنتج لسّا، فما في حدّ أعلى لسعر العرض لحدّ ما ينكتب السعر الأساسي.
        {canChangePrice ? ' اكتبه من «تعديل المنتج» فوق.' : ' بيكتبه اللي معه صلاحية «تغيير أسعار المنتجات».'}
      </p>
    );
  }
  const whole = pieces !== undefined && Number.isInteger(pieces) && pieces >= 1 ? pieces : null;
  const line = whole === null ? null : offerCeiling(basePrice, whole, unit);
  if (whole === null || line === null) {
    return (
      <p className={look}>سعر العرض ما بيزيد عن السعر الأساسي × عدد القطع المدفوعة. القطع المجانية ما بتنحسب.</p>
    );
  }
  return (
    <p className={look}>
      أعلى سعر لهذا العرض: <bdi className="font-semibold tabular-nums">{moneyText(line, currency, unit)}</bdi> —{' '}
      <bdi>{whole}</bdi> × السعر الأساسي <bdi>{basePrice}</bdi>. القطع المجانية ما بتنحسب.
    </p>
  );
}

/* ───────────────────────────── the order of the list, by hand ───────────────────────────── */

/** What a screen reader is told before it picks an offer up. */
const INSTRUCTIONS = {
  draggable: 'لتغيير ترتيب هذا العرض: اضغط مسافة لتمسكه، ثم السهم لأعلى أو لأسفل، ثم مسافة لتفلته. اضغط Esc للإلغاء.',
};

/**
 * THE LIST CAN BE DRAGGED — AND THE ARROWS ARE STILL THERE.
 *
 * The owner asked (21/10) for the offers to be reordered by drag and drop. The pattern is the one `MenuOrderCard` already
 * answers for the menu, with the same two promises:
 *
 *   • the engine is `@dnd-kit`: a pointer sensor that needs six pixels of travel before a press is a drag (a tap on the
 *     grip is not a move), and a keyboard sensor with Arabic announcements — Space to pick an offer up, ↑ ↓ to move it,
 *     Space to put it down, Esc to cancel;
 *   • the drag starts ONLY from the grip, and the grip alone carries `touch-action: none` — a thumb on the rest of the row
 *     scrolls the page exactly as before, so the scroll is never fought, only the grip is.
 *
 * The arrows stay: a drag is a pointer's surface, and the arrows are what a thumb, a keyboard and a screen reader reach on the
 * first day. Both go through `moveOffer`, so they cannot disagree about what a move means.
 *
 * Without `offers.manage` (`enabled` false) there is no grip, no arrows, and not even a drag context: a list that cannot
 * be changed does not offer to change.
 */
function ReorderFrame({
  enabled, offers, onMove, children,
}: {
  enabled: boolean;
  offers: Offer[];
  onMove: (m: OfferMove) => void;
  children: React.ReactNode;
}) {
  // Hooks first, the early return after: the order of hooks must not depend on a permission.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  if (!enabled) return <>{children}</>;

  const nameOf = (id: string | number) => offers.find((o) => o.id === String(id))?.name ?? '';
  const announcements: Announcements = {
    onDragStart: ({ active }) => `أمسكتَ «${nameOf(active.id)}».`,
    onDragOver: ({ active, over }) =>
      over && over.id !== active.id ? `«${nameOf(active.id)}» فوق «${nameOf(over.id)}».` : undefined,
    onDragEnd: ({ active, over }) =>
      over && over.id !== active.id
        ? `أُفلت «${nameOf(active.id)}» مكان «${nameOf(over.id)}».`
        : `أُفلت «${nameOf(active.id)}» في مكانه.`,
    onDragCancel: ({ active }) => `أُلغي تحريك «${nameOf(active.id)}».`,
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      // The vertical axis is locked and the row kept inside its list, so a hand that drifts sideways does not lose the row.
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={(end) => {
        const m = moveAfterDrag(offers, end);
        if (m) onMove(m);
      }}
      accessibility={{ announcements, screenReaderInstructions: INSTRUCTIONS }}
    >
      <SortableContext items={offers.map((o) => o.id)} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/**
 * The grip is made by the row's own `useSortable` (it needs the same hook instance as the row's node) and is DRAWN where the
 * row's markup says `<GripSlot />` — handed down through context so the row's markup stays what it was.
 */
const GripContext = React.createContext<React.ReactNode>(null);
function GripSlot() {
  return <>{React.useContext(GripContext)}</>;
}

interface RowProps {
  id: string;
  name: string;
  disabled: boolean;
  className: string;
  children: React.ReactNode;
}

/** A row nobody may reorder: the old `<li>`, nothing added. */
function PlainLi({ className, children }: RowProps) {
  return <li className={className}>{children}</li>;
}

/**
 * ONE ROW THAT CAN BE CARRIED.
 *
 * The grip is the ONLY thing that starts a drag (`useSortable`'s listeners are on it and nowhere else) and it alone refuses the
 * browser's scroll gesture. The row's look while it is carried is INLINE — lifted, a little transparent, above its neighbours —
 * because the stylesheet is capped to the byte and a drag state is not worth a utility class nothing else uses.
 */
function SortableLi({ id, name, disabled, className, children }: RowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
    // The library announces the grip as «sortable» unless told otherwise — one English word in an Arabic sentence.
    attributes: { roleDescription: 'مقبض ترتيب' },
  });
  const grip = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`اسحب «${name}» لتغيير ترتيبه`}
      title="اسحب لتغيير الترتيب"
      style={{ touchAction: 'none', cursor: isDragging ? 'grabbing' : 'grab' }}
      className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-primary-soft)] hover:text-[var(--sys-primary)]"
    >
      <RiDraggable className="w-4 h-4" />
    </button>
  );
  return (
    <li
      ref={setNodeRef}
      className={className}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { position: 'relative', zIndex: 1, opacity: 0.85, boxShadow: 'var(--sys-shadow-overlay)' } : null),
      }}
    >
      <GripContext.Provider value={grip}>{children}</GripContext.Provider>
    </li>
  );
}
