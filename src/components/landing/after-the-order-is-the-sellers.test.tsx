// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { landingSectionSchema, newSection } from '@/lib/landing-sections';

/**
 * «بعد ما يتمم الطلب… تواصل معنا عبر الواتس — ضيفها كفيتشر كوستمايز اقدر اعدل النص والرقم» and «الابسيل والكروس سيل
 * حاسهم مخفيين… لازم يكون في اشي بوصل الهم بصفحة الهبوط».
 */

const { apiJson, leaveFor } = vi.hoisted(() => ({ apiJson: vi.fn(), leaveFor: vi.fn() }));
vi.mock('@/lib/leave-for', () => ({ leaveFor }));
vi.mock('@/lib/api-client', () => ({ apiJson, apiFetch: vi.fn() }));
vi.mock('@/components/tracking/GlobalTrackingProvider', () => ({
  useTracking: () => ({ trackEvent: vi.fn(), registerPixels: vi.fn(), setPageContext: vi.fn() }),
}));

import OrderForm, { afterOrderMessage } from './OrderForm';
import { AfterOrderPanel } from '@/components/landing-editor/AfterOrderPanel';

const offers = [{ id: 'o1', name: 'عبوة واحدة', quantity: 1, freeQuantity: 0, price: 12, isDefault: true }];

async function orderPlaced(props: Partial<React.ComponentProps<typeof OrderForm>>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ orderNumber: 'ORD-2026-0601', total: 12, currency: 'USD' }), { status: 200 })));
  render(<OrderForm slug="s" productName="ماء الكمأ" basePrice={12} currency="USD" offers={offers} recommendations={[]} regions={['دمشق']} {...props} />);
  const field = (name: string) => document.querySelector(`[name="${name}"]`) as HTMLInputElement;
  fireEvent.change(field('full_name'), { target: { value: 'زبون تجربة' } });
  fireEvent.change(field('phone'), { target: { value: '0999999999' } });
  fireEvent.change(field('address'), { target: { value: 'شارع 5' } });
  fireEvent.click(screen.getByRole('button', { name: /المدينة|المحافظة/ }));
  fireEvent.click(screen.getByRole('button', { name: 'دمشق' }));
  fireEvent.submit(document.querySelector('form')!);
  await screen.findByText(/ORD-2026-0601/);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the form block’s «بعد الطلب» settings', () => {
  it('a saved page reads as before: on, the old words, the store’s number, no auto-open', () => {
    const s = landingSectionSchema.parse({ ...newSection('form') }) as Record<string, unknown>;
    expect(s).toMatchObject({ whatsappAfter: true, whatsappLabel: 'أكّد طلبك على واتساب', whatsappNumber: '', whatsappAutoOpen: false });
  });

  it('NEGATIVE: a number with letters in it is refused', () => {
    expect(landingSectionSchema.safeParse({ ...newSection('form'), whatsappNumber: 'javascript:1' }).success).toBe(false);
  });

  it('the message carries the order number where the seller put it', () => {
    expect(afterOrderMessage('طلبي {رقم_الطلب} بدّي أأكده', 'ORD-1')).toBe('طلبي ORD-1 بدّي أأكده');
    expect(afterOrderMessage('مرحبا', 'ORD-1')).toBe('مرحبا — ORD-1');
  });
});

describe('the thank-you screen', () => {
  it('shows the seller’s words and number, with the order in the message', async () => {
    await orderPlaced({ whatsapp: '+963 999 000 111', afterOrderWhatsapp: { label: 'كلّمنا على واتساب', message: 'طلب {رقم_الطلب}' } });
    const link = screen.getByRole('link', { name: 'كلّمنا على واتساب' }) as HTMLAnchorElement;
    expect(link.href).toContain('wa.me/963999000111');
    expect(decodeURIComponent(link.href)).toContain('طلب ORD-2026-0601');
  });

  it('NEGATIVE: switched off, there is no button', async () => {
    await orderPlaced({ whatsapp: '+963999000111', afterOrderWhatsapp: { enabled: false } });
    expect(screen.queryByRole('link', { name: /واتساب/ })).toBeNull();
  });

  it('opens WhatsApp by itself after a moment — when the seller chose it', async () => {
    await orderPlaced({ whatsapp: '+963999000111', afterOrderWhatsapp: { autoOpen: true } });
    await new Promise((r) => setTimeout(r, 3200));
    expect(leaveFor).toHaveBeenCalledWith(expect.stringContaining('wa.me/963999000111'));
  }, 10_000);

  it('NEGATIVE: no auto-open unless the seller chose it', async () => {
    await orderPlaced({ whatsapp: '+963999000111' });
    await new Promise((r) => setTimeout(r, 3200));
    expect(leaveFor).not.toHaveBeenCalled();
  }, 10_000);
});

