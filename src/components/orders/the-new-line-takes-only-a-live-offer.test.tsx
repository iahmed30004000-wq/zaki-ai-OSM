// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';
import type { Currency } from '@/lib/format';

/**
 * A NEW LINE ADOPTS AN OFFER ON SALE TODAY, OR NO OFFER AT ALL.
 *
 * `GET /api/products` sends `offers` (every row: stopped, finished, shown only after an order) and, since the offer
 * reader was unified, `liveOffers` (what the doors would accept today). The editor adopted `offers[0]`, so a hoodie
 * with A «3 بـ75» finished and B «قطعتان بـ50» live, A listed first, opened the order at three pieces for 75 with a
 * gift of a bundle that no longer exists.
 *
 *   L1  the first LIVE offer is adopted - not the first row;
 *   L2  every offer finished / stopped / after-order: nothing adopted, base price, and the line says so;
 *   L3  `liveOffers` absent (an older server, a failed read): the same as L2 - never a fall back to `offers`;
 *   L4  the offer list a person chooses from holds the live ones only;
 *   L5  the body sent to create the order is the one it always was for a live offer (offer id, paid quantity,
 *       the bundle's price before its own reduction), and the plain base-price body when none is live.
 *
 * Every rule carries its NEGATIVE: the value the old `offers[0]` would have produced.
 */

