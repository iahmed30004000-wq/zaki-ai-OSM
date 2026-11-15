import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE CONTACT DOOR UNDER THE FIVE-ATTEMPT PLAN (Confirmation Center v2, step B)
 *
 * With the switch ON (the same switch as the proof):
 *
 *  1. A «لا يرد» / «مشغول» / «مسكّر» is an attempt. #1 counts at once and its line carries the plan's due (+30 min) on `nextFollowUpAt`; the order goes back to the queue (the holder's
 *     COUNTED press releases). A press BEFORE its due is kept and told, never counted, writes no due and releases nothing; a press exactly AT the due counts.
 *  2. The fifth COUNTED press, on the second local day, closes the order in the same transaction through the one door (`endOrder`, CONTACT_AUTO_CLOSE, NO_ANSWER_5_ATTEMPTS, the real N = 5).
 *     Three and four counted close nothing. Five presses crammed into one day cannot close.
 *  3. The line is written ONCE with its due on it and with the instant the plan used; the table is never updated; the plan is read through the transaction, after the proof guard and before
 *     the write; a proof refusal reaches none of it.
 *  4. Lines at or before the switch's `enabledAt` never count; a call that reached somebody does not reset the plan; BUSY and UNREACHABLE count; any other result is recorded as before.
 *  5. The answer says the limit is 5 and carries `cadence { attempt, of, counted, dueAt, words }` for a no-answer-class line; the audit row logs what was STORED.
 *
 * With the switch OFF the door is today's, key for key: `count()`, never the plan's read, the five answer keys, limit 3, the third no-answer closes.
 *
 * The harness of `a-no-answer-needs-a-call-thirty-seconds-old.test.ts` (a small stateful fake of the attempt table, a fake clock). Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, calls, rows, requireContext, assertOrderAccess, assertOrderReadable, logAudit, endOrder, announce, proof, cad, sw, rsw, order } = vi.hoisted(() => {
  const calls: string[] = [];
  const rows: any[] = [];
  const db = {
    orderContactAttempt: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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
    announce: vi.fn(),
    proof: { on: true },
    cad: { value: { enabled: true, enabledAt: new Date('2026-11-14T00:00:00.000Z') } as { enabled: boolean; enabledAt: Date | null } },
    sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
    rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
    order: { current: null as any },
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
vi.mock('@/lib/call-proof-switch', () => ({ callProofOn: async () => proof.on, callProofSwitch: async () => (proof.on ? cad.value : { enabled: false, enabledAt: null }) }));

import { POST } from '@/app/api/orders/[id]/contact-attempts/route';

const T0 = new Date('2026-11-15T10:00:00.000Z'); // 13:00 in Amman (UTC+3)
const MIN = 60_000;
const params = { params: Promise.resolve({ id: 'o1' }) };
const send = (body: Record<string, unknown>) =>
  POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactMethod: 'PHONE', ...body }) }), params);
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);
const written = () => calls.filter((c) => c === 'attempt').length;
const lineNo = (result: string, at: Date, employeeId = 'u1') =>
  rows.push({ id: `s${rows.length}`, orderId: 'o1', companyId: 'c1', createdAt: at, result, employeeId, attemptNumber: rows.length + 1 });

/** A press at `when`, with its own proven «اتصال» a minute before it (the step-A guard is part of this door), exactly as an agent would make it. */
async function pressAt(when: Date, result = 'NO_ANSWER', extra: Record<string, unknown> = {}) {
  lineNo('OPENED', ms(when, -MIN));
  vi.setSystemTime(when);
  const res = await send({ result, ...extra });
  return { res, body: await res.json() };
}

