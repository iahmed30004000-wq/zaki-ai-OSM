import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EACH OPERATIONS DOOR ASKS ITS OWN KEY (perm-plan PR-8) — AND THE KEY IT USED TO ASK NO LONGER OPENS IT.
 *
 *   tracking/deliver       ops.track            →  ops.deliver
 *   tracking/transfer      ops.track            →  ops.transfer      (the packing-table half still asks ops.ship as well)
 *   tracking/write-off     finance.update | orders.unlock (a catch-chain)  →  ops.write_off, ONE key, no fallback
 *   returns POST           ops.returns          →  + ops.return_fee  for the fee tick-box only
 *   stand-down             ops.ship            →  UNCHANGED, on purpose (moving it onto orders.cancel would widen that key)
 *   shipping-batches GET   ops.ship | ops.track →  ops.batches       (its two routes are in
 *                                                   `money-and-customers-stay-with-their-keys.test.ts`)
 *
 * Each has its NEGATIVE: the old key alone is a 403 that writes nothing, and the new key alone gets past the gate.
 *
 * HOW THE GATE IS SEEN. The gate is the first thing each handler asks after the context, so a request with an EMPTY body
 * shows it: a refusal is a 403, and a request that got past the gate is stopped by the body’s own check (400) or by the
 * lookup that follows (404). Neither is a 403, and nothing was read or written for the first.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, held } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(async () => null), update: vi.fn(), findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    orderChangeRequest: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn(async () => null) },
    returnReceipt: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  held: { keys: new Set<string>() },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => held.keys.has(k),
  requirePermission: async (k: string) => {
    if (!held.keys.has(k)) throw new Error(`Forbidden: missing required permission ${k}`);
    return {};
  },
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/commission', () => ({ reverseForOrder: vi.fn() }));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines: vi.fn(), releaseOrderLines: vi.fn() }));
vi.mock('@/lib/order-cancel', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  endOrder: vi.fn(async () => ({ ok: true, orderNumber: 'SY-1' })),
}));

import { POST as deliver } from '@/app/api/ops/tracking/deliver/route';
import { POST as transfer } from '@/app/api/ops/tracking/transfer/route';
import { POST as writeOff } from '@/app/api/ops/tracking/write-off/route';
import { POST as receiveReturn } from '@/app/api/ops/returns/route';
import { POST as standDown } from '@/app/api/ops/shipments/stand-down/route';

const ID = '99999999-9999-4999-8999-999999999999';
const holding = (...keys: string[]) => {
  held.keys = new Set(keys);
};
const send = async (post: (r: Request) => Promise<Response>, body: unknown) => {
  const res = await post(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const nothingWasTouched = () => {
  expect(db.order.findFirst, 'قرأ الباب طلباً بعد الرفض').not.toHaveBeenCalled();
  expect(db.order.update, 'كتب الباب بعد الرفض').not.toHaveBeenCalled();
  expect(db.returnReceipt.create).not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  holding();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'عامل', role: 'MODERATOR', status: 'ACTIVE' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 3, currencyCode: 'JOD', allowNegativeStock: false },
  });
});

describe('recording the delivery outcome asks ops.deliver', () => {
  it('the tracking key alone is refused — and nothing is read or written', async () => {
    holding('ops.track');
    const res = await send(deliver, {});
    expect(res.status).toBe(403);
    nothingWasTouched();
  });

  it('NEGATIVE: the box alone gets past the gate (the body’s own check stops the empty request)', async () => {
    holding('ops.deliver');
    expect((await send(deliver, {})).status).toBe(400);
  });

  it('the chain the old gate could have been read as does not exist: neither the transfer box nor the write-off box opens it', async () => {
    holding('ops.transfer', 'ops.write_off', 'orders.change_status', 'finance.update');
    expect((await send(deliver, {})).status).toBe(403);
  });
});

describe('moving a parcel to another courier asks ops.transfer', () => {
  it('the tracking key alone is refused', async () => {
    holding('ops.track', 'ops.ship');
    const res = await send(transfer, {});
    expect(res.status).toBe(403);
    nothingWasTouched();
  });

  it('NEGATIVE: the box alone gets past the first gate', async () => {
    holding('ops.transfer');
    expect((await send(transfer, {})).status).toBe(400);
  });
});

