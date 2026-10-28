// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «العرض بعد الطلب مش شغال» — and from the basket it was never there at all (RV250). The basket's door answered with
 * the offer and its signed token exactly as the landing page's does, and the checkout threw the answer away on its
 * way to the thank-you page. Now the answer crosses that one navigation in this tab's session storage — never in
 * the link — and the thank-you page draws the same card every other door draws, through the same door.
 *
 * The worked example is the one measured on the product page (ORD-2026-0062): «قطعة كمان» at 10 on an order of 14,
 * and the server's total after the add is 24.
 */

const { push, trackEvent, shopFetch, clear, getStorefront } = vi.hoisted(() => ({
  push: vi.fn(),
  trackEvent: vi.fn(),
  shopFetch: vi.fn(),
  clear: vi.fn(),
  getStorefront: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/components/tracking/GlobalTrackingProvider', () => ({
  useTracking: () => ({ trackEvent, registerPixels: vi.fn(), setPageContext: vi.fn() }),
}));
vi.mock('@/lib/storefront-fetch', () => ({ shopFetch: (...a: unknown[]) => shopFetch(...a) }));
vi.mock('./useCart', () => ({
  useCart: () => ({
    ready: true,
    pricing: false,
    lines: [{ productId: 'p1', quantity: 1 }],
    quote: { lines: [], subtotal: 14, cod: 14, currency: 'JOD', pieces: 1 },
    clear,
  }),
}));
// The thank-you page's neighbours, stubbed as `thanks-and-track.test.tsx` stubs them.
vi.mock('@/lib/storefront', () => ({ getStorefront: (...a: unknown[]) => getStorefront(...a) }));
vi.mock('@/components/storefront/StorefrontShell', () => ({
  StorefrontShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/tracking/LandingTrackingPixels', () => ({ LandingTrackingPixels: () => null }));
vi.mock('@/lib/tracking/tracking-config', () => ({ getTrackingPixelsForPage: async () => [] }));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { CheckoutForm } from './CheckoutForm';
import { CartThankYouOffer } from './CartThankYouOffer';
import { afterOrderKey } from './after-order-handoff';
import Thanks from '@/app/s/[store]/thanks/page';
import { POST_ORDER_REFUSAL_AR } from '@/lib/post-order-offer-copy';
import { repoFile, stripComments } from '@/lib/guard-source';

const T0 = 1_800_000_000_000;
const N = 'ORD-2026-0064';
const TOKEN = 'x'.repeat(40);
const OFFER = { id: 'cmof-after-0001', name: 'قطعة كمان', quantity: 1, freeQuantity: 0, price: 10, listPrice: 14 };

/** The basket door's answer, as `createPublicOrder` sends it — more than the thank-you page needs. */
const DOOR_ANSWER = {
  success: true,
  orderNumber: N,
  addonToken: TOKEN,
  postOrderOffer: { ...OFFER, compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: null },
  postOrderWindowMinutes: 15,
  total: 14,
  currency: 'JOD',
  recommendations: [],
};

/** Exactly what the thank-you page may be handed, and nothing else. */
const ENTRY = { orderNumber: N, addonToken: TOKEN, offer: OFFER, windowMinutes: 15, currency: 'JOD', at: T0 };
const keep = (entry: unknown, key = afterOrderKey(N)) => sessionStorage.setItem(key, JSON.stringify(entry));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(T0);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ─────────────────────────── the checkout keeps the answer ─────────────────────────── */

describe('the checkout keeps the door’s answer for the thank-you page — in this tab, never in the link', () => {
  const answer = (ok: boolean, body: unknown) => shopFetch.mockResolvedValue({ ok, json: async () => body });
  const order = async () => {
    render(
      <CheckoutForm slug="main" minorUnit={3} fields={['name', 'phone']} required={['name', 'phone']} regions={[]} submitText="أرسل الطلب" />
    );
    fireEvent.change(document.getElementById('co-name')!, { target: { value: 'سلمى الأحمد' } });
    fireEvent.change(document.getElementById('co-phone')!, { target: { value: '0790000064' } });
    fireEvent.click(screen.getByRole('button', { name: 'أرسل الطلب' }));
  };

  it('keeps exactly the documented entry, before leaving, and the link carries the reference alone', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    answer(true, DOOR_ANSWER);
    await order();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/s/main/thanks?o=${N}`));

    const stored = sessionStorage.getItem(`zaki:after-order:${N}`);
    expect(JSON.parse(stored!), 'المحفوظ مش هو المكتوب بالضبط').toStrictEqual(ENTRY);
    expect(sessionStorage.length, 'انحفظ إشي تاني').toBe(1);
    // Written BEFORE the page is left, not after.
    expect(setItem.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]);
    // The token is in NO link the checkout opens.
    for (const [url] of push.mock.calls) expect(String(url), 'الرمز صار بالرابط').not.toContain(TOKEN);
    // And nothing the customer typed.
    expect(stored).not.toContain('سلمى');
    expect(stored).not.toContain('0790000064');
    // The basket's own sale is reported once, as before — the kept answer adds no event.
    expect(trackEvent.mock.calls).toEqual([['Purchase', { orderId: N, value: 14, currency: 'JOD' }]]);
  });

  it('NEGATIVE: an order whose product has no offer after it keeps nothing — there is no card to draw', async () => {
    answer(true, { ...DOOR_ANSWER, postOrderOffer: null });
    await order();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/s/main/thanks?o=${N}`));
    expect(sessionStorage.length).toBe(0);
  });

  it('NEGATIVE: an answer with no token keeps nothing — the card could not add without it', async () => {
    answer(true, { ...DOOR_ANSWER, addonToken: null });
    await order();
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(sessionStorage.length).toBe(0);
  });

  it('NEGATIVE: a refused order keeps nothing and goes nowhere', async () => {
    answer(false, { error: 'هذا الرقم عليه طلب مفتوح' });
    await order();
    await screen.findByRole('alert');
    expect(sessionStorage.length).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });

  it('storage that throws (private mode) costs nothing: the order is placed and the thank-you page opens', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    answer(true, DOOR_ANSWER);
    await order();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/s/main/thanks?o=${N}`));
    expect(sessionStorage.length).toBe(0);
  });
});

/* ─────────────────────────── the thank-you page draws the card ─────────────────────────── */

describe('the thank-you page draws the same card, only for its own reference', () => {
  const card = () => document.querySelector('.lp-upsell');
  const page = async (reference = N) => {
    render(<CartThankYouOffer reference={reference} />);
    await act(async () => {});
  };
  const addAnswers = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('draws the server’s offer, its price, both answers and the window — the card the other doors show', async () => {
    keep(ENTRY);
    await page();
    expect(card()?.getAttribute('data-look')).toBe('card');
    expect(screen.getByText('قطعة كمان — زيدها لطلبك؟')).toBeTruthy();
    expect(card()!.querySelector('.lp-upsell-price')!.textContent).toBe('10 JOD14 JOD');
    expect(screen.getByRole('button', { name: 'آه، زيدها لطلبي' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'لا شكراً' })).toBeTruthy();
    expect(screen.getByText(/تقدر تزيدها خلال 15 دقيقة من وقت الطلب/)).toBeTruthy();
  });

  it('NEGATIVE: nothing kept — nothing drawn', async () => {
    await page();
    expect(card()).toBeNull();
  });

  it('NEGATIVE: a value that is not the entry — nothing drawn', async () => {
    sessionStorage.setItem(afterOrderKey(N), '{not json');
    await page();
    expect(card()).toBeNull();
    sessionStorage.setItem(afterOrderKey(N), JSON.stringify({ ...ENTRY, addonToken: 7 }));
    cleanup();
    await page();
    expect(card()).toBeNull();
  });

  it('NEGATIVE: another order’s answer is never this page’s — under its own key or under this one', async () => {
    const other = 'ORD-2026-0063';
    keep({ ...ENTRY, orderNumber: other }, afterOrderKey(other));
    await page(N);
    expect(card(), 'صفحة طلب رسمت عرض طلب تاني').toBeNull();
    // and the other order's entry is left for its own page
    expect(sessionStorage.getItem(afterOrderKey(other))).not.toBeNull();

    cleanup();
    keep({ ...ENTRY, orderNumber: other }); // under THIS reference's key, naming another order
    await page(N);
    expect(card(), 'المفتاح طابق والطلب لأ — وانرسمت').toBeNull();
  });

  it('NEGATIVE: storage that throws — nothing drawn, nothing broken', async () => {
    keep(ENTRY);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    await page();
    expect(card()).toBeNull();
  });

  it('NEGATIVE: opened after the window — nothing drawn, and the entry is gone', async () => {
    keep({ ...ENTRY, at: T0 - 15 * 60_000 - 1 });
    await page();
    expect(card()).toBeNull();
    expect(sessionStorage.getItem(afterOrderKey(N))).toBeNull();
  });

  it('«آه، زيدها لطلبي» posts exactly the token and the offer to the one door', async () => {
    keep(ENTRY);
    addAnswers(200, { success: true, orderNumber: N, newTotal: 24, currency: 'JOD', addOn: { id: 'a1', productName: 'كريم', quantity: 1, price: 10, total: 11 } });
    await page();
    fireEvent.click(screen.getByRole('button', { name: 'آه، زيدها لطلبي' }));
    await screen.findByText('تمت الإضافة إلى طلبك ✅');
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/public/orders/${N}/post-order-offer`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(String(init.body))).toStrictEqual({ token: TOKEN, offerId: OFFER.id });
  });

  it('200 → «تمت الإضافة إلى طلبك ✅», the SERVER’s new total, and one Purchase for the added amount', async () => {
    keep(ENTRY);
    // The added amount (11) is not the offer's price (10) and the total (24) is not 14 + 10: the screen can only
    // print and report what the server sent.
    addAnswers(200, { success: true, orderNumber: N, newTotal: 24, currency: 'JOD', addOn: { id: 'a1', productName: 'كريم', quantity: 1, price: 11, total: 11 } });
    await page();
    fireEvent.click(screen.getByRole('button', { name: 'آه، زيدها لطلبي' }));
    await screen.findByText('تمت الإضافة إلى طلبك ✅');
    expect(screen.getByRole('status').textContent).toContain('24 JOD');
    expect(screen.queryByRole('button', { name: 'آه، زيدها لطلبي' }), 'الزر ضل بعد الإضافة').toBeNull();
    expect(trackEvent.mock.calls).toEqual([
      ['Purchase', { orderId: `${N}:${OFFER.id}`, value: 11, currency: 'JOD', contentName: 'كريم' }],
    ]);
    // Answered — so a refresh does not ask again.
    expect(sessionStorage.getItem(afterOrderKey(N))).toBeNull();
    cleanup();
    await page();
    expect(card(), 'رجع العرض بعد ما انضاف').toBeNull();
  });

  it('409 → the server’s sentence, word for word, and the card closes', async () => {
    keep(ENTRY);
    addAnswers(409, { error: POST_ORDER_REFUSAL_AR.NOT_NEW, reason: 'NOT_NEW' });
    await page();
    fireEvent.click(screen.getByRole('button', { name: 'آه، زيدها لطلبي' }));
    expect(await screen.findByText(POST_ORDER_REFUSAL_AR.NOT_NEW)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'آه، زيدها لطلبي' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'لا شكراً' })).toBeNull();
    expect(trackEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(sessionStorage.getItem(afterOrderKey(N))).toBeNull();
  });

  it('«لا شكراً» sends nothing, closes the card and forgets the entry', async () => {
    keep(ENTRY);
    vi.stubGlobal('fetch', vi.fn());
    await page();
    fireEvent.click(screen.getByRole('button', { name: 'لا شكراً' }));
    expect(card()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    await waitFor(() => expect(sessionStorage.getItem(afterOrderKey(N))).toBeNull());
  });

  it('a connection that failed is not a no: the card stays, and so does the entry, to try again', async () => {
    keep(ENTRY);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await page();
    fireEvent.click(screen.getByRole('button', { name: 'آه، زيدها لطلبي' }));
    expect(await screen.findByText('تعذر الاتصال، حاول مرة أخرى')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'آه، زيدها لطلبي' })).toBeTruthy();
    expect(sessionStorage.getItem(afterOrderKey(N))).not.toBeNull();
  });

  it('a dinar keeps its three decimals, as the server sent them', async () => {
    keep({ ...ENTRY, offer: { ...OFFER, price: 10.125, listPrice: 14.5 } });
    addAnswers(200, { success: true, orderNumber: N, newTotal: 24.125, currency: 'JOD', addOn: { id: 'a1', productName: 'كريم', quantity: 1, price: 10.125, total: 10.125 } });
    await page();
    expect(card()!.querySelector('.lp-upsell-price')!.textContent).toBe('10.125 JOD14.5 JOD');
    fireEvent.click(screen.getByRole('button', { name: 'آه، زيدها لطلبي' }));
    await screen.findByText('تمت الإضافة إلى طلبك ✅');
    expect(screen.getByRole('status').textContent).toContain('24.125 JOD');
  });
});

