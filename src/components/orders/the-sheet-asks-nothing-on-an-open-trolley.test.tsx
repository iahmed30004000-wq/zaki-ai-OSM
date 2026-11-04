// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE ORDER SHEET OFFERS NO ASK FOR AN ORDER ON AN OPEN TROLLEY (the owner's ruling 4/11).
 *
 * The card «تعديل · إلغاء · تأجيل» is where a confirmed order is asked about. On a trolley still being filled the raising door
 * refuses every ask with ON_OPEN_TROLLEY, so the card says that sentence instead of offering a press that would fail — and
 * after the handover, or off any trolley, it offers what it always did.
 */

const { apiFetch, apiJson, viewer } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  viewer: { current: { id: 'u1', role: 'CUSTOM', permissions: ['orders.view', 'orders.request_change'], status: 'ACTIVE' } },
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: viewer.current }) }));
vi.mock('@/hooks/useOrderOwnership', () => ({
  useOrderOwnership: () => ({ claim: vi.fn(), release: vi.fn(), busy: false, error: null }),
}));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => ({ patch: vi.fn(), saving: false }) }));
vi.mock('@/components/orders/OrderResponsibility', () => ({ OrderResponsibility: () => null }));
vi.mock('@/components/orders/CustomerCard', () => ({ CustomerCard: () => null }));
vi.mock('@/components/orders/OrderLinesCard', () => ({ OrderLinesCard: () => null }));
vi.mock('@/components/orders/ConfirmationActions', () => ({ ConfirmationActions: () => null }));
vi.mock('@/components/orders/ShapeRiskPanel', () => ({ ShapeRiskPanel: () => null }));
vi.mock('@/components/orders/ShippingSection', () => ({ ShippingSection: () => null }));
vi.mock('@/components/orders/OrderStages', () => ({ OrderStages: () => null }));
vi.mock('@/components/orders/OrderNotes', () => ({ OrderNotes: () => null }));
vi.mock('@/components/orders/OrderStateBadge', () => ({ OrderStateBadge: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryModal: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null }));
vi.mock('@/components/orders/raiseChangeRequest', () => ({ raiseChangeRequest: vi.fn() }));

import { ON_TROLLEY_AR } from '@/lib/order-seal';
import { OrderDetailModal } from './OrderDetailModal';

const ORDER = {
  id: 'o1', orderNumber: 'ORD-2026-1584', createdAt: '2026-11-03T06:00:00.000Z', source: 'Manual', status: 'CONFIRMED',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: null, trackingNumber: null,
  shippingBatchId: 'b1', shippingBatch: { id: 'b1', status: 'READY', batchNumber: 'BATCH-2026-0009' }, version: 3,
  priceIncludesDelivery: false, customer: { id: 'cu1', fullName: 'زبون', phone: '079', city: 'عمّان' },
  items: [], addOns: [], totalAmount: 23, deliveryFee: 3, shippingCost: 0, deliveryProvider: { id: 'p1', name: 'الباشا' },
};
const COD = { subtotal: 20, discount: 0, deliveryFee: 3, cod: 23, includesDelivery: false };

let order: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  order = { ...ORDER };
  apiFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ order, currency: { code: 'USD', minorUnit: 2 }, cod: COD, previousOrderId: null, nextOrderId: null }),
  }));
  apiJson.mockResolvedValue({ events: [], channels: [] });
});
afterEach(cleanup);

async function open() {
  render(<OrderDetailModal orderId="o1" isOpen onClose={() => {}} onRefresh={() => {}} />);
  await waitFor(() => expect(screen.queryAllByText(/ORD-2026-1584/).length).toBeGreaterThan(0));
}
const ask = () => screen.queryByRole('button', { name: 'تعديل · إلغاء · تأجيل' });

describe('the ask card on the sheet', () => {
  it('on a READY trolley: no press, and the one sentence in its place', async () => {
    await open();
    expect(ask()).toBeNull();
    expect(screen.getByText(ON_TROLLEY_AR)).toBeTruthy();
  });

  it('on a trolley the order names but nobody can read: the same (fail closed)', async () => {
    order = { ...ORDER, shippingBatch: null };
    await open();
    expect(ask()).toBeNull();
    expect(screen.getByText(ON_TROLLEY_AR)).toBeTruthy();
  });

  it('NEGATIVE: after the handover, and off any trolley, the press is offered as before', async () => {
    for (const over of [
      { shippingBatch: { id: 'b1', status: 'SHIPPED', batchNumber: 'BATCH-2026-0009' } },
      { shippingBatchId: null, shippingBatch: null },
    ]) {
      cleanup();
      order = { ...ORDER, ...over };
      await open();
      expect(ask(), JSON.stringify(over)).not.toBeNull();
      expect(screen.queryByText(ON_TROLLEY_AR), JSON.stringify(over)).toBeNull();
    }
  });
});
