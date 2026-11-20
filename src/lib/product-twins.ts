import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';

type Client = Prisma.TransactionClient | typeof prismaDb;

/**
 * THE TWIN OF A PRODUCT IN ONE OTHER STORE — the one read of the pairs table outside the pair doors (the warehouse
 * plan, request W7b). A transfer across stores asks it at the send to know which product of the other store its units
 * land in. The pairs are made and removed by `product-pairs.ts` (W7a) — a person's choice, never the system's.
 *
 * A pair is written in ONE direction (side A is the store whose id sorts first), so the twin of a product of `storeId` is
 * on side B when `storeId` is side A, and on side A otherwise. A product with no pair to that store is absent from the
 * answer; the transfer refuses it by name.
 *
 * Its own small file, not `product-pairs.ts`: that module loads the session's store-entry rule (`geo-context`, and the
 * permission engine under it), and the stock libraries that ask this must load nothing of the kind. Reads only.
 */
export async function twinsIn(
  client: Client,
  companyId: string,
  storeId: string,
  productIds: readonly string[],
  otherStoreId: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(productIds)];
  if (ids.length === 0 || otherStoreId === storeId) return out;
  const rows = await client.productPair.findMany({
    where: {
      companyId,
      OR: [
        { storeAId: storeId, storeBId: otherStoreId, productAId: { in: ids } },
        { storeBId: storeId, storeAId: otherStoreId, productBId: { in: ids } },
      ],
    },
    select: { productAId: true, storeAId: true, productBId: true, storeBId: true },
  });
  for (const r of rows) {
    if (r.storeAId === storeId) out.set(r.productAId, r.productBId);
    else out.set(r.productBId, r.productAId);
  }
  return out;
}
