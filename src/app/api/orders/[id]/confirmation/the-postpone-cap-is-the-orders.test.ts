import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q4d (21/11) — THE CONFIRMATION DOOR READS THE ORDER'S OWN NUMBERS
 *
 *  · The postpone cap is the order's: with «منتج: تأجيل الزبون مرة وحدة» on its product, an order already postponed once is refused the second date (409
 *    `POSTPONE_LIMIT`, the sentence names its own cap); an order of another product, postponed once, gets its second date (the base's two).
 *  · The «system only» sentence names the order's attempts (seven on «منتج غالي»).
 *  · No ORDER_NUMBERS row: the order is never read again (the door is main's — `the-plan-holds-the-postponements.test.ts` holds its sentences unchanged).
 *
 * The harness of `the-plan-holds-the-postponements.test.ts`, plus the rules table and the order's facts.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, calls, requireContext, assertOrderAccess, can, rules, facts } = vi.hoisted(() => {
  const calls: string[] = [];
  const rules: any[] = [];
  const facts = { productIds: ['pA'] as string[] };
  const db: any = {
    order: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderClaimHistory: { create: vi.fn(), findFirst: vi.fn() },
    orderContactAttempt: { count: vi.fn(), findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    confirmationRule: { findMany: vi.fn(async () => rules.map((r) => ({ ...r }))) },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return { db, calls, rules, facts, requireContext: vi.fn(), assertOrderAccess: vi.fn(), can: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn(async () => 1) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), authorize: () => ({ allowed: true }), requirePermission: vi.fn() }));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines: vi.fn(), releaseOrderLines: vi.fn(), orderLinesForGuard: vi.fn(async () => []) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-cadence-switch', () => ({ cadenceSince: async () => new Date('2026-11-17T10:12:00.000Z') }));
vi.mock('@/lib/call-proof-switch', () => ({ callProofOn: async () => false, callProofSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/queue-priority-switch', () => ({ queuePrioritySwitch: async () => ({ enabled: false, enabledAt: null }) }));

import { POST } from '@/app/api/orders/[id]/confirmation/route';
import { forgetConfirmationRules } from '@/lib/employee-numbers';
import { scheduleOfAttempts } from '@/lib/confirmation-own-rules';

const ME = { id: 'actor-1', name: 'منفّذ', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' };
const ctx = { user: ME, companyId: 'c1', storeId: 'store-a', countryId: 'jo', country: { id: 'jo', code: 'JO', timezone: 'Asia/Amman', allowNegativeStock: false, workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5] } };
const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 'store-a', productId: 'pA', orderNumber: 'ORD-1', version: 1, moderatorId: 'mod-1', claimedById: ME.id,
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', lockedById: null, lockExpiresAt: null, shippedAt: null, nextFollowUpAt: null, followUpStatus: null, regionId: 'r1', postponeCount: 0,
  ...over,
});
const params = { params: Promise.resolve({ id: 'o1' }) };
const post = (body: unknown) => POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), params);
const postpone = () => post({ action: 'schedule_follow_up', nextFollowUpAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), followUpReason: 'CUSTOMER_REQUESTED_CALLBACK', expectedVersion: 1 });
const ruleRow = (over: Record<string, unknown>) => ({
  id: 'r1', companyId: 'c1', storeId: null, name: 'قاعدة', kind: 'ORDER_NUMBERS', userIds: null, productId: 'pA', channelKind: null, phase: null, hoursFrom: null, hoursTo: null,
  effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), effectiveTo: null, isActive: true, payload: { postponeMax: 1 }, createdAt: new Date('2026-11-01T00:00:00.000Z'), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  forgetConfirmationRules('c1');
  calls.length = 0;
  rules.length = 0;
  facts.productIds = ['pA'];
  requireContext.mockResolvedValue(ctx);
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log' || key === 'orders.confirm');
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.order.updateMany.mockImplementation(async ({ where }: any) => (calls.push('version' in where ? 'write' : 'release'), { count: 1 }));
  db.order.findMany.mockImplementation(async ({ where }: any) => {
    calls.push('facts');
    return (where.id.in as string[]).map((id) => ({ id, storeId: 'store-a', productId: facts.productIds[0], channel: null, items: facts.productIds.map((p) => ({ productId: p })) }));
  });
  db.orderStatusLog.create.mockImplementation(async () => undefined);
  db.orderActivity.create.mockImplementation(async () => undefined);
  db.orderClaimHistory.create.mockImplementation(async () => undefined);
  db.order.findUnique.mockResolvedValue(order());
  db.order.findFirst.mockResolvedValue({ postponeCount: 1 });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: order() });
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.orderClaimHistory.findFirst.mockResolvedValue(null);
});

