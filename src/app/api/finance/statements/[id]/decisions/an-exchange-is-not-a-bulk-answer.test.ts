import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «طلب تبديل» IS ONE ORDER AT A TIME — THE BULK DOOR NEVER TAKES IT, AND NEVER LEAVES ITS MARK STANDING (the owner, 13/11).
 *
 * The bulk door answers a group of lines that carry the same word of the company, with one explanation. An exchange has its own reason
 * on every order, so it is not offered there — and the API says so instead of guessing:
 *
 *   · a body that asks for it (`exchange: true`) is refused with a sentence, before anything is read or written. It is NOT quietly taken as
 *     the plain «اعتُمد رقم الشركة», which is the opposite thing (a discount somebody gave);
 *   · every answer the bulk door writes carries the qualifier CLEARED — `resolutionKind: null` — so a bulk press over a line that was an
 *     exchange leaves a plain answer and no exchange mark, whichever of the three sayings it is.
 */

const { db, requireContext, requirePermission, logAudit, state } = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, unknown>[],
    orders: [] as { id: string; shippingStatus: string; settlementStatus: string }[],
  };
  const db = {
    settlementMatch: { findMany: vi.fn(), updateMany: vi.fn() },
    orderNote: { create: vi.fn() },
    courierStatement: { findFirst: vi.fn() },
    order: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { db, state, requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn() };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: String((e as Error).message) }), { status: (e as { status?: number }).status ?? 500 }),
}));

import { POST } from './route';
import { EXCHANGE_NOT_IN_BULK_SENTENCE } from '@/lib/settlement-difference';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
const call = (body: Record<string, unknown>) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'st1' }) });

const mkRow = (i: number, over: Record<string, unknown> = {}) => ({
  id: ids(9)[i], result: 'MISMATCHED', orderId: `o${i}`, expectedAmount: 20, statementAmount: 18, difference: -2, appliedAt: null,
  resolution: null, resolutionKind: null, statementLine: { status: 'مؤجلة' }, order: { orderNumber: `ORD-${i}` }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
  requirePermission.mockResolvedValue({});
  db.courierStatement.findFirst.mockImplementation(async () => ({ reference: 'ST-1', status: 'MATCHED', approvedAt: null, matchingClosedAt: null }));
  db.settlementMatch.findMany.mockImplementation(async (args: { where: { id?: { in: string[] }; OR?: unknown } }) =>
    args.where.OR ? [] : state.rows.filter((r) => args.where.id!.in.includes(r.id as string))
  );
  // The write is applied to the stored row, the way the database applies it.
  db.settlementMatch.updateMany.mockImplementation(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = state.rows.find((r) => r.id === a.where.id);
    if (!row) return { count: 0 };
    Object.assign(row, a.data);
    return { count: 1 };
  });
  db.order.findMany.mockImplementation(async () => state.orders);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  state.rows = [mkRow(0), mkRow(1), mkRow(2)];
  state.orders = state.rows.map((r) => ({ id: r.orderId as string, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION' }));
});

describe('an exchange is not a bulk answer', () => {
  it('`exchange: true` is refused with its sentence, and nothing is read, locked, written, noted or audited', async () => {
    const res = await call({ matchIds: ids(3), resolution: 'ACCEPTED_COURIER', exchange: true, note: 'تبديل حبة ناقصة' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: EXCHANGE_NOT_IN_BULK_SENTENCE, code: 'EXCHANGE_NOT_IN_BULK' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.settlementMatch.findMany).not.toHaveBeenCalled();
    expect(db.settlementMatch.updateMany).not.toHaveBeenCalled();
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    for (const row of state.rows) expect(row.resolutionKind).toBeNull();
  });

  it('with any resolution beside it, not only the courier’s figure — it is the flag that is refused', async () => {
    for (const resolution of ['OURS_STANDS', 'UNDER_REVIEW', 'ACCEPTED_COURIER']) {
      const res = await call({ matchIds: ids(2), resolution, exchange: true, note: 'تبديل حبة ناقصة' });
      expect(res.status, resolution).toBe(400);
      expect((await res.json()).code, resolution).toBe('EXCHANGE_NOT_IN_BULK');
    }
    expect(db.settlementMatch.updateMany).not.toHaveBeenCalled();
  });

  it('the refusal is Arabic and plain', () => {
    expect(EXCHANGE_NOT_IN_BULK_SENTENCE).not.toMatch(/[A-Za-z]/);
    expect(EXCHANGE_NOT_IN_BULK_SENTENCE).toContain('طلباً طلباً');
  });

  it('a person without the key is refused first (the same key as the single door)', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('ليس لديك صلاحية'), { status: 403 }));
    const res = await call({ matchIds: ids(2), resolution: 'ACCEPTED_COURIER', exchange: true, note: 'تبديل حبة ناقصة' });
    expect(res.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('settlement.review');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('`exchange: false`, or no such field (an older client), is the plain bulk answer', async () => {
    for (const extra of [{ exchange: false }, {}]) {
      state.rows = [mkRow(0), mkRow(1)];
      const res = await call({ matchIds: ids(2), resolution: 'ACCEPTED_COURIER', note: 'خصم متفق عليه', ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(200);
    }
  });

  it('a flag that is not a true/false is refused (nothing written)', async () => {
    for (const exchange of ['true', 1, null]) {
      expect((await call({ matchIds: ids(2), resolution: 'ACCEPTED_COURIER', exchange, note: 'تبديل حبة ناقصة' })).status).toBe(400);
    }
    expect(db.settlementMatch.updateMany).not.toHaveBeenCalled();
  });
});

describe('every bulk answer clears the qualifier — the last answer on a row is the only one it carries', () => {
  it.each(['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW'] as const)('%s: each row is written with `resolutionKind: null`', async (resolution) => {
    const res = await call({ matchIds: ids(3), resolution, note: 'ننتظر كشف الشركة' });
    expect(res.status).toBe(200);
    expect(db.settlementMatch.updateMany).toHaveBeenCalledTimes(3);
    for (const c of db.settlementMatch.updateMany.mock.calls) {
      expect(Object.prototype.hasOwnProperty.call(c[0].data, 'resolutionKind')).toBe(true);
      expect(c[0].data.resolutionKind).toBeNull();
    }
  });

  it('a line that was an EXCHANGE, answered again in bulk, is a plain answer with no exchange mark left on it', async () => {
    state.rows = [
      mkRow(0, { resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE' }),
      mkRow(1, { resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE' }),
    ];
    const res = await call({ matchIds: ids(2), resolution: 'ACCEPTED_COURIER', note: 'خصم متفق عليه' });
    expect(res.status).toBe(200);
    for (const row of state.rows) expect(row).toMatchObject({ resolution: 'ACCEPTED_COURIER', resolutionKind: null });
  });

  it('and the plain fields of the write are what they always were — the person, the explanation, one time for the group', async () => {
    await call({ matchIds: ids(3), resolution: 'ACCEPTED_COURIER', note: 'خصم متفق عليه' });
    for (const c of db.settlementMatch.updateMany.mock.calls) {
      expect(c[0].data).toMatchObject({ resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم متفق عليه', resolvedById: 'u1' });
      expect(c[0].where).toMatchObject({ appliedAt: null, statement: { matchingClosedAt: null } });
    }
    expect(new Set(db.settlementMatch.updateMany.mock.calls.map((c) => (c[0].data.resolvedAt as Date).getTime())).size).toBe(1);
    // The notes the bulk door writes say the answer's own word — never «طلب تبديل».
    for (const c of db.orderNote.create.mock.calls) expect(c[0].data.body).not.toContain('طلب تبديل');
  });
});
