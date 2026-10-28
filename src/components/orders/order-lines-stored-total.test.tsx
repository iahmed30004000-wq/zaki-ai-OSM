// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * THE EDITOR OPENS ON THE SERVER'S FIGURE FOR EACH LINE — THE LINE BEFORE THE
 * ORDER'S DISCOUNT. ALL OF IT, INCLUDING ZERO.
 *
 * TWO DEFECTS HAVE LIVED IN THIS ONE BOX.
 *
 * The first was a fallback: `Number(l.lineTotal) || Number(l.unitPrice) *
 * l.quantity`. A line whose total is legitimately 0 opened priced at
 * `unitPrice × quantity`, and `save()` posts the box as the item's
 * `unitPrice`, so pressing حفظ WROTE the invented number onto the order. The
 * fallback is gone and stays gone: money is the server's, and the stored
 * `unitPrice` is rounded, so 3 × 16.67 reads 50.01 against a stored 50.
 *
 * The second was the figure itself. The box opened on the stored
 * `lineTotal`, which is the line AFTER its share of the discount, while the
 * door reads `items[].unitPrice` as the line BEFORE it and spreads the
 * discount box over the lines again. So every untouched save took the
 * discount off once more — 64.200, then 57.400, then 50.600 — and once the
 * discount was more than the lines left after it, the door refused the save:
 * this file's own 3 × 14 with all 42 off opened at 0 beside a discount of 42.
 *
 * The box now opens on `beforeDiscount`, which `GET /api/orders/[id]` sends
 * per line (`totalsBeforeDiscount`). The card adds nothing up. Between them
 * the fixtures below make every reconstruction a browser could make —
 * `unitPrice × quantity`, `lineTotal + discountShare`, or `lineTotal` alone —
 * disagree with the server's figure somewhere.
 *
 * Decimals arrive as STRINGS over the wire (the detail route converts only
 * `commission` out of a Prisma `Decimal`), so they are written as strings
 * here; the server's own figure is a number.
 *
 * The round trip — the window's `GET`, this card's untouched body, the real
 * `PATCH`, twice — is `src/app/api/orders/[id]/the-lines-save-again.test.ts`,
 * which builds the body exactly as `save()` below is seen to send it.
 */

const { apiFetch, apiJson, ask } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  ask: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch, apiJson }));
// The reason dialog, spied on: `useOrderPatch` and the confirmed-order request both open it.
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => ask }));
// next/image is not this test's subject.
vi.mock('@/components/ui/ProductThumb', () => ({
  ProductThumb: () => <span data-testid="thumb" />,
}));

import { OrderLinesCard } from './OrderLinesCard';

const CURRENCY = { code: 'JOD', minorUnit: 3 };

/**
 * ONE LINE, THREE UNITS AT 14 — AND THE ORDER'S OWN 42 TAKES IT TO ZERO.
 *
 * Stored: share 42, line total 0. Before the discount the line is 42, which
 * is the figure the server sends, and the discount box opens on 42 beside it.
 */
const ZERO_LINE = {
  id: 'i1',
  productId: 'p1',
  productName: 'مقشر',
  quantity: 3,
  freeQuantity: 0,
  unitPrice: '14' as unknown as number,
  discountShare: '42' as unknown as number,
  lineTotal: '0' as unknown as number,
  beforeDiscount: 42,
};

type Line = typeof ZERO_LINE;

function order(items: Line[], over: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    version: 7,
    // Before confirmation: after it the card raises a request instead of
    // saving, which is the last describe below.
    confirmationStatus: 'NEW',
    totalAmount: 2.5,
    quantity: 3,
    sellingPrice: 42,
    discountAmount: 42,
    deliveryFee: 2.5,
    priceIncludesDelivery: false,
    internalNotes: null,
    customerNotes: null,
    items,
    product: { name: 'مقشر', image: null },
    productNameSnapshot: 'مقشر',
    productImageSnapshot: null,
    offer: null,
    deliveryProvider: { id: 'dp1', name: 'شركة' },
    ...over,
  };
}

function draw(items: Line[] = [ZERO_LINE], over: Record<string, unknown> = {}) {
  return render(
    <OrderLinesCard
      order={order(items, over)}
      currency={CURRENCY}
      canEdit
      onAcquireLock={() => {}}
      onSaved={() => {}}
    />
  );
}

/** Every line-price box inside `ProductLinesEditor`, by its own placeholder. */
const priceBoxes = () => screen.getAllByPlaceholderText('سعر السطر') as HTMLInputElement[];
const priceBox = () => priceBoxes()[0];

async function openEditor() {
  await userEvent.click(screen.getByRole('button', { name: /تعديل/ }));
  await waitFor(() => expect(priceBoxes().length).toBeGreaterThan(0));
}

const pressSave = () => userEvent.click(screen.getByRole('button', { name: /حفظ بيانات الطلب/ }));

