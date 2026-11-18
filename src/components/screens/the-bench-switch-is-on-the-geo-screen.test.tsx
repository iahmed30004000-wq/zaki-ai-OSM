// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SWITCH «منصّة تجريب» IS ON THE SCREEN THAT TELLS THE OWNER TO LOOK FOR IT (B1, 18/11)
 *
 * The bench screen said «علّم متجراً منصّة تجريب من الإعدادات ← البلدان والمتاجر» and that screen had no such field.
 * Nothing behind the sign-in can be clicked from here (the second factor is the owner's), so what a person would see
 * and press is proved by rendering the real screen against a fake door:
 *   · a real checkbox with a real label, on every store, with ONE sentence under it that the checkbox is described by;
 *   · ticking it writes `isTest` and nothing else; the door's refusal appears under the box, inline;
 *   · a store with orders says what the switch will do to them BEFORE the press (a sentence, no dialog);
 *   · the creation form carries it too; a person who may only look gets it disabled;
 *   · the bench screen's pointer is a link now.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, refresh, who } = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  who: { permissions: ['geo.view', 'geo.manage'] as string[] },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/settings/geo',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', role: 'COMPANY_ADMIN', permissions: who.permissions } }),
}));
vi.mock('@/components/settings/StorefrontSettings', () => ({ StorefrontSettings: () => null }));
vi.mock('@/components/settings/StoreIdentityCard', () => ({ StoreIdentityCard: () => null }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => null }));

import { GeoSettingsScreen } from './GeoSettingsScreen';
import { BenchScreen } from './BenchScreen';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';

type StoreFixture = Record<string, unknown>;
const store = (over: StoreFixture = {}): StoreFixture => ({
  id: 's1', name: 'متجر صحة بلس', slug: 'saha', status: 'ACTIVE', type: 'MULTI_PRODUCT', priceIncludesDelivery: false,
  isTest: false, storefrontEnabled: false, _count: { orders: 0 }, ...over,
});
const country = (stores: StoreFixture[]) => ({
  id: 'c1', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, workHoursStart: '09:00', workHoursEnd: '17:00',
  weekendDays: [5], timezone: 'Asia/Damascus', orderPrefix: 'ORD', allowNegativeStock: false, isActive: true,
  stores, _count: { regions: 2, orders: 10 },
});

let stores: StoreFixture[];
let calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
/** What the fake PATCH answers: null = taken; a string = the door's refusal sentence. */
let refusal: string | null;

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  refusal = null;
  who.permissions = ['geo.view', 'geo.manage'];
  stores = [store()];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/geo/countries') return { countries: [country(stores)] };
    if (url === '/api/geo/stores/usage') return { stores: {} };
    if (url === '/api/geo/countries/c1/regions') return { regions: [], usage: null };
    if (method === 'PATCH' || method === 'POST') {
      if (refusal) throw new Error(refusal);
      return { success: true };
    }
    if (url === '/api/growth/bench') return { currency: 'USD', benches: [], results: [], excluded: null, dna: { sellers: 0, minSellers: 10, traits: null, whyNot: null } };
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
const box = () => screen.getByRole('checkbox', { name: 'منصّة تجريب' }) as HTMLInputElement;
const patches = () => calls.filter((c) => c.method === 'PATCH');

