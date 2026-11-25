'use client';

import React, { useCallback, useRef, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';

/**
 * THE COMBINATION GRID — the boxes of a product with combinations (size/colour) inside the stock documents' forms: the
 * placement sheet, the transfer (send and receipt) and the exit request (the warehouse plan, request W8c; the rules are
 * W8b's, `src/lib/variant-lines.ts`).
 *
 * THIS FILE DOES NO ARITHMETIC ON A FIGURE. The boxes are read as typed and sent; whether the combinations add up to the
 * product's quantity, whether there are enough of them free, whether a product must name them — every one of those is
 * the door's question, answered in the door's own sentence. A sum made here would be a second copy of the rule.
 *
 * A product WITHOUT combinations draws nothing here and adds nothing to the body: its line goes out exactly as before.
 */

const WHOLE = /^\d+$/;

/** One combination as a grid draws it: its label and, when the server said one, a figure beside it. */
export interface GridCombination {
  variantId: string;
  label: string;
  hint?: string | null;
}

/** A combination of a product as `/api/products/[id]/variants` answers it, with its places in a placed store (W8a). */
export interface ProductCombination {
  variantId: string;
  label: string;
  /** `warehouseId: null` + `inTransit` = on the road; `warehouseId: null` alone = «بلا مكان». */
  places: { warehouseId: string | null; onHand: number; inTransit?: boolean }[];
}

interface VariantsAnswer {
  combinations?: { id: string; label: string; status: string; places?: ProductCombination['places'] }[];
}

/** A box typed with something that is not a whole number from zero up. */
export const badBox = (raw: string | undefined) => (raw ?? '').trim() !== '' && !WHOLE.test((raw ?? '').trim());

/**
 * The typed boxes as the wire carries them, in the grid's order: a blank box is not sent; `dropZero` also leaves out a
 * zero (a document that SENDS pieces names only combinations it sends). The quantities are the numbers as typed.
 */
export function typedCombinations(
  combos: readonly { variantId: string }[],
  values: Readonly<Record<string, string>>,
  opts: { dropZero: boolean }
): { variantId: string; quantity: number }[] {
  return combos.flatMap((c) => {
    const raw = (values[c.variantId] ?? '').trim();
    if (raw === '' || !WHOLE.test(raw)) return [];
    const quantity = Number(raw);
    return opts.dropZero && quantity === 0 ? [] : [{ variantId: c.variantId, quantity }];
  });
}

/**
 * «على الرف بـX: n» for one combination in one warehouse — its shelf row there, the server's figure, or nothing. A row on
 * the road has no warehouse, so it never answers for one (and is never called «بلا مكان»).
 */
export function shelfHint(c: ProductCombination, warehouse: { id: string; name: string } | undefined): string | null {
  if (!warehouse) return null;
  const row = c.places.find((p) => p.warehouseId === warehouse.id && !p.inTransit);
  return row ? `على الرف بـ${warehouse.name}: ${row.onHand}` : null;
}

/** Whether a catalogue product says it has options — the only products whose combinations are asked for. */
export const mayHaveCombinations = (p: { variantOptions?: string | null } | undefined) =>
  !!p?.variantOptions && p.variantOptions.trim() !== '' && p.variantOptions.trim() !== '[]';

/**
 * The ACTIVE combinations of the products a form picks, asked once per product from the products door. A product with
 * no options is never asked about (its request stays today's); a refused read is remembered as `failed`, and the form
 * says so — the door then names the combinations it needs in its own refusal.
 */
export function useProductCombinations() {
  const [known, setKnown] = useState<Record<string, ProductCombination[] | 'loading' | 'failed'>>({});
  const asked = useRef(new Set<string>());
  const ask = useCallback((productId: string) => {
    if (!productId || asked.current.has(productId)) return;
    asked.current.add(productId);
    setKnown((k) => ({ ...k, [productId]: 'loading' }));
    Promise.resolve()
      .then(() => apiJson<VariantsAnswer>(`/api/products/${encodeURIComponent(productId)}/variants`))
      .then(
        (a) =>
          setKnown((k) => ({
            ...k,
            [productId]: (a?.combinations ?? [])
              .filter((c) => c.status === 'ACTIVE')
              .map((c) => ({ variantId: c.id, label: c.label, places: c.places ?? [] })),
          })),
        () => setKnown((k) => ({ ...k, [productId]: 'failed' }))
      );
  }, []);
  return { known, ask };
}

/**
 * The combinations of the product picked on a line of a sending form (a transfer, an exit): a word while they are asked
 * for, a word when they could not be, and the grid once they are known. Nothing at all for a product without any.
 */
export function PickedCombinations({
  state,
  combos,
  values,
  onChange,
  line,
}: {
  state: ProductCombination[] | 'loading' | 'failed' | undefined;
  combos: readonly GridCombination[];
  values: Readonly<Record<string, string>>;
  onChange: (variantId: string, value: string) => void;
  line: number;
}) {
  if (state === 'loading') return <p className="text-note text-[var(--sys-muted-foreground)]">عم نجيب خيارات المنتج…</p>;
  if (state === 'failed') {
    return <p className="text-note text-[var(--sys-warning)]">ما قدرنا نجيب خيارات هالمنتج. إذا إله خيارات، الطلب رح يرجع ويسمّيها.</p>;
  }
  return (
    <CombinationBoxes
      title="كم قطعة من كل خيار؟ مجموعهم لازم يساوي كمية السطر."
      combos={combos}
      values={values}
      onChange={onChange}
      ariaOf={(label) => `عدد «${label}» بالسطر ${line}`}
    />
  );
}

/** The grid: one box per combination, wrapping on a phone. */
export function CombinationBoxes({
  title,
  combos,
  values,
  onChange,
  ariaOf,
}: {
  title: string;
  combos: readonly GridCombination[];
  values: Readonly<Record<string, string>>;
  onChange: (variantId: string, value: string) => void;
  /** The box's accessible name, from the combination's label. */
  ariaOf: (label: string) => string;
}) {
  if (combos.length === 0) return null;
  return (
    <div className="space-y-1.5" data-combinations="">
      <span className="block text-note text-[var(--sys-muted-foreground)]">{title}</span>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {combos.map((c) => (
          <Input
            key={c.variantId}
            label={c.label}
            aria-label={ariaOf(c.label)}
            inputMode="numeric"
            dir="ltr"
            value={values[c.variantId] ?? ''}
            onChange={(e) => onChange(c.variantId, e.target.value)}
            helperText={c.hint ?? undefined}
            error={badBox(values[c.variantId]) ? 'رقم صحيح من صفر وطالع' : undefined}
          />
        ))}
      </div>
    </div>
  );
}
