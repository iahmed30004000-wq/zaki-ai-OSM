import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q4b (21/11) — THE QUEUE DOOR SAYS HER NUMBERS AND THEIR SOURCE, AND ITS HAND IS HERS
 *
 *  1. With NO rule of the owner the answer is main's, key for key: no `numbers`, the hand the store's (`caps.total`).
 *  2. A rule naming her: `caps.total` is HER hand, `canPull` is judged by it, and `numbers` carries her hand, idle minutes and pull pace, each with its source in Arabic.
 *  3. A colleague on the same desk keeps the base hand; she sees `numbers` too (the company has a rule), all «من القاعدة الأساسية».
 *  4. The desk imports nothing for it: the words come in the answer (`staff-confirmation-first-load.test.ts` holds the bundle).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, queue, state } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(async () => []) },
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    confirmationRule: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  queue: { waitingByPlan: vi.fn(), ownedCounts: vi.fn(), postponedNotDueCount: vi.fn(), reservedForColleaguesCount: vi.fn() },
  state: { rules: [] as Record<string, unknown>[], company: 'c-0' },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn(async () => ({})) }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
// The plan «جدول المحاولات» is on: the base rule's hand (3) is the panel's limit.
vi.mock('@/lib/no-answer-cadence-switch', () => ({ cadenceSince: async () => new Date('2026-11-01T00:00:00Z') }));
vi.mock('@/lib/confirmation-queue', async (orig) => ({
  ...(await orig<typeof import('@/lib/confirmation-queue')>()),
  waitingByPlan: (...a: unknown[]) => queue.waitingByPlan(...a),
  ownedCounts: (...a: unknown[]) => queue.ownedCounts(...a),
  postponedNotDueCount: (...a: unknown[]) => queue.postponedNotDueCount(...a),
  reservedForColleaguesCount: (...a: unknown[]) => queue.reservedForColleaguesCount(...a),
}));

import { GET } from './route';

const COUNTRY = { workHoursStart: '08:00', workHoursEnd: '20:00', weekendDays: [] as number[], timezone: 'UTC' };
let n = 0;
const as = (userId: string) => requireContext.mockResolvedValue({ user: { id: userId }, companyId: state.company, storeId: 's1', country: COUNTRY });
const named = (ids: string[], payload: Record<string, number>) =>
  state.rules.push({
    id: `r${state.rules.length}`, companyId: state.company, storeId: null, name: 'الجديدة', kind: 'EMPLOYEE_NUMBERS', userIds: ids, productId: null, channelKind: null,
    phase: null, hoursFrom: null, hoursTo: null, effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null, isActive: true, payload,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });

beforeEach(() => {
  vi.clearAllMocks();
  n += 1;
  state.company = `c-q4b-${n}`;
  state.rules = [];
  db.confirmationRule.findMany.mockImplementation(async () => state.rules);
  can.mockImplementation((_u: unknown, k: string) => k === 'confirmation.pull');
  queue.waitingByPlan.mockResolvedValue({ fresh: 1, promise: 0, retry: 0, rest: 0 });
  queue.ownedCounts.mockResolvedValue({ total: 2, withoutAttempt: 0, untouched: null });
  queue.postponedNotDueCount.mockResolvedValue(0);
  queue.reservedForColleaguesCount.mockResolvedValue(0);
});

describe('the queue door', () => {
  it('no rule: no `numbers` key, the base hand of 3 — main\'s answer', async () => {
    as('sara');
    const body = await (await GET()).json();
    expect('numbers' in body).toBe(false);
    expect(body.caps).toEqual({ withoutAttempt: 40, total: 3 });
    expect(body.canPull).toBe(true);
  });

  it('a rule of hand 2 naming her: her limit is 2, she cannot pull with two, and her numbers say where they came from', async () => {
    named(['sara'], { hand: 2, pullPerHour: 15 });
    as('sara');
    const body = await (await GET()).json();
    expect(body.caps.total).toBe(2);
    expect(body.canPull).toBe(false);
    expect(body.refusal.code).toBe('CAP_TOTAL');
    expect(body.numbers.hand).toEqual({ value: 2, source: { from: 'RULE', ruleId: 'r0', name: 'الجديدة', level: 3 }, from: 'من قاعدة «الجديدة»' });
    expect(body.numbers.pullPerHour).toMatchObject({ value: 15, from: 'من قاعدة «الجديدة»' });
    expect(body.numbers.idleMinutes).toMatchObject({ value: 20, from: 'من القاعدة الأساسية' });
  });

  it('a colleague on the same desk: the base hand, and her numbers all from the base rule', async () => {
    named(['sara'], { hand: 2 });
    as('huda');
    const body = await (await GET()).json();
    expect(body.caps.total).toBe(3);
    expect(body.canPull).toBe(true);
    for (const k of ['hand', 'idleMinutes', 'pullPerHour']) expect(body.numbers[k].from).toBe('من القاعدة الأساسية');
  });
});
