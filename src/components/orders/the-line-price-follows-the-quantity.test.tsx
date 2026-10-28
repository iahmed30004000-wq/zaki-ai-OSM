// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';
import type { Currency } from '@/lib/format';

/**
 * THE LINE'S PRICE BOX FOLLOWS ITS QUANTITY — UNTIL A PERSON WRITES IN IT.
 *
 * The bug: in «طلب جديد» a product at 25, changed to two pieces, still said
 * 25, and the order was saved at 25 instead of 50 unless somebody fixed it
 * by hand. The box holds the TOTAL for the line's paid quantity, and the
 * quantity controls never touched it. The same after an offer: «3 بـ60»,
 * the offer let go, a fourth piece — still 60.
 *
 *   D1  a line nobody wrote in follows: the offer's price while an offer is
 *       chosen, otherwise the base price for the PAID quantity;
 *   D2  a figure a person typed is theirs: a quantity change keeps it, and
 *       the line under the box names the base price, one press away;
 *   D3  a line opened from a SAVED order is never rewritten either;
 *   D4  the request carries the same keys it always did, and the door's
 *       arithmetic is not touched (the round trip is in
 *       `the-price-boxes-and-their-doors-agree.test.tsx`);
 *   D5  rounded by the store's own minor unit; no figure for a base price of
 *       0 or for a currency not known yet; a gift is never priced.
 *
 * Every rule carries its NEGATIVE — the value today's bug, or the obvious
 * wrong fix, would have produced.
 */

