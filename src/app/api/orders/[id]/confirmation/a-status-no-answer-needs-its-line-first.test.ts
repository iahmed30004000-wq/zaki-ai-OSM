import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTACT_FIRST_MESSAGE } from '@/lib/confirmation-queue';
import { CALL_PROOF_WORDS } from '@/lib/call-proof-words';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE CONFIRMATION DOOR OF «إثبات المكالمات» (Confirmation Center v2, step A)
 *
 * The contact door (`a-no-answer-needs-a-call-thirty-seconds-old.test.ts`) is where the thirty seconds are asked. This door can also put an order on «لا يرد», so it
 * must not be a side door around them. With the switch ON:
 *
 *  1. `contact_result` that lands on «لا يرد» (NO_ANSWER, BUSY, and WRONG_NUMBER, which maps there too) is the second half of a pair: her OWN newest outcome line of the same
 *     result, no older than two minutes, must already be on the order — else 409 `CALL_NOT_LOGGED` and nothing is written. Presses and messages after that line are walked past.
 *  2. «رقم غلط» additionally needs a press of hers before its line (409 `CALL_NOT_STARTED`): it is not guarded at the contact door, so without this it would be the open back door.
 *  3. A date saved with the reason «لا يرد» (`schedule_follow_up`) asks the proof itself — a press of hers thirty seconds old — because no line is written there; any other reason is not asked.
 *  4. A supervisor’s audited override is not asked — the exit this door already has: the transition table REFUSED the move and an `orders.unlock` holder carried it with a written
 *     reason of at least five characters. A note on a move the table allows exempts nothing, and neither does a 4-character or a blank one.
 *  5. The «contact first» refusal says «اتصال» (not «أو اكبس لا يرد») with the switch on, and keeps its old words with it off.
 *  6. No other action pays for the switch read: «start» and an answered call.
 *
 * With the switch OFF the door is today’s: not one extra read.
 *
 * The mocks of `a-date-takes-the-order-out-of-her-hand.test.ts` (the same door) with a stateful fake of the attempt table. Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, calls, rows, requireContext, assertOrderAccess, can, logAudit, proof } = vi.hoisted(() => {
  const calls: string[] = [];
  const rows: any[] = [];
  const db: any = {
    order: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderClaimHistory: { create: vi.fn(), findFirst: vi.fn() },
    orderContactAttempt: { count: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    db,
    calls,
    rows,
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    can: vi.fn(),
    logAudit: vi.fn(),
    proof: { on: true, reads: 0 },
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn(async () => 1) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: () => ({ allowed: true }),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines: vi.fn(), releaseOrderLines: vi.fn(), orderLinesForGuard: vi.fn(async () => []) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/call-proof-switch', () => ({
  callProofOn: async () => {
    proof.reads += 1;
    return proof.on;
  },
}));

import { POST } from '@/app/api/orders/[id]/confirmation/route';
import { CONFIRMATION_RULE_DEFAULT, documentAfterSave } from '@/lib/confirmation-rule-settings';

const T0 = new Date('2026-11-15T10:00:00.000Z').getTime();
const ME = { id: 'actor-1', name: 'منفّذ', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' };
const ctx = {
  user: ME, companyId: 'c1', storeId: 'store-a', countryId: 'jo',
  country: { id: 'jo', code: 'JO', timezone: 'Asia/Amman', allowNegativeStock: false, workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5] },
};
const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 'store-a', orderNumber: 'ORD-1', version: 1, moderatorId: 'mod-1', claimedById: ME.id, claimedAt: new Date(T0 - 3_600_000),
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', lockedById: null, lockExpiresAt: null, shippedAt: null,
  nextFollowUpAt: null, followUpStatus: null, regionId: 'r1',
  ...over,
});
const params = { params: Promise.resolve({ id: 'o1' }) };
const post = (body: unknown) =>
  POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), params);
const line = (result: string, ageMs: number, employeeId = ME.id) =>
  rows.push({ createdAt: new Date(Date.now() - ageMs), result, employeeId, attemptNumber: rows.length + 1 });
const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const noAnswer = (result = 'NO_ANSWER') => post({ action: 'contact_result', result, expectedVersion: 1 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  calls.length = 0;
  rows.length = 0;
  proof.on = true;
  proof.reads = 0;
  requireContext.mockResolvedValue(ctx);
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log' || key === 'orders.confirm');
  db.$transaction.mockImplementation(async (fn: any) => {
    calls.push('begin');
    const out = await fn(db);
    calls.push('commit');
    return out;
  });
  db.order.updateMany.mockImplementation(async ({ where }: any) => (calls.push('version' in where ? 'write' : 'release'), { count: 1 }));
  db.orderStatusLog.create.mockImplementation(async () => void calls.push('statusLog'));
  db.orderActivity.create.mockImplementation(async () => void calls.push('activity'));
  db.orderClaimHistory.create.mockImplementation(async () => void calls.push('history'));
  db.order.findUnique.mockResolvedValue(order());
  assertOrderAccess.mockResolvedValue({ allowed: true, order: order() });
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.orderContactAttempt.findMany.mockImplementation(async () => rows.map((r) => ({ ...r })));
  db.orderClaimHistory.findFirst.mockResolvedValue(null);
});

