'use client';

import React from 'react';
import { onTheWire, typedFigure } from '@/lib/typed-box';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { amount, type Currency } from '@/lib/format';
import { atBasePrice } from '@/lib/line-price';
import { RiAddCircleLine, RiDeleteBinLine, RiSubtractLine } from '@remixicon/react';

/**
 * The products on one order.
 *
 * Shared by the quick-create form and the order screen so the two can never
 * disagree about what a line is or how its total is read. Neither of them
 * computes the order's money: they collect lines, and the server's single
 * COD function decides what the customer owes.
 *
 * A line's price box holds the TOTAL for that line's quantity, which is the
 * meaning the API has always given it — showing a per-unit price here and a
 * line total there would be two numbers for one field.
 */

/**
 * THE BOX FOLLOWS THE CATALOGUE UNTIL A PERSON WRITES IN IT.
 *
 * It opened at the base price of ONE piece and never moved: a product at 25,
 * changed to two pieces, still said 25, and the order was saved at 25. Now a
 * line that nobody has written in follows its quantity — the offer's price
 * while an offer is chosen, otherwise the base price for the paid quantity.
 * A figure a person typed is theirs, and so is a figure an order was saved
 * with: a quantity change never rewrites either, and the line under the box
 * says what the base price would be, with a button to take it.
 *
 * The multiplication is `atBasePrice` in `src/lib/line-price.ts`, rounded to
 * the currency's minor unit the way `computeCod` rounds a line, and held
 * equal to it by a test. It fills a box; the door still takes what the box
 * sends, and the COD is still the server's.
 */

/**
 * WHAT A PRICE BOX PUTS ON THE WIRE: ITS CHARACTERS, OR NOTHING AT ALL.
 *
 * The same reader `CourierFees.tsx` got in `17cbe93` and
 * `ManufacturingScreen.tsx` in `509306a`, now on the box where the number
 * is what a customer is charged.
 *
 * `price` was `Number(e.target.value) || 0`. `Number('')` is `0`, so
 * CLEARING THE BOX MADE THE LINE FREE — and it was worse than a wrong
 * figure, because the component wrote that `0` back into the box: clearing
 * «14» and typing «20» gave «120», since the box had redrawn as `0` before
 * the first keystroke landed. `0aea050` fixed exactly this for
 * `basePrice` in `ProductsScreen`; this is the same defect on the order
 * door.
 *
 * `undefined` is the answer for an empty box, and `JSON.stringify` DROPS an
 * `undefined` property — so the field is ABSENT on the wire and the door
 * decides. Both order doors declare the same rule over the same column:
 * `OrderItem.unitPrice` is `Decimal(12,2) NOT NULL` with NO DEFAULT, so
 * «nothing» is not a value the column can hold and both schemas make it
 * required — `items[].unitPrice: amount(100000)` on `POST /api/orders`,
 * `z.coerce.number().min(0)` on `PATCH /api/orders/[id]`. Absent is
 * therefore a 400 that NAMES the field («سعر الوحدة مطلوب»), which is the
 * one thing a silent zero could never be.
 *
 * AND IT IS THE CHARACTERS, NOT A NUMBER. `''` must never be sent: the
 * PATCH door reads with `z.coerce.number()` and `Number('')` is `0`, which
 * is the free line again, one layer down. A non-empty box goes as typed, so
 * the door's reader — not this component — decides what `'2,500'` means.
 * `509306a` measured that a `type="number"` box never lets a comma through
 * (the browser drops it and empties unparseable input), so the reachable
 * case is the empty box; the characters are sent anyway, because a browser
 * that pre-repairs a number is a second rule for it.
 */

/** The figure a price box holds, for the line's own echo. Never a zero it invented. */

