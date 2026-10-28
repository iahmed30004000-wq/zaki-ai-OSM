import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «الغي الويب هوك وخليك API… الـ API أسرع، بيرجّع الحالات والباركود بسرعة».
 *
 * The status job asked every courier with `apiEnabled` — but read only {id, code, name, apiEnabled, companyId}.
 * «الباشا» is code BASHA on the LogesTechs platform (adapterCode LOGESTECHS) with its account encrypted on its row,
 * so `adapterFor` keyed on BASHA, handed back the manual adapter, and the courier was skipped on every sweep. These
 * run the REAL adapterFor with a stored account, against a stubbed network.
 */

const { db, applyCourierEvent, recordMiss, clearMiss, createNotification } = vi.hoisted(() => ({
  db: { deliveryProvider: { findMany: vi.fn() }, order: { findMany: vi.fn() } },
  applyCourierEvent: vi.fn(async (_input: unknown) => 'APPLIED'),
  recordMiss: vi.fn(async () => ({ alertNow: false })),
  clearMiss: vi.fn(async () => undefined),
  createNotification: vi.fn(async () => undefined),
}));

vi.mock('../db', () => ({ db }));
vi.mock('../couriers/apply-event', () => ({ applyCourierEvent }));
vi.mock('../couriers/missing-shipment', () => ({ recordMiss, clearMiss, missingHours: () => 1 }));
vi.mock('../notification', () => ({ createNotification }));
// Pace without waiting: the limiter is not what these test.
vi.mock('../outbound-limit', () => ({
  limitFor: () => ({ perSecond: 1000 }),
  paced: async <T, R>(_k: string, _l: unknown, items: T[], fn: (t: T) => Promise<R>) => Promise.all(items.map(fn)),
}));

const ENV = process.env.APP_ENCRYPTION_KEY;
process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64);

import { encryptJson } from '../secrets';
import { forgetCourierPollCursor, POLL_BATCH, syncCourierStatus } from './definitions';
import type { JobContext } from './runner';

const ctx = { now: new Date(), db } as unknown as JobContext;

const account = encryptJson({
  email: 'shop@example.com', password: 'test-password', companyId: 744, originCityId: 445053,
  senderName: 'متجر', senderPhone: '0999000000',
});
const BASHA = { id: 'p1', code: 'BASHA', name: 'الباشا', apiEnabled: true, companyId: 'c1', adapterCode: 'LOGESTECHS', apiConfig: {}, apiCredentials: account };

const parcel = (n: number) => ({
  id: `o${String(n).padStart(4, '0')}`, trackingNumber: `KSA${n}`, shippingStatus: 'READY_FOR_PICKUP', companyId: 'c1', storeId: 's1',
  orderNumber: `ORD-${n}`, trackingMissCount: 0, trackingMissingSince: null, trackingMissingAlertedAt: null,
  shippedAt: null, outForDeliveryAt: null, failedAt: null,
});

/** The order table, answering the job's cursor query the way Postgres would. */
function ordersTable(rows: ReturnType<typeof parcel>[]) {
  db.order.findMany.mockImplementation(async (q: { where: { id?: { gt: string } }; take: number }) => {
    const after = q.where.id?.gt;
    return rows.filter((r) => !after || r.id > after).slice(0, q.take);
  });
}

const asked: string[] = [];
const answer = (body: (barcode: string) => unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const barcode = new URL(url).searchParams.get('barcode') ?? '';
    asked.push(barcode);
    return new Response(JSON.stringify(body(barcode)), { status });
  }));

beforeEach(() => {
  vi.clearAllMocks();
  asked.length = 0;
  forgetCourierPollCursor();
  db.deliveryProvider.findMany.mockResolvedValue([BASHA]);
});
afterEach(() => vi.unstubAllGlobals());
process.on('exit', () => {
  process.env.APP_ENCRYPTION_KEY = ENV;
});

