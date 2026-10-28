// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * «العرض ما بصير يكون اكثر من السعر الاساسي» — ON THE OFFERS SCREEN.
 *
 * Three things the seller sees, each built on what the door decides rather than on a second copy of the rule:
 *
 *   · under the price box, the line for the quantity being typed — from `offerCeiling`, the function the door
 *     refuses with, at the store's own decimals;
 *   · on a row saved above its line before the rule existed, a flag carrying the line the DOOR sent;
 *   · «توليد سريع» never writes a tier the door refuses — proved by handing the bodies it sends to the real door.
 */

const { db, screenApi } = vi.hoisted(() => ({
  db: {
    offer: { create: vi.fn(), updateMany: vi.fn() },
    product: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  screenApi: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/landing-cache', () => ({ refreshLandingPages: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1' },
    companyId: 'c1',
    storeId: 's1',
    country: { currencyCode: 'JOD', minorUnit: 3 },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));
vi.mock('@/lib/screen-api', () => ({ screenApi }));

import { POST as OFFERS_POST } from '@/app/api/offers/route';
import { ProductOffers } from './ProductOffers';

const PRODUCT_ID = 'prod-aaaaaaaaaa';

/** Every non-GET body the screen sent, in order. */
let sent: { url: string; method: string; body: Record<string, unknown> }[] = [];

/** The offers door's list, as the screen reads it: rows, and the store's own decimals. */
function serve(offers: object[] = []) {
  screenApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return { offers, minorUnit: 3 };
    sent.push({ url: path, method, body: JSON.parse(String(init?.body)) });
    return { success: true };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  // jsdom has no ResizeObserver, and the drag library measures its drop zones with one.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  serve();
  db.offer.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'offer-new', ...data }));
  db.offer.updateMany.mockResolvedValue({ count: 0 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ offer: db.offer }));
});

afterEach(() => {
  cleanup();
});

const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

/** Open a new offer's draft on a product priced at `basePrice`. */
async function openDraft(basePrice: number, canChangePrice?: boolean) {
  const user = userEvent.setup();
  render(<ProductOffers productId={PRODUCT_ID} basePrice={basePrice} currency="JOD" canChangePrice={canChangePrice} />);
  await waitFor(() => expect(screen.getByText('عرض جديد')).toBeTruthy());
  await user.click(screen.getByText('عرض جديد'));
  await waitFor(() => expect(box('الكمية')).toBeTruthy());
  return user;
}

describe('the line under the price box', () => {
  it('with a quantity typed, it is the figure — and the arithmetic that makes it, so it can be checked', async () => {
    const user = await openDraft(25);
    await user.type(box('الكمية'), '3');
    const hint = screen.getByText(/أعلى سعر لهذا العرض/);
    expect(hint.textContent).toBe('أعلى سعر لهذا العرض: 75.000 JOD — 3 × السعر الأساسي 25. القطع المجانية ما بتنحسب.');
  });

  it('and a gift typed beside it does not move the line — the free pieces are not counted', async () => {
    const user = await openDraft(25);
    await user.type(box('الكمية'), '3');
    await user.type(box('كمية مجانية'), '1');
    expect(screen.getByText(/أعلى سعر لهذا العرض/).textContent).toContain('75.000 JOD — 3 × السعر الأساسي 25');
  });

  it('with the quantity box empty, it states the rule and invents no number — not even the 1 the door would fill in', async () => {
    await openDraft(25);
    const hint = screen.getByText(/سعر العرض ما بيزيد عن السعر الأساسي/);
    expect(hint.textContent).toBe('سعر العرض ما بيزيد عن السعر الأساسي × عدد القطع المدفوعة. القطع المجانية ما بتنحسب.');
    expect(hint.textContent).not.toMatch(/\d/);
    expect(screen.queryByText(/أعلى سعر لهذا العرض/)).toBeNull();
  });

  it('with no base price, it says there is no line yet — and names «تعديل المنتج» to somebody who may write one', async () => {
    await openDraft(0, true);
    const hint = screen.getByText(/ما في سعر أساسي لهذا المنتج لسّا/);
    expect(hint.textContent).toContain('فما في حدّ أعلى لسعر العرض');
    expect(hint.textContent).toContain('«تعديل المنتج»');
  });

  it('NEGATIVE: and does NOT send somebody without the price authority to a door that refuses them', async () => {
    await openDraft(0);
    const hint = screen.getByText(/ما في سعر أساسي لهذا المنتج لسّا/);
    expect(hint.textContent).not.toContain('تعديل المنتج');
    expect(hint.textContent).toContain('«تغيير أسعار المنتجات»');
  });
});