const { apiFetch, apiJson, catalogue } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  catalogue: { current: [] as unknown[] },
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    t: (k: string) => k,
    locale: 'ar',
    isRtl: true,
    currentUser: { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['orders.create'] },
  }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({
    regions: [{ id: 'r1', name: 'عمّان', delivery: null, deliveryAr: null }],
    countryName: 'الأردن',
    currency: { code: 'JOD', minorUnit: 2 },
    loading: false,
  }),
}));
vi.mock('@/hooks/useDeliveryEta', () => ({ useDeliveryEta: () => ({ eta: null, loading: false }) }));
vi.mock('@/hooks/useProducts', () => ({
  useProducts: () => ({ products: catalogue.current, loading: false }),
}));
// A native select makes choosing a product one change event.
vi.mock('@/components/ui/ProductPicker', () => ({
  ProductPicker: ({
    value,
    onChange,
    products,
  }: {
    value: string;
    onChange: (id: string) => void;
    products: { id: string; name: string }[];
  }) => (
    <select aria-label="المنتج" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {products.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  ),
}));

import { ProductLinesEditor, adoptedOffer, liveOffersOf, newLine, withOffer, withProduct, type DraftLine } from './ProductLinesEditor';
import { CreateOrderModal } from './CreateOrderModal';

/* ── the catalogue (ids in camelCase: an id spelled like a spacing class is a class to the stylesheet scanner) ── */

const OFFER_A = { id: 'offerAThree', name: 'ثلاث قطع', quantity: 3, freeQuantity: 1, sellingPrice: 75 };
const OFFER_B = { id: 'offerBTwo', name: 'قطعتان', quantity: 2, freeQuantity: 0, sellingPrice: 50 };
const LIVE_B = { id: 'offerBTwo', name: 'قطعتان', quantity: 2, freeQuantity: 0, price: 50, listPrice: null };

/** A finished, B live, A listed first: the worked example. */
const HOODIE = { id: 'prodHoodie', name: 'هودي', basePrice: 30, offers: [OFFER_A, OFFER_B], liveOffers: [LIVE_B] };
/** Every offer it has is finished, stopped or shown only after an order: the server sent an empty live list. */
const NONE_LIVE = { id: 'prodNoneLive', name: 'قبعة', basePrice: 20, offers: [OFFER_A], liveOffers: [] };
/** An older server, or a failed read: `liveOffers` is simply not there. */
const NO_LIVE_KEY = { id: 'prodNoKey', name: 'وشاح', basePrice: 20, offers: [OFFER_A, OFFER_B] };
/** A product that never had an offer. */
const PLAIN = { id: 'prodPlain', name: 'كوب', basePrice: 12, offers: [] };
/** Live, with its own reduction: 25 before it, 22 charged. */
const REDUCED = {
  id: 'prodReduced',
  name: 'غسول',
  basePrice: 15,
  offers: [{ id: 'offerReduced', name: 'قطعتان', quantity: 2, freeQuantity: 0, sellingPrice: 25 }],
  liveOffers: [{ id: 'offerReduced', name: 'قطعتان', quantity: 2, freeQuantity: 0, price: 22, listPrice: 25 }],
};
/** Two live bundles, the SECOND marked as the default: the storefront opens on it, so does the order form. */
const TWO_LIVE = {
  id: 'prodTwoLive',
  name: 'جاكيت',
  basePrice: 40,
  offers: [OFFER_B],
  liveOffers: [
    { id: 'offerFirst', name: 'قطعتان', quantity: 2, freeQuantity: 0, price: 70, listPrice: null, isDefault: false },
    { id: 'offerDefault', name: 'ثلاث قطع', quantity: 3, freeQuantity: 0, price: 90, listPrice: null, isDefault: true },
  ],
};
/** Two live bundles and none marked: the first. */
const NO_DEFAULT = { ...TWO_LIVE, id: 'prodNoDefault', liveOffers: TWO_LIVE.liveOffers.map((o) => ({ ...o, isDefault: false })) };
const CATALOGUE = [HOODIE, NONE_LIVE, NO_LIVE_KEY, PLAIN, REDUCED, TWO_LIVE, NO_DEFAULT];

const JOD2: Currency = { code: 'JOD', minorUnit: 2 };

function Harness() {
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  return <ProductLinesEditor lines={lines} products={CATALOGUE} currency={JOD2} onChange={setLines} />;
}

const priceBox = () => screen.getByPlaceholderText('سعر السطر') as HTMLInputElement;
const pick = (id: string) => fireEvent.change(screen.getByLabelText('المنتج'), { target: { value: id } });
const offerSelect = () => screen.queryByRole('option', { name: 'بلا عرض — سعر مباشر' })?.closest('select') ?? null;
const NOTE = 'لا عرض فعّال لهذا المنتج — السعر الأساسي';

beforeEach(() => {
  vi.clearAllMocks();
  catalogue.current = [];
});
afterEach(cleanup);

/* ══════════════════════════════════════════════════════════════════════ */

describe('L1 — the first LIVE offer is adopted, not the first row', () => {
  it('the hoodie: B (2 for 50) is adopted, not the finished A (3 for 75)', () => {
    const line = newLine(HOODIE, 2);
    expect(line).toMatchObject({ offerId: 'offerBTwo', quantity: 2, price: '50', pricing: 'follows' });
    // NEGATIVE: what `offers[0]` produced.
    expect(line.offerId).not.toBe('offerAThree');
    expect(line.quantity).not.toBe(3);
    expect(line.price).not.toBe('75');
  });

  it('picking the product in the form opens the line at B', () => {
    render(<Harness />);
    pick(HOODIE.id);
    expect(priceBox().value).toBe('50');
    expect(offerSelect()?.value).toBe('offerBTwo');
  });

  it('switching to another product re-adopts that product\'s live offer', () => {
    const switched = withProduct(newLine(NONE_LIVE, 2), HOODIE.id, HOODIE, 2);
    expect(switched).toMatchObject({ offerId: 'offerBTwo', quantity: 2, price: '50' });
  });

  it('the bundle\'s price BEFORE its own reduction is what the box holds, as it always did', () => {
    expect(newLine(REDUCED, 2)).toMatchObject({ offerId: 'offerReduced', quantity: 2, price: '25' });
    // NEGATIVE: the charged 22 is for the door to take off, not the box.
    expect(newLine(REDUCED, 2).price).not.toBe('22');
  });
});

describe('L1b — the default bundle wins, as in the storefront', () => {
  it('two live bundles, the default second: the default is adopted', () => {
    expect(newLine(TWO_LIVE, 2)).toMatchObject({ offerId: 'offerDefault', quantity: 3, price: '90' });
    expect(adoptedOffer(TWO_LIVE)?.id).toBe('offerDefault');
    // NEGATIVE: the first row is not the default.
    expect(newLine(TWO_LIVE, 2).offerId).not.toBe('offerFirst');
  });

  it('none marked: the first live one', () => {
    expect(newLine(NO_DEFAULT, 2)).toMatchObject({ offerId: 'offerFirst', quantity: 2, price: '70' });
  });

  it('picking the product in the form opens at the default', () => {
    render(<Harness />);
    pick(TWO_LIVE.id);
    expect(priceBox().value).toBe('90');
    expect(offerSelect()?.value).toBe('offerDefault');
  });
});

describe('L2/L3 — no live offer: nothing adopted, the base price, and the line says so', () => {
  it.each([
    ['every offer finished or stopped (an empty live list)', NONE_LIVE],
    ['`liveOffers` absent (an older server)', NO_LIVE_KEY],
  ])('%s', (_name, product) => {
    const line = newLine(product, 2);
    expect(line).toMatchObject({ offerId: null, quantity: 1, pricing: 'follows' });
    expect(line.price).toBe('20');
    // NEGATIVE: a row of `offers` is never the fallback.
    expect(line.offerId).not.toBe('offerAThree');
    expect(line.price).not.toBe('75');
  });

  it('the screen offers no bundle and, when the server said none is live, names the reason', () => {
    render(<Harness />);
    pick(NONE_LIVE.id);
    expect(offerSelect()).toBeNull();
    expect(screen.getByText(NOTE)).toBeTruthy();
    expect(priceBox().value).toBe('20');
  });

  it('a MISSING `liveOffers` offers no bundle either, but claims nothing: «unknown» is not «none»', () => {
    render(<Harness />);
    pick(NO_LIVE_KEY.id);
    expect(offerSelect()).toBeNull();
    expect(priceBox().value).toBe('20');
    // NEGATIVE: the note would say something nobody checked.
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('a product that never had an offer says nothing about one', () => {
    render(<Harness />);
    pick(PLAIN.id);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(priceBox().value).toBe('12');
  });

  it('a product with a live offer does not carry the note', () => {
    render(<Harness />);
    pick(HOODIE.id);
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('`liveOffersOf` returns nothing for no product, no key or an empty list', () => {
    expect(liveOffersOf(undefined)).toEqual([]);
    expect(liveOffersOf(NO_LIVE_KEY)).toEqual([]);
    expect(liveOffersOf(NONE_LIVE)).toEqual([]);
  });
});

describe('L4 — the choice a person makes holds the live offers only', () => {
  it('B is a choice, A is not', () => {
    render(<Harness />);
    pick(HOODIE.id);
    const choices = Array.from(offerSelect()!.querySelectorAll('option')).map((o) => o.textContent ?? '');
    expect(choices.some((c) => c.includes('قطعتان'))).toBe(true);
    // NEGATIVE: the finished bundle is not offered.
    expect(choices.some((c) => c.includes('ثلاث قطع'))).toBe(false);
  });

  it('an offer id that is not live is treated as «بلا عرض»', () => {
    const line = newLine(HOODIE, 2);
    const stale = withOffer(line, 'offerAThree', HOODIE, 2);
    expect(stale).toMatchObject({ offerId: null, quantity: 2, price: '60' });
    // NEGATIVE: the quantity and the price of A are never taken.
    expect(stale.quantity).not.toBe(3);
    expect(stale.price).not.toBe('75');
  });
});

describe('L5 — the body sent to create the order', () => {
  const open = async () => {
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/orders' && init?.method === 'POST') return { ok: true, json: async () => ({ order: { id: 'o-1' } }) };
      if (url === '/api/orders/form-options') return { ok: true, json: async () => ({ channels: [], moderators: [], mayAssign: false }) };
      return { ok: true, json: async () => ({}) };
    });
    render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={vi.fn()} />);
    await screen.findByLabelText('المحافظة');
    fireEvent.change(screen.getByPlaceholderText('مثال: 0936654998'), { target: { value: '0791234567' } });
    fireEvent.change(screen.getByPlaceholderText('مثال: عبدالله عبدالقادر'), { target: { value: 'سامر أحمد' } });
    fireEvent.change(screen.getByPlaceholderText('الشارع، البناء، المنطقة...'), { target: { value: 'عمّان - الجبيهة' } });
    fireEvent.change(screen.getByLabelText('المحافظة'), { target: { value: 'r1' } });
    const button = await screen.findByRole('button', { name: /إنشاء الطلب/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(apiFetch.mock.calls.some((c) => c[0] === '/api/orders')).toBe(true));
    const call = apiFetch.mock.calls.find((c) => c[0] === '/api/orders' && c[1]?.method === 'POST');
    return JSON.parse(String(call![1].body)) as { items: unknown[] };
  };

  it('a live offer: the same line the form always sent for it', async () => {
    catalogue.current = [HOODIE];
    const body = await open();
    expect(body.items).toEqual([{ productId: 'prodHoodie', offerId: 'offerBTwo', quantity: 2, unitPrice: '50' }]);
  });

  it('a live offer with its own reduction: the price before it, as before', async () => {
    catalogue.current = [REDUCED];
    const body = await open();
    expect(body.items).toEqual([{ productId: 'prodReduced', offerId: 'offerReduced', quantity: 2, unitPrice: '25' }]);
  });

  it('only finished offers: a plain base-price line, no offer id', async () => {
    catalogue.current = [NONE_LIVE];
    const body = await open();
    expect(body.items).toEqual([{ productId: 'prodNoneLive', offerId: null, quantity: 1, unitPrice: '20' }]);
    // NEGATIVE: the finished bundle's id never reaches the door.
    expect(JSON.stringify(body)).not.toContain('offerAThree');
  });
});

describe('the source', () => {
  it('no code path of the editor reads `offers` to pick or adopt an offer', () => {
    const code = stripComments(repoFile('src/components/orders/ProductLinesEditor.tsx'));
    expect(code).not.toMatch(/product\??\.offers\??\.\[0\]/);
    expect(code).not.toMatch(/product\??\.offers\??\.find/);
    expect(code).not.toMatch(/const offers = product\??\.offers/);
    expect(code).toContain('liveOffersOf(product)');
  });
});
