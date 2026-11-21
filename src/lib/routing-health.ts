import type { Prisma } from '@prisma/client';
import type { BusinessCalendar } from './business-calendar';
import type { db } from './db';
import { duePostponedWhere, readyToPullWhere, type QueueScope } from './confirmation-queue';
import { readConfirmationRules } from './employee-numbers';
import { routingRulesInForce, unstaffedWhere } from './routing-rules';
import { readRoutingStaff } from './routing-staff';

type Client = Prisma.TransactionClient | typeof db;

/**
 * «طلبات بلا موظفة» ON THE SUPERVISOR'S BOARD (request Q5b of the rules plan, 21/11): how many orders of the pool — takeable now, or a postponement that is due — are
 * governed by a ROUTING rule none of whose people can pull (`routing-rules.ts`: they wait the rule's fallback, then go to everyone). Read in the board's own lane.
 *
 * undefined = no ROUTING rule is in force for the store: the board's answer carries no such key, exactly as before. 0 without a statement when every rule in force
 * has somebody. One count otherwise. A read that fails answers undefined (the board stands without the line). Reading only.
 */
export async function readUnstaffedOrders(client: Client, scope: QueueScope, cal: BusinessCalendar, now: Date): Promise<number | undefined> {
  try {
    const inForce = routingRulesInForce(await readConfirmationRules(client, scope.companyId, now.getTime()), { ...scope, now, timezone: cal.timezone });
    if (inForce.length === 0) return undefined;
    const where = unstaffedWhere(inForce, await readRoutingStaff(scope.companyId, scope.storeId, now.getTime()));
    if (where === null) return 0;
    return await client.order.count({ where: { AND: [{ OR: [readyToPullWhere(scope, undefined, now), duePostponedWhere(scope, now)] }, where] } });
  } catch {
    return undefined;
  }
}
