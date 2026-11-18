// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «تحديد الكل» MEANS THE ROWS IN FRONT OF YOU.
 *
 * A search box is only safe on a screen whose next button creates real
 * shipments with real couriers. If «تحديد الكل» reached past the search —
 * to everything the last unfiltered load had held, or to everything on the
 * server — then narrowing the list and pressing it would book parcels the
 * person never saw.
 *
 * It already iterates the rows the API returned, which is the right thing.
 * What it did not have was a test, and a property nobody asserts is a
 * property that survives until somebody refactors it.
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
// The screen now asks who is signed in — to offer «اطبع البوالص» only to
// somebody who may open the batches screen. Nobody is, here: this test is
// about ticking rows, and an offer that is not made is not under test.
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: null }) }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));

import { ShipmentsNewScreen } from './ShipmentsNewScreen';

/** One order waiting to go out. */
const row = (id: string, name: string, city: string) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: `ORD-${id}`,
  customer: { id: `c-${id}`, fullName: name, phone: '0790000000', city },
  previousOrders: 0,
  region: { id: 'r1', name: city },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
  cod: { subtotal: 20, discount: 0, deliveryFee: 0, cod: 20, currency: 'JOD', feeSource: 'region' },
  blocks: [],
  selectable: true,
  hardBlocked: false,
  shipHoldUntil: null,
  standDownBlocked: null,
  shipHoldReason: null,
});

const ALL = [row('1', 'سامر خليل', 'عمّان'), row('2', 'هبة يوسف', 'إربد'), row('3', 'عمر النجار', 'الزرقاء')];

/** The API answers with whatever the current query deserves. */
function serverHolds(rows: typeof ALL) {
  apiJson.mockImplementation(async (url: string) => {
    if (url.includes('/api/ops/shipments?') || url.endsWith('/api/ops/shipments')) {
      const q = new URL(url, 'http://x').searchParams.get('q')?.trim();
      const shown = q
        ? rows.filter((r) => r.customer.fullName.includes(q) || r.customer.city.includes(q) || r.orderNumber.includes(q))
        : rows;
      return { orders: shown, heldCount: 0 };
    }
    return { providers: [{ id: 'p1', name: 'شركة الشحن أ' }], regions: [{ id: 'r1', name: 'عمّان' }] };
  });
}

/** The create button says how many are ticked. */
const createButton = () => screen.getAllByText(/إنشاء شحنة \(/)[0];

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ticking every row', () => {
  it('takes all three when nothing is searched', async () => {
    serverHolds(ALL);
    const user = userEvent.setup();
    render(<ShipmentsNewScreen />);

    // The screen draws a table AND a card list, so every name is in the
    // DOM twice — counted, not fetched singly.
    await waitFor(() => expect(screen.queryAllByText(/سامر خليل/).length).toBeGreaterThan(0));
    const all = document.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    expect(all, 'ما في مربّع «تحديد الكل»').toBeTruthy();
    await user.click(all);

    expect(createButton().textContent).toContain('3');
  });

  it('and only the row the search left when one is', async () => {
    serverHolds(ALL);
    const user = userEvent.setup();
    render(<ShipmentsNewScreen />);

    await waitFor(() => expect(screen.queryAllByText(/سامر خليل/).length).toBeGreaterThan(0));

    // Type a name that matches exactly one of the three.
    const box = screen.getByPlaceholderText(/رقم الطلب/);
    await user.type(box, 'هبة');

    await waitFor(() => expect(screen.queryAllByText(/سامر خليل/)).toHaveLength(0));

    const all = document.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    await user.click(all);

    // One, not three — and not «the three the last load held».
    expect(createButton().textContent, 'حدّد صفوفاً مش معروضة').toContain('1');
  });
});