const { apiFetch, apiJson } = vi.hoisted(() => ({ apiFetch: vi.fn(), apiJson: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ apiFetch, apiJson }));
// The reason dialog belongs to `useOrderPatch`; a 200 never opens it.
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null }));
// next/image is not this file's subject.
vi.mock('@/components/ui/ProductThumb', () => ({ ProductThumb: () => <span data-testid="thumb" /> }));
// Nor is the searchable picker: a native select makes choosing a product one call.
vi.mock('@/components/ui/ProductPicker', () => ({
  ProductPicker: ({
    value,
    onChange,
    products,
  }: {
    value: string;
    onChange: (id: string) => void;
    products: { id: string; name: string }[];
  }) => (
    <select aria-label="المنتج" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {products.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  ),
}));

import { ProductLinesEditor, newLine, withOffer, withQuantity, type DraftLine } from './ProductLinesEditor';
import { OrderLinesCard } from './OrderLinesCard';

/* ── the catalogue ─────────────────────────────────────────────────────── */

/*
 * The ids are camelCase on purpose: an id spelled like a spacing class is a
 * class to the stylesheet's scanner, which reads tests too.
 */
const AT_25 = { id: 'prodTwentyFive', name: 'كريم', basePrice: 25, offers: [] };
/** «3 + 1 هدية» for 60, on a product whose base price is 25. */
const BUNDLE = {
  id: 'prodBundle',
  name: 'غسول',
  basePrice: 25,
  offers: [{ id: 'offerThree', name: 'ثلاث قطع', quantity: 3, freeQuantity: 1, sellingPrice: 60 }],
};
/** Base price 0: the column's default, «not set yet». */
const UNPRICED = { id: 'prodUnpriced', name: 'عيّنة', basePrice: 0, offers: [] };
const TENTH = { id: 'prodTenth', name: 'لصقة', basePrice: 0.1, offers: [] };
const EIGHTH = { id: 'prodEighth', name: 'مرهم', basePrice: 0.125, offers: [] };
const HALF = { id: 'prodHalf', name: 'صابون', basePrice: 12.5, offers: [] };
const CATALOGUE = [AT_25, BUNDLE, UNPRICED, TENTH, EIGHTH, HALF];

const JOD2: Currency = { code: 'JOD', minorUnit: 2 };

/** The real editor, holding its own lines the way both hosts do. */
function Harness({ currency = JOD2, initial }: { currency?: Currency | null; initial?: DraftLine[] }) {
  const [lines, setLines] = useState<DraftLine[]>(initial ?? [newLine()]);
  return <ProductLinesEditor lines={lines} products={CATALOGUE} currency={currency} onChange={setLines} />;
}

/* ── finding things the way a person does ──────────────────────────────── */

const priceBox = () => screen.getByPlaceholderText('سعر السطر') as HTMLInputElement;
const quantityBox = () =>
  screen.getAllByRole('spinbutton').find((el) => el !== priceBox()) as HTMLInputElement;
const plus = () => screen.getByRole('button', { name: 'زد الكمية' }) as HTMLButtonElement;
const minus = () => screen.getByRole('button', { name: 'أنقص الكمية' }) as HTMLButtonElement;
const restore = () => screen.queryByRole('button', { name: 'رجّعه للسعر الأساسي' });
/** The line under the box, or null. Its text carries the figure. */
const hint = () => screen.queryByText(/مكتوب بإيدك/);
const offerSelect = () =>
  screen.getByRole('option', { name: 'بلا عرض — سعر مباشر' }).closest('select') as HTMLSelectElement;

async function pick(user: ReturnType<typeof userEvent.setup>, productId: string) {
  await user.selectOptions(screen.getByLabelText('المنتج'), productId);
}

async function typePrice(user: ReturnType<typeof userEvent.setup>, figure: string) {
  await user.clear(priceBox());
  await user.type(priceBox(), figure);
}

/** Press «رجّعه للسعر الأساسي» — and fail by name when it is not there to press. */
async function pressRestore(user: ReturnType<typeof userEvent.setup>) {
  const button = restore();
  expect(button, 'زر «رجّعه للسعر الأساسي» مش ظاهر').not.toBeNull();
  await user.click(button!);
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

/* ══════════════════════════════════════════════════════════════════════ */

describe('D1 — a line nobody wrote in follows its quantity', () => {
  it('the worked example: 25 for one piece, 50 for two, 75 for three, and back to 50', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, AT_25.id);
    expect(priceBox().value).toBe('25');

    await user.click(plus());
    // NEGATIVE first, because it is the bug: two pieces, and the box still said 25.
    expect(priceBox().value, 'الكمية تغيّرت والسعر لا').not.toBe('25');
    expect(priceBox().value).toBe('50');

    await user.click(plus());
    expect(priceBox().value).toBe('75');
    await user.click(minus());
    expect(priceBox().value).toBe('50');
    expect(quantityBox().value).toBe('2');
    // A line that follows has nothing to explain.
    expect(hint()).toBeNull();
    expect(restore()).toBeNull();
  });

  it('and a quantity typed into its box follows the same way', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, AT_25.id);
    fireEvent.change(quantityBox(), { target: { value: '4' } });
    expect(priceBox().value).toBe('100');
    // NEGATIVE: not one piece's price for four pieces.
    expect(priceBox().value).not.toBe('25');
  });

  it('an offer sets its own price; letting it go prices the PAID pieces at base — the gift is never priced', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, BUNDLE.id);
    // The product's first offer is adopted, as it always was: «3 + 1» for 60.
    expect(priceBox().value).toBe('60');
    expect(quantityBox().value).toBe('3');
    // The offer holds both boxes, as it always did.
    expect(priceBox().disabled).toBe(true);
    expect(plus().disabled).toBe(true);

    await user.selectOptions(offerSelect(), '');
    expect(priceBox().value).toBe('75');
    // NEGATIVE: not the stale offer price, and not the gift counted as a fourth paid piece.
    expect(priceBox().value, 'سعر العرض ضلّ بعد ما راح العرض').not.toBe('60');
    expect(priceBox().value, 'الهدية انحسبت').not.toBe('100');

    await user.click(plus());
    expect(priceBox().value).toBe('100');
    // NEGATIVE: not 60 for four pieces, and not 125 (four paid plus the gift).
    expect(priceBox().value).not.toBe('60');
    expect(priceBox().value).not.toBe('125');
  });

  it('the same rule without the form: «3 بـ60» moved to four pieces drops the offer and is 100', () => {
    const line = newLine(BUNDLE, 2);
    expect(line).toMatchObject({ offerId: 'offerThree', quantity: 3, price: '60', pricing: 'follows' });

    const four = withQuantity(line, 4, BUNDLE, 2);
    expect(four).toMatchObject({ offerId: null, quantity: 4, price: '100', pricing: 'follows' });
    // NEGATIVE: the bundle's price does not survive the bundle.
    expect(four.price).not.toBe('60');
    // And the line is a new object: the old one is untouched.
    expect(line.price).toBe('60');
  });

  it('picking an offer again takes its price, even over a typed figure, and the line follows again', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, BUNDLE.id);
    await user.selectOptions(offerSelect(), '');
    await typePrice(user, '33');
    expect(priceBox().value).toBe('33');

    await user.selectOptions(offerSelect(), 'offerThree');
    expect(priceBox().value).toBe('60');
    // NEGATIVE: the typed 33 is gone, in plain view.
    expect(priceBox().value).not.toBe('33');
    expect(hint()).toBeNull();

    // It follows again: let the offer go and add a piece — base × 4.
    await user.selectOptions(offerSelect(), '');
    await user.click(plus());
    expect(priceBox().value).toBe('100');
  });

  it('and «بلا عرض» on a line somebody typed leaves the typed figure alone', () => {
    const typed: DraftLine = { key: 'k', productId: BUNDLE.id, offerId: null, quantity: 3, price: '50', pricing: 'typed' };
    expect(withOffer(typed, '', BUNDLE, 2)).toMatchObject({ offerId: null, price: '50', pricing: 'typed' });
    // NEGATIVE: a following line in the same place is priced at base × 3.
    expect(withOffer({ ...typed, pricing: 'follows' }, '', BUNDLE, 2).price).toBe('75');
  });
});

