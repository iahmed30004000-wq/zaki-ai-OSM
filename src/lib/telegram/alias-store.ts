/**
 * What the three «أسماء المنتجات» doors share: the store being worked (with its currency, which bounds a price's decimals), the
 * row as the screen reads it, and the product check — a name may only point at an ACTIVE product of the SAME store.
 *
 * Kept in the library so the routes stay thin.
 */
import { db } from '@/lib/db';
import { toAliasRow, type AliasRow } from '@/lib/telegram/aliases';

export async function storeOf(companyId: string, storeId: string) {
  return db.store.findFirst({
    where: { id: storeId, companyId },
    select: { id: true, country: { select: { currencyCode: true, minorUnit: true } } },
  });
}

/** The row as the screen draws it: numbers, never Decimals, and the old offers read defensively. */
export function view(row: Parameters<typeof toAliasRow>[0] & { product?: { name: string } | null }) {
  const alias = toAliasRow(row);
  return { ...alias, productName: row.product?.name ?? null };
}

export const ROW_SELECT = {
  id: true,
  kind: true,
  incomingName: true,
  foldedName: true,
  productId: true,
  extraUnits: true,
  linePrice: true,
  offerAliases: true,
  isActive: true,
  product: { select: { name: true } },
} as const;

/** The product a name points at: this company's, this store's, ACTIVE. */
export async function activeProductOf(companyId: string, storeId: string, productId: string) {
  return db.product.findFirst({ where: { id: productId, companyId, storeId, status: 'ACTIVE' }, select: { id: true, name: true } });
}

/** The first message of a zod refusal, in Arabic (the schema's own words). */
export function firstIssue(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message || 'البيانات مش صحيحة';
}

/** The ACTIVE names of one store, as the door reads them. */
export async function loadAliases(companyId: string, storeId: string): Promise<AliasRow[]> {
  const rows = await db.telegramUpsellProduct.findMany({
    where: { companyId, storeId, isActive: true },
    select: {
      id: true,
      kind: true,
      incomingName: true,
      foldedName: true,
      productId: true,
      extraUnits: true,
      linePrice: true,
      offerAliases: true,
      isActive: true,
    },
  });
  return rows.map(toAliasRow);
}
