// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hitsOf } from '../../../scripts/ui-debt';
import { findRoute } from '@/lib/route-registry';
import { CART_STATUSES } from '@/lib/abandoned-cart-rules';

/**
 * «زبائن ما كمّلوا» (R10c, 18/11) — THE CARTS AND THE PAGES' LEADS, ONE SCREEN OF THREE TABS.
 *
 * The owner: the carts and the page leads keep the same thing — a visitor left a name and a phone and did not order — so ONE
 * screen: «جديدة» · «كل السلات» (one status at a time, the door filters one) · «ليدز الصفحات» (the lane's own door, only for who
 * may pull or supervise). Both data sources and both doors stay; this file holds what each tab asks and draws, who sees the third,
 * the presses on a row, the two settings on the kit's controls with the same bodies, and the cart page's date box on the kit.
 */

const { api, params, user } = vi.hoisted(() => ({
  api: vi.fn(),
  params: { current: new URLSearchParams() },
  user: { current: { id: 'u1', role: 'CONFIRMATION_AGENT', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => params.current,
  usePathname: () => '/abandoned-carts',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current, t: {}, locale: 'ar' }) }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), failed: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));

import { AbandonedCartsScreen } from './AbandonedCartsScreen';
import { AbandonedCartDetailScreen } from './AbandonedCartDetailScreen';

const ALL = { work: true, note: true, assign: true, convert: true, settings: true };

const cart = (over: Record<string, unknown> = {}) => ({
  id: 'c1', externalId: 'x1', landingPageName: 'صفحة', landingPageUrl: null, productId: 'p1', productName: 'كريم',
  customerName: 'زائر أول', phone: '0930000001', phoneShown: '0930000001', city: 'دمشق', country: 'SY',
  firstSeenAt: '2026-11-18T08:00:00.000Z', lastSeenAt: '2026-11-18T09:00:00.000Z', status: 'NEW', attempts: 0,
  nextFollowUpAt: null, region: null, assignedTo: null, order: null, hasOrder: null, ...over,
});

const FACTS = { all: 12, NEW: 3, CONTACTED: 2, NO_ANSWER: 4, CALLBACK: 1, NOT_INTERESTED: 1, INVALID: 0, CONVERTED: 1, RECOVERED: 0 };

const listBody = { carts: [cart()], pagination: { page: 1, totalPages: 1, total: 1, limit: 25 }, facts: FACTS, products: [], people: [], dialCode: '963', may: ALL };
const LEADS = { enabled: true, leads: [{ id: 'L1', fullName: 'ليد تجريبي', phone: '0930000002', city: null, productName: 'كريم', receivedAt: new Date().toISOString(), recentOrder: false, offers: [] }] };

function answer(url: string) {
  if (url.startsWith('/api/abandoned-carts/settings')) return Promise.resolve({ retentionDays: 30, autoConvert: true });
  if (url.startsWith('/api/abandoned-carts')) return Promise.resolve(listBody);
  if (url.startsWith('/api/confirmation/leads')) return Promise.resolve(LEADS);
  return Promise.reject(new Error(`unexpected ${url}`));
}

const cartReads = () => api.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/abandoned-carts?'));
const lastCartRead = () => new URL(`https://x.test${cartReads().at(-1)}`).searchParams;
const leadReads = () => api.mock.calls.filter((c) => String(c[0]) === '/api/confirmation/leads' && !c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation((url: string, init?: unknown) => (init ? Promise.resolve({ autoConvert: false, retentionDays: 45 }) : answer(url)));
  params.current = new URLSearchParams();
  user.current = { id: 'u1', role: 'CONFIRMATION_AGENT', permissions: ['orders.view', 'confirmation.pull'], status: 'ACTIVE' };
});
afterEach(cleanup);

