import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE CONTACT DOOR OF «إثبات المكالمات» (Confirmation Center v2, step A; the owner's gate: «NO_ANSWER release without a logged ≥ 30 s attempt is
 * blocked; with it, allowed»)
 *
 * With the switch ON:
 *
 *  1. A «لا يرد» / «مشغول» / «مسكّر» with no «اتصال» press of hers on the order is refused 409 `CALL_NOT_STARTED`; with a press younger than 30 s, 409
 *     `CALL_TOO_SOON` (with the seconds to wait); with a press exactly 30 s old it is recorded, and the line carries the SERVER-measured seconds (a client value is ignored).
 *  2. A refusal writes NOTHING — no attempt line, no close, no release — and leaves one `CALL_PROOF_REFUSED` audit row.
 *  3. The same press cannot be spent twice; a colleague's press does not license her; «رقم غلط», «ردّ» and the lines that claim no outcome are not asked.
 *  4. A typed `durationSeconds` is stored only for a result that is not a «didn't answer», only as a whole number 0..14400.
 *  5. The guard reads THIS order's lines of THIS company, through the transaction (a wrong `orderId` in that read would make every test below that depends on it fail).
 *
 * With the switch OFF the door is today’s: the guard is never asked, the data of the write has no new key, the answer carries no new key.
 *
 * The mocks of `the-contact-door-returns-the-order.test.ts` (the same door) with a small STATEFUL fake of the attempt table, so a press written by one call is the
 * evidence of the next; the clock is the test's. Blockers: no money, no order creation, one nullable column.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, calls, rows, requireContext, assertOrderAccess, assertOrderReadable, logAudit, endOrder, proof, sw, rsw } = vi.hoisted(() => {
  const calls: string[] = [];
  const rows: any[] = [];
  const db = {
    orderContactAttempt: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    order: { update: vi.fn(), updateMany: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    $transaction: vi.fn(),
  } as any;
  return {
    db,
    calls,
    rows,
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    assertOrderReadable: vi.fn(),
    logAudit: vi.fn(),
    endOrder: vi.fn(),
    proof: { on: true },
    sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
    rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: (...a: unknown[]) => assertOrderReadable(...a),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/order-cancel', () => ({ endOrder: (...a: unknown[]) => endOrder(...a) }));
vi.mock('@/lib/authorization', () => ({ can: () => true, authorize: () => ({ allowed: true }) }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));
vi.mock('@/lib/call-proof-switch', () => ({ callProofOn: async () => proof.on }));

import { GET, POST } from '@/app/api/orders/[id]/contact-attempts/route';

const T0 = new Date('2026-11-15T10:00:00.000Z').getTime();
const params = { params: Promise.resolve({ id: 'o1' }) };
const send = (body: Record<string, unknown>) =>
  POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactMethod: 'PHONE', ...body }) }), params);
const press = (result: string, extra: Record<string, unknown> = {}) => send({ result, ...extra });
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
const seed = (result: string, ageMs: number, employeeId = 'u1') =>
  rows.push({ id: `s${rows.length}`, orderId: 'o1', companyId: 'c1', createdAt: new Date(Date.now() - ageMs), result, employeeId, attemptNumber: rows.length + 1 });
const written = () => calls.filter((c) => c === 'attempt').length;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  calls.length = 0;
  rows.length = 0;
  proof.on = true;
  sw.value = { enabled: false, enabledAt: null };
  rsw.value = { enabled: false, enabledAt: null };
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Agent', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' },
  });
  const order = {
    id: 'o1', claimedById: 'u1', claimedAt: new Date(T0 - 3_600_000), confirmationStatus: 'IN_PROGRESS', nextFollowUpAt: null, followUpStatus: null, shippingStatus: 'NOT_READY',
  };
  assertOrderAccess.mockResolvedValue({ allowed: true, order });
  assertOrderReadable.mockResolvedValue({ allowed: true, order });
  db.orderContactAttempt.findFirst.mockImplementation(async () => (rows.length ? { attemptNumber: rows[rows.length - 1].attemptNumber } : null));
  db.orderContactAttempt.findMany.mockImplementation(async () => rows.map((r) => ({ ...r })));
  db.orderContactAttempt.count.mockImplementation(async () => rows.filter((r) => ['NO_ANSWER', 'BUSY', 'UNREACHABLE'].includes(r.result)).length);
  db.orderContactAttempt.create.mockImplementation(async ({ data }: any) => {
    calls.push('attempt');
    const row = { ...data, id: `a${rows.length + 1}`, createdAt: new Date() };
    rows.push(row);
    return row;
  });
  db.order.updateMany.mockImplementation(async () => (calls.push('release'), { count: 1 }));
  db.orderClaimHistory.create.mockImplementation(async () => void calls.push('history'));
  db.$transaction.mockImplementation(async (fn: any) => {
    calls.push('begin');
    const out = await fn(db);
    calls.push('commit');
    return out;
  });
  endOrder.mockResolvedValue({ ok: true, orderNumber: 'ORD-1' });
});

