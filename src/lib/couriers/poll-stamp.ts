import { Prisma } from '@prisma/client';
import { db } from '../db';

/**
 * «WHEN DID WE LAST ASK THE COURIER ABOUT THIS PARCEL» (RV146) — the poll's place, kept in the database.
 *
 * The status job asks about sixty parcels per courier per sweep, the ones never asked about first, then the ones asked
 * longest ago. This stamps the ones it has just asked.
 *
 * RAW SQL ON PURPOSE, AND ONLY THIS COLUMN. `db.order.update` would bump `updatedAt`, which the media buyer's hourly
 * read pages by (`@@index([companyId, updatedAt])`) — sixty orders would look «changed» every two minutes. It also
 * bumps nothing else: no `version`, no status, no amount. The WHERE carries the company, so a stamp can never land on
 * another company's order even if an id were wrong.
 *
 * BEST EFFORT. A stamp that cannot be written is the poll asking the same parcels again in two minutes — which is what
 * it did before there was a stamp. It never stops the sweep and never turns a successful sweep into a failed one.
 */
export async function stampCourierPolled(companyId: string, orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  try {
    await db.$executeRaw`
      UPDATE "orders"
         SET "courier_polled_at" = now()
       WHERE "companyId" = ${companyId}
         AND "id" IN (${Prisma.join(orderIds)})`;
  } catch {
    /* see above */
  }
}