/** The five attempts of the plan, each on time: #1 13:00, #2 13:30, #3 15:30, #4 next day 09:00, #5 18:00 that day (Amman). */
const PLAN = [T0, ms(T0, 30 * MIN), ms(T0, 150 * MIN), new Date('2026-11-16T06:00:00.000Z'), new Date('2026-11-16T15:00:00.000Z')];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  calls.length = 0;
  rows.length = 0;
  proof.on = true;
  cad.value = { enabled: true, enabledAt: new Date('2026-11-14T00:00:00.000Z') };
  sw.value = { enabled: false, enabledAt: null };
  rsw.value = { enabled: false, enabledAt: null };
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Agent', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' },
  });
  order.current = {
    id: 'o1', claimedById: 'u1', claimedAt: new Date(T0.getTime() - 3_600_000), confirmationStatus: 'IN_PROGRESS', nextFollowUpAt: null, followUpStatus: null, shippingStatus: 'NOT_READY',
  };
  assertOrderAccess.mockImplementation(async () => ({ allowed: true, order: order.current }));
  assertOrderReadable.mockImplementation(async () => ({ allowed: true, order: order.current }));
  db.orderContactAttempt.findFirst.mockImplementation(async () => (rows.length ? { attemptNumber: rows[rows.length - 1].attemptNumber } : null));
  db.orderContactAttempt.findMany.mockImplementation(async () => rows.map((r) => ({ ...r })));
  db.orderContactAttempt.count.mockImplementation(async () => rows.filter((r) => ['NO_ANSWER', 'BUSY', 'UNREACHABLE'].includes(r.result)).length);
  db.orderContactAttempt.create.mockImplementation(async ({ data }: any) => {
    calls.push('attempt');
    const row = { ...data, id: `a${rows.length + 1}`, createdAt: data.createdAt ?? new Date() };
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
  announce.mockResolvedValue(undefined);
  endOrder.mockResolvedValue({ ok: true, orderNumber: 'ORD-1', afterCommit: announce });
});

afterEach(() => vi.useRealTimers());