describe('a row saved above its line before the rule', () => {
  const row = (id: string, name: string, over: object) => ({
    id,
    name,
    quantity: 3,
    freeQuantity: 0,
    sellingPrice: 80,
    compareAtPrice: null,
    endsAt: null,
    discount: 0,
    deliveryIncluded: true,
    postOrderOffer: false,
    isDefault: false,
    sortOrder: 0,
    status: 'ACTIVE',
    ...over,
  });

  it('is flagged with the line the DOOR sent — not one the screen worked out', async () => {
    // 70, where 3 × 25 would be 75: the badge prints the server's figure, so a disagreement could only be the
    // server's, never a second calculation in the browser.
    serve([
      row('offer-1', 'ثلاث قطع', { aboveBase: true, maxPrice: 70 }),
      row('offer-2', 'ثلاث قطع بسعرها', { sellingPrice: 60, sortOrder: 1, aboveBase: false, maxPrice: 75 }),
    ]);
    render(<ProductOffers productId={PRODUCT_ID} basePrice={25} currency="JOD" />);
    await waitFor(() => expect(screen.getAllByText(/أغلى من السعر الأساسي/)).toHaveLength(1));
    const flag = screen.getByText(/أغلى من السعر الأساسي/);
    expect(flag.textContent).toBe('أغلى من السعر الأساسي — الحدّ 70.000 JOD');
    // On the flagged row, and only there.
    expect(flag.closest('li')?.textContent).toContain('ثلاث قطع');
    expect(flag.closest('li')?.textContent).not.toContain('بسعرها');
  });

  it('NEGATIVE: a row the door did not flag carries nothing, whatever its numbers look like', async () => {
    serve([row('offer-1', 'ثلاث قطع', { aboveBase: false, maxPrice: 75 })]);
    render(<ProductOffers productId={PRODUCT_ID} basePrice={25} currency="JOD" />);
    await waitFor(() => expect(screen.getByText('ثلاث قطع')).toBeTruthy());
    expect(screen.queryByText(/أغلى من السعر الأساسي/)).toBeNull();
  });
});

describe('«توليد سريع» writes nothing the door refuses', () => {
  /** Press the generator on a product priced at `basePrice` and return the three bodies it sent. */
  async function generatedAt(basePrice: number) {
    const user = userEvent.setup();
    render(<ProductOffers productId={PRODUCT_ID} basePrice={basePrice} currency="JOD" />);
    await waitFor(() => expect(screen.getByText('توليد سريع')).toBeTruthy());
    await user.click(screen.getByText('توليد سريع'));
    await waitFor(() => expect(sent).toHaveLength(3));
    return sent.map((s) => s.body);
  }

  const atTheCreateDoor = (body: unknown) =>
    OFFERS_POST(
      new Request('http://localhost/api/offers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );

  it('a base price with a fraction: 12.5 made a first tier of 13 — every tier now passes the real door', async () => {
    db.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, companyId: 'c1', storeId: 's1', basePrice: 12.5 });
    const bodies = await generatedAt(12.5);
    // One piece at most 12.5; two and three pieces are under their lines of 25 and 37.5 as rounded.
    expect(bodies.map((b) => b.sellingPrice)).toEqual([12.5, 23, 31]);
    for (const body of bodies) {
      const res = await atTheCreateDoor(body);
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    }
    expect(db.offer.create).toHaveBeenCalledTimes(3);
  });

  it('a whole base price is untouched by the cap: 25 still makes 25, 45 and 63', async () => {
    const bodies = await generatedAt(25);
    expect(bodies.map((b) => [b.quantity, b.freeQuantity, b.sellingPrice])).toEqual([
      [1, 0, 25],
      [2, 0, 45],
      [3, 1, 63],
    ]);
  });
});