describe('D2 — a figure a person typed is theirs', () => {
  it('typed 30, a second piece: still 30, and the line names the base price 50', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, AT_25.id);
    await typePrice(user, '30');
    await user.click(plus());

    expect(priceBox().value).toBe('30');
    // NEGATIVE: never rewritten behind the person's back.
    expect(priceBox().value).not.toBe('50');
    expect(hint()?.textContent).toContain('مكتوب بإيدك — بالسعر الأساسي:');
    expect(hint()?.textContent).toContain('50.00 JOD');
    expect(restore()).not.toBeNull();
  });

  it('the worked example: typed 45, three pieces → still 45, and the line says 75', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, AT_25.id);
    await user.click(plus());
    expect(priceBox().value).toBe('50');
    await typePrice(user, '45');
    await user.click(plus());

    expect(quantityBox().value).toBe('3');
    expect(priceBox().value).toBe('45');
    expect(priceBox().value).not.toBe('75');
    expect(hint()?.textContent).toContain('75.00 JOD');
  });

  it('«رجّعه للسعر الأساسي» writes the base price, and the line follows again', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, AT_25.id);
    await user.click(plus());
    await typePrice(user, '45');
    await user.click(plus());

    await pressRestore(user);
    expect(priceBox().value).toBe('75');
    expect(hint()).toBeNull();
    expect(restore()).toBeNull();

    await user.click(plus());
    // NEGATIVE: after the restore a piece more is priced — the line follows again.
    expect(priceBox().value, 'بعد الإرجاع ما رجع يلحق الكمية').not.toBe('75');
    expect(priceBox().value).toBe('100');
  });

  it('no line while the typed figure IS the base price — and the figure stays the person’s', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, AT_25.id);
    await user.click(plus());
    await typePrice(user, '50');
    expect(hint()).toBeNull();

    // NEGATIVE: the line CAN appear — one piece more and the typed 50 is kept, and named.
    await user.click(plus());
    expect(priceBox().value).toBe('50');
    expect(hint()?.textContent).toContain('75.00 JOD');
  });

  it('a cleared box shows the line, and only the button fills it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, AT_25.id);
    await user.clear(priceBox());

    // NEGATIVE: the box is never refilled on its own — an empty box is still the person's.
    expect(priceBox().value).toBe('');
    expect(hint()?.textContent).toContain('25.00 JOD');

    await pressRestore(user);
    expect(priceBox().value).toBe('25');
    expect(hint()).toBeNull();
  });
});

describe('D3 — a line opened from a saved order is never rewritten', () => {
  const saved = (quantity: number, price: string): DraftLine => ({
    key: 'savedLine',
    productId: AT_25.id,
    offerId: null,
    quantity,
    price,
    pricing: 'saved',
  });

  it('opens silent at its saved total, and a quantity change keeps it and names the base price', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[saved(2, '40')]} />);
    expect(priceBox().value).toBe('40');
    // 40 is not 2 × 25, and still nothing is said: it was agreed with the customer.
    expect(hint()).toBeNull();

    await user.click(plus());
    expect(priceBox().value).toBe('40');
    // NEGATIVE: the saved money does not move on its own.
    expect(priceBox().value, 'السعر المحفوظ اتغيّر لحاله').not.toBe('75');
    expect(hint()?.textContent).toContain('75.00 JOD');
    expect(restore()).not.toBeNull();
  });

  it('and a press that changes nothing (− at one piece) leaves it silent', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[saved(1, '40')]} />);
    await user.click(minus());
    expect(quantityBox().value).toBe('1');
    expect(priceBox().value).toBe('40');
    expect(hint()).toBeNull();
    // NEGATIVE: a real change does speak.
    await user.click(plus());
    expect(hint()?.textContent).toContain('50.00 JOD');
  });
});

