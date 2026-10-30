import { describe, expect, it, vi } from 'vitest';
import { activeOffersFor, activeOffersForProducts, withTheReduction } from './offers';

/**
 * ONE READER OF «WHAT MAY BE SOLD TODAY», FOR ONE PRODUCT OR MANY.
 *
 * The lines editor needs the live offers of every product in a catalogue; asking `activeOffersFor` once per product
 * would be a query per line, and a second hand-written filter would be a second answer to «is this offer on sale».
 * So `activeOffersForProducts` is the reader and `activeOffersFor` is it with one id.
 *
 * The fake database below EVALUATES the `where` it is handed against rows — status, the after-order flag, the ending,
 * the company and the products — so a predicate that is dropped from the query shows up as a row that should not have
 * been returned, not as a mock nobody asked.
 */

const NOW = new Date('2026-10-30T12:00:00.000Z');
const LATER = new Date('2026-12-01T00:00:00.000Z');
const EARLIER = new Date('2026-10-01T00:00:00.000Z');

interface Row {
  id: string;
  companyId: string;
  productId: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  sellingPrice: number;
  discount: number;
  compareAtPrice: number | null;
  isDefault: boolean;
  deliveryIncluded: boolean;
  endsAt: Date | null;
  status: string;
  postOrderOffer: boolean;
  sortOrder: number;
}

const row = (over: Partial<Row> & { id: string }): Row => ({
  companyId: 'c1',
  productId: 'p1',
  name: over.id,
  quantity: 3,
  freeQuantity: 1,
  sellingPrice: 75,
  discount: 0,
  compareAtPrice: null,
  isDefault: false,
  deliveryIncluded: true,
  endsAt: null,
  status: 'ACTIVE',
  postOrderOffer: false,
  sortOrder: 0,
  ...over,
});

const ROWS: Row[] = [
  row({ id: 'live-1', productId: 'p1' }),
  row({ id: 'live-2', productId: 'p1', quantity: 6, freeQuantity: 2, sellingPrice: 150, sortOrder: 1 }),
  row({ id: 'stopped', productId: 'p1', status: 'PAUSED' }),
  row({ id: 'finished', productId: 'p1', endsAt: EARLIER }),
  row({ id: 'after-the-order', productId: 'p1', sellingPrice: 15, postOrderOffer: true }),
  row({ id: 'ends-later', productId: 'p2', endsAt: LATER, discount: 3 }),
  row({ id: 'other-company', productId: 'p2', companyId: 'c2' }),
  row({ id: 'p3-live', productId: 'p3' }),
];

type Where = Record<string, any>;

function matches(where: Where, r: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Where[]).some((w) => matches(w, r));
    const have = (r as unknown as Where)[key];
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      if ('in' in want) return (want.in as unknown[]).includes(have);
      if ('gt' in want) return have instanceof Date && have.getTime() > (want.gt as Date).getTime();
    }
    if (want === null) return have === null;
    return have === want;
  });
}

function fakeTx() {
  const findMany = vi.fn(async (args: { where: Where }) => ROWS.filter((r) => matches(args.where, r)));
  const groupBy = vi.fn(async (): Promise<unknown[]> => []);
  return { tx: { offer: { findMany }, order: { groupBy } } as never, findMany, groupBy };
}

