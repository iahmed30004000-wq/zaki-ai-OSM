// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE STORE'S «السعر المُعلن يشمل التوصيل» SAYS WHAT IT COVERS (the owner, 1/11)
 *
 * His words: «إذا كل طلباتك توصيلها مجاني، شغّله ليشمل تلجرام والشيتات وصفحات البيع. بيغيّر ربحك … بس بدي اترك مجال لاضافة الطلب يدويا
 * او من اللاندنج انو اقدر احدد اذا شامل ولا لأ بظبط».
 *
 * The checkbox had no explanation at all: turning it on silently changed what every Telegram message, sheet row and sales page asks
 * the customer for. The sentence under it names the three doors, says the profit moves, and says who beats it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, refresh } = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/settings/geo',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['geo.view', 'geo.manage'] } }),
}));
vi.mock('@/components/settings/StorefrontSettings', () => ({ StorefrontSettings: () => null }));
vi.mock('@/components/settings/StoreIdentityCard', () => ({ StoreIdentityCard: () => null }));

import { GeoSettingsScreen } from './GeoSettingsScreen';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';

const COUNTRY = {
  id: 'c1', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, workHoursStart: '09:00', workHoursEnd: '17:00',
  weekendDays: [5], timezone: 'Asia/Damascus', orderPrefix: 'ORD', allowNegativeStock: false, isActive: true,
  stores: [{ id: 's1', name: 'متجر صحة بلس', slug: 'saha', status: 'ACTIVE', type: 'MULTI_PRODUCT', priceIncludesDelivery: false }],
  _count: { regions: 2, orders: 10 },
};
let calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/geo/countries') return { countries: [COUNTRY] };
    if (url === '/api/geo/stores/usage') return { stores: {} };
    if (url === '/api/geo/countries/c1/regions') return { regions: [], usage: null };
    if (method === 'PATCH') return { success: true };
    throw new Error(`unexpected ${method} ${url}`);
  });
});
afterEach(cleanup);

const draw = async () => {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <GeoSettingsScreen />
      </ConfirmProvider>
    </ToastProvider>
  );
  await screen.findByText('متجر صحة بلس');
};

describe('the checkbox under a store', () => {
  it('is followed by what turning it on covers, in the owner’s order: the three doors, the profit, who beats it', async () => {
    await draw();
    const checkbox = screen.getByRole('checkbox', { name: /السعر المُعلن يشمل التوصيل/ });
    const sentence = checkbox.closest('div')!.querySelector('p.leading-relaxed');
    expect(sentence, 'the help sentence is not drawn under the checkbox').toBeTruthy();
    const text = (sentence!.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('إذا كل طلباتك توصيلها مجاني');
    for (const door of ['تلجرام', 'الشيتات', 'صفحات البيع']) expect(text, door).toContain(door);
    expect(text).toContain('بيغيّر ربحك');
    expect(text).toContain('أجرة التوصيل بتنخصم من الإيراد');
    // The two places that beat it, named as the screens call them.
    expect(text).toContain('شامل التوصيل');
    expect(text).toContain('السعر شامل التوصيل');
    expect(text).toContain('كلمتهم بتغلب هاد الإعداد');
    // And that it is not retroactive.
    expect(text).toContain('الطلبات اللي انكتبت قبل ما تغيّره بتضل متل ما هي');
  });

  it('ticking it still writes the store’s flag, and only that', async () => {
    await draw();
    fireEvent.click(screen.getByRole('checkbox', { name: /السعر المُعلن يشمل التوصيل/ }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ priceIncludesDelivery: true });
  });
});