describe('ON — #1 counts, carries its due, and the order goes back to the queue', () => {
  it('ONE insert with createdAt = the press instant and nextFollowUpAt = +30 min; released; the answer says 1 of 5', async () => {
    const { res, body } = await pressAt(T0);
    expect(res.status).toBe(200);
    expect(written()).toBe(1);
    const data = db.orderContactAttempt.create.mock.calls[0][0].data;
    expect(data.createdAt).toEqual(T0);
    expect(data.nextFollowUpAt).toEqual(ms(T0, 30 * MIN));
    expect(calls).toContain('release');
    expect(body).toMatchObject({ success: true, noAnswerCount: 1, noAnswerLimit: 5, autoClosed: false, returnedToQueue: true });
    expect(body.cadence).toEqual({
      attempt: 1,
      of: 5,
      counted: true,
      dueAt: ms(T0, 30 * MIN).toISOString(),
      words: 'انحسبت المحاولة 1 من 5 — رجع الطلب للطابور، والمحاولة الجاية الساعة 13:30.',
    });
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('the statement order: begin, the guard’s read, the PLAN’s read, the line, the release, its history, commit — and the table is never updated, db never read', async () => {
    let reads = 0;
    const tx = {
      ...db,
      orderContactAttempt: {
        ...db.orderContactAttempt,
        findMany: vi.fn(async (_a: unknown) => {
          calls.push(++reads === 1 ? 'guard-read' : 'plan-read');
          return rows.map((r) => ({ ...r }));
        }),
      },
    };
    db.$transaction.mockImplementationOnce(async (fn: any) => {
      calls.push('begin');
      const out = await fn(tx);
      calls.push('commit');
      return out;
    });
    await pressAt(T0);
    expect(calls).toEqual(['begin', 'guard-read', 'plan-read', 'attempt', 'release', 'history', 'commit']);
    const planRead = tx.orderContactAttempt.findMany.mock.calls[1][0] as any;
    expect(planRead.where).toEqual({ orderId: 'o1', companyId: 'c1' });
    expect(planRead.select).toEqual({ createdAt: true, result: true, attemptNumber: true });
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
    expect(db.orderContactAttempt.count).not.toHaveBeenCalled();
    expect(db.orderContactAttempt.update).not.toHaveBeenCalled();
    expect(db.orderContactAttempt.updateMany).not.toHaveBeenCalled();
  });

  it('a press BEFORE its due is early: inserted with no due, nothing released, told — and the counted number does not move', async () => {
    await pressAt(T0);
    calls.length = 0;
    const { body } = await pressAt(ms(T0, 30 * MIN - 1));
    expect(body.cadence).toMatchObject({ attempt: 1, counted: false, dueAt: ms(T0, 30 * MIN).toISOString() });
    expect(body.cadence.words).toBe('سجّلنا الضغطة بس ما انحسبت محاولة — لسا بدري. المحاولة 2 من 5 بتنحسب الساعة 13:30.');
    expect(body.noAnswerCount).toBe(1);
    expect(body.returnedToQueue).toBeUndefined();
    expect(calls).not.toContain('release');
    const data = db.orderContactAttempt.create.mock.calls[1][0].data;
    expect(data.nextFollowUpAt).toBeNull();
    expect(data.createdAt).toEqual(ms(T0, 30 * MIN - 1));
    expect(data.result).toBe('NO_ANSWER');
  });

  it('a press exactly AT the due counts, and one millisecond after counts too', async () => {
    await pressAt(T0);
    const at = await pressAt(ms(T0, 30 * MIN));
    expect(at.body.cadence).toMatchObject({ attempt: 2, counted: true, dueAt: ms(T0, 150 * MIN).toISOString() });
    expect(at.body.noAnswerCount).toBe(2);
    expect(db.orderContactAttempt.create.mock.calls[1][0].data.nextFollowUpAt).toEqual(ms(T0, 150 * MIN));
  });

  it('the counted press of a non-holder (a supervisor) writes the due and releases nothing', async () => {
    order.current = { ...order.current, claimedById: 'colleague' };
    const { body } = await pressAt(T0);
    expect(body.cadence).toMatchObject({ attempt: 1, counted: true });
    expect(db.orderContactAttempt.create.mock.calls[0][0].data.nextFollowUpAt).toEqual(ms(T0, 30 * MIN));
    expect(calls).not.toContain('release');
    expect(body.returnedToQueue).toBeUndefined();
    expect(body.cadence.words).toBe('انحسبت المحاولة 1 من 5 — المحاولة الجاية الساعة 13:30.');
  });
});

describe('ON — the close at the fifth counted press', () => {
  it('the five on-plan presses: 1-4 close nothing and release; the fifth (the second day) closes through the one door and releases nothing', async () => {
    for (let i = 0; i < 4; i++) {
      const { body } = await pressAt(PLAN[i]);
      expect(body).toMatchObject({ autoClosed: false, noAnswerCount: i + 1, returnedToQueue: true });
      expect(endOrder).not.toHaveBeenCalled();
    }
    calls.length = 0;
    const { res, body } = await pressAt(PLAN[4]);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, autoClosed: true, noAnswerCount: 5, noAnswerLimit: 5 });
    expect(body.returnedToQueue).toBeUndefined();
    expect(calls).not.toContain('release');
    expect(endOrder).toHaveBeenCalledTimes(1);
    expect(endOrder.mock.calls[0][0]).toMatchObject({
      orderId: 'o1',
      companyId: 'c1',
      storeId: 's1',
      door: 'CONTACT_AUTO_CLOSE',
      kind: 'CANCEL',
      endAs: 'CANCELLED',
      // The plan's own code and note («خمس») — not the rule of three's, which only the switch-off rule and the rounds still write.
      reason: 'NO_ANSWER_5_ATTEMPTS',
      rejectionNote: 'إغلاق تلقائي بعد 5 محاولات بلا رد',
      logNote: 'AUTO_CLOSE_NO_ANSWER_5_ATTEMPTS',
    });
    expect(endOrder.mock.calls[0][0].tx).toBe(db);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(body.cadence).toMatchObject({ attempt: 5, of: 5, counted: true, dueAt: null });
    expect(body.cadence.words).toContain('أُغلق الطلب تلقائياً');
  });

  it('five presses crammed into one day cannot close: every one after the first is early', async () => {
    for (let i = 0; i < 5; i++) await pressAt(ms(T0, i * 2 * MIN));
    expect(endOrder).not.toHaveBeenCalled();
    expect(written()).toBe(5);
    expect(rows.filter((r) => r.result === 'NO_ANSWER' && r.nextFollowUpAt).length).toBe(1);
  });

  it('four counted plus an early press: no close and no release', async () => {
    for (let i = 0; i < 4; i++) await pressAt(PLAN[i]);
    calls.length = 0;
    const { body } = await pressAt(ms(PLAN[3], 10 * MIN));
    expect(body).toMatchObject({ autoClosed: false, noAnswerCount: 4 });
    expect(body.cadence.counted).toBe(false);
    expect(endOrder).not.toHaveBeenCalled();
    expect(calls).not.toContain('release');
  });

  it('a refused close (the order moved on in the same instant) leaves the line, answers autoClosed false, releases nothing — and the NEXT no-answer asks again', async () => {
    for (let i = 0; i < 4; i++) await pressAt(PLAN[i]);
    endOrder.mockResolvedValueOnce({ ok: false, reason: 'ALREADY_ENDED' });
    calls.length = 0;
    const { body } = await pressAt(PLAN[4]);
    expect(body).toMatchObject({ autoClosed: false, noAnswerCount: 5 });
    expect(calls).not.toContain('release');
    expect(db.orderContactAttempt.create).toHaveBeenCalledTimes(5);
    expect(body.cadence.words).toBe('انحسبت المحاولة 5 من 5 — الطلب لسا مفتوح، والضغطة الجاية بتجرّب تسكّره من جديد.');
    const next = await pressAt(ms(PLAN[4], 2 * 3_600_000));
    expect(endOrder).toHaveBeenCalledTimes(2);
    expect(next.body.autoClosed).toBe(true);
  });

  it('a terminal or shipped order is never closed by the counter', async () => {
    for (let i = 0; i < 4; i++) await pressAt(PLAN[i]);
    order.current = { ...order.current, shippingStatus: 'IN_TRANSIT', claimedById: null };
    const { body } = await pressAt(PLAN[4]);
    expect(endOrder).not.toHaveBeenCalled();
    expect(body.autoClosed).toBe(false);
  });

  it('23:59 and then 00:29 next day: two local days, the plan reads them as the pure module does', async () => {
    const late = new Date('2026-11-15T20:59:00.000Z'); // 23:59 Amman
    const { body: first } = await pressAt(late);
    expect(first.cadence.dueAt).toBe(ms(late, 30 * MIN).toISOString());
    expect(first.cadence.words).toBe('انحسبت المحاولة 1 من 5 — رجع الطلب للطابور، والمحاولة الجاية بكرة الساعة 00:29.');
    const { body: second } = await pressAt(ms(late, 30 * MIN));
    expect(second.cadence).toMatchObject({ attempt: 2, counted: true });
  });
});

