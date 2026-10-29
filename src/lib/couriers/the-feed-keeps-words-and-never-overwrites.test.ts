import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CourierEvent } from './types';

/**
 * TWO PROMISES OF THE ONE GATE (RV144 and the Basha critique).
 *
 *   1. A courier's word that decides money — «تم التوصيل», «رجع», «ألغي» — or that a delivery failed («مؤجلة») is KEPT
 *      as a line on the order and never written as a status.
 *   2. A move is written only if the order is still in the status it was read in: a late poll answer cannot walk back
 *      what the door or a statement wrote in between.
 */

const { tx, db } = vi.hoisted(() => {
  const tx = {
    order: { updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderChangeRequest: { updateMany: vi.fn() },
  };
  return {
    tx,
    db: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      orderActivity: { findFirst: vi.fn(), create: vi.fn() },
    },
  };
});
vi.mock('../db', () => ({ db }));

import { applyCourierEvent } from './apply-event';
import { courierSaidTitle } from './courier-said';

const ev = (status: CourierEvent['status'], over: Partial<CourierEvent> = {}): CourierEvent => ({
  trackingNumber: 'KSA1', rawStatus: 'RAW', occurredAt: new Date(), status, ...over,
});
const target = (shippingStatus: string) => ({ id: 'o1', companyId: 'c1', shippingStatus });
const apply = (shippingStatus: string, event: CourierEvent, source: 'POLL' | 'WEBHOOK' = 'POLL') =>
  applyCourierEvent({ order: target(shippingStatus), event, courierName: 'الباشا', source });

beforeEach(() => {
  vi.clearAllMocks();
  tx.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderActivity.findFirst.mockResolvedValue(null);
});

describe('a word that decides money is kept, not written', () => {
  it.each(['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED', 'CANCELLED'] as const)('%s: one line on the order, no status written', async (status) => {
    const out = await apply('OUT_FOR_DELIVERY', ev(status, { rawStatus: 'DELIVERED_TO_RECIPIENT', note: 'تم التوصيل' }));
    expect(out).toBe('NOT_AUTO_APPLICABLE');
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderActivity.create).toHaveBeenCalledOnce();
    const row = db.orderActivity.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ companyId: 'c1', orderId: 'o1', userId: null, action: 'COURIER_SAID', previousStatus: 'OUT_FOR_DELIVERY' });
    expect(JSON.parse(row.metadata)).toMatchObject({ courier: 'الباشا', rawStatus: 'DELIVERED_TO_RECIPIENT', courierSaid: 'تم التوصيل', via: 'POLL' });
  });

  it('«مؤجلة» (mapped to FAILED_DELIVERY) is kept as a word, and the order stays where it is', async () => {
    const out = await apply('OUT_FOR_DELIVERY', ev('FAILED_DELIVERY', { rawStatus: 'POSTPONED_DELIVERY', note: 'مؤجلة' }));
    expect(out).toBe('NOT_AUTO_APPLICABLE');
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(JSON.parse(db.orderActivity.create.mock.calls[0][0].data.metadata).courierSaid).toBe('مؤجلة');
  });

  it('with no note from the company the word is ours for that status', async () => {
    await apply('OUT_FOR_DELIVERY', ev('DELIVERED', { note: null }));
    expect(JSON.parse(db.orderActivity.create.mock.calls[0][0].data.metadata).courierSaid).toBe('مسلَّم');
  });

  it('NEGATIVE: the same word again is not a second line', async () => {
    db.orderActivity.findFirst.mockResolvedValue({ newStatus: 'DELIVERED', metadata: JSON.stringify({ rawStatus: 'DELIVERED_TO_RECIPIENT' }) });
    await apply('OUT_FOR_DELIVERY', ev('DELIVERED', { rawStatus: 'DELIVERED_TO_RECIPIENT' }));
    expect(db.orderActivity.create).not.toHaveBeenCalled();
  });

  it('a different word after it is a new line', async () => {
    db.orderActivity.findFirst.mockResolvedValue({ newStatus: 'FAILED_DELIVERY', metadata: JSON.stringify({ rawStatus: 'POSTPONED_DELIVERY' }) });
    await apply('OUT_FOR_DELIVERY', ev('DELIVERED', { rawStatus: 'DELIVERED_TO_RECIPIENT' }));
    expect(db.orderActivity.create).toHaveBeenCalledOnce();
  });

  it('NEGATIVE: a word that agrees with the order’s own status says nothing new', async () => {
    await apply('FAILED_DELIVERY', ev('FAILED_DELIVERY', { rawStatus: 'POSTPONED_DELIVERY' }));
    expect(db.orderActivity.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a code we do not know is not kept as anything', async () => {
    expect(await apply('OUT_FOR_DELIVERY', ev(null))).toBe('UNKNOWN_STATUS');
    expect(db.orderActivity.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a note that cannot be written never stops the sweep', async () => {
    db.orderActivity.create.mockRejectedValue(new Error('db down'));
    await expect(apply('OUT_FOR_DELIVERY', ev('DELIVERED'))).resolves.toBe('NOT_AUTO_APPLICABLE');
  });

  it('NEGATIVE: the allowed in-transit moves are still written as before', async () => {
    expect(await apply('SHIPPED', ev('OUT_FOR_DELIVERY'))).toBe('APPLIED');
    expect(db.orderActivity.create).not.toHaveBeenCalled(); // the note path stayed out of it
    expect(tx.orderActivity.create).toHaveBeenCalledOnce();
  });

  it('the line reads as a sentence on the timeline, from a stored JSON string', () => {
    const title = courierSaidTitle(JSON.stringify({ courierSaid: 'تم التوصيل' }));
    expect(title).toContain('«تم التوصيل»');
    expect(title).toContain('لم تتغيّر حالة الطلب');
    expect(courierSaidTitle('not json')).toContain('لا تغيّر حالة الطلب');
    expect(courierSaidTitle(null)).toContain('لا تغيّر حالة الطلب');
  });
});

describe('a move is written only where nothing moved under it', () => {
  it('asks the database to change the order only while it is still in the status that was read', async () => {
    await apply('SHIPPED', ev('OUT_FOR_DELIVERY'));
    expect(tx.order.updateMany.mock.calls[0][0].where).toEqual({ id: 'o1', shippingStatus: 'SHIPPED' });
  });

  it('NEGATIVE: the door delivered it in between — nothing is written, no activity, no review flag', async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    const out = await apply('SHIPPED', ev('OUT_FOR_DELIVERY'));
    expect(out).toBe('NO_CHANGE');
    expect(tx.orderActivity.create).not.toHaveBeenCalled();
    expect(tx.orderChangeRequest.updateMany).not.toHaveBeenCalled();
  });
});
