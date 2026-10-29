import { describe, expect, it, vi } from 'vitest';
import { countOutcomes, OUTCOME_CLOSED, OUTCOME_LABEL_AR, OUTCOMES, orderOutcome, type OutcomeSource } from './order-outcome';
import { closingStages } from './order-closing';
import { mapLegacyStatus } from '../../scripts/migration/lib/legacy-map.mjs';

/**
 * The owner's vocabulary (21/10), read off the stored fields. Two promises:
 * every legacy status lands on the words he chose, and «= مغلق» is said
 * exactly where the «مغلق» filter says closed — never one without the other.
 */

const fromLegacy = (statusId: number): OutcomeSource => {
  const m = mapLegacyStatus(statusId);
  return {
    confirmationStatus: m.confirmationStatus,
    shippingStatus: m.shippingStatus,
    settlementStatus: m.settlementStatus,
    rejectionReason: m.rejectionReason,
    returnReceipt: m.returnReceipt ? { courierFeeCharged: false } : null,
  };
};

describe('every legacy status reads in the owner\'s words', () => {
  const ruled: [number, string][] = [
    [2, 'مؤكد وتم شحنه'],
    [4, 'مرتجع بدون رسوم = مغلق'],
    [5, 'تم الاستلام + تم التحصيل = مغلق'],
    [6, 'ملغي قبل الشحن'],
    [8, 'مؤجل'],
    [9, 'ملغي مكرر'],
    [12, 'تم الاستلام + تم التحصيل = مغلق'],
    [13, 'مرتجع بدون رسوم = مغلق'],
    [15, 'ملغي قبل الشحن'],
    [16, 'ملغي قبل الشحن'],
  ];
  for (const [id, words] of ruled) {
    it(`${id} → «${words}»`, () => {
      expect(OUTCOME_LABEL_AR[orderOutcome(fromLegacy(id))]).toBe(words);
    });
  }
});