/** What `save()` actually sent, parsed. */
function sentBody() {
  expect(apiFetch).toHaveBeenCalled();
  const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as {
    items: { productId: string; unitPrice: string; quantity: number }[];
    expectedVersion: number;
    discountAmount: number;
    customerNotes: string | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockResolvedValue({ products: [] });
  apiFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  // Cancelled: nothing in this file goes past the question.
  ask.mockResolvedValue(null);
});

afterEach(cleanup);

describe('a line the order’s discount took to zero', () => {
  it('still shows on the card as stored: 0 after the 42 off, 3 × 14', async () => {
    draw();
    // Scoped to the LINE's own row: 42 is also the order's selling price and
    // its discount, both of which legitimately print «42.000 JOD» in the
    // summary below. The row is the line after its discount.
    const row = screen.getByText('مقشر').closest('div.flex.items-center') as HTMLElement;
    expect(row.textContent).toContain('0.000 JOD');
    expect(row.textContent).not.toContain('42.000 JOD');
    expect(row.textContent).toContain('3 × 14.000 JOD');
  });

  it('opens the editor at 42 — the line before the discount, as the server sends it — not at its 0 after', async () => {
    draw();
    await openEditor();
    expect(Number(priceBox().value)).toBe(42);
    expect(Number(priceBox().value), 'فتح على السطر بعد الخصم').not.toBe(0);
  });

  it('and SAVES 42 beside the 42 off — the untouched save the door refused when the box said 0', async () => {
    draw();
    await openEditor();
    await pressSave();

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const body = sentBody();
    expect(body.items).toHaveLength(1);
    // The characters the box held, and the number the door will read.
    expect(body.items[0].unitPrice).toBe('42');
    expect(body.discountAmount).toBe(42);
    // The save is still the versioned one — the fix must not have changed
    // what the editor is for.
    expect(body.expectedVersion).toBe(7);
    expect(body.items[0].quantity).toBe(3);
  });
});

describe('the box holds the server’s figure, and no figure of the browser’s making', () => {
  it('an offer’s reduction that took the line to 0, on an order with no discount of its own, opens at 0', async () => {
    /*
     * As the storefront writes it: the offer's 42 is in the share, the order's
     * own discount is 0, so the line before THE ORDER'S discount is the 0
     * the customer was quoted. A browser that multiplied `unitPrice ×
     * quantity`, or added the share back, would open this box at 42 — and,
     * beside a discount box of 0, charge her 42.
     */
    draw([{ ...ZERO_LINE, beforeDiscount: 0 }], { discountAmount: 0, totalAmount: 2.5 });
    await openEditor();
    expect(Number(priceBox().value)).toBe(0);

    await pressSave();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(sentBody().items[0].unitPrice).toBe('0');
    expect(sentBody().discountAmount).toBe(0);
  });

  /**
   * A LINE WITH A REAL PRICE AND NO DISCOUNT IS UNTOUCHED, so the fix is not
   * «always add something». 2 × 12.5 stores 25, and 25 opens and saves.
   */
  it('leaves a priced line with no discount exactly as it is stored', async () => {
    draw(
      [{ ...ZERO_LINE, quantity: 2, unitPrice: '12.5' as unknown as number, discountShare: '0' as unknown as number, lineTotal: '25' as unknown as number, beforeDiscount: 25 }],
      { discountAmount: 0 }
    );
    await openEditor();
    expect(Number(priceBox().value)).toBe(25);

    await pressSave();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(sentBody().items[0].unitPrice).toBe('25');
    expect(Number(sentBody().items[0].unitPrice)).toBe(25);
  });

  /**
   * THE MULTIPLICATION WAS NOT A FAITHFUL COPY EITHER. `unitPrice` is stored
   * rounded, so a line of 3 for 50 stores 16.67 and 3 × 16.67 is 50.01 — a
   * fils invented in a frontend, where the contract forbids computing money
   * at all.
   */
  it('and is not reconstructed even when the product would be a fils off', async () => {
    draw(
      [{ ...ZERO_LINE, quantity: 3, unitPrice: '16.67' as unknown as number, discountShare: '0' as unknown as number, lineTotal: '50' as unknown as number, beforeDiscount: 50 }],
      { discountAmount: 0 }
    );
    await openEditor();
    expect(Number(priceBox().value)).toBe(50);
    expect(Number(priceBox().value)).not.toBe(50.01);
  });

  it('an untouched save of the worked example sends 60 and 8.5 with the 6.8 off — what the door reads as before the discount', async () => {
    // Stored after its first save: 54.044 and 7.656 after shares of 5.956 and 0.844.
    draw(
      [
        { ...ZERO_LINE, id: 'i-cream', productId: 'p-cream', productName: 'كريم', quantity: 5, unitPrice: '12' as unknown as number, discountShare: '5.956' as unknown as number, lineTotal: '54.044' as unknown as number, beforeDiscount: 60 },
        { ...ZERO_LINE, id: 'i-drops', productId: 'p-drops', productName: 'قطرة', quantity: 1, unitPrice: '8.5' as unknown as number, discountShare: '0.844' as unknown as number, lineTotal: '7.656' as unknown as number, beforeDiscount: 8.5 },
      ],
      { discountAmount: 6.8, sellingPrice: 68.5, quantity: 6, totalAmount: 64.2 }
    );
    await openEditor();
    expect(priceBoxes().map((b) => Number(b.value))).toEqual([60, 8.5]);

    await pressSave();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({
      expectedVersion: 7,
      items: [
        { productId: 'p-cream', quantity: 5, unitPrice: '60' },
        { productId: 'p-drops', quantity: 1, unitPrice: '8.5' },
      ],
      discountAmount: 6.8,
      customerNotes: null,
    });
  });
});

