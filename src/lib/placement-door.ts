import { NextResponse } from 'next/server';
import { db } from './db';
import { warehousesReachedBy } from './warehouses';
import type { PlacementCount } from './warehouse-placement';
import type { SessionUser } from '@/types/auth';

/**
 * What the two placement doors (`/api/inventory/placement` and its preview) share: the Arabic refusal, and the one check
 * that needs the session — every warehouse the counts name is one this person reaches (`warehouses.warehousesReachedBy`:
 * its country, and her keeper rows). A warehouse of another company is simply not found here; the lib refuses it by name.
 */

export const refuse = (status: number, code: string, ar: string) => NextResponse.json({ error: ar, errorAr: ar, code }, { status });

export const WAREHOUSE_NOT_REACHED_AR = 'في مخزن ما إلك وصول عليه. وزّع على المخازن اللي إلك بس.';

export async function refuseUnreached(user: SessionUser, companyId: string, counts: readonly PlacementCount[]) {
  if (counts.length === 0) return null;
  const named = await db.warehouse.findMany({
    where: { companyId, id: { in: [...new Set(counts.map((c) => c.warehouseId))] } },
    select: { id: true, companyId: true, countryId: true },
  });
  const reached = await warehousesReachedBy(user, companyId, named);
  if (reached.length < named.length) return refuse(403, 'WAREHOUSE_NOT_REACHED', WAREHOUSE_NOT_REACHED_AR);
  return null;
}
