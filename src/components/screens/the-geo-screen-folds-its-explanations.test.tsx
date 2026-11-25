// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE BUTTON FOLDS THE LONG SENTENCES UNDER THE STORE BOXES (F6, the owner 23/11: «زر لاخفاء واظهار كل هالحكي»)
 *
 * What folds: the explanation under «السعر المُعلن يشمل التوصيل» and the one under «منصّة تجريب». What never folds: the boxes,
 * the row's buttons, «لا يُحذف — …» (it says why a button is missing), the warning about a store's orders, an error.
 * Shown by default; the choice is this browser's, and a storage that throws leaves the page shown and working.
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
vi.mock('@/components/geo/WarehousesCard', () => ({ WarehousesCard: () => null }));

import { GeoSettingsScreen } from './GeoSettingsScreen';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';

const KEY = 'salesflow.geoExplain';
const COUNTRY = {
  id: 'c1', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, workHoursStart: '09:00', workHoursEnd: '17:00',
  weekendDays: [5], timezone: 'Asia/Damascus', orderPrefix: 'ORD', allowNegativeStock: false, isActive: true,
  stores: [
    { id: 's1', name: 'المتجر الأول', slug: 'one', status: 'ACTIVE', type: 'MULTI_PRODUCT', priceIncludesDelivery: false, _count: { orders: 4 } },
  ],
  _count: { regions: 2, orders: 10 },
};
let benchRefusal: string | null = null;

const DELIVERY_SAID = /إذا كل طلباتك توصيلها مجاني/;
const BENCH_SAID = /وما بتنفتح للزوّار أبداً/;
const ORDERS_WARNING = /على المتجر 4 طلب/;
const REASON = /لا يُحذف — الطلبات \(4\)/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  benchRefusal = null;
  try { window.localStorage.clear(); } catch { /* the throwing case replaces it */ }
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/geo/countries') return { countries: [COUNTRY] };
    if (url === '/api/geo/stores/usage') return { stores: { s1: { blockers: [{ text: 'الطلبات (4)' }] } } };
    if (url === '/api/geo/countries/c1/regions') return { regions: [], usage: null };
    if (method === 'PATCH' && benchRefusal) throw new Error(benchRefusal);
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
  await screen.findByText('المتجر الأول');
  await screen.findByText(REASON);
};
const toggle = (name: string) => screen.getByRole('button', { name });
const keptAlways = () => {
  expect(screen.getByRole('checkbox', { name: /السعر المُعلن يشمل التوصيل/ })).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'منصّة تجريب' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'الهوية والواجهة' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'إيقاف مؤقت' })).toBeTruthy();
  expect(screen.getByText(REASON)).toBeTruthy();
  expect(screen.getByText(ORDERS_WARNING)).toBeTruthy();
};

describe('«إخفاء الشرح» on /settings/geo', () => {
  it('starts shown: both explanations are drawn and tied to their boxes, the button says «إخفاء الشرح»', async () => {
    await draw();
    const b = toggle('إخفاء الشرح');
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(DELIVERY_SAID)).toBeTruthy();
    expect(screen.getByText(BENCH_SAID)).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: /السعر المُعلن يشمل التوصيل/ });
    expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(DELIVERY_SAID);
    keptAlways();
  });

  it('hides ONLY the two explanations; shows them again on the second press', async () => {
    await draw();
    fireEvent.click(toggle('إخفاء الشرح'));
    expect(screen.queryByText(DELIVERY_SAID)).toBeNull();
    expect(screen.queryByText(BENCH_SAID)).toBeNull();
    keptAlways();
    // A box is not described by a sentence that is not there.
    for (const name of [/السعر المُعلن يشمل التوصيل/, 'منصّة تجريب']) {
      const box = screen.getByRole('checkbox', { name });
      expect(box.getAttribute('aria-describedby')).toBeNull();
    }
    const b = toggle('إظهار الشرح');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(b);
    expect(screen.getByText(DELIVERY_SAID)).toBeTruthy();
    expect(screen.getByText(BENCH_SAID)).toBeTruthy();
    expect(toggle('إخفاء الشرح')).toBeTruthy();
  });

  it('keeps an error under «منصّة تجريب» while the explanations are hidden', async () => {
    benchRefusal = 'ما بيصير تعلّم متجر الشركة الوحيد';
    await draw();
    fireEvent.click(toggle('إخفاء الشرح'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'منصّة تجريب' }));
    expect((await screen.findByRole('alert')).textContent).toBe(benchRefusal);
    expect(screen.queryByText(BENCH_SAID)).toBeNull();
  });

  it('remembers the choice in this browser: a new visit after hiding starts hidden', async () => {
    await draw();
    fireEvent.click(toggle('إخفاء الشرح'));
    expect(window.localStorage.getItem(KEY)).toBe('0');
    cleanup();
    await draw();
    expect(toggle('إظهار الشرح')).toBeTruthy();
    expect(screen.queryByText(DELIVERY_SAID)).toBeNull();
    fireEvent.click(toggle('إظهار الشرح'));
    expect(window.localStorage.getItem(KEY)).toBe('1');
  });

  it('NEGATIVE: a stored word that is not «0» does not hide anything', async () => {
    window.localStorage.setItem(KEY, 'garbage');
    await draw();
    expect(screen.getByText(DELIVERY_SAID)).toBeTruthy();
  });

  it('NEGATIVE: a storage that throws — the page draws, shown, and the button still folds it', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    await draw();
    expect(screen.getByText(DELIVERY_SAID)).toBeTruthy();
    fireEvent.click(toggle('إخفاء الشرح'));
    expect(screen.queryByText(DELIVERY_SAID)).toBeNull();
    keptAlways();
  });

  it('NEGATIVE: a write that throws on the press escapes nowhere — the page folds and the next press unfolds', async () => {
    await draw();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const escaped: unknown[] = [];
    const onError = (e: ErrorEvent) => { escaped.push(e.error); e.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      expect(() => fireEvent.click(toggle('إخفاء الشرح'))).not.toThrow();
      expect(screen.queryByText(DELIVERY_SAID)).toBeNull();
      expect(screen.queryByText(BENCH_SAID)).toBeNull();
      keptAlways();
      expect(() => fireEvent.click(toggle('إظهار الشرح'))).not.toThrow();
      expect(screen.getByText(DELIVERY_SAID)).toBeTruthy();
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(escaped).toEqual([]);
  });

  it('the add-store form keeps its «منصّة تجريب» sentence: the fold is for the store rows', async () => {
    await draw();
    fireEvent.click(toggle('إخفاء الشرح'));
    fireEvent.click(screen.getByRole('button', { name: /متجر في سوريا/ }));
    expect(screen.getAllByText(BENCH_SAID)).toHaveLength(1);
  });
});
