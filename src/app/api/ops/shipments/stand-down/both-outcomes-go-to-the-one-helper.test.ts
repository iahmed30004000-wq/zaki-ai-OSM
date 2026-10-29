import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE STAND-DOWN HANDS BOTH OUTCOMES TO THE ONE HELPER — AND ASKS THE GATE FIRST.
 *
 * What the helper does (the end state, the release, the company told, the
 * races) is `order-cancel.test.ts`'s. What THIS door owes is narrower and just
 * as breakable: that «ألغِ» and «أعِده للمتابعة» reach `endOrder` with the
 * right kind and the right columns, that the person's word travels with the
 * press, that a refusal is forwarded WITH the sentence they must stand behind,
 * and that a pressed trolley is refused before anything is written.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, can, logAudit, endOrder, notify } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  endOrder: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
// Only the writer is replaced: the gate (`batchStatusOf`) stays the real one, reading the fake db.
vi.mock('@/lib/order-cancel', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  endOrder: (...a: unknown[]) => endOrder(...a),
}));

import { POST } from './route';

const ORDER_ID = '88888888-8888-4888-8888-888888888888';
const SOON = new Date(Date.now() + 3 * 86_400_000).toISOString();

const stored = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-5', version: 4, confirmationStatus: 'CONFIRMED',
  shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: new Date(),
  shippingBatchId: 'b1', trackingNumber: null, deliveryProviderId: null,
  ...over,
});

const press = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID, ...body }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'أبو خالد', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({});
  can.mockReturnValue(true);
  db.order.findFirst.mockResolvedValue(stored());
  db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY' });
  endOrder.mockResolvedValue({ ok: true, orderNumber: 'SY-5', attested: true, tookOff: true, courierCancelled: false });
});

describe('«ألغِ»', () => {
  it('reaches the helper as a CANCEL of this door, with the reason, the version and the person’s word', async () => {
    const res = await press({ outcome: 'CANCEL', reason: 'CUSTOMER_CHANGED_MIND', note: 'اتصل وألغى', parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(endOrder).toHaveBeenCalledTimes(1);
    const call = endOrder.mock.calls[0][0];
    expect(call).toMatchObject({
      orderId: ORDER_ID, companyId: 'c1', storeId: 's1', door: 'STAND_DOWN', kind: 'CANCEL', endAs: 'CANCELLED',
      reason: 'CUSTOMER_CHANGED_MIND', rejectionNote: 'اتصل وألغى', expectedVersion: 4, parcelInHand: true,
    });
    // The cancelled order is let go of by whoever held it.
    expect(call.data).toMatchObject({ claimedById: null, lockedById: null, currentOwnerId: null });
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'SHIPMENT_STOOD_DOWN_CANCELLED' });
  });

  it('NEGATIVE: the word is never assumed — not sent means not given', async () => {
    await press({ outcome: 'CANCEL', reason: 'CUSTOMER_CHANGED_MIND' });

    expect(endOrder.mock.calls[0][0].parcelInHand).toBe(false);
  });

  it('and the person is told what they must stand behind when the helper asks for it', async () => {
    endOrder.mockResolvedValue({
      ok: false, status: 409, code: 'ATTESTATION_REQUIRED', error: 'علّم «الطرد بين يديّ»',
      attestation: 'الطرد بين يديّ — فككتُه وأعدتُ قطعه للرف وأتلفتُ بوليصته',
    });

    const res = await press({ outcome: 'CANCEL', reason: 'CUSTOMER_CHANGED_MIND' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ATTESTATION_REQUIRED', attestation: 'الطرد بين يديّ — فككتُه وأعدتُ قطعه للرف وأتلفتُ بوليصته' });
    // A refused cancel announces nothing and audits no stand-down.
    expect(logAudit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('demands a structured reason, and a sentence for «other» — before the helper is asked', async () => {
    expect((await press({ outcome: 'CANCEL' })).status).toBe(400);
    expect((await press({ outcome: 'CANCEL', reason: 'OTHER', note: 'x' })).status).toBe(400);
    expect(endOrder).not.toHaveBeenCalled();
  });
});

describe('«أعِده للمتابعة»', () => {
  it('reaches the helper as a FOLLOW_UP: the order lives, un-confirmed, with a date and nobody holding it', async () => {
    const res = await press({ outcome: 'POSTPONE', until: SOON });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const call = endOrder.mock.calls[0][0];
    expect(call).toMatchObject({ door: 'STAND_DOWN', kind: 'FOLLOW_UP', expectedVersion: 4 });
    expect(call.data).toMatchObject({
      confirmationStatus: 'POSTPONED', status: 'POSTPONED', confirmedAt: null, claimedById: null, followUpStatus: 'SCHEDULED',
    });
    expect(call.data.postponedUntil).toEqual(new Date(SOON));
    // The shipment’s exit and the version are the helper’s, in ONE place — not repeated by a door.
    expect(call.data).not.toHaveProperty('shippingStatus');
    expect(call.data).not.toHaveProperty('version');
    expect(call.reason, 'اخترع سبب رفض لطلب حيّ').toBeUndefined();
  });

  it('and a date in the past is refused before the helper is asked', async () => {
    const res = await press({ outcome: 'POSTPONE', until: new Date(Date.now() - 86_400_000).toISOString() });

    expect(res.status).toBe(400);
    expect(endOrder).not.toHaveBeenCalled();
  });
});

describe('the gate, asked first', () => {
  it('a trolley that was PRESSED is refused before anything is written', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED' });

    const res = await press({ outcome: 'CANCEL', reason: 'CUSTOMER_CHANGED_MIND', parcelInHand: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('a trolley whose status cannot be read is refused too — it is not assumed open', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(null);

    const res = await press({ outcome: 'CANCEL', reason: 'CUSTOMER_CHANGED_MIND', parcelInHand: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UNKNOWN_BATCH');
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('an order that is not confirmed has nothing to stand down', async () => {
    db.order.findFirst.mockResolvedValue(stored({ confirmationStatus: 'POSTPONED', shippingStatus: 'NOT_READY', labelPrintedAt: null, shippingBatchId: null }));

    const res = await press({ outcome: 'CANCEL', reason: 'CUSTOMER_CHANGED_MIND' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_CONFIRMED');
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a labelled parcel on a trolley still being filled reaches the helper (it is the helper that asks for the word)', async () => {
    await press({ outcome: 'CANCEL', reason: 'CUSTOMER_CHANGED_MIND' });

    expect(endOrder).toHaveBeenCalledTimes(1);
  });
});