describe('one screen, three tabs, the right door for each', () => {
  it('is named from the registry «زبائن ما كمّلوا» and opens on «جديدة», which reads the NEW carts', async () => {
    render(<AbandonedCartsScreen />);
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['زبائن ما كمّلوا']);
    expect(findRoute('/abandoned-carts')!.label).toBe('زبائن ما كمّلوا');
    await screen.findAllByText('زائر أول');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['جديدة3', 'كل السلات12', 'ليدز الصفحات']);
    expect(screen.getByRole('tab', { name: /جديدة/ }).getAttribute('aria-selected')).toBe('true');
    expect(lastCartRead().get('status')).toBe('NEW');
    // «جديدة» is one status already: no status picker there
    expect(screen.queryByLabelText('الحالة')).toBeNull();
    expect(leadReads()).toHaveLength(0);
  });

  it('«كل السلات» reads every status, and its picker sets ONE status (every status of the rules, with its count)', async () => {
    render(<AbandonedCartsScreen />);
    await screen.findAllByText('زائر أول');
    fireEvent.click(screen.getByRole('tab', { name: /كل السلات/ }));
    await waitFor(() => expect(lastCartRead().has('status')).toBe(false));
    const picker = screen.getByLabelText('الحالة') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['', ...CART_STATUSES]);
    expect([...picker.options].find((o) => o.value === 'NO_ANSWER')!.textContent).toBe('ما رد (4)');
    expect(picker.multiple).toBe(false);
    fireEvent.change(picker, { target: { value: 'NO_ANSWER' } });
    await waitFor(() => expect(lastCartRead().get('status')).toBe('NO_ANSWER'));
  });

  it('«ليدز الصفحات» is the lane, on its own door — and `?tab=leads` opens it', async () => {
    params.current = new URLSearchParams('tab=leads');
    render(<AbandonedCartsScreen />);
    expect(await screen.findAllByText('ليد تجريبي')).not.toHaveLength(0);
    expect(screen.getByRole('tab', { name: 'ليدز الصفحات' }).getAttribute('aria-selected')).toBe('true');
    expect(leadReads().length).toBeGreaterThan(0);
    // the carts' own toolbar and settings belong to the carts' tabs
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('`?tab=all` opens «كل السلات»; an unknown tab opens «جديدة»', async () => {
    params.current = new URLSearchParams('tab=all');
    render(<AbandonedCartsScreen />);
    await screen.findAllByText('زائر أول');
    expect(screen.getByRole('tab', { name: /كل السلات/ }).getAttribute('aria-selected')).toBe('true');
    cleanup();
    params.current = new URLSearchParams('tab=x');
    render(<AbandonedCartsScreen />);
    await screen.findAllByText('زائر أول');
    expect(screen.getByRole('tab', { name: /جديدة/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('a supervisor without `confirmation.pull` has the leads tab too (the door takes either key)', async () => {
    user.current = { ...user.current, permissions: ['orders.view', 'confirmation.supervise'] };
    render(<AbandonedCartsScreen />);
    await screen.findAllByText('زائر أول');
    expect(screen.getByRole('tab', { name: 'ليدز الصفحات' })).toBeTruthy();
  });

  it('NEGATIVE: without `confirmation.pull` or `confirmation.supervise` there is no leads tab, and `?tab=leads` opens «جديدة» and never asks the lane', async () => {
    user.current = { ...user.current, permissions: ['orders.view'] };
    params.current = new URLSearchParams('tab=leads');
    render(<AbandonedCartsScreen />);
    await screen.findAllByText('زائر أول');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['جديدة3', 'كل السلات12']);
    expect(screen.getByRole('tab', { name: /جديدة/ }).getAttribute('aria-selected')).toBe('true');
    expect(leadReads()).toHaveLength(0);
  });

  it('NEGATIVE: without `orders.view` nothing is read at all', () => {
    user.current = { ...user.current, permissions: ['confirmation.pull'] };
    render(<AbandonedCartsScreen />);
    expect(screen.getByText(/ما عندك صلاحية/)).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });
});

describe('a row keeps every press it had', () => {
  it('call · WhatsApp · «ما رد» · the status picker · «حوّل لطلب» · «التفاصيل» — one each, the same as before R10c', async () => {
    render(<AbandonedCartsScreen />);
    await screen.findAllByText('زائر أول');
    const card = document.querySelector('ul li') as HTMLElement;
    const r = within(card);
    expect(r.getAllByRole('link', { name: /اتصال/ })).toHaveLength(1);
    expect(r.getAllByRole('link', { name: /واتساب/ })).toHaveLength(1);
    expect(r.getAllByRole('button', { name: 'ما رد' })).toHaveLength(1);
    expect(r.getAllByRole('combobox', { name: 'حالة السلة' })).toHaveLength(1);
    expect(r.getAllByRole('button', { name: /حوّل لطلب/ })).toHaveLength(1);
    expect(r.getAllByRole('button', { name: 'التفاصيل' })).toHaveLength(1);
    // and nothing more: six presses, plus the name's link to the cart page
    expect(r.getAllByRole('button')).toHaveLength(3);
    expect(r.getAllByRole('combobox')).toHaveLength(1);
  });

  it('the lead and the cart say the SAME words for the press that makes an order', async () => {
    const lane = readFileSync(join(process.cwd(), 'src/components/screens/LeadsLane.tsx'), 'utf8');
    const parts = readFileSync(join(process.cwd(), 'src/components/carts/cart-parts.tsx'), 'utf8');
    expect(parts).toContain('حوّل لطلب');
    expect(lane).toContain('حوّل لطلب');
  });
});

describe('the carts settings, on the kit, with the same bodies', () => {
  it('the auto-convert switch is the kit Switch (a named id) and sends `{ autoConvert }` exactly', async () => {
    render(<AbandonedCartsScreen />);
    // the list's answer carries who may flip it: wait for it, as a person does
    await screen.findAllByText('زائر أول');
    const sw = (await screen.findByRole('switch')) as HTMLInputElement;
    await waitFor(() => expect(sw.disabled).toBe(false));
    expect(sw.id).toBe('cart-auto-convert');
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    await waitFor(() => expect(api.mock.calls.some((c) => c[1])).toBe(true));
    const [url, init] = api.mock.calls.find((c) => c[1])!;
    expect(url).toBe('/api/abandoned-carts/settings');
    expect((init as RequestInit).method).toBe('PUT');
    expect((init as RequestInit).body).toBe(JSON.stringify({ autoConvert: false }));
  });

  it('the retention box is the kit Input (a named id) and «احفظ المدة» sends `{ retentionDays }` exactly', async () => {
    render(<AbandonedCartsScreen />);
    const box = (await screen.findByLabelText('مدة الحفظ بالأيام')) as HTMLInputElement;
    expect(box.id).toBe('cart-retention-days');
    fireEvent.change(box, { target: { value: '45' } });
    fireEvent.click(screen.getByText('احفظ المدة'));
    await waitFor(() => expect(api.mock.calls.some((c) => c[1])).toBe(true));
    const [url, init] = api.mock.calls.find((c) => c[1])!;
    expect(url).toBe('/api/abandoned-carts/settings');
    expect((init as RequestInit).body).toBe(JSON.stringify({ retentionDays: 45 }));
  });

  it('NEGATIVE: who may not edit the settings sees the switch shut and no retention box', async () => {
    api.mockImplementation((url: string) =>
      url.startsWith('/api/abandoned-carts?') ? Promise.resolve({ ...listBody, may: { ...ALL, settings: false } }) : answer(url)
    );
    render(<AbandonedCartsScreen />);
    await screen.findAllByText('زائر أول');
    const sw = (await screen.findByRole('switch')) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(screen.queryByLabelText('مدة الحفظ بالأيام')).toBeNull();
  });
});

describe('the cart page', () => {
  const detail = {
    cart: { ...cart({ nextFollowUpAt: null }), source: 'lp', landingPageId: null, createdAt: '2026-11-18T08:00:00.000Z', order: null, activities: [] },
    people: [{ id: 'p2', name: 'موظف' }],
    dialCode: '963',
    may: ALL,
  };

  beforeEach(() => {
    api.mockImplementation((url: string, init?: unknown) => (init ? Promise.resolve({ ok: true }) : url === '/api/abandoned-carts/c1' ? Promise.resolve(detail) : answer(url)));
  });

  it('the follow-up box is the kit Input and «احفظ» sends the body the raw box sent, byte for byte', async () => {
    render(<AbandonedCartDetailScreen id="c1" />);
    const box = (await screen.findByLabelText('موعد المتابعة')) as HTMLInputElement;
    expect(box.id).toBe('cart-follow-up-at');
    expect(box.type).toBe('datetime-local');
    fireEvent.change(box, { target: { value: '2026-11-20T10:30' } });
    fireEvent.click(screen.getByText('احفظ'));
    await waitFor(() => expect(api.mock.calls.some((c) => c[1])).toBe(true));
    const [url, init] = api.mock.calls.find((c) => c[1])!;
    expect(url).toBe('/api/abandoned-carts/c1');
    expect((init as RequestInit).method).toBe('PATCH');
    expect((init as RequestInit).body).toBe(JSON.stringify({ action: 'follow_up', at: new Date('2026-11-20T10:30').toISOString() }));
  });

  it('an empty box still sends `at: null` (the «remove the date» press)', async () => {
    render(<AbandonedCartDetailScreen id="c1" />);
    await screen.findByLabelText('موعد المتابعة');
    fireEvent.click(screen.getByText('احفظ'));
    await waitFor(() => expect(api.mock.calls.some((c) => c[1])).toBe(true));
    expect((api.mock.calls.find((c) => c[1])![1] as RequestInit).body).toBe(JSON.stringify({ action: 'follow_up', at: null }));
  });

  it('the assignee is the kit Select and sends `{ action: assign, userId }` exactly', async () => {
    render(<AbandonedCartDetailScreen id="c1" />);
    const pick = (await screen.findByLabelText('المسؤول')) as HTMLSelectElement;
    expect(pick.id).toBe('cart-assignee');
    fireEvent.change(pick, { target: { value: 'p2' } });
    await waitFor(() => expect(api.mock.calls.some((c) => c[1])).toBe(true));
    expect((api.mock.calls.find((c) => c[1])![1] as RequestInit).body).toBe(JSON.stringify({ action: 'assign', userId: 'p2' }));
  });

  it('«غير مسندة» sends `userId: null` (taking the cart off a person)', async () => {
    api.mockImplementation((url: string, init?: unknown) =>
      init ? Promise.resolve({ ok: true }) : url === '/api/abandoned-carts/c1' ? Promise.resolve({ ...detail, cart: { ...detail.cart, assignedTo: { id: 'p2', name: 'موظف' } } }) : answer(url)
    );
    render(<AbandonedCartDetailScreen id="c1" />);
    const pick = (await screen.findByLabelText('المسؤول')) as HTMLSelectElement;
    expect(pick.value).toBe('p2');
    fireEvent.change(pick, { target: { value: '' } });
    await waitFor(() => expect(api.mock.calls.some((c) => c[1])).toBe(true));
    expect((api.mock.calls.find((c) => c[1])![1] as RequestInit).body).toBe(JSON.stringify({ action: 'assign', userId: null }));
  });

  it('the way back says the screen by its registry name', async () => {
    render(<AbandonedCartDetailScreen id="c1" />);
    await screen.findByLabelText('موعد المتابعة');
    expect(screen.getByRole('link', { name: /زبائن ما كمّلوا/ }).getAttribute('href')).toBe('/abandoned-carts');
  });
});

describe('the look', () => {
  const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

  it('the four files of the screen carry no raw button, tick box, date box or small text left', () => {
    for (const f of [
      'src/components/screens/AbandonedCartsScreen.tsx',
      'src/components/screens/AbandonedCartDetailScreen.tsx',
      'src/components/screens/LeadsLane.tsx',
    ]) {
      const kinds = hitsOf(src(f)).map((h) => h.kind).filter((k) => k !== 'rawSurfaces');
      expect(kinds, f).toEqual([]);
    }
    expect(hitsOf(src('src/components/carts/cart-parts.tsx')).filter((h) => h.kind === 'textXs')).toEqual([]);
  });

  it('at 375 px nothing on the screen is wider than the phone', async () => {
    window.innerWidth = 375;
    const { container } = render(<AbandonedCartsScreen />);
    await screen.findAllByText('زائر أول');
    // any fixed pixel size written in a class, wider than the phone
    const PX = /\[(\d+)px\]/g;
    const wide = [...container.querySelectorAll('[class]')]
      .map((el) => el.getAttribute('class') ?? '')
      .filter((c) => [...c.matchAll(PX)].some((m) => Number(m[1]) > 375));
    expect(wide).toEqual([]);
    // the tab strip scrolls instead of pushing the page wider
    expect(screen.getByRole('tablist').className).toContain('overflow-x-auto');
  });
});
