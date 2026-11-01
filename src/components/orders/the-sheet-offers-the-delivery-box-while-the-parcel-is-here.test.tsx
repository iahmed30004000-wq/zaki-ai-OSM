// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «شامل التوصيل» ON THE ORDER SHEET — drawn only while the order can still be told apart from the parcel (the owner, 1/11).
 *
 * The sheet's money block shows «أجرة التوصيل» and the amount collected. Under the fee, for somebody who may change the fee, the box
 * of the order form is still there — until the parcel's batch is handed over, its waybill is printed, a courier barcode is on it,
 * or the order is ended. The door (`POST /api/orders/[id]/delivery-included`) asks every one of those again; the screen only does
 * not draw a box that would answer with a refusal.
 */

const { apiFetch, apiJson, viewer } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  viewer: { current: { id: 'u1', role: 'CUSTOM', permissions: ['orders.view', 'orders.change_fee'], status: 'ACTIVE' } },
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

import { OrderDetailModal } from './OrderDetailModal';

const OPEN = {
  id: 'o1', orderNumber: 'ORD-5', createdAt: '2026-10-15T06:00:00.000Z', source: 'Manual', status: 'CONFIRMED',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: null, trackingNumber: null,
  shippingBatch: { status: 'READY', batchNumber: 'BATCH-2026-0005' }, version: 3, priceIncludesDelivery: false,
  customer: { id: 'cu1', fullName: 'زبون', phone: '079', city: 'عمّان' },
  items: [], addOns: [], totalAmount: 23, deliveryFee: 3, shippingCost: 0, deliveryProvider: { id: 'p1', name: 'الباشا' },
};
const COD = { subtotal: 20, discount: 0, deliveryFee: 3, cod: 23, includesDelivery: false };

let order: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  viewer.current = { id: 'u1', role: 'CUSTOM', permissions: ['orders.view', 'orders.change_fee'], status: 'ACTIVE' };
  order = { ...OPEN };
  apiFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ order, currency: { code: 'USD', minorUnit: 2 }, cod: COD, previousOrderId: null, nextOrderId: null }),
  }));
  apiJson.mockResolvedValue({ events: [], channels: [] });
});
afterEach(cleanup);

async function open() {
  render(<OrderDetailModal orderId="o1" isOpen onClose={() => {}} onRefresh={() => {}} />);
  await waitFor(() => expect(screen.queryByText(/ORD-5/)).not.toBeNull());
}
const box = () => screen.queryByRole('checkbox', { name: /شامل التوصيل/ }) as HTMLInputElement | null;

describe('the box on the sheet', () => {
  it('an open order, for somebody who may change the fee: drawn, unticked as the order is', async () => {
    await open();
    expect(box()).not.toBeNull();
    expect(box()!.checked).toBe(false);
  });

  it('and ticked when the order already carries it', async () => {
    order = { ...OPEN, priceIncludesDelivery: true };
    await open();
    expect(box()!.checked).toBe(true);
  });

  it('NEGATIVE: not drawn without the fee key', async () => {
    viewer.current = { id: 'u1', role: 'CUSTOM', permissions: ['orders.view'], status: 'ACTIVE' };
    await open();
    expect(box()).toBeNull();
  });

  it('NEGATIVE: not drawn once the batch is handed over, the parcel shipped, the waybill printed, a barcode on it, or the order ended', async () => {
    for (const over of [
      { shippingBatch: { status: 'SHIPPED', batchNumber: 'BATCH-2026-0004' } },
      { shippingStatus: 'SHIPPED', shippedAt: '2026-10-31T16:23:00.000Z' },
      { labelPrintedAt: '2026-11-01T09:00:00.000Z' },
      { trackingNumber: 'KSA100422577363' },
      { confirmationStatus: 'CANCELLED' },
      { confirmationStatus: 'REJECTED' },
    ]) {
      cleanup();
      order = { ...OPEN, ...over };
      await open();
      expect(box(), JSON.stringify(over)).toBeNull();
    }
  });
});
