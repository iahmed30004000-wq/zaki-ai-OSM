// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الطلبات»: THE COUNTS PER STATE, THE CARDS, AND «متأخرة» IN DAYS.
 *
 *   · the chips are what `/api/orders/summary` answered — a state with nothing in it is not a chip — and pressing one is
 *     the state filter: the next list request carries `status`; pressing it again lets go;
 *   · the summary is asked with the list's filters and without its page;
 *   · the cards draw the profit only when the server sent it;
 *   · «متأخرة» starts at ten days, the box beside it changes the number, the number goes to the list and into the address,
 *     and `?late=1` — every link written before — still means ten.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, nav, answer } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  nav: { params: new URLSearchParams() },
  answer: { profit: false },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  usePathname: () => '/orders',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), apiJson: vi.fn(async () => ({})) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: { orders: 'الطلبات', export: 'تصدير CSV', quickCreateOrder: 'إدخال طلب سريع' },
    currentUser: { id: 'u1', name: 'أحمد', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' },
  }),
}));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [] }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [] }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/components/ui/Confirm', () => ({ useTell: () => vi.fn(), useConfirm: () => vi.fn() }));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => 'thermal', LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({ openWaybills: vi.fn(), describeRefused: () => '', WaybillError: class extends Error {} }));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/AiOrderModal', () => ({ AiOrderModal: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ImportOrdersDialog', () => ({ ImportOrdersDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/components/ui/SavedViews', () => ({ SavedViews: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));

import { OrdersScreen } from './OrdersScreen';

const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = new URLSearchParams();
  answer.profit = false;
  window.history.replaceState(null, '', '/orders');
  apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/orders/summary?')) {
      return json({
        counts: [
          { state: 'NEW', count: 4 },
          { state: 'CONFIRMED', count: 7 },
          { state: 'SHIPPED', count: 0 },
        ],
        countsTotal: 11,
        cards: { orders: 11, value: 330, average: 30, ...(answer.profit ? { profit: { value: 55, orders: 3 } } : {}) },
      });
    }
    if (url.startsWith('/api/orders?')) {
      return json({ orders: [], pagination: { total: 0, page: 1, limit: 25, totalPages: 1 }, currency: { code: 'JOD', minorUnit: 3 } });
    }
    if (url.startsWith('/api/delivery-providers')) return json({ providers: [] });
    if (url.startsWith('/api/orders/sources')) return json({ sources: [] });
    return json({});
  });
});
afterEach(cleanup);

const calls = (prefix: string) => apiFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith(prefix));
const lastQuery = (prefix: string) => new URLSearchParams((calls(prefix).at(-1) ?? '').split('?')[1] ?? '');

describe('the counts above the list', () => {
  it('draws «الكل» and each state the server counted, and no chip for a state with nothing in it', async () => {
    render(<OrdersScreen />);
    const strip = await screen.findByRole('tablist');
    const tabs = within(strip).getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['الكل11', 'جديد4', 'مؤكد7']);
  });

  it('pressing a chip filters the list by that state, and pressing it again lets go', async () => {
    render(<OrdersScreen />);
    const strip = await screen.findByRole('tablist');
    fireEvent.click(within(strip).getByRole('tab', { name: /مؤكد/ }));
    await waitFor(() => expect(lastQuery('/api/orders?').get('status')).toBe('CONFIRMED'));
    expect((screen.getByLabelText('فلتر الحالة') as HTMLSelectElement).value).toBe('CONFIRMED');
    fireEvent.click(within(await screen.findByRole('tablist')).getByRole('tab', { name: /مؤكد/ }));
    await waitFor(() => expect(lastQuery('/api/orders?').get('status')).toBe('all'));
  });

  it('the summary is asked with the list’s filters and without its page', async () => {
    render(<OrdersScreen />);
    await screen.findByRole('tablist');
    const q = lastQuery('/api/orders/summary?');
    expect(q.get('page')).toBeNull();
    expect(q.get('limit')).toBeNull();
    expect(q.get('status')).toBe('all');
  });

  it('the cards: count, total, average — and no profit card unless the server sent one', async () => {
    render(<OrdersScreen />);
    await screen.findByText('عدد الطلبات');
    expect(screen.getByText('إجمالي القيمة')).toBeTruthy();
    expect(screen.getByText('متوسط الطلب')).toBeTruthy();
    expect(screen.queryByText('صافي الربح')).toBeNull();
  });

  it('the profit card, when the server sent it', async () => {
    answer.profit = true;
    render(<OrdersScreen />);
    await screen.findByText('صافي الربح');
    expect(screen.getByText('من 3 طلب أُقفل مالياً')).toBeTruthy();
  });

  it('NEGATIVE: an answer that is not a summary draws nothing and breaks nothing', async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.startsWith('/api/orders?')
        ? json({ orders: [], pagination: { total: 0, page: 1, limit: 25, totalPages: 1 } })
        : url.startsWith('/api/orders/summary')
          ? json({ error: 'Forbidden' }, 403)
          : json({})
    );
    render(<OrdersScreen />);
    await waitFor(() => expect(calls('/api/orders?').length).toBeGreaterThan(0));
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('عدد الطلبات')).toBeNull();
  });
});

