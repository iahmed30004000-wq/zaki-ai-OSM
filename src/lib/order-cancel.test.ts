import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CourierRefusal } from './couriers/logestechs';
import { markOutcomeUnknown } from './couriers/types';
import { ATTESTATION_AR } from './shipment-cancel';
import { readContract, validate } from './apps/contract';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE HELPER ENDS AN ORDER — AND UNTIL «إغلاق الشحنة — سُلّمت للشركة» IT CAN.
 *
 * The owner's M6 ruling: «الغاء و التأجيل لغاية ما اضغط اغلاق الشحنة».
 * `endOrder` is where every cancel door lands (stand-down, confirmation,
 * the shipping screen's CANCELLED, the PATCH, the automatic close), so this
 * file is where the claims about cancelling live, against a fake database
 * that records every write:
 *
 *   · the gate: refused once the courier has it, AND when the trolley cannot
 *     be read (fail closed);
 *   · packed goods (waybill printed, or on the pickup shelf) come back only
 *     on a person's word, recorded with their name;
 *   · ONE end state, written conditionally (a press, a dispatch or a second
 *     cancel that lands first makes the write find nothing);
 *   · the company is told for a barcode it holds — outside the transaction,
 *     and only a clear YES lets the order change;
 *   · System 7 hears `order.cancelled` once, with the shipping payload.
 *
 * Every refusal has its negative: the ordinary cancel is not asked for a
 * word it does not need.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, releaseOrderLines, emitAppEvent, logAudit } = vi.hoisted(() => {
  const db: any = {
    order: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { create: vi.fn(async () => ({})) },
    orderActivity: { create: vi.fn(async () => ({})) },
    orderNote: { create: vi.fn(async () => ({})) },
    customer: { update: vi.fn(async () => ({})) },
    orderChangeRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    shippingBatch: { findFirst: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    db,
    // Rest parameters, so `.mock.calls[n][m]` is typed as the calls they really get.
    releaseOrderLines: vi.fn(async (..._a: unknown[]) => 2),
    emitAppEvent: vi.fn(async (..._a: unknown[]) => 1),
    logAudit: vi.fn(async (..._a: unknown[]) => undefined),
  };
});

vi.mock('./db', () => ({ db }));
vi.mock('./reservation', () => ({ releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...a) }));
vi.mock('./apps/events', () => ({ emitAppEvent: (...a: unknown[]) => emitAppEvent(...a) }));
vi.mock('./audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { batchStatusOf, endOrder, holdFromTrolley, type EndOrderInput, type HoldFromTrolleyInput } from './order-cancel';

const BY = { id: 'u1', name: 'أبو خالد', role: 'WAREHOUSE' };

/** An order on the pickup shelf, on an open trolley, waybill printed — the case M6 exists for. */
const packed = (over: Record<string, unknown> = {}) => ({
  id: 'o1', orderNumber: 'SY-2026-0148', version: 7,
  confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  shippedAt: null, labelPrintedAt: new Date('2026-10-28T08:00:00Z'),
  shippingBatchId: 'b1', deliveryProviderId: 'p1', trackingNumber: null, courierSendStartedAt: null,
  totalAmount: 185000, currency: 'SYP', customerId: 'cu1',
  shippingBatch: { status: 'READY', batchNumber: 'BATCH-2026-0003' },
  ...over,
});

/** A plain confirmed order still on the confirmation side of the building. */
const plain = (over: Record<string, unknown> = {}) =>
  packed({
    shippingStatus: 'NOT_READY', labelPrintedAt: null, shippingBatchId: null, deliveryProviderId: null,
    shippingBatch: null, ...over,
  });

const input = (over: Partial<EndOrderInput> = {}): EndOrderInput => ({
  orderId: 'o1', companyId: 'c1', storeId: 's1', by: BY, door: 'STAND_DOWN', kind: 'CANCEL',
  endAs: 'CANCELLED', reason: 'CUSTOMER_CHANGED_MIND', rejectionNote: 'الزبون تراجع', ...over,
});

/** The company's adapter, with the one call that matters. */
const adapterWith = (cancelShipment: () => Promise<void>) => ({
  code: 'LOGESTECHS', name: 'LogesTechs', automated: true,
  createShipment: vi.fn(), fetchEvents: vi.fn(), mapStatus: vi.fn(), cancelShipment: vi.fn(cancelShipment),
});

const written = () => db.order.updateMany.mock.calls[0][0] as { where: Record<string, any>; data: Record<string, any> };
const activities = () => db.orderActivity.create.mock.calls.map((c: any[]) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.deliveryProvider.findFirst.mockResolvedValue({ name: 'الباشا', code: 'BASHA', apiEnabled: false });
});