/**
 * «قيمة البضاعة» — AN INPUT ECHO, IN ONE PLACE, AND THE JUDGEMENT IS
 * RECORDED ON PURPOSE.
 *
 * `the-frontend-invariants.test.ts` names this very sum as case 1 of its
 * three legitimate kinds of arithmetic: the total of prices a moderator is
 * typing into a form FOR AN ORDER THAT DOES NOT EXIST YET. There is no
 * server figure to render because there is nothing on the server, so it is
 * not a second copy of anything — and it is NOT the COD: no delivery fee,
 * no discount, no `priceIncludesDelivery` branch. The header above says the
 * COD is the server's, and `computeCod` remains the only thing that
 * computes it.
 *
 * It lives here and is exported because `CreateOrderModal` had the SAME
 * reduce written out again for the figure on its submit button — two copies
 * of one echo, each free to read an empty box differently.
 *
 * `undefined` RATHER THAN `0` WHEN NOTHING IS WRITTEN. Both copies were
 * `sum + (Number(l.price) || 0)`, which printed a confident «0.00 JOD»
 * over a form with every price box empty — the figure the operator then
 * believes. A partial form shows the sum of what IS written; an untouched
 * one shows a dash.
 */
export function goodsTotal(lines: DraftLine[]): number | undefined {
  const figures = lines
    .map((l) => typedFigure(l.price))
    .filter((p): p is number => p !== undefined);
  return figures.length === 0 ? undefined : figures.reduce((sum, p) => sum + p, 0);
}

export interface DraftLine {
  key: string;
  productId: string;
  offerId: string | null;
  quantity: number;
  /**
   * THE CHARACTERS IN THE LINE-TOTAL BOX, or `undefined` for an empty one.
   * Total for this line's quantity, not per unit.
   *
   * A string rather than a number so that «I have not written a price» is
   * sayable at all, and so the characters reach the door's own reader. Every
   * caller already sends it straight through as `unitPrice`, so `undefined`
   * leaves the key off the request without a caller having to know why.
   */
  price: string | undefined;
  /**
   * WHO WROTE THE FIGURE IN THE BOX, which decides whether a quantity change
   * may rewrite it.
   *
   *   · `follows` — the catalogue did (an offer's price, or the base price
   *     for the paid quantity). A quantity change computes it again.
   *   · `typed` — a person did. A quantity change leaves it alone.
   *   · `saved` — it is the total a stored order was saved with, agreed with
   *     the customer. Never rewritten; its first quantity change makes it
   *     `typed`, so the line under the box offers the base price.
   *
   * Never sent: both hosts build the request from named fields.
   */
  pricing: LinePricing;
}

export type LinePricing = 'follows' | 'typed' | 'saved';

interface ProductOption {
  id: string;
  name: string;
  image?: string | null;
  basePrice?: number;
  /*
   * `freeQuantity` is the bundle's gift. It is carried here so the agent
   * can SEE what «٣+١» promises before she sends it — the door writes it
   * onto the line either way, from the offer id.
   */
  offers?: { id: string; name: string; quantity: number; freeQuantity?: number; sellingPrice: number }[];
}

/**
 * A LINE'S OPENING PRICE IS A REAL PRICE OR AN EMPTY BOX — NEVER A `0`.
 *
 * `offer?.sellingPrice ?? product?.basePrice ?? 0` ended in an invented
 * zero, and that last branch is the one `newLine()` with no product takes:
 * both the dialog's first line and every «أضف منتجاً آخر» opened holding a
 * price of nothing-at-all, drawn as `0`. Pressing حفظ on it sent a free
 * line — a real order line at no charge, which the door is obliged to
 * accept because `min(0)` and a giveaway line is legitimate.
 *
 * So the price is the offer's, or the product's own base price for the paid
 * quantity, or the box is EMPTY. There is no third number in this file: the
 * only figures it can put in a box came from the catalogue.
 *
 * A BASE PRICE OF 0 IS AN EMPTY BOX TOO. It is the column's default and
 * means «not set yet», and it opened the line at `0` — the same free line,
 * reached through the catalogue instead of through a missing product. And
 * without the currency's minor unit there is nothing to round to, so the box
 * waits empty rather than guess one (`atBasePrice`).
 */
export function newLine(product?: ProductOption, minorUnit?: number | null): DraftLine {
  return { key: Math.random().toString(36).slice(2), ...fromCatalogue(product?.id ?? '', product, minorUnit) };
}

