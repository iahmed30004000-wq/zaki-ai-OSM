import type { Prisma } from '@prisma/client';
import { db } from './db';
import { can } from './authorization';
import { resolveAudience } from './notification-audience';
import { capRoom, mayBeHandedAnOrder, ownedCounts, returnsLimits, returnsModeOn } from './confirmation-queue';
import { confirmationRuleOnce } from './confirmation-rule-settings';
import { confirmationRulesOnce } from './employee-numbers';
import { deriveCoreState, getZone } from './order-state';
import { LOST_STATUSES } from './winback';
import { DELIVERED_STATUSES, type CustomerVerdict } from './winback-customer';
import { winbackPriceFor, type WinbackPrices } from './winback-prices';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «وزّع على الموظفات» — A MANAGER OFFERS MANY CANCELLED ORDERS AGAIN AT ONCE, AND HANDS THEM OUT.
 *
 * The amendment: reuse, do not rebuild. Every new order is made by the ONE win-back creator (`POST /api/confirmation/winback`'s, in its
 * own file — this module makes no order), at the owner's win-back price (`winback-prices.ts`), and is then HELD for an agent through the
 * hold that already exists (`order-reservation.ts`: `assignedToId` on an order nobody holds — the same write the returning-customer job
 * makes). The cancelled order is never touched: the creator links the new one to it (`replacesOrderId`, unique — the database itself
 * refuses a second offer on one cancelled order, even from two managers pressing at once).
 *
 * THIS FILE: the pure plan (who gets which, what is skipped and why), the reads it needs, and the hold. In order:
 *
 *   1. the candidates — the «ready» view of the pool (the same filter as the list), narrowed by the manager's filters, NEWEST first;
 *   2. per candidate, in that order: one per customer · the customer may be rung (`winback-customer.ts`) · he has no live order (the
 *      duplicate guard) · one product with a win-back price in the order's currency, not above what the order cost;
 *   3. dealt round-robin to the agents picked — even split — each only up to her room under her cap (`capRoom`, the same room the
 *      returning-customer hold reads): the cap is not changed, and an agent with no room left receives nothing more.
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
  'TOO_MANY_PIECES',
  'PRICE_NOT_LOWER',
  'PRICE_BELOW_COST',
  'NO_ROOM',
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
  TOO_MANY_PIECES: 'الطلب فيه أكتر من 3 قطع (ما بينعرض لحد ما يقرر المالك)',
  PRICE_NOT_LOWER: 'سعر الاسترجاع أعلى من سعر الطلب الأصلي',
  PRICE_BELOW_COST: 'سعر الاسترجاع أقل من تكلفة البضاعة',
  NO_ROOM: 'الموظفات وصلوا الحد (طلبات بإيدهن ومحجوزة إلهن)',
};

export interface BulkCandidate {
  orderId: string;
  orderNumber: string;
  customerId: string;
  currency: string;
  /** What the cancelled order cost the customer: its subtotal less the discount already on it. */
  paid: number;
  lines: Array<{ productId: string; quantity: number; freeQuantity: number }>;
  /** What the new order's goods will cost — the cost the creator copies (the owner's fixed figures when every line has one, else the cancelled order's). */
  cost: number;
}

export interface PlannedRow {
  orderId: string;
  orderNumber: string;
  agentId: string;
  price: number;
  tier: 'one' | 'three';
}

export interface BulkPlan {
  planned: PlannedRow[];
  skipped: Partial<Record<SkipCode, number>>;
  /** Each skipped candidate and why — the run reports it on its row. */
  skippedRows: Array<{ orderId: string; orderNumber: string; code: SkipCode }>;
  perAgent: Record<string, number>;
}

/**
 * THE PLAN — pure. `candidates` newest first; `agents` in the order picked, each with her room; `count` already capped by the caller
 * (it is capped here again). Nothing here reads a clock or a database.
 */
