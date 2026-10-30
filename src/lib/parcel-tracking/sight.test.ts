import { describe, expect, it } from 'vitest';
import {
  COLLECTION_STATUSES,
  FULL_SIGHT,
  MONEY_FIELDS,
  NO_SIGHT,
  RETURN_STATUSES,
  sightWhere,
  statesOffered,
  unseenKey,
  withoutMoney,
} from './sight';
import { SHIPPING_STATUSES } from './filters';

/**
 * THE TWO LEVELS OF THE FOLLOW-UP SCREEN, AS PURE RULES.
 * The door and the two screens read the same table; this is the table.
 */

const money = { ...NO_SIGHT, money: true };
const returns = { ...NO_SIGHT, returns: true };

describe('what a request may not ask for', () => {
  it('the collection states and the collect chip are the money level’s, and name «عرض التسويات»', () => {
    for (const status of COLLECTION_STATUSES) expect(unseenKey({ status, task: null }, NO_SIGHT), status).toBe('settlement.view');
    expect(unseenKey({ status: 'default', task: 'COLLECT' }, NO_SIGHT)).toBe('settlement.view');
    expect(unseenKey({ status: 'DELIVERED', task: null }, money)).toBeNull();
    expect(unseenKey({ status: 'default', task: 'COLLECT' }, money)).toBeNull();
  });

  it('the return states and the returning chip are the returns level’s, and name «عرض المرتجعات»', () => {
    for (const status of RETURN_STATUSES) expect(unseenKey({ status, task: null }, NO_SIGHT), status).toBe('ops.returns_view');
    expect(unseenKey({ status: 'default', task: 'RETURNING' }, NO_SIGHT)).toBe('ops.returns_view');
    expect(unseenKey({ status: 'RETURNED', task: null }, returns)).toBeNull();
    expect(unseenKey({ status: 'default', task: 'RETURNING' }, returns)).toBeNull();
  });

  it('one level does not open the other', () => {
    expect(unseenKey({ status: 'RETURNED', task: null }, money)).toBe('ops.returns_view');
    expect(unseenKey({ status: 'DELIVERED', task: null }, returns)).toBe('settlement.view');
  });

  it('the road is everybody’s: the default, every state, the other chips and the in-flight states are never refused', () => {
    for (const status of ['default', 'every', 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'CANCELLED'] as const) {
      expect(unseenKey({ status, task: null }, NO_SIGHT), status).toBeNull();
    }
    for (const task of ['LATE', 'NO_BARCODE', 'CANCELLED', 'CHANGED', 'FAILED', 'NOT_LATE']) {
      expect(unseenKey({ status: 'default', task }, NO_SIGHT), task).toBeNull();
    }
  });
});

describe('the rows the question to the database is narrowed to', () => {
  it('asks nothing extra of someone who sees everything', () => {
    expect(sightWhere(FULL_SIGHT)).toBeNull();
  });
  it('leaves out the delivered parcels, the returned ones, or both', () => {
    expect(sightWhere(NO_SIGHT)).toEqual({ shippingStatus: { notIn: ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] } });
    expect(sightWhere(money)).toEqual({ shippingStatus: { notIn: ['RETURN_REQUESTED', 'RETURNED'] } });
    expect(sightWhere(returns)).toEqual({ shippingStatus: { notIn: ['DELIVERED', 'PARTIALLY_DELIVERED'] } });
  });
});

describe('the figures', () => {
  const row = {
    id: 'a', totalAmount: 20, currency: 'USD', customer: { fullName: 'x' },
    collectionStatus: 'PENDING', settlementStatus: 'PENDING', collectedAmount: 1, expectedCollection: 2, deliveryFee: 3, priceIncludesDelivery: true,
  };
  it('are taken off the row, and the customer’s own sum is not one of them', () => {
    const out = withoutMoney(row);
    for (const f of MONEY_FIELDS) expect(out, f).not.toHaveProperty(f);
    expect(out).toEqual({ id: 'a', totalAmount: 20, currency: 'USD', customer: { fullName: 'x' } });
  });
  it('and the row it was given is left whole', () => {
    withoutMoney(row);
    expect(row.expectedCollection).toBe(2);
  });
});

describe('the dropdown offers only what the door would answer', () => {
  it('without either level: no delivered state and no return state', () => {
    const offered = statesOffered(SHIPPING_STATUSES, NO_SIGHT);
    for (const s of [...COLLECTION_STATUSES, ...RETURN_STATUSES]) expect(offered, s).not.toContain(s);
    expect(offered).toContain('SHIPPED');
    expect(offered).toContain('FAILED_DELIVERY');
  });
  it('with a level, its states come back', () => {
    expect(statesOffered(SHIPPING_STATUSES, money)).toEqual(expect.arrayContaining([...COLLECTION_STATUSES]));
    expect(statesOffered(SHIPPING_STATUSES, money)).not.toContain('RETURNED');
    expect(statesOffered(SHIPPING_STATUSES, returns)).toEqual(expect.arrayContaining([...RETURN_STATUSES]));
    expect(statesOffered(SHIPPING_STATUSES, FULL_SIGHT)).toEqual(SHIPPING_STATUSES);
  });
  it('every state it offers is one the door answers', () => {
    for (const sight of [NO_SIGHT, money, returns, FULL_SIGHT]) {
      for (const status of statesOffered(SHIPPING_STATUSES, sight)) expect(unseenKey({ status, task: null }, sight), status).toBeNull();
    }
  });
});
