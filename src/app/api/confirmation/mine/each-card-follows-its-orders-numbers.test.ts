import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q4d (21/11) — «طلباتي»: TWO ORDERS OF TWO PRODUCTS ON ONE DESK, EACH CARD WITH ITS OWN NUMBERS
 *
 * With «إثبات المكالمات وجدول المحاولات» on and «منتج غالي: 7 محاولات» + «20 ثانية إثبات» on product pA:
 *  · the card of the pA order counts «من 7» (its words, its counter, its hint), waits its own 20 s (`proofSeconds` on the card, and its `callProof`);
 *  · the card of the pB order on the same desk counts «من 5» and carries no `proofSeconds` of its own (the desk's);
 *  · the desk's own `noAnswerLimit` and `proofSeconds` stay the base's (the desk-wide answer is unchanged);
 *  · the orders' facts are read ONCE for the whole desk — and not at all with no ORDER_NUMBERS row, where the answer is the one without rules, key for key.
 * The desk itself imports nothing new: it reads `proofSeconds` off the card (`ConfirmationMineScreen.tsx`).
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-15T10:00:00.000Z').getTime(); // 13:00 in Amman
const ENABLED_AT = new Date('2026-11-01T00:00:00.000Z');
const MIN = 60_000;

const { db, attempts, rules, facts, factReads, COUNTRY } = vi.hoisted(() => {
  const attempts: Array<{ orderId: string; createdAt: Date; result: string; employeeId: string; attemptNumber: number; nextFollowUpAt?: Date | null }> = [];
  const rules: any[] = [];
  const facts: Record<string, string[]> = { oa: ['pA'], ob: ['pB'] };
  const factReads: unknown[] = [];
  const row = (id: string) => ({
    id, orderNumber: `JO-${id}`, confirmationStatus: 'IN_PROGRESS', shippingStatus: null, totalAmount: 10, currency: 'JOD',
    claimedAt: new Date('2026-11-15T09:00:00.000Z'), nextFollowUpAt: null, postponedUntil: null,
    customer: { id: `c-${id}`, fullName: 'زبون', phone: '0791234567', rawPhone: '0791234567', totalOrders: 1 },
    items: [], addOns: [], _count: { contactAttempts: 2, notes: 0 },
  });
  const db = {
    order: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        if (where.id?.in) {
          factReads.push(where);
          return (where.id.in as string[]).map((id) => ({ id, storeId: 's1', productId: facts[id][0], channel: null, items: facts[id].map((p) => ({ productId: p })) }));
        }
        if (where.rejectionReason) return [];
        if (!('OR' in where)) return [];
        return [row('oa'), row('ob')];
      }),
      count: vi.fn(async () => 0),
    },
    orderContactAttempt: {
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => attempts.map((a) => ({ ...a }))),
    },
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    callHelperDevice: { findFirst: vi.fn(async () => null) },
    confirmationRule: { findMany: vi.fn(async () => rules.map((r) => ({ ...r }))) },
  };
  const COUNTRY = { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] };
  return { db, attempts, rules, facts, factReads, COUNTRY };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'Sara', role: 'CONFIRMATION_AGENT', companyId: 'c1', status: 'ACTIVE', permissions: [] },
    companyId: 'c1', storeId: 's1', countryId: 'co1', country: COUNTRY,
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined, can: (_u: unknown, k: string) => k === 'confirmation.work' }));
vi.mock('@/lib/desk-watch', () => ({ DESK_NOT_FOUND: 'x', DESK_WATCH_REFUSAL: 'x', mayWatchDesks: () => true, watchedAgent: async () => ({ id: 'u2', name: 'Lina' }) }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/call-proof-switch', () => ({ callProofOn: async () => true, callProofSwitch: async () => ({ enabled: true, enabledAt: ENABLED_AT }) }));

import { GET } from './route';
import { forgetConfirmationRules } from '@/lib/employee-numbers';
import { scheduleOfAttempts } from '@/lib/confirmation-own-rules';

type Card = { id: string; noAnswerCount: number; dueWords: string | null; attemptWords?: string; noAnswerHint?: string; proofSeconds?: number; callProof?: { state: string; unlocksAtMs: number | null } };
type Desk = { work: Card[]; noAnswer: Card[]; noAnswerLimit: number; proofSeconds?: number };
const desk = async () => (await GET(new Request('http://localhost/api/confirmation/mine'))).json() as Promise<Desk>;
const card = (d: Desk, id: string) => [...d.work, ...d.noAnswer].find((c) => c.id === id)!;
const ruleRow = (over: Record<string, unknown>) => ({
  id: 'r1', companyId: 'c1', storeId: null, name: 'منتج غالي', kind: 'ORDER_NUMBERS', userIds: null, productId: 'pA', channelKind: null, phase: null, hoursFrom: null, hoursTo: null,
  effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), effectiveTo: null, isActive: true, payload: { ...scheduleOfAttempts(7), proofSeconds: 20 }, createdAt: new Date('2026-11-01T00:00:00.000Z'), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  forgetConfirmationRules('c1');
  attempts.length = 0;
  rules.length = 0;
  factReads.length = 0;
  facts.oa = ['pA'];
  facts.ob = ['pB'];
  // Both orders: one counted «لا يرد» an hour ago (due +30 min → due now), and a «اتصال» 10 s ago.
  for (const id of ['oa', 'ob']) {
    attempts.push({ orderId: id, createdAt: new Date(NOW - 60 * MIN), result: 'NO_ANSWER', employeeId: 'u1', attemptNumber: 1, nextFollowUpAt: new Date(NOW - 30 * MIN) });
    attempts.push({ orderId: id, createdAt: new Date(NOW - 10_000), result: 'OPENED', employeeId: 'u1', attemptNumber: 2 });
  }
});

describe('two products, one desk', () => {
  it('each card counts and waits by its own order’s rule; the desk-wide answer stays the base’s', async () => {
    rules.push(ruleRow({}));
    const d = await desk();
    const a = card(d, 'oa');
    const b = card(d, 'ob');
    expect(a.dueWords).toBe('لا يرد راجع — محاولة 2 من 7');
    expect(b.dueWords).toBe('لا يرد راجع — محاولة 2 من 5');
    expect(a.attemptWords).toContain('من 7');
    expect(b.attemptWords).toContain('من 5');
    expect(a.proofSeconds).toBe(20);
    expect(b.proofSeconds).toBeUndefined();
    expect(a.callProof).toMatchObject({ state: 'WAIT', unlocksAtMs: NOW + 10_000 });
    expect(b.callProof).toMatchObject({ state: 'WAIT', unlocksAtMs: NOW + 20_000 });
    expect(d.noAnswerLimit).toBe(5);
    expect(d.proofSeconds).toBeUndefined();
    expect(factReads).toHaveLength(1);
  });

  it('an order whose product was changed is counted by its current lines', async () => {
    rules.push(ruleRow({}));
    facts.oa = ['pC'];
    const d = await desk();
    expect(card(d, 'oa').dueWords).toBe('لا يرد راجع — محاولة 2 من 5');
    expect(card(d, 'oa').proofSeconds).toBeUndefined();
  });

  it('NEGATIVE: with no ORDER_NUMBERS row the facts are never read, and the answer is the rule-less one, key for key', async () => {
    const without = JSON.parse(JSON.stringify(await desk()));
    expect(factReads).toHaveLength(0);
    rules.push(ruleRow({ kind: 'EMPLOYEE_NUMBERS', productId: null, payload: { hand: 2 } }), ruleRow({ id: 'r2', productId: 'pZ' }));
    forgetConfirmationRules('c1');
    const binding = JSON.parse(JSON.stringify(await desk()));
    delete without.serverNow;
    delete binding.serverNow;
    expect(binding).toEqual(without);
  });
});

/** REVIEW OF #448 (21/11): every per-card limit is the ORDER's — pinned where a behaviour test above does not reach (a closed card, the hint beside «لا يرد»). */
describe('every card word reads its order’s limit', () => {
  it('the closed card and the «لا يرد» hint ask `limitOf(o.id)`, never the desk’s `planLimit`', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    expect(src).toContain('closedCardWords(row.noAnswerCount, limitOf(o.id))');
    expect(src).toContain('limit: desks ? limitOf(o.id) : NO_ANSWER_LIMIT');
    expect(src).toContain('cadenceCardWords(desks.get(o.id)!, now, country.timezone, limitOf(o.id))');
    expect(src).not.toMatch(/closedCardWords\([^)]*planLimit\)/);
  });
});
