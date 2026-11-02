// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «ماسكه» ON «الطلبات» — DRAWN WHEN THE SERVER SENDS THE NAMES, AND SENT WITH THE LIST.
 *
 * The door `/api/orders/holders` answers only whoever sees every order; the
 * screen draws the filter only when it answers. Choosing a name sends
 * `holderId` with the list, the CSV and the arrows alike (the builder is shared).
 * The six cells of the filter grid stay six: «ماسكه» is a row of its own.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, holders } = vi.hoisted(() => ({ apiFetch: vi.fn(), holders: { answer: 'ok' as 'ok' | 'refused' } }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
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
  holders.answer = 'ok';
  apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/orders?')) {
      return json({ orders: [], pagination: { total: 0, page: 1, limit: 25, totalPages: 1 }, currency: { code: 'JOD', minorUnit: 3 } });
    }
    if (url.startsWith('/api/orders/holders')) {
      return holders.answer === 'ok'
        ? json({ holders: [{ id: 'sara', name: 'سارة', count: 12 }, { id: 'hind', name: 'هند', count: 3 }] })
        : json({ error: 'Forbidden' }, 403);
    }
    if (url.startsWith('/api/delivery-providers')) return json({ providers: [] });
    if (url.startsWith('/api/orders/sources')) return json({ sources: [] });
    return json({});
  });
});
afterEach(cleanup);

const listCalls = () => apiFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/orders?'));

describe('a person the door answers', () => {
  it('sees a real select «ماسكه» with «الكل», «ما حدا ماسكه» and each holder with what he holds', async () => {
    render(<OrdersScreen />);
    const select = (await screen.findByLabelText('فلتر ماسكه')) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['ماسكه: الكل', 'ما حدا ماسكه', 'سارة (12)', 'هند (3)']);
  });

  it('choosing Sara sends `holderId=sara` with the list — and no filter sends none', async () => {
    render(<OrdersScreen />);
    const select = await screen.findByLabelText('فلتر ماسكه');
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls().every((u) => !u.includes('holderId'))).toBe(true);
    fireEvent.change(select, { target: { value: 'sara' } });
    await waitFor(() => expect(listCalls().some((u) => new URLSearchParams(u.split('?')[1]).get('holderId') === 'sara')).toBe(true));
  });

  it('it sits in a row of its own: the grid of the six filters still holds six', async () => {
    render(<OrdersScreen />);
    const select = await screen.findByLabelText('فلتر ماسكه');
    const six = screen.getByLabelText('فلتر الحالة').closest('.grid') as HTMLElement;
    expect(six.children).toHaveLength(6);
    expect(six.contains(select)).toBe(false);
  });
});

describe('NEGATIVE: a person the door refuses', () => {
  it('gets no «ماسكه» at all, and the list is asked without it', async () => {
    holders.answer = 'refused';
    render(<OrdersScreen />);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u).startsWith('/api/orders/holders'))).toBe(true));
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('فلتر ماسكه')).toBeNull();
    expect(listCalls().every((u) => !u.includes('holderId'))).toBe(true);
  });
});
