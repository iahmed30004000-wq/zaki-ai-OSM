'use client';

import { useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import type { PickableProduct } from '@/components/ui/ProductPicker';

/**
 * THE CATALOGUE, FETCHED IN ONE PLACE AND WHOLE.
 *
 * Seven screens each wrote this fetch by hand, through three different
 * clients, and two of them asked for `?limit=200` — which the route caps at
 * 100 (`src/app/api/products/route.ts`: `Math.min(…, 100)`). So on a
 * catalogue larger than a hundred those two screens quietly could not reach
 * its tail, and a search box over a truncated list is worse than a dropdown
 * over a whole one: it answers «لا يوجد» about a product that exists.
 *
 * Hence NO limit. The route returns the store's catalogue when none is
 * given, and `ProductPicker` narrows it in the browser, where the typing is.
 *
 * IT CARRIES THE CATEGORY THROUGH, and that needed no change to the fetch:
 * the route already selects it (`category: { select: { id: true, name: true } }`)
 * and this hook never dropped it — `PickableProduct` simply did not name it,
 * so every caller was typed as if it were not there. `ProductPicker` groups
 * its list under it while nothing is typed, so a catalogue can be BROWSED
 * and not only searched. Nothing extra is asked of the route, and the
 * no-limit rule above is untouched.
 *
 * `products.view` is held by the moderator, the confirmation agent and the
 * warehouse (see cost-visibility.ts), so every screen that offers a product
 * choice may read this. A refusal is not thrown at the caller: the list
 * stays empty and `loading` ends, so a picker says «لا نتائج» instead of a
 * dialog breaking around it.
 */
/**
 * WHAT THE ROUTE ACTUALLY RETURNS, NAMED.
 *
 * `PickableProduct` describes what the PICKER needs. The route sends more
 * — `basePrice` and the offers with their selling prices — and the three
 * order dialogs need exactly that to price a line. They were each fetching
 * the catalogue again by hand to get it, two of them through a bare
 * `fetch` that does not redirect on an expired session: instead of being
 * sent to sign in, the person got an empty product list, which reads as
 * «المنتج مش موجود».
 *
 * Nothing extra is asked of the route. The fields were always in the
 * answer; only the type stopped short of them.
 */
export interface CatalogueProduct extends PickableProduct {
  basePrice?: number;
  offers?: { id: string; name: string; quantity: number; sellingPrice: number }[];
  /**
   * The offers on sale RIGHT NOW (`activeOffersForProducts`): not stopped, not finished, not the one shown only after an
   * order. `price` is what the customer is charged for the bundle; `listPrice` the figure before its own reduction (or
   * null) and `discount` the difference. OPTIONAL: absent when the server could not read them, and `offers` above stays
   * what it always was for every screen that already reads it.
   */
  liveOffers?: {
    id: string;
    name: string;
    quantity: number;
    freeQuantity: number;
    price: number;
    listPrice: number | null;
    discount: number;
    isDefault: boolean;
    deliveryIncluded: boolean;
    endsAt: string | null;
  }[];
}

/**
 * `enabled: false` waits.
 *
 * Some callers need the catalogue only once a form opens — the order
 * dialog's line editor is one, and it fetched lazily before it was moved
 * onto this hook. Making every one of them fetch on mount would ask the
 * route for the whole catalogue every time an order is merely LOOKED at,
 * which is most of what happens on that screen.
 *
 * It is a delay, not a second behaviour: the moment it turns true the
 * same one fetch runs, and `loading` reads false until then because
 * nothing has been asked for yet.
 */
export function useProducts({ enabled = true }: { enabled?: boolean } = {}) {
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [loading, setLoading] = useState(enabled);
  /** Asked once, and not again when a form is closed and reopened. */
  const asked = useRef(false);

  useEffect(() => {
    if (!enabled || asked.current) return;
    asked.current = true;
    let cancelled = false;
    setLoading(true);
    apiJson<{ products: CatalogueProduct[] }>('/api/products')
      .then((data) => {
        if (!cancelled) setProducts(data.products ?? []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { products, loading };
}
