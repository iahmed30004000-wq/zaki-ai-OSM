// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OFFER'S «السعر شامل التوصيل» SAYS WHERE ITS «NO» IS HEARD — ON THE OFFER EDITOR (the owner, 1/11)
 *
 * His words: «إذا كل طلباتك توصيلها مجاني، شغّله ليشمل تلجرام والشيتات وصفحات البيع. بيغيّر ربحك … بس بدي اترك مجال لاضافة الطلب يدويا
 * او من اللاندنج انو اقدر احدد اذا شامل ولا لأ بظبط».
 *
 *  · an UNTICKED «السعر شامل التوصيل» says that the fee is added on the SALES PAGE — when every offer in the customer's basket is
 *    unticked — even where the store includes delivery; and what does not change that (a ticked offer or a product with no offer in the
 *    basket). The independent review (1/11) found the first wording claimed more: that the fee is added whatever the door, which is
 *    false for the order form's own box and for a mixed basket;
 *  · nothing is said while it is ticked, nor for the bundle shown AFTER the order (its own paragraph says the flag has no effect there).
 *    The store card's own sentence is held in `the-store-policy-says-what-it-covers.test.tsx`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { screenApi } = vi.hoisted(() => ({ screenApi: vi.fn() }));
vi.mock('@/lib/screen-api', () => ({ screenApi }));

import { ProductOffers } from './ProductOffers';

const PRODUCT_ID = 'prod-aaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  screenApi.mockImplementation(async (_path: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return { offers: [], minorUnit: 2 };
    return { success: true };
  });
});
afterEach(cleanup);

async function openNewOffer() {
  const user = userEvent.setup();
  render(<ProductOffers productId={PRODUCT_ID} basePrice={20} currency="USD" />);
  await waitFor(() => expect(screen.getByText('عرض جديد')).toBeTruthy());
  await user.click(screen.getByText('عرض جديد'));
  return user;
}
const box = () => screen.getByRole('checkbox', { name: /السعر شامل التوصيل/ }) as HTMLInputElement;
/** The hint is one paragraph with a bold span inside it, so it is found by the paragraph's whole text. */
const hint = () =>
  Array.from(document.querySelectorAll('p')).find((p) =>
    /صفحة البيع[\s\S]*حتى لو[\s\S]*إعداد المتجر[\s\S]*مفعَّلاً/.test((p.textContent ?? '').replace(/\s+/g, ' '))
  ) ?? null;

describe('the offer editor', () => {
  it('a new offer opens ticked (the column’s default) and says nothing about the store', async () => {
    await openNewOffer();
    expect(box().checked).toBe(true);
    expect(hint()).toBeNull();
  });

  it('unticking it says WHERE the fee is added — the sales page, every offer in the basket unticked, even in a store that includes delivery', async () => {
    const user = await openNewOffer();
    await user.click(box());
    expect(box().checked).toBe(false);
    const text = (hint()?.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('صفحة البيع');
    expect(text).toContain('كل عروض سلّته غير مؤشَّرة');
    // …and what keeps it from applying, so it is not read as a promise about every order:
    expect(text).toContain('عرض مؤشَّر أو منتج بلا عرض');
    // NEGATIVE: it does not claim to beat the order form's own box, and it no longer says an offer beats the store everywhere.
    expect(text).not.toContain('كلمة العرض تغلب إعداد المتجر');
    await user.click(box());
    expect(hint()).toBeNull();
  });

  it('NEGATIVE: for the bundle shown AFTER the order the flag has no effect, and the hint is not drawn beside a paragraph that says so', async () => {
    const user = await openNewOffer();
    await user.click(box()); // unticked
    expect(hint()).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: /العرض بعد الطلب/ }));
    expect(hint()).toBeNull();
    expect(screen.getByText(/لا أثر له هنا/)).toBeTruthy();
  });
});
