import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OWNER CAN CANCEL HIS OWN LABELLED PARCEL WITHOUT APPROVING HIMSELF.
 *
 * `readyToApply` is the server saying «the raiser may also decide this, and
 * the parcel is still ours». It read the PRINTED WAYBILL as the line for every
 * ask, so the owner raising a cancel of a labelled parcel was told to wait for
 * somebody else — while the decide door refuses «لا يمكنك اعتماد طلب قدّمته
 * بنفسك». A deadlock with one person in it.
 *
 * M6 (28/10): for a CANCEL or a POSTPONEMENT the line is the press of
 * «إغلاق الشحنة — سُلّمت للشركة». For an EDIT it is still the waybill, which
 * fixes what the driver will read. Every positive has its negative.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, can, createNotification } = vi.hoisted(() => ({
  db: {
    orderChangeRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(async (..._a: unknown[]) => ({})) },
    shippingBatch: { findFirst: vi.fn() },
    order: { findFirst: vi.fn() },
    orderNote: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  can: vi.fn<(...a: unknown[]) => boolean>(),
  createNotification: vi.fn(async (..._a: unknown[]) => 1),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: vi.fn(),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/notify', () => ({ afterResponse: (fn: () => Promise<void>) => void fn() }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a) }));

import { POST } from './route';

const OWNER = { id: 'owner', name: 'المالك', role: 'SUPER_ADMIN' };
const ctx = {
  user: OWNER, companyId: 'c1', storeId: 's1',
  country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Amman' },
};

const labelled = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 's1', orderNumber: 'SY-5', confirmationStatus: 'CONFIRMED',
  shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: new Date(), claimedById: null,
  ...over,
});

const raise = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const CANCEL = { intent: 'CANCEL', reason: 'الزبون تراجع بالاتصال', cancelReason: 'CUSTOMER_CHANGED_MIND' };
const POSTPONE = { intent: 'POSTPONE', reason: 'الزبون مسافر', postponeUntil: new Date(Date.now() + 5 * 86_400_000).toISOString() };
const EDIT = { intent: 'EDIT', reason: 'عنوان خاطئ', changes: { customerAddress: { to: 'شارع جديد' } } };

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(ctx);
  // The owner holds every key, control.change_requests included: he may decide it himself.
  can.mockReturnValue(true);
  assertOrderAccess.mockResolvedValue({ allowed: true, order: labelled() });
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'cr1', ...data }));
  db.order.findFirst.mockResolvedValue({ quantity: 1, productId: 'p1', sellingPrice: 10, discountAmount: 0, customerNotes: null, regionId: null, customer: {} });
  // A trolley still being filled.
  db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY', batchNumber: 'B-1' });
});

describe('a labelled parcel on a trolley still being filled', () => {
  it.each([['a cancellation', CANCEL], ['a postponement', POSTPONE]])('%s by the owner is ready to apply — no waiting for himself', async (_n, body) => {
    const res = await raise(body);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.readyToApply).toBe(true);
    expect((db.orderChangeRequest.update.mock.calls[0] as unknown as [{ data: unknown }])[0].data).toMatchObject({ status: 'APPROVED', decidedById: 'owner' });
  });

  it('NEGATIVE: an EDIT of the same parcel still waits — the printed waybill fixes what the driver reads', async () => {
    const res = await raise(EDIT);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.readyToApply).toBe(false);
    expect(db.orderChangeRequest.update).not.toHaveBeenCalled();
  });
});

describe('a parcel on a trolley that was pressed', () => {
  beforeEach(() => {
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'B-1' });
  });

  it('a cancellation is NOT ready to apply — it becomes a request that tells the company', async () => {
    const res = await raise(CANCEL);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.readyToApply).toBe(false);
    expect(db.orderChangeRequest.update).not.toHaveBeenCalled();
  });

  it('a postponement is refused at the door — there is nothing left to hold', async () => {
    const res = await raise(POSTPONE);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INTENT_IMPOSSIBLE');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });
});

describe('the parcel’s own status is read too, not only the trolley', () => {
  it('a parcel that is already shipped by itself cannot be postponed, though no trolley says so', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: labelled({ shippingStatus: 'SHIPPED', shippedAt: new Date() }) });
    db.shippingBatch.findFirst.mockResolvedValue(null);

    const res = await raise(POSTPONE);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INTENT_IMPOSSIBLE');
  });
});