describe('the offers on sale right now, for many products in one query', () => {
  it('returns only the live ones: not stopped, not finished, not the one shown after the order', async () => {
    const { tx } = fakeTx();
    const got = await activeOffersForProducts(tx, 'c1', ['p1'], 3, NOW);
    expect(got.get('p1')?.map((o) => o.id)).toEqual(['live-1', 'live-2']);
    // NEGATIVE, one by one: each of the three is in the fixture and each is left out for its own reason.
    const ids = got.get('p1')?.map((o) => o.id) ?? [];
    expect(ids).not.toContain('stopped');
    expect(ids).not.toContain('finished');
    expect(ids).not.toContain('after-the-order');
  });

  it('an offer that ends later is still on sale; another company’s offer never is', async () => {
    const { tx } = fakeTx();
    const got = await activeOffersForProducts(tx, 'c1', ['p2'], 3, NOW);
    expect(got.get('p2')?.map((o) => o.id)).toEqual(['ends-later']);
    expect(got.get('p2')?.[0]?.endsAt).toEqual(LATER);
  });

  it('many products in ONE query, each under its own key, and a product with nothing on sale has an empty list', async () => {
    const { tx, findMany } = fakeTx();
    const got = await activeOffersForProducts(tx, 'c1', ['p1', 'p2', 'p3', 'p4'], 3, NOW);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect([...got.keys()]).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(got.get('p1')).toHaveLength(2);
    expect(got.get('p2')).toHaveLength(1);
    expect(got.get('p3')?.map((o) => o.id)).toEqual(['p3-live']);
    expect(got.get('p4')).toEqual([]);
  });

  it('keeps the reader’s order inside a product: by sortOrder, then by bundle size (the query asks for it)', async () => {
    const { tx, findMany } = fakeTx();
    await activeOffersForProducts(tx, 'c1', ['p1'], 3, NOW);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ orderBy: [{ sortOrder: 'asc' }, { quantity: 'asc' }] });
  });

  it('asks for nobody and asks nothing: an empty list is an empty answer without a query', async () => {
    const { tx, findMany } = fakeTx();
    const got = await activeOffersForProducts(tx, 'c1', [], 3, NOW);
    expect(got.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('a repeated id is asked once and answered once', async () => {
    const { tx } = fakeTx();
    const got = await activeOffersForProducts(tx, 'c1', ['p1', 'p1', 'p1'], 3, NOW);
    expect([...got.keys()]).toEqual(['p1']);
    expect(got.get('p1')).toHaveLength(2);
  });

  it('one product is queried exactly as it always was (productId: <id>), many with `in`', async () => {
    const one = fakeTx();
    await activeOffersForProducts(one.tx, 'c1', ['p1'], 3, NOW);
    expect(one.findMany.mock.calls[0]?.[0].where).toMatchObject({ companyId: 'c1', productId: 'p1', status: 'ACTIVE', postOrderOffer: false });
    const many = fakeTx();
    await activeOffersForProducts(many.tx, 'c1', ['p1', 'p2'], 3, NOW);
    expect(many.findMany.mock.calls[0]?.[0].where).toMatchObject({ companyId: 'c1', productId: { in: ['p1', 'p2'] } });
  });

  it('the company is part of the question: the same ids under another company return that company’s offers only', async () => {
    const { tx } = fakeTx();
    const got = await activeOffersForProducts(tx, 'c2', ['p1', 'p2'], 3, NOW);
    expect(got.get('p1')).toEqual([]);
    expect(got.get('p2')?.map((o) => o.id)).toEqual(['other-company']);
  });
});

describe('and the single-product reader is the same reader', () => {
  it('activeOffersFor answers exactly what activeOffersForProducts says for that product', async () => {
    const { tx } = fakeTx();
    const one = await activeOffersFor(tx, 'c1', 'p1', 3, NOW);
    const many = await activeOffersForProducts(tx, 'c1', ['p1', 'p2'], 3, NOW);
    expect(one).toEqual(many.get('p1'));
    expect(one.map((o) => o.id)).toEqual(['live-1', 'live-2']);
  });

  it('a product with no live offer is an empty list, never undefined', async () => {
    const { tx } = fakeTx();
    expect(await activeOffersFor(tx, 'c1', 'nobody', 3, NOW)).toEqual([]);
  });

  it('a caller’s stub that leaves productId out of a row still answers for the one product asked about', async () => {
    const findMany = vi.fn(async () => [{ ...row({ id: 'stub' }), productId: undefined }]);
    const tx = { offer: { findMany }, order: { groupBy: vi.fn(async () => []) } } as never;
    expect((await activeOffersFor(tx, 'c1', 'p1', 3, NOW)).map((o) => o.id)).toEqual(['stub']);
  });
});

describe('the reduction said out loud', () => {
  it('is what the bundle’s own reduction really took: list price less the charged price', async () => {
    const { tx } = fakeTx();
    const [reduced] = (await activeOffersForProducts(tx, 'c1', ['p2'], 3, NOW)).get('p2') ?? [];
    expect(reduced).toMatchObject({ price: 72, listPrice: 75 });
    expect(withTheReduction(reduced!, 3)).toMatchObject({ price: 72, listPrice: 75, discount: 3 });
  });

  it('is 0 for a bundle with no reduction, and the view is otherwise untouched', async () => {
    const { tx } = fakeTx();
    const [plain] = (await activeOffersForProducts(tx, 'c1', ['p1'], 3, NOW)).get('p1') ?? [];
    expect(withTheReduction(plain!, 3)).toEqual({ ...plain, discount: 0 });
  });
});
