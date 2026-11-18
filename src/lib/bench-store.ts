import type { Prisma } from '@prisma/client';
import type { db } from './db';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * IS THIS STORE A TEST BENCH? — asked of the database, once per request.
 *
 * The doors that move an order toward a courier (`test-store.ts`, «A BENCH ORDER
 * STOPS AT CONFIRMATION») are all scoped to ONE store, so one read answers for
 * every order the door holds.
 *
 * Asked as «is it marked a bench», never as «is it a real store»: a store row
 * that cannot be found answers NO, so a missing row behaves exactly as every
 * store did before 18/11 instead of refusing work nobody marked.
 */
export async function isBenchStore(tx: Tx, scope: { companyId: string; storeId: string | null | undefined }): Promise<boolean> {
  if (!scope.storeId) return false;
  const bench = await tx.store.findFirst({
    where: { id: scope.storeId, companyId: scope.companyId, isTest: true },
    select: { id: true },
  });
  return !!bench;
}