export function planBulk(input: {
  candidates: readonly BulkCandidate[];
  count: number;
  agents: ReadonlyArray<{ id: string; room: number }>;
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
  const room = input.agents.map((a) => ({ id: a.id, left: Math.max(0, Math.floor(a.room)) }));
  const perAgent: Record<string, number> = Object.fromEntries(input.agents.map((a) => [a.id, 0]));
  const planned: PlannedRow[] = [];
  const seen = new Set<string>();
  let turn = 0;

  for (const c of input.candidates) {
    if (planned.length >= want) break;
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
    if (price.price > c.paid) {
      skip('PRICE_NOT_LOWER');
      continue;
    }
    // Never below what the goods cost: a win-back sold at a loss is not one.
    if (price.price < c.cost) {
      skip('PRICE_BELOW_COST');
      continue;
    }
    // Round-robin over the agents who still have room: the next one in turn, skipping a full one.
    let agent: (typeof room)[number] | undefined;
    for (let k = 0; k < room.length; k++) {
      const a = room[(turn + k) % room.length];
      if (a.left > 0) {
        agent = a;
        turn = (turn + k + 1) % room.length;
        break;
      }
    }
    if (!agent) {
      skip('NO_ROOM');
      continue;
    }
    agent.left -= 1;
    perAgent[agent.id] = (perAgent[agent.id] ?? 0) + 1;
    planned.push({ orderId: c.orderId, orderNumber: c.orderNumber, agentId: agent.id, price: price.price, tier: price.tier });
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
  sellingPrice: number | null;
  discountAmount: number | null;
  estimatedCostOfGoods: number | null;
  items: Array<{ productId: string; quantity: number; freeQuantity: number | null }>;
};

/** A cancelled order as the plan reads it — its goods exactly as the creator copies them (its own lines, else its product columns). */
export function toCandidate(o: OrderRow): BulkCandidate {
  const lines = o.items.length
    ? o.items.map((l) => ({ productId: l.productId, quantity: l.quantity, freeQuantity: l.freeQuantity ?? 0 }))
    : [{ productId: o.productId, quantity: o.quantity ?? 1, freeQuantity: o.freeQuantity ?? 0 }];
  return {
    orderId: o.id,
    orderNumber: o.orderNumber,
    customerId: o.customerId,
    currency: o.currency,
    paid: Number(o.sellingPrice ?? 0) - Number(o.discountAmount ?? 0),
    lines,
    cost: Number(o.estimatedCostOfGoods ?? 0),
  };
}

export const CANDIDATE_SELECT = {
  id: true,
  orderNumber: true,
  customerId: true,
  currency: true,
  productId: true,
  quantity: true,
  freeQuantity: true,
  sellingPrice: true,
  discountAmount: true,
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
  /** How many more orders may carry her name — in her hands or held for her — under her cap. */
  room: number;
}

/**
 * WHO MAY RECEIVE ONE — the agents of this store who may pull (`confirmation.pull`) and work an order handed to them (`mayBeHandedAnOrder`,
 * the transfer's question), each with her room under the cap read the way the returning-customer hold reads it (the hand limit when
 * «الطلب يرجع للطابور فوراً» is on). The cap is read, never changed.
 */
export async function bulkAgents(scope: { companyId: string; storeId: string }, now: Date = new Date(), only?: readonly string[]): Promise<BulkAgent[]> {
  const audience = await resolveAudience({ companyId: scope.companyId, storeId: scope.storeId, audience: { permission: 'confirmation.pull' } });
  const people = audience
    .filter((u) => mayBeHandedAnOrder((p) => can(u, p)))
    .filter((u) => !only || only.includes(u.id))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'ar'));
  if (people.length === 0) return [];
  const modeOn = await returnsModeOn(db, scope.companyId);
  const rule = confirmationRuleOnce(db, scope.companyId, now.getTime());
  const rules = confirmationRulesOnce(db, scope.companyId, now.getTime());
  const out: BulkAgent[] = [];
  for (const u of people) {
    const limit = modeOn ? (await returnsLimits(db, scope.companyId, now.getTime(), rule, { userId: u.id, storeId: scope.storeId, rules })).handLimit : undefined;
    out.push({ id: u.id, name: u.name ?? '—', room: capRoom(await ownedCounts(db, scope, u.id, now), limit) });
  }
  return out;
}

/**
 * HOLD THE NEW ORDER FOR HER — the hold that exists (`order-reservation.ts`): her name on an order nobody holds, written only if it is
 * STILL unclaimed and unnamed (one conditional write), and one activity line saying why. Nothing else: no claim, no message, no stock.
 */
export async function holdForAgent(input: { companyId: string; orderId: string; agentId: string; byUserId: string; now: Date }): Promise<boolean> {
  const won = await db.order.updateMany({
    where: { id: input.orderId, companyId: input.companyId, claimedById: null, assignedToId: null, confirmationStatus: 'NEW' },
    data: { assignedToId: input.agentId, assignedAt: input.now, version: { increment: 1 } },
  });
  if (won.count !== 1) return false;
  await db.orderActivity.create({
    data: {
      companyId: input.companyId,
      orderId: input.orderId,
      // The manager who pressed — a person, not the scheduler (the returning-customer hold writes null).
      userId: input.byUserId,
      action: 'HELD_FOR_AGENT',
      metadata: JSON.stringify({ agentId: input.agentId, reason: 'WINBACK_BULK' }),
    },
  });
  return true;
}
