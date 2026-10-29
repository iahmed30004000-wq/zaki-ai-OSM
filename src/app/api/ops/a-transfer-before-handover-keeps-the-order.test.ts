import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CourierRefusal } from '@/lib/couriers/logestechs';

const { db, requireContext, createReplacement, logAudit, releaseOrderLines, adapterFor, emitAppEvent } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  createReplacement: vi.fn(),
  logAudit: vi.fn(),
  releaseOrderLines: vi.fn(),
  adapterFor: vi.fn(),
  emitAppEvent: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/replacement-order', () => ({ createReplacement: (...a: unknown[]) => createReplacement(...a) }));
vi.mock('@/lib/reservation', () => ({ releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...a) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => emitAppEvent(...a) }));
vi.mock('@/lib/couriers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adapterFor: (...a: unknown[]) => adapterFor(...a),
}));

/**
 * ═══════════════════════════════════════════════════════════════════════
 * BEFORE THE COMPANY TOOK THE PARCEL, A TRANSFER MOVES THE SAME ORDER.
 *
 * (old → new) This file was `a-parcel-on-our-trolley-is-not-replaced-away-from-a-company`
 * (#59). It asserted the interim answer: a REPLACE for a parcel still on our
 * trolley is refused `STILL_ON_OUR_TROLLEY`, because it raised a second live
 * order for the same goods and reserved them twice. That refusal named PR O as
 * the fix, and this is PR O: the refusal is gone (the bug it stood in front of
 * is fixed at the root) and the same press now moves the order itself — same id,
 * same number, same reservation — onto the new company's trolley.
 *
 * What stayed: nothing is ever raised for a parcel nobody took back, and the
 * parcel the company DOES hold is still replaced, at the version it was read at.
 * ═══════════════════════════════════════════════════════════════════════
 */

const TO = '55555555-5555-4555-8555-555555555555';
const ORDER_ID = '66666666-6666-4666-8666-666666666666';

const stored = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-1', version: 5, confirmationStatus: 'CONFIRMED',
  shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: null,
  shippingBatchId: 'old-batch', deliveryProviderId: 'co1', trackingNumber: null, courierSendStartedAt: null,
  totalAmount: 25, currency: 'JOD', customerId: 'cu1',
  deliveryProvider: { id: 'co1', name: 'أرامكس', kind: 'COMPANY' },
  replacedBy: null,
  shippingBatch: { status: 'READY', batchNumber: 'B-1' },
  ...over,
});

const transfer = async (body: Record<string, unknown> = {}) => {
  const { POST } = await import('@/app/api/ops/tracking/transfer/route');
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID, toProviderId: TO, ...body }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const written = () => db.order.updateMany.mock.calls[0][0] as { where: Record<string, any>; data: Record<string, any> };
const activities = () => db.orderActivity.create.mock.calls.map((c: any[]) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'م', role: 'DELIVERY_MANAGER' },
    companyId: 'c1', storeId: 's1',
    country: { orderPrefix: 'SY', minorUnit: 2, allowNegativeStock: false },
  });
  // The route reads the new courier, the helper reads the old one's account: both are a manual company.
  db.deliveryProvider.findFirst.mockResolvedValue({ id: TO, name: 'شركة أخرى', kind: 'COMPANY', code: 'X', adapterCode: null, apiEnabled: false });
  adapterFor.mockReturnValue({ automated: false, code: 'MANUAL', name: 'يدوي' });
  db.shippingBatch.findFirst.mockResolvedValue({ id: 'open-batch', batchNumber: 'B-9' });
  db.shippingBatch.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.order.update.mockResolvedValue({});
  db.order.updateMany.mockResolvedValue({ count: 1 });
  createReplacement.mockResolvedValue({ id: 'rep1', orderNumber: 'SY-2' });
  db.orderActivity.create.mockResolvedValue({});
});

