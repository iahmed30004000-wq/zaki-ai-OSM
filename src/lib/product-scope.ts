import type { Prisma } from '@prisma/client';

/**
 * WHICH PRODUCTS A `products.view` GRANT REACHES — ONE FUNCTION, FOR EVERY DOOR THAT LISTS THEM.
 *
 * The catalogue route wrote this inline: this store's products, narrowed by the grant's scope
 * (a category, or specific products). The command palette is a second door that lists products,
 * and a second copy of «what may this account see» is how a search box shows a product the
 * list would have hidden. So it is written once and both read it.
 *
 * `scope` is what `getPermissionScope(user, 'products.view')` returned — the caller has already
 * refused an account with no grant. ALL_COMPANY and OWN add no filter (OWN is unsupported for
 * products and treated as company-wide, as the route always did).
 */
export function productScopeWhere(
  scope: { scope: string; scopeIds?: unknown },
  companyId: string,
  storeId?: string | null
): Prisma.ProductWhereInput {
  // This store's catalogue: a product from another store showing up is one somebody could try to sell.
  const where: Prisma.ProductWhereInput = { companyId, ...(storeId ? { storeId } : {}) };
  const ids = Array.isArray(scope.scopeIds) ? (scope.scopeIds as string[]) : [];
  if (scope.scope === 'CATEGORY') where.categoryId = { in: ids };
  else if (scope.scope === 'SPECIFIC') where.id = { in: ids };
  return where;
}

/**
 * THE SAME RULE, NARROWED TO THE ROWS A SCREEN IS SHOWING.
 *
 * `/api/products/grades?ids=…` answers only for the products on one page, so it starts from the catalogue rule above and
 * intersects with the ids asked for — an id in a query string is a request, not a permission. For a SPECIFIC grant the
 * intersection is taken here (an id the grant does not name is simply dropped); for every other scope the grant's own
 * filter is kept and the ids are added to it.
 *
 * It is written on top of `productScopeWhere`, not beside it: the day a new scope kind appears, it is added in ONE place.
 */
export function productScopeWhereWithin(
  scope: { scope: string; scopeIds?: unknown },
  companyId: string,
  storeId: string | null | undefined,
  ids: readonly string[]
): Prisma.ProductWhereInput {
  const where = productScopeWhere(scope, companyId, storeId);
  if (scope.scope === 'SPECIFIC') {
    const granted = Array.isArray(scope.scopeIds) ? (scope.scopeIds as string[]) : [];
    where.id = { in: ids.filter((id) => granted.includes(id)) };
  } else {
    where.id = { in: [...ids] };
  }
  return where;
}
