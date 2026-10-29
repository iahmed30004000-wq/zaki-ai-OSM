import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyCourierEvent } from './apply-event';
import type { CourierEvent } from './types';

vi.mock('../db', () => {
  const tx = {
    order: { updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderChangeRequest: { updateMany: vi.fn() },
  };
  return {
    db: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});

const { db } = (await import('../db')) as unknown as {
  db: {
    $transaction: ReturnType<typeof vi.fn>;
    __tx: {
      order: { updateMany: ReturnType<typeof vi.fn> };
      orderActivity: { create: ReturnType<typeof vi.fn> };
      orderChangeRequest: { updateMany: ReturnType<typeof vi.fn> };
    };
  };
};

const order = { id: 'o1', companyId: 'c1', shippingStatus: 'SHIPPED' };
const event = (over: Partial<CourierEvent> = {}): CourierEvent => ({
  trackingNumber: 'BC-1',
  rawStatus: 'RAW',
  occurredAt: new Date(),
  status: 'OUT_FOR_DELIVERY',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // The compare-and-set write: one row changed, as it does when nothing moved under the poll.
  db.__tx.order.updateMany.mockResolvedValue({ count: 1 });
});

describe('applyCourierEvent — the one gate both the poll and the webhook pass', () => {
  it('applies a status the courier is allowed to assert', async () => {
    const out = await applyCourierEvent({ order, event: event(), courierName: 'باشا', source: 'POLL' });
    expect(out).toBe('APPLIED');
    expect(db.__tx.order.updateMany).toHaveBeenCalledOnce();
  });

  it('records HOW it learned, so a push and a poll are told apart', async () => {
    await applyCourierEvent({ order, event: event(), courierName: 'باشا', source: 'WEBHOOK' });
    const meta = JSON.parse(db.__tx.orderActivity.create.mock.calls[0][0].data.metadata);
    expect(meta.source).toBe('WEBHOOK');
  });

  // The rule that protects money. A courier feed saying DELIVERED would make
  // commission accrue and cash become expected, on a string nobody checked.
  it.each(['DELIVERED', 'RETURNED', 'PARTIALLY_DELIVERED', 'CANCELLED'] as const)(
    'refuses %s from a courier feed, however it arrived',
    async (status) => {
      const out = await applyCourierEvent({
        order,
        event: event({ status }),
        courierName: 'باشا',
        source: 'WEBHOOK',
      });
      expect(out).toBe('NOT_AUTO_APPLICABLE');
      expect(db.__tx.order.updateMany).not.toHaveBeenCalled();
    }
  );

  it('ignores a status the courier repeats — a retried push writes nothing twice', async () => {
    const out = await applyCourierEvent({
      order,
      event: event({ status: 'SHIPPED' }),
      courierName: 'باشا',
      source: 'WEBHOOK',
    });
    expect(out).toBe('NO_CHANGE');
    expect(db.__tx.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a code it does not recognise rather than guessing', async () => {
    const out = await applyCourierEvent({
      order,
      event: event({ status: null }),
      courierName: 'باشا',
      source: 'WEBHOOK',
    });
    expect(out).toBe('UNKNOWN_STATUS');
    expect(db.__tx.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a move the transition machine forbids (delivered → shipped)', async () => {
    const out = await applyCourierEvent({
      order: { ...order, shippingStatus: 'DELIVERED' },
      event: event({ status: 'OUT_FOR_DELIVERY' }),
      courierName: 'باشا',
      source: 'WEBHOOK',
    });
    expect(out).toBe('INVALID_TRANSITION');
    expect(db.__tx.order.updateMany).not.toHaveBeenCalled();
  });

  /**
   * CONTRACT INVARIANT 7, second half. A feed is never blocked by a change
   * request — it tells on itself instead, so whoever decides the request
   * knows the order moved under her.
   */
  describe('and it flags a request that was under review while it moved', () => {
    it('flags every PENDING request on that order', async () => {
      await applyCourierEvent({ order, event: event(), courierName: 'باشا', source: 'WEBHOOK' });
      const call = db.__tx.orderChangeRequest.updateMany.mock.calls[0][0];
      expect(call.data).toEqual({ changedDuringReview: true });
      expect(call.where.orderId).toBe('o1');
      expect(call.where.status).toBe('PENDING');
      // Not `blocking: true`. A non-blocking request is the one that did NOT
      // stop the pipeline, so it is the likelier to be overtaken.
      expect(call.where.blocking).toBeUndefined();
      // Already-flagged rows are excluded so a later event cannot bump
      // `updatedAt` and reorder a human's worklist.
      expect(call.where.changedDuringReview).toBe(false);
    });

    it('and does not flag anything when the parcel did not move', async () => {
      for (const ev of [event({ status: 'SHIPPED' }), event({ status: null }), event({ status: 'DELIVERED' })]) {
        await applyCourierEvent({ order, event: ev, courierName: 'باشا', source: 'WEBHOOK' });
      }
      expect(db.__tx.orderChangeRequest.updateMany).not.toHaveBeenCalled();
    });

    it('and never reads a change request as a gate — the feed is not blocked', async () => {
      // There is no `findFirst` on the mock at all: if the implementation
      // ever reached for one to decide whether to proceed, this throws.
      const out = await applyCourierEvent({ order, event: event(), courierName: 'باشا', source: 'WEBHOOK' });
      expect(out).toBe('APPLIED');
    });
  });
});