describe('D5 — the store’s own decimals, and no figure it does not have', () => {
  it('a base price of 0 is an empty box, before and after a quantity change, with no line', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pick(user, UNPRICED.id);
    // NEGATIVE: never the free line `0` the old seed opened with.
    expect(priceBox().value).not.toBe('0');
    expect(priceBox().value).toBe('');
    await user.click(plus());
    expect(priceBox().value).toBe('');
    expect(hint()).toBeNull();
  });

  it('USD, two decimals: 0.1 × 3 is 0.3', async () => {
    const user = userEvent.setup();
    render(<Harness currency={{ code: 'USD', minorUnit: 2 }} />);
    await pick(user, TENTH.id);
    await user.click(plus());
    await user.click(plus());
    expect(priceBox().value).toBe('0.3');
    // NEGATIVE: the float noise a bare multiplication writes.
    expect(priceBox().value).not.toBe('0.30000000000000004');
  });

  it('JOD, three decimals: 0.125 × 3 is 0.375, and the echo keeps the third decimal', async () => {
    const user = userEvent.setup();
    render(<Harness currency={{ code: 'JOD', minorUnit: 3 }} />);
    await pick(user, EIGHTH.id);
    await user.click(plus());
    await user.click(plus());
    expect(priceBox().value).toBe('0.375');
    expect(screen.getAllByText('0.375 JOD').length).toBeGreaterThan(0);
  });

  it('NEGATIVE: the same clicks under two decimals give 0.38 — the unit is read, not fixed', async () => {
    const user = userEvent.setup();
    render(<Harness currency={{ code: 'JOD', minorUnit: 2 }} />);
    await pick(user, EIGHTH.id);
    await user.click(plus());
    await user.click(plus());
    expect(priceBox().value).toBe('0.38');
  });

  it('a whole-unit currency (minor unit 0, the SYP example) rounds to whole pieces of money', async () => {
    /*
     * The unit is whatever the server sends from `Country.minorUnit`; 0 is
     * the edge being held here, not a claim about one currency's table.
     */
    const user = userEvent.setup();
    render(<Harness currency={{ code: 'SYP', minorUnit: 0 }} />);
    await pick(user, HALF.id);
    expect(priceBox().value).toBe('13');
    await user.click(plus());
    await user.click(plus());
    expect(priceBox().value).toBe('38');
    // NEGATIVE: nothing below the unit survives.
    expect(priceBox().value).not.toBe('37.5');
    expect(screen.getAllByText('38 SYP').length).toBeGreaterThan(0);
  });

  it('no currency yet: the box waits empty rather than round to a unit nobody stated', async () => {
    const user = userEvent.setup();
    render(<Harness currency={null} />);
    await pick(user, AT_25.id);
    expect(priceBox().value).toBe('');
    await user.click(plus());
    // NEGATIVE: never a figure computed under an assumed two decimals.
    expect(priceBox().value).not.toBe('25');
    expect(priceBox().value).not.toBe('50');
    expect(priceBox().value).toBe('');
  });
});

/* ── the saved order, through the real card ────────────────────────────── */