describe('the gate — until the press of «إغلاق الشحنة — سُلّمت للشركة»', () => {
  it('lets a PACKED parcel on an OPEN trolley be cancelled (with the word)', async () => {
    db.order.findFirst.mockResolvedValue(packed());

    const out = await endOrder(input({ parcelInHand: true }));

    expect(out).toMatchObject({ ok: true, orderNumber: 'SY-2026-0148', attested: true, tookOff: true });
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses once the courier has the trolley — and writes nothing', async () => {
    db.order.findFirst.mockResolvedValue(packed({ shippingBatch: { status: 'SHIPPED', batchNumber: 'B' } }));

    const out = await endOrder(input({ parcelInHand: true }));

    expect(out).toMatchObject({ ok: false, status: 409, code: 'CANCEL_AFTER_SHIPPED' });
    expect(db.$transaction, 'انفتحت معاملة على طرد سُلّم للشركة').not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(releaseOrderLines).not.toHaveBeenCalled();
  });

  it.each([
    ['its own status says SHIPPED', { shippingStatus: 'SHIPPED' }],
    ['it carries shippedAt', { shippedAt: new Date() }],
    ['it is out for delivery', { shippingStatus: 'OUT_FOR_DELIVERY' }],
  ])('refuses a parcel that left even if the trolley still reads open: %s', async (_name, over) => {
    db.order.findFirst.mockResolvedValue(packed(over));

    const out = await endOrder(input({ parcelInHand: true }));

    expect(out).toMatchObject({ ok: false, code: 'CANCEL_AFTER_SHIPPED' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the order names a trolley whose status cannot be read', async () => {
    db.order.findFirst.mockResolvedValue(packed({ shippingBatch: null }));

    const out = await endOrder(input({ parcelInHand: true }));

    expect(out).toMatchObject({ ok: false, code: 'UNKNOWN_BATCH' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('and an order that is already ended is not ended twice', async () => {
    db.order.findFirst.mockResolvedValue(plain({ confirmationStatus: 'CANCELLED' }));

    const out = await endOrder(input());

    expect(out).toMatchObject({ ok: false, status: 409, code: 'ALREADY_ENDED' });
    expect(db.customer.update, 'عُدّ إلغاءٌ ثانٍ على الزبون').not.toHaveBeenCalled();
  });

  it('and a stale screen is refused by version', async () => {
    db.order.findFirst.mockResolvedValue(plain());

    const out = await endOrder(input({ expectedVersion: 3 }));

    expect(out).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a missing order is a 404, not a crash', async () => {
    db.order.findFirst.mockResolvedValue(null);

    expect(await endOrder(input())).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
  });
});

describe('the stock — packed goods come back on a person’s word', () => {
  it.each([
    ['a printed waybill', packed({ shippingStatus: 'READY_FOR_SHIPPING', shippingBatchId: null, shippingBatch: null })],
    ['the pickup shelf', packed({ labelPrintedAt: null })],
  ])('asks for it when the parcel is on %s — and releases nothing without it', async (_name, row) => {
    db.order.findFirst.mockResolvedValue(row);

    const out = await endOrder(input());

    expect(out).toMatchObject({ ok: false, status: 409, code: 'ATTESTATION_REQUIRED', attestation: ATTESTATION_AR });
    expect(releaseOrderLines, 'رجعت قطع طرد مغلّف على كلمة أحد').not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('the sentence the person is asked to stand behind is the owner’s', () => {
    expect(ATTESTATION_AR).toBe('الطرد بين يديّ — فككتُه وأعدتُ قطعه للرف وأتلفتُ بوليصته');
  });

  it('with the word: the units go back, and WHO said it is written to the order and to the audit', async () => {
    db.order.findFirst.mockResolvedValue(packed());

    await endOrder(input({ parcelInHand: true }));

    expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    const said = activities().find((a: any) => a.action === 'PARCEL_ATTESTED_IN_HAND');
    expect(said).toMatchObject({ orderId: 'o1', userId: 'u1' });
    expect(JSON.parse(said.metadata)).toMatchObject({ said: ATTESTATION_AR, by: 'أبو خالد' });
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      userId: 'u1', action: 'PARCEL_ATTESTED_IN_HAND', entity: 'Order', entityId: 'o1',
    });
  });

  it('NEGATIVE: an order that was never packed is cancelled without being asked for any word', async () => {
    db.order.findFirst.mockResolvedValue(plain());

    const out = await endOrder(input());

    expect(out).toMatchObject({ ok: true, attested: false, tookOff: false });
    expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    expect(activities().map((a: any) => a.action)).not.toContain('PARCEL_ATTESTED_IN_HAND');
    expect(logAudit, 'سُجّل تصريح لم يُطلب').not.toHaveBeenCalled();
  });
});

describe('ONE end state', () => {
  beforeEach(() => {
    db.order.findFirst.mockResolvedValue(packed({ trackingNumber: null }));
  });

  it('writes the cancelled confirmation with the reason, and takes the parcel out of the shipment', async () => {
    await endOrder(input({ parcelInHand: true }));

    expect(written().data).toMatchObject({
      confirmationStatus: 'CANCELLED',
      status: 'CANCELLED',
      rejectionReason: 'CUSTOMER_CHANGED_MIND',
      rejectionNote: 'الزبون تراجع',
      shippingStatus: 'NOT_READY',
      settlementStatus: 'NOT_APPLICABLE',
      shippingBatchId: null,
      deliveryProviderId: null,
      labelPrintedAt: null,
      trackingNumber: null,
      courierSendStartedAt: null,
      shipHoldUntil: null,
      version: { increment: 1 },
    });
  });

  it('keeps the OLD values in the activity «أُخرج من الدفعة» — nothing is lost, only moved', async () => {
    await endOrder(input({ parcelInHand: true }));

    const off = activities().find((a: any) => a.action === 'TAKEN_OFF_BATCH');
    expect(off).toBeTruthy();
    expect(JSON.parse(off.metadata)).toMatchObject({
      batch: 'BATCH-2026-0003', shippingStatus: 'READY_FOR_PICKUP', door: 'STAND_DOWN',
    });
    expect(JSON.parse(off.metadata).labelPrintedAt).toBe('2026-10-28T08:00:00.000Z');
  });

  it('writes the CONFIRMATION status-log row, so win-back still sees the loss — and the shipping one', async () => {
    await endOrder(input({ parcelInHand: true, logNote: 'أُلغي قبل الشحن' }));

    const logs = db.orderStatusLog.create.mock.calls.map((c: any[]) => c[0].data);
    expect(logs).toEqual([
      expect.objectContaining({ statusType: 'CONFIRMATION', previousValue: 'CONFIRMED', newValue: 'CANCELLED', changedById: 'u1', note: 'أُلغي قبل الشحن' }),
      expect.objectContaining({ statusType: 'SHIPPING', previousValue: 'READY_FOR_PICKUP', newValue: 'NOT_READY' }),
    ]);
  });

  it('counts the customer’s cancellation — at every door, not only the PATCH', async () => {
    await endOrder(input({ parcelInHand: true, door: 'CONFIRMATION' }));

    expect(db.customer.update).toHaveBeenCalledWith({ where: { id: 'cu1' }, data: { cancelledOrders: { increment: 1 } } });
  });

  it('the door’s own columns ride along, and cannot undo the shipment’s exit', async () => {
    await endOrder(input({ parcelInHand: true, data: { claimedById: null, shippingStatus: 'PACKING', labelPrintedAt: new Date() } }));

    expect(written().data.claimedById).toBeNull();
    // A door cannot keep a waybill or a status for a parcel that left the shipment.
    expect(written().data.shippingStatus).toBe('NOT_READY');
    expect(written().data.labelPrintedAt).toBeNull();
  });

  it('REJECTED keeps its word: the same exit, the same count, and NO event (it never was announced)', async () => {
    db.order.findFirst.mockResolvedValue(plain({ confirmationStatus: 'IN_PROGRESS' }));

    await endOrder(input({ endAs: 'REJECTED', door: 'CONFIRMATION' }));

    expect(written().data).toMatchObject({ confirmationStatus: 'REJECTED', status: 'REJECTED' });
    expect(db.customer.update).toHaveBeenCalledTimes(1);
    expect(emitAppEvent).not.toHaveBeenCalled();
  });

  it('FOLLOW_UP hands the order back alive: leaves the shipment, but is not a cancellation', async () => {
    await endOrder(input({
      kind: 'FOLLOW_UP', parcelInHand: true, reason: undefined, rejectionNote: undefined,
      data: { confirmationStatus: 'POSTPONED', status: 'POSTPONED', confirmedAt: null },
    }));

    expect(written().data).toMatchObject({
      confirmationStatus: 'POSTPONED', shippingStatus: 'NOT_READY', shippingBatchId: null, labelPrintedAt: null,
    });
    // Not a cancellation: no count against the customer, nothing announced, and no rejection reason invented.
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(emitAppEvent).not.toHaveBeenCalled();
    expect(written().data).not.toHaveProperty('rejectionReason');
    const log = db.orderStatusLog.create.mock.calls[0][0].data;
    expect(log).toMatchObject({ statusType: 'CONFIRMATION', previousValue: 'CONFIRMED', newValue: 'POSTPONED' });
  });

  it('an approved request is marked carried out in the SAME transaction, once', async () => {
    await endOrder(input({ parcelInHand: true, viaRequest: { id: 'r1' } }));

    expect(db.orderChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', appliedAt: null },
      data: { appliedAt: expect.any(Date), appliedById: 'u1' },
    });
  });
});

describe('no races — the write repeats what made the cancel allowed', () => {
  it('is conditional on version, trolley, barcode, claim and the trolley still being open', async () => {
    db.order.findFirst.mockResolvedValue(packed());

    await endOrder(input({ parcelInHand: true }));

    const where = written().where;
    expect(where).toMatchObject({
      id: 'o1', companyId: 'c1', version: 7, shippedAt: null,
      shippingBatchId: 'b1', trackingNumber: null, courierSendStartedAt: null,
      shippingBatch: { is: { status: 'READY' } },
    });
    expect(where.shippingStatus.notIn).toContain('SHIPPED');
  });

  it('an unbatched order carries no trolley condition', async () => {
    db.order.findFirst.mockResolvedValue(plain());

    await endOrder(input());

    expect(written().where.shippingBatchId).toBeNull();
    expect(written().where).not.toHaveProperty('shippingBatch');
  });

  it('LOSES the race to a press that landed first: nothing is released, logged, counted or announced', async () => {
    db.order.findFirst.mockResolvedValue(packed());
    db.order.updateMany.mockResolvedValue({ count: 0 });

    const out = await endOrder(input({ parcelInHand: true }));

    expect(out).toMatchObject({ ok: false, status: 409, code: 'ORDER_MOVED_ON' });
    expect(releaseOrderLines, 'رجعت قطع بعد خسارة السباق').not.toHaveBeenCalled();
    expect(db.orderStatusLog.create).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(emitAppEvent).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a dispatcher that claimed the order a moment after we read it is named: «الطرد قيد الترحيل الآن», not a vague refresh', async () => {
    db.order.findFirst
      .mockResolvedValueOnce(packed()) // what we read: no claim yet
      .mockResolvedValueOnce({ courierSendStartedAt: new Date() }); // what is there when our write found nothing
    db.order.updateMany.mockResolvedValue({ count: 0 });

    const out = await endOrder(input({ parcelInHand: true }));

    expect(out).toMatchObject({ ok: false, status: 409, code: 'SEND_IN_FLIGHT' });
    expect(out.ok ? '' : out.error).toContain('قيد الترحيل الآن');
  });

  it('a send in flight (a claim, no barcode yet) is not cancelled under the dispatcher', async () => {
    db.order.findFirst.mockResolvedValue(packed({ courierSendStartedAt: new Date() }));

    const out = await endOrder(input({ parcelInHand: true, inject: { adapter: adapterWith(async () => undefined), courierName: 'الباشا' } }));

    expect(out).toMatchObject({ ok: false, status: 409, code: 'SEND_IN_FLIGHT' });
    expect(out.ok ? '' : out.error).toContain('قيد الترحيل الآن');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('a parcel the company already holds a barcode for', () => {
  const withBarcode = () => packed({ trackingNumber: 'ALB-77812', courierSendStartedAt: new Date() });

  it('is cancelled THERE first, outside any transaction, and only then taken off our trolley', async () => {
    db.order.findFirst.mockResolvedValue(withBarcode());
    const adapter = adapterWith(async () => undefined);

    const out = await endOrder(input({ parcelInHand: true, inject: { adapter, courierName: 'الباشا' } }));

    expect(out).toMatchObject({ ok: true, courierCancelled: true });
    expect(adapter.cancelShipment).toHaveBeenCalledWith('ALB-77812');
    // Never inside a transaction: a hung call would hold row locks behind it.
    expect(adapter.cancelShipment.mock.invocationCallOrder[0]).toBeLessThan(db.$transaction.mock.invocationCallOrder[0]);
    // The write clears the barcode and the claim, and is conditional on the very barcode we cancelled.
    expect(written().where).toMatchObject({ trackingNumber: 'ALB-77812', courierSendStartedAt: { not: null } });
    expect(written().data).toMatchObject({ trackingNumber: null, courierSendStartedAt: null });
    const off = activities().find((a: any) => a.action === 'TAKEN_OFF_BATCH');
    expect(JSON.parse(off.metadata)).toMatchObject({ barcode: 'ALB-77812', courierCancelled: true });
  });

  it('on their REFUSAL shows their own words and changes nothing', async () => {
    db.order.findFirst.mockResolvedValue(withBarcode());
    const adapter = adapterWith(async () => {
      throw new CourierRefusal('الباشا رفض: الطرد مع السائق (400)', 400, 'الطرد مع السائق');
    });

    const out = await endOrder(input({ parcelInHand: true, inject: { adapter, courierName: 'الباشا' } }));

    expect(out).toMatchObject({ ok: false, status: 409, code: 'COURIER_REFUSED' });
    expect(out.ok ? '' : out.error).toContain('الطرد مع السائق');
    expect(db.$transaction, 'تغيّر الطلب بعد رفض الشركة').not.toHaveBeenCalled();
    expect(releaseOrderLines).not.toHaveBeenCalled();
  });

  it('on an answer nobody heard changes NOTHING and says the cancel was not confirmed', async () => {
    db.order.findFirst.mockResolvedValue(withBarcode());
    const adapter = adapterWith(async () => {
      throw markOutcomeUnknown(new Error('LOGESTECHS_TIMEOUT: لم تردّ شركةُ الشحن'));
    });

    const out = await endOrder(input({ parcelInHand: true, inject: { adapter, courierName: 'الباشا' } }));

    expect(out).toMatchObject({ ok: false, status: 409, code: 'COURIER_UNSURE' });
    expect(out.ok ? '' : out.error).toContain('لم يتأكد الإلغاء عند الباشا');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a dropped line (not even a timeout) is the same: unknown, nothing changes', async () => {
    db.order.findFirst.mockResolvedValue(withBarcode());
    const adapter = adapterWith(async () => {
      throw new TypeError('fetch failed');
    });

    const out = await endOrder(input({ parcelInHand: true, inject: { adapter, courierName: 'الباشا' } }));

    expect(out).toMatchObject({ ok: false, code: 'COURIER_UNSURE' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('if the company said yes but our write lost a race, it is said LOUDLY and recorded', async () => {
    db.order.findFirst.mockResolvedValue(withBarcode());
    db.order.updateMany.mockResolvedValue({ count: 0 });
    const adapter = adapterWith(async () => undefined);

    const out = await endOrder(input({ parcelInHand: true, inject: { adapter, courierName: 'الباشا' } }));

    expect(out).toMatchObject({ ok: false, code: 'COURIER_CANCELLED_BUT_MOVED' });
    expect(out.ok ? '' : out.error).toContain('ألغت الطرد');
    const last = db.orderActivity.create.mock.calls.at(-1)![0].data;
    expect(last).toMatchObject({ action: 'COURIER_CANCELLED_ORDER_MOVED' });
    expect(JSON.parse(last.metadata)).toMatchObject({ barcode: 'ALB-77812' });
  });

  it('NEGATIVE: a MANUAL courier’s typed number is only ours — nobody is called, and it is cleared', async () => {
    db.order.findFirst.mockResolvedValue(packed({ trackingNumber: 'TYPED-1' }));
    const manual = { code: 'MANUAL', name: 'يدوي', automated: false, createShipment: vi.fn(), fetchEvents: vi.fn(), mapStatus: vi.fn() };

    const out = await endOrder(input({ parcelInHand: true, inject: { adapter: manual as never } }));

    expect(out).toMatchObject({ ok: true, courierCancelled: false });
    expect(written().data.trackingNumber).toBeNull();
  });
});

describe('System 7 hears it once, after the commit', () => {
  it('a parcel with a shipping life announces the SHIPPING payload — never REJECTED in it', async () => {
    db.order.findFirst.mockResolvedValue(packed({ trackingNumber: null }));

    await endOrder(input({ parcelInHand: true }));

    expect(emitAppEvent).toHaveBeenCalledTimes(1);
    expect(emitAppEvent).toHaveBeenCalledWith('c1', 'order.cancelled', {
      orderId: 'o1',
      orderNumber: 'SY-2026-0148',
      shippingStatus: 'CANCELLED',
      previousStatus: 'READY_FOR_PICKUP',
      total: 185000,
      currency: 'SYP',
      trackingNumber: null,
    });
    expect(JSON.stringify(emitAppEvent.mock.calls[0])).not.toContain('REJECTED');
  });

  it('an order that never shipped announces the CONFIRMATION payload', async () => {
    db.order.findFirst.mockResolvedValue(plain());

    await endOrder(input());

    expect(emitAppEvent).toHaveBeenCalledWith('c1', 'order.cancelled', {
      orderId: 'o1',
      orderNumber: 'SY-2026-0148',
      confirmationStatus: 'CANCELLED',
      previousStatus: 'CONFIRMED',
      total: 185000,
      currency: 'SYP',
    });
  });

  it('and BOTH payloads validate against the published contract, byte for byte as the replies system reads it', async () => {
    const schema = readContract<Parameters<typeof validate>[0]>('schema.json');
    const bodyOf = (call: unknown[]) => ({ event: call[1], at: '2026-10-28T09:59:01.000Z', data: call[2] });

    db.order.findFirst.mockResolvedValue(packed({ trackingNumber: null }));
    await endOrder(input({ parcelInHand: true }));
    db.order.findFirst.mockResolvedValue(plain());
    await endOrder(input());

    expect(emitAppEvent).toHaveBeenCalledTimes(2);
    for (const call of emitAppEvent.mock.calls) {
      expect(validate(schema, bodyOf(call as unknown[])), JSON.stringify(call)).toEqual([]);
    }
  });

  it('is not announced from a transaction that rolled back', async () => {
    db.order.findFirst.mockResolvedValue(plain());
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await endOrder(input());

    expect(emitAppEvent).not.toHaveBeenCalled();
  });
});

describe('inside a transaction the caller already holds', () => {
  it('writes through THAT transaction and opens none of its own (the automatic close)', async () => {
    db.order.findFirst.mockResolvedValue(plain({ confirmationStatus: 'IN_PROGRESS' }));
    const tx = {
      order: { updateMany: vi.fn(async () => ({ count: 1 })) },
      orderStatusLog: { create: vi.fn(async () => ({})) },
      orderActivity: { create: vi.fn(async () => ({})) },
      orderNote: { create: vi.fn(async () => ({})) },
      customer: { update: vi.fn(async () => ({})) },
      orderChangeRequest: { updateMany: vi.fn() },
    };

    const out = await endOrder(input({ door: 'CONTACT_AUTO_CLOSE', tx: tx as never }));

    expect(out.ok).toBe(true);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany, 'كُتب خارج معاملة المستدعي').not.toHaveBeenCalled();
  });
});

describe('«أجّل الشحن» — a hold takes the parcel off the trolley and keeps the box as it is', () => {
  const hold = (over: Partial<HoldFromTrolleyInput> = {}): HoldFromTrolleyInput => ({
    orderId: 'o1', companyId: 'c1', storeId: 's1', by: BY, until: new Date('2026-11-05T00:00:00Z'), reason: 'الزبون مسافر',
    ...over,
  });

  it('keeps the waybill, the courier and the goods; clears only the trolley; sets the date', async () => {
    db.order.findFirst.mockResolvedValue(packed());

    const out = await holdFromTrolley(hold());

    expect(out).toMatchObject({ ok: true, orderNumber: 'SY-2026-0148', courierCancelled: false });
    const data = written().data;
    expect(data).toMatchObject({
      shippingBatchId: null,
      shippingStatus: 'READY_FOR_SHIPPING',
      settlementStatus: 'NOT_APPLICABLE',
      shipHoldUntil: new Date('2026-11-05T00:00:00Z'),
      shipHoldReason: 'الزبون مسافر',
    });
    // The box is not opened: the label, the courier and the confirmation stay.
    expect(data).not.toHaveProperty('labelPrintedAt');
    expect(data).not.toHaveProperty('deliveryProviderId');
    expect(data, 'محا رقماً مكتوباً على بوليصة باقية').not.toHaveProperty('trackingNumber');
    expect(data).not.toHaveProperty('confirmationStatus');
    expect(releaseOrderLines, 'رجعت قطع طرد مؤجَّل').not.toHaveBeenCalled();
    const off = activities().find((a: any) => a.action === 'TAKEN_OFF_BATCH');
    expect(JSON.parse(off.metadata)).toMatchObject({ door: 'HOLD', stock: 'KEPT' });
  });

  it('needs no word: nothing is counted back', async () => {
    db.order.findFirst.mockResolvedValue(packed());

    const out = await holdFromTrolley(hold());

    expect(out.ok).toBe(true);
    expect(activities().map((a: any) => a.action)).not.toContain('PARCEL_ATTESTED_IN_HAND');
  });

  it('postponing an API parcel is cancelling it there NOW, to be sent again later', async () => {
    db.order.findFirst.mockResolvedValue(packed({ trackingNumber: 'ALB-77812' }));
    const adapter = adapterWith(async () => undefined);

    const out = await holdFromTrolley(hold({ inject: { adapter, courierName: 'الباشا' } }));

    expect(out).toMatchObject({ ok: true, courierCancelled: true });
    expect(adapter.cancelShipment).toHaveBeenCalledWith('ALB-77812');
    expect(written().data).toMatchObject({ trackingNumber: null, courierSendStartedAt: null });
    expect(written().where).toMatchObject({ trackingNumber: 'ALB-77812' });
  });

  it('a number typed by hand for a courier nobody calls stays — it is on the label that stays', async () => {
    db.order.findFirst.mockResolvedValue(packed({ trackingNumber: 'TYPED-1' }));
    const manual = { code: 'MANUAL', name: 'يدوي', automated: false, createShipment: vi.fn(), fetchEvents: vi.fn(), mapStatus: vi.fn() };

    const out = await holdFromTrolley(hold({ inject: { adapter: manual as never } }));

    expect(out).toMatchObject({ ok: true, courierCancelled: false });
    expect(written().data).not.toHaveProperty('trackingNumber');
  });

  it('is refused when they refuse, or when we cannot tell — and nothing changes', async () => {
    db.order.findFirst.mockResolvedValue(packed({ trackingNumber: 'ALB-77812' }));
    const refusing = adapterWith(async () => {
      throw new CourierRefusal('x', 400, 'سلّمناه للسائق');
    });
    expect(await holdFromTrolley(hold({ inject: { adapter: refusing } }))).toMatchObject({ ok: false, code: 'COURIER_REFUSED' });

    const silent = adapterWith(async () => {
      throw markOutcomeUnknown(new Error('LOGESTECHS_TIMEOUT'));
    });
    expect(await holdFromTrolley(hold({ inject: { adapter: silent } }))).toMatchObject({ ok: false, code: 'COURIER_UNSURE' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('is refused once the courier has the trolley', async () => {
    db.order.findFirst.mockResolvedValue(packed({ shippingBatch: { status: 'SHIPPED', batchNumber: 'B' } }));

    expect(await holdFromTrolley(hold())).toMatchObject({ ok: false, code: 'CANCEL_AFTER_SHIPPED' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('loses a race like the cancel does, and marks an approved request applied only when it wins', async () => {
    db.order.findFirst.mockResolvedValue(packed());
    db.order.updateMany.mockResolvedValue({ count: 0 });
    expect(await holdFromTrolley(hold({ viaRequest: { id: 'r1' } }))).toMatchObject({ ok: false, code: 'ORDER_MOVED_ON' });
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();

    db.order.updateMany.mockResolvedValue({ count: 1 });
    await holdFromTrolley(hold({ viaRequest: { id: 'r1' } }));
    expect(db.orderChangeRequest.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('the trolley’s status is something every door must ask for', () => {
  it('reads null when there is no trolley, and the status when there is', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY' });

    expect(await batchStatusOf(db, null)).toBeNull();
    expect(db.shippingBatch.findFirst).not.toHaveBeenCalled();
    expect(await batchStatusOf(db, 'b1')).toBe('READY');
  });
});
