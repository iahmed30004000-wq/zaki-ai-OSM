// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OFFER'S «السعر شامل التوصيل», AND THE STORE'S «السعر المُعلن يشمل التوصيل» — ON THE SCREEN (the owner, 1/11)
 *
 * His words: «إذا كل طلباتك توصيلها مجاني، شغّله ليشمل تلجرام والشيتات وصفحات البيع. بيغيّر ربحك … بس بدي اترك مجال لاضافة الطلب يدويا
 * او من اللاندنج انو اقدر احدد اذا شامل ولا لأ بظبط».
 *
 *  · under the store's checkbox, the sentence that says what it covers (Telegram, the sheets, the sales pages), that it changes the
 *    profit, and that the order form's box and each offer's box beat it — so the setting is not turned on blind;
 *  · on the offer editor, an UNTICKED «السعر شامل التوصيل» says that the fee is added even where the store includes delivery — and
 *    nothing is said while it is ticked.
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
  Array.from(document.querySelectorAll('p')).find((p) => /حتى لو[\s\S]*إعداد المتجر[\s\S]*مفعَّلاً/.test((p.textContent ?? '').replace(/\s+/g, ' '))) ??
  null;

describe('the offer editor', () => {
  it('a new offer opens ticked (the column’s default) and says nothing about the store', async () => {
    await openNewOffer();
    expect(box().checked).toBe(true);
    expect(hint()).toBeNull();
  });

  it('unticking it says the fee is added even where the store includes delivery — and ticking it again takes the sentence away', async () => {
    const user = await openNewOffer();
    await user.click(box());
    expect(box().checked).toBe(false);
    expect(hint()).toBeTruthy();
    expect(hint()!.textContent).toContain('كلمة العرض تغلب إعداد المتجر');
    await user.click(box());
    expect(hint()).toBeNull();
  });
});