describe('D3 + D4 — the order screen’s card, saved line and request body', () => {
  const CURRENCY: Currency = { code: 'JOD', minorUnit: 3 };
  const SAVED = {
    id: 'i1',
    productId: 'p1',
    productName: 'مقشر',
    quantity: 2,
    freeQuantity: 0,
    // Decimals arrive as strings over the wire.
    unitPrice: '20' as unknown as number,
    discountShare: '0' as unknown as number,
    lineTotal: '40' as unknown as number,
  };
  const ORDER = {
    id: 'o1',
    version: 7,
    // Before confirmation: the card saves rather than raising a request.
    confirmationStatus: 'NEW',
    totalAmount: 40,
    quantity: 2,
    sellingPrice: 40,
    discountAmount: 0,
    deliveryFee: null,
    priceIncludesDelivery: false,
    internalNotes: null,
    customerNotes: null,
    items: [SAVED],
    product: { name: 'مقشر', image: null },
    productNameSnapshot: 'مقشر',
    productImageSnapshot: null,
    offer: null,
    deliveryProvider: null,
  };

  /** What the save sent — the request body only: the door's line branch is fixed elsewhere. */
  function sentItems() {
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/orders/o1');
    expect(init.method).toBe('PATCH');
    return (JSON.parse(init.body) as { items: Record<string, unknown>[] }).items;
  }

  async function openTheCard(user: ReturnType<typeof userEvent.setup>) {
    render(
      <OrderLinesCard order={ORDER} currency={CURRENCY} canEdit onAcquireLock={() => {}} onSaved={() => {}} />
    );
    await user.click(screen.getByRole('button', { name: /تعديل/ }));
    // The catalogue arrives after the draft — wait for it, so the base price is known.
    await waitFor(() => expect(screen.getByRole('option', { name: 'مقشر' })).toBeTruthy());
  }

  beforeEach(() => {
    apiJson.mockResolvedValue({ products: [{ id: 'p1', name: 'مقشر', basePrice: 25, offers: [] }] });
    apiFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  });

  it('opens at the stored 40 with no line, keeps 40 for a third piece, and saves 40', async () => {
    const user = userEvent.setup();
    await openTheCard(user);
    expect(priceBox().value).toBe('40');
    expect(hint()).toBeNull();

    await user.click(plus());
    expect(priceBox().value).toBe('40');
    // NEGATIVE: not rewritten to three pieces at base.
    expect(priceBox().value).not.toBe('75');
    expect(hint()?.textContent).toContain('75.000 JOD');

    await user.click(screen.getByRole('button', { name: /حفظ بيانات الطلب/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const items = sentItems();
    expect(items).toEqual([{ productId: 'p1', quantity: 3, unitPrice: '40' }]);
    // D4: the same three keys as ever; the editor's own bookkeeping never leaves.
    expect(Object.keys(items[0]).sort()).toEqual(['productId', 'quantity', 'unitPrice']);
    expect(items[0]).not.toHaveProperty('pricing');
  });

  it('and only the button changes the saved money: restore → 75, and 75 is what is saved', async () => {
    const user = userEvent.setup();
    await openTheCard(user);
    await user.click(plus());
    await pressRestore(user);
    expect(priceBox().value).toBe('75');
    expect(hint()).toBeNull();

    await user.click(screen.getByRole('button', { name: /حفظ بيانات الطلب/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    // NEGATIVE: without the press the save sends 40 (the case above).
    expect(sentItems()).toEqual([{ productId: 'p1', quantity: 3, unitPrice: '75' }]);
  });
});

/* ── and the arithmetic stays in the one place ─────────────────────────── */

describe('the editor multiplies nothing itself', () => {
  /** A catalogue price with an arithmetic operator beside it, either way round. */
  const BESIDE = /(?:basePrice|sellingPrice)\s*[-+*/]|[-+*/]\s*(?:[\w?]+\.)*(?:basePrice|sellingPrice)\b/;

  it('it calls atBasePrice, writes no operator beside a catalogue price, and assumes no unit', () => {
    const code = stripComments(repoFile('src/components/orders/ProductLinesEditor.tsx'));
    expect(code).toMatch(/atBasePrice\(/);
    expect(code).not.toMatch(BESIDE);
    expect(code).not.toMatch(/minorUnit\s*\?\?\s*\d/);
  });

  it('NEGATIVE: the checks can still see — a call passes, a multiplication and an assumed unit do not', () => {
    expect(BESIDE.test('atBasePrice(product?.basePrice, quantity, minorUnit)')).toBe(false);
    expect(BESIDE.test('basePrice*qty')).toBe(true);
    expect(BESIDE.test('quantity * product?.basePrice')).toBe(true);
    expect(BESIDE.test('offer.sellingPrice / offer.quantity')).toBe(true);
    expect(/minorUnit\s*\?\?\s*\d/.test('currency?.minorUnit ?? 2')).toBe(true);
  });
});
