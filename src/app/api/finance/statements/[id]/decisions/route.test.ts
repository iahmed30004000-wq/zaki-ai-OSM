import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ONE ANSWER FOR THE LINES THAT CARRY THE SAME WORD OF THE COMPANY — ALL OR NONE.
 *
 *   · the lines must share the company’s word (or its meaning): «مؤجل» and «مؤجلة» are one, «تم توصيلها» is another;
 *   · every one of them is a difference in money of THIS statement;
 *   · every one is allowed the answer by the matrix for its own order — one refused refuses the press, names the
 *     line and the sentence, and nothing is saved;
 *   · the explanation is the single door’s: five characters at least.
 */

type Row = {
  id: string; result: string; orderId: string | null; expectedAmount: number; statementAmount: number; difference: number;
  statementLine: { status: string | null }; order: { orderNumber: string } | null;
};

const { db, requireContext, requirePermission, logAudit, state } = vi.hoisted(() => {
  const state = {
    approvedAt: null as Date | null,
    rows: [] as unknown[],
    orders: [] as { id: string; shippingStatus: string; settlementStatus: string }[],
    requests: [] as { orderId: string; intent: string }[],
  };
  const db = {
    settlementMatch: { findMany: vi.fn(), update: vi.fn() },
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
vi.mock('@/lib/api-error', () => ({ apiErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }) }));

import { POST } from './route';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);

const call = (body: Record<string, unknown>) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'st1' }) });

const mkRow = (i: number, over: Partial<Row> = {}): Row => ({
  id: ids(9)[i], result: 'MISMATCHED', orderId: `o${i}`, expectedAmount: 20, statementAmount: 18, difference: -2,
  statementLine: { status: 'مؤجلة' }, order: { orderNumber: `ORD-${i}` }, ...over,
});