/*
 * ONCE CONFIRMED, THE SAVE COMPARES EACH BOX WITH THE FIGURE IT OPENED ON.
 *
 * A confirmed order's save becomes a change request for whatever changed,
 * and a change of price is refused with the door that can carry it. The
 * one-line comparison read `was.lineTotal` — after the discount, and a
 * string over the wire, against a number — so it called EVERY confirmed
 * one-line save a price change, a note alone included.
 */
describe('a confirmed order compares each box with the figure it opened on', () => {
  const ONE = {
    ...ZERO_LINE, id: 'i-cream', productId: 'p-cream', productName: 'كريم', quantity: 5,
    unitPrice: '12' as unknown as number, discountShare: '6' as unknown as number, lineTotal: '54' as unknown as number, beforeDiscount: 60,
  };
  const CONFIRMED = { confirmationStatus: 'CONFIRMED', discountAmount: 6, sellingPrice: 60, quantity: 5, totalAmount: 56.5 };
  const PRICE_REFUSAL = 'الطلب مؤكَّد — تغيير السعر';

  it('saved with nothing touched, it closes — no refusal over a price nobody changed', async () => {
    draw([ONE], CONFIRMED);
    await openEditor();
    expect(Number(priceBox().value)).toBe(60);
    await pressSave();

    await waitFor(() => expect(screen.queryByPlaceholderText('سعر السطر')).toBeNull());
    expect(document.body.textContent).not.toContain(PRICE_REFUSAL);
    expect(ask, 'سأل عن سبب لطلب ما فيه إشي').not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('and with only the note changed, it asks the reason for a request — it does not refuse a price change', async () => {
    draw([ONE], CONFIRMED);
    await openEditor();
    await userEvent.type(screen.getByPlaceholderText(/ما طلبه العميل/), 'التوصيل بعد العصر');
    await pressSave();

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0][0].title).toBe('طلب تعديل');
    expect(document.body.textContent).not.toContain(PRICE_REFUSAL);
  });

  it('and a two-line confirmed order saved untouched closes too — the lines read as untouched', async () => {
    draw(
      [
        ONE,
        { ...ZERO_LINE, id: 'i-drops', productId: 'p-drops', productName: 'قطرة', quantity: 1, unitPrice: '8.5' as unknown as number, discountShare: '0' as unknown as number, lineTotal: '8.5' as unknown as number, beforeDiscount: 8.5 },
      ],
      { ...CONFIRMED, sellingPrice: 68.5, quantity: 6, totalAmount: 65 }
    );
    await openEditor();
    await pressSave();

    await waitFor(() => expect(screen.queryByPlaceholderText('سعر السطر')).toBeNull());
    expect(document.body.textContent).not.toContain('الطلب مؤكَّد وفيه أكتر من سطر');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

/**
 * AN ORDER WITH NO LINES SAYS SO, RATHER THAN BEING GIVEN ONE.
 *
 * The card built a synthetic line when `order.items` was empty, priced at
 * `sellingPrice / quantity` — rounded by nothing, against the server's
 * `lineTotal / quantity` to two places. `the-frontend-invariants.test.ts`
 * carried it on its DIVERGED list with the disagreement measured (3 units
 * over 50: server 16.67, card 50.01) and the remedy stated: delete the
 * branch.
 *
 * MEASURED BEFORE DELETING: 0 of 56 orders on this database have no items,
 * so nothing a person looks at today changes. What goes is a second copy of
 * a money rule, waiting for the day something makes a lineless order and
 * prints a figure nobody can trace.
 *
 * The fixture below is the shape that made the divergence visible — 3 units
 * for 50 — so a restored branch dies on the number rather than on a layout.
 */
describe('an order with no lines at all', () => {
  const uneven = () => draw([], { quantity: 3, sellingPrice: 50 });

  it('prints no invented unit price — 16.667 is nobody’s figure', () => {
    uneven();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('16.66');
    expect(text).not.toContain('16.67');
    // And no «3 ×» row at all, because there is no line to multiply.
    expect(text).not.toMatch(/3\s*×/);
  });

  it('and says in a sentence that there are none', () => {
    uneven();
    expect(document.body.textContent).toContain('لا أسطرَ مسجَّلةٌ على هذا الطلب');
  });

  it('while the order’s own figures, which the server holds, are still shown', () => {
    // Nothing a reader needs is lost: the summary below the list carries the
    // selling price and the quantity exactly as the server sent them.
    uneven();
    const text = document.body.textContent ?? '';
    expect(text).toContain('سعر البيع');
    expect(text).toContain('الكمية');
  });
});
