import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A SEND THAT TIMED OUT IS NOT STUCK FOR EVER.
 *
 * The claim written before the courier call is kept on a silence on
 * purpose — the parcel may exist — and nothing ever cleared it, so the
 * order sat «send in flight» for ever. The way out is a person who rang the
 * company and heard «no parcel under that number»: «تحقّقتُ مع الشركة — لا
 * طرد عندهم». It clears the claim and the barcode in one conditional write
 * and it is audited with her sentence.
 *
 * It must NOT be a way to erase a real parcel: every refusal below is a
 * case where the parcel may exist.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('./db', () => ({ db }));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { STUCK_AFTER_MS, clearStuckSend } from './courier-send-reset';
import { POST } from '@/app/api/ops/shipments/clear-send/route';

const NOW = new Date();
const OLD = new Date(NOW.getTime() - STUCK_AFTER_MS - 1000);
const ORDER_ID = '77777777-7777-4777-8777-777777777777';

const stored = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-1', version: 6, trackingNumber: null,
  courierSendStartedAt: OLD, shippingStatus: 'READY_FOR_PICKUP', shippedAt: null,
  ...over,
});

const clear = (over: Record<string, unknown> = {}) =>
  clearStuckSend({ orderId: ORDER_ID, companyId: 'c1', storeId: 's1', now: NOW, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  db.order.findFirst.mockResolvedValue(stored());
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderActivity.create.mockResolvedValue({});
});

describe('clearing a stuck send', () => {
  it('clears the claim and the barcode in one conditional write', async () => {
    const res = await clear();

    expect(res.ok).toBe(true);
    const call = db.order.updateMany.mock.calls[0][0];
    expect(call.data).toMatchObject({ courierSendStartedAt: null, trackingNumber: null });
    // Conditional: the claim as read, the version as read, and not shipped.
    expect(call.where).toMatchObject({ id: ORDER_ID, version: 6, courierSendStartedAt: OLD, shippedAt: null });
  });

  it('refuses an order that has no claim at all', async () => {
    db.order.findFirst.mockResolvedValue(stored({ courierSendStartedAt: null }));

    const res = await clear();

    expect(res).toMatchObject({ ok: false, code: 'NO_CLAIM' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a claim younger than the courier’s patience — the call may still be answering', async () => {
    db.order.findFirst.mockResolvedValue(stored({ courierSendStartedAt: new Date(NOW.getTime() - 30_000) }));

    const res = await clear();

    expect(res).toMatchObject({ ok: false, code: 'TOO_SOON' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['stamped shipped', { shippedAt: new Date() }],
    ['with the courier', { shippingStatus: 'OUT_FOR_DELIVERY' }],
  ])('refuses a parcel that has left (%s) — it exists', async (_n, over) => {
    db.order.findFirst.mockResolvedValue(stored(over));

    const res = await clear();

    expect(res).toMatchObject({ ok: false, code: 'ALREADY_LEFT' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to erase a barcode the person did not repeat back, and shows it', async () => {
    db.order.findFirst.mockResolvedValue(stored({ trackingNumber: 'BC-123' }));

    const res = await clear();

    expect(res).toMatchObject({ ok: false, code: 'BARCODE_CONFIRM_REQUIRED', barcode: 'BC-123' });
    expect(db.order.updateMany, 'انمسح باركود بلا تأكيد').not.toHaveBeenCalled();
  });

  it('refuses the wrong barcode typed back', async () => {
    db.order.findFirst.mockResolvedValue(stored({ trackingNumber: 'BC-123' }));

    expect(await clear({ confirmBarcode: 'BC-999' })).toMatchObject({ ok: false, code: 'BARCODE_CONFIRM_REQUIRED' });
  });

  it('clears an order that carries a barcode once she types it back right', async () => {
    db.order.findFirst.mockResolvedValue(stored({ trackingNumber: 'BC-123' }));

    const res = await clear({ confirmBarcode: ' BC-123 ' });

    expect(res).toMatchObject({ ok: true, clearedBarcode: 'BC-123' });
    expect(db.order.updateMany.mock.calls[0][0].where.trackingNumber).toBe('BC-123');
  });

  it('says so, and erases nothing, when the late answer wrote a barcode a second ago', async () => {
    db.order.updateMany.mockResolvedValue({ count: 0 });

    expect(await clear()).toMatchObject({ ok: false, code: 'MOVED_ON' });
  });

  it('refuses an order of another store', async () => {
    db.order.findFirst.mockResolvedValue(null);

    expect(await clear()).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(db.order.findFirst.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', storeId: 's1' });
  });
});

describe('the door', () => {
  const press = async (body: Record<string, unknown>) => {
    const res = await POST(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(() => {
    requireContext.mockResolvedValue({ user: { id: 'u1', name: 'المستودع' }, companyId: 'c1', storeId: 's1' });
    requirePermission.mockResolvedValue({});
  });

  it('records WHO said it and WHAT they said — on the order and in the audit', async () => {
    const res = await press({ orderId: ORDER_ID, note: 'كلّمتهم وما عندهم أي طرد' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const activity = db.orderActivity.create.mock.calls[0][0].data;
    expect(activity).toMatchObject({ orderId: ORDER_ID, userId: 'u1', action: 'COURIER_SEND_CLEARED' });
    expect(JSON.parse(activity.metadata).said).toBe('كلّمتهم وما عندهم أي طرد');
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      userId: 'u1', action: 'COURIER_SEND_CLEARED', entity: 'Order', entityId: ORDER_ID,
    });
  });

  it('wants a sentence, not a click', async () => {
    const res = await press({ orderId: ORDER_ID, note: 'تم' });

    expect(res.status).toBe(400);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('asks for the shipping key before anything', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission ops.ship'));

    const res = await press({ orderId: ORDER_ID, note: 'كلّمتهم وما عندهم أي طرد' });

    expect(res.status).toBe(403);
    expect(db.order.findFirst).not.toHaveBeenCalled();
    expect(requirePermission).toHaveBeenCalledWith('ops.ship');
  });

  it('writes no audit and no activity for a refusal', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippedAt: new Date() }));

    const res = await press({ orderId: ORDER_ID, note: 'كلّمتهم وما عندهم أي طرد' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_LEFT');
    expect(logAudit).not.toHaveBeenCalled();
    expect(db.orderActivity.create).not.toHaveBeenCalled();
  });

  it('gives the barcode back to the screen when it needs to be repeated', async () => {
    db.order.findFirst.mockResolvedValue(stored({ trackingNumber: 'BC-123' }));

    const res = await press({ orderId: ORDER_ID, note: 'كلّمتهم وما عندهم أي طرد' });

    expect(res.status).toBe(409);
    expect(res.body.barcode).toBe('BC-123');
  });
});
