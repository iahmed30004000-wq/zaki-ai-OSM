import { describe, expect, it } from 'vitest';
import { DEFAULT_LATE_DAYS, lateChoices, lateFromUrl, ordersWhere, validLateDays } from './order-filters';
import { orderSummary, stateCounts } from './order-list-summary';

/**
 * «متأخرة» TAKES A NUMBER OF DAYS — and the old `?late=1` is still ten.
 * And the fold of the summary: one grouped answer becomes the chips, and the sums are the database's.
 */

describe('the address and the number of days', () => {
  it('`late=1` is every link written before the number could change: ten days', () => {
    expect(DEFAULT_LATE_DAYS).toBe('10');
    expect(lateFromUrl('1')).toBe('10');
  });

  it('a number the builder accepts is itself; anything else is no filter', () => {
    expect(lateFromUrl('7')).toBe('7');
    expect(lateFromUrl('14')).toBe('14');
    for (const bad of [null, '', 'abc', '0', '-3', '366', '7.5', '1e2', ' 7']) expect(lateFromUrl(bad), String(bad)).toBe('');
  });

  it('every choice the box offers is a number the builder accepts', () => {
    for (const d of lateChoices('')) {
      expect(validLateDays(d)).toBe(true);
      expect(ordersWhere(new URLSearchParams({ lateDays: d })).ok).toBe(true);
    }
    expect(lateChoices('')).toEqual(['3', '5', '7', '10', '14']);
    // A number a saved view brought in stays among the choices so the box can show it.
    expect(lateChoices('21')).toEqual(['3', '5', '7', '10', '14', '21']);
  });

  it('seven days cuts off on shipping seven days ago', () => {
    const built = ordersWhere(new URLSearchParams({ lateDays: '7' }));
    expect(built.ok).toBe(true);
    const cut = (built.ok ? (built.where.AND as { shippedAt?: { lte: Date } }[]) : []).find((c) => c.shippedAt)!.shippedAt!.lte;
    const days = (Date.now() - cut.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
  });
});

describe('the summary’s fold', () => {
  it('groups become states by the same derivation the rows are labelled with', () => {
    const { states, total } = stateCounts([
      { confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', claimedById: null, _count: { _all: 3 } },
      { confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', claimedById: 'u1', _count: { _all: 2 } },
      { confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', claimedById: 'u1', _count: { _all: 1 } },
      { confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', claimedById: 'u1', _count: { _all: 4 } },
      { confirmationStatus: 'CONFIRMED', shippingStatus: 'CANCELLED', claimedById: null, _count: { _all: 1 } },
    ]);
    const of = (s: string) => states.find((c) => c.state === s)?.count;
    expect(total).toBe(11);
    expect(of('NEW')).toBe(3);
    expect(of('CLAIMED')).toBe(3);
    expect(of('SHIPPED')).toBe(4);
    expect(of('CANCELLED')).toBe(1);
    expect(of('CONFIRMED')).toBe(0);
  });

  it('the cards are the database’s sums, rounded to the currency; nothing to average is null, not zero', () => {
    expect(orderSummary({ _count: { _all: 3 }, _sum: { totalAmount: 0.1 + 0.2 + 10 } }, { withProfit: false, minorUnit: 2 })).toEqual({
      orders: 3,
      value: 10.3,
      average: 3.43,
    });
  });

  it('the average is rounded to the minor unit too', () => {
    expect(orderSummary({ _count: { _all: 3 }, _sum: { totalAmount: 10 } }, { withProfit: false, minorUnit: 2 }).average).toBe(3.33);
    expect(orderSummary({ _count: { _all: 0 }, _sum: { totalAmount: null } }, { withProfit: false, minorUnit: 3 })).toEqual({
      orders: 0,
      value: 0,
      average: null,
    });
  });

  it('the profit only when asked for, with how many orders carried one (a Decimal arrives as a string-able object)', () => {
    const decimal = { toString: () => '12.345' };
    const with_ = orderSummary({ _count: { _all: 5, netProfit: 2 }, _sum: { totalAmount: 50, netProfit: decimal } }, { withProfit: true, minorUnit: 3 });
    expect(with_.profit).toEqual({ value: 12.345, orders: 2 });
    const without = orderSummary({ _count: { _all: 5 }, _sum: { totalAmount: 50 } }, { withProfit: false, minorUnit: 3 });
    expect('profit' in without).toBe(false);
  });
});
