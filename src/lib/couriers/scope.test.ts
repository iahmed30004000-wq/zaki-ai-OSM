import { describe, it, expect } from 'vitest';
import {
  courierScope,
  courierBelongsToStore,
  isCourierInUse,
  describeUsage,
  type CourierUsage,
} from './scope';

const none: CourierUsage = { orders: 0, batches: 0, statements: 0, fees: 0, attempts: 0 };

describe('which couriers a store may use', () => {
  it('offers the store ONLY its own — there is no shared courier', () => {
    expect(courierScope('c1', 's1')).toEqual({ companyId: 'c1', storeId: 's1' });
  });

  // The dangerous default: a missing store used to mean "the whole company",
  // so an unscoped call quietly received every store's couriers.
  it('offers NOTHING when no store is in context', () => {
    expect(courierScope('c1', null)).toEqual({ companyId: 'c1', id: { in: [] } });
    expect(courierScope('c1', undefined)).toEqual({ companyId: 'c1', id: { in: [] } });
    expect(courierScope('c1', '')).toEqual({ companyId: 'c1', id: { in: [] } });
  });

  it('never drops the company, whatever the store', () => {
    for (const store of ['s1', null, undefined, '']) {
      expect(courierScope('c1', store).companyId).toBe('c1');
    }
  });
});

describe('the guard that holds when the API is called directly', () => {
  it('lets a store use its own courier', () => {
    expect(courierBelongsToStore({ companyId: 'c1', storeId: 's1' }, 'c1', 's1')).toBe(true);
  });

  // Not placed yet is allowed NOWHERE, not everywhere. A row nobody owns
  // being usable by everybody is the leak this whole change exists to close.
  it('refuses one that has not been placed in a store', () => {
    expect(courierBelongsToStore({ companyId: 'c1', storeId: null }, 'c1', 's9')).toBe(false);
    expect(courierBelongsToStore({ companyId: 'c1' }, 'c1', 's9')).toBe(false);
  });

  // The one that matters: another store's account would create the parcel
  // under another store's login, and the money comes back to their books.
  it("REFUSES another store's courier", () => {
    expect(courierBelongsToStore({ companyId: 'c1', storeId: 's2' }, 'c1', 's1')).toBe(false);
  });

  it("REFUSES another company's courier outright", () => {
    expect(courierBelongsToStore({ companyId: 'c2', storeId: null }, 'c1', 's1')).toBe(false);
  });

  it('refuses a store-owned courier when no store is in context', () => {
    expect(courierBelongsToStore({ companyId: 'c1', storeId: 's1' }, 'c1', null)).toBe(false);
  });
});

describe('what stops a courier being deleted', () => {
  it('nothing referencing it — a row added by mistake can go', () => {
    expect(isCourierInUse(none)).toBe(false);
  });

  // The bug this replaces: the check counted ORDERS only, so a courier with
  // no orders and fourteen fee rows was hard-deleted, cascading them away.
  it.each([
    ['orders', { ...none, orders: 1 }],
    ['batches', { ...none, batches: 1 }],
    ['statements', { ...none, statements: 1 }],
    ['fees', { ...none, fees: 14 }],
    ['attempts', { ...none, attempts: 1 }],
  ])('%s alone keeps it', (_label, usage) => {
    expect(isCourierInUse(usage as CourierUsage)).toBe(true);
  });

  it('says in Arabic what is holding it', () => {
    const said = describeUsage({ orders: 151, batches: 5, statements: 1, fees: 14, attempts: 0 });
    expect(said).toBe('151 طلب · 5 دفعة شحن · 1 كشف · 14 أجرة توصيل');
    // nothing that is zero gets mentioned
    expect(said).not.toContain('محاولة');
  });
});