afterEach(() => vi.useRealTimers());

describe('ON — a «didn’t answer» needs a logged «اتصال» press that is thirty seconds old', () => {
  it('with no press at all it is refused CALL_NOT_STARTED, and NOTHING is written', async () => {
    const res = await press('NO_ANSWER');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CALL_NOT_STARTED', errorAr: expect.stringContaining('اتصال') });
    expect(written()).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(endOrder).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  });

  it('a press 29 s old is refused CALL_TOO_SOON, with the seconds to wait and the instant it opens', async () => {
    seed('OPENED', 29_000);
    const res = await press('NO_ANSWER');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CALL_TOO_SOON', waitSeconds: 1, unlocksAt: new Date(T0 + 1_000).toISOString(), errorAr: expect.stringContaining('1 ثانية') });
    expect(written()).toBe(0);
  });

  it('a press exactly 30 s old is recorded — with the SERVER-measured seconds, whatever the client claims', async () => {
    seed('OPENED', 30_000);
    const res = await press('NO_ANSWER', { durationSeconds: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect(written()).toBe(1);
    expect(db.orderContactAttempt.create.mock.calls[0][0].data).toMatchObject({ result: 'NO_ANSWER', durationSeconds: 30, employeeId: 'u1', companyId: 'c1', orderId: 'o1' });
  });

  it('end to end on the stateful fake: «اتصال» is recorded, 29 s later «لا يرد» is refused, one second later it is recorded', async () => {
    expect((await press('OPENED')).status).toBe(200);
    expect(rows).toHaveLength(1);
    advance(29_000);
    expect((await press('NO_ANSWER')).status).toBe(409);
    expect(rows).toHaveLength(1);
    advance(1_000);
    expect((await press('NO_ANSWER')).status).toBe(200);
    expect(rows.map((r) => r.result)).toEqual(['OPENED', 'NO_ANSWER']);
    expect(rows[1].durationSeconds).toBe(30);
  });

  it.each(['BUSY', 'UNREACHABLE'])('«%s» is held to the same thirty seconds — the quick press cannot move to the other buttons', async (result) => {
    seed('OPENED', 10_000);
    expect((await press(result)).status).toBe(409);
    advance(20_000);
    expect((await press(result)).status).toBe(200);
  });

  it('the same press is never spent twice: right after a recorded «لا يرد» the next one is refused', async () => {
    seed('OPENED', 90_000);
    expect((await press('NO_ANSWER')).status).toBe(200);
    advance(60_000);
    const again = await press('NO_ANSWER');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'CALL_NOT_STARTED' });
  });

  it('a colleague’s press does not license her', async () => {
    seed('OPENED', 120_000, 'u2');
    expect((await press('NO_ANSWER')).status).toBe(409);
  });

  it('a press from before her claim does not count (she took the order again after it)', async () => {
    seed('OPENED', 2 * 3_600_000);
    expect((await press('NO_ANSWER')).status).toBe(409);
  });

  it.each([['WRONG_NUMBER'], ['ANSWERED'], ['CALLBACK_REQUESTED'], ['OPENED'], ['MESSAGE_SENT']])('«%s» is not asked: recorded with no press at all', async (result) => {
    expect((await press(result)).status).toBe(200);
    expect(written()).toBe(1);
  });

  it('a refusal leaves exactly one CALL_PROOF_REFUSED audit row, in her name, and no CONTACT_ATTEMPT_RECORDED', async () => {
    await press('NO_ANSWER');
    const actions = logAudit.mock.calls.map((c: any[]) => c[0].action);
    expect(actions).toEqual(['CALL_PROOF_REFUSED']);
    expect(logAudit.mock.calls[0][0]).toMatchObject({ companyId: 'c1', userId: 'u1', entity: 'Order', entityId: 'o1', newData: { code: 'CALL_NOT_STARTED', result: 'NO_ANSWER', door: 'ATTEMPT' } });
  });

  it('with the returns mode on, a refused «لا يرد» releases nothing (and an accepted one still does)', async () => {
    sw.value = { enabled: true, enabledAt: new Date('2026-11-01T06:00:00.000Z') };
    rsw.value = { enabled: true, enabledAt: new Date('2026-11-01T06:00:00.000Z') };
    expect((await press('NO_ANSWER')).status).toBe(409);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    seed('OPENED', 31_000);
    const ok = await press('NO_ANSWER');
    expect((await ok.json()).returnedToQueue).toBe(true);
    expect(calls).toContain('release');
  });

  it('the guard reads THIS order’s lines of THIS company, THROUGH THE TRANSACTION, with the columns the rule needs — and before the first write', async () => {
    seed('OPENED', 31_000);
    // A transaction client of its own: a guard that read through `db` (outside the rollback boundary) would not touch it.
    const txRead = vi.fn(async (_args: unknown) => {
      calls.push('guard-read');
      return rows.map((r) => ({ ...r }));
    });
    const tx = { ...db, orderContactAttempt: { ...db.orderContactAttempt, findMany: txRead } };
    db.$transaction.mockImplementationOnce(async (fn: any) => {
      calls.push('begin');
      const out = await fn(tx);
      calls.push('commit');
      return out;
    });
    await press('NO_ANSWER');
    const guardRead = txRead.mock.calls[0][0] as any;
    expect(guardRead.where).toEqual({ orderId: 'o1', companyId: 'c1' });
    expect(guardRead.select).toEqual({ createdAt: true, result: true, employeeId: true, attemptNumber: true });
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
    // The order of the writes: begin, then the guard's read, then the line — the guard came before the first write.
    expect(calls.slice(0, 3)).toEqual(['begin', 'guard-read', 'attempt']);
  });

  describe('the close at the third «لا يرد» rides on the proof too', () => {
    /** Two proven no-answers already on the order (each with its own press), nothing unresolved after them. */
    const twoProvenNoAnswers = () => {
      seed('OPENED', 600_000);
      seed('NO_ANSWER', 560_000);
      seed('OPENED', 400_000);
      seed('NO_ANSWER', 360_000);
    };

    it('a third «لا يرد» with NO press is refused and the order is NOT closed (without the guard it would be the third and close it)', async () => {
      twoProvenNoAnswers();
      const res = await press('NO_ANSWER');
      expect(res.status).toBe(409);
      expect(endOrder).not.toHaveBeenCalled();
      expect(written()).toBe(0);
    });

    it('with a press 30 s old the third is recorded and the close runs, as before', async () => {
      twoProvenNoAnswers();
      seed('OPENED', 30_000);
      const res = await press('NO_ANSWER');
      expect(res.status).toBe(200);
      expect(endOrder).toHaveBeenCalledTimes(1);
      expect(endOrder.mock.calls[0][0]).toMatchObject({ reason: 'NO_ANSWER_3_ATTEMPTS', orderId: 'o1' });
    });
  });
});