describe('Basha is asked at all', () => {
  it('the courier is read WITH its platform and its account — the line that kept it manual', async () => {
    ordersTable([]);
    answer(() => ({}));
    await syncCourierStatus.run(ctx);
    const select = db.deliveryProvider.findMany.mock.calls[0][0].select;
    expect(select).toMatchObject({ adapterCode: true, apiConfig: true, apiCredentials: true });
  });

  it('asks their status endpoint for each barcode, and hands the answer to the one gate as a poll', async () => {
    ordersTable([parcel(1), parcel(2)]);
    answer(() => ({ status: 'MOVED_TO_SHELF_AND_OUT_OF_HANDLER_CUSTODY' }));
    const result = await syncCourierStatus.run(ctx);
    expect(asked.sort()).toEqual(['KSA1', 'KSA2']);
    expect(applyCourierEvent).toHaveBeenCalledTimes(2);
    const call = applyCourierEvent.mock.calls[0][0] as unknown as { source: string; event: { status: string }; order: { shippedAt: unknown } };
    expect(call.source).toBe('POLL');
    expect(call.event.status).toBe('SHIPPED');
    // The timestamps travel with the order, so the move can stamp shippedAt.
    expect(call.order.shippedAt).toBeNull();
    expect(result.detail).toContain('حُدِّث 2 شحنة');
  });

  it('NEGATIVE: a courier whose account does not read is NOT polled — and the job says so', async () => {
    db.deliveryProvider.findMany.mockResolvedValue([{ ...BASHA, apiCredentials: 'not-a-sealed-blob' }]);
    ordersTable([parcel(1)]);
    answer(() => ({}));
    const result = await syncCourierStatus.run(ctx);
    expect(asked).toEqual([]);
    expect(result.detail).toContain('لا يُستطلع: الباشا');
  });
});

describe('a long list is asked in turns', () => {
  it('sixty a sweep, in id order, then from the top again', async () => {
    const rows = Array.from({ length: 130 }, (_, i) => parcel(i + 1));
    ordersTable(rows);
    answer(() => ({ status: 'SCANNED_BY_DRIVER_AND_IN_CAR' }));
    const sweeps: number[] = [];
    for (let i = 0; i < 4; i++) {
      asked.length = 0;
      await syncCourierStatus.run(ctx);
      sweeps.push(asked.length);
    }
    expect(sweeps).toEqual([POLL_BATCH, POLL_BATCH, 10, POLL_BATCH]);
  });
});

describe('when the courier is not there', () => {
  it('NEGATIVE: every barcode erroring is an outage, not sixty lost parcels — nothing is counted missing', async () => {
    ordersTable(Array.from({ length: 30 }, (_, i) => parcel(i + 1)));
    answer(() => ({ message: 'down' }), 503);
    await expect(syncCourierStatus.run(ctx)).rejects.toThrow(/تعذّر الوصول إلى الباشا/);
    expect(recordMiss).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    // The first chunk told us; the rest were not asked.
    expect(asked.length).toBe(10);
  });

  it('one barcode erroring among answers is still a miss, as before', async () => {
    ordersTable([parcel(1), parcel(2), parcel(3)]);
    answer((barcode) => (barcode === 'KSA2' ? { message: 'unknown' } : { status: 'SCANNED_BY_DRIVER_AND_IN_CAR' }));
    // A 200 with no status is not an error; make the unknown one a real failure.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const barcode = new URL(url).searchParams.get('barcode') ?? '';
      return barcode === 'KSA2' ? new Response('no', { status: 404 }) : new Response(JSON.stringify({ status: 'SCANNED_BY_DRIVER_AND_IN_CAR' }));
    }));
    await syncCourierStatus.run(ctx);
    expect(recordMiss).toHaveBeenCalledTimes(1);
  });
});

describe('the status question carries the company id too', () => {
  it('every barcode is asked with company-id = the account’s own id, through the adapter the job builds', async () => {
    ordersTable([parcel(1), parcel(2)]);
    const headers: Record<string, string>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ status: 'SCANNED_BY_DRIVER_AND_IN_CAR' }));
    }));
    await syncCourierStatus.run(ctx);
    expect(headers).toHaveLength(2);
    for (const h of headers) expect(h['company-id']).toBe('744');
  });
});
