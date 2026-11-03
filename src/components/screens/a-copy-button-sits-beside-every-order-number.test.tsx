// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { DEFAULT_WINBACK_RULE } from '@/lib/winback';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «أزرار نسخ رقم الطلب بكل الشاشات» — THE OWNER, 3/11.
 *
 * `OrderRef` was drawn on one screen; every other list printed the number
 * through `OrderLink` or by hand, with nothing to copy it by. These render
 * three of the screens it moved to, against a fake server, and press the
 * button the way a person does:
 *
 *   · it sits beside the number and copies exactly what the row prints —
 *     the merchant reference where the screen shows that, else the number;
 *   · the number keeps what it was (a link to the order, or its own link);
 *   · no phone button, even when the row carries the phone: only the order
 *     number is copied here;
 *   · a press asks the server nothing.
 *
 * `OrderRef`'s own tests hold the rest (the tick, the fallback, the names);
 * `an-order-number-is-drawn-by-one-component` holds the count.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch } = vi.hoisted(() => ({ apiJson: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => vi.fn(), useTell: () => vi.fn() }));

import { DiscountAlertsScreen } from './DiscountAlertsScreen';
import { WinbackScreen } from './WinbackScreen';
import { ProductRecentOrders } from '@/components/products/ProductRecentOrders';

vi.setConfig({ testTimeout: 20000 });
const WAIT = { timeout: 8000 };

let written: string[];

beforeEach(() => {
  vi.clearAllMocks();
  written = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (t: string) => void written.push(t)) },
  });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});

async function press(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

/** The first copy button of that name — a list draws its rows twice (the desk table and the phone card). */
const copyOf = (number: string) => screen.getAllByRole('button', { name: `نسخ رقم الطلب ${number}` })[0];

describe('«تنبيهات الخصم» — the merchant reference where the row shows it', () => {
  const discountRow = (id: string, merchantRef: string | null) => ({
    id,
    orderNumber: `SY-${id}`,
    merchantRef,
    createdAt: '2026-10-20T12:00:00.000Z',
    customerName: 'نور الحسن',
    discount: 5,
    total: 40,
    share: 0.125,
    notable: true,
    currency: 'JOD',
    byName: 'سارة',
    confirmationStatus: 'CONFIRMED',
  });

  beforeEach(() => {
    apiJson.mockResolvedValue({
      days: 30,
      currency: 'JOD',
      notableThreshold: 0.1,
      totals: { orders: 2, discount: 10, notable: 2 },
      byPerson: [],
      orders: [discountRow('1', 'M-77'), discountRow('2', null)],
    });
  });

  it('copies what is printed: the reference, else the number — and the number is still the link', async () => {
    render(<DiscountAlertsScreen />);
    await screen.findAllByText('M-77', undefined, WAIT);

    expect(screen.getAllByRole('link', { name: 'M-77' })[0].getAttribute('href')).toBe('/orders/1');
    await press(copyOf('M-77'));
    await press(copyOf('SY-2'));
    expect(written).toEqual(['M-77', 'SY-2']);
  });

  it('draws no phone or barcode button', async () => {
    render(<DiscountAlertsScreen />);
    await screen.findAllByText('M-77', undefined, WAIT);
    expect(screen.queryByRole('button', { name: /هاتف|باركود/ })).toBeNull();
  });
});

describe('«استرجاع العملاء» — a row that carries the phone still copies only the number', () => {
  beforeEach(() => {
    apiJson.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method) throw new Error('a copy asked the server');
      return {
        rows: [
          {
            id: 'w1',
            orderNumber: 'ORD-W1',
            customer: { fullName: 'عميل تجريبي', phone: '0790000000' },
            product: 'ساعة',
            quantity: 1,
            sellingPrice: 40,
            discountAmount: 0,
            rejectionReason: 'PRICE_TOO_HIGH',
            rejectionNote: null,
            rejectedAt: '2026-09-20T10:00:00.000Z',
            verdict: { eligible: true, dueAt: '2026-10-04T10:00:00.000Z', maxDiscount: 10 },
          },
        ],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        facts: {
          views: { ready: 1, cooling: 0, skipped: 0 },
          reasons: [{ reason: 'PRICE_TOO_HIGH', count: 1 }],
          products: [{ name: 'ساعة', count: 1 }],
          periods: { '7': 1, '30': 1, '90': 1 },
          shipping: { before: 1, after: 0 },
        },
        rule: DEFAULT_WINBACK_RULE,
        canEditRule: false,
      };
    });
  });

  it('the button sits beside the link, copies the number, and nothing is sent', async () => {
    render(<WinbackScreen />);
    await screen.findByText('ORD-W1', undefined, WAIT);
    const link = screen.getByRole('link', { name: 'ORD-W1' });
    expect(link.getAttribute('href')).toBe('/orders/w1');
    // beside it: the same cluster as the number
    expect(link.parentElement!.contains(copyOf('ORD-W1'))).toBe(true);

    const asked = apiJson.mock.calls.length;
    await press(copyOf('ORD-W1'));
    expect(written).toEqual(['ORD-W1']);
    expect(apiJson.mock.calls.length).toBe(asked);
    expect(screen.queryByRole('button', { name: 'نسخ رقم هاتف الزبون' })).toBeNull();
  });
});

describe('«أحدث الطلبات على هذا المنتج» — its own link stays, the copy button joins it', () => {
  beforeEach(() => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        total: 1,
        orders: [
          {
            id: 'o1',
            orderNumber: 'ORD-26-0001',
            state: 'DELIVERED',
            totalAmount: 40,
            createdAt: '2026-10-20T12:00:00.000Z',
            customer: { fullName: 'نور الحسن', city: 'عمّان' },
            moderator: 'سارة',
          },
        ],
        currency: { code: 'JOD', minorUnit: 3 },
      }),
    });
  });

  it('the number still leads to the list with its row lit, and the button beside it copies it', async () => {
    render(<ProductRecentOrders productId="p-1" />);
    const link = (await screen.findAllByRole('link', { name: 'ORD-26-0001' }, WAIT))[0];
    expect(link.getAttribute('href')).toBe('/orders?highlight=o1');
    expect(link.parentElement!.contains(copyOf('ORD-26-0001'))).toBe(true);
    await press(copyOf('ORD-26-0001'));
    expect(written).toEqual(['ORD-26-0001']);
  });
});
