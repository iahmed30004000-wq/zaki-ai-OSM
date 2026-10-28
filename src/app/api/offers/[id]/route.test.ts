import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN EDIT WRITES WHAT THE EDITOR SENT, AND NOT ONE COLUMN MORE.
 *
 * This door used to destroy configuration on the most ordinary action there
 * is. Zod keeps a field's `.default()` through `.partial()`, so every
 * defaulted field came back from the schema PRESENT carrying its default
 * instead of the stored value, and this route's merge — `input.x !==
 * undefined ? { x } : {}` — wrote all of them.
 *
 * MEASURED on the golden-path offer «قطعتان بحسم ٣» (quantity 2, discount
 * 3, the preselected bundle): dragging it one place up the list sent
 * `PATCH { sortOrder: 1 }` and the row that landed was one piece, no
 * discount, no longer the default, forced back to ACTIVE. No error, nothing
 * in the request asking for it, and nothing in the screen showing it had
 * happened.
 *
 * The schema fix is pinned in `src/lib/offers.test.ts`. What is pinned HERE
 * is the thing the admin actually does: the data block that reaches the
 * database. A schema that stops inventing values is only half the
 * guarantee if the route goes on writing them.
 */

const { db, logAudit } = vi.hoisted(() => ({
  db: {
    offer: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    order: { count: vi.fn() },
    $transaction: vi.fn(),
  },
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit }));
vi.mock('@/lib/geo-context', () => ({
  // A Jordanian store: the line an offer must stay under is rounded to three places.
  requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'JOD', minorUnit: 3 } }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));

import { PATCH } from './route';

/** «قطعتان بحسم ٣», exactly as the golden path stores it. */
const STORED = {
  id: 'of1',
  companyId: 'c1',
  productId: 'p1',
  name: 'قطعتان بحسم ٣',
  quantity: 2,
  freeQuantity: 0,
  sellingPrice: 25,
  compareAtPrice: 30,
  endsAt: null,
  discount: 3,
  deliveryIncluded: true,
  isDefault: true,
  sortOrder: 5,
  status: 'ACTIVE',
};

const patch = (body: unknown) =>
  PATCH(
    new Request('http://localhost/api/offers/of1', { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'of1' }) }
  );

/** The `data` block the route handed Prisma — the row as it was written. */
const written = () => db.offer.update.mock.calls[0][0].data as Record<string, unknown>;

/**
 * The stored row as the door reads it: with its product's base price, which the door now loads beside it.
 *
 * 20 and not 0, on purpose. A base price of 0 draws no line, so a fixture without one would let every case below
 * pass by skipping the rule rather than by meeting it — and «قطعتان» at 25, or at the 40 the money rule accepts
 * further down, is under its line of 2 × 20 = 40.
 */
const asStored = (row: object, basePrice = 20) => ({ ...row, product: { basePrice } });

beforeEach(() => {
  vi.clearAllMocks();
  db.offer.findFirst.mockResolvedValue(asStored(STORED));
  db.offer.update.mockImplementation(async ({ data }: { data: object }) => ({ ...STORED, ...data }));
  db.offer.updateMany.mockResolvedValue({ count: 0 });
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
});

describe('dragging an offer up the list', () => {
  it('writes the new position and leaves every other column alone', async () => {
    const res = await patch({ sortOrder: 1 });
    expect(res.status).toBe(200);
    expect(db.offer.update).toHaveBeenCalledTimes(1);
    expect(written()).toEqual({ sortOrder: 1 });
  });

  it('and specifically does not write back the defaults it used to', async () => {
    await patch({ sortOrder: 1 });
    const data = written();
    // Each of these was written on every reorder, with the value in brackets.
    expect('quantity' in data).toBe(false); // was 1, over a stored 2
    expect('discount' in data).toBe(false); // was 0, over a stored 3
    expect('isDefault' in data).toBe(false); // was false, over a stored true
    expect('status' in data).toBe(false); // was 'ACTIVE', whatever was stored
    expect('freeQuantity' in data).toBe(false);
    expect('deliveryIncluded' in data).toBe(false);
    expect('name' in data).toBe(false);
    expect('sellingPrice' in data).toBe(false);
    expect('compareAtPrice' in data).toBe(false);
    expect('endsAt' in data).toBe(false);
  });

  it('and the row that comes back still describes the same bundle', async () => {
    const res = await patch({ sortOrder: 1 });
    const body = await res.json();
    expect(body.offer).toMatchObject({
      name: 'قطعتان بحسم ٣',
      quantity: 2,
      discount: 3,
      isDefault: true,
      sortOrder: 1,
    });
  });
});

describe('the other edits the offers screen sends on their own', () => {
  it('retiring a bundle touches only its status', async () => {
    await patch({ status: 'INACTIVE' });
    expect(written()).toEqual({ status: 'INACTIVE' });
  });

  it('choosing the default touches only the flag — and clears the others', async () => {
    await patch({ isDefault: true });
    expect(written()).toEqual({ isDefault: true });
    // Exactly one default per product is still enforced inside the same
    // transaction; the narrower merge must not have cost that.
    expect(db.offer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ productId: 'p1', isDefault: true }),
        data: { isDefault: false },
      })
    );
  });

  it('renaming writes a trimmed name and nothing else', async () => {
    await patch({ name: '  قطعتان بحسم ٤  ' });
    expect(written()).toEqual({ name: 'قطعتان بحسم ٤' });
  });

  it('clearing the struck-through price writes null, because null was sent', async () => {
    await patch({ compareAtPrice: null });
    expect(written()).toEqual({ compareAtPrice: null });
  });
});

describe('and the money rule still shuts this door', () => {
  it('refuses a discount that reaches the stored price, writing nothing', async () => {
    const res = await patch({ discount: 30 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('25') });
    expect(db.offer.update).not.toHaveBeenCalled();
  });

  it('refuses a price dropped under the discount the row already has', async () => {
    const res = await patch({ sellingPrice: 2 });
    expect(res.status).toBe(400);
    expect(db.offer.update).not.toHaveBeenCalled();
  });

  it('accepts the two changed together when they agree', async () => {
    await patch({ sellingPrice: 40, discount: 30 });
    expect(written()).toEqual({ sellingPrice: 40, discount: 30 });
  });
});

describe('what the audit log would let somebody find out', () => {
  it('keeps the whole row before and after, so an overwrite is recoverable', async () => {
    await patch({ sortOrder: 1 });
    expect(logAudit).toHaveBeenCalledTimes(1);
    const entry = logAudit.mock.calls[0][0];
    expect(entry.action).toBe('OFFER_UPDATED');
    expect(entry.entityId).toBe('of1');
    // No field-level diff is recorded — but both snapshots are, so the
    // difference between them is the diff. Had the wipe happened, the log
    // would show quantity 2 → 1 and discount 3 → 0 to anybody who compared.
    expect(entry.previousData).toMatchObject({ quantity: 2, discount: 3, isDefault: true });
    expect(entry.newData).toMatchObject({ quantity: 2, discount: 3, isDefault: true, sortOrder: 1 });
  });

  it('and the snapshot is the offer’s own row — the product read beside it is not written into the log', async () => {
    await patch({ sortOrder: 1 });
    expect(logAudit.mock.calls[0][0].previousData).not.toHaveProperty('product');
  });
});

/**
 * «العرض ما بصير يكون اكثر من السعر الاساسي» — AT THE EDIT DOOR, FOR WHAT THE EDIT CHANGES.
 *
 * A base price of 25, so «ثلاث قطع بـ60» (20 a piece) is under its line of 3 × 25 = 75. The rule reads the row the
 * edit will LEAVE — the stored figures fill in what the request does not carry — and it is asked only when the price
 * or the quantity really moves, or a stopped offer is switched back on.
 */
const THREE_FOR_60 = { ...STORED, name: 'ثلاث قطع', quantity: 3, sellingPrice: 60, discount: 0, compareAtPrice: null };

describe('an edit that moves an offer against its line', () => {
  beforeEach(() => {
    db.offer.findFirst.mockResolvedValue(asStored(THREE_FOR_60, 25));
  });

  it('refuses a price above the line, says what the line is, and writes nothing', async () => {
    const res = await patch({ sellingPrice: 80 });
    const body = await res.json();
    // The owner's edit sentence (28/10), with the real figures at the store's three places.
    expect(body).toEqual({
      error: 'لا يمكنك تعديل العرض: السعر 80.000 أعلى من السعر الأساسي لـ3 قطع (75.000)',
      code: 'OFFER_ABOVE_BASE',
      maxPrice: 75,
    });
    expect(res.status).toBe(400);
    expect(db.offer.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('refuses a quantity sent ALONE when the stored price is above the line it leaves — 60 for one piece', async () => {
    const res = await patch({ quantity: 1 });
    const body = await res.json();
    expect(body.error).toBe('لا يمكنك تعديل العرض: السعر 60.000 أعلى من السعر الأساسي لقطعة واحدة (25.000)');
    expect(body.maxPrice).toBe(25);
    expect(res.status).toBe(400);
    expect(db.offer.update).not.toHaveBeenCalled();
  });

  it('accepts a price exactly on the line — equality is not above it', async () => {
    const res = await patch({ sellingPrice: 75 });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ sellingPrice: 75 });
  });

  it('and a bigger bundle at the same price passes, because its line rose with it', async () => {
    const res = await patch({ quantity: 4 });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ quantity: 4 });
  });

  it('NEGATIVE: with no base price there is no line, and 80 is written', async () => {
    db.offer.findFirst.mockResolvedValue(asStored(THREE_FOR_60, 0));
    const res = await patch({ sellingPrice: 80 });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ sellingPrice: 80 });
  });
});

describe('an offer stored ABOVE its line before the rule existed — «ثلاث قطع بـ80» at a base of 25', () => {
  const VIOLATOR = { ...THREE_FOR_60, sellingPrice: 80 };

  beforeEach(() => {
    db.offer.findFirst.mockResolvedValue(asStored(VIOLATOR, 25));
  });

  /*
   * IT STAYS ON SALE AND STAYS MANAGEABLE. Each of these is an edit the offers screen sends on its own — the drag,
   * the star, the eye, the «تعديل» form's ending and «was» price — and none of them moves the offer against its
   * line, so each one writes exactly what it carried. A drag sends one PATCH per moved row; refusing one of them
   * would leave the list half reordered.
   */
  it.each([
    ['a reorder', { sortOrder: 1 }, { sortOrder: 1 }],
    ['the star', { isDefault: true }, { isDefault: true }],
    ['a new name', { name: '  ثلاث قطع — قديم  ' }, { name: 'ثلاث قطع — قديم' }],
    ['switching it OFF', { status: 'INACTIVE' }, { status: 'INACTIVE' }],
    ['clearing the «was» price', { compareAtPrice: null }, { compareAtPrice: null }],
    ['a new ending', { endsAt: '2027-01-01T00:00:00.000Z' }, { endsAt: new Date('2027-01-01T00:00:00.000Z') }],
  ])('%s passes, and writes exactly that', async (_what, body, data) => {
    const res = await patch(body);
    expect(res.status).toBe(200);
    expect(written()).toEqual(data);
  });

  it('and the same price sent back is not a change — compared rounded, as the line is', async () => {
    // What the «تعديل» form sends for a price nobody touched, in a spelling the rounding cannot tell apart.
    const res = await patch({ sellingPrice: 80.0004 });
    expect(res.status).toBe(200);
  });

  it('NEGATIVE: but a price edit that is still above the line is refused', async () => {
    const res = await patch({ sellingPrice: 78 });
    expect(res.status).toBe(400);
    expect((await res.json()).maxPrice).toBe(75);
    expect(db.offer.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: and switching a STOPPED one back on is putting it back on sale — refused, and it says why', async () => {
    db.offer.findFirst.mockResolvedValue(asStored({ ...VIOLATOR, status: 'INACTIVE' }, 25));
    const res = await patch({ status: 'ACTIVE' });
    const body = await res.json();
    // The edit door's one sentence: the price it would go back on sale at, and the line it is above.
    expect(body).toEqual({
      error: 'لا يمكنك تعديل العرض: السعر 80.000 أعلى من السعر الأساسي لـ3 قطع (75.000)',
      code: 'OFFER_ABOVE_BASE',
      maxPrice: 75,
    });
    expect(res.status).toBe(400);
    expect(db.offer.update).not.toHaveBeenCalled();
  });

  it('and switched back on together with a price on its line, it passes', async () => {
    db.offer.findFirst.mockResolvedValue(asStored({ ...VIOLATOR, status: 'INACTIVE' }, 25));
    const res = await patch({ status: 'ACTIVE', sellingPrice: 75 });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ status: 'ACTIVE', sellingPrice: 75 });
  });

  it('and ACTIVE resent on one already on sale is no switch — the «تعديل» form sends the stored status every time', async () => {
    const res = await patch({ status: 'ACTIVE' });
    expect(res.status).toBe(200);
  });

  it('and switching a stopped offer that is UNDER its line back on is never questioned', async () => {
    db.offer.findFirst.mockResolvedValue(asStored({ ...THREE_FOR_60, status: 'INACTIVE' }, 25));
    const res = await patch({ status: 'ACTIVE' });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ status: 'ACTIVE' });
  });
});
