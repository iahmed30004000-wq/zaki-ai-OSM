import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE STATUS POLL: ITS TRIAL SWITCH, AND WHY IT CALLS A COURIER UNAVAILABLE (RV146).
 *
 * The real job, the real adapter, a stubbed network — no call to any company. `COURIER_POLL_DRY_RUN=1` asks, runs
 * every guard and writes ONLY the job's own sentence. And when the first ten barcodes all fail, the courier is skipped,
 * named WITH the reason the error class gives, and nothing is counted missing, stamped or shouted.
 */

const { db, applyCourierEvent, recordMiss, clearMiss, createNotification } = vi.hoisted(() => ({
  db: { deliveryProvider: { findMany: vi.fn() }, order: { findMany: vi.fn() }, $executeRaw: vi.fn(async () => 1) },
  applyCourierEvent: vi.fn(async (_input: unknown) => 'APPLIED'),
  recordMiss: vi.fn(async (_db: unknown, _order: unknown) => ({ alertNow: true })),
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
process.env.APP_ENCRYPTION_KEY = 'e'.repeat(64);

import { encryptJson } from '../secrets';
import { courierPollIsDryRun, syncCourierStatus } from './definitions/sync-courier-status';
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
const parcels = (n: number) => Array.from({ length: n }, (_, i) => parcel(i + 1));

const asked: string[] = [];
const answerWith = (respond: (barcode: string) => Response | Promise<Response>) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const barcode = new URL(url).searchParams.get('barcode') ?? '';
    asked.push(barcode);
    return respond(barcode);
  }));
const statusOk = () => new Response(JSON.stringify({ status: 'SCANNED_BY_DRIVER_AND_IN_CAR' }));

beforeEach(() => {
  vi.clearAllMocks();
  asked.length = 0;
  db.deliveryProvider.findMany.mockResolvedValue([BASHA]);
  db.$executeRaw.mockResolvedValue(1);
  applyCourierEvent.mockResolvedValue('APPLIED');
  recordMiss.mockResolvedValue({ alertNow: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
process.on('exit', () => {
  process.env.APP_ENCRYPTION_KEY = ENV;
});

describe('the switch', () => {
  it.each(['1', 'true', 'TRUE', ' 1 '])('%j turns the trial on', (v) => {
    expect(courierPollIsDryRun({ COURIER_POLL_DRY_RUN: v } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
  it.each([undefined, '', '0', 'false', 'no', 'yes', '2'])('NEGATIVE: %j leaves the real sweep on', (v) => {
    expect(courierPollIsDryRun({ COURIER_POLL_DRY_RUN: v } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('a trial sweep', () => {
  it('asks, runs the guards, and writes only its sentence — no status, no stamp, no miss, no alert', async () => {
    vi.stubEnv('COURIER_POLL_DRY_RUN', '1');
    // KSA2 is unknown to the company; KSA3 was already counted missing once and now answers.
    db.order.findMany.mockResolvedValue([parcel(1), parcel(2), parcel(3, { trackingMissCount: 2 })]);
    answerWith((b) => (b === 'KSA2' ? new Response('not found', { status: 404 }) : statusOk()));

    const result = await syncCourierStatus.run(ctx);

    expect(asked.sort()).toEqual(['KSA1', 'KSA2', 'KSA3']);
    // Every parcel went through the one gate, told not to write.
    expect(applyCourierEvent).toHaveBeenCalledTimes(2);
    for (const c of applyCourierEvent.mock.calls) expect(c[0]).toMatchObject({ dryRun: true, source: 'POLL' });
    // Nothing else is written, anywhere.
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(recordMiss).not.toHaveBeenCalled();
    expect(clearMiss).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    // And it says what it saw.
    expect(result.processed).toBe(0);
    expect(result.detail).toContain('تجربة بلا كتابة: كان سيُحدَّث 2 شحنة');
    expect(result.detail).toContain('ORD-1: مشحون ← خرج للتوصيل');
    expect(result.detail).toContain('1 شحنة لم تردّ عنها الشركة');
  });

  it('NEGATIVE: the same sweep without the switch writes the stamp, the miss, the clear and the alert', async () => {
    db.order.findMany.mockResolvedValue([parcel(1), parcel(2), parcel(3, { trackingMissCount: 2 })]);
    answerWith((b) => (b === 'KSA2' ? new Response('not found', { status: 404 }) : statusOk()));

    const result = await syncCourierStatus.run(ctx);

    for (const c of applyCourierEvent.mock.calls) expect(c[0]).toMatchObject({ dryRun: false });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(recordMiss).toHaveBeenCalledTimes(1);
    expect(clearMiss).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(2);
    expect(result.detail).not.toContain('تجربة');
  });

  it('a trial that finds the courier down still says so (and still writes nothing)', async () => {
    vi.stubEnv('COURIER_POLL_DRY_RUN', 'true');
    db.order.findMany.mockResolvedValue(parcels(12));
    answerWith(() => new Response('down', { status: 503 }));
    await expect(syncCourierStatus.run(ctx)).rejects.toThrow(/تعذّر الوصول إلى الباشا \(لا تردّ\).*تجربة بلا كتابة/);
    expect(recordMiss).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('the first ten fail: the courier is unavailable, and the sentence says why', () => {
  it.each([
    [404, /غير موجود/],
    [503, /لا تردّ/],
    [403, /رفضت الطلب أو الحساب/],
  ] as const)('HTTP %i on every barcode', async (status, why) => {
    db.order.findMany.mockResolvedValue(parcels(30));
    answerWith(() => new Response('x', { status }));

    await expect(syncCourierStatus.run(ctx)).rejects.toThrow(why);
    await expect(syncCourierStatus.run(ctx)).rejects.toThrow(/تعذّر الوصول إلى الباشا/);

    // Not thirty lost parcels: nothing counted, nothing stamped, nothing shouted; the rest were not even asked.
    expect(recordMiss).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(applyCourierEvent).not.toHaveBeenCalled();
    expect(asked.length).toBe(20); // ten per run, two runs
  });

  it('no network at all reads «لا تردّ»', async () => {
    db.order.findMany.mockResolvedValue(parcels(5));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(syncCourierStatus.run(ctx)).rejects.toThrow(/\(لا تردّ\)/);
    expect(recordMiss).not.toHaveBeenCalled();
  });

  it('NEGATIVE: 404 on SOME of the first ten is still a miss for those parcels — the company is there', async () => {
    db.order.findMany.mockResolvedValue(parcels(5));
    answerWith((b) => (b === 'KSA2' || b === 'KSA4' ? new Response('nf', { status: 404 }) : statusOk()));
    const result = await syncCourierStatus.run(ctx);
    expect(recordMiss).toHaveBeenCalledTimes(2);
    expect(applyCourierEvent).toHaveBeenCalledTimes(3);
    expect(result.detail).toContain('2 شحنة مفقودة عند الشركة');
    // And, having been asked, they are stamped.
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