describe('a parcel the company never took — the same order moves', () => {
  it('moves it to the new trolley and raises NOTHING', async () => {
    db.order.findFirst.mockResolvedValue(stored());

    const res = await transfer();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mode).toBe('REBATCH');
    expect(res.body.replacement).toBeNull();
    expect(res.body.orderNumber).toBe('SY-1');
    expect(createReplacement, 'صدر طلب بديل لطرد ما غادر').not.toHaveBeenCalled();
    expect(db.order.update, 'انكتب على الطلب القديم كأنه رجع').not.toHaveBeenCalled();
    expect(releaseOrderLines, 'رجعت قطع الطرد للرف بتحويله').not.toHaveBeenCalled();
  });

  it('writes ONE update on the SAME id: new company, new trolley, no barcode, the status untouched', async () => {
    db.order.findFirst.mockResolvedValue(stored());

    await transfer();

    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = written();
    expect(where).toMatchObject({ id: ORDER_ID, version: 5, shippedAt: null });
    expect(data).toMatchObject({
      deliveryProviderId: TO,
      shippingBatchId: 'open-batch',
      trackingNumber: null,
      courierSendStartedAt: null,
      labelPrintedAt: null,
      version: { increment: 1 },
    });
    // The status is not written: READY_FOR_PICKUP is the fact «packed», and it must not move.
    expect(data).not.toHaveProperty('shippingStatus');
    expect(data).not.toHaveProperty('returnReason');
  });

  it('is conditional on everything it read — a press, a dispatch or a second press that lands first wins', async () => {
    db.order.findFirst.mockResolvedValue(stored({ trackingNumber: 'T1', courierSendStartedAt: new Date() }));

    await transfer();

    const { where } = written();
    expect(where.version).toBe(5);
    expect(where.shippedAt).toBeNull();
    expect(where.shippingStatus).toEqual({ notIn: expect.arrayContaining(['SHIPPED', 'OUT_FOR_DELIVERY']) });
    expect(where.shippingBatchId).toBe('old-batch');
    expect(where.trackingNumber).toBe('T1');
    expect(where.courierSendStartedAt).toEqual({ not: null });
    expect(where.shippingBatch).toEqual({ is: { status: 'READY' } });
  });

  it('records it as a REBATCH — never the word `REPLACE`, which would make the order read as superseded', async () => {
    db.order.findFirst.mockResolvedValue(stored());

    await transfer({ note: 'الزبون طلب شركة ثانية' });

    const moved = activities().find((a: any) => a.action === 'COURIER_TRANSFERRED');
    expect(moved.orderId).toBe(ORDER_ID);
    expect(moved.metadata).toContain('"mode":"REBATCH"');
    expect(moved.metadata).not.toContain('"mode":"REPLACE"');
    expect(moved.metadata).toContain('"stock":"KEPT"');
    expect(JSON.parse(moved.metadata)).toMatchObject({ from: 'أرامكس', to: 'شركة أخرى', note: 'الزبون طلب شركة ثانية', batch: 'B-1' });
  });

  it('puts it on a trolley of the NEW company, taking that trolley’s lock while it is still being filled', async () => {
    db.order.findFirst.mockResolvedValue(stored());

    await transfer();

    const lock = db.shippingBatch.updateMany.mock.calls[0][0];
    expect(lock.where).toMatchObject({ id: 'open-batch', status: 'READY', deliveryProviderId: TO });
    // The lock comes first, the order write second: the press takes them in that order too.
    expect(db.shippingBatch.updateMany.mock.invocationCallOrder[0]).toBeLessThan(db.order.updateMany.mock.invocationCallOrder[0]);
  });

  it('answers a trolley pressed a moment ago with a plain sentence, and writes nothing on the order', async () => {
    db.order.findFirst.mockResolvedValue(stored());
    db.shippingBatch.updateMany.mockResolvedValue({ count: 0 });

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TARGET_BATCH_CLOSED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(activities().some((a: any) => a.action === 'COURIER_TRANSFERRED')).toBe(false);
  });

  it('still needs an open trolley for a company — and says so', async () => {
    db.order.findFirst.mockResolvedValue(stored());
    db.shippingBatch.findFirst.mockResolvedValue(null);

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_OPEN_BATCH');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('moves it to a مندوب with no trolley at all — he takes it by hand', async () => {
    db.order.findFirst.mockResolvedValue(stored());
    db.deliveryProvider.findFirst.mockResolvedValue({ id: TO, name: 'سامر', kind: 'AGENT', code: 'S', adapterCode: null, apiEnabled: false });

    const res = await transfer();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(written().data.shippingBatchId).toBeNull();
    expect(db.shippingBatch.updateMany).not.toHaveBeenCalled();
  });

  it('a parcel on no trolley at all (assigned to a company, never batched) moves the same way', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingBatchId: null, shippingBatch: null }));

    const res = await transfer();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(written().where.shippingBatchId).toBeNull();
    expect(createReplacement).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the trolley it names cannot be read', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingBatch: null }));

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UNKNOWN_BATCH');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(createReplacement).not.toHaveBeenCalled();
  });

  it('the two presses make one move: the second finds the version moved and says so', async () => {
    db.order.findFirst.mockResolvedValue(stored());
    db.order.updateMany.mockResolvedValue({ count: 0 });

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_MOVED_ON');
    expect(activities().some((a: any) => a.action === 'COURIER_TRANSFERRED')).toBe(false);
    expect(createReplacement).not.toHaveBeenCalled();
  });

  it('refuses when somebody else already moved it to another company between the look and the press', async () => {
    db.order.findFirst
      .mockResolvedValueOnce(stored())
      .mockResolvedValueOnce(stored({ deliveryProviderId: 'someone-else' }));

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_MOVED_ON');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses the instant the trolley was pressed under the screen — the parcel is the company’s now', async () => {
    // The route read it as «not handed» and the helper reads it again, pressed.
    db.order.findFirst
      .mockResolvedValueOnce(stored())
      .mockResolvedValueOnce(stored({ shippingBatch: { status: 'SHIPPED', batchNumber: 'B-1' } }));

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HANDED_OVER');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('a printed waybill goes only on a person’s word', () => {
  it('without the word: asks for it, names the sentence, and writes nothing', async () => {
    db.order.findFirst.mockResolvedValue(stored({ labelPrintedAt: new Date('2026-10-28T08:00:00Z') }));

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ATTESTATION_REQUIRED');
    expect(res.body.attestation).toContain('أتلفتُ بوليصته القديمة');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.shippingBatch.updateMany).not.toHaveBeenCalled();
  });

  it('with the word: moves it, clears the stale waybill, and records the word with the person’s name', async () => {
    db.order.findFirst.mockResolvedValue(stored({ labelPrintedAt: new Date('2026-10-28T08:00:00Z') }));

    const res = await transfer({ parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(written().data.labelPrintedAt).toBeNull();
    const said = activities().find((a: any) => a.action === 'PARCEL_ATTESTED_IN_HAND');
    expect(said.userId).toBe('u1');
    expect(JSON.parse(said.metadata)).toMatchObject({ kind: 'WAYBILL', by: 'م' });
    expect(logAudit.mock.calls.map((c: any[]) => c[0].action)).toContain('PARCEL_ATTESTED_IN_HAND');
    expect(res.body.message).toContain('بوليصة جديدة');
  });

  it('NEGATIVE: a parcel with no waybill is asked for no word at all', async () => {
    db.order.findFirst.mockResolvedValue(stored({ labelPrintedAt: null }));

    const res = await transfer();

    expect(res.status).toBe(200);
    expect(activities().some((a: any) => a.action === 'PARCEL_ATTESTED_IN_HAND')).toBe(false);
  });

  it('NEGATIVE: the word does not let a pressed trolley through', async () => {
    db.order.findFirst.mockResolvedValue(
      stored({ labelPrintedAt: new Date(), shippingBatch: { status: 'SHIPPED', batchNumber: 'B-1' } })
    );

    const res = await transfer({ parcelInHand: true });

    // The route sees a handed-over parcel and takes the replacement road, as it always did.
    expect(res.body.mode).toBe('REPLACE');
    expect(createReplacement).toHaveBeenCalledTimes(1);
  });
});

describe('a barcode at an API company is cancelled THERE first', () => {
  const barcoded = () => stored({ trackingNumber: 'LG-77', courierSendStartedAt: new Date() });
  const apiAdapter = (cancelShipment: () => Promise<void>) => ({
    automated: true, code: 'LOGESTECHS', name: 'LogesTechs', cancelShipment: vi.fn(cancelShipment),
  });

  it('asks the company, and on a clear yes moves the order and drops the barcode and the claim', async () => {
    db.order.findFirst.mockResolvedValue(barcoded());
    const adapter = apiAdapter(async () => undefined);
    adapterFor.mockReturnValue(adapter);

    const res = await transfer();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(adapter.cancelShipment).toHaveBeenCalledWith('LG-77');
    expect(written().data).toMatchObject({ trackingNumber: null, courierSendStartedAt: null });
    expect(res.body.message).toContain('ألغينا الطرد');
  });

  it('on the company’s refusal: their words, and NOTHING changes on the order', async () => {
    db.order.findFirst.mockResolvedValue(barcoded());
    adapterFor.mockReturnValue(apiAdapter(async () => { throw new CourierRefusal('refused', 400, 'الطرد خرج مع السائق'); }));

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COURIER_REFUSED');
    expect(res.body.error).toContain('الطرد خرج مع السائق');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('on an answer nobody heard: changes nothing and says it is not sure', async () => {
    db.order.findFirst.mockResolvedValue(barcoded());
    adapterFor.mockReturnValue(apiAdapter(async () => { throw new Error('timeout'); }));

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COURIER_UNSURE');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a send still in flight is not moved: the parcel may be coming into existence right now', async () => {
    db.order.findFirst.mockResolvedValue(stored({ trackingNumber: null, courierSendStartedAt: new Date() }));
    adapterFor.mockReturnValue(apiAdapter(async () => undefined));

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEND_IN_FLIGHT');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('if the company said yes and the write then lost its race, the order says so — never silent', async () => {
    db.order.findFirst.mockResolvedValue(barcoded());
    adapterFor.mockReturnValue(apiAdapter(async () => undefined));
    db.order.updateMany.mockResolvedValue({ count: 0 });

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COURIER_CANCELLED_BUT_MOVED');
    expect(activities().some((a: any) => a.action === 'COURIER_CANCELLED_ORDER_MOVED')).toBe(true);
  });
});

describe('a parcel the company already holds is still replaced — the negative', () => {
  const held = (over: Record<string, unknown> = {}) =>
    stored({ shippingStatus: 'SHIPPED', shippedAt: new Date(), shippingBatch: { status: 'SHIPPED', batchNumber: 'B-1' }, ...over });

  it('raises the replacement for an order whose trolley was pressed', async () => {
    db.order.findFirst.mockResolvedValue(held());

    const res = await transfer();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mode).toBe('REPLACE');
    expect(createReplacement).toHaveBeenCalledTimes(1);
  });

  it('a pressed trolley with the order’s own status never moved is replaced too — the batch is the fact', async () => {
    db.order.findFirst.mockResolvedValue(held({ shippingStatus: 'READY_FOR_PICKUP', shippedAt: null }));

    const res = await transfer();

    expect(res.body.mode).toBe('REPLACE');
    expect(createReplacement).toHaveBeenCalledTimes(1);
  });

  it('writes the company leg only at the version it read — two presses make one replacement', async () => {
    db.order.findFirst.mockResolvedValue(held());

    await transfer();

    expect(db.order.update.mock.calls[0][0].where).toMatchObject({ id: ORDER_ID, version: 5 });
  });

  it('and the second press, finding the version moved, stops with a plain sentence', async () => {
    db.order.findFirst.mockResolvedValue(held());
    db.order.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(createReplacement).not.toHaveBeenCalled();
  });

  it('after the journey ended nothing moves at all', async () => {
    db.order.findFirst.mockResolvedValue(held({ shippingStatus: 'DELIVERED' }));

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_TRANSFERABLE');
    expect(createReplacement).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});
