import type { Prisma } from '@prisma/client';
import { db } from './db';
import { can } from './authorization';
import { resolveAudience } from './notification-audience';
import { mayBeHandedAnOrder } from './confirmation-queue';
import { deriveCoreState, getZone } from './order-state';
import { LOST_STATUSES } from './winback';
import { DELIVERED_STATUSES, type CustomerVerdict } from './winback-customer';
import { DEFAULT_PIECES, winbackPriceFor, type Pieces, type WinbackPrices } from './winback-prices';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «وزّع على الموظفات» — A MANAGER OFFERS MANY CANCELLED ORDERS AGAIN AT ONCE, EACH TO AN AGENT'S PRIVATE LIST.
 *
 * The owner's ruling 25/11 («A + 1 (modified)»): every new order is made by the ONE win-back creator (`POST /api/confirmation/winback`'s
 * `offerOne`, in its own file — this module makes no order) at the owner's 3-piece win-back price, and is then handed to an agent's
 * PRIVATE win-back list (`winback-private-list.ts`) — OUTSIDE her hand limit, so no agent's cap is read or spent here. The cancelled
 * order is never touched: the creator links the new one to it (`replacesOrderId`, unique — the database itself refuses a second offer on
 * one cancelled order, even from two managers pressing at once).
 *
 * THIS FILE: the pure plan (who gets which, what is skipped and why) and the reads it needs. In order:
 *
 *   1. the candidates — the «ready» view of the pool (the same filter as the list), narrowed by the manager's filters, NEWEST first;
 *   2. per candidate, in that order: one per customer · the customer may be rung (`winback-customer.ts`) · he has no live order (the
 *      duplicate guard) · one product with a win-back price in the order's currency · the price is not below what the three pieces cost;
 *   3. dealt round-robin to the agents picked — an even split. No quantity is excluded: every order is offered at the 3-piece option.
 *
 * Capped at `BULK_MAX` orders a press. No customer field is written to a log: the plan names orders and agents only.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const BULK_MAX = 200;
/** How many of the pool's newest candidates one plan reads, at most — far above any page of work. */
export const BULK_SCAN = 3000;

export const SKIP_CODES = [
  'SAME_CUSTOMER',
  'CUSTOMER_CANCELLED_TWICE',
  'CUSTOMER_HAS_LIVE_ORDER',
  'MIXED_PRODUCTS',
  'NO_WINBACK_PRICE',
  'CURRENCY_MISMATCH',
  'NO_LINES',
  'PRICE_BELOW_COST',
] as const;
export type SkipCode = (typeof SKIP_CODES)[number];

export const SKIP_AR: Record<SkipCode, string> = {
  SAME_CUSTOMER: 'نفس الزبون بطلب تاني (طلب وحدة لكل زبون)',
  CUSTOMER_CANCELLED_TWICE: 'الزبون لغى مرتين وما استلم بعدها',
  CUSTOMER_HAS_LIVE_ORDER: 'الزبون عندو طلب شغّال',
  MIXED_PRODUCTS: 'الطلب فيه أكتر من منتج',
  NO_WINBACK_PRICE: 'المنتج ما إلو سعر استرجاع',
  CURRENCY_MISMATCH: 'عملة الطلب غير عملة سعر الاسترجاع',
  NO_LINES: 'الطلب ما فيه بضاعة',
  PRICE_BELOW_COST: 'سعر الاسترجاع أقل من تكلفة البضاعة',
};

export interface BulkCandidate {
  orderId: string;
  orderNumber: string;
  customerId: string;
  currency: string;
  lines: Array<{ productId: string; quantity: number; freeQuantity: number }>;
  /** The cancelled order's own cost of goods (for ITS pieces) — shared over its pieces when the product has no fixed figure. */
  oldCost: number;
  /** What ONE piece of the new order costs (`winbackUnitCost`: the owner's fixed figure, else the old order's cost per piece). */
  unitCost: number;
}

export interface PlannedRow {
  orderId: string;
  orderNumber: string;
  agentId: string;
  price: number;
  pieces: Pieces;
  /** The cancelled order's own pieces (paid + free) — shown to the agent, never a reason. */
  oldPieces: number;
}

export interface BulkPlan {
  planned: PlannedRow[];
  skipped: Partial<Record<SkipCode, number>>;
  /** Each skipped candidate and why — the run reports it on its row. */
  skippedRows: Array<{ orderId: string; orderNumber: string; code: SkipCode }>;
  perAgent: Record<string, number>;
}

