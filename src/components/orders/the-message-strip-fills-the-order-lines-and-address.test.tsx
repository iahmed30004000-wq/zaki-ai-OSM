// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * DEFINITION OF DONE
 *
 * The owner, from the screen of the template words: «ضيف الهم بيانات الطلب».
 * Four new placeholders — «المنتجات» «الكمية» «العنوان» «تاريخ_الطلب» — are filled from the order itself on EVERY
 * screen that shows the strip, though no list row carries the lines.
 *
 *  1. A wording that uses one of them reads the order once (`/api/orders/:id`) and shows the filled sentence.
 *  2. Until the order answers, that wording cannot be sent: nothing leaves with a blank where the products go.
 *  3. A wording that uses none of them never reads the order.
 *  4. If the read fails the wording is sent as it stands (blank words), as it was before — the strip never breaks.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { ContactButtons } from './ContactButtons';

const ORDER = {
  createdAt: '2026-10-28T09:00:00.000Z',
  deliveryAddress: 'دمشق، المزة، شارع 3',
  customer: { address: 'عنوان الزبون' },
  items: [
    { productName: 'كريم', quantity: 2, freeQuantity: 1 },
    { productName: 'صابون', quantity: 1, freeQuantity: 0 },
  ],
};
const CTX = { orderNumber: 'ORD-1', customerName: 'أبو محمد' };

const tpl = (id: string, body: string) => ({ id, name: `ق-${id}`, channel: 'BOTH', body, situation: 'other', lang: 'ar', active: true });

let order: () => Promise<unknown>;
const setup = (templates: unknown[]) => {
  apiJson.mockImplementation((url: string) => {
    if (url === '/api/settings/messages') return Promise.resolve({ templates });
    if (url.startsWith('/api/orders/')) return order();
    return Promise.resolve({});
  });
};
const orderCalls = () => apiJson.mock.calls.filter((c) => String(c[0]).startsWith('/api/orders/'));
const openWhatsapp = async () => {
  fireEvent.click(screen.getByTitle('واتساب'));
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { ...navigator, maxTouchPoints: 5 });
  order = () => Promise.resolve({ order: ORDER });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a wording that uses the order lines', () => {
  it('reads the order once and shows the products, quantity, address and date filled in', async () => {
    setup([tpl('a', 'طلبك: {المنتجات} — {الكمية} قطع — إلى {العنوان} — بتاريخ {تاريخ_الطلب}')]);
    render(<ContactButtons phone="0791234567" countryCode="962" orderId="o1" context={CTX} />);
    await openWhatsapp();

    const preview = await screen.findByText(/كريم × 2/);
    expect(preview.textContent).toContain('كريم × 2 (+ 1 هدية)، صابون × 1');
    expect(preview.textContent).toContain('3 قطع');
    expect(preview.textContent).toContain('دمشق، المزة، شارع 3');
    expect(preview.textContent).toContain('28/10/2026');
    expect(orderCalls()).toHaveLength(1);
    expect(orderCalls()[0][0]).toBe('/api/orders/o1');
  });

  it('cannot be sent while the order is still being read', async () => {
    let release!: (v: unknown) => void;
    const pending = new Promise((r) => {
      release = r;
    });
    order = () => pending;
    setup([tpl('a', 'منتجاتك {المنتجات}')]);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<ContactButtons phone="0791234567" countryCode="962" orderId="o1" context={CTX} />);
    await openWhatsapp();

    const button = (await screen.findByText('ق-a')).closest('button')!;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(open).not.toHaveBeenCalled();

    release({ order: ORDER });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(String(open.mock.calls[0][0]))).toContain('كريم × 2');
  });

  it('a failed read does not break the strip: the wording is sent with the words blank, as before', async () => {
    order = () => Promise.reject(new Error('x'));
    setup([tpl('a', 'منتجاتك {المنتجات}.')]);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<ContactButtons phone="0791234567" countryCode="962" orderId="o1" context={CTX} />);
    await openWhatsapp();

    const button = (await screen.findByText('ق-a')).closest('button')!;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('a wording that uses none of them', () => {
  it('never reads the order', async () => {
    setup([tpl('b', 'مرحبا {اسم_الزبون}، طلبك {رقم_الطلب}')]);
    render(<ContactButtons phone="0791234567" countryCode="962" orderId="o1" context={CTX} />);
    await openWhatsapp();
    await screen.findByText('ق-b');
    expect(orderCalls()).toHaveLength(0);
  });

  it('and a strip with no order behind it never reads one either', async () => {
    setup([tpl('a', 'منتجاتك {المنتجات}')]);
    render(<ContactButtons phone="0791234567" countryCode="962" context={CTX} />);
    await openWhatsapp();
    await screen.findByText('ق-a');
    expect(orderCalls()).toHaveLength(0);
  });
});
