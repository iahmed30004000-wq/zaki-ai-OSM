import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * «مطابق يدوي» AND «تجميع» AT THEIR DOORS — who may knock, what is refused in words, what is audited.
 *
 * The work itself (the lines, the lock, the hash) is tested against a world that applies filters in
 * `src/lib/manual-statement.test.ts`; here the lib is replaced and the routes are asked only what a route owns.
 */

const { db, requireContext, requirePermission, logAudit, addOrdersToDraft, assembleDraft } = vi.hoisted(() => ({
  db: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown, _options?: unknown) => fn({ tx: true })) },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  addOrdersToDraft: vi.fn(),
  assembleDraft: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/manual-statement', async (orig) => ({
  ...(await orig<typeof import('@/lib/manual-statement')>()),
  addOrdersToDraft: (...a: unknown[]) => addOrdersToDraft(...a),
  assembleDraft: (...a: unknown[]) => assembleDraft(...a),
}));

import { POST as addToDraft } from './route';
import { POST as assemble } from '../[id]/assemble/route';
import { ManualRefused } from '@/lib/manual-statement';

const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';
const ID = '88888888-8888-4888-8888-888888888888';
const send = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  requirePermission.mockResolvedValue({});
});

describe('POST /api/finance/statements/manual — press 1', () => {
  const answer = { statementId: ID, courier: 'الباشا', currencyCode: 'JOD', created: true, added: 2, updated: 0, lines: 2, total: 35 };

  it('asks for the permission that makes a statement, before it reads the body', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const res = await addToDraft(send({ orders: [{ orderId: O1 }] }));
    expect(requirePermission).toHaveBeenCalledWith('settlement.upload');
    expect(res.status).not.toBe(200);
    expect(addOrdersToDraft).not.toHaveBeenCalled();
  });

  it('passes the store’s currency and minor unit to the door — the client names neither', async () => {
    addOrdersToDraft.mockResolvedValue(answer);
    await addToDraft(send({ orders: [{ orderId: O1 }, { orderId: O2, amount: 15.5 }], currencyCode: 'USD', storeId: 'other' }));
    expect(addOrdersToDraft.mock.calls[0][1]).toEqual({
      companyId: 'c1', storeId: 's1', userId: 'u1', currencyCode: 'JOD', minorUnit: 3,
      items: [{ orderId: O1 }, { orderId: O2, amount: 15.5 }],
    });
  });

  it('answers 201 for the press that made the draft and 200 for the next, and audits both', async () => {
    addOrdersToDraft.mockResolvedValueOnce(answer).mockResolvedValueOnce({ ...answer, created: false, added: 0, updated: 2 });
    expect((await addToDraft(send({ orders: [{ orderId: O1 }] }))).status).toBe(201);
    expect((await addToDraft(send({ orders: [{ orderId: O1 }] }))).status).toBe(200);
    expect(logAudit).toHaveBeenCalledTimes(2);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'STATEMENT_MANUAL_ADDED', entity: 'CourierStatement', entityId: ID,
      newData: { courier: 'الباشا', added: 2, lines: 2, total: 35, draftCreated: true },
    });
  });

  it('a refusal reaches the person as the door worded it, with its status, and is not audited as an act', async () => {
    addOrdersToDraft.mockRejectedValue(
      new ManualRefused(409, { code: 'NO_COURIER', error: 'طلبات بلا شركة شحن: JO-2026-0002', orders: ['JO-2026-0002'] })
    );
    const res = await addToDraft(send({ orders: [{ orderId: O1 }] }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'NO_COURIER', error: 'طلبات بلا شركة شحن: JO-2026-0002', orders: ['JO-2026-0002'] });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('refuses a body that is not a list of orders, an id that is not an id, and a list that is empty', async () => {
    for (const bad of [null, {}, { orders: [] }, { orders: [{ orderId: 'x' }] }, { orders: [{ orderId: O1, amount: 'a lot' }] }]) {
      expect((await addToDraft(send(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(addOrdersToDraft).not.toHaveBeenCalled();
  });

  it('works inside ONE transaction, with room to lock and read', async () => {
    addOrdersToDraft.mockResolvedValue(answer);
    await addToDraft(send({ orders: [{ orderId: O1 }] }));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction.mock.calls[0][1]).toMatchObject({ timeout: 30_000 });
    expect(addOrdersToDraft.mock.calls[0][0]).toEqual({ tx: true });
  });
});

describe('POST /api/finance/statements/:id/assemble — press 2', () => {
  const answer = { statementId: ID, reference: 'كشف الأحد', courier: 'الباشا', currencyCode: 'JOD', lines: 2, total: 35 };

  it('asks for the permission that makes a statement', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    await assemble(send({ reference: 'كشف الأحد' }), params);
    expect(requirePermission).toHaveBeenCalledWith('settlement.upload');
    expect(assembleDraft).not.toHaveBeenCalled();
  });

  it('hands the door the statement from the URL, the trimmed reference and the period as dates', async () => {
    assembleDraft.mockResolvedValue(answer);
    const res = await assemble(
      send({ reference: '  كشف الأحد ', periodFrom: '2026-10-01T00:00:00.000Z', periodTo: '2026-10-07T23:59:59.000Z' }),
      params
    );
    expect(res.status).toBe(200);
    expect(assembleDraft.mock.calls[0][1]).toEqual({
      companyId: 'c1', storeId: 's1', statementId: ID, reference: 'كشف الأحد', minorUnit: 3,
      periodFrom: new Date('2026-10-01T00:00:00.000Z'), periodTo: new Date('2026-10-07T23:59:59.000Z'),
    });
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'STATEMENT_MANUAL_ASSEMBLED', entityId: ID, newData: { reference: 'كشف الأحد', lines: 2, total: 35 },
    });
  });

  it('a period is optional, and one that ends before it begins is refused', async () => {
    assembleDraft.mockResolvedValue(answer);
    expect((await assemble(send({ reference: 'كشف الأحد' }), params)).status).toBe(200);
    expect(assembleDraft.mock.calls[0][1]).toMatchObject({ periodFrom: null, periodTo: null });
    const backwards = await assemble(
      send({ reference: 'كشف الأحد', periodFrom: '2026-10-07T00:00:00.000Z', periodTo: '2026-10-01T00:00:00.000Z' }),
      params
    );
    expect(backwards.status).toBe(400);
    expect((await backwards.json()).error).toContain('الفترة');
  });

  it('a reference of one character is refused before anything is read', async () => {
    expect((await assemble(send({ reference: 'x' }), params)).status).toBe(400);
    expect((await assemble(send({ reference: '   ' }), params)).status).toBe(400);
    expect(assembleDraft).not.toHaveBeenCalled();
  });

  it('a refusal reaches the person as the door worded it', async () => {
    assembleDraft.mockRejectedValue(new ManualRefused(409, { code: 'HAS_RECEIPT', error: 'سُجِّل لهذا الكشف إيصال' }));
    const res = await assemble(send({ reference: 'كشف الأحد' }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('HAS_RECEIPT');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('two presses that both passed the read cannot both win: the unique hash answers the second in words', async () => {
    assembleDraft.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
    );
    const res = await assemble(send({ reference: 'كشف الأحد' }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('DUPLICATE_REFERENCE');
    expect(body.error).toContain('كشف الأحد');
  });
});
