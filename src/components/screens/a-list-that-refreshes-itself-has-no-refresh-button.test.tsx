// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * A SCREEN THAT REFRESHES ITSELF HAS NO REFRESH BUTTON — AND A GROUP THE
 * PACKER MUST OPEN BEFORE READING IS NOT READ.
 *
 * Found by reading the screens for controls that do the same thing twice:
 *
 *   · «تشغيل التطبيقات المثبتة» ran `useLiveRefresh` (it reloads on a timer
 *     and when the window comes back) AND drew a «تحديث» button beside the
 *     filters that called the same loader;
 *   · «التجهيز» is read standing at a shelf and has no action of its own, yet
 *     every product group started CLOSED — one tap per product before a single
 *     line could be read. They start open now; closing one is still one tap.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/preparation',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', name: 'سارة', role: 'COMPANY_ADMIN', permissions: [], status: 'ACTIVE' } }),
}));
vi.mock('@/components/screens/ops/PickingAssistant', () => ({ PickingAssistant: () => null }));
vi.mock('@/components/orders/ChangeRequestReview', () => ({ ChangeRequestReview: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
// The keys panel under the installed apps fetches its own endpoint and is another screen's subject.
vi.mock('@/components/apps/SystemTokensPanel', () => ({ SystemTokensPanel: () => null }));

import { PreparationScreen } from './PreparationScreen';
import { InstalledAppsScreen } from './InstalledAppsScreen';

const line = (orderId: string) => ({
  orderId,
  orderNumber: `ORD-${orderId}`,
  customerName: 'عميل تجريبي',
  regionName: 'عمّان',
  pendingChangeRequestId: null,
  quantity: 2,
  freeQuantity: 0,
  reservedQty: 2,
  shippingStatus: 'NOT_READY',
});
const group = (productId: string) => ({
  productId,
  productName: `منتج ${productId}`,
  orders: 1,
  required: 2,
  available: 5,
  shortage: 0,
  lines: [line(`${productId}1`)],
});

// A block body: `() => api.mockReset()` RETURNS the mock, and vitest runs whatever a
// beforeEach returns as a cleanup — so `api()` was being called with no arguments
// after every test, into whatever implementation the last test had set.
beforeEach(() => {
  api.mockReset();
});
afterEach(cleanup);

describe('«التجهيز» — the groups start open', () => {
  const mount = async () => {
    api.mockResolvedValue({
      allowNegativeStock: false,
      totals: { products: 2, orders: 2, shortages: 0 },
      groups: [group('A'), group('B')],
    });
    render(<PreparationScreen />);
    await screen.findByText('منتج A');
  };

  it('every product group shows its orders without a tap', async () => {
    await mount();
    expect(screen.getAllByText('ORD-A1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ORD-B1').length).toBeGreaterThan(0);
  });

  it('and closing one hides ITS orders only — one tap, as before', async () => {
    await mount();
    fireEvent.click(screen.getByText('منتج A').closest('button')!);
    expect(screen.queryByText('ORD-A1')).toBeNull();
    expect(screen.getAllByText('ORD-B1').length).toBeGreaterThan(0);
    // and a second tap opens it again
    fireEvent.click(screen.getByText('منتج A').closest('button')!);
    expect(screen.getAllByText('ORD-A1').length).toBeGreaterThan(0);
  });
});

describe('«التطبيقات المثبتة» — a list that reloads itself', () => {
  it('draws its filters but no «تحديث» button', async () => {
    // Every endpoint the screen asks is answered by name; an unknown one is an error,
    // not a guess — a wrong-shaped answer to a child's request throws AFTER the test
    // has passed and fails the whole run as an unhandled error.
    api.mockImplementation(async (...args: unknown[]) => {
      const u = String(args[0] ?? '');
      if (u.startsWith('/api/apps/deliveries')) return { deliveries: [], totals: { ok: 0, failed: 0, pending: 0 } };
      if (u === '/api/apps') return { builtIn: [], external: [] };
      throw new Error(`unexpected request ${u}`);
    });
    render(<InstalledAppsScreen />);
    // the filter pills are the screen's buttons; wait for them, then look for a refresh
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(1));
    expect(screen.queryByRole('button', { name: /تحديث/ })).toBeNull();
    expect(api).toHaveBeenCalled();
  });
});
