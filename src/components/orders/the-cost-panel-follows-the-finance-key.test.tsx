// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «تكاليفنا على هذا الطلب» — THE SHOP'S MONEY, ON EVERY READER'S SCREEN.
 *
 * The order window drew the cost of goods and the commission for anyone
 * who could open the order. The server now sends neither without the
 * finance key (order-projection.ts); the panel is not drawn without it
 * either, so nobody sees «تكلفة البضاعة: ٠» and believes it.
 */

const { apiFetch, apiJson, viewer } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  viewer: { current: { id: 'u1', role: 'CUSTOM', permissions: ['orders.view'], status: 'ACTIVE' } },
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: (...a: unknown[]) => apiJson(...a),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: {},
    currentUser: viewer.current,
  }),
}));
vi.mock('@/hooks/useOrderOwnership', () => ({
  useOrderOwnership: () => ({ claim: vi.fn(), release: vi.fn(), busy: false, error: null }),
}));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => ({ patch: vi.fn(), saving: false }) }));
/*
 * Every card inside the modal is somebody else's subject, and the nav row
 * is a sibling of them all. Written out one by one rather than in a loop:
 * `vi.mock` is hoisted above the import and a loop of `vi.doMock` is not,
 * so the loop version let the real children render and they fell over on
 * fixture fields that have nothing to do with the arrows.
 */
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

const ORDER = {
  id: 'o1',
  orderNumber: 'ORD-5',
  createdAt: '2026-10-15T06:00:00.000Z',
  source: 'Manual',
  status: 'NEW',
  confirmationStatus: 'NEW',
  customer: { id: 'cu1', fullName: 'زبون', phone: '079', city: 'عمّان' },
  items: [],
  addOns: [],
  totalAmount: 20,
  estimatedCostOfGoods: 9,
  commission: 1.5,
};

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ order: ORDER, currency: 'JOD', cod: null, previousOrderId: null, nextOrderId: null }),
  }));
  apiJson.mockResolvedValue({ events: [], channels: [] });
});
afterEach(cleanup);

async function open() {
  render(<OrderDetailModal orderId="o1" isOpen onClose={() => {}} onRefresh={() => {}} />);
  await waitFor(() => expect(screen.queryByText(/ORD-5/)).not.toBeNull());
}

describe('the cost panel', () => {
  it('is not drawn for someone who can open the order but holds no finance key', async () => {
    viewer.current = { id: 'u1', role: 'CUSTOM', permissions: ['orders.view'], status: 'ACTIVE' };
    await open();
    expect(screen.queryByText('تكاليفنا على هذا الطلب')).toBeNull();
    expect(screen.queryByText('تكلفة البضاعة:')).toBeNull();
  });

  it('is drawn for the finance key AND the cost key (PR-10)', async () => {
    viewer.current = { id: 'u1', role: 'CUSTOM', permissions: ['orders.view', 'finance.view', 'costs.view'], status: 'ACTIVE' };
    await open();
    expect(screen.queryByText('تكاليفنا على هذا الطلب')).not.toBeNull();
  });

  it('NEGATIVE: not drawn for the finance key alone — the owner took the cost away', async () => {
    viewer.current = { id: 'u1', role: 'CUSTOM', permissions: ['orders.view', 'finance.view'], status: 'ACTIVE' };
    await open();
    expect(screen.queryByText('تكاليفنا على هذا الطلب')).toBeNull();
  });

  it('NEGATIVE: not drawn for the cost key alone — a warehouse keeper sees the shelf’s cost, not the order’s margin', async () => {
    viewer.current = { id: 'u1', role: 'CUSTOM', permissions: ['orders.view', 'costs.view'], status: 'ACTIVE' };
    await open();
    expect(screen.queryByText('تكاليفنا على هذا الطلب')).toBeNull();
  });
});