describe('ON — «لا يرد» through the status door is the second half of a pair', () => {
  it('with no attempt line it is refused CALL_NOT_LOGGED and the order is not touched', async () => {
    const res = await noAnswer();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CALL_NOT_LOGGED', errorAr: CALL_PROOF_WORDS.notLogged });
    expect(calls).not.toContain('write');
    expect(logAudit.mock.calls.map((c: any[]) => c[0])).toEqual([expect.objectContaining({ action: 'CALL_PROOF_REFUSED', entityId: 'o1', newData: expect.objectContaining({ code: 'CALL_NOT_LOGGED', door: 'STATUS' }) })]);
  });

  it('her own newest outcome line of the same result, a moment ago, lets it through — and the write happens', async () => {
    line('OPENED', 40_000);
    line('NO_ANSWER', 5_000);
    const res = await noAnswer();
    expect(res.status).toBe(200);
    expect(calls).toContain('write');
  });

  it('the guard read is this order’s lines of this company, inside the transaction and before the write', async () => {
    line('NO_ANSWER', 5_000);
    await noAnswer();
    const read = db.orderContactAttempt.findMany.mock.calls[0][0];
    expect(read.where).toEqual({ orderId: 'o1', companyId: 'c1' });
    expect(read.select).toEqual({ createdAt: true, result: true, employeeId: true, attemptNumber: true });
    expect(calls.indexOf('begin')).toBeLessThan(calls.indexOf('write'));
  });

  it('a colleague’s line, a line older than two minutes, or a line of another result is not her pair', async () => {
    line('NO_ANSWER', 5_000, 'someone-else');
    expect((await noAnswer()).status).toBe(409);
    rows.length = 0;
    line('NO_ANSWER', 121_000);
    expect((await noAnswer()).status).toBe(409);
    rows.length = 0;
    line('NO_ANSWER', 5_000);
    expect((await noAnswer('BUSY')).status).toBe(409);
    rows.length = 0;
    line('BUSY', 5_000);
    expect((await noAnswer('BUSY')).status).toBe(200);
  });

  it('a press that landed between her two calls is walked past', async () => {
    line('NO_ANSWER', 6_000);
    line('OPENED', 3_000);
    line('MESSAGE_SENT', 2_000);
    expect((await noAnswer()).status).toBe(200);
  });

  it('«رقم غلط» lands on «لا يرد» too: its own line alone is not enough — it needs a press of hers before it', async () => {
    line('WRONG_NUMBER', 2_000);
    const refused = await noAnswer('WRONG_NUMBER');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'CALL_NOT_STARTED' });
    expect(calls).not.toContain('write');
    rows.length = 0;
    line('OPENED', 8_000);
    line('WRONG_NUMBER', 2_000);
    expect((await noAnswer('WRONG_NUMBER')).status).toBe(200);
  });

  describe('the supervisor’s override is the one the transition table already has', () => {
    const asUnlockHolder = () => can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log' || key === 'orders.confirm' || key === 'orders.unlock');
    /** CONFIRMED → «لا يرد» is a move the table refuses: only an unlock holder with a written reason carries it. */
    const confirmedOrder = () => assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ confirmationStatus: 'CONFIRMED' }) });

    it('a real override (table refused, unlock holder, a written reason) is not asked for a line', async () => {
      asUnlockHolder();
      confirmedOrder();
      const res = await post({ action: 'contact_result', result: 'NO_ANSWER', note: 'العميل ما بيرد من يومين — موثّق', expectedVersion: 1 });
      expect(res.status).toBe(200);
      expect(calls).toContain('write');
      expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
    });

    it('a note of 4 characters, or a blank one, is no override: the table’s own refusal stands and nothing is written', async () => {
      asUnlockHolder();
      confirmedOrder();
      for (const note of ['abcd', '      ']) {
        const res = await post({ action: 'contact_result', result: 'NO_ANSWER', note, expectedVersion: 1 });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
      }
      expect(calls).not.toContain('write');
    });

    it('a note on a move the table ALLOWS exempts nothing: an unlock holder is bound like everybody else, with a note or without', async () => {
      asUnlockHolder();
      for (const note of ['ok ok ok ok', undefined]) {
        const res = await post({ action: 'contact_result', result: 'NO_ANSWER', note, expectedVersion: 1 });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'CALL_NOT_LOGGED' });
      }
      expect(calls).not.toContain('write');
    });

    it('…and the same note on a date saved with the reason «لا يرد» exempts nothing either', async () => {
      asUnlockHolder();
      const res = await post({ action: 'schedule_follow_up', nextFollowUpAt: tomorrow(), followUpReason: 'NO_ANSWER', note: 'ok ok ok ok', expectedVersion: 1 });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'CALL_NOT_STARTED' });
    });
  });
});

