import type { Prisma } from '@prisma/client';
import { db } from './db';
import { courierScope } from './couriers/scope';
import {
  CUSTODY_DELIVERED,
  CUSTODY_IN_HAND,
  CUSTODY_UNSETTLED,
  custodyTotals,
  wasDelivered,
  type CustodyTotals,
} from './agent-custody-totals';

/**
 * AGENT CUSTODY — what a courier is holding right now.
 *
 * A shipping company sends a statement and we match it. An agent sends
 * nothing: he takes parcels from the warehouse, knocks on doors, collects
 * cash, and comes back. Between those two moments the company's goods and
 * the company's money are in his hands and nothing said how much.
 *
 * So custody is DERIVED from the orders he is carrying, exactly the way the
 * order state and the zone are derived — there is no custody column to fall
 * out of step with reality, and no second place to correct.
 *
 * Three questions, in the order anyone asks them:
 *
 *   ما زال بيده   — parcels shipped to him and not yet closed
 *   حصّله ولم يسلّمه — cash collected on delivered orders, not yet settled
 *   له علينا       — his delivery fees on those same orders
 *
 * The balance is what he owes us minus what we owe him. It is never stored:
 * the moment a receipt is recorded the orders behind it settle, and the same
 * calculation returns a smaller number.
 *
 * WHAT THIS FILE DOES NOT DECIDE. The arithmetic lives in
 * agent-custody-totals.ts, which is pure and takes no database — because
 * «did anybody actually record what he took at this door?» is a rule, not a
 * query, and it was being answered wrongly here by a `??`.
 */

export interface CustodyOrder {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  customerName: string;
  regionName: string | null;
  shippingStatus: string;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  /** What the order is worth. Always known. */
  orderValue: number;
  /**
   * What he actually took at the door. NULL when nothing has recorded it —
   * the normal state until the settlement covering it is approved. It is never
   * filled in from the order total: that is our expectation, not his debt.
   */
  collected: number | null;
  /** His fee for that door. */
  fee: number;
}

export interface AgentCustody {
  agent: { id: string; name: string; code: string };
  currencyCode: string;
  /** Parcels still out with him. */
  inHand: CustodyOrder[];
  /** Delivered — whatever we know about the money. */
  owing: CustodyOrder[];
  totals: CustodyTotals;
}

type Tx = Prisma.TransactionClient | typeof db;

interface Scope {
  companyId: string;
  storeId: string;
  minorUnit: number;
  currencyCode: string;
}

/**
 * One agent's custody, or null when that provider is not an agent of ours.
 *
 * «Of ours» is checked twice and both halves matter. The STORE, because a
 * courier belongs to one store and this function counts only that store's
 * orders — answering for another store's agent returned his name over an
 * empty custody, which reads as «he is holding nothing». And the KIND,
 * because a shipping COMPANY settles by statement: custody is not a thing it
 * has, and a derived «balance» for one would compete with the matched figure
 * the statement produces.
 */
export async function agentCustody(
  tx: Tx,
  providerId: string,
  scope: Scope
): Promise<AgentCustody | null> {
  const agent = await tx.deliveryProvider.findFirst({
    // `courierScope` LAST: with no store in context it narrows `id` to an
    // empty set, and an `id` spread after it would quietly undo that.
    where: { id: providerId, kind: 'AGENT', ...courierScope(scope.companyId, scope.storeId) },
    select: { id: true, name: true, code: true, kind: true },
  });
  if (!agent) return null;

  const orders = await tx.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      deliveryProviderId: providerId,
      OR: [
        { shippingStatus: { in: [...CUSTODY_IN_HAND] } },
        { shippingStatus: { in: [...CUSTODY_DELIVERED] }, settlementStatus: { in: [...CUSTODY_UNSETTLED] } },
      ],
    },
    select: {
      id: true, orderNumber: true, merchantRef: true,
      shippingStatus: true, shippedAt: true, deliveredAt: true,
      totalAmount: true, collectedAmount: true, deliveryFee: true,
      customer: { select: { fullName: true } },
      region: { select: { name: true } },
    },
    orderBy: { shippedAt: 'asc' },
  });

  const inHand: CustodyOrder[] = [];
  const owing: CustodyOrder[] = [];

  for (const o of orders) {
    const row: CustodyOrder = {
      id: o.id,
      orderNumber: o.orderNumber,
      merchantRef: o.merchantRef,
      customerName: o.customer?.fullName ?? '—',
      regionName: o.region?.name ?? null,
      shippingStatus: o.shippingStatus,
      shippedAt: o.shippedAt,
      deliveredAt: o.deliveredAt,
      orderValue: Number(o.totalAmount ?? 0),
      // Read, never inferred.
      collected: o.collectedAmount === null || o.collectedAmount === undefined ? null : Number(o.collectedAmount),
      fee: Number(o.deliveryFee ?? 0),
    };
    if (wasDelivered(o.shippingStatus)) owing.push(row);
    else inHand.push(row);
  }

  return {
    agent: { id: agent.id, name: agent.name, code: agent.code },
    currencyCode: scope.currencyCode,
    inHand,
    owing,
    totals: custodyTotals([...inHand, ...owing], scope.minorUnit),
  };
}

/**
 * Every agent OF THIS STORE, with their custody. Quiet agents included: a zero
 * balance is an answer, and its absence looks like a missing page.
 *
 * Scoped through `courierScope` — the one function that decides which couriers
 * a store may see. This listed every agent in the COMPANY while counting only
 * the selected store's orders, so an agent who works for another store showed
 * up here as «متوازن 0»: a settled-looking figure about work this store cannot
 * see at all.
 */
export async function allAgentCustody(tx: Tx, scope: Scope): Promise<AgentCustody[]> {
  const agents = await tx.deliveryProvider.findMany({
    where: { ...courierScope(scope.companyId, scope.storeId), kind: 'AGENT' },
    select: { id: true },
    orderBy: { name: 'asc' },
  });

  const rows = await Promise.all(agents.map((a) => agentCustody(tx, a.id, scope)));
  return rows.filter((r): r is AgentCustody => r !== null);
}
