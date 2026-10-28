import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «العرض ما بصير يكون اكثر من السعر الاساسي» — THE CREATE DOOR, AND THE LIST THE SCREEN READS.
 *
 * `POST /api/offers` refuses a bundle priced above its line — the product's base price × the bundle's PAID pieces,
 * rounded by the store's currency — before anything is written: no row, no audit entry, no rebuilt landing page.
 * `GET /api/offers` hands every row its line (`maxPrice`) and whether it is above it (`aboveBase`), so the screen
 * flags an offer saved before the rule without doing the arithmetic itself.
 *
 * The product here is priced at 25 and the store is Jordanian (three places).
 */

const { db, logAudit, refreshLandingPages } = vi.hoisted(() => ({
  db: {
    offer: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    product: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  logAudit: vi.fn(),
  refreshLandingPages: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit }));
vi.mock('@/lib/landing-cache', () => ({ refreshLandingPages }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1' },
    companyId: 'c1',
    storeId: 's1',
    country: { currencyCode: 'JOD', minorUnit: 3 },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));

import { GET, POST } from './route';

const PRODUCT = { id: 'prod-aaaaaaaaaa', companyId: 'c1', storeId: 's1', name: 'كريم', basePrice: 25 };

const post = (body: Record<string, unknown>) =>
  POST(
    new Request('http://localhost/api/offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: PRODUCT.id, name: 'ثلاث قطع', ...body }),
    })
  );

/** The `data` the offer was created with. */
const created = () => db.offer.create.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  db.product.findFirst.mockResolvedValue(PRODUCT);
  db.offer.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'offer-new', ...data }));
  db.offer.updateMany.mockResolvedValue({ count: 0 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ offer: db.offer }));
});

describe('creating a bundle above its line', () => {
  it('NEGATIVE: «3 بـ80» at a base of 25 is refused with the line, and NOTHING is written', async () => {
    const res = await post({ quantity: 3, sellingPrice: 80 });
    const body = await res.json();
    // The sentence first: the owner's own words (28/10), with the real figures at the store's three places.
    expect(body).toEqual({
      error: 'لا يمكنك إنشاء العرض: السعر 80.000 أعلى من السعر الأساسي لـ3 قطع (75.000)',
      code: 'OFFER_ABOVE_BASE',
      maxPrice: 75,
    });
    expect(res.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.offer.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(refreshLandingPages).not.toHaveBeenCalled();
  });

  it('«3 بـ60» at a base of 25 — 20 a piece, under its line of 75 — is written as typed', async () => {
    const res = await post({ quantity: 3, sellingPrice: 60 });
    expect(res.status).toBe(200);
    expect(created()).toMatchObject({ quantity: 3, sellingPrice: 60 });
  });

  it('on the line it is written as typed — and audited, and the page rebuilt, as every offer is', async () => {
    const res = await post({ quantity: 3, sellingPrice: 75 });
    expect(res.status).toBe(200);
    expect(created().sellingPrice).toBe(75);
    expect(created().quantity).toBe(3);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(refreshLandingPages).toHaveBeenCalledTimes(1);
  });

  it('a gift rides on top of the line: «3 + 1 هدية» may cost what three pieces cost — 75, not 80', async () => {
    const refused = await post({ quantity: 3, freeQuantity: 1, sellingPrice: 80 });
    expect(refused.status).toBe(400);
    // The line is for the 3 PAID pieces: the gift does not raise it to 4 × 25 = 100.
    expect((await refused.json()).error).toBe('لا يمكنك إنشاء العرض: السعر 80.000 أعلى من السعر الأساسي لـ3 قطع (75.000)');
    expect(db.offer.create).not.toHaveBeenCalled();
    expect((await post({ quantity: 3, freeQuantity: 1, sellingPrice: 75 })).status).toBe(200);
    expect(created().freeQuantity).toBe(1);
  });

  it('a quantity left out is the column’s one piece — and one piece may cost one base price', async () => {
    const res = await post({ sellingPrice: 26 });
    expect(res.status).toBe(400);
    expect((await res.json()).maxPrice).toBe(25);
  });

  it('the store’s own decimals decide: 24.691 for two at 12.345 is a fils over, in dinars', async () => {
    db.product.findFirst.mockResolvedValue({ ...PRODUCT, basePrice: 12.345 });
    expect((await post({ quantity: 2, sellingPrice: 24.691 })).status).toBe(400);
    expect((await post({ quantity: 2, sellingPrice: 24.69 })).status).toBe(200);
  });

  it('NEGATIVE: a product of another store still answers 404 first — its base price is never quoted', async () => {
    db.product.findFirst.mockResolvedValue(null);
    const res = await post({ productId: 'prod-otherstore', quantity: 3, sellingPrice: 80 });
    expect(await res.json()).toEqual({ error: 'المنتج غير موجود في شركتك' });
    expect(res.status).toBe(404);
    expect(db.offer.create).not.toHaveBeenCalled();
  });

  it('and a product with no base price yet has no line: «not priced yet» refuses nothing', async () => {
    db.product.findFirst.mockResolvedValue({ ...PRODUCT, basePrice: 0 });
    const res = await post({ quantity: 3, sellingPrice: 500 });
    expect(res.status).toBe(200);
    expect(created().sellingPrice).toBe(500);
  });
});

describe('the list carries each row’s line, worked out by the door', () => {
  const product = (basePrice: number) => ({ id: PRODUCT.id, name: 'كريم', sku: 'CRM-1', basePrice, image: null });

  beforeEach(() => {
    db.offer.findMany.mockResolvedValue([
      { id: 'under', name: 'ثلاث قطع', quantity: 3, freeQuantity: 0, sellingPrice: 60, status: 'ACTIVE', product: product(25) },
      // Saved before the rule: a gift does not lift the line, so «3 + 1» at 80 is above 75.
      { id: 'above', name: 'ثلاث + هدية', quantity: 3, freeQuantity: 1, sellingPrice: 80, status: 'ACTIVE', product: product(25) },
      { id: 'unpriced', name: 'قطعتان', quantity: 2, freeQuantity: 0, sellingPrice: 500, status: 'ACTIVE', product: product(0) },
    ]);
  });

  const list = async () => (await GET(new Request(`http://localhost/api/offers?productId=${PRODUCT.id}`))).json();

  it('maxPrice and aboveBase on every row — and a product with no base price has neither a line nor a flag', async () => {
    const { offers } = await list();
    expect(offers.map((o: { id: string; maxPrice: number | null; aboveBase: boolean }) => [o.id, o.maxPrice, o.aboveBase])).toEqual([
      ['under', 75, false],
      ['above', 75, true],
      ['unpriced', null, false],
    ]);
  });

  it('and the row is otherwise what it was — the fields are added, nothing is taken away', async () => {
    const { offers } = await list();
    expect(offers[1]).toMatchObject({ id: 'above', name: 'ثلاث + هدية', quantity: 3, freeQuantity: 1, sellingPrice: 80, status: 'ACTIVE' });
    expect(offers[1].product).toEqual(product(25));
  });

  it('and the store’s own decimals travel with the list, for the hint the screen draws', async () => {
    expect((await list()).minorUnit).toBe(3);
  });
});
