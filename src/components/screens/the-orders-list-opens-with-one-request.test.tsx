// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الطلبات» OPENS WITH ONE REQUEST FOR THE ORDERS, NOT TWO (13/11 — the site's slow-down, plan PR-5).
 *
 * The screen has its own debounced load (250 ms after the filters change — also on the opening) AND `useLiveRefresh`, whose first
 * load is immediate: two identical requests for the heaviest list, on every opening. The first run of the debounced effect (the
 * opening) now stands down because the hook has already asked; every run after it is a changed filter, and that still reloads.
 * The first rows come as early as they did — the immediate load is the one that stays.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/orders',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: vi.fn(async () => ({})),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: { orders: 'الطلبات', export: 'تصدير CSV', quickCreateOrder: 'إدخال طلب سريع' },
    currentUser: { id: 'u1', name: 'سارة', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' },
  }),
}));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [] }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [] }) }));
vi.mock('@/components/ui/Confirm', () => ({ useTell: () => vi.fn(), useConfirm: () => vi.fn() }));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => 'thermal', LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({
  openWaybills: vi.fn(),
  describeRefused: () => '',
  WaybillError: class extends Error {},
}));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/AiOrderModal', () => ({ AiOrderModal: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ImportOrdersDialog', () => ({ ImportOrdersDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/components/ui/SavedViews', () => ({ SavedViews: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));

import { OrdersScreen } from './OrdersScreen';

const ORDER = {
  id: 'o1',
  orderNumber: 'ORD-26-5000',
  state: 'CONFIRMED',
  customer: { id: 'c1', fullName: 'نور الحسن', rawPhone: '0791234567', phone: '0791234567', city: 'عمّان' },
  region: { name: 'إربد' },
  productNameSnapshot: 'ساعة ذكية',
  quantity: 2,
  offer: { name: 'اشترِ 3 واحصل على 1 مجاناً' },
  source: 'Sheet import',
  moderator: { name: 'سارة' },
  createdAt: '2026-10-20T12:00:00.000Z',
  totalAmount: 40,
  confirmationStatus: 'NEW',
  deliveryProvider: { kind: 'COMPANY', name: 'ناقل' },
  trackingNumber: 'TRK-900-000',
};

const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const orderRequests = () => apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/orders?'));

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/orders?')) {
      return json({
        orders: [ORDER],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        currency: { code: 'JOD', minorUnit: 3 },
        dialCode: '962',
      });
    }
    if (url.startsWith('/api/delivery-providers')) return json({ providers: [] });
    if (url.startsWith('/api/orders/sources')) return json({ sources: [] });
    return json({});
  });
});

afterEach(cleanup);

describe('opening the orders list', () => {
  it('asks for the orders ONCE — and the rows are there', async () => {
    render(<OrdersScreen />);
    await screen.findByText('ORD-26-5000');
    await later(600); // past the 250 ms debounce that used to ask a second time
    expect(orderRequests(), 'طلبين مطابقين لقائمة الطلبات بكل فتحة').toHaveLength(1);
  });

  it('and the first request does not wait for the debounce: the rows come before it would have fired', async () => {
    render(<OrdersScreen />);
    expect(orderRequests(), 'الطلب الأول فوراً').toHaveLength(1);
  });

  it('a changed filter STILL reloads — the debounced load is for exactly that', async () => {
    render(<OrdersScreen />);
    await screen.findByText('ORD-26-5000');
    await later(400);
    expect(orderRequests()).toHaveLength(1);

    const box = screen.getByPlaceholderText('ابحث برقم الطلب، الرمز، اسم العميل، أو الهاتف…');
    fireEvent.change(box, { target: { value: 'نور' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await later(600);
    const asked = orderRequests();
    expect(asked, 'تغيّر الفلتر ما أعاد الطلب').toHaveLength(2);
    expect(decodeURIComponent(asked[1])).toContain('نور');
  });
});
