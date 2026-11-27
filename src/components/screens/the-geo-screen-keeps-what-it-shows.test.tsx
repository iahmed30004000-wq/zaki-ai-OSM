// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «البلدان والمتاجر» KEEPS EVERY CONTROL IT HAD WHEN IT MOVED ONTO THE KIT (R15b, 18/11)
 *
 * Written and measured against osm/main BEFORE the screen changed, then kept green after: the same fixture, the same
 * presses, the same number of buttons, fields, ticks and links at every step — the whole screen, the country's settings
 * open, a store's identity panel open (the REAL identity card and storefront panel, not mocks), and both creation forms.
 * What a person who may only look sees is counted too: the delete controls are the manager's and stay the manager's.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, refresh, who } = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  who: { permissions: ['geo.view', 'geo.manage'] as string[] },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
// 19/11 (W0b): the screen gained «المخازن» under each country — its own card, with its own door and its own test
// (`geo/WarehousesCard.test.tsx`). Drawn as nothing here, so what THIS file counts and presses stays what it was.
vi.mock('@/components/geo/WarehousesCard', () => ({ WarehousesCard: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/settings/geo',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', role: 'COMPANY_ADMIN', permissions: who.permissions } }),
}));

import { GeoSettingsScreen } from './GeoSettingsScreen';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';

const stores = () => [
  {
    id: 's1', name: 'متجر فاضي', slug: 'empty', status: 'ACTIVE', type: 'MULTI_PRODUCT', priceIncludesDelivery: true,
    isTest: false, storefrontEnabled: true, logo: '/x/logo.png', favicon: null, supportPhone: '0999000000', _count: { orders: 0 },
  },
  {
    id: 's2', name: 'متجر شغّال', slug: 'busy', status: 'PAUSED', type: 'MULTI_PRODUCT', priceIncludesDelivery: false,
    isTest: true, storefrontEnabled: false, logo: null, _count: { orders: 4 },
  },
];
const country = () => ({
  id: 'c1', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, workHoursStart: '09:00', workHoursEnd: '17:00',
  weekendDays: [5], timezone: 'Asia/Damascus', orderPrefix: 'ORD', allowNegativeStock: false, isActive: true,
  stores: stores(), _count: { regions: 2, orders: 0 },
});

beforeEach(() => {
  vi.clearAllMocks();
  who.permissions = ['geo.view', 'geo.manage'];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/geo/countries' && method === 'GET') return { countries: [country()] };
    if (url === '/api/geo/stores/usage') return { stores: { s1: { blockers: [] }, s2: { blockers: [{ text: 'الطلبات (4)' }] } } };
    if (url === '/api/geo/countries/c1/regions') {
      return {
        regions: [{ id: 'r1', name: 'دمشق' }, { id: 'r2', name: 'حلب' }],
        usage: who.permissions.includes('geo.manage') ? { r1: [], r2: [{ text: 'الطلبات (3)' }] } : null,
      };
    }
    if (url === '/api/context') return { stores: [], selection: null };
    return { success: true };
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
  await screen.findByText('متجر فاضي');
  if (who.permissions.includes('geo.manage')) await screen.findByText(/لا يُحذف —/);
};

/** What a person can press, type into, tick or follow — counted from the DOM, the same way on both sides of the change. */
const census = () => {
  const inputs = Array.from(document.querySelectorAll('input'));
  return {
    buttons: document.querySelectorAll('button').length,
    ticks: inputs.filter((i) => i.type === 'checkbox').length,
    fields: inputs.filter((i) => i.type !== 'checkbox').length + document.querySelectorAll('select, textarea').length,
    links: document.querySelectorAll('a[href]').length,
    headings: document.querySelectorAll('h1').length,
  };
};

// 23/11 (F6, «إخفاء الشرح»): every button count is ONE more than it was (8→9, 18→19, 12→13, 10→11, 9→10, 16→17) — the
// page's one new button that folds the explanations under the store boxes. Ticks, fields, links and headings are unchanged.
describe('the census, step by step (the same numbers before and after the kit)', () => {
  it('the screen as it opens: new country, two stores each with identity/pause, one delete, the add-store row', async () => {
    await draw();
    expect(census()).toEqual({ buttons: 9, ticks: 4, fields: 0, links: 0, headings: 1 });
  });

  it('with the country’s settings open: currency, two clocks, seven days, prefix, zone, two flags, the cities', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'الإعدادات' }));
    await screen.findByText('دمشق');
    expect(census()).toEqual({ buttons: 19, ticks: 6, fields: 7, links: 0, headings: 1 });
  });

  it('with a store’s identity and storefront panel open (the real cards)', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'الهوية والواجهة' })[0]);
    await screen.findByText('هوية المتجر');
    // 26/11 «زر واتساب بالمتجر» inside the identity card: its two choices and its number (+3 fields) and its own save (+1 button).
    expect(census()).toEqual({ buttons: 14, ticks: 4, fields: 7, links: 4, headings: 1 });
  });

  it('with the new-country form open (one form at a time: the screen holds one «adding»)', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /بلد جديد/ }));
    expect(document.querySelectorAll('form').length).toBe(1);
    expect(census()).toEqual({ buttons: 11, ticks: 4, fields: 4, links: 0, headings: 1 });
  });

  it('with the new-store form open', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /متجر في سوريا/ }));
    expect(document.querySelectorAll('form').length).toBe(1);
    expect(census()).toEqual({ buttons: 10, ticks: 5, fields: 2, links: 0, headings: 1 });
  });

  it('NEGATIVE: a person who may only look gets no delete control and no cross on a city — and the same ticks', async () => {
    who.permissions = ['geo.view'];
    await draw();
    expect(screen.queryByRole('button', { name: /حذف المتجر/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'الإعدادات' }));
    await screen.findByText('دمشق');
    expect(screen.queryByRole('button', { name: /حذف المحافظة/ })).toBeNull();
    const c = census();
    expect(c.ticks).toBe(6);
    expect(c.buttons).toBe(17);
  });

  it('the identity card saves the name only when it changed, and sends only that', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'الهوية والواجهة' })[0]);
    const card = (await screen.findByText('هوية المتجر')).closest('li')!;
    const save = within(card).getByRole('button', { name: 'حفظ' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText('اسم المتجر'), { target: { value: 'متجر جديد' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await vi.waitFor(() => expect(api.mock.calls.some(([u, i]) => u === '/api/geo/stores/s1' && i?.method === 'PATCH')).toBe(true));
    const [, init] = api.mock.calls.find(([u, i]) => u === '/api/geo/stores/s1' && i?.method === 'PATCH')!;
    expect(JSON.parse(String(init.body))).toEqual({ name: 'متجر جديد' });
  });

  it('the storefront panel keeps its links to /store and to the live storefront', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'الهوية والواجهة' })[0]);
    await screen.findByText('هوية المتجر');
    const hrefs = Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/s/empty', '/store', '/store?tab=address&sec=domain', '/store?tab=front&sec=look']);
  });
});