const put = (rows: Row[]) => {
  state.rows = rows;
  state.orders = rows.flatMap((r) => (r.orderId ? [{ id: r.orderId, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION' }] : []));
};

beforeEach(() => {
  vi.clearAllMocks();
  state.approvedAt = null;
  state.requests = [];
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
  requirePermission.mockResolvedValue({});
  db.courierStatement.findFirst.mockImplementation(async () => ({ reference: 'ST-1', approvedAt: state.approvedAt }));
  db.settlementMatch.findMany.mockImplementation(async (args: { where: { id?: { in: string[] }; OR?: unknown } }) =>
    // The rows of the press, and — for the "is another row holding the order" question, which has an OR — none.
    args.where.OR ? [] : (state.rows as Row[]).filter((r) => args.where.id!.in.includes(r.id))
  );
  db.settlementMatch.update.mockResolvedValue({ id: 'x' });
  db.order.findMany.mockImplementation(async () => state.orders);
  db.orderChangeRequest.findMany.mockImplementation(async () => state.requests);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  put([mkRow(0), mkRow(1), mkRow(2)]);
});

describe('one answer for a group of lines with the same word', () => {
  it('writes the answer on every row, a note on every order, and one audit row', async () => {
    const res = await call({ matchIds: ids(3), resolution: 'UNDER_REVIEW', note: 'ننتظر كشف الشركة' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(3);
    expect(db.settlementMatch.update).toHaveBeenCalledTimes(3);
    for (const call of db.settlementMatch.update.mock.calls) {
      expect(call[0].data).toMatchObject({ resolution: 'UNDER_REVIEW', resolutionNote: 'ننتظر كشف الشركة', resolvedById: 'u1' });
    }
    expect(db.orderNote.create).toHaveBeenCalledTimes(3);
    expect(db.orderNote.create.mock.calls.map((c) => c[0].data.orderId).sort()).toEqual(['o0', 'o1', 'o2']);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'SETTLEMENT_DIFFERENCES_RESOLVED_BULK', newData: { rows: 3, resolution: 'UNDER_REVIEW' } });
  });

  it('every row gets the SAME time, so the group reads as one act', async () => {
    await call({ matchIds: ids(3), resolution: 'ACCEPTED_COURIER', note: 'خصم متفق عليه' });
    const times = new Set(db.settlementMatch.update.mock.calls.map((c) => (c[0].data.resolvedAt as Date).getTime()));
    expect(times.size).toBe(1);
  });

  it('«مؤجل» and «مؤجلة» are one word, so they are one group', async () => {
    put([mkRow(0, { statementLine: { status: 'مؤجل' } }), mkRow(1, { statementLine: { status: 'مؤجلة' } })]);
    expect((await call({ matchIds: ids(2), resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' })).status).toBe(200);
  });
});

describe('two chosen lines for ONE order (the company names a parcel twice)', () => {
  const twice = () => put([mkRow(0), mkRow(1, { orderId: 'o0', order: { orderNumber: 'ORD-0' } })]);

  it('«اعتُمد رقم الشركة»: the first holds the order, the SECOND is refused by name with the single door’s sentence — nothing is saved', async () => {
    twice();
    const res = await call({ matchIds: ids(2), resolution: 'ACCEPTED_COURIER', note: 'خصم متفق عليه' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('DECISION_NOT_ALLOWED');
    // Only the second is named; the first is not a refusal.
    expect(body.refused).toEqual([{ matchId: ids(9)[1], order: 'ORD-0', why: 'الطلب محجوز بسطر آخر' }]);
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
  });

  it('…and pressing again for the first line alone goes through', async () => {
    twice();
    const res = await call({ matchIds: [ids(2)[0]], resolution: 'ACCEPTED_COURIER', note: 'خصم متفق عليه' });
    expect(res.status).toBe(200);
    expect(db.settlementMatch.update).toHaveBeenCalledTimes(1);
  });

  it('the order of the press decides which is first: the line sent first holds it', async () => {
    twice();
    const res = await call({ matchIds: [ids(2)[1], ids(2)[0]], resolution: 'ACCEPTED_COURIER', note: 'خصم متفق عليه' });
    expect((await res.json()).refused).toEqual([{ matchId: ids(9)[0], order: 'ORD-0', why: 'الطلب محجوز بسطر آخر' }]);
  });

  it('«رقمنا» and «قيد المراجعة» hold nothing, as at the single door: both lines may take them', async () => {
    twice();
    expect((await call({ matchIds: ids(2), resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' })).status).toBe(200);
  });
});

describe('the explanation is a reason, not five characters', () => {
  it.each(['.....', '\u0640\u0640\u0640\u0640\u0640', '\u200B\u200B\u200B\u200B\u200B', '\u200E\u200E\u200E\u200E\u200E'])(
    'refuses %j',
    async (note) => {
      expect((await call({ matchIds: ids(3), resolution: 'UNDER_REVIEW', note })).status).toBe(400);
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it('and a short real reason passes', async () => {
    expect((await call({ matchIds: ids(3), resolution: 'UNDER_REVIEW', note: 'خطأ بالرقم' })).status).toBe(200);
  });
});

describe('the store’s fence — a statement of another store is not found and none of its rows is touched', () => {
  it('asks for the statement WITH the store, and answers 404 for one that belongs to another', async () => {
    db.courierStatement.findFirst.mockImplementation(async (a: { where: { storeId: string } }) =>
      a.where.storeId === 's1' ? { reference: 'ST-1', approvedAt: null } : null
    );
    requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's2', country: { minorUnit: 3 } });

    const res = await call({ matchIds: ids(3), resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' });

    expect(res.status).toBe(404);
    expect(db.courierStatement.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'st1', companyId: 'c1', storeId: 's2' });
    expect(db.settlementMatch.findMany).not.toHaveBeenCalled();
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and the orders it reads for the matrix are the store’s own', async () => {
    await call({ matchIds: ids(3), resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' });
    expect(db.order.findMany.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', storeId: 's1' });
  });
});

describe('the lines must carry the same word', () => {
  it('a line with another word refuses the whole press — nothing is saved', async () => {
    put([mkRow(0), mkRow(1, { statementLine: { status: 'تم توصيلها' } })]);
    const res = await call({ matchIds: ids(2), resolution: 'ACCEPTED_COURIER', note: 'خصم متفق عليه' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MIXED_WORDS');
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
    expect(db.orderNote.create).not.toHaveBeenCalled();
  });

  it('a blank cell is a word of its own: not decided together with «مؤجلة»', async () => {
    put([mkRow(0), mkRow(1, { statementLine: { status: null } })]);
    expect((await call({ matchIds: ids(2), resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' })).status).toBe(409);
  });

  it('two words nobody has met are two groups', async () => {
    put([mkRow(0, { statementLine: { status: 'كلمة غريبة' } }), mkRow(1, { statementLine: { status: 'كلمة ثانية' } })]);
    expect((await call({ matchIds: ids(2), resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' })).status).toBe(409);
  });
});

describe('all or none', () => {
  it('one order that cannot take the answer refuses the press, and names the line and the sentence', async () => {
    put([mkRow(0), mkRow(1), mkRow(2)]);
    state.orders[1].settlementStatus = 'SETTLED';

    const res = await call({ matchIds: ids(3), resolution: 'OURS_STANDS', note: 'نطالب بالفرق' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('DECISION_NOT_ALLOWED');
    expect(body.refused).toEqual([{ matchId: ids(9)[1], order: 'ORD-1', why: expect.stringContaining('مُسوّى أصلاً') }]);
    expect(body.error).toContain('ORD-1');
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('«قيد المراجعة» goes through for the very same group', async () => {
    state.orders[1].settlementStatus = 'SETTLED';
    expect((await call({ matchIds: ids(3), resolution: 'UNDER_REVIEW', note: 'مسوّى بباب آخر' })).status).toBe(200);
  });

  it('a row that is not a difference in money refuses it', async () => {
    put([mkRow(0), mkRow(1, { result: 'MATCHED' })]);
    const res = await call({ matchIds: ids(2), resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_A_DIFFERENCE');
  });

  it('a row that is not of this statement is not found', async () => {
    put([mkRow(0)]);
    const res = await call({ matchIds: ids(2), resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' });
    expect(res.status).toBe(404);
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
  });

  it('an approved statement no longer takes their figure', async () => {
    state.approvedAt = new Date('2026-10-29T00:00:00Z');
    const res = await call({ matchIds: ids(3), resolution: 'ACCEPTED_COURIER', note: 'خصم متفق عليه' });
    expect(res.status).toBe(409);
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
  });
});

describe('the explanation, the ceiling and the lock', () => {
  it('four characters are refused', async () => {
    expect((await call({ matchIds: ids(3), resolution: 'UNDER_REVIEW', note: 'خصم' })).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('an empty list and a list over the ceiling are refused', async () => {
    expect((await call({ matchIds: [], resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' })).status).toBe(400);
    const many = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await call({ matchIds: many, resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' })).status).toBe(400);
  });

  it('the same id sent twice is one row, not two', async () => {
    const res = await call({ matchIds: [ids(1)[0], ids(1)[0]], resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' });
    expect(res.status).toBe(200);
    expect(db.settlementMatch.update).toHaveBeenCalledTimes(1);
  });

  it('locks the statement’s row before it reads anything, as the single door does', async () => {
    await call({ matchIds: ids(3), resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' });
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.courierStatement.findFirst.mock.invocationCallOrder[0]);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.settlementMatch.findMany.mock.invocationCallOrder[0]);
  });

  it('asks the settlement permission, and moves no money', async () => {
    await call({ matchIds: ids(3), resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' });
    expect(requirePermission).toHaveBeenCalledWith('settlement.review');
    expect(Object.keys(db)).not.toContain('walletMovement');
  });
});
