import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, bestSellers } = vi.hoisted(() => ({
  db: { product: { findMany: vi.fn() } },
  bestSellers: vi.fn(),
}));
vi.mock('../db', () => ({ db }));
vi.mock('../store-facts', () => ({ bestSellers: (...a: unknown[]) => bestSellers(...a) }));

import { sortFacts } from './sort-facts';
import { newSection, type LandingSection } from '../landing-sections';
import type { CatalogItem } from '@/components/landing/blocks/PageBlocks';

const items: CatalogItem[] = [
  { id: 'p1', kind: 'product', name: 'a', image: null, href: '/a', price: 1, categoryId: null },
  { id: 'lp1', kind: 'page', name: 'b', image: null, href: '/b', price: 2, categoryId: null },
];
const catalogue = { items, categories: [] };
const row = (sort: string) => ({ ...newSection('catalog'), sort }) as LandingSection;
const scope = { companyId: 'c1', storeId: 's1' };

beforeEach(() => {
  vi.resetAllMocks();
  db.product.findMany.mockResolvedValue([{ id: 'p1', createdAt: new Date(5000) }]);
  bestSellers.mockResolvedValue(new Map([['p1', 7]]));
});

describe('the facts a sorted row asks for', () => {
  it('a home whose rows chose no order asks the database nothing and gets back what it gave', async () => {
    const out = await sortFacts(catalogue, [row('shelf'), newSection('trust')], scope);
    expect(out).toBe(catalogue);
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(bestSellers).not.toHaveBeenCalled();
  });

  it('«الأقل سعراً» needs nothing more than the price it already has', async () => {
    expect(await sortFacts(catalogue, [row('priceAsc')], scope)).toBe(catalogue);
  });

  it('«الأكثر مبيعاً» reads this store’s delivered orders, and decorates product cards only', async () => {
    const out = await sortFacts(catalogue, [row('best')], scope);
    expect(bestSellers).toHaveBeenCalledWith(expect.anything(), scope);
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(out.items[0]).toMatchObject({ id: 'p1', sold: 7 });
    expect(out.items[1]).toEqual(items[1]);
  });

  it('«وصل حديثاً» reads when each of THIS store’s products was added', async () => {
    const out = await sortFacts(catalogue, [row('newest')], scope);
    const where = db.product.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ companyId: 'c1', storeId: 's1', id: { in: ['p1'] } });
    expect(out.items[0]).toMatchObject({ addedAt: 5000 });
    expect(out.items[0].sold).toBeUndefined();
  });
});
