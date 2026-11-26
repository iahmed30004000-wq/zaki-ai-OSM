import { describe, expect, it } from 'vitest';
import { BULK_MAX, planBulk, toCandidate, type BulkCandidate } from './winback-bulk';
import { parseWinbackPrices } from './winback-prices';
import type { CustomerVerdict } from './winback-customer';

/**
 * THE BULK PLAN (F12, the owner's ruling 25/11) — pure: who gets which order, what is skipped and why. The counts are written by hand.
 * Every order is offered at the 3-piece option; the lists are outside the hand, so no agent is ever «full».
 */

const PRICES = parseWinbackPrices({
  scar: { one: 12, three: 20, currency: 'USD' },
  fungus: { one: 12, three: 20, currency: 'USD' },
  kamaa: { one: 10, three: 20, currency: 'USD' },
});
const cand = (i: number, over: Partial<BulkCandidate> = {}): BulkCandidate => ({
  orderId: `o${i}`,
  orderNumber: `ORD-${i}`,
  customerId: `c${i}`,
  currency: 'USD',
  lines: [{ productId: 'scar', quantity: 3, freeQuantity: 0 }],
  oldCost: 6,
  unitCost: 2,
  ...over,
});
const none = new Map<string, CustomerVerdict>();
const plan = (candidates: BulkCandidate[], extra: Partial<Parameters<typeof planBulk>[0]> = {}) =>
  planBulk({ candidates, count: 200, agents: [{ id: 'sara' }, { id: 'huda' }], customers: none, liveCustomers: new Set(), prices: PRICES, ...extra });

describe('the even split, outside the hand limit', () => {
  it('200 orders to two agents: 100 and 100, and no customer twice', () => {
    // 260 candidates, newest first; every fifth one is a second order of an earlier customer
    const candidates = Array.from({ length: 260 }, (_, i) => cand(i, { customerId: i % 5 === 4 ? `c${i - 1}` : `c${i}` }));
    const p = plan(candidates);
    expect(p.planned).toHaveLength(200);
    expect(p.perAgent).toEqual({ sara: 100, huda: 100 });
    const customers = p.planned.map((r) => candidates.find((c) => c.orderId === r.orderId)!.customerId);
    expect(new Set(customers).size).toBe(200);
    expect(p.skipped.SAME_CUSTOMER).toBeGreaterThan(0);
  });

  it('no agent is «full»: the plan takes no room, no cap — the agents carry only an id', () => {
    const p = planBulk({ candidates: Array.from({ length: 200 }, (_, i) => cand(i)), count: 200, agents: [{ id: 'sara' }], customers: none, liveCustomers: new Set(), prices: PRICES });
    expect(p.perAgent).toEqual({ sara: 200 });
    expect(Object.keys(p.skipped)).toEqual([]);
  });

  it('newest first, dealt in turn: the first goes to the first agent picked', () => {
    const p = plan([cand(1), cand(2), cand(3)]);
    expect(p.planned.map((r) => [r.orderId, r.agentId])).toEqual([
      ['o1', 'sara'],
      ['o2', 'huda'],
      ['o3', 'sara'],
    ]);
  });

  it('the newest order of a customer is the one kept', () => {
    const p = plan([cand(1, { customerId: 'x' }), cand(2, { customerId: 'x' })]);
    expect(p.planned.map((r) => r.orderId)).toEqual(['o1']);
    expect(p.skippedRows).toEqual([{ orderId: 'o2', orderNumber: 'ORD-2', code: 'SAME_CUSTOMER' }]);
  });

  it('the count is capped at the bulk max whatever is asked', () => {
    const candidates = Array.from({ length: 400 }, (_, i) => cand(i));
    expect(plan(candidates, { count: 10_000 }).planned).toHaveLength(BULK_MAX);
    expect(BULK_MAX).toBe(200);
    expect(plan(candidates, { count: 7 }).planned).toHaveLength(7);
  });
});

describe('the price: always the 3-piece option, whatever the old quantity (the owner, 25/11)', () => {
  it('2-piece and 6-piece old orders are offered at 3 pieces and the triple price; the old quantity rides along as information', () => {
    const p = plan([
      cand(1, { lines: [{ productId: 'scar', quantity: 2, freeQuantity: 0 }] }),
      cand(2, { lines: [{ productId: 'fungus', quantity: 6, freeQuantity: 0 }] }),
      cand(3, { lines: [{ productId: 'kamaa', quantity: 1, freeQuantity: 0 }] }),
    ]);
    expect(p.planned.map((r) => [r.orderId, r.pieces, r.price, r.oldPieces])).toEqual([
      ['o1', 3, 20, 2],
      ['o2', 3, 20, 6],
      ['o3', 3, 20, 1],
    ]);
    expect(Object.keys(p.skipped)).toEqual([]);
  });
});

describe('what is skipped, and why', () => {
  it('a customer who cancelled twice and took nothing since', () => {
    const customers = new Map<string, CustomerVerdict>([['c1', { eligible: false, code: 'CUSTOMER_CANCELLED_TWICE', reason: 'x' }]]);
    const p = plan([cand(1), cand(2)], { customers });
    expect(p.planned.map((r) => r.orderId)).toEqual(['o2']);
    expect(p.skipped).toEqual({ CUSTOMER_CANCELLED_TWICE: 1 });
  });

  it('a customer with a live order (the duplicate guard)', () => {
    const p = plan([cand(1), cand(2)], { liveCustomers: new Set(['c2']) });
    expect(p.planned.map((r) => r.orderId)).toEqual(['o1']);
    expect(p.skipped).toEqual({ CUSTOMER_HAS_LIVE_ORDER: 1 });
  });

  it('a product with no win-back price, two products, another currency — each counted', () => {
    const p = plan([
      cand(1, { lines: [{ productId: 'soap', quantity: 1, freeQuantity: 0 }] }),
      cand(2, { lines: [{ productId: 'scar', quantity: 1, freeQuantity: 0 }, { productId: 'fungus', quantity: 1, freeQuantity: 0 }] }),
      cand(3, { currency: 'SYP' }),
      cand(4),
    ]);
    expect(p.planned.map((r) => r.orderId)).toEqual(['o4']);
    expect(p.skipped).toEqual({ NO_WINBACK_PRICE: 1, MIXED_PRODUCTS: 1, CURRENCY_MISMATCH: 1 });
  });

  it('a price below what the three pieces cost is not offered (pending the coordinator)', () => {
    const p = plan([cand(1, { unitCost: 6.67 }), cand(2, { unitCost: 6.66 })]);
    expect(p.planned.map((r) => r.orderId)).toEqual(['o2']);
    expect(p.skippedRows).toEqual([{ orderId: 'o1', orderNumber: 'ORD-1', code: 'PRICE_BELOW_COST' }]);
  });

  it('no agent picked: nothing planned', () => {
    expect(plan([cand(1)], { agents: [] }).planned).toEqual([]);
  });
});

describe('a cancelled order is read as its goods', () => {
  it('its own lines when it has some, else its product columns', () => {
    const base = { id: 'o', orderNumber: 'N', customerId: 'c', currency: 'USD', productId: 'scar', quantity: 3, freeQuantity: 1, estimatedCostOfGoods: 9 };
    expect(toCandidate({ ...base, items: [] })).toMatchObject({ oldCost: 9, lines: [{ productId: 'scar', quantity: 3, freeQuantity: 1 }] });
    expect(toCandidate({ ...base, items: [{ productId: 'fungus', quantity: 1, freeQuantity: null }] }).lines).toEqual([{ productId: 'fungus', quantity: 1, freeQuantity: 0 }]);
  });
});