describe('ON — the typed duration', () => {
  it('an answered call keeps the whole seconds the phone measured', async () => {
    expect((await press('ANSWERED', { durationSeconds: 95 })).status).toBe(200);
    expect(db.orderContactAttempt.create.mock.calls[0][0].data.durationSeconds).toBe(95);
  });

  it.each([[-1], [1.5], ['12'], [14_401], [{}]])('%j is refused 400 and nothing is written', async (bad) => {
    const res = await press('ANSWERED', { durationSeconds: bad });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_DURATION' });
    expect(written()).toBe(0);
  });

  it.each([[0], [14_400]])('the bounds are inclusive: %j is stored', async (ok) => {
    expect((await press('ANSWERED', { durationSeconds: ok })).status).toBe(200);
    expect(db.orderContactAttempt.create.mock.calls[0][0].data.durationSeconds).toBe(ok);
  });

  it('no duration at all is stored as «not measured» (null) — never zero', async () => {
    await press('ANSWERED');
    expect(db.orderContactAttempt.create.mock.calls[0][0].data.durationSeconds).toBeNull();
  });
});

describe('ON — what the order window is told', () => {
  const get = () => GET(new Request('http://localhost/x'), params);

  it('no press → NO_OPENED, a young press → WAIT with the unlock instant, an old one → READY, and the server’s clock rides along', async () => {
    let body = await (await get()).json();
    expect(body.callProof).toEqual({ on: true, serverNow: T0, state: 'NO_OPENED', unlocksAtMs: null });
    seed('OPENED', 10_000);
    body = await (await get()).json();
    expect(body.callProof).toEqual({ on: true, serverNow: T0, state: 'WAIT', unlocksAtMs: T0 + 20_000 });
    advance(20_000);
    body = await (await get()).json();
    expect(body.callProof).toMatchObject({ state: 'READY', unlocksAtMs: null });
  });
});

describe('OFF — the door is today’s', () => {
  beforeEach(() => {
    proof.on = false;
  });

  it('a «لا يرد» with no press at all is recorded, the guard is never asked, and the write carries no new key', async () => {
    const res = await press('NO_ANSWER', { durationSeconds: 7 });
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(['attempt', 'autoClosed', 'noAnswerCount', 'noAnswerLimit', 'success']);
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
    expect(Object.keys(db.orderContactAttempt.create.mock.calls[0][0].data)).not.toContain('durationSeconds');
    expect(logAudit.mock.calls.map((c: any[]) => c[0].action)).toEqual(['CONTACT_ATTEMPT_RECORDED']);
    expect(logAudit.mock.calls[0][0].newData).not.toHaveProperty('durationSeconds');
  });

  it('a bad typed duration is not even looked at', async () => {
    expect((await press('ANSWERED', { durationSeconds: 'abc' })).status).toBe(200);
  });

  it('the GET answer has no callProof key', async () => {
    const body = await (await GET(new Request('http://localhost/x'), params)).json();
    expect(body).not.toHaveProperty('callProof');
    expect(Object.keys(body).sort()).toEqual(['attempts', 'summary']);
  });
});
