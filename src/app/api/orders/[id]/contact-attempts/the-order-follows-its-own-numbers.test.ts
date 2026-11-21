import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q4d (21/11) — THE CONTACT DOOR JUDGES EACH ORDER BY ITS OWN NUMBERS
 *
 * With «إثبات المكالمات وجدول المحاولات» on and an owner's ORDER_NUMBERS rule on a product:
 *  1. the order of that product waits ITS proof seconds (20): a «لا يرد» 21 s after «اتصال» is written; an order of another product, the same 21 s, is refused (30);
 *  2. its plan has ITS attempts (3): the answer says «من 3», and the third counted press — on the second day — closes it through the one door; the other product's
 *     order still says «من 5» and is not closed by three;
 *  3. an order whose product is changed (its lines now another product) is judged by its CURRENT lines at the next press: the limit moves back to the base's;
 *  4. the order window's proof (GET) unlocks at the order's own seconds;
 *  5. no ORDER_NUMBERS row (or rows that bind nothing here): the order is never read again — the door is main's.
 *
 * The harness of `the-cadence-closes-at-five.test.ts`, plus the rules table and the order's facts.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, calls, rows, requireContext, assertOrderAccess, assertOrderReadable, logAudit, endOrder, announce, cad, order, rules, facts } = vi.hoisted(() => {
  const calls: string[] = [];
  const rows: any[] = [];
  const rules: any[] = [];
  const facts: Record<string, { productIds: string[]; channelKind: string | null }> = {};
  const db = {
    orderContactAttempt: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    order: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    orderClaimHistory: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    confirmationRule: { findMany: vi.fn(async () => rules.map((r) => ({ ...r }))) },
    $transaction: vi.fn(),
  } as any;
  return {
    db, calls, rows, rules, facts,
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    assertOrderReadable: vi.fn(),
    logAudit: vi.fn(),
    endOrder: vi.fn(),
    announce: vi.fn(),
    cad: { value: { enabled: true, enabledAt: new Date('2026-11-14T00:00:00.000Z') } as { enabled: boolean; enabledAt: Date | null } },
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
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/call-proof-switch', () => ({ callProofOn: async () => true, callProofSwitch: async () => cad.value }));

import { GET, POST } from '@/app/api/orders/[id]/contact-attempts/route';
import { forgetConfirmationRules } from '@/lib/employee-numbers';
import { scheduleOfAttempts } from '@/lib/confirmation-own-rules';

const T0 = new Date('2026-11-15T10:00:00.000Z'); // Sunday 13:00 in Amman
const MIN = 60_000;
const S = 1000;
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);
const params = { params: Promise.resolve({ id: 'o1' }) };
const send = (body: Record<string, unknown>) =>
  POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactMethod: 'PHONE', ...body }) }), params);

function ruleRow(over: Record<string, unknown>) {
  return {
    id: 'r1', companyId: 'c1', storeId: null, name: 'قاعدة', kind: 'ORDER_NUMBERS', userIds: null, productId: null, channelKind: null, phase: null, hoursFrom: null, hoursTo: null,
    effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), effectiveTo: null, isActive: true, payload: { proofSeconds: 20 }, createdAt: new Date('2026-11-01T00:00:00.000Z'), ...over,
  };
}

/** A press at `when`, its own «اتصال» `openedBefore` earlier. */
async function pressAt(when: Date, openedBefore = MIN, result = 'NO_ANSWER') {
  rows.push({ id: `s${rows.length}`, orderId: 'o1', companyId: 'c1', createdAt: ms(when, -openedBefore), result: 'OPENED', employeeId: 'u1', attemptNumber: rows.length + 1 });
  vi.setSystemTime(when);
  const res = await send({ result });
  return { res, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  forgetConfirmationRules('c1');
  calls.length = 0;
  rows.length = 0;
  rules.length = 0;
  for (const k of Object.keys(facts)) delete facts[k];
  facts.o1 = { productIds: ['pA'], channelKind: 'FACEBOOK' };
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Agent', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' },
  });
  order.current = {
    id: 'o1', companyId: 'c1', storeId: 's1', productId: 'pA', claimedById: 'u1', claimedAt: new Date(T0.getTime() - 3_600_000), confirmationStatus: 'IN_PROGRESS',
    nextFollowUpAt: null, followUpStatus: null, shippingStatus: 'NOT_READY',
  };
  assertOrderAccess.mockImplementation(async () => ({ allowed: true, order: order.current }));
  assertOrderReadable.mockImplementation(async () => ({ allowed: true, order: order.current }));
  db.order.findMany.mockImplementation(async ({ where }: any) => {
    calls.push('facts');
    return (where.id.in as string[])
      .filter((id) => facts[id])
      .map((id) => ({ id, storeId: 's1', productId: facts[id].productIds[0] ?? null, channel: { kind: facts[id].channelKind }, items: facts[id].productIds.map((p) => ({ productId: p })) }));
  });
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
  db.orderClaimHistory.findFirst.mockImplementation(async () => ({ id: 'h1', metadata: JSON.stringify({ automatic: true, holder: 'u1' }) }));
  db.orderClaimHistory.update.mockImplementation(async () => void calls.push('stamp'));
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  announce.mockResolvedValue(undefined);
  endOrder.mockResolvedValue({ ok: true, orderNumber: 'ORD-1', afterCommit: announce });
});

afterEach(() => vi.useRealTimers());

