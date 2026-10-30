import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A CANCELLATION IS RAISED WITH ITS REASON — AND KEEPS IT.
 *
 * The stand-down door carries an approved cancellation out only under one of
 * the structured reasons, and reads it from the request. This door never
 * stored it: its schema did not name `cancelReason`, so zod dropped it, and
 * every cancellation was saved with `cancelReason = null` and failed on the
 * last press with «سبب الإلغاء مطلوب» — the owner saw it on the review queue.
 *
 * So: stored, demanded, validated like the door does, and never invented for
 * the other two asks.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, can } = vi.hoisted(() => ({
  db: {
    orderChangeRequest: {
      findFirst: vi.fn<(args: { where: Record<string, unknown> }) => Promise<unknown>>(),
      create: vi.fn<(args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>>(),
      update: vi.fn(async (..._a: unknown[]) => ({})),
    },
    shippingBatch: { findFirst: vi.fn() },
    order: { findFirst: vi.fn() },
    orderNote: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  can: vi.fn<(...a: unknown[]) => boolean>(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: vi.fn(),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn(async (..._a: unknown[]) => 1) }));
vi.mock('@/lib/notify', () => ({ afterResponse: (fn: () => Promise<void>) => void fn() }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a) }));

import { POST } from './route';

const OWNER = { id: 'owner', name: 'المالك', role: 'SUPER_ADMIN' };
const ctx = {
  user: OWNER, companyId: 'c1', storeId: 's1',
  country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Amman' },
};

const ours = () => ({
  id: 'o1', companyId: 'c1', storeId: 's1', orderNumber: 'SY-5', confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null, claimedById: null,
});

const raise = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const SAID = 'الزبون تراجع بالاتصال';
const CANCEL = { intent: 'CANCEL', reason: SAID };

/** What was written, read back from the one create call. */
const written = () => {
  const call = db.orderChangeRequest.create.mock.calls[0];
  if (!call) throw new Error('لم يُكتب طلب');
  return call[0].data;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(ctx);
  can.mockReturnValue(true);
  assertOrderAccess.mockResolvedValue({ allowed: true, order: ours() });
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.create.mockImplementation(async ({ data }) => ({ id: 'cr1', ...data }));
  db.order.findFirst.mockResolvedValue({ quantity: 1, productId: 'p1', sellingPrice: 10, discountAmount: 0, customerNotes: null, regionId: null, customer: {} });
  db.shippingBatch.findFirst.mockResolvedValue(null);
});

describe('the reason is stored', () => {
  it('a cancellation raised with a reason keeps it on the request', async () => {
    const res = await raise({ ...CANCEL, cancelReason: 'CUSTOMER_CHANGED_MIND' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(written().cancelReason).toBe('CUSTOMER_CHANGED_MIND');
    expect(res.body.request.cancelReason).toBe('CUSTOMER_CHANGED_MIND');
  });

  it('and the immediate apply (the raiser may decide) reads the same stored reason', async () => {
    const res = await raise({ ...CANCEL, cancelReason: 'PRICE_TOO_HIGH' });

    expect(res.body.readyToApply).toBe(true);
    // The request carried out a moment later is this very row.
    expect(res.body.request.cancelReason).toBe('PRICE_TOO_HIGH');
  });

  it('«أخرى» is accepted with the customer’s sentence, which is the explanation', async () => {
    const res = await raise({ ...CANCEL, cancelReason: 'OTHER' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(written().cancelReason).toBe('OTHER');
  });

  it('a parcel already with the courier still stores it — the reason reaches the message', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'B-1' });
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ours(), shippingStatus: 'SHIPPED', shippedAt: new Date() } });

    const res = await raise({ ...CANCEL, cancelReason: 'FAKE_ORDER' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.readyToApply).toBe(false);
    expect(written().cancelReason).toBe('FAKE_ORDER');
  });
});

describe('and it is demanded, in Arabic, before anything is written', () => {
  it('no reason at all → 400 with the code the screen reads', async () => {
    const res = await raise(CANCEL);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANCEL_REASON_REQUIRED');
    expect(res.body.error).toBe('اختر سبب الإلغاء');
    expect(res.body.errorAr).toBe('اختر سبب الإلغاء');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it.each(['NO_ANSWER_3_ATTEMPTS', 'MODERATOR_DATA_ERROR', 'SOMETHING_I_MADE_UP', ''])(
    'NEGATIVE: %j is not a choice a person may make',
    async (bad) => {
      const res = await raise({ ...CANCEL, cancelReason: bad });

      expect(res.status).toBe(400);
      expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
    }
  );

  it('«أخرى» without the sentence is refused — the request’s own reason is that sentence and must be there', async () => {
    const res = await raise({ intent: 'CANCEL', cancelReason: 'OTHER', reason: 'لا' });

    expect(res.status).toBe(400);
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });
});

describe('and it belongs to a cancellation only', () => {
  it('an edit never stores one, even if the body carries it', async () => {
    const res = await raise({ intent: 'EDIT', reason: 'عنوان خاطئ', changes: { customerAddress: { to: 'شارع جديد' } }, cancelReason: 'FAKE_ORDER' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(written().cancelReason).toBeNull();
  });

  it('nor does a postponement', async () => {
    const res = await raise({
      intent: 'POSTPONE', reason: 'الزبون مسافر', cancelReason: 'FAKE_ORDER',
      postponeUntil: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(written().cancelReason).toBeNull();
  });

  it('and an edit or a postponement is not asked for one', async () => {
    const edit = await raise({ intent: 'EDIT', reason: 'عنوان خاطئ', changes: { customerAddress: { to: 'شارع جديد' } } });
    expect(edit.status).toBe(201);
  });
});

describe('one cancellation at a time', () => {
  /** The first findFirst is the PENDING check; the second is ours, told apart by its `where`. */
  const approvedCancelWaiting = () =>
    db.orderChangeRequest.findFirst.mockImplementation(async ({ where }) =>
      where.status === 'APPROVED' && where.intent === 'CANCEL' && where.appliedAt === null ? { id: 'old' } : null
    );

  it('an approved cancellation still waiting to be carried out is not raised again', async () => {
    approvedCancelWaiting();

    const res = await raise({ ...CANCEL, cancelReason: 'CUSTOMER_CHANGED_MIND' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCEL_ALREADY_APPROVED');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: it blocks only another cancellation — an edit of the same order is raised as before', async () => {
    approvedCancelWaiting();

    const res = await raise({ intent: 'EDIT', reason: 'عنوان خاطئ', changes: { customerAddress: { to: 'شارع جديد' } } });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('and the question is scoped to this company’s unapplied approvals, not any row', async () => {
    await raise({ ...CANCEL, cancelReason: 'CUSTOMER_CHANGED_MIND' });

    const asked = db.orderChangeRequest.findFirst.mock.calls.map((c) => c[0].where);
    expect(asked).toContainEqual({ orderId: 'o1', companyId: 'c1', intent: 'CANCEL', status: 'APPROVED', appliedAt: null });
  });
});