describe('the postpone cap is the order’s', () => {
  beforeEach(() => {
    rules.push(ruleRow({ name: 'منتج: تأجيل الزبون مرة وحدة', payload: { postponeMax: 1 } }));
  });

  it('the product with «once»: postponed once already → the second date is refused, its own cap in the sentence, nothing written', async () => {
    const res = await postpone();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'هالطلب انأجّل 1 مرات — ما بينأجّل مرة كمان. اتصل فيه وخذ قرار: تأكيد أو رفض.', code: 'POSTPONE_LIMIT' });
    expect(calls).not.toContain('write');
  });

  it('NEGATIVE: an order of another product, postponed once, gets its second date (the base’s two)', async () => {
    facts.productIds = ['pB'];
    const res = await postpone();
    expect(res.status).toBe(200);
    expect(calls).toContain('write');
  });

  it('its product changed to another: judged by the current line — the base’s two', async () => {
    facts.productIds = ['pC'];
    expect((await postpone()).status).toBe(200);
  });
});

describe('the «system only» sentence names the order’s attempts', () => {
  it('«منتج غالي» (seven): «بعد 7 محاولات»; another product: the base five', async () => {
    rules.push(ruleRow({ name: 'منتج غالي', payload: scheduleOfAttempts(7) }));
    const reject = () => post({ action: 'reject', rejectionReason: 'NO_ANSWER_5_ATTEMPTS', expectedVersion: 1 });
    const own = await (await reject()).json();
    expect(own.code).toBe('SYSTEM_ONLY_REASON');
    expect(own.errorAr).toContain('بعد 7 محاولات «لا يرد» محسوبة على يومين');
    facts.productIds = ['pB'];
    forgetConfirmationRules('c1');
    const other = await (await reject()).json();
    expect(other.errorAr).toContain('بعد 5 محاولات «لا يرد» محسوبة على يومين');
  });
});

describe('no ORDER_NUMBERS row = main', () => {
  it('the order is never read again, and the cap is the base’s two', async () => {
    rules.push(ruleRow({ kind: 'EMPLOYEE_NUMBERS', productId: null, payload: { hand: 2 } }));
    expect((await postpone()).status).toBe(200);
    db.order.findFirst.mockResolvedValue({ postponeCount: 2 });
    const res = await postpone();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('هالطلب انأجّل 2 مرات — ما بينأجّل مرة تالتة. اتصل فيه وخذ قرار: تأكيد أو رفض.');
    expect(calls).not.toContain('facts');
  });
});

/** REVIEW OF #448 (21/11): the proof seconds of a «لا يرد» date are asked of the same per-order rule (pinned: the plan refuses such a date before the proof is asked). */
describe('the proof seconds come from the order’s rule', () => {
  it('one `ruleNow`, built for the order, answers the cap, the sentence and the proof seconds', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    expect(src).toContain('const ruleNow = orderRuleOnce(db, companyId, id, confirmationRuleOnce(db, companyId));');
    expect(src).toContain('const proofSeconds = proofOn && !statusGuarded ? (await ruleNow()).proofSeconds : undefined;');
    expect(src.match(/confirmationRuleOnce\(/g)).toHaveLength(1);
  });
});
