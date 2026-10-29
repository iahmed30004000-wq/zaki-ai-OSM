import { beforeEach, describe, expect, it, vi } from 'vitest';
const { db, requireContext, createReplacement, logAudit } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), update: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  createReplacement: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/replacement-order', () => ({ createReplacement: (...a: unknown[]) => createReplacement(...a) }));

import { assertCompanyHoldsIt, planTransfer, TransferRefused, type TransferParty } from '@/lib/courier-transfer';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A REPLACEMENT TAKES A PARCEL BACK FROM A COMPANY — NOT FROM OUR TROLLEY.
 *
 * `READY_FOR_PICKUP` is accepted by the transfer rules because an agent's
 * parcel wears it all day. For a COMPANY's parcel the same status also
 * means «packed and waiting on our trolley, the company has not come yet».
 * Moving that one with REPLACE raised a second live order for the same
 * goods, reserved them twice, and left the first in its batch under its own
 * barcode.
 *
 * The old rule about WHICH STATUSES may transfer is untouched
 * (`courier-transfer.test.ts`); this is the extra question, asked after it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const aramex: TransferParty = { id: 'co1', name: 'أرامكس', kind: 'COMPANY' };
const other: TransferParty = { id: 'co2', name: 'شركة أخرى', kind: 'COMPANY' };
const agent: TransferParty = { id: 'ag1', name: 'أبو علي', kind: 'AGENT' };

describe('assertCompanyHoldsIt', () => {
  const replace = () => planTransfer({ from: aramex, to: other, shippingStatus: 'READY_FOR_PICKUP' });

  it('refuses a replacement while the parcel is on our trolley', () => {
    expect(() => assertCompanyHoldsIt(replace(), { shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, batchStatus: 'READY' }))
      .toThrow(TransferRefused);
    try {
      assertCompanyHoldsIt(replace(), { shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, batchStatus: 'READY' });
    } catch (e) {
      expect((e as TransferRefused).code).toBe('STILL_ON_OUR_TROLLEY');
    }
  });

  it('refuses it with no batch at all just the same', () => {
    expect(() => assertCompanyHoldsIt(replace(), { shippingStatus: 'READY_FOR_PICKUP' })).toThrow(/لسّا عندنا/);
  });

  it('lets it through once the trolley was handed over', () => {
    expect(() => assertCompanyHoldsIt(replace(), { shippingStatus: 'READY_FOR_PICKUP', batchStatus: 'SHIPPED' })).not.toThrow();
  });

  it.each(['SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY'])('lets a %s parcel through — the company holds it', (s) => {
    const plan = planTransfer({ from: aramex, to: other, shippingStatus: s });
    expect(() => assertCompanyHoldsIt(plan, { shippingStatus: s, shippedAt: null })).not.toThrow();
  });

  it('lets it through when only the stamp says it left', () => {
    expect(() => assertCompanyHoldsIt(replace(), { shippingStatus: 'READY_FOR_PICKUP', shippedAt: new Date() })).not.toThrow();
  });

  it('never touches the direct move away from an agent, which is immediate', () => {
    const direct = planTransfer({ from: agent, to: aramex, shippingStatus: 'READY_FOR_PICKUP' });
    expect(direct.mode).toBe('DIRECT');
    expect(() => assertCompanyHoldsIt(direct, { shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, batchStatus: 'READY' })).not.toThrow();
  });
});

describe('the transfer door', () => {
  const TO = '55555555-5555-4555-8555-555555555555';
  const ORDER_ID = '66666666-6666-4666-8666-666666666666';

  const stored = (over: Record<string, unknown> = {}) => ({
    id: ORDER_ID, orderNumber: 'SY-1', version: 5, shippingStatus: 'READY_FOR_PICKUP', shippedAt: null,
    deliveryProvider: { id: 'co1', name: 'أرامكس', kind: 'COMPANY' },
    replacedBy: null,
    shippingBatch: { status: 'READY' },
    ...over,
  });

  const transfer = async () => {
    const { POST } = await import('@/app/api/ops/tracking/transfer/route');
    const res = await POST(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ORDER_ID, toProviderId: TO }),
      })
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    requireContext.mockResolvedValue({
      user: { id: 'u1', name: 'م', role: 'DELIVERY_MANAGER' },
      companyId: 'c1', storeId: 's1',
      country: { orderPrefix: 'SY', minorUnit: 2, allowNegativeStock: false },
    });
    db.deliveryProvider.findFirst.mockResolvedValue({ id: TO, name: 'شركة أخرى', kind: 'COMPANY' });
    db.shippingBatch.findFirst.mockResolvedValue({ id: 'open-batch', batchNumber: 'B-9' });
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.order.update.mockResolvedValue({});
    createReplacement.mockResolvedValue({ id: 'rep1', orderNumber: 'SY-2' });
    db.orderActivity.create.mockResolvedValue({});
  });

  it('refuses a replacement for a parcel still on our trolley, and creates nothing', async () => {
    db.order.findFirst.mockResolvedValue(stored());

    const res = await transfer();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('STILL_ON_OUR_TROLLEY');
    expect(createReplacement, 'صدر طلب بديل لطرد ما غادر').not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('still replaces a parcel the company already holds — the negative', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'SHIPPED', shippedAt: new Date(), shippingBatch: { status: 'SHIPPED' } }));

    const res = await transfer();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(createReplacement).toHaveBeenCalledTimes(1);
  });

  it('writes the company leg only at the version it read — two presses make one replacement', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'SHIPPED', shippedAt: new Date(), shippingBatch: { status: 'SHIPPED' } }));

    await transfer();

    expect(db.order.update.mock.calls[0][0].where).toMatchObject({ id: ORDER_ID, version: 5 });
  });

  it('and the second press, finding the version moved, stops with a plain sentence', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'SHIPPED', shippedAt: new Date(), shippingBatch: { status: 'SHIPPED' } }));
    db.order.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));

    const res = await transfer();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(createReplacement).not.toHaveBeenCalled();
  });
});
