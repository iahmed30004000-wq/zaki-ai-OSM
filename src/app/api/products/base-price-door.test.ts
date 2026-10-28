import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A PRICE BOX WITH SOMETHING ELSE IN IT USED TO MEAN «FREE».
 *
 * Both product doors wrote `parseFloat(basePrice) || 0`, so a non-numeric
 * price stored a product at zero and answered 200. `basePrice` is not just
 * the product card: it is what a landing page shows a shopper, the fallback
 * price in the AI intake, and the number `ProductOffers` multiplies to
 * propose the offer ladder.
 *
 * Both doors now read the price with the same reader, so these tests run
 * against create AND edit — a guard on one door only is how the two drifted
 * apart in the first place.
 */

const { db, requireContext, requirePermission, getPermissionScope, can, authorize, logAudit } = vi.hoisted(() => ({
  db: {
    product: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    category: { findFirst: vi.fn() },
    // The edit door now asks for the product's live offers before it lowers a base price — see the last section.
    offer: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  getPermissionScope: vi.fn(),
  can: vi.fn(),
  authorize: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { POST } from './route';
import { PATCH } from './[id]/route';

const CATEGORY = '11111111-1111-4111-8111-111111111111';

const sound = { name: 'كريم مرطّب', sku: 'CRM-1', categoryId: CATEGORY };

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const patch = (body: unknown) =>
  PATCH(
    new Request('http://localhost/api/products/p1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'p1' }) }
  );

/** The price as it actually reached the database. */
const created = () => db.product.create.mock.calls[0][0].data;
const updated = () => db.product.update.mock.calls[0][0].data;

const STORED = {
  id: 'p1',
  companyId: 'c1',
  storeId: 's1',
  name: 'كريم مرطّب',
  sku: 'CRM-1',
  basePrice: 120,
  status: 'ACTIVE',
  slug: null,
  previousSlugs: null,
  category: { attributeSchema: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'admin', name: 'مدير' },
    companyId: 'c1',
    storeId: 's1',
    // The store's currency, which rounds an offer's line when the base price moves.
    country: { currencyCode: 'USD', minorUnit: 2 },
  });
  // No offers unless a case gives the product some: the cases above are about the price box, not the line.
  db.offer.findMany.mockResolvedValue([]);
  requirePermission.mockResolvedValue(undefined);
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  can.mockReturnValue(true);
  authorize.mockReturnValue({ allowed: true });
  db.product.findFirst.mockResolvedValue(null);
  db.category.findFirst.mockResolvedValue({ id: CATEGORY });
  db.product.create.mockResolvedValue({ id: 'p-new', name: sound.name, sku: sound.sku, basePrice: 0, status: 'ACTIVE' });
  db.product.update.mockResolvedValue({ id: 'p1', name: STORED.name, sku: STORED.sku, basePrice: 0, status: 'ACTIVE' });
});

describe('creating a product: a price is a number or a refusal', () => {
  it('refuses a non-numeric price instead of creating a free product', async () => {
    const res = await post({ ...sound, basePrice: 'abc' });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain('السعر الأساسي');
    expect(db.product.create).not.toHaveBeenCalled();
    // Refused before any lookup: nothing was asked of the database for a
    // request that was never going to be stored.
    expect(db.product.findFirst).not.toHaveBeenCalled();
    expect(db.category.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a decimal comma rather than storing the whole part', async () => {
    // `parseFloat('3,5')` is 3 — a wrong price stored silently, which is the
    // same defect with the other shoe on.
    const res = await post({ ...sound, basePrice: '3,5' });
    expect(res.status).toBe(400);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it('refuses a negative price', async () => {
    const res = await post({ ...sound, basePrice: -5 });
    expect(res.status).toBe(400);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it('refuses an empty price box rather than reading it as zero', async () => {
    const res = await post({ ...sound, basePrice: '' });
    expect(res.status).toBe(400);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it('stores a typed zero as zero — a sample is a real price', async () => {
    const res = await post({ ...sound, basePrice: 0 });
    expect(res.status).toBe(200);
    expect(created().basePrice).toBe(0);
  });

  it('stores the number that was typed', async () => {
    const res = await post({ ...sound, basePrice: 12.5 });
    expect(res.status).toBe(200);
    expect(created().basePrice).toBe(12.5);
  });

  it('accepts a numeric string from a form, as this door always has', async () => {
    const res = await post({ ...sound, basePrice: '12.5' });
    expect(res.status).toBe(200);
    expect(created().basePrice).toBe(12.5);
  });

  it('leaves the column at its default when no price was sent at all', async () => {
    const res = await post(sound);
    expect(res.status).toBe(200);
    expect(created().basePrice).toBe(0);
  });
});

describe('editing a product: the stored price survives a bad one', () => {
  beforeEach(() => {
    db.product.findFirst.mockResolvedValue(STORED);
  });

  it('refuses a non-numeric price instead of zeroing the product', async () => {
    const res = await patch({ basePrice: 'abc' });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain('السعر الأساسي');
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it('refuses a decimal comma rather than cutting 3,5 down to 3', async () => {
    const res = await patch({ basePrice: '3,5' });
    expect(res.status).toBe(400);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it('refuses a negative price', async () => {
    const res = await patch({ basePrice: -1 });
    expect(res.status).toBe(400);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it('writes a deliberate zero, because somebody may price a sample at nothing', async () => {
    const res = await patch({ basePrice: 0 });
    expect(res.status).toBe(200);
    expect(updated().basePrice).toBe(0);
  });

  it('writes the number that was typed', async () => {
    const res = await patch({ basePrice: 99.99 });
    expect(res.status).toBe(200);
    expect(updated().basePrice).toBe(99.99);
  });

  it('does not touch the price when the request never mentions it', async () => {
    const res = await patch({ status: 'INACTIVE' });
    expect(res.status).toBe(200);
    expect(updated()).not.toHaveProperty('basePrice');
  });

  it('still asks for the price authority before changing a price', async () => {
    authorize.mockImplementation((_u: unknown, key: string) => ({ allowed: key !== 'products.change_price' }));
    const res = await patch({ basePrice: 99 });
    expect(res.status).toBe(403);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it('does not ask for the price authority when the price is unchanged', async () => {
    authorize.mockImplementation((_u: unknown, key: string) => ({ allowed: key !== 'products.change_price' }));
    const res = await patch({ basePrice: STORED.basePrice });
    expect(res.status).toBe(200);
  });
});

/**
 * THE NOTATION THAT GOT PAST THE OLD READER — MEASURED AT THE DOOR.
 *
 * `readBasePrice` used `Number()` because `parseFloat('3,5')` is 3 and that
 * stored a wrong price silently. The reasoning was right and the coverage was
 * not: `Number()` reads base prefixes, so `'0x10'` arrived at both doors and
 * was stored as **16** with a 200 — the same defect one notation over. The
 * price rule now borrows its notation from `numeric-input.ts`.
 *
 * Each case asserts the figure `Number()` really answers before asserting the
 * refusal, so the hazard in this file is measured rather than recited.
 */
describe('a price written in another notation reaches neither door', () => {
  const PREFIXED = [
    ['0x10', 16],
    ['0X10', 16],
    ['0b11', 3],
    ['0B11', 3],
    ['0o17', 15],
    ['0O17', 15],
  ] as const;

  it.each(PREFIXED)('creating refuses «%s», which Number() reads as %i', async (typed, wouldStore) => {
    expect(Number(typed), 'the hazard is measured, not remembered').toBe(wouldStore);
    const res = await post({ ...sound, basePrice: typed });
    // The row Prisma was handed comes first, so a failure prints the figure
    // that would have been stored rather than only the status code.
    expect(
      db.product.create.mock.calls.map((c) => c[0].data.basePrice),
      `${typed} was handed to Prisma as a price; Number() reads it as ${wouldStore}`
    ).toEqual([]);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain('السعر الأساسي');
  });

  it.each(PREFIXED)('editing refuses «%s» rather than overwriting 120 with %i', async (typed, wouldStore) => {
    db.product.findFirst.mockResolvedValue(STORED);
    expect(Number(typed)).toBe(wouldStore);
    const res = await patch({ basePrice: typed });
    expect(
      db.product.update.mock.calls.map((c) => c[0].data.basePrice),
      `the stored 120 would have been overwritten; Number() reads ${typed} as ${wouldStore}`
    ).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('refuses before the price authority is consulted at all', async () => {
    // 16 against a stored 120 IS a change, so the old reader did not bypass
    // `products.change_price` — it satisfied it with a number nobody typed and
    // then wrote 16, and the audit log recorded 120 next to it. The refusal
    // now happens before that question is asked.
    db.product.findFirst.mockResolvedValue(STORED);
    const res = await patch({ basePrice: '0x10' });
    expect(res.status).toBe(400);
    expect(authorize).not.toHaveBeenCalledWith(expect.anything(), 'products.change_price', expect.anything());
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('refuses an Arabic-Indic numeral — this product is Arabic-facing and ١٢٣ is not 123', async () => {
    expect(Number('١٢٣'), 'Number() does not read Arabic-Indic digits').toBeNaN();
    const res = await post({ ...sound, basePrice: '١٢٣' });
    expect(res.status).toBe(400);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it("refuses a whitespace-only box, though Number('   ') is 0", async () => {
    expect(Number('   ')).toBe(0);
    const res = await post({ ...sound, basePrice: '   ' });
    expect(res.status).toBe(400);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it('refuses null, though Number(null) is 0', async () => {
    expect(Number(null)).toBe(0);
    const res = await post({ ...sound, basePrice: null });
    expect(res.status).toBe(400);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it("refuses a one-element array, though Number(['5']) is 5", async () => {
    expect(Number(['5'])).toBe(5);
    const res = await post({ ...sound, basePrice: ['5'] });
    expect(res.status).toBe(400);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it('refuses an overflowing exponent, though it is written in digits', async () => {
    expect(Number('1e400')).toBe(Infinity);
    const res = await post({ ...sound, basePrice: '1e400' });
    expect(res.status).toBe(400);
    expect(db.product.create).not.toHaveBeenCalled();
  });

  it('still stores a scientific-notation price, which a form may legitimately post', async () => {
    const res = await post({ ...sound, basePrice: '5e-1' });
    expect(res.status).toBe(200);
    expect(created().basePrice).toBe(0.5);
  });
});

/**
 * «العرض ما بصير يكون اكثر من السعر الاساسي» — AND THE BASE PRICE IS THE LINE ITSELF.
 *
 * Lowering it lowers every offer's line at once, so this door refuses a price that would leave a live offer above
 * its line. The stored product is priced at 120 (`STORED`). The mock reads the `where` it is handed, so an offer the
 * door did not ask for is an offer the door never sees — which is what makes «only stopped offers pass» a fact
 * about the query and not about the fixture.
 */
type ShelfOffer = {
  companyId: string;
  productId: string;
  name: string;
  quantity: number;
  sellingPrice: number;
  status: string;
};
const onShelf = (over: Partial<ShelfOffer>): ShelfOffer => ({
  companyId: 'c1',
  productId: 'p1',
  name: 'قطعة',
  quantity: 1,
  sellingPrice: 100,
  status: 'ACTIVE',
  ...over,
});
function offersOf(rows: ShelfOffer[]) {
  db.offer.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    rows
      .filter((o) => Object.entries(where).every(([k, v]) => o[k as keyof ShelfOffer] === v))
      .map(({ name, quantity, sellingPrice }) => ({ name, quantity, sellingPrice }))
  );
}

describe('the base price is the line every offer stays under', () => {
  beforeEach(() => {
    db.product.findFirst.mockResolvedValue(STORED);
  });

  it('NEGATIVE: lowering it under a live offer answers 409, naming the offer, its price and the new line', async () => {
    // «قطعتان» at 230 is under 2 × 120 = 240 today; at 99.99 its line is 2 × 99.99 = 199.98.
    offersOf([onShelf({ name: 'قطعتان', quantity: 2, sellingPrice: 230 })]);
    const res = await patch({ basePrice: 99.99 });
    const { error, code } = await res.json();
    expect(error).toContain('«قطعتان» سعره 230');
    expect(error).toContain('(2 × 99.99 = 199.98)');
    expect(error).toContain('عدّل سعر العرض أو أوقفه');
    expect(code).toBe('BASE_BELOW_ACTIVE_OFFER');
    expect(res.status).toBe(409);
    expect(db.product.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and it asks for THIS product’s ACTIVE offers, and nothing wider', async () => {
    await patch({ basePrice: 99.99 });
    expect(db.offer.findMany).toHaveBeenCalledTimes(1);
    expect(db.offer.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1', productId: 'p1', status: 'ACTIVE' });
  });

  it('and names every offer it would leave above the line — and only those', async () => {
    offersOf([
      onShelf({ name: 'قطعة', quantity: 1, sellingPrice: 110 }),
      onShelf({ name: 'ثلاث قطع', quantity: 3, sellingPrice: 330 }),
      // 190 for two is under 2 × 100 = 200, so it is not this refusal's business.
      onShelf({ name: 'قطعتان', quantity: 2, sellingPrice: 190 }),
    ]);
    const res = await patch({ basePrice: 100 });
    const { error } = await res.json();
    expect(res.status).toBe(409);
    expect(error).toContain('«قطعة» سعره 110');
    expect(error).toContain('«ثلاث قطع» سعره 330');
    expect(error).not.toContain('قطعتان');
    expect(error).toContain('عدّل أسعار هالعروض أو أوقفها');
  });

  it('passes when the only offers above the new line are STOPPED — they are not on sale', async () => {
    offersOf([onShelf({ name: 'قديم', quantity: 1, sellingPrice: 115, status: 'INACTIVE' })]);
    const res = await patch({ basePrice: 99.99 });
    expect(res.status).toBe(200);
    expect(updated().basePrice).toBe(99.99);
  });

  it('passes a lowering every live offer still fits under — on the line included', async () => {
    offersOf([onShelf({ name: 'قطعتان', quantity: 2, sellingPrice: 200 })]);
    const res = await patch({ basePrice: 100 });
    expect(res.status).toBe(200);
    expect(updated().basePrice).toBe(100);
  });

  it('passes a RAISE without asking — a higher line cannot put an offer above it', async () => {
    // Even an old offer that was above the line before and is still above it after: it is flagged already, and a
    // raise is a step toward it. Refusing the step would keep the shop further from the rule, not closer.
    offersOf([onShelf({ name: 'قطعة', quantity: 1, sellingPrice: 130 })]);
    const res = await patch({ basePrice: 125 });
    expect(res.status).toBe(200);
    expect(updated().basePrice).toBe(125);
    expect(db.offer.findMany).not.toHaveBeenCalled();
  });

  it('passes a zero — «not priced yet» draws no line at all', async () => {
    offersOf([onShelf({ name: 'قطعة', quantity: 1, sellingPrice: 130 })]);
    const res = await patch({ basePrice: 0 });
    expect(res.status).toBe(200);
    expect(db.offer.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: and a FIRST base price under a live offer is refused too — the line appears with it', async () => {
    db.product.findFirst.mockResolvedValue({ ...STORED, basePrice: 0 });
    offersOf([onShelf({ name: 'ثلاث قطع', quantity: 3, sellingPrice: 75 })]);
    const res = await patch({ basePrice: 20 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('(3 × 20 = 60)');
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it('and an edit that resends the stored price is no price change — an old offer above the line does not block it', async () => {
    offersOf([onShelf({ name: 'قطعة', quantity: 1, sellingPrice: 130 })]);
    const res = await patch({ status: 'INACTIVE', basePrice: STORED.basePrice });
    expect(res.status).toBe(200);
    expect(db.offer.findMany).not.toHaveBeenCalled();
  });

  it('and somebody without the price authority is told THAT first — the offers are not even read', async () => {
    authorize.mockImplementation((_u: unknown, key: string) => ({ allowed: key !== 'products.change_price' }));
    offersOf([onShelf({ name: 'قطعتان', quantity: 2, sellingPrice: 230 })]);
    const res = await patch({ basePrice: 99.99 });
    expect(res.status).toBe(403);
    expect(db.offer.findMany).not.toHaveBeenCalled();
  });
});
