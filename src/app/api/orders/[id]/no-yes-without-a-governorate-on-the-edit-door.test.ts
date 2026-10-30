import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REGION_REQUIRED_MESSAGE } from '@/lib/confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * NO CONFIRMATION WITHOUT A GOVERNORATE — THE EDIT DOOR (30/10).
 *
 * `PATCH /api/orders/[id]` is the second door to the same decision: with `orders.unlock` and a written reason it moves
 * `status` / `confirmationStatus` to CONFIRMED. The confirmation door refuses an order with no governorate
 * (`no-yes-without-a-governorate.test.ts` next to it); this door must not be the way round.
 *
 * DEFINITION OF DONE for this file:
 *   · the override moving an order WITHOUT a governorate to CONFIRMED — by `status` or by `confirmationStatus` ⇒ 409
 *     `REGION_REQUIRED`, nothing written;
 *   · the same request that SETS a governorate and confirms is fine (the governorate the order WILL have counts);
 *   · a CONFIRMED order keeps its governorate: `regionId: null` ⇒ 409 `REGION_REQUIRED`;
 *   · NEGATIVE: clearing it on an order that is not confirmed yet is still allowed, and the door that is not the
 *     override's still answers `USE_CONFIRMATION_DOOR`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, createNotification, can } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn() },
    region: { findFirst: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    customer: { update: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderContactAttempt: { count: vi.fn(async () => 1) },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  createNotification: vi.fn(),
  can: vi.fn(),
}));

const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const REGION_ID = '99999999-2222-4333-8444-555555555555';
let ORDER: Record<string, unknown>;

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/authorization', () => ({
  authorize: () => ({ allowed: true }),
  can: (...a: unknown[]) => can(...a),
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
}));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: async () => ({ allowed: true, order: ORDER }),
  orderVisibilityWhere: () => ({}),
}));

import { PATCH } from './route';

const patch = (body: Record<string, unknown>) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'قرار المالك بعد مراجعة الطلب', ...body }),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );
const said = async (res: Response) => (await res.json()) as Record<string, unknown>;

const nothingWritten = () => {
  expect(db.order.updateMany).not.toHaveBeenCalled();
  expect(db.order.update).not.toHaveBeenCalled();
  expect(db.orderStatusLog.create).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  ORDER = {
    id: ORDER_ID, companyId: 'c1', storeId: 's1', customerId: 'cu1', countryId: 'co1', version: 3, orderNumber: 'SY-1',
    status: 'CONTACTING', confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY',
    moderatorId: 'mod-A', lockedById: null, lockExpiresAt: null, shippingCost: 0,
    regionId: null,
  };
  can.mockImplementation(() => true);
  requireContext.mockResolvedValue({
    user: { id: 'agent-1', name: 'سارة', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD' },
  });
  db.order.findUnique.mockImplementation(async () => ORDER);
  db.region.findFirst.mockResolvedValue({ id: REGION_ID, name: 'دمشق' });
  db.$transaction.mockImplementation(async (fn: never) =>
    typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn
  );
  db.order.updateMany.mockImplementation(async ({ data }: any) => {
    ORDER = { ...ORDER, ...data };
    return { count: 1 };
  });
  db.order.update.mockImplementation(async ({ data }: any) => {
    ORDER = { ...ORDER, ...data };
    return ORDER;
  });
  createNotification.mockResolvedValue(1);
});

describe('the override moving an order to CONFIRMED with no governorate', () => {
  it.each([
    ['status', { status: 'CONFIRMED' }],
    ['confirmationStatus', { confirmationStatus: 'CONFIRMED' }],
  ])('by %s ⇒ 409 REGION_REQUIRED and nothing is written', async (_field, move) => {
    const res = await patch({ expectedVersion: 3, ...move });

    expect(res.status).toBe(409);
    const body = await said(res);
    expect(body.code).toBe('REGION_REQUIRED');
    expect(body.errorAr).toBe(REGION_REQUIRED_MESSAGE);
    expect(body.error).toBe(REGION_REQUIRED_MESSAGE);
    nothingWritten();
  });

  it('a governorate set by the SAME request counts: set it and confirm in one save', async () => {
    const res = await patch({ expectedVersion: 3, status: 'CONFIRMED', regionId: REGION_ID });

    expect(res.status, JSON.stringify(await said(res.clone()))).toBe(200);
    expect(ORDER.confirmationStatus).toBe('CONFIRMED');
    expect(ORDER.regionId).toBe(REGION_ID);
  });

  it('an order that already has one is confirmed as before', async () => {
    ORDER = { ...ORDER, regionId: REGION_ID };

    const res = await patch({ expectedVersion: 3, status: 'CONFIRMED' });

    expect(res.status).toBe(200);
    expect(ORDER.confirmationStatus).toBe('CONFIRMED');
  });

  it('NEGATIVE: without the override the door is still the confirmation door’s (the older refusal comes first)', async () => {
    can.mockImplementation((_u: unknown, key: string) => key !== 'orders.unlock');

    const res = await patch({ expectedVersion: 3, status: 'CONFIRMED' });

    expect(res.status).toBe(409);
    expect((await said(res)).code).toBe('USE_CONFIRMATION_DOOR');
    nothingWritten();
  });
});

describe('a confirmed order keeps its governorate', () => {
  beforeEach(() => {
    ORDER = { ...ORDER, status: 'CONFIRMED', confirmationStatus: 'CONFIRMED', regionId: REGION_ID };
  });

  it('clearing it (regionId: null) ⇒ 409 REGION_REQUIRED and nothing is written', async () => {
    const res = await patch({ expectedVersion: 3, regionId: null });

    expect(res.status).toBe(409);
    expect((await said(res)).code).toBe('REGION_REQUIRED');
    nothingWritten();
    expect(ORDER.regionId).toBe(REGION_ID);
  });

  it('even with the full override', async () => {
    can.mockImplementation(() => true);

    const res = await patch({ expectedVersion: 3, regionId: null, customerAddress: 'الجلاء' });

    expect(res.status).toBe(409);
    expect((await said(res)).code).toBe('REGION_REQUIRED');
    nothingWritten();
  });
});

describe('NEGATIVE: before confirmation the governorate can still be cleared', () => {
  it('an order in progress, regionId: null ⇒ saved', async () => {
    ORDER = { ...ORDER, regionId: REGION_ID };

    const res = await patch({ expectedVersion: 3, regionId: null });

    expect(res.status, JSON.stringify(await said(res.clone()))).toBe(200);
    expect(ORDER.regionId).toBeNull();
  });
});
