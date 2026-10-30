import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE TRIAL SWITCH OF THE STATUS POLL (RV146 / B1's dry-run).
 *
 * `applyCourierEvent({ dryRun: true })` runs every guard the real call runs and says what it WOULD do, and writes
 * nothing: no status, no stamp, no activity row, no flag on a change request, no «قالت الشركة» note. The same events
 * without the switch write, so the switch is the only difference (the NEGATIVE half of every case).
 */

const { db, tx } = vi.hoisted(() => {
  const tx = {
    order: { updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderChangeRequest: { updateMany: vi.fn() },
  };
  return {
    tx,
    db: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      orderActivity: { findFirst: vi.fn(async () => null), create: vi.fn() },
      order: { update: vi.fn(), updateMany: vi.fn() },
    },
  };
});
vi.mock('../db', () => ({ db }));

import { applyCourierEvent } from './apply-event';
import type { CourierEvent } from './types';

const order = { id: 'o1', companyId: 'c1', shippingStatus: 'SHIPPED', shippedAt: null, outForDeliveryAt: null, failedAt: null };
const event = (over: Partial<CourierEvent> = {}): CourierEvent => ({
  trackingNumber: 'BC-1', rawStatus: 'RAW', occurredAt: new Date(), status: 'OUT_FOR_DELIVERY', ...over,
});
const call = (e: CourierEvent, dryRun?: boolean, o: typeof order = order) =>
  applyCourierEvent({ order: o, event: e, courierName: 'الباشا', source: 'POLL', dryRun });

/** Every write the module has, anywhere. */
const writes = () => [
  db.$transaction, tx.order.updateMany, tx.orderActivity.create, tx.orderChangeRequest.updateMany,
  db.orderActivity.create, db.order.update, db.order.updateMany,
];

beforeEach(() => {
  vi.clearAllMocks();
  tx.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderActivity.findFirst.mockResolvedValue(null);
});

describe('a trial computes and writes nothing', () => {
  it('a move that WOULD be applied is answered APPLIED, with no write of any kind', async () => {
    expect(await call(event(), true)).toBe('APPLIED');
    for (const w of writes()) expect(w).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the very same event without the switch writes the status, the row and the flag', async () => {
    expect(await call(event())).toBe('APPLIED');
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.orderActivity.create).toHaveBeenCalledTimes(1);
    expect(tx.orderChangeRequest.updateMany).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: dryRun false is the real thing, like leaving it out', async () => {
    expect(await call(event(), false)).toBe('APPLIED');
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it('a status only a human may write is answered NOT_AUTO_APPLICABLE and leaves no «قالت الشركة» note', async () => {
    expect(await call(event({ status: 'FAILED_DELIVERY' }), true)).toBe('NOT_AUTO_APPLICABLE');
    expect(await call(event({ status: 'DELIVERED' }), true)).toBe('NOT_AUTO_APPLICABLE');
    for (const w of writes()) expect(w).not.toHaveBeenCalled();
    expect(db.orderActivity.findFirst).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the same word without the switch IS kept as a note', async () => {
    expect(await call(event({ status: 'FAILED_DELIVERY' }))).toBe('NOT_AUTO_APPLICABLE');
    expect(db.orderActivity.create).toHaveBeenCalledTimes(1);
  });

  it('the guards still answer in a trial: unknown status, no change, an illegal move', async () => {
    expect(await call(event({ status: null }), true)).toBe('UNKNOWN_STATUS');
    expect(await call(event({ status: 'SHIPPED' }), true)).toBe('NO_CHANGE');
    // READY_FOR_PICKUP is not a legal move from SHIPPED.
    expect(await call(event({ status: 'READY_FOR_PICKUP' }), true)).toBe('INVALID_TRANSITION');
    for (const w of writes()) expect(w).not.toHaveBeenCalled();
  });
});
