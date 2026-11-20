// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «طلع من مخزن كذا» IN THE ORDER WINDOW (the warehouse plan, request W4d) — the shipping card of the window.
 *
 *   • an order the server names a source warehouse for shows «طلع من مخزن» beside «دفعة الشحن», with the server's name;
 *   • an order with none shows the card exactly as before: no such box, the same six boxes.
 */

const phone = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

import { ShippingSection } from './ShippingSection';

const ORDER = (over: Record<string, unknown> = {}) => ({
  id: 'ord-1',
  version: 7,
  shippingStatus: 'SHIPPED',
  deliveryProviderId: null,
  deliveryProvider: { id: 'p1', name: 'الباشا' },
  shippingBatch: { id: 'b1', batchNumber: 'B-17', status: 'CLOSED' },
  trackingNumber: 'TRK-1',
  deliveryFee: 3,
  shippedAt: '2026-11-18T10:00:00.000Z',
  outForDeliveryAt: null,
  deliveredAt: null,
  ...over,
});

beforeEach(() => {
  phone.value = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('delivery-attempts') ? { attempts: [] } : { providers: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = async (order: Record<string, unknown>) => {
  render(<ShippingSection order={order} ar isRtl onRefreshOrder={() => {}} />);
  await waitFor(() => expect(screen.getByText('الشحن والتوصيل')).toBeTruthy());
};
/** The info boxes' labels, in order. */
const labels = () => [...document.querySelectorAll('.grid > div > p:first-child')].map((p) => p.textContent);

describe('the shipping card of the order window', () => {
  it('— an order that left from a warehouse says which, right after its batch', async () => {
    await mount(ORDER({ sourceWarehouseName: 'المخزن الشمالي' }));
    const label = screen.getByText('طلع من مخزن');
    expect(label.nextElementSibling?.textContent).toBe('المخزن الشمالي');
    expect(labels()).toEqual(['شركة التوصيل', 'رقم التتبع', 'دفعة الشحن', 'طلع من مخزن', 'شُحن في', 'خرج للتوصيل', 'سُلّم في']);
  });

  it('and on a phone too', async () => {
    phone.value = true;
    await mount(ORDER({ sourceWarehouseName: 'المخزن الشمالي' }));
    expect(screen.getByText('المخزن الشمالي')).toBeTruthy();
  });

  it('NEGATIVE: an order with no source warehouse shows the card as it always was — the same six boxes, no «مخزن»', async () => {
    await mount(ORDER());
    expect(labels()).toEqual(['شركة التوصيل', 'رقم التتبع', 'دفعة الشحن', 'شُحن في', 'خرج للتوصيل', 'سُلّم في']);
    expect(document.body.textContent).not.toContain('مخزن');
  });
});