describe('«= مغلق» is said exactly where the «مغلق» filter says closed', () => {
  const confirmations = ['NEW', 'IN_PROGRESS', 'CONFIRMED', 'POSTPONED', 'REJECTED', 'CANCELLED'];
  const shippings = ['NOT_READY', 'PACKING', 'READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'];
  const settlements = ['NOT_APPLICABLE', 'PENDING', 'COLLECTED', 'SETTLED', 'CANCELLED'];
  const receipts = [null, { courierFeeCharged: false }, { courierFeeCharged: true }];

  it('over every combination of the columns it reads', () => {
    let checked = 0;
    for (const confirmationStatus of confirmations)
      for (const shippingStatus of shippings)
        for (const settlementStatus of settlements)
          for (const returnReceipt of receipts) {
            const o = { confirmationStatus, shippingStatus, settlementStatus, returnReceipt };
            const outcome = orderOutcome(o);
            const closed = closingStages({ shippingStatus, settlementStatus, returnReceived: Boolean(returnReceipt), confirmationStatus }).closed;
            expect(OUTCOME_CLOSED[outcome], JSON.stringify(o)).toBe(closed);
            expect(OUTCOME_LABEL_AR[outcome].endsWith('= مغلق') || outcome.startsWith('CANCELLED')).toBe(OUTCOME_CLOSED[outcome]);
            checked++;
          }
    expect(checked).toBe(confirmations.length * shippings.length * settlements.length * receipts.length);
  });

  it('a delivered order whose money is still out is NOT closed', () => {
    expect(orderOutcome({ confirmationStatus: 'CONFIRMED', shippingStatus: 'DELIVERED', settlementStatus: 'COLLECTED' })).toBe('DELIVERED_AWAITING_CASH');
  });

  it('a return the desk has not counted is NOT closed', () => {
    expect(orderOutcome({ confirmationStatus: 'CONFIRMED', shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE', returnReceipt: null })).toBe('RETURN_AWAITING');
  });

  it('a return the courier charged for says so', () => {
    expect(orderOutcome({ confirmationStatus: 'CONFIRMED', shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE', returnReceipt: { courierFeeCharged: true } })).toBe('RETURNED_FEE_CLOSED');
  });

  it('refused at confirmation is cancelled before shipping, and finished', () => {
    const o = { confirmationStatus: 'REJECTED', shippingStatus: 'NOT_READY', settlementStatus: 'NOT_APPLICABLE' };
    expect(orderOutcome(o)).toBe('CANCELLED_BEFORE_SHIPPING');
    expect(OUTCOME_CLOSED[orderOutcome(o)]).toBe(true);
  });

  it('a new order that has not shipped is still being worked, not closed', () => {
    const o = { confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', settlementStatus: 'NOT_APPLICABLE' };
    expect(orderOutcome(o)).toBe('BEING_WORKED');
    expect(OUTCOME_CLOSED.BEING_WORKED).toBe(false);
  });
});

describe('the dashboard\'s counts add up to every order', () => {
  it('splits the receipt-dependent groups and loses nobody', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { confirmationStatus: 'CONFIRMED', shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED', rejectionReason: null, _count: { _all: 10 } },
      { confirmationStatus: 'CONFIRMED', shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE', rejectionReason: null, _count: { _all: 7 } },
      { confirmationStatus: 'CONFIRMED', shippingStatus: 'CANCELLED', settlementStatus: 'CANCELLED', rejectionReason: 'DUPLICATE_ORDER', _count: { _all: 2 } },
      { confirmationStatus: 'POSTPONED', shippingStatus: 'NOT_READY', settlementStatus: 'NOT_APPLICABLE', rejectionReason: null, _count: { _all: 1 } },
    ]);
    // of the 7 returned: 4 counted with no fee, 1 with a fee, 2 not counted yet
    // (the dashboard now also asks «how many of those say nothing came back» — none of these do)
    const count = vi.fn(async ({ where }: any) => (where.returnReceipt.is.receivedQty === 0 ? 0 : where.returnReceipt.is.courierFeeCharged ? 1 : 4));
    const r = await countOutcomes({ order: { groupBy, count } }, { companyId: 'c1', storeId: 's1' });
    const by = Object.fromEntries(r.outcomes.map((x) => [x.key, x.count]));
    expect(r.total).toBe(20);
    expect(r.outcomes.reduce((s, x) => s + x.count, 0)).toBe(20);
    expect(by).toEqual({ DELIVERED_CLOSED: 10, RETURNED_NO_FEE_CLOSED: 4, RETURNED_FEE_CLOSED: 1, RETURN_AWAITING: 2, CANCELLED_DUPLICATE: 2, POSTPONED: 1 });
    // scoped to the store, over all time — no date in the query
    expect(groupBy.mock.calls[0][0].where).toEqual({ companyId: 'c1', storeId: 's1' });
  });

  it('lists outcomes in one fixed order, so the card does not reshuffle', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { confirmationStatus: 'POSTPONED', shippingStatus: 'NOT_READY', settlementStatus: 'NOT_APPLICABLE', rejectionReason: null, _count: { _all: 1 } },
      { confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', settlementStatus: 'PENDING', rejectionReason: null, _count: { _all: 3 } },
    ]);
    const r = await countOutcomes({ order: { groupBy, count: vi.fn() } }, { companyId: 'c1' });
    expect(r.outcomes.map((x) => x.key)).toEqual(OUTCOMES.filter((k) => k === 'SHIPPED' || k === 'POSTPONED'));
  });
});

describe('a parcel written off as lost reads «مفقود بعد الشحن — خسارة = مغلق»', () => {
  const returned = { confirmationStatus: 'CONFIRMED', shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE' };
  const receipt = (over: Partial<NonNullable<OutcomeSource['returnReceipt']>> = {}) => ({
    courierFeeCharged: false, receivedQty: 0, damagedQty: 0, missingQty: 4, ...over,
  });

  it('is read from the receipt\'s shape: nothing received, nothing damaged, some missing, no fee', () => {
    const outcome = orderOutcome({ ...returned, returnReceipt: receipt() });
    expect(outcome).toBe('LOST_AFTER_SHIPPING_CLOSED');
    expect(OUTCOME_LABEL_AR[outcome]).toBe('مفقود بعد الشحن — خسارة = مغلق');
    expect(OUTCOME_CLOSED[outcome]).toBe(true);
  });

  it('is said for a parcel still marked as waiting for its return, once the receipt is there', () => {
    expect(orderOutcome({ ...returned, shippingStatus: 'RETURN_REQUESTED', returnReceipt: receipt() })).toBe('LOST_AFTER_SHIPPING_CLOSED');
  });

  it('NEGATIVE: one unit received, or one broken, is a return that came back', () => {
    expect(orderOutcome({ ...returned, returnReceipt: receipt({ receivedQty: 1, missingQty: 3 }) })).toBe('RETURNED_NO_FEE_CLOSED');
    expect(orderOutcome({ ...returned, returnReceipt: receipt({ damagedQty: 1, missingQty: 3 }) })).toBe('RETURNED_NO_FEE_CLOSED');
  });

  it('NEGATIVE: a receipt that expected nothing (missing 0) is not a loss', () => {
    expect(orderOutcome({ ...returned, returnReceipt: receipt({ missingQty: 0 }) })).toBe('RETURNED_NO_FEE_CLOSED');
  });

  it('NEGATIVE: a courier fee charged keeps its own word — the fee is money, the shape is not', () => {
    expect(orderOutcome({ ...returned, returnReceipt: receipt({ courierFeeCharged: true }) })).toBe('RETURNED_FEE_CLOSED');
  });

  it('NEGATIVE: a caller that did not select the counts reads exactly what it read before', () => {
    expect(orderOutcome({ ...returned, returnReceipt: { courierFeeCharged: false } })).toBe('RETURNED_NO_FEE_CLOSED');
  });

  it('NEGATIVE: with no receipt it is still a return nobody has counted — the word that holds the order OPEN', () => {
    expect(orderOutcome({ ...returned, returnReceipt: null })).toBe('RETURN_AWAITING');
    expect(OUTCOME_CLOSED.RETURN_AWAITING).toBe(false);
  });

  it('the dashboard counts it apart, and the outcomes still add up to every order', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { confirmationStatus: 'CONFIRMED', shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE', rejectionReason: null, _count: { _all: 9 } },
    ]);
    // of the 9: 3 written off, 2 counted with no fee, 1 with a fee, 3 not counted yet
    const count = vi.fn(async ({ where }: any) => {
      const is = where.returnReceipt.is;
      if (is.receivedQty === 0) return 3;
      return is.courierFeeCharged ? 1 : 5; // «no fee» includes the 3 written off
    });
    const r = await countOutcomes({ order: { groupBy, count } }, { companyId: 'c1', storeId: 's1' });
    const by = Object.fromEntries(r.outcomes.map((x) => [x.key, x.count]));
    expect(by).toEqual({ LOST_AFTER_SHIPPING_CLOSED: 3, RETURNED_NO_FEE_CLOSED: 2, RETURNED_FEE_CLOSED: 1, RETURN_AWAITING: 3 });
    expect(r.outcomes.reduce((s, x) => s + x.count, 0)).toBe(r.total);
    expect(r.outcomes.find((x) => x.key === 'LOST_AFTER_SHIPPING_CLOSED')).toMatchObject({ closed: true, label: 'مفقود بعد الشحن — خسارة = مغلق' });
  });
});
