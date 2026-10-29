import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «طلبات لم يذكرها أي كشف» — THE THREE ANSWERS ARE RECORDS ON THE ORDER, AND NOTHING ELSE.
 *
 * Each press writes one OrderActivity (and one audit row). It sets no status, writes no figure, moves no
 * money — the test fails on any write other than the activity — and it keeps the screen's own permission.
 * «لم يُسلَّم — صحّح الحالة» also asks for the one permission that can make the correction, because a
 * button leading to a door its owner cannot open is not offered.
 */

const { db, requireContext, requirePermission, logAudit, can } = vi.hoisted(() => ({
  db: {
    settlementMatch: { findFirst: vi.fn() },
    orderActivity: { findMany: vi.fn(), create: vi.fn() },
    // Anything below must NEVER be called by this door.
    order: { update: vi.fn(), updateMany: vi.fn() },
    walletMovement: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  can: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({ apiErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }) }));

import { POST } from './route';
import { NOT_MENTIONED_ACTIONS, NOT_MENTIONED_ACTIVITY } from '@/lib/not-mentioned';

const call = (action: unknown, ids = { id: 'st1', matchId: 'm1' }) =>
  POST(
    new Request('http://x/api/finance/statements/st1/matches/m1/order-action', {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve(ids) }
  );

const match = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  result: 'MISSING_IN_STATEMENT',
  orderId: 'o1',
  statement: { reference: 'ST-1' },
  order: { id: 'o1', orderNumber: 'ORD-1', shippingStatus: 'DELIVERED', storeId: 's1' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({ id: 'u1' });
  can.mockReturnValue(true);
  db.settlementMatch.findFirst.mockResolvedValue(match());
  db.orderActivity.findMany.mockResolvedValue([]);
  db.orderActivity.create.mockResolvedValue({ id: 'a1', createdAt: new Date() });
});

describe('each answer is one activity on the order', () => {
  it.each(NOT_MENTIONED_ACTIONS)('%s is stored under its own code, with the statement and the row it was pressed on', async (action) => {
    const res = await call(action);
    expect(res.status).toBe(200);
    expect(db.orderActivity.create).toHaveBeenCalledTimes(1);
    const data = db.orderActivity.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ companyId: 'c1', orderId: 'o1', userId: 'u1', action: NOT_MENTIONED_ACTIVITY[action] });
    const meta = JSON.parse(data.metadata);
    expect(meta).toMatchObject({ matchId: 'm1', statement: 'ST-1' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ entity: 'Order', entityId: 'o1', userId: 'u1' }));
  });

  it('the three codes are three different codes', () => {
    expect(new Set(Object.values(NOT_MENTIONED_ACTIVITY)).size).toBe(3);
  });

  it('writes NOTHING but the activity — no status, no money, no transaction', async () => {
    for (const action of NOT_MENTIONED_ACTIONS) await call(action);
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.walletMovement.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('a second press on the same row finds the first and writes no second record', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a9', createdAt: new Date(), metadata: JSON.stringify({ matchId: 'other-row' }) },
      { id: 'a0', createdAt: new Date(), metadata: JSON.stringify({ matchId: 'm1' }) },
    ]);
    const body = await (await call('CHASE_COURIER')).json();
    expect(body.repeated).toBe(true);
    expect(db.orderActivity.create).not.toHaveBeenCalled();
    expect(body.activity.id).toBe('a0');
  });
});

describe('who may, and on what', () => {
  it('asks for the same permission as the screen and the difference answer beside it', async () => {
    await call('WAIT_LATER_STATEMENT');
    expect(requirePermission).toHaveBeenCalledWith('settlement.review');
  });

  it('refuses when that permission is missing, and writes nothing', async () => {
    requirePermission.mockRejectedValue(new Error('403'));
    const res = await call('CHASE_COURIER');
    expect(res.status).toBe(500);
    expect(db.orderActivity.create).not.toHaveBeenCalled();
  });

  it('«لم يُسلَّم — صحّح الحالة» needs orders.unlock; the other two do not', async () => {
    can.mockReturnValue(false);
    const refused = await call('NOT_DELIVERED');
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('NO_DOOR_TO_CORRECT_STATUS');
    expect(db.orderActivity.create).not.toHaveBeenCalled();

    expect((await call('WAIT_LATER_STATEMENT')).status).toBe(200);
    expect((await call('CHASE_COURIER')).status).toBe(200);
  });

  it('and it is not offered for an order that is not delivered — there is no door to correct that', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(match({ order: { id: 'o1', orderNumber: 'ORD-1', shippingStatus: 'RETURNED', storeId: 's1' } }));
    expect((await call('NOT_DELIVERED')).status).toBe(403);
    expect(db.orderActivity.create).not.toHaveBeenCalled();
  });
});

describe('only the group it belongs to', () => {
  it.each(['MISMATCHED', 'MATCHED', 'MISSING_IN_SYSTEM'])('refuses a %s row', async (result) => {
    db.settlementMatch.findFirst.mockResolvedValue(match({ result }));
    const res = await call('CHASE_COURIER');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_AN_UNMENTIONED_ORDER');
    expect(db.orderActivity.create).not.toHaveBeenCalled();
  });

  it('a row of another statement or company is simply not found', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(null);
    expect((await call('CHASE_COURIER')).status).toBe(404);
    const where = db.settlementMatch.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'm1', statementId: 'st1', companyId: 'c1', statement: { storeId: 's1' } });
  });

  it('an order of another store is not found either', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(match({ order: { id: 'o1', orderNumber: 'ORD-1', shippingStatus: 'DELIVERED', storeId: 'other' } }));
    expect((await call('CHASE_COURIER')).status).toBe(404);
    expect(db.orderActivity.create).not.toHaveBeenCalled();
  });

  it('an answer that is not one of the three is refused before anything is read', async () => {
    const res = await call('SETTLE_IT');
    expect(res.status).toBe(400);
    expect(db.settlementMatch.findFirst).not.toHaveBeenCalled();
  });
});
