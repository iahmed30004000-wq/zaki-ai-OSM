import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q4d — THE DIFFERENTIAL: «NO ORDER RULE = osm/main, BYTE FOR BYTE» AT THE CONFIRMATION DOOR
 *
 * `the-confirmation-door-without-order-rules.main-golden.json` was written by THIS file with `Q4D_GOLDEN_FROM` naming a copy of this door's `route.ts` as it is on
 * `osm/main` db1f1b20, over seeded presses of every action that reads a number of the rule: a customer's date (every reason, postponed 0–3 times already), a call
 * result with a date, a reject with the system's own reasons or another, «لا يرد» with and without a date — the plan and «أولوية الطابور» on or off. Recorded: the
 * status, the answer and the writes.
 *
 * Today's door answers them with NO rule row, and again with rows that bind NOTHING on this order: both must be the golden, record for record.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, out, sw, rules, seen } = vi.hoisted(() => {
  const out: unknown[] = [];
  const rules: any[] = [];
  const sw = { plan: true, priority: false };
  const seen = { postponeCount: 0 };
  const db: any = {
    order: {
      findFirst: vi.fn(async () => ({ postponeCount: seen.postponeCount })),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async (a: any) => (out.push({ update: { where: a.where, data: a.data } }), { count: 1 })),
      findMany: vi.fn(async () => [{ id: 'o1', storeId: 'store-a', productId: 'pA', channel: { kind: 'FACEBOOK' }, items: [{ productId: 'pA' }] }]),
    },
    orderStatusLog: { create: vi.fn(async (a: any) => void out.push({ statusLog: a.data })) },
    orderActivity: { create: vi.fn(async () => undefined) },
    orderClaimHistory: { create: vi.fn(async (a: any) => void out.push({ history: a.data })), findFirst: vi.fn(async () => null) },
    orderContactAttempt: { count: vi.fn(async () => 1), findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    confirmationRule: { findMany: vi.fn(async () => rules.map((r) => ({ ...r }))) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
    $executeRaw: vi.fn(),
  };
  return { db, out, sw, rules, seen };
});

const ME = { id: 'actor-1', name: 'منفّذ', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' };
const ORDER = {
  id: 'o1', companyId: 'c1', storeId: 'store-a', productId: 'pA', channelId: 'ch1', orderNumber: 'ORD-1', version: 1, moderatorId: 'mod-1', claimedById: 'actor-1',
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', lockedById: null, lockExpiresAt: null, shippedAt: null, nextFollowUpAt: null, followUpStatus: null, regionId: 'r1', postponeCount: 0,
};

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: ME, companyId: 'c1', storeId: 'store-a', countryId: 'jo', country: { id: 'jo', code: 'JO', timezone: 'Asia/Amman', allowNegativeStock: false, workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5] } }),
}));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: async () => ({ allowed: true, order: { ...ORDER } }), ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 } }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/desk-refusals', () => ({ logDeskRefusal: vi.fn(async (a: any) => void out.push({ refusal: a.code })) }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn(async () => 1) }));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, key: string) => key === 'orders.contact_log' || key === 'orders.confirm', authorize: () => ({ allowed: true }), requirePermission: vi.fn() }));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines: vi.fn(), releaseOrderLines: vi.fn(), orderLinesForGuard: vi.fn(async () => []) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-cadence-switch', () => ({ cadenceSince: async () => (sw.plan ? new Date('2026-11-17T10:12:00.000Z') : null) }));
vi.mock('@/lib/call-proof-switch', () => ({ callProofOn: async () => false, callProofSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/queue-priority-switch', () => ({ queuePrioritySwitch: async () => ({ enabled: sw.priority, enabledAt: null }) }));

import { forgetConfirmationRules } from '@/lib/employee-numbers';
import { scheduleOfAttempts } from '@/lib/confirmation-own-rules';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 150;
const SEED = 20261121;
const GOLDEN = join(process.cwd(), 'src/app/api/orders/[id]/confirmation/the-confirmation-door-without-order-rules.main-golden.json');
const rule = (over: Record<string, unknown>) => ({
  id: `n${Math.random()}`, companyId: 'c1', storeId: null, name: 'لا تمسك', kind: 'ORDER_NUMBERS', userIds: null, productId: null, channelKind: null, phase: null, hoursFrom: null, hoursTo: null,
  effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), effectiveTo: null, isActive: true, payload: { ...scheduleOfAttempts(7), postponeMax: 1, proofSeconds: 15 }, createdAt: new Date('2026-11-01T00:00:00.000Z'), ...over,
});
const BIND_NOTHING = () => [
  rule({ companyId: 'c2', productId: 'pA' }),
  rule({ isActive: false, productId: 'pA' }),
  rule({ storeId: 'store-b' }),
  rule({ productId: 'pZ' }),
  rule({ channelKind: 'TIKTOK' }),
  rule({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 } }),
];

const BODIES = [
  (d: string) => ({ action: 'schedule_follow_up', nextFollowUpAt: d, followUpReason: 'CUSTOMER_REQUESTED_CALLBACK' }),
  (d: string) => ({ action: 'schedule_follow_up', nextFollowUpAt: d, followUpReason: 'POSTPONED' }),
  (d: string) => ({ action: 'schedule_follow_up', nextFollowUpAt: d, followUpReason: 'NO_ANSWER' }),
  (d: string) => ({ action: 'contact_result', result: 'CALLBACK_REQUESTED', nextFollowUpAt: d, followUpReason: 'OTHER' }),
  () => ({ action: 'reject', rejectionReason: 'NO_ANSWER_5_ATTEMPTS' }),
  () => ({ action: 'reject', rejectionReason: 'NO_ANSWER_3_ATTEMPTS' }),
  () => ({ action: 'reject', rejectionReason: 'PRICE_TOO_HIGH' }),
];

async function runScenarios(POST: (r: Request, p: { params: Promise<{ id: string }> }) => Promise<Response>) {
  const records: unknown[] = [];
  for (let i = 0; i < N; i++) {
    const next = rng(SEED + i);
    forgetConfirmationRules('c1');
    out.length = 0;
    sw.plan = next() < 0.6;
    sw.priority = next() < 0.4;
    seen.postponeCount = Math.floor(next() * 4);
    const body = { ...BODIES[Math.floor(next() * BODIES.length)]('2026-12-20T10:00:00.000Z'), expectedVersion: 1 };
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'o1' }) });
    records.push({ body, plan: sw.plan, priority: sw.priority, seen: seen.postponeCount, status: res.status, answer: JSON.parse(JSON.stringify(await res.json())), writes: JSON.parse(JSON.stringify(out)) });
  }
  return records;
}

describe('the confirmation door with no order rule that binds it = osm/main', () => {
  it.each([
    ['no rule row', () => []],
    ['rows that bind nothing here', BIND_NOTHING],
  ])('%s → the golden, record for record', async (_name, make) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T08:00:00.000Z'));
    rules.length = 0;
    rules.push(...make());
    const from = process.env.Q4D_GOLDEN_FROM;
    if (from) writeFileSync(GOLDEN, JSON.stringify(await runScenarios((await import(/* @vite-ignore */ from)).POST)));
    expect(existsSync(GOLDEN)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as unknown[];
    expect(golden).toHaveLength(N);
    const today = await runScenarios((await import('./route')).POST);
    for (let i = 0; i < N; i++) expect(today[i], `press ${i}`).toEqual(golden[i]);
    vi.useRealTimers();
  });
});
