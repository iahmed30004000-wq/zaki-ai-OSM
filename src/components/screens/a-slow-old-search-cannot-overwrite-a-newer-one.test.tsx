// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE LATEST QUESTION WINS ON «إنشاء شحنة» (RV34).
 *
 * The list loads a quarter-second after the screen opens and again after each change in the search box. When the first
 * (slow) answer arrived after the second, the list showed the old result beside the newer search. The real screen, two
 * answers in the wrong order.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/shipments/new', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.ship', 'ops.labels'] } }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));

import { ShipmentsNewScreen } from './ShipmentsNewScreen';

vi.setConfig({ testTimeout: 15000 });
const WAIT = { timeout: 8000 };

const row = (id: string, name: string) => ({
  id, orderNumber: `ORD-${id}`, merchantRef: `ORD-${id}`,
  customer: { id: `c${id}`, fullName: name, phone: '0790000000', city: 'عمّان' },
  previousOrders: 0, region: { id: 'r1', name: 'عمّان' },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
  cod: { subtotal: 20, discount: 0, deliveryFee: 0, cod: 20, currency: 'JOD', feeSource: 'region' },
  blocks: [], selectable: true, hardBlocked: false, shipHoldUntil: null, standDownBlocked: null, shipHoldReason: null,
});

let releaseFirst: (v: unknown) => void = () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
  let shipmentCalls = 0;
  apiJson.mockImplementation(async (url: string) => {
    if (url.includes('/api/ops/shipments')) {
      shipmentCalls += 1;
      // The first question is slow and is answered last; the second is answered at once.
      if (shipmentCalls === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      return { orders: [row('2', 'اسم الجديد')], heldCount: 0 };
    }
    return { providers: [{ id: 'p1', name: 'شركة الشحن أ' }], regions: [{ id: 'r1', name: 'عمّان' }] };
  });
});
afterEach(cleanup);

describe('«إنشاء شحنة» — two answers, wrong order', () => {
  it('the older, slower answer does not replace the newer one', async () => {
    render(<ShipmentsNewScreen />);
    // The first load is in flight (held). Now the person types, which asks a second question.
    await waitFor(() => expect(apiJson.mock.calls.some((c) => String(c[0]).includes('/api/ops/shipments'))).toBe(true), WAIT);
    fireEvent.change(screen.getByPlaceholderText(/رقم الطلب · اسم الزبون/), { target: { value: 'جديد' } });
    await waitFor(() => expect(screen.queryAllByText(/اسم الجديد/).length).toBeGreaterThan(0), WAIT);

    // NOW the slow, old answer comes in.
    await act(async () => {
      releaseFirst({ orders: [row('1', 'اسم القديم')], heldCount: 0 });
    });
    expect(screen.queryAllByText(/اسم القديم/).length).toBe(0);
    expect(screen.queryAllByText(/اسم الجديد/).length).toBeGreaterThan(0);
  });
});
