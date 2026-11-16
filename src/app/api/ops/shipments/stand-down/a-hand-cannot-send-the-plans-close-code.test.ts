import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PLAN'S CLOSE CODE IS NOT A REASON A HAND MAY SEND TO THE STAND-DOWN DOOR (review round 1 of step B, ruling 6)
 *
 * The direct path of this door (no `changeRequestId`, under `ops.ship`) cancels a CONFIRMED order for any value in `REJECTION_REASONS`. `NO_ANSWER_5_ATTEMPTS`
 * joined that list with the plan, so a hand-made body that carried it — which got «سبب الإلغاء مطلوب» (400) before the code existed — would have cancelled the
 * order under a reason only the contact door writes, filed it as OUR_REACH in the loss report and made it win-back ready, with the switch OFF as well.
 *
 *  1. `CANCEL` + `NO_ANSWER_5_ATTEMPTS` = 400 CANCEL_REASON_REQUIRED, the body an unknown value gets, and nothing is written, switch or no switch (the door never reads it).
 *  2. A real reason still cancels (200, one conditional write) — the door is otherwise untouched.
 *
 * Not touched, on purpose: the OLD code `NO_ANSWER_3_ATTEMPTS` keeps its behaviour here (RV2389, an open gap that predates the plan).
 * Blockers: no money, no order creation, no migration, no `contracts/`, no external model.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, releaseOrderLines, emitAppEvent, logAudit, notify } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { create: vi.fn(async () => ({})) },
    orderActivity: { create: vi.fn(async () => ({})) },
    orderNote: { create: vi.fn(async () => ({})) },
    customer: { update: vi.fn(async () => ({})) },
    shippingBatch: { findFirst: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  releaseOrderLines: vi.fn(async (..._a: unknown[]) => 2),
  emitAppEvent: vi.fn(async (..._a: unknown[]) => 1),
  logAudit: vi.fn(async (..._a: unknown[]) => undefined),
  notify: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', async (orig) => ({ ...(await orig<Record<string, unknown>>()), requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/reservation', () => ({ releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...a) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => emitAppEvent(...a) }));

import { POST } from './route';

const ORDER_ID = '88888888-8888-4888-8888-888888888888';

/** A confirmed order in no batch, nothing printed, nothing shipped — the row both the door and the helper read. */
const stored = () => ({
  id: ORDER_ID, orderNumber: 'SY-5', version: 4, confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null, shippingBatchId: null, shippingBatch: null,
  trackingNumber: null, deliveryProviderId: null, courierSendStartedAt: null,
  regionId: 'r1', deliveryFee: 3, totalAmount: 80, currency: 'JOD', customerId: 'cu1', claimedById: 'salma',
});

async function cancelWith(reason: string) {
  requireContext.mockResolvedValue({
    user: { id: 'u1', email: 'u1@x', name: 'u1', role: 'ADMIN', status: 'ACTIVE', companyId: 'c1' },
    companyId: 'c1',
    storeId: 's1',
  });
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID, outcome: 'CANCEL', reason }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.order.findFirst.mockResolvedValue(stored());
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('the plan’s close code sent by a hand, on the direct path', () => {
  it('is answered exactly like an unknown reason, and nothing is written', async () => {
    const five = await cancelWith('NO_ANSWER_5_ATTEMPTS');
    const unknown = await cancelWith('NOT_A_REASON');

    expect(five.status, JSON.stringify(five.body)).toBe(400);
    expect(five.body.code).toBe('CANCEL_REASON_REQUIRED');
    expect(five.body).toEqual(unknown.body);
    expect(db.$transaction, 'انفتحت معاملة').not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(releaseOrderLines).not.toHaveBeenCalled();
    expect(emitAppEvent).not.toHaveBeenCalled();
  });

  it('a real reason still cancels, once', async () => {
    const res = await cancelWith('CUSTOMER_CHANGED_MIND');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });
});
