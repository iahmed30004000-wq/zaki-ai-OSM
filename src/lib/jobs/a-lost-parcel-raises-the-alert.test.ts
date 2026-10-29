import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «شحنة مفقودة عند شركة الشحن» — THE ALERT HAD NO TEST (Q6).
 *
 * The status job counts a barcode the courier does not answer for (`recordMiss`), and on the miss that crosses the line
 * (`alertNow`) it tells whoever may track parcels, once, with a link that finds the parcel. These run the real job with
 * the real adapter against a stubbed network, and `recordMiss` answering in turn as it does after three sweeps.
 */

const { db, applyCourierEvent, recordMiss, clearMiss, createNotification } = vi.hoisted(() => ({
  db: { deliveryProvider: { findMany: vi.fn() }, order: { findMany: vi.fn() } },
  applyCourierEvent: vi.fn(async (_input: unknown) => 'NO_CHANGE'),
  recordMiss: vi.fn(async (_db: unknown, _order: unknown) => ({ alertNow: false })),
  clearMiss: vi.fn(async (_db: unknown, _order: unknown) => undefined),
  createNotification: vi.fn(async (_n: unknown) => undefined),
}));

vi.mock('../db', () => ({ db }));
vi.mock('../couriers/apply-event', () => ({ applyCourierEvent }));
vi.mock('../couriers/missing-shipment', () => ({ recordMiss, clearMiss, missingHours: () => 7 }));
vi.mock('../notification', () => ({ createNotification }));
vi.mock('../outbound-limit', () => ({
  limitFor: () => ({ perSecond: 1000 }),
  paced: async <T, R>(_k: string, _l: unknown, items: T[], fn: (t: T) => Promise<R>) => Promise.all(items.map(fn)),
}));

const ENV = process.env.APP_ENCRYPTION_KEY;
process.env.APP_ENCRYPTION_KEY = 'd'.repeat(64);

import { encryptJson } from '../secrets';
import { forgetCourierPollCursor, syncCourierStatus } from './definitions';
import type { JobContext } from './runner';

const ctx = { now: new Date(), db } as unknown as JobContext;
const account = encryptJson({
  email: 'shop@example.com', password: 'test-password', companyId: 744, originCityId: 445053,
  senderName: 'متجر', senderPhone: '0999000000',
});
const BASHA = { id: 'p1', code: 'BASHA', name: 'الباشا', apiEnabled: true, companyId: 'c1', adapterCode: 'LOGESTECHS', apiConfig: {}, apiCredentials: account };

const parcel = (n: number, over: Record<string, unknown> = {}) => ({
  id: `o${n}`, trackingNumber: `KSA${n}`, shippingStatus: 'SHIPPED', companyId: 'c1', storeId: 's1', orderNumber: `ORD-${n}`,
  trackingMissCount: 0, trackingMissingSince: null, trackingMissingAlertedAt: null,
  shippedAt: null, outForDeliveryAt: null, failedAt: null, ...over,
});

/** The courier answers every barcode except the ones named, which it does not know. */
const knowsAllBut = (unknown: string[]) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const barcode = new URL(url).searchParams.get('barcode') ?? '';
    return unknown.includes(barcode)
      ? new Response('not found', { status: 404 })
      : new Response(JSON.stringify({ status: 'MOVED_TO_SHELF_AND_OUT_OF_HANDLER_CUSTODY' }));
  }));

beforeEach(() => {
  vi.clearAllMocks();
  forgetCourierPollCursor();
  db.deliveryProvider.findMany.mockResolvedValue([BASHA]);
});
afterEach(() => vi.unstubAllGlobals());
process.on('exit', () => {
  process.env.APP_ENCRYPTION_KEY = ENV;
});

describe('a parcel the courier does not know', () => {
  it('on the miss that crosses the line: one alert, to those who track parcels, with a link that finds it', async () => {
    db.order.findMany.mockResolvedValue([parcel(1), parcel(2), parcel(3)]);
    knowsAllBut(['KSA2']);
    recordMiss.mockResolvedValue({ alertNow: true });

    const result = await syncCourierStatus.run(ctx);

    expect(recordMiss).toHaveBeenCalledTimes(1);
    expect((recordMiss.mock.calls[0][1] as { orderNumber: string }).orderNumber).toBe('ORD-2');
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({
      companyId: 'c1', storeId: 's1', audience: { permission: 'ops.track' }, type: 'SYSTEM_ALERT',
      title: 'شحنة مفقودة عند شركة الشحن', link: '/ops/tracking?order=ORD-2',
    });
    const message = (createNotification.mock.calls[0][0] as { message: string }).message;
    expect(message).toContain('الطلب ORD-2');
    expect(message).toContain('KSA2');
    expect(message).toContain('الباشا');
    expect(message).toContain('7 ساعة');
    expect(result.detail).toContain('1 شحنة مفقودة عند الشركة');
  });

  it('NEGATIVE: a miss that has not yet crossed the line is counted, not shouted', async () => {
    db.order.findMany.mockResolvedValue([parcel(1), parcel(2), parcel(3)]);
    knowsAllBut(['KSA2']);
    recordMiss.mockResolvedValue({ alertNow: false });

    const result = await syncCourierStatus.run(ctx);

    expect(recordMiss).toHaveBeenCalledTimes(1);
    expect(createNotification).not.toHaveBeenCalled();
    expect(result.detail).not.toContain('مفقودة');
  });

  it('NEGATIVE: parcels the courier answers for are never counted as missing', async () => {
    db.order.findMany.mockResolvedValue([parcel(1), parcel(2), parcel(3)]);
    knowsAllBut([]);
    await syncCourierStatus.run(ctx);
    expect(recordMiss).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('a parcel that was missing and answers again has its count cleared — a second disappearance is a new alert', async () => {
    db.order.findMany.mockResolvedValue([
      parcel(1, { trackingMissCount: 2 }), parcel(2, { trackingMissingAlertedAt: new Date('2026-10-20') }), parcel(3),
    ]);
    knowsAllBut([]);
    await syncCourierStatus.run(ctx);
    expect(clearMiss).toHaveBeenCalledTimes(2);
    expect(clearMiss.mock.calls.map((c) => (c[1] as { orderNumber: string }).orderNumber).sort()).toEqual(['ORD-1', 'ORD-2']);
  });
});