/** A figure as the characters the box will hold, or an empty box. */
function inTheBox(figure: number | undefined): string | undefined {
  return figure === undefined ? undefined : String(figure);
}

/** A line set from the catalogue: the product's first offer, or its base price for one piece. */
function fromCatalogue(
  productId: string,
  product: ProductOption | undefined,
  minorUnit: number | null | undefined
): Omit<DraftLine, 'key'> {
  const offer = product?.offers?.[0];
  if (offer) {
    return { productId, offerId: offer.id, quantity: offer.quantity, price: String(offer.sellingPrice), pricing: 'follows' };
  }
  return {
    productId,
    offerId: null,
    quantity: 1,
    price: inTheBox(atBasePrice(product?.basePrice, 1, minorUnit)),
    pricing: 'follows',
  };
}

/*
 * WHAT EACH CONTROL DOES TO A LINE — written once, as plain functions, so a
 * test can hold every rule without drawing the form.
 *
 * None of them multiplies anything. Every figure they put in a box is the
 * offer's own price or `atBasePrice`, which rounds the way `computeCod`
 * rounds a line. `quantity` is always the PAID quantity: a gift is the
 * door's, worked out from the offer (`offer-gift.ts`), and is never priced.
 */

/**
 * − / + / the quantity box. The offer goes, as it always has: a bundle of
 * three is not a bundle once it is four. A line that follows takes the base
 * price for the new quantity; a typed or saved figure is never rewritten,
 * and a saved one becomes typed, so the line under the box speaks.
 */
export function withQuantity(
  line: DraftLine,
  quantity: number,
  product: ProductOption | undefined,
  minorUnit: number | null | undefined
): DraftLine {
  if (quantity === line.quantity) return line;
  if (line.pricing === 'follows') {
    return { ...line, quantity, offerId: null, price: inTheBox(atBasePrice(product?.basePrice, quantity, minorUnit)) };
  }
  return { ...line, quantity, offerId: null, pricing: 'typed' };
}

/** The price box itself: what was typed, as typed — and from now on it is the person's. */
export function withTypedPrice(line: DraftLine, raw: string): DraftLine {
  return { ...line, price: onTheWire(raw), offerId: null, pricing: 'typed' };
}

/**
 * Picking a product adopts its first offer — that is the offer's job — or
 * its base price for one piece, and the line follows again. Even after
 * typing: choosing a product is choosing its price, in plain view.
 */
export function withProduct(
  line: DraftLine,
  productId: string,
  product: ProductOption | undefined,
  minorUnit: number | null | undefined
): DraftLine {
  return { ...line, ...fromCatalogue(productId, product, minorUnit) };
}

/**
 * An offer fixes the quantity and the price of its line, and the line
 * follows it. «بلا عرض» lets the offer go: a following line then takes the
 * base price for the quantity it has, so «3 بـ60» does not stay 60.
 */
export function withOffer(
  line: DraftLine,
  offerId: string,
  product: ProductOption | undefined,
  minorUnit: number | null | undefined
): DraftLine {
  const offer = product?.offers?.find((o) => o.id === offerId);
  if (offer) {
    return { ...line, offerId: offer.id, quantity: offer.quantity, price: String(offer.sellingPrice), pricing: 'follows' };
  }
  if (line.pricing !== 'follows') return { ...line, offerId: null };
  return { ...line, offerId: null, price: inTheBox(atBasePrice(product?.basePrice, line.quantity, minorUnit)) };
}

/** «رجّعه للسعر الأساسي»: the base price for this quantity, and the line follows again. */
export function backToBase(
  line: DraftLine,
  product: ProductOption | undefined,
  minorUnit: number | null | undefined
): DraftLine {
  const figure = atBasePrice(product?.basePrice, line.quantity, minorUnit);
  return figure === undefined ? line : { ...line, price: String(figure), offerId: null, pricing: 'follows' };
}

/**
 * The figure the line under the box names — only on a typed line, only when
 * the base price is known, and only when it differs from what the box holds.
 * A saved line opens silent even when its stored total differs (a discount
 * share, an old price): that total was agreed, and nobody has touched it.
 */