/** THE PLAN — pure. `candidates` newest first; `agents` in the order picked. Nothing here reads a clock or a database. */
export function planBulk(input: {
  candidates: readonly BulkCandidate[];
  count: number;
  agents: ReadonlyArray<{ id: string }>;
  customers: ReadonlyMap<string, CustomerVerdict>;
  liveCustomers: ReadonlySet<string>;
  prices: WinbackPrices;
}): BulkPlan {
  const want = Math.max(0, Math.min(BULK_MAX, Math.floor(input.count)));
  const skipped: Partial<Record<SkipCode, number>> = {};
  const skippedRows: BulkPlan['skippedRows'] = [];
  let current: BulkCandidate | null = null;
  const skip = (c: SkipCode) => {
    skipped[c] = (skipped[c] ?? 0) + 1;
    if (current) skippedRows.push({ orderId: current.orderId, orderNumber: current.orderNumber, code: c });
  };
  const perAgent: Record<string, number> = Object.fromEntries(input.agents.map((a) => [a.id, 0]));
  const planned: PlannedRow[] = [];
  const seen = new Set<string>();
  let turn = 0;

  for (const c of input.candidates) {
    if (planned.length >= want || input.agents.length === 0) break;
    current = c;
    if (seen.has(c.customerId)) {
      skip('SAME_CUSTOMER');
      continue;
    }
    seen.add(c.customerId);
    const who = input.customers.get(c.customerId);
    if (who && !who.eligible) {
      skip('CUSTOMER_CANCELLED_TWICE');
      continue;
    }
    if (input.liveCustomers.has(c.customerId)) {
      skip('CUSTOMER_HAS_LIVE_ORDER');
      continue;
    }
    const price = winbackPriceFor(c.lines, input.prices, c.currency);
    if (!price.ok) {
      skip(price.code);
      continue;
    }
    // Never below what the goods cost: a win-back sold at a loss is not one (pending the coordinator — see the PR).
    if (price.price < c.unitCost * DEFAULT_PIECES) {
      skip('PRICE_BELOW_COST');
      continue;
    }
    // Round-robin: the next agent in turn. Her private list is outside her hand limit, so nobody is ever «full».
    const agent = input.agents[turn % input.agents.length];
    turn += 1;
    perAgent[agent.id] = (perAgent[agent.id] ?? 0) + 1;
    planned.push({ orderId: c.orderId, orderNumber: c.orderNumber, agentId: agent.id, price: price.price, pieces: price.pieces, oldPieces: price.oldPieces });
  }
  return { planned, skipped, skippedRows, perAgent };
}

type OrderRow = {
  id: string;
  orderNumber: string;
  customerId: string;
  currency: string;
  productId: string;
  quantity: number | null;
  freeQuantity: number | null;
  estimatedCostOfGoods: number | null;
  items: Array<{ productId: string; quantity: number; freeQuantity: number | null }>;
};

/** A cancelled order as the plan reads it — its goods (its own lines, else its product columns). `unitCost` is filled by the caller. */
export function toCandidate(o: OrderRow): BulkCandidate {
  const lines = o.items.length
    ? o.items.map((l) => ({ productId: l.productId, quantity: l.quantity, freeQuantity: l.freeQuantity ?? 0 }))
    : [{ productId: o.productId, quantity: o.quantity ?? 1, freeQuantity: o.freeQuantity ?? 0 }];
  return { orderId: o.id, orderNumber: o.orderNumber, customerId: o.customerId, currency: o.currency, lines, oldCost: Number(o.estimatedCostOfGoods ?? 0), unitCost: 0 };
}

export const CANDIDATE_SELECT = {
  id: true,
  orderNumber: true,
  customerId: true,
  currency: true,
  productId: true,
  quantity: true,
  freeQuantity: true,
  estimatedCostOfGoods: true,
  items: { select: { productId: true, quantity: true, freeQuantity: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderSelect;

/** The candidates of a where (the pool's ready view and the filters), newest first. */
export async function readCandidates(where: Prisma.OrderWhereInput, take: number = BULK_SCAN): Promise<BulkCandidate[]> {
  const rows = await db.order.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, select: CANDIDATE_SELECT });
  return (rows as unknown as OrderRow[]).map(toCandidate);
}

/**
 * THE CUSTOMERS WHO ALREADY HAVE A LIVE ORDER in this store — one that is not closed (`getZone` ≠ CLOSED): new, in confirmation, in the
 * warehouse or on the road. A second order beside it would be a double (the duplicate guard).
 */
export async function customersWithALiveOrder(scope: { companyId: string; storeId: string }, customerIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(customerIds)];
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const rows = await db.order.findMany({
    where: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      customerId: { in: ids },
      confirmationStatus: { notIn: [...LOST_STATUSES] },
      shippingStatus: { notIn: [...DELIVERED_STATUSES, 'RETURNED', 'CANCELLED'] },
    },
    select: { customerId: true, confirmationStatus: true, shippingStatus: true, claimedById: true, shippedAt: true },
  });
  for (const r of rows) if (getZone(deriveCoreState(r)) !== 'CLOSED') out.add(r.customerId);
  return out;
}

export interface BulkAgent {
  id: string;
  name: string;
  /** Open rows on her private win-back list now — information, never a limit. */
  listOpen: number;
}

/**
 * WHO MAY RECEIVE ONE — the agents of this store who may pull (`confirmation.pull`) and work an order handed to them (`mayBeHandedAnOrder`,
 * the transfer's question). No cap is read: the private list is outside the hand.
 */
export async function bulkAgents(scope: { companyId: string; storeId: string }, only?: readonly string[]): Promise<BulkAgent[]> {
  const audience = await resolveAudience({ companyId: scope.companyId, storeId: scope.storeId, audience: { permission: 'confirmation.pull' } });
  const people = audience
    .filter((u) => mayBeHandedAnOrder((p) => can(u, p)))
    .filter((u) => !only || only.includes(u.id))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'ar'));
  if (people.length === 0) return [];
  const open = await db.order.groupBy({
    by: ['winbackListUserId'],
    where: { ...scope, winbackListUserId: { in: people.map((u) => u.id) }, confirmationStatus: { in: ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'] } },
    _count: { _all: true },
  });
  const openOf = new Map(open.map((g) => [g.winbackListUserId as string, g._count._all]));
  return people.map((u) => ({ id: u.id, name: u.name ?? '—', listOpen: openOf.get(u.id) ?? 0 }));
}