describe('closing a lost parcel as a loss asks ops.write_off — one key, no catch-chain', () => {
  it('finance.update alone is refused, and so is orders.unlock alone, and so are both together', async () => {
    for (const keys of [['finance.update'], ['orders.unlock'], ['finance.update', 'orders.unlock', 'ops.track']]) {
      holding(...keys);
      const res = await send(writeOff, {});
      expect(res.status, keys.join('+')).toBe(403);
      nothingWasTouched();
    }
  });

  it('NEGATIVE: the box alone gets past the gate', async () => {
    holding('ops.write_off');
    expect((await send(writeOff, {})).status).toBe(400);
  });

  it('the source has no catch fallback left on the gate', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/ops/tracking/write-off/route.ts'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(src).toContain("requirePermission('ops.write_off')");
    expect(src).not.toMatch(/requirePermission\([^)]*\)\.catch/);
    expect(src).not.toContain("requirePermission('finance.update')");
    expect(src).not.toContain("requirePermission('orders.unlock')");
  });
});

describe('charging the courier a return fee asks ops.return_fee — receiving the return does not', () => {
  const body = (over: Record<string, unknown> = {}) => ({ orderId: ID, receivedQty: 3, countedAndInspected: true, ...over });

  it('with the fee ticked and without the box: 403, before the order is even read, and nothing is written', async () => {
    holding('ops.returns');
    const res = await send(receiveReturn, body({ chargeCourierFee: true }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RETURN_FEE_FORBIDDEN');
    nothingWasTouched();
  });

  it('NEGATIVE: the same receiver, the fee NOT ticked, gets past (the order lookup is what answers)', async () => {
    holding('ops.returns');
    const res = await send(receiveReturn, body({ chargeCourierFee: false }));
    expect(res.status).toBe(404);
    expect(db.order.findFirst).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: and so does a request that does not mention the fee at all', async () => {
    holding('ops.returns');
    expect((await send(receiveReturn, body())).status).toBe(404);
  });

  it('with the box, the fee ticked passes the gate', async () => {
    holding('ops.returns', 'ops.return_fee');
    expect((await send(receiveReturn, body({ chargeCourierFee: true }))).status).toBe(404);
  });

  it('the box without the returns key is still a 403: the fee rides on the desk', async () => {
    holding('ops.return_fee');
    expect((await send(receiveReturn, body({ chargeCourierFee: true }))).status).toBe(403);
  });
});

describe('standing a confirmed order down is NOT moved in this change — it keeps asking ops.ship', () => {
  const press = (over: Record<string, unknown> = {}) => send(standDown, { orderId: ID, outcome: 'CANCEL', reason: 'OTHER', note: 'سبب مكتوب', ...over });

  it('the packing key still opens it (the order lookup answers: 404), and nothing is refused', async () => {
    holding('ops.ship');
    expect((await press()).status).toBe(404);
    expect(db.order.findFirst).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: the cancel box and the new operations boxes do not open it', async () => {
    holding('orders.cancel', 'orders.unlock', 'ops.batches', 'ops.deliver', 'ops.transfer', 'ops.write_off');
    expect((await press()).status).toBe(403);
    nothingWasTouched();
  });

  it('the approved-request branch is untouched too: the packing key or the desk carry out a decision, the cancel box alone does not', async () => {
    const request = { id: ID, orderId: ID, status: 'APPROVED', appliedAt: null, intent: 'CANCEL', reason: 'الزبون ندم', requestedById: 'u9', postponeUntil: null, cancelReason: 'OTHER' };
    db.orderChangeRequest.findFirst.mockResolvedValue(request);
    holding('ops.ship');
    expect((await press({ changeRequestId: ID })).status).toBe(404);
    holding('control.change_requests');
    expect((await press({ changeRequestId: ID })).status).toBe(404);
    holding('orders.cancel');
    expect((await press({ changeRequestId: ID })).status).toBe(403);
  });
});