/* ─────────────────────────── both halves, and the page between them ─────────────────────────── */

describe('a basket order, end to end: checkout → thank-you page → «آه، زيدها لطلبي» → 14 → 24', () => {
  it('the card the checkout kept is the card the thank-you page draws, and the add lands on the same order', async () => {
    shopFetch.mockResolvedValue({ ok: true, json: async () => DOOR_ANSWER });
    render(
      <CheckoutForm slug="main" minorUnit={3} fields={['name', 'phone']} required={['name', 'phone']} regions={[]} submitText="أرسل الطلب" />
    );
    fireEvent.change(document.getElementById('co-name')!, { target: { value: 'سلمى الأحمد' } });
    fireEvent.change(document.getElementById('co-phone')!, { target: { value: '0790000064' } });
    fireEvent.click(screen.getByRole('button', { name: 'أرسل الطلب' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/s/main/thanks?o=${N}`));
    cleanup();

    // The page the link opens: it echoes the reference, and hands only that reference to the card's part.
    getStorefront.mockResolvedValue({ id: 's1', slug: 'main', companyId: 'c1', countryId: 'jo', type: 'MULTI_PRODUCT', name: 'متجر' });
    const reference = new URL(String(push.mock.calls[0][0]), 'https://shop.example').searchParams.get('o')!;
    render(await Thanks({ params: Promise.resolve({ store: 'main' }), searchParams: Promise.resolve({ o: reference }) }));
    await act(async () => {});
    expect(screen.getByText(N)).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ success: true, orderNumber: N, newTotal: 24, currency: 'JOD', addOn: { id: 'a1', productName: 'كريم', quantity: 1, price: 10, total: 10 } }), { status: 200 })
    ));
    fireEvent.click(screen.getByRole('button', { name: 'آه، زيدها لطلبي' }));
    await screen.findByText('تمت الإضافة إلى طلبك ✅');
    expect(screen.getByRole('status').textContent).toContain('24 JOD');
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`/api/public/orders/${N}/post-order-offer`);
    // The basket's sale (14) and the addition (10) — two Purchases, never the whole 24 a second time.
    expect(trackEvent.mock.calls.map((c) => c[1])).toEqual([
      { orderId: N, value: 14, currency: 'JOD' },
      { orderId: `${N}:${OFFER.id}`, value: 10, currency: 'JOD', contentName: 'كريم' },
    ]);
  });

  it('NEGATIVE: the same page with no reference has no card part at all, and asks nothing about one', async () => {
    getStorefront.mockResolvedValue({ id: 's1', slug: 'main', companyId: 'c1', countryId: 'jo', type: 'MULTI_PRODUCT', name: 'متجر' });
    keep(ENTRY);
    render(await Thanks({ params: Promise.resolve({ store: 'main' }), searchParams: Promise.resolve({}) }));
    await act(async () => {});
    expect(document.querySelector('.lp-upsell')).toBeNull();
    const src = stripComments(repoFile('src/app/s/[store]/thanks/page.tsx'));
    expect(src).toContain('{reference && <CartThankYouOffer reference={reference} />}');
    expect(src, 'صفحة الشكر تسأل عن الطلب').not.toMatch(/db\.order|findFirst|findUnique/);
  });
});