describe('the editor panel', () => {
  const section = {
    whatsappAfter: true, whatsappLabel: 'أكّد طلبك على واتساب', whatsappMessage: 'طلبي {رقم_الطلب}', whatsappNumber: '', whatsappAutoOpen: false,
    afterOrderFlow: 'together' as const, afterOrderBanner: 'none' as const, afterOrderBannerText: 'مبروك!', upsellLook: 'card' as const, crossSellLook: 'list' as const,
  };

  it('the shapes of the thank-you offers are the seller’s to pick — order, strip, upsell, cross-sell', () => {
    apiJson.mockResolvedValue({});
    const patch = vi.fn();
    render(<AfterOrderPanel section={section} patch={patch} ctx={{ productId: null, pageId: null, storePhone: null }} />);
    fireEvent.click(screen.getByRole('button', { name: 'ورا بعض' }));
    fireEvent.click(screen.getByRole('button', { name: 'عدّاد' }));
    fireEvent.click(screen.getByRole('button', { name: 'شريط ملوّن' }));
    fireEvent.click(screen.getByRole('button', { name: 'بطاقات' }));
    expect(patch.mock.calls.map((c) => c[0])).toEqual([
      { afterOrderFlow: 'sequence' }, { afterOrderBanner: 'countdown' }, { upsellLook: 'banner' }, { crossSellLook: 'cards' },
    ]);
  });

  it('says whether the upsell and the suggestions are on, and links to where they are set', async () => {
    // The upsell line is the page's own answer now — see the-offer-after-the-order-is-switched-on-from-the-page.test.tsx.
    apiJson.mockImplementation(async (url: string) =>
      url === '/api/landing-pages/lp1/after-order'
        ? {
            productId: 'p1', productName: 'ماء الكمأ', why: null, flagged: { id: 'po1', name: 'قطعة كمان' }, flaggedCount: 1, minorUnit: 2, canManage: false,
            offer: { id: 'po1', name: 'قطعة كمان', quantity: 1, freeQuantity: 0, price: 10, listPrice: null },
          }
        : { recommendations: [{}, {}] }
    );
    render(<AfterOrderPanel section={section} patch={vi.fn()} ctx={{ productId: 'p1', pageId: 'lp1', storePhone: null, currency: 'USD' }} />);
    await waitFor(() => expect(screen.getByText('شغّال: قطعة كمان — 1 قطعة بـ10.00 USD')).toBeTruthy());
    expect(screen.getByText('2 منتج')).toBeTruthy();
    expect((screen.getByRole('link', { name: 'عروض المنتج' }) as HTMLAnchorElement).getAttribute('href')).toBe('/products/p1#offers');
    expect((screen.getByRole('link', { name: 'المنتجات المقترحة' }) as HTMLAnchorElement).getAttribute('href')).toBe('/store/landing-pages/lp1#recommendations');
  });

  it('NEGATIVE: warns when there is no number at all — the button would not show', async () => {
    apiJson.mockResolvedValue({ offers: [], recommendations: [] });
    render(<AfterOrderPanel section={section} patch={vi.fn()} ctx={{ productId: 'p1', pageId: 'lp1', storePhone: null }} />);
    expect(screen.getByText(/ما في رقم/)).toBeTruthy();
    await act(async () => {});
  });

  it('typing a number keeps digits only', async () => {
    apiJson.mockResolvedValue({ offers: [], recommendations: [] });
    const patch = vi.fn();
    render(<AfterOrderPanel section={section} patch={patch} ctx={{}} />);
    fireEvent.change(screen.getByLabelText('رقم واتساب'), { target: { value: '+963 9a9' } });
    expect(patch).toHaveBeenCalledWith({ whatsappNumber: '+963 99' });
  });
});

describe('the confirm button’s words — «بعد ما يعبي بياناته زر واضح كمان»', () => {
  it('a saved page still says «تأكيد الطلب»', () => {
    expect((landingSectionSchema.parse({ ...newSection('form') }) as Record<string, unknown>).submitLabel).toBe('تأكيد الطلب');
  });

  it('the seller’s words are on the button, with the price after them', () => {
    render(<OrderForm slug="s" productName="ماء الكمأ" basePrice={12} currency="USD" offers={offers} recommendations={[]} regions={['دمشق']} submitLabel="اضغط هنا لتأكيد طلبك" />);
    expect(screen.getByRole('button', { name: /اضغط هنا لتأكيد طلبك — 12 USD/ })).toBeTruthy();
  });

  it('NEGATIVE: an empty label falls back to «تأكيد الطلب», never a blank button', () => {
    render(<OrderForm slug="s" productName="ماء الكمأ" basePrice={12} currency="USD" offers={offers} recommendations={[]} regions={['دمشق']} submitLabel="  " />);
    expect(screen.getByRole('button', { name: /^تأكيد الطلب — 12 USD/ })).toBeTruthy();
  });
});