describe('«متأخرة» in days', () => {
  it('off by default; on, it asks ten days and writes `late=10` to the address', async () => {
    render(<OrdersScreen />);
    await waitFor(() => expect(calls('/api/orders?').length).toBeGreaterThan(0));
    expect(lastQuery('/api/orders?').get('lateDays')).toBeNull();
    expect(screen.queryByLabelText('عدد أيام التأخير')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /متأخرة 10 أيام/ }));
    await waitFor(() => expect(lastQuery('/api/orders?').get('lateDays')).toBe('10'));
    expect(new URLSearchParams(window.location.search).get('late')).toBe('10');
  });

  it('the box changes the number: seven days goes to the list, the summary and the address', async () => {
    render(<OrdersScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /متأخرة 10 أيام/ }));
    const box = (await screen.findByLabelText('عدد أيام التأخير')) as HTMLSelectElement;
    expect(box.tagName).toBe('SELECT');
    expect(Array.from(box.options).map((o) => o.value)).toEqual(['3', '5', '7', '10', '14']);
    fireEvent.change(box, { target: { value: '7' } });
    await waitFor(() => expect(lastQuery('/api/orders?').get('lateDays')).toBe('7'));
    await waitFor(() => expect(lastQuery('/api/orders/summary?').get('lateDays')).toBe('7'));
    expect(new URLSearchParams(window.location.search).get('late')).toBe('7');
    expect(screen.getByRole('button', { name: /متأخرة 7 أيام/ })).toBeTruthy();
  });

  it('the old link `?late=1` still means ten days', async () => {
    nav.params = new URLSearchParams('late=1');
    render(<OrdersScreen />);
    await waitFor(() => expect(lastQuery('/api/orders?').get('lateDays')).toBe('10'));
  });

  it('`?late=5` is five days; a number the builder would refuse is no filter at all', async () => {
    nav.params = new URLSearchParams('late=5');
    render(<OrdersScreen />);
    await waitFor(() => expect(lastQuery('/api/orders?').get('lateDays')).toBe('5'));
    cleanup();
    apiFetch.mockClear();
    nav.params = new URLSearchParams('late=abc');
    render(<OrdersScreen />);
    await waitFor(() => expect(calls('/api/orders?').length).toBeGreaterThan(0));
    expect(lastQuery('/api/orders?').get('lateDays')).toBeNull();
  });

  it('turning it off clears the filter and the address', async () => {
    nav.params = new URLSearchParams('late=7');
    window.history.replaceState(null, '', '/orders?late=7');
    render(<OrdersScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /متأخرة 7 أيام/ }));
    await waitFor(() => expect(lastQuery('/api/orders?').get('lateDays')).toBeNull());
    expect(new URLSearchParams(window.location.search).get('late')).toBeNull();
  });
});
