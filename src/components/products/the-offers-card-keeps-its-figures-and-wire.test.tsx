// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OFFERS CARD WEARS THE KIT — AND NOT ONE FIGURE OR BODY MOVED (18/11, R12e).
 *
 * The card's presses became `IconButton`, its three marks became `Checkbox`, its 12px text became 14px/13px. Offers carry
 * prices, «free» pieces, the delivery-included flag and the «after the order» flag, so this file is the DIFFERENTIAL: every
 * expectation below was first run against the card as it stood on `osm/main` before the change (green), and then against the
 * card after it (green). What it pins:
 *
 *   1. the figures a row prints (pieces, free pieces, price, the struck price, the price per piece, the door's ceiling);
 *   2. the hint under the price box (the ceiling the door refuses with);
 *   3. every request every press sends — path, method and the body, byte for byte: the star, on/off, the arrows, the bin,
 *      an edit saved as it opened, an edit with a changed price and the two flags, a new offer, the quick generator.
 *
 * A change of look that moved any of these is not a change of look.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { screenApi, confirmMock } = vi.hoisted(() => ({ screenApi: vi.fn(), confirmMock: vi.fn() }));
vi.mock('@/lib/screen-api', () => ({ screenApi }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirmMock }));

import { ProductOffers } from './ProductOffers';

beforeEach(() => {
  // jsdom has no ResizeObserver, and the drag library measures its drop zones with one.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const row = (over: Record<string, unknown>) => ({
  freeQuantity: 0,
  compareAtPrice: null,
  endsAt: null,
  discount: 0,
  deliveryIncluded: true,
  postOrderOffer: false,
  isDefault: false,
  status: 'ACTIVE',
  ...over,
});

const ROWS = [
  row({ id: 'offer-a', name: 'قطعة واحدة', quantity: 1, sellingPrice: 20, isDefault: true, sortOrder: 0 }),
  row({
    id: 'offer-b', name: 'ثلاث وهدية', quantity: 3, freeQuantity: 1, sellingPrice: 52.5, compareAtPrice: 80, discount: 2,
    sortOrder: 1, aboveBase: true, maxPrice: 60,
  }),
  row({ id: 'offer-c', name: 'بعد الطلب فقط', quantity: 1, sellingPrice: 15, postOrderOffer: true, status: 'INACTIVE', sortOrder: 2 }),
];

let sent: Array<{ path: string; method: string; body?: string }>;
let list: unknown[];

