import { describe, expect, it } from 'vitest';
import { BULK_MAX, planBulk, toCandidate, type BulkCandidate } from './winback-bulk';
import { parseWinbackPrices } from './winback-prices';
import type { CustomerVerdict } from './winback-customer';

/**
 * THE BULK PLAN (F12) — pure: who gets which order, what is skipped and why. The counts are written by hand.
 */

const PRICES = parseWinbackPrices({ scar: { one: 12, three: 20, currency: 'USD' }, fungus: { one: 12, three: 20, currency: 'USD' } });
const cand = (i: number, over: Partial<BulkCandidate> = {}): BulkCandidate => ({
  orderId: `o${i}`,
  orderNumber: `ORD-${i}`,
  customerId: `c${i}`,
  currency: 'USD',
  paid: 45,
  lines: [{ productId: 'scar', quantity: 3, freeQuantity: 0 }],
  cost: 5,
  ...over,
});
const none = new Map<string, CustomerVerdict>();
const plan = (candidates: BulkCandidate[], extra: Partial<Parameters<typeof planBulk>[0]> = {}) =>
  planBulk({ candidates, count: 200, agents: [{ id: 'sara', room: 500 }, { id: 'huda', room: 500 }], customers: none, liveCustomers: new Set(), prices: PRICES, ...extra });

describe('the even split', () => {
  it('200 orders to two agents: 100 and 100, and no customer twice', () => {
    // 260 candidates, newest first; every fifth one is a second order of an earlier customer
    const candidates = Array.from({ length: 260 }, (_, i) => cand(i, { customerId: i % 5 === 4 ? `c${i - 1}` : `c${i}` }));
    const p = plan(candidates);
    expect(p.planned).toHaveLength(200);
    expect(p.perAgent).toEqual({ sara: 100, huda: 100 });
    expect(p.planned.filter((r) => r.agentId === 'sara')).toHaveLength(100);
    const customers = p.planned.map((r) => candidates.find((c) => c.orderId === r.orderId)!.customerId);
    expect(new Set(customers).size).toBe(200);
    expect(p.skipped.SAME_CUSTOMER).toBeGreaterThan(0);
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

  it('a product with no win-back price, two products, another currency', () => {
    const p = plan([
      cand(1, { lines: [{ productId: 'soap', quantity: 1, freeQuantity: 0 }] }),
      cand(2, { lines: [{ productId: 'scar', quantity: 1, freeQuantity: 0 }, { productId: 'fungus', quantity: 1, freeQuantity: 0 }] }),
      cand(3, { currency: 'SYP' }),
      cand(4),
    ]);
    expect(p.planned.map((r) => r.orderId)).toEqual(['o4']);
    expect(p.skipped).toEqual({ NO_WINBACK_PRICE: 1, MIXED_PRODUCTS: 1, CURRENCY_MISMATCH: 1 });
  });

  it('a price above what the order cost is no win-back', () => {
    const p = plan([cand(1, { paid: 19.99 }), cand(2, { paid: 20 })]);
    expect(p.planned.map((r) => [r.orderId, r.price])).toEqual([['o2', 20]]);
    expect(p.skipped).toEqual({ PRICE_NOT_LOWER: 1 });
  });

  it('PENDING THE OWNER: more than three pieces (paid + free) is not offered, by its own reason', () => {
    const p = plan([cand(1, { lines: [{ productId: 'scar', quantity: 4, freeQuantity: 0 }] }), cand(2, { lines: [{ productId: 'scar', quantity: 3, freeQuantity: 1 }] }), cand(3)]);
    expect(p.planned.map((r) => r.orderId)).toEqual(['o3']);
    expect(p.skipped).toEqual({ TOO_MANY_PIECES: 2 });
  });

  it('a price below the cost the new order will carry is not offered', () => {
    const p = plan([cand(1, { cost: 20.01 }), cand(2, { cost: 20 })]);
    expect(p.planned.map((r) => r.orderId)).toEqual(['o2']);
    expect(p.skippedRows).toEqual([{ orderId: 'o1', orderNumber: 'ORD-1', code: 'PRICE_BELOW_COST' }]);
  });

  it('the tier follows the pieces of the cancelled order', () => {
    const p = plan([cand(1, { lines: [{ productId: 'scar', quantity: 2, freeQuantity: 0 }] }), cand(2)]);
    expect(p.planned.map((r) => [r.tier, r.price])).toEqual([
      ['one', 12],
      ['three', 20],
    ]);
  });

  it('an agent with no room under her cap receives nothing; the other one does; when none has room, the rest wait', () => {
    const p = plan([cand(1), cand(2), cand(3), cand(4)], { agents: [{ id: 'sara', room: 0 }, { id: 'huda', room: 2 }] });
    expect(p.perAgent).toEqual({ sara: 0, huda: 2 });
    expect(p.skipped).toEqual({ NO_ROOM: 2 });
  });
});

describe('a cancelled order is read as the creator copies it', () => {
  it('its own lines when it has some, else its product columns; paid is the subtotal less the discount', () => {
    const base = { id: 'o', orderNumber: 'N', customerId: 'c', currency: 'USD', productId: 'scar', quantity: 3, freeQuantity: 1, sellingPrice: 45, discountAmount: 5, estimatedCostOfGoods: 7 };
    expect(toCandidate({ ...base, items: [] })).toMatchObject({ paid: 40, cost: 7, lines: [{ productId: 'scar', quantity: 3, freeQuantity: 1 }] });
    expect(toCandidate({ ...base, items: [{ productId: 'fungus', quantity: 1, freeQuantity: null }] }).lines).toEqual([{ productId: 'fungus', quantity: 1, freeQuantity: 0 }]);
  });
});