describe('ON — what counts and what does not', () => {
  it('lines at or before the switch went on never count: four old no-answers → the new press is #1', async () => {
    const floor = cad.value.enabledAt!;
    for (let i = 1; i <= 4; i++) lineNo('NO_ANSWER', ms(floor, -i * 3_600_000));
    const { body } = await pressAt(T0);
    expect(body.cadence).toMatchObject({ attempt: 1, counted: true });
    expect(body.noAnswerCount).toBe(1);
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('a call that reached somebody between two presses does not reset the plan', async () => {
    await pressAt(T0);
    await pressAt(ms(T0, 10 * MIN), 'ANSWERED');
    const { body } = await pressAt(ms(T0, 30 * MIN));
    expect(body.cadence).toMatchObject({ attempt: 2, counted: true });
  });

  it.each(['BUSY', 'UNREACHABLE'])('«%s» counts like «لا يرد»', async (result) => {
    await pressAt(T0, 'NO_ANSWER');
    const { body } = await pressAt(ms(T0, 30 * MIN), result);
    expect(body.cadence).toMatchObject({ attempt: 2, counted: true });
  });

  it('the lines of another employee count together with hers', async () => {
    lineNo('NO_ANSWER', ms(T0, -2 * 3_600_000), 'u2');
    const { body } = await pressAt(T0);
    expect(body.cadence).toMatchObject({ attempt: 2, counted: true });
  });

  it.each(['OPENED', 'MESSAGE_SENT', 'ANSWERED', 'WRONG_NUMBER'])('«%s» is recorded as before: no cadence key, no release, no createdAt from the door, the client’s date kept', async (result) => {
    const when = new Date(T0.getTime() + 3_600_000);
    const date = new Date(when.getTime() + 24 * 3_600_000).toISOString();
    const { res, body } = await pressAt(T0, result, { nextFollowUpAt: date });
    expect(res.status).toBe(200);
    expect(body.cadence).toBeUndefined();
    expect(body.noAnswerLimit).toBe(5);
    expect(body.noAnswerCount).toBe(0);
    expect(calls).not.toContain('release');
    const data = db.orderContactAttempt.create.mock.calls[0][0].data;
    expect('createdAt' in data).toBe(false);
    expect(data.nextFollowUpAt).toEqual(new Date(date));
  });

  it('a date the client sends on a no-answer line is validated (400 for the past) but never stored as the due', async () => {
    const past = new Date(T0.getTime() - 3_600_000).toISOString();
    const bad = await pressAt(T0, 'NO_ANSWER', { nextFollowUpAt: past });
    expect(bad.res.status).toBe(400);
    expect(written()).toBe(0);
    const future = new Date(T0.getTime() + 5 * 24 * 3_600_000).toISOString();
    const ok = await pressAt(T0, 'NO_ANSWER', { nextFollowUpAt: future });
    expect(ok.res.status).toBe(200);
    expect(db.orderContactAttempt.create.mock.calls[0][0].data.nextFollowUpAt).toEqual(ms(T0, 30 * MIN));
  });

  it('with «نظام الجولات» ON as well, the rounds’ own counting is not used and a press 31 minutes after #1 counts (the 180-minute gap is irrelevant)', async () => {
    sw.value = { enabled: true, enabledAt: new Date('2026-11-01T00:00:00Z') };
    await pressAt(T0);
    const { body } = await pressAt(ms(T0, 31 * MIN));
    expect(body.cadence).toMatchObject({ attempt: 2, counted: true });
    expect(db.orderContactAttempt.count).not.toHaveBeenCalled();
    // the rounds' own read is `where: { orderId }` with no company: the plan and the guard both read `{ orderId, companyId }`
    for (const call of db.orderContactAttempt.findMany.mock.calls) expect((call[0] as any)?.where).toEqual({ orderId: 'o1', companyId: 'c1' });
  });
});

describe('ON — refusals and failures write nothing', () => {
  it('a proof refusal (no «اتصال» press) writes nothing, releases nothing, closes nothing — and never reaches the plan’s read', async () => {
    vi.setSystemTime(T0);
    let reads = 0;
    const tx = { ...db, orderContactAttempt: { ...db.orderContactAttempt, findMany: vi.fn(async () => (reads++, [])) } };
    db.$transaction.mockImplementationOnce(async (fn: any) => fn(tx));
    const res = await send({ result: 'NO_ANSWER' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CALL_NOT_STARTED');
    expect(reads).toBe(1); // the guard's read only
    expect(written()).toBe(0);
    expect(calls).not.toContain('release');
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('a lost race on the attempt number (unique violation) answers 409, releases nothing, closes nothing and logs no CONTACT_ATTEMPT_RECORDED', async () => {
    lineNo('OPENED', ms(T0, -MIN));
    db.orderContactAttempt.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '0' }));
    const res = await send({ result: 'NO_ANSWER' });
    expect(res.status).toBe(409);
    expect(calls).not.toContain('release');
    expect(endOrder).not.toHaveBeenCalled();
    expect(logAudit.mock.calls.map((c: any[]) => c[0].action)).not.toContain('CONTACT_ATTEMPT_RECORDED');
  });
});

describe('ON — the audit row logs what was STORED', () => {
  it('a counted press: the stored due and a cadence block; an early press: null and counted false; another result: the client’s date and no block', async () => {
    await pressAt(T0);
    await pressAt(ms(T0, 5 * MIN * 1));
    const date = new Date(T0.getTime() + 3 * 24 * 3_600_000).toISOString();
    await pressAt(ms(T0, 10 * MIN), 'ANSWERED', { nextFollowUpAt: date });
    const recorded = logAudit.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.action === 'CONTACT_ATTEMPT_RECORDED');
    expect(recorded).toHaveLength(3);
    expect(recorded[0].newData.nextFollowUpAt).toEqual(ms(T0, 30 * MIN));
    expect(recorded[0].newData.cadence).toEqual({ attempt: 1, counted: true, dueAt: ms(T0, 30 * MIN).toISOString() });
    expect(recorded[1].newData.nextFollowUpAt).toBeNull();
    expect(recorded[1].newData.cadence).toEqual({ attempt: 1, counted: false, dueAt: ms(T0, 30 * MIN).toISOString() });
    expect(recorded[2].newData.nextFollowUpAt).toEqual(new Date(date));
    expect('cadence' in recorded[2].newData).toBe(false);
  });
});

describe('OFF — the door is today’s, key for key', () => {
  beforeEach(() => {
    cad.value = { enabled: false, enabledAt: null };
  });

  it('count() is asked (never the plan’s read), the answer has exactly the five keys and the limit 3, the data has no createdAt key', async () => {
    lineNo('OPENED', ms(T0, -MIN));
    let planReads = 0;
    const tx = { ...db, orderContactAttempt: { ...db.orderContactAttempt, findMany: vi.fn(async () => (planReads++, rows.map((r) => ({ ...r })))) } };
    db.$transaction.mockImplementationOnce(async (fn: any) => fn(tx));
    const res = await send({ result: 'NO_ANSWER' });
    const body = await res.json();
    expect(planReads).toBe(1); // the proof guard's read; the cadence adds none
    expect(db.orderContactAttempt.count).toHaveBeenCalledTimes(1);
    expect(Object.keys(body).sort()).toEqual(['attempt', 'autoClosed', 'noAnswerCount', 'noAnswerLimit', 'success']);
    expect(body.noAnswerLimit).toBe(3);
    const data = db.orderContactAttempt.create.mock.calls[0][0].data;
    expect('createdAt' in data).toBe(false);
    expect(data.nextFollowUpAt).toBeNull();
  });

  it('the third no-answer closes, as it always did', async () => {
    for (let i = 0; i < 3; i++) {
      await pressAt(ms(T0, i * 2 * MIN));
    }
    expect(endOrder).toHaveBeenCalledTimes(1);
    // The switch off keeps the rule of three's own pair, byte for byte: the plan's code is never written without the plan.
    expect(endOrder.mock.calls[0][0]).toMatchObject({
      reason: 'NO_ANSWER_3_ATTEMPTS',
      rejectionNote: 'إغلاق تلقائي بعد 3 محاولات بلا رد',
      logNote: 'AUTO_CLOSE_NO_ANSWER_3_ATTEMPTS',
    });
  });

  it('with the proof OFF too, the switch is not even asked', async () => {
    proof.on = false;
    const res = await send({ result: 'NO_ANSWER' });
    expect(res.status).toBe(200);
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
  });
});