beforeEach(() => {
  sent = [];
  list = ROWS;
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  screenApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return { offers: JSON.parse(JSON.stringify(list)), minorUnit: 3 };
    sent.push({ path, method, body: init?.body === undefined ? undefined : String(init.body) });
    return { success: true };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mount = async (basePrice = 20) => {
  render(<ProductOffers productId="prod-1" basePrice={basePrice} currency="JOD" canManage />);
  if (list.length > 0) await screen.findAllByRole('listitem');
  else await screen.findByText(/لا عروض بعد/);
};
const rowsOf = () => screen.getAllByRole('listitem');
const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const typeIn = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const writes = () => sent.map((s) => [s.method, s.path, s.body ?? null]);

describe('1 · the figures each row prints', () => {
  it('pieces, free pieces, price, struck price, price per piece and the door’s ceiling — as before', async () => {
    await mount();
    const text = rowsOf().map((li) => li.textContent);
    expect(text[0]).toContain('1 قطعة — 20.000 JOD');
    expect(text[0]).not.toContain('للقطعة');
    expect(text[1]).toContain('3 قطعة + 1 مجاناً — 52.500 JOD 80.000 JOD · 13.125 JOD للقطعة');
    expect(text[1]).toContain('أغلى من السعر الأساسي — الحدّ 60.000 JOD');
    expect(text[2]).toContain('1 قطعة — 15.000 JOD');
    expect(text[2]).toContain('بعد الطلب');
    expect(text[2]).not.toContain('أغلى من السعر الأساسي');
  });

  it('the ceiling under the price box is the door’s figure for the pieces typed', async () => {
    await mount();
    await click(screen.getByText('عرض جديد'));
    typeIn('الكمية', '3');
    expect(screen.getByText(/أعلى سعر لهذا العرض/).textContent).toBe('أعلى سعر لهذا العرض: 60.000 JOD — 3 × السعر الأساسي 20. القطع المجانية ما بتنحسب.');
  });
});

describe('2 · every press sends what it sent', () => {
  it('the star makes an offer the default', async () => {
    await mount();
    await click(within(rowsOf()[1]).getByLabelText('اجعله الافتراضي'));
    await waitFor(() => expect(writes()).toEqual([['PATCH', '/api/offers/offer-b', '{"isDefault":true}']]));
  });

  it('on/off turns an offer off, and back on', async () => {
    await mount();
    await click(within(rowsOf()[0]).getByTitle('إيقاف'));
    await waitFor(() => expect(sent).toHaveLength(1));
    await click(within(rowsOf()[2]).getByTitle('تفعيل'));
    await waitFor(() =>
      expect(writes()).toEqual([
        ['PATCH', '/api/offers/offer-a', '{"status":"INACTIVE"}'],
        ['PATCH', '/api/offers/offer-c', '{"status":"ACTIVE"}'],
      ])
    );
  });

  it('the arrows write the new order in one request', async () => {
    await mount();
    await click(within(rowsOf()[0]).getByLabelText('لأسفل'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].method).toBe('PATCH');
    expect(sent[0].path).toBe('/api/offers');
    expect(JSON.parse(sent[0].body!)).toEqual({
      productId: 'prod-1',
      order: [
        { id: 'offer-b', sortOrder: 0 },
        { id: 'offer-a', sortOrder: 1 },
      ],
    });
  });

  it('the bin asks, then deletes', async () => {
    await mount();
    await click(within(rowsOf()[1]).getByLabelText('حذف'));
    await waitFor(() => expect(writes()).toEqual([['DELETE', '/api/offers/offer-b', null]]));
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it('an edit saved as it opened sends the stored row back, figure for figure', async () => {
    await mount();
    await click(within(rowsOf()[1]).getByLabelText('تعديل'));
    await click(screen.getByText('حفظ العرض'));
    await waitFor(() =>
      expect(writes()).toEqual([
        [
          'PATCH',
          '/api/offers/offer-b',
          '{"productId":"prod-1","name":"ثلاث وهدية","quantity":"3","freeQuantity":"1","sellingPrice":"52.5","compareAtPrice":80,"discount":2,"deliveryIncluded":true,"postOrderOffer":false,"isDefault":false,"sortOrder":1,"status":"ACTIVE"}',
        ],
      ])
    );
  });

  it('an edit with a new price, the delivery box cleared and «after the order» ticked', async () => {
    await mount();
    await click(within(rowsOf()[1]).getByLabelText('تعديل'));
    typeIn('السعر (JOD)', '55');
    typeIn('السعر قبل الخصم', '');
    typeIn('كمية مجانية', '');
    await click(screen.getByRole('checkbox', { name: /السعر شامل التوصيل/ }));
    await click(screen.getByRole('checkbox', { name: /العرض بعد الطلب/ }));
    await click(screen.getByText('حفظ العرض'));
    await waitFor(() =>
      expect(writes()).toEqual([
        [
          'PATCH',
          '/api/offers/offer-b',
          '{"productId":"prod-1","name":"ثلاث وهدية","quantity":"3","sellingPrice":"55","compareAtPrice":null,"discount":2,"deliveryIncluded":false,"postOrderOffer":true,"isDefault":false,"sortOrder":1,"status":"ACTIVE"}',
        ],
      ])
    );
  });

  it('a new offer sends what was typed, and nothing a browser made up', async () => {
    await mount();
    await click(screen.getByText('عرض جديد'));
    typeIn('اسم العرض', 'قطعتان');
    typeIn('الكمية', '2');
    typeIn('السعر (JOD)', '30');
    typeIn('السعر قبل الخصم', '40');
    await click(screen.getByRole('checkbox', { name: /العرض الافتراضي/ }));
    await click(screen.getByText('حفظ العرض'));
    await waitFor(() =>
      expect(writes()).toEqual([
        [
          'POST',
          '/api/offers',
          '{"productId":"prod-1","name":"قطعتان","quantity":"2","sellingPrice":"30","compareAtPrice":40,"isDefault":true,"sortOrder":3}',
        ],
      ])
    );
  });

  it('the quick generator writes the same three tiers, each under its line', async () => {
    list = [];
    await mount(12.5);
    await click(screen.getByText('توليد سريع'));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(writes()).toEqual([
      ['POST', '/api/offers', '{"productId":"prod-1","name":"قطعة واحدة","quantity":1,"freeQuantity":0,"sellingPrice":12.5,"compareAtPrice":null,"isDefault":false,"sortOrder":0}'],
      ['POST', '/api/offers', '{"productId":"prod-1","name":"قطعتان","quantity":2,"freeQuantity":0,"sellingPrice":23,"compareAtPrice":null,"isDefault":true,"sortOrder":1}'],
      ['POST', '/api/offers', '{"productId":"prod-1","name":"ثلاث قطع + واحدة هدية","quantity":3,"freeQuantity":1,"sellingPrice":31,"compareAtPrice":null,"isDefault":false,"sortOrder":2}'],
    ]);
  });
});
