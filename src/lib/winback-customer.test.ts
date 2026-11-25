import { describe, expect, it, vi } from 'vitest';
import { customerVerdict, customerWinbackVerdicts, type CustomerOrderFact } from './winback-customer';

/**
 * A CUSTOMER WHO SAID NO TWICE IS OUT — UNLESS HE CAME BACK BY HIMSELF AND TOOK A PARCEL (F12, the owner's amendment).
 * Every claim is a fact list written by hand, never one computed by the function under test.
 */

const D = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
const cancelled = (day: number, reason: string | null = 'PRICE_TOO_HIGH', lostDay: number | null = day): CustomerOrderFact => ({
  confirmationStatus: 'CANCELLED',
  rejectionReason: reason,
  shippingStatus: 'NOT_READY',
  replacesOrderId: null,
  createdAt: D(day),
  lostAt: lostDay === null ? null : D(lostDay),
});
const delivered = (day: number, replacesOrderId: string | null = null, shippingStatus = 'DELIVERED'): CustomerOrderFact => ({
  confirmationStatus: 'CONFIRMED',
  rejectionReason: null,
  shippingStatus,
  replacesOrderId,
  createdAt: D(day),
  lostAt: null,
});

describe('the customer rule', () => {
  it('one cancellation: he may be offered again', () => {
    expect(customerVerdict([cancelled(1)]).eligible).toBe(true);
  });

  it('two cancellations and no later delivery: excluded, in words', () => {
    const v = customerVerdict([cancelled(1), cancelled(5, 'CUSTOMER_CHANGED_MIND')]);
    expect(v).toEqual({ eligible: false, code: 'CUSTOMER_CANCELLED_TWICE', reason: expect.stringContaining('مرتين') });
  });

  it('the same customer after a delivered order he placed himself, AFTER the last cancellation: eligible again', () => {
    expect(customerVerdict([cancelled(1), cancelled(5), delivered(9)]).eligible).toBe(true);
    // a partial delivery is goods he took too
    expect(customerVerdict([cancelled(1), cancelled(5), delivered(9, null, 'PARTIALLY_DELIVERED')]).eligible).toBe(true);
  });

  it('a delivery BEFORE the last cancellation does not redeem him', () => {
    expect(customerVerdict([cancelled(1), delivered(3), cancelled(5)]).eligible).toBe(false);
  });

  it('a delivered WIN-BACK order is not «placed himself»', () => {
    expect(customerVerdict([cancelled(1), cancelled(5), delivered(9, 'some-cancelled-order')]).eligible).toBe(false);
  });

  it('«after» is after the LOST moment from the log, not the order’s creation', () => {
    // cancelled orders made on days 1 and 2, the second closed on day 10; a delivery made on day 6 is before that
    expect(customerVerdict([cancelled(1), cancelled(2, 'PRICE_TOO_HIGH', 10), delivered(6)]).eligible).toBe(false);
    // and without a log row the order's own creation is the moment
    expect(customerVerdict([cancelled(1, 'PRICE_TOO_HIGH', null), cancelled(2, 'PRICE_TOO_HIGH', null), delivered(6)]).eligible).toBe(true);
  });

  it('duplicate / test / wrong-number / entry-error closes are not «he cancelled», nor a close with no reason', () => {
    for (const r of ['DUPLICATE_ORDER', 'FAKE_ORDER', 'WRONG_NUMBER', 'MODERATOR_DATA_ERROR', null]) {
      expect(customerVerdict([cancelled(1), cancelled(5, r)]).eligible, String(r)).toBe(true);
    }
    // REJECTED is a cancellation as much as CANCELLED
    expect(customerVerdict([cancelled(1), { ...cancelled(5), confirmationStatus: 'REJECTED' }]).eligible).toBe(false);
    // and the no-answer closes count: they are the customer's silence
    expect(customerVerdict([cancelled(1, 'NO_ANSWER_3_ATTEMPTS'), cancelled(5, 'NO_ANSWER_5_ATTEMPTS')]).eligible).toBe(false);
  });
});

describe('the reader asks once, in the store, and a customer with nothing is eligible', () => {
  it('one query for any number of customers, scoped to the company and store', async () => {
    const findMany = vi.fn(async () => [
      { customerId: 'a', ...cancelled(1), statusLogs: [{ createdAt: D(1) }] },
      { customerId: 'a', ...cancelled(5), statusLogs: [{ createdAt: D(5) }] },
      { customerId: 'b', ...cancelled(1), statusLogs: [] },
    ]);
    const out = await customerWinbackVerdicts({ order: { findMany } } as never, { companyId: 'c1', storeId: 's1' }, ['a', 'b', 'c', 'a']);
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ companyId: 'c1', storeId: 's1', customerId: { in: ['a', 'b', 'c'] } });
    expect(out.get('a')?.eligible).toBe(false);
    expect(out.get('b')?.eligible).toBe(true);
    expect(out.get('c')?.eligible).toBe(true);
  });

  it('no customers, no query', async () => {
    const findMany = vi.fn();
    await customerWinbackVerdicts({ order: { findMany } } as never, { companyId: 'c1' }, []);
    expect(findMany).not.toHaveBeenCalled();
  });
});
