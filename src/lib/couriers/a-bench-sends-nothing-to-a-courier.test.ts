import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A BENCH SENDS NOTHING TO A COURIER (B2, 18/11 — `test-store.ts`).
 *
 * `dispatchBatch` is the one place a parcel comes into existence at the company. A bench order stops at confirmation,
 * so even one that sits on a trolley from before its store became a bench is not created there: each is answered
 * «TEST_STORE», before the claim and before any call. The negative: a real store's batch is sent as before.
 */

const { db, adapterFor } = vi.hoisted(() => ({
  db: {
    store: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    order: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
  adapterFor: vi.fn(),
}));
vi.mock('../db', () => ({ db }));
vi.mock('./index', () => ({ adapterFor: (...a: unknown[]) => adapterFor(...a) }));
vi.mock('../audit', () => ({ logAudit: vi.fn() }));

import { dispatchBatch } from './dispatch';
import { dispatchReasonAr } from '../dispatch-reason';
import { BENCH_STOPS_AR } from '../test-store';

const createShipment = vi.fn();
const input = { batchId: 'b1', companyId: 'c1', storeId: 's1', userId: 'u1' };
const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', orderNumber: 'SY-2026-0001', merchantRef: 'SY-2026-0001',
  trackingNumber: null, currency: 'USD', quantity: 1, freeQuantity: 0, customerNotes: null, deliveryProviderId: 'p1',
  customer: { fullName: 'زبون', rawPhone: '0999111222', phone: '999111222', address: 'شارع' },
  region: { name: 'دمشق' }, regionId: 'r1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.shippingBatch.findFirst.mockResolvedValue({
    id: 'b1', batchNumber: 'BATCH-2026-0001', status: 'READY',
    provider: { id: 'p1', code: 'HALA', apiEnabled: true, companyId: 'c1', storeId: 's1' },
  });
  adapterFor.mockReturnValue({ code: 'TEST', automated: true, needsCourierCityId: false, createShipment });
  createShipment.mockResolvedValue({ trackingNumber: 'BC-777' });
  db.order.findMany.mockResolvedValue([order(), order({ id: 'o2', orderNumber: 'SY-2026-0002' })]);
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.deliveryFee.findMany.mockResolvedValue([]);
  db.$queryRaw.mockImplementation(async (frags: string[]) =>
    frags.join(' ').includes('UPDATE') ? [{ id: 'o1', totalAmount: 60 }] : [{ tracking: null }]
  );
  db.$executeRaw.mockResolvedValue(1);
  db.store.findFirst.mockResolvedValue(null);
});

describe('a bench’s batch', () => {
  it('sends no order: each is answered TEST_STORE, no claim is written, the courier is never called', async () => {
    db.store.findFirst.mockResolvedValue({ id: 's1' });
    const res = await dispatchBatch(input);
    expect(res.sent).toBe(0);
    expect(res.outcomes.map((o) => o.skipped)).toEqual(['TEST_STORE', 'TEST_STORE']);
    expect(createShipment).not.toHaveBeenCalled();
    expect(db.$queryRaw, 'كُتب حجزُ إرسالٍ لطلب منصّة').not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('asks the batch’s own store, in this company', async () => {
    db.store.findFirst.mockResolvedValue({ id: 's1' });
    await dispatchBatch(input);
    expect(db.store.findFirst.mock.calls[0][0].where).toEqual({ id: 's1', companyId: 'c1', isTest: true });
  });

  it('and the screen reads the owner’s sentence for it', async () => {
    db.store.findFirst.mockResolvedValue({ id: 's1' });
    const res = await dispatchBatch(input);
    expect(dispatchReasonAr(res.outcomes[0])).toBe(BENCH_STOPS_AR);
  });

  it('an order that already carries a barcode is still said to be sent — history is not rewritten', async () => {
    db.store.findFirst.mockResolvedValue({ id: 's1' });
    db.order.findMany.mockResolvedValue([order({ trackingNumber: 'BC-OLD' })]);
    const res = await dispatchBatch(input);
    expect(res.outcomes[0].skipped).toBe('ALREADY_SENT');
  });
});

describe('NEGATIVE: a real store’s batch', () => {
  it('is sent exactly as before', async () => {
    const res = await dispatchBatch({ ...input, orderIds: ['o1'] });
    expect(createShipment).toHaveBeenCalled();
    expect(res.outcomes.some((o) => o.skipped === 'TEST_STORE')).toBe(false);
    expect(res.sent).toBeGreaterThan(0);
  });
});