export function baseHint(
  line: DraftLine,
  product: ProductOption | undefined,
  minorUnit: number | null | undefined
): number | undefined {
  if (line.pricing !== 'typed') return undefined;
  const figure = atBasePrice(product?.basePrice, line.quantity, minorUnit);
  return figure === undefined || typedFigure(line.price) === figure ? undefined : figure;
}

export function ProductLinesEditor({
  lines,
  products,
  currency,
  onChange,
  disabled,
}: {
  lines: DraftLine[];
  products: ProductOption[];
  currency: Currency | null;
  onChange: (lines: DraftLine[]) => void;
  disabled?: boolean;
}) {
  const productOf = (id: string) => products.find((p) => p.id === id);
  /** This store's decimals, or nothing while they load — never an assumed two. */
  const minorUnit = currency?.minorUnit;

  function update(key: string, change: (line: DraftLine) => DraftLine) {
    onChange(lines.map((l) => (l.key === key ? change(l) : l)));
  }

  /** Picking a product adopts its first offer — that is the offer's job. */
  function pickProduct(key: string, productId: string) {
    // Same rule as `newLine`: a catalogue figure, or an empty box. The
    // trailing `?? 0` here put a free line under a product that has neither
    // an offer nor a base price.
    update(key, (l) => withProduct(l, productId, productOf(productId), minorUnit));
  }

  /** An offer fixes the quantity and the price of its line. */
  function pickOffer(key: string, offerId: string) {
    update(key, (l) => withOffer(l, offerId, productOf(l.productId), minorUnit));
  }

  const total = goodsTotal(lines);
  const inputClass =
    'w-full h-10 px-2 rounded-lg border border-[var(--sys-border)] text-sm focus:outline-none focus:border-[var(--sys-primary)] disabled:bg-[var(--sys-surface)]';

  return (
    <div className="space-y-2">
      {lines.map((line) => {
        const product = productOf(line.productId);
        const offers = product?.offers ?? [];
        const lockedByOffer = !!line.offerId;
        /** The figure this line's box holds, or nothing — never an invented 0. */
        const lineFigure = typedFigure(line.price);
        /** The base price for this quantity, named only when a person's figure differs from it. */
        const hint = baseHint(line, product, minorUnit);

        return (
          <div key={line.key} className="rounded-lg border border-[var(--sys-border)] p-2.5 space-y-2">
            <div className="flex items-center gap-2">
              {/* SEARCHABLE, because a native dropdown of a hundred
                  products is a scroll, not a choice. Reported from two
                  screens — the new order and the return — and both come
                  through this one editor. See ui/ProductPicker. */}
              <ProductPicker
                products={products}
                value={line.productId}
                onChange={(id) => pickProduct(line.key, id)}
                disabled={disabled}
                className="flex-1"
              />
              {lines.length > 1 && (
                <button
                  type="button"
                  onClick={() => onChange(lines.filter((l) => l.key !== line.key))}
                  disabled={disabled}
                  aria-label="احذف هذا المنتج من الطلب" title="احذف هذا المنتج من الطلب"
                  className="h-11 md:h-9 w-9 rounded-lg bg-[var(--sys-destructive)] text-[var(--sys-primary-foreground)] shrink-0 disabled:opacity-40"
                >
                  <RiDeleteBinLine className="w-4 h-4 mx-auto" />
                </button>
              )}
            </div>

            {offers.length > 0 && (
              <select
                value={line.offerId ?? ''}
                onChange={(e) => pickOffer(line.key, e.target.value)}
                disabled={disabled}
                className={inputClass}
              >
                <option value="">بلا عرض — سعر مباشر</option>
                {offers.map((o) => (
                  <option key={o.id} value={o.id}>
                    {/* The gift is named here because it is the part that
                        leaves the shelf without appearing in the price —
                        «٣+١» has to read as four units before it is sent,
                        not as a surprise in the warehouse. */}
                    {o.name} ({o.quantity}
                    {o.freeQuantity ? ` + ${o.freeQuantity} هدية` : ''} ×{' '}
                    {amount(o.sellingPrice, currency)})
                  </option>
                ))}
              </select>
            )}

            {/* THE PRICE BOX KEEPS ITS WIDTH ON A PHONE. One unwrapped row left it
                what the quantity stepper and the line figure did not take —
                about forty pixels at 360, a box too small to read the figure
                being edited. It wraps instead: the stepper on one line, the
                price box and the line figure on the next. */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => update(line.key, (l) => withQuantity(l, Math.max(1, l.quantity - 1), product, minorUnit))}
                  aria-label="أنقص الكمية"
                  title="أنقص الكمية"
                  disabled={disabled || lockedByOffer}
                  className="h-11 md:h-9 w-9 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] disabled:opacity-40"
                >
                  <RiSubtractLine className="w-4 h-4 mx-auto" />
                </button>
                <input
                  type="number" min={1} dir="ltr"
                  value={line.quantity}
                  onChange={(e) =>
                    update(line.key, (l) => withQuantity(l, Math.max(1, Number(e.target.value) || 1), product, minorUnit))
                  }
                  disabled={disabled || lockedByOffer}
                  className={`${inputClass} w-16 text-center`}
                />
                <button
                  type="button"
                  onClick={() => update(line.key, (l) => withQuantity(l, l.quantity + 1, product, minorUnit))}
                  aria-label="زد الكمية"
                  title="زد الكمية"
                  disabled={disabled || lockedByOffer}
                  className="h-11 md:h-9 w-9 rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted-foreground)] disabled:opacity-40"
                >
                  <RiAddCircleLine className="w-4 h-4 mx-auto" />
                </button>
              </div>

              <label className="flex-1 min-w-[150px]">
                <input
                  type="number" min={0} step="0.01" dir="ltr"
                  // THE BOX HOLDS WHAT WAS TYPED, including nothing at all.
                  // `value={line.price}` over a numeric state is what redrew
                  // a cleared box as `0`, so «14» cleared and retyped as
                  // «20» came out «120».
                  value={line.price ?? ''}
                  onChange={(e) => update(line.key, (l) => withTypedPrice(l, e.target.value))}
                  disabled={disabled || lockedByOffer}
                  placeholder="سعر السطر"
                  className={inputClass}
                />
              </label>

              <span className="text-sm font-bold text-[var(--sys-heading)] tabular-nums shrink-0 w-24 text-end" dir="ltr">
                {/* An unwritten price is a dash, not «0.00». A confident zero
                    beside an empty box is the figure the operator believes. */}
                {lineFigure === undefined ? '—' : amount(lineFigure, currency)}
              </span>
            </div>

            {hint !== undefined && (
              <div className="flex flex-wrap items-center gap-2">
                {/* A person's figure is never rewritten behind their back, so
                    the base price is said beside it, one press away. */}
                <p className="text-xs text-[var(--sys-muted)]">
                  مكتوب بإيدك — بالسعر الأساسي: <span dir="ltr">{amount(hint, currency)}</span>
                </p>
                <button
                  type="button"
                  onClick={() => update(line.key, (l) => backToBase(l, product, minorUnit))}
                  disabled={disabled}
                  className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-xs font-medium text-[var(--sys-muted-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)] disabled:opacity-40"
                >
                  رجّعه للسعر الأساسي
                </button>
              </div>
            )}

            {lockedByOffer && (
              <p className="text-xs text-[var(--sys-muted)]">
                الكمية والسعر من العرض — غيّرهما بإلغاء العرض من القائمة أعلاه.
              </p>
            )}
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={() => onChange([...lines, newLine()])}
          disabled={disabled}
          className="min-h-11 md:min-h-0 inline-flex items-center text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-[var(--sys-primary)] text-[var(--sys-primary)] inline-flex items-center gap-1.5 disabled:opacity-40"
        >
          <RiAddCircleLine className="w-4 h-4" />
          أضف منتجاً آخر
        </button>
        <span className="text-xs text-[var(--sys-muted-foreground)]">
          قيمة البضاعة:{' '}
          <span className="font-bold text-[var(--sys-heading)] tabular-nums" dir="ltr">
            {total === undefined ? '—' : amount(total, currency)}
          </span>
        </span>
      </div>
    </div>
  );
}
