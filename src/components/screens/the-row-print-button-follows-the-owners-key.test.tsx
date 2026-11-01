// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الطلبات» — THE WAYBILL BUTTON ON A ROW FOLLOWS THE OWNER'S KEY (1/11).
 *
 * The button is drawn only on the rows that can produce a waybill, so it is never one that answers with a refusal: a confirmed
 * order. Whoever holds `ops.labels_any` prints any order in any state (waybill.ts `printRefusal`), so for her every row can.
 * The key needs `ops.labels` beside it, as the server asks both.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, currentUser } = vi.hoisted(() => ({ apiFetch: vi.fn(), currentUser: { value: null as unknown } }));

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
    currentUser: currentUser.value,
  }),
}));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [] }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [] }) }));
vi.mock('@/components/ui/Confirm', () => ({ useTell: () => vi.fn(), useConfirm: () => vi.fn() }));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => 'thermal', LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({
  openWaybills: vi.fn(),
  describeRefused: () => '',
  BLOCKED_WAYBILLS: 'المتصفح منع النافذة',
  WaybillError: class extends Error {},
}));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/AiOrderModal', () => ({ AiOrderModal: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ImportOrdersDialog', () => ({ ImportOrdersDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => null }));
vi.mock('@/components/ui/SavedViews', () => ({ SavedViews: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));

import { OrdersScreen } from './OrdersScreen';

// Two synthetic rows — no real person in either.
const row = (n: number, confirmationStatus: string) => ({
  id: `o${n}`,
  orderNumber: `ORD-26-${5000 + n}`,
  state: confirmationStatus === 'CONFIRMED' ? 'CONFIRMED' : 'NEW',
  customer: { id: `c${n}`, fullName: `زبون تجريبي ${n}`, city: 'عمّان' },
  region: { name: 'إربد' },
  productNameSnapshot: 'منتج تجريبي',
  quantity: 1,
  source: 'Sheet import',
  moderator: { name: 'سارة' },
  createdAt: '2026-10-20T09:00:00.000Z',
  totalAmount: 40,
  confirmationStatus,
  deliveryProvider: { kind: 'COMPANY', name: 'ناقل' },
});
const NEW_ROW = row(1, 'NEW');
const CONFIRMED_ROW = row(2, 'CONFIRMED');

const as = (role: string, permissions: string[]) => {
  currentUser.value = { id: 'u1', name: 'سارة', role, permissions, status: 'ACTIVE' };
};
const printOf = (r: { orderNumber: string }) => screen.queryByLabelText(`اطبع بوليصة ${r.orderNumber}`);

async function open() {
  render(<OrdersScreen />);
  // the rows first
  await screen.findByLabelText(`تحديد الطلب ${CONFIRMED_ROW.orderNumber}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).startsWith('/api/orders?')
        ? { orders: [NEW_ROW, CONFIRMED_ROW], pagination: { page: 1, limit: 25, total: 2, totalPages: 1 } }
        : { orders: [], pagination: { page: 1, pages: 1, total: 0 } },
  }));
});
afterEach(cleanup);

describe('«الطلبات» — the waybill button on a row', () => {
  it('somebody with the labels key and nothing more: only the confirmed row has it', async () => {
    as('WAREHOUSE', ['orders.view', 'ops.labels']);
    await open();
    expect(printOf(CONFIRMED_ROW)).not.toBeNull();
    expect(printOf(NEW_ROW), 'طلب غير مؤكَّد بلا زر: ما بتعطيه بوليصة').toBeNull();
  });

  it('with the owner’s key beside it: every row has it, the unconfirmed one too', async () => {
    as('WAREHOUSE', ['orders.view', 'ops.labels', 'ops.labels_any']);
    await open();
    expect(printOf(CONFIRMED_ROW)).not.toBeNull();
    expect(printOf(NEW_ROW)).not.toBeNull();
  });

  it('the owner (full access) has it on every row', async () => {
    as('SUPER_ADMIN', []);
    await open();
    expect(printOf(CONFIRMED_ROW)).not.toBeNull();
    expect(printOf(NEW_ROW)).not.toBeNull();
  });

  it('NEGATIVE: the owner’s key without the labels key draws nothing — the server asks both', async () => {
    as('WAREHOUSE', ['orders.view', 'ops.labels_any']);
    await open();
    expect(printOf(CONFIRMED_ROW)).toBeNull();
    expect(printOf(NEW_ROW)).toBeNull();
  });
});