describe('ON — a date saved with the reason «لا يرد» asks the proof itself', () => {
  const later = (reason = 'NO_ANSWER') => post({ action: 'schedule_follow_up', nextFollowUpAt: tomorrow(), followUpReason: reason, expectedVersion: 1 });

  it('no press → CALL_NOT_STARTED; a press 5 s old → CALL_TOO_SOON; a press 31 s old → the date is saved', async () => {
    const none = await later();
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ code: 'CALL_NOT_STARTED' });
    line('OPENED', 5_000);
    const soon = await later();
    expect(soon.status).toBe(409);
    expect(await soon.json()).toMatchObject({ code: 'CALL_TOO_SOON', waitSeconds: 25 });
    expect(calls).not.toContain('write');
    rows.length = 0;
    line('OPENED', 31_000);
    expect((await later()).status).toBe(200);
    expect(calls).toContain('write');
  });

  it('any other reason is not asked — «العميل طلب يتصل لاحقاً» needs no press', async () => {
    expect((await later('CUSTOMER_REQUESTED_CALLBACK')).status).toBe(200);
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
  });
});

describe('ON — what is not asked', () => {
  it('an answered call and «start» do not even read the switch — and both still go through', async () => {
    expect((await post({ action: 'contact_result', result: 'ANSWERED', expectedVersion: 1 })).status).toBe(200);
    db.order.findUnique.mockResolvedValue(order({ confirmationStatus: 'NEW' }));
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ confirmationStatus: 'NEW' }) });
    expect((await post({ action: 'start', expectedVersion: 1 })).status).toBe(200);
    expect(proof.reads).toBe(0);
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
  });
});

describe('the «contact first» refusal', () => {
  const firstContact = async () => {
    db.orderContactAttempt.count.mockResolvedValue(0);
    return post({ action: 'confirm', expectedVersion: 1 });
  };

  it('ON: says «اتصال» and no longer points at «لا يرد»', async () => {
    const res = await firstContact();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'CONTACT_FIRST', errorAr: CALL_PROOF_WORDS.contactFirstV2 });
    expect(body.errorAr).not.toContain('لا يرد');
  });

  it('OFF: keeps today’s words', async () => {
    proof.on = false;
    const body = await (await firstContact()).json();
    expect(body.errorAr).toBe(CONTACT_FIRST_MESSAGE);
  });
});

describe('OFF — the door is today’s', () => {
  beforeEach(() => {
    proof.on = false;
  });

  it('«لا يرد» with no line is moved as it always was, and the attempts are not read', async () => {
    expect((await noAnswer()).status).toBe(200);
    expect(calls).toContain('write');
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
    expect(logAudit.mock.calls.map((c: any[]) => c[0].action)).not.toContain('CALL_PROOF_REFUSED');
  });

  it('a date with the reason «لا يرد» is saved with no press', async () => {
    expect((await post({ action: 'schedule_follow_up', nextFollowUpAt: tomorrow(), followUpReason: 'NO_ANSWER', expectedVersion: 1 })).status).toBe(200);
  });
});

/**
 * Request Q3b (review 19/11, blocker 2): the date saved with the reason «لا يرد» asks the proof with the RULE IN FORCE's seconds. The company stores «proof 45» (its own
 * company id: the reader caches per company, and the clock here is faked).
 */
describe('an edited rule stored for the company — the ATTEMPT question waits 45 seconds', () => {
  beforeEach(() => {
    const doc = documentAfterSave(null, { rule: { ...CONFIRMATION_RULE_DEFAULT, proofSeconds: 45 }, effectiveAt: new Date(0), byUserId: 'u9' }, 0);
    db.company = { findUnique: vi.fn(async () => ({ settings: JSON.stringify({ confirmationRule: doc }) })) };
    requireContext.mockResolvedValue({ ...ctx, companyId: 'c-q3b-attempt45' });
  });
  afterEach(() => {
    delete db.company;
  });

  it('a press 31 s old is CALL_TOO_SOON with 14 s left (the default would save it); 45 s saves the date', async () => {
    line('OPENED', 31_000);
    const soon = await post({ action: 'schedule_follow_up', nextFollowUpAt: tomorrow(), followUpReason: 'NO_ANSWER', expectedVersion: 1 });
    expect(soon.status).toBe(409);
    expect(await soon.json()).toMatchObject({ code: 'CALL_TOO_SOON', waitSeconds: 14 });
    rows.length = 0;
    line('OPENED', 45_000);
    expect((await post({ action: 'schedule_follow_up', nextFollowUpAt: tomorrow(), followUpReason: 'NO_ANSWER', expectedVersion: 1 })).status).toBe(200);
  });
});
