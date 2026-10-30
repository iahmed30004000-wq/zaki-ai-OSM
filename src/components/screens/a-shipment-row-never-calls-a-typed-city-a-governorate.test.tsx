// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A TYPED CITY IS NOT A GOVERNORATE — ON THE «شحنة جديدة» ROW (30/10).
 *
 * The column «المحافظة» printed `region?.name ?? customer.city`, so an order with no governorate showed «سكاكة الجوف»
 * under that heading and read as settled — while the screen’s own refusal said «لم تُحدَّد المحافظة — لا يمكن حساب أجرة
 * التوصيل». Now an order with none says «لم تُحدَّد» in red, and what was typed is named «المكتوب».
 * ═══════════════════════════════════════════════════════════════════════
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
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: null }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));

import { ShipmentsNewScreen } from './ShipmentsNewScreen';

const row = (id: string, city: string, region: { id: string; name: string } | null) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: `ORD-${id}`,
  customer: { id: `c-${id}`, fullName: `زبون ${id}`, phone: '0790000000', city },
  previousOrders: 0,
  region,
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
  cod: { subtotal: 20, discount: 0, deliveryFee: 0, cod: 20, currency: 'JOD', feeSource: 'region' },
  blocks: [],
  selectable: true,
  hardBlocked: false,
  shipHoldUntil: null,
  standDownBlocked: null,
  shipHoldReason: null,
});

const draw = async (rows: ReturnType<typeof row>[]) => {
  apiJson.mockImplementation(async (url: string) =>
    url.includes('/api/ops/shipments') ? { orders: rows, heldCount: 0 } : { providers: [{ id: 'p1', name: 'شركة الشحن أ' }], regions: [{ id: 'r1', name: 'عمّان' }] }
  );
  render(<ShipmentsNewScreen />);
  await waitFor(() => expect(screen.queryAllByText(/ORD-/).length).toBeGreaterThan(0));
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the «المحافظة» column', () => {
  it('an order with none says «لم تُحدَّد» in red, and the typed city is named «المكتوب»', async () => {
    await draw([row('1', 'سكاكة الجوف', null)]);
    const unset = screen.getAllByText('لم تُحدَّد')[0];
    expect(unset.className).toContain('text-[var(--sys-destructive)]');
    const typed = screen.getAllByText(/المكتوب:/)[0];
    expect(typed.textContent).toContain('سكاكة الجوف');
  });

  it('the typed city is never the bare content of the governorate cell', async () => {
    await draw([row('1', 'سكاكة الجوف', null)]);
    // every place the city appears carries the «المكتوب» label with it
    for (const el of screen.getAllByText(/سكاكة الجوف/)) {
      expect(el.closest('span')?.parentElement?.textContent ?? el.textContent).toMatch(/المكتوب:/);
    }
  });

  it('NEGATIVE: an order with a governorate prints its name, and no «لم تُحدَّد»', async () => {
    await draw([row('2', 'المزة', { id: 'r1', name: 'دمشق' })]);
    expect(screen.getAllByText('دمشق').length).toBeGreaterThan(0);
    expect(screen.queryByText('لم تُحدَّد')).toBeNull();
    expect(screen.queryByText(/المكتوب:/)).toBeNull();
  });

  it('an order with none and no typed city says only «لم تُحدَّد»', async () => {
    await draw([row('3', '  ', null)]);
    expect(screen.getAllByText('لم تُحدَّد').length).toBeGreaterThan(0);
    expect(screen.queryByText(/المكتوب:/)).toBeNull();
  });
});
