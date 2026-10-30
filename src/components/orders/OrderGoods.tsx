import React from 'react';

/**
 * WHAT IS IN THE ORDER, IN ONE SHORT PLACE — FOR THE DESK'S LISTS.
 *
 * The agent's «أكّدتها» and «المؤجلة» lists showed a number, a name, a phone and a
 * sum. A row that says «٤٥ دينار» and not what the 45 buys is a row she has to
 * open to read. These three pieces put the goods, the place and the notes on the
 * row itself — display only: nothing here adds, prices or decides anything.
 * The sum stays the server's (`totalAmount`), exactly as the row already carried it.
 *
 * The lists are compact on purpose: a handful of lines and then «+N أخرى». The
 * agent's working card (للشغل · لا يرد) lists every line, because the goods she
 * reads out on the phone must never be cut.
 */

export interface GoodsLine {
  id: string;
  productName: string;
  quantity: number;
  freeQuantity?: number;
}

export interface GoodsAddOn {
  id: string;
  productName: string;
  quantity: number;
}

/** How many lines a compact cell shows before it says how many more there are. */
export const GOODS_SHOWN = 3;

export interface GoodsText {
  key: string;
  /** The line as the reader sees it. */
  text: string;
  /** What the customer added after ordering, not a line of the order. */
  addOn: boolean;
}

/**
 * The lines to draw and the number left out — pure, so the cut is testable without a screen.
 *
 * Lines first, add-ons after them; the cut applies to the whole, so ten lines and an add-on say
 * «+8 أخرى» and not a tenth line with an add-on hiding behind it. A gift is written beside its line
 * («+1 مجاني») and never as a line of its own: the line already is that product.
 * An order that came with no lines (an old import) is an empty list, not an error.
 */
export function goodsLines(
  items: ReadonlyArray<GoodsLine> | null | undefined,
  addOns: ReadonlyArray<GoodsAddOn> | null | undefined,
  max: number = GOODS_SHOWN
): { shown: GoodsText[]; more: number } {
  const all: GoodsText[] = [
    ...(items ?? []).map((it) => ({
      key: `i-${it.id}`,
      text: `${it.productName} × ${it.quantity}${it.freeQuantity && it.freeQuantity > 0 ? ` (+${it.freeQuantity} مجاني)` : ''}`,
      addOn: false,
    })),
    ...(addOns ?? []).map((a) => ({ key: `a-${a.id}`, text: `${a.productName} × ${a.quantity}`, addOn: true })),
  ];
  const cap = Math.max(1, max);
  return { shown: all.slice(0, cap), more: Math.max(0, all.length - cap) };
}

export function OrderGoods({
  items,
  addOns,
  max = GOODS_SHOWN,
}: {
  items?: ReadonlyArray<GoodsLine> | null;
  addOns?: ReadonlyArray<GoodsAddOn> | null;
  max?: number;
}) {
  const { shown, more } = goodsLines(items, addOns, max);
  if (shown.length === 0) return <span className="text-xs text-[var(--sys-muted)]">—</span>;
  return (
    <ul className="text-xs space-y-0.5 break-words">
      {shown.map((l) => (
        <li key={l.key} className="line-clamp-2">
          {l.addOn && <span className="text-[var(--sys-warning)]">إضافة: </span>}
          {l.text}
        </li>
      ))}
      {more > 0 && <li className="text-[var(--sys-muted-foreground)]">+{more} أخرى</li>}
    </ul>
  );
}

/**
 * The governorate, the city and the street the parcel goes to.
 *
 * The street THIS order goes to wins over the customer's own — the same rule the working card
 * follows. The governorate is left out when it only repeats the city's name. Nothing known →
 * a dash, never an empty cell that reads as «not loaded».
 */
export function OrderPlace({
  region,
  city,
  address,
}: {
  region?: string | null;
  city?: string | null;
  address?: string | null;
}) {
  const where = [region, city].map((v) => v?.trim()).filter((v, i, all): v is string => !!v && all.indexOf(v) === i);
  const street = address?.trim();
  if (where.length === 0 && !street) return <span className="text-xs text-[var(--sys-muted)]">—</span>;
  return (
    <div className="text-xs break-words max-w-xs">
      {where.length > 0 && <p dir="auto">{where.join(' · ')}</p>}
      {street && (
        <p dir="auto" className="line-clamp-2 text-[var(--sys-muted-foreground)]">
          {street}
        </p>
      )}
    </div>
  );
}

/** The customer's note and the team's, one line each. Nothing to say draws nothing. */
export function OrderNotes({ customer, internal }: { customer?: string | null; internal?: string | null }) {
  const c = customer?.trim();
  const i = internal?.trim();
  if (!c && !i) return null;
  return (
    <div className="text-xs break-words text-[var(--sys-muted-foreground)]">
      {c && (
        <p dir="auto" className="line-clamp-1" title={c}>
          ملاحظة الزبون: {c}
        </p>
      )}
      {i && (
        <p dir="auto" className="line-clamp-1" title={i}>
          ملاحظة داخلية: {i}
        </p>
      )}
    </div>
  );
}