describe('the box on a store', () => {
  it('is a real checkbox with a real label, unticked for an ordinary store, and described by ONE plain sentence', async () => {
    await draw();
    expect(box().checked).toBe(false);
    const said = document.getElementById(box().getAttribute('aria-describedby')!)!;
    const text = (said.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('بتتأكد متل أي متجر');
    expect(text).toContain('شاشة منصّة التجريب');
    expect(text).toContain('ما بتنفتح للزوّار');
    // One sentence: a single full stop at most, none in the middle.
    expect(text.replace(/\.$/, '')).not.toContain('.');
  });

  it('comes back ticked, and marked beside the store’s address, for a store that is a bench', async () => {
    stores = [store({ isTest: true })];
    await draw();
    expect(box().checked).toBe(true);
    expect(screen.getByText(/\/saha ·/).textContent).toContain('منصّة تجريب');
  });

  it('NEGATIVE: an ordinary store’s address line does not carry the mark', async () => {
    await draw();
    expect(screen.getByText(/\/saha ·/).textContent).not.toContain('منصّة تجريب');
  });

  it('ticking it writes isTest and only that', async () => {
    await draw();
    fireEvent.click(box());
    await vi.waitFor(() => expect(patches().length).toBe(1));
    expect(patches()[0].url).toBe('/api/geo/stores/s1');
    expect(patches()[0].body).toEqual({ isTest: true });
  });

  it('is operable from the keyboard: a label that names it, and a person who may only look finds it disabled', async () => {
    who.permissions = ['geo.view'];
    await draw();
    expect(box().disabled).toBe(true);
    fireEvent.click(box());
    expect(patches().length).toBe(0);
  });
});

describe('the door’s refusal is shown under the box', () => {
  it('as an alert with the sentence the door gave, and the box stays as stored', async () => {
    refusal = 'المتجر مفتوح للزوّار — سكّر واجهة المتجر أول، المنصّة ما بتنفتح للزوّار';
    await draw();
    fireEvent.click(box());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(refusal);
    expect(box().checked).toBe(false);
  });

  it('a second, accepted press clears the old sentence', async () => {
    refusal = 'هذا متجرك الحقيقي الوحيد';
    await draw();
    fireEvent.click(box());
    await screen.findByRole('alert');
    refusal = null;
    fireEvent.click(box());
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('a store that already holds orders says what the switch changes — before the press', () => {
  it('an ordinary store: the orders leave the company’s figures and are counted on the bench screen', async () => {
    stores = [store({ _count: { orders: 12 } })];
    await draw();
    const text = (box().closest('div')!.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('على المتجر 12 طلب');
    expect(text).toContain('بتطلع طلباته من أرقام الشركة');
    expect(text).toContain('بتنعدّ بشاشة المنصّة');
    // A sentence, not a dialog: nothing to confirm, and the press still writes at once.
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(box());
    await vi.waitFor(() => expect(patches().length).toBe(1));
  });

  it('a bench: the reverse', async () => {
    stores = [store({ isTest: true, _count: { orders: 3 } })];
    await draw();
    const text = (box().closest('div')!.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('على المتجر 3 طلب');
    expect(text).toContain('بترجع طلباته تنعدّ بأرقام الشركة');
    expect(text).not.toContain('بتطلع طلباته من أرقام الشركة');
  });

  it('NEGATIVE: a store with no orders says nothing about them', async () => {
    await draw();
    expect((box().closest('div')!.textContent ?? '')).not.toContain('على المتجر');
  });
});

describe('the creation form carries it too', () => {
  const openForm = async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /متجر في سوريا/ }));
  };
  const fill = () => {
    const form = document.querySelector('form')!;
    const [name, slug] = Array.from(form.querySelectorAll('input[required]')) as HTMLInputElement[];
    fireEvent.change(name, { target: { value: 'منصة الاختبار' } });
    fireEvent.change(slug, { target: { value: 'bench-one' } });
    return form;
  };

  it('ticked, it sends isTest: true with the rest', async () => {
    await openForm();
    // Two boxes now exist (the store's and the form's): the form's is the one inside the <form>.
    const form = fill();
    fireEvent.click(within(form).getByRole('checkbox', { name: 'منصّة تجريب' }));
    fireEvent.submit(form);
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      countryId: 'c1', name: 'منصة الاختبار', slug: 'bench-one', type: 'MULTI_PRODUCT', isTest: true,
    });
  });

  it('NEGATIVE: left alone, it sends isTest: false — a new store is a real one', async () => {
    await openForm();
    const form = fill();
    expect((within(form).getByRole('checkbox', { name: 'منصّة تجريب' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.submit(form);
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body!.isTest).toBe(false);
  });
});

describe('the bench screen’s pointer now leads somewhere true', () => {
  it('names the place and links to it', async () => {
    render(<BenchScreen />);
    const link = await screen.findByRole('link', { name: 'افتح البلدان والمتاجر' });
    expect(link.getAttribute('href')).toBe('/settings/geo');
    expect(screen.getByText(/علامة «منصّة تجريب» من الإعدادات ← البلدان والمتاجر/)).toBeTruthy();
  });
});
