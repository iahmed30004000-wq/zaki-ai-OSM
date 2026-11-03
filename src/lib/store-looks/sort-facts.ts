import { db } from '../db';
import { bestSellers } from '../store-facts';
import type { LandingSection } from '../landing-sections';
import type { CatalogItem } from '@/components/landing/blocks/PageBlocks';

/**
 * THE TWO FACTS A SORTED CATALOGUE ROW NEEDS, AND NOTHING FOR ONE THAT IS NOT.
 *
 * «وصل حديثاً» needs when each product was added; «الأكثر مبيعاً» needs how
 * many DELIVERED orders carried it — `bestSellers`, which already drops a
 * product below the sample floor, so a product that sold twice is absent
 * rather than ranked on two. No count is ever drawn: `sold` orders the row
 * and decides its heading, and that is all.
 *
 * Only product cards are decorated (a landing page's card keeps its place
 * after them). A home with no sorted row gets back the very object it gave,
 * having asked the database nothing.
 */
export async function sortFacts<T extends { items: CatalogItem[] }>(
  catalogue: T,
  home: readonly LandingSection[],
  scope: { companyId: string; storeId: string }
): Promise<T> {
  const sorts = new Set(home.flatMap((s) => (s.type === 'catalog' && s.sort !== 'shelf' ? [s.sort] : [])));
  if (!sorts.has('newest') && !sorts.has('best')) return catalogue;

  const ids = catalogue.items.filter((i) => i.kind === 'product').map((i) => i.id);
  if (!ids.length) return catalogue;

  const [added, sold] = await Promise.all([
    sorts.has('newest')
      ? db.product.findMany({
          where: { companyId: scope.companyId, storeId: scope.storeId, id: { in: ids } },
          select: { id: true, createdAt: true },
        })
      : Promise.resolve([]),
    sorts.has('best') ? bestSellers(db, scope) : Promise.resolve(new Map<string, number>()),
  ]);
  const addedAt = new Map(added.map((p) => [p.id, p.createdAt.getTime()]));

  return {
    ...catalogue,
    items: catalogue.items.map((i) => {
      if (i.kind !== 'product') return i;
      const at = addedAt.get(i.id);
      const n = sold.get(i.id);
      return { ...i, ...(at !== undefined ? { addedAt: at } : {}), ...(n !== undefined ? { sold: n } : {}) };
    }),
  };
}
