import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CourierEvent } from './types';

/**
 * A parcel the poll moved to SHIPPED had no shippedAt — and «days in transit», the late threshold and the statement
 * sweep all read that column. The move now stamps its own timestamp when it is still empty, inside the same update.
 */

const tx = {
  order: { updateMany: vi.fn() },
  orderActivity: { create: vi.fn() },
  orderChangeRequest: { updateMany: vi.fn() },
};
vi.mock('../db', () => ({ db: { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } }));

import { applyCourierEvent } from './apply-event';

const event = (status: CourierEvent['status']): CourierEvent => ({ trackingNumber: 'B1', rawStatus: 'RAW', occurredAt: new Date(), status });
const data = () => tx.order.updateMany.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  // The compare-and-set write: one row changed, as it does when nothing moved under the poll.
  tx.order.updateMany.mockResolvedValue({ count: 1 });
});

describe('the status’s own time', () => {
  it('READY_FOR_PICKUP → SHIPPED with shippedAt empty stamps shippedAt', async () => {
    await applyCourierEvent({ order: { id: 'o1', companyId: 'c1', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null }, event: event('SHIPPED'), courierName: 'الباشا', source: 'POLL' });
    expect(data().shippedAt).toBeInstanceOf(Date);
  });

  it('NEGATIVE: an existing shippedAt is never overwritten', async () => {
    const when = new Date('2026-10-01');
    await applyCourierEvent({ order: { id: 'o1', companyId: 'c1', shippingStatus: 'READY_FOR_PICKUP', shippedAt: when }, event: event('SHIPPED'), courierName: 'الباشا', source: 'POLL' });
    expect('shippedAt' in data()).toBe(false);
  });

  it('NEGATIVE: a caller that did not read the column leaves it alone', async () => {
    await applyCourierEvent({ order: { id: 'o1', companyId: 'c1', shippingStatus: 'READY_FOR_PICKUP' }, event: event('SHIPPED'), courierName: 'الباشا', source: 'WEBHOOK' });
    expect('shippedAt' in data()).toBe(false);
  });

  it('out for delivery stamps its own time', async () => {
    await applyCourierEvent({ order: { id: 'o1', companyId: 'c1', shippingStatus: 'SHIPPED', outForDeliveryAt: null }, event: event('OUT_FOR_DELIVERY'), courierName: 'الباشا', source: 'POLL' });
    expect(data().outForDeliveryAt).toBeInstanceOf(Date);
  });

  // WAS: 'out for delivery and a failed attempt stamp theirs' (a polled FAILED_DELIVERY wrote failedAt).
  // NOW: a feed never writes FAILED — see apply-event NOTE_ONLY and the-feed-keeps-words-and-never-overwrites.test.ts.
  it('NEGATIVE: a failed attempt is NOT written by a feed, so it stamps nothing', async () => {
    const out = await applyCourierEvent({ order: { id: 'o1', companyId: 'c1', shippingStatus: 'OUT_FOR_DELIVERY', failedAt: null }, event: event('FAILED_DELIVERY'), courierName: 'الباشا', source: 'POLL' });
    expect(out).toBe('NOT_AUTO_APPLICABLE');
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a money status is still not applied by a feed — nothing is written', async () => {
    const out = await applyCourierEvent({ order: { id: 'o1', companyId: 'c1', shippingStatus: 'OUT_FOR_DELIVERY', shippedAt: null }, event: event('DELIVERED'), courierName: 'الباشا', source: 'POLL' });
    expect(out).toBe('NOT_AUTO_APPLICABLE');
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
});
