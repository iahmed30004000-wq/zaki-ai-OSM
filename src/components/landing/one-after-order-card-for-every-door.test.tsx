// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { repoFile, stripComments } from '@/lib/guard-source';
import { POST_ORDER_REFUSAL_AR } from '@/lib/post-order-offer-copy';

/**
 * «العرض بعد الطلب» IS ONE CARD — `ThankYouOfferCard` — drawn by the landing form and by the basket's thank-you page.
 *
 * The card left `OrderForm` so the basket could draw it too (RV250). These are the landing form's own answers
 * through the shared card — the request, the server's total in the form's header, the one Purchase for the
 * addition, a refusal, «لا شكراً» — and the rule that keeps it one card: no other screen spells the door or the
 * answer. The form's markup for every look is pinned, unchanged, by the thank-you tests beside this file.
 */

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('@/lib/leave-for', () => ({ leaveFor: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/components/tracking/GlobalTrackingProvider', () => ({
  useTracking: () => ({ trackEvent, registerPixels: vi.fn(), setPageContext: vi.fn() }),
}));

import OrderForm from './OrderForm';

const N = 'ORD-2026-0062';
const TOKEN = 'x'.repeat(40);
const OFFER = { id: 'cmof-after-0001', name: 'قطعة كمان', quantity: 1, freeQuantity: 0, price: 10, listPrice: 14 };
const offers = [{ id: 'o1', name: 'عبوة واحدة', quantity: 1, freeQuantity: 0, price: 14, isDefault: true }];

async function orderPlaced(add: { status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/post-order-offer')) return new Response(JSON.stringify(add.body), { status: add.status });
    return new Response(
      JSON.stringify({ orderNumber: N, total: 14, currency: 'JOD', addonToken: TOKEN, postOrderOffer: OFFER, postOrderWindowMinutes: 15 }),
      { status: 200 }
    );
  }));
  render(<OrderForm slug="skin" productName="كريم" basePrice={14} currency="JOD" offers={offers} recommendations={[]} regions={['عمّان']} />);
  const field = (name: string) => document.querySelector(`[name="${name}"]`) as HTMLInputElement;
  fireEvent.change(field('full_name'), { target: { value: 'زبون تجربة' } });
  fireEvent.change(field('phone'), { target: { value: '0790000062' } });
  fireEvent.change(field('address'), { target: { value: 'شارع 5' } });
  fireEvent.click(screen.getByRole('button', { name: /المدينة|المحافظة/ }));
  fireEvent.click(screen.getByRole('button', { name: 'عمّان' }));
  fireEvent.submit(document.querySelector('form')!);
  await screen.findByText(N);
}
const purchases = () => trackEvent.mock.calls.filter((c) => c[0] === 'Purchase').map((c) => c[1]);

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the landing form, through the shared card', () => {
  it('«آه، زيدها لطلبي» → the one door, the server’s total in the header, one Purchase for the addition', async () => {
    // 24 is the server's answer, not 14 + 10; 10 is the server's added amount.
    await orderPlaced({ status: 200, body: { success: true, orderNumber: N, newTotal: 24, currency: 'JOD', addOn: { id: 'a1', productName: 'كريم', quantity: 1, price: 10, total: 10 } } });
    fireEvent.click(screen.getByRole('button', { name: 'آه، زيدها لطلبي' }));
    await screen.findByText('تمت الإضافة إلى طلبك ✅');

    const calls = vi.mocked(fetch).mock.calls as [string, RequestInit][];
    const add = calls.filter(([url]) => url.includes('/post-order-offer'));
    expect(add).toHaveLength(1);
    expect(add[0][0]).toBe(`/api/public/orders/${N}/post-order-offer`);
    expect(add[0][1].credentials).toBe('omit');
    expect(JSON.parse(String(add[0][1].body))).toStrictEqual({ token: TOKEN, offerId: OFFER.id });

    expect(screen.getByText('24 JOD'), 'الهيدر ما طبع إجمالي السيرفر').toBeTruthy();
    expect(screen.getByText('تم تحديث الإجمالي بعد الإضافة')).toBeTruthy();
    expect(purchases()).toEqual([
      { orderId: N, value: 14, currency: 'JOD' },
      { orderId: `${N}:${OFFER.id}`, value: 10, currency: 'JOD', contentName: 'كريم' },
    ]);
  });

  it('409 → the server’s sentence and the card closes; the header keeps the order’s own figure', async () => {
    await orderPlaced({ status: 409, body: { error: POST_ORDER_REFUSAL_AR.CONTACTED, reason: 'CONTACTED' } });
    fireEvent.click(screen.getByRole('button', { name: 'آه، زيدها لطلبي' }));
    expect(await screen.findByText(POST_ORDER_REFUSAL_AR.CONTACTED)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'آه، زيدها لطلبي' })).toBeNull();
    expect(screen.queryByText('تم تحديث الإجمالي بعد الإضافة')).toBeNull();
    expect(purchases()).toEqual([{ orderId: N, value: 14, currency: 'JOD' }]);
  });

  it('NEGATIVE: «لا شكراً» sends nothing and the card leaves', async () => {
    await orderPlaced({ status: 200, body: {} });
    fireEvent.click(screen.getByRole('button', { name: 'لا شكراً' }));
    expect(document.querySelector('.lp-upsell')).toBeNull();
    expect((vi.mocked(fetch).mock.calls as [string][]).filter(([url]) => url.includes('/post-order-offer'))).toEqual([]);
  });
});

describe('one card, and no second copy of it', () => {
  const form = () => stripComments(repoFile('src/components/landing/OrderForm.tsx'));
  const cart = () => stripComments(repoFile('src/components/storefront/CartThankYouOffer.tsx'));

  it('both doors draw `ThankYouOfferCard` and answer through `usePostOrderOffer`', () => {
    for (const [name, src] of [['OrderForm', form()], ['CartThankYouOffer', cart()]] as const) {
      expect(src, `${name} ما بيرسم البطاقة المشتركة`).toContain('<ThankYouOfferCard');
      expect(src, `${name} ما بيجاوب من خلال البطاقة المشتركة`).toContain('usePostOrderOffer(');
      expect(src, `${name} بيكتب باب الإضافة بحاله`).not.toContain('/api/public/orders/');
      expect(src, `${name} عنده زر إضافة خاص فيه`).not.toContain('آه، زيدها لطلبي');
    }
    // The basket's part sends nothing of its own at all.
    expect(cart(), 'جزء صفحة الشكر بيبعت طلبات بحاله').not.toContain('fetch(');
  });

  it('and no other screen spells the door or the answer', () => {
    // Every screen and page, so the next copy cannot hide in a file nobody thought to list.
    const root = process.cwd();
    const tsx = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) tsx(p, out);
        else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
      }
      return out;
    };
    const spelling = [...tsx(join(root, 'src', 'components')), ...tsx(join(root, 'src', 'app'))]
      .filter((p) => {
        const src = stripComments(readFileSync(p, 'utf8'));
        return src.includes('/api/public/orders/') || src.includes('آه، زيدها لطلبي');
      })
      .map((p) => relative(root, p).split(sep).join('/'));
    expect(spelling, 'نسخة تانية من العرض بعد الطلب').toEqual(['src/components/landing/ThankYouOfferCard.tsx']);
  });
});