describe('1 · the proof seconds are the order’s', () => {
  beforeEach(() => {
    rules.push(ruleRow({ id: 'proof', name: 'منتج سريع', productId: 'pA', payload: { proofSeconds: 20 } }));
  });

  it('the order of the product with 20 s: a «لا يرد» 21 s after «اتصال» is written', async () => {
    const { res, body } = await pressAt(T0, 21 * S);
    expect(res.status).toBe(200);
    expect(body.cadence).toMatchObject({ attempt: 1, counted: true });
    expect(calls).toContain('attempt');
  });

  it('NEGATIVE: an order of another product, the same 21 s, is refused — its seconds are the base’s 30', async () => {
    facts.o1 = { productIds: ['pB'], channelKind: 'FACEBOOK' };
    const { res, body } = await pressAt(T0, 21 * S);
    expect(res.status).toBe(409);
    expect(body.code).toBe('CALL_TOO_SOON');
    expect(calls).not.toContain('attempt');
  });

  it('the order window (GET) unlocks at the order’s own 20 s', async () => {
    rows.push({ id: 's0', orderId: 'o1', companyId: 'c1', createdAt: ms(T0, -5 * S), result: 'OPENED', employeeId: 'u1', attemptNumber: 1, employee: { id: 'u1', name: 'Agent' } });
    const res = await GET(new Request('http://localhost/x'), params);
    const body = await res.json();
    expect(body.callProof).toMatchObject({ state: 'WAIT', unlocksAtMs: ms(T0, 15 * S).getTime() });
  });
});

describe('2 · the attempts are the order’s', () => {
  beforeEach(() => {
    rules.push(ruleRow({ id: 'three', name: 'تلات محاولات', productId: 'pA', payload: scheduleOfAttempts(3) }));
  });

  it('«من 3»: #1 now, #2 at its due (+30 min), #3 the next morning closes it — the plan’s own close, through the one door', async () => {
    const first = await pressAt(T0);
    expect(first.body).toMatchObject({ noAnswerLimit: 3, cadence: { attempt: 1, of: 3, counted: true } });
    expect(first.body.cadence.words).toBe('انحسبت المحاولة 1 من 3 — رجع الطلب للطابور، والمحاولة الجاية الساعة 13:30.');
    const second = await pressAt(new Date(first.body.cadence.dueAt));
    expect(second.body.cadence).toMatchObject({ attempt: 2, of: 3, counted: true });
    expect(endOrder).not.toHaveBeenCalled();
    const due3 = new Date(second.body.cadence.dueAt);
    expect(due3.toISOString()).toBe('2026-11-16T08:00:00.000Z'); // Monday 11:00 Amman, the morning anchor
    const third = await pressAt(due3);
    expect(third.body).toMatchObject({ autoClosed: true, noAnswerCount: 3, noAnswerLimit: 3 });
    expect(endOrder).toHaveBeenCalledTimes(1);
    expect(endOrder.mock.calls[0][0]).toMatchObject({ reason: 'NO_ANSWER_5_ATTEMPTS', rejectionNote: 'إغلاق تلقائي بعد 3 محاولات بلا رد' });
  });

  it('NEGATIVE: the order of another product on the same desk keeps the base five — three on-plan presses close nothing', async () => {
    facts.o1 = { productIds: ['pB'], channelKind: 'FACEBOOK' };
    const first = await pressAt(T0);
    expect(first.body).toMatchObject({ noAnswerLimit: 5, cadence: { of: 5 } });
    const second = await pressAt(new Date(first.body.cadence.dueAt));
    const third = await pressAt(new Date(second.body.cadence.dueAt));
    expect(third.body).toMatchObject({ autoClosed: false, noAnswerLimit: 5 });
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('an order of two products: the product rule reaches it through its line (every current line counts)', async () => {
    facts.o1 = { productIds: ['pZ', 'pA'], channelKind: 'FACEBOOK' };
    const first = await pressAt(T0);
    expect(first.body.cadence.of).toBe(3);
  });

  it('the product is changed after #1: the next press is judged by the CURRENT lines — the base five; the stored due is kept', async () => {
    const first = await pressAt(T0);
    expect(first.body.cadence.of).toBe(3);
    facts.o1 = { productIds: ['pC'], channelKind: 'FACEBOOK' };
    const second = await pressAt(new Date(first.body.cadence.dueAt));
    expect(second.body).toMatchObject({ noAnswerLimit: 5, cadence: { attempt: 2, of: 5, counted: true } });
    expect(rows.find((r) => r.id === 'a2')!.nextFollowUpAt).toEqual(ms(T0, 30 * MIN));
  });
});

describe('5 · nothing that binds this order = main', () => {
  it.each([
    ['no row', []],
    ['an employee rule', [ruleRow({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 } })]],
  ])('%s: the order is never read again; 30 s and five attempts', async (_n, list) => {
    rules.push(...(list as any[]));
    const early = await pressAt(T0, 21 * S);
    expect(early.res.status).toBe(409);
    const { body } = await pressAt(ms(T0, MIN), 31 * S);
    expect(body).toMatchObject({ noAnswerLimit: 5, cadence: { of: 5 } });
    expect(calls).not.toContain('facts');
  });

  it('a product rule of another product: read, and the order keeps every base number', async () => {
    rules.push(ruleRow({ productId: 'pZ', payload: { ...scheduleOfAttempts(3), proofSeconds: 20 } }));
    const early = await pressAt(T0, 21 * S);
    expect(early.res.status).toBe(409);
    const { body } = await pressAt(ms(T0, MIN), 31 * S);
    expect(body).toMatchObject({ noAnswerLimit: 5, cadence: { of: 5 } });
  });
});
