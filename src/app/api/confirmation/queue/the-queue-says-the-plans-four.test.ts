import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE QUEUE SAYS THE PLAN'S FOUR (the planner 15/11 22:30, ruling 24: «غيّر العدّاد والجملة ليطابقوا الترتيب الجديد … مع المفتاح بس. مطفي = نفس الشي بالحرف»)
 *
 *  1. With «جدول المحاولات» ON (`Company.settings.callProofAndCadence`, read by `cadenceSince`), `GET /api/confirmation/queue` asks the PLAN's counter (`waitingByPlan`) — handed the very mode
 *     the pull picks under — and answers `waitingPlan`: the four parts in the pull's order, جديد / وعد وصل / إعادة حان موعدها / الباقي, and the sentence that says the same order, in the
 *     server's words (the screen prints them without logic).
 *  2. `waiting` is the SUM of the four — the same number as before the change — and the two old keys that survive (`waitingNew`, `waitingReturned`) still add up to it.
 *  3. THE OFF PIN: with the switch off, and with only the older legacy mode on, the answer is byte for byte what it was — the same keys in the same order, the three-part counter asked,
 *     the plan's counter never asked, no `waitingPlan`.
 *
 * Counters are stand-ins that RECORD what they are asked; their answers against filters are `the-waiting-number-follows-the-plan.test.ts`.
 * Edge cases: a pool of zeroes · a part that is zero is still sent (the screen decides what to draw) · a supervisor reads the whole pool.
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, queue, cp, sw, rsw } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  queue: { waitingBreakdown: vi.fn(), waitingByPlan: vi.fn(), ownedCounts: vi.fn(), postponedNotDueCount: vi.fn(), reservedForColleaguesCount: vi.fn() },
  cp: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn(async () => ({})) }));
vi.mock('@/lib/call-proof-switch', () => ({ callProofSwitch: async () => cp.value, callProofOn: async () => cp.value.enabled }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));
vi.mock('@/lib/confirmation-queue', async (orig) => ({
  ...(await orig<typeof import('@/lib/confirmation-queue')>()),
  waitingBreakdown: (...a: unknown[]) => queue.waitingBreakdown(...a),
  waitingByPlan: (...a: unknown[]) => queue.waitingByPlan(...a),
  ownedCounts: (...a: unknown[]) => queue.ownedCounts(...a),
  postponedNotDueCount: (...a: unknown[]) => queue.postponedNotDueCount(...a),
  reservedForColleaguesCount: (...a: unknown[]) => queue.reservedForColleaguesCount(...a),
}));

import { GET } from './route';
import { planWords, planRule } from '@/lib/pull-plan-words';
import { RETURNS_MODE } from '@/lib/confirmation-queue';

const PLAN_RULE = planRule(RETURNS_MODE.idleBusinessMinutes);

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const SINCE = new Date('2026-11-10T08:00:00.000Z');
const ON = { enabled: true, enabledAt: SINCE };
const OFF = { enabled: false, enabledAt: null };
const as = (id: string, keys: string[]) => {
  requireContext.mockResolvedValue({ user: { id }, companyId: 'c1', storeId: 's1', country: COUNTRY });
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
};
const read = async () => (await GET()).json();

beforeEach(() => {
  vi.clearAllMocks();
  cp.value = OFF;
  sw.value = OFF;
  rsw.value = OFF;
  as('huda', ['confirmation.pull']);
  queue.waitingBreakdown.mockResolvedValue({ fresh: 5, returned: 417, due: 3 });
  queue.waitingByPlan.mockResolvedValue({ fresh: 5, promise: 4, retry: 100, rest: 316 });
  queue.ownedCounts.mockResolvedValue({ total: 0, withoutAttempt: 0, untouched: null });
  queue.postponedNotDueCount.mockResolvedValue(67);
  queue.reservedForColleaguesCount.mockResolvedValue(0);
  db.order.findMany.mockResolvedValue([]);
});

describe('ON — the plan’s counter, in the server’s words', () => {
  beforeEach(() => {
    cp.value = ON;
  });

  it('the plan’s counter is asked, with the mode the pull picks under (the cadence floor in it) and for HER; the three-part counter is not asked', async () => {
    await read();
    expect(queue.waitingBreakdown).not.toHaveBeenCalled();
    expect(queue.waitingByPlan).toHaveBeenCalledTimes(1);
    const [, scope, , forUserId, mode] = queue.waitingByPlan.mock.calls[0];
    expect(scope).toEqual({ companyId: 'c1', storeId: 's1' });
    expect(forUserId).toBe('huda');
    expect(mode.cadence.since).toEqual(SINCE);
  });

  it('answers the four parts in the pull’s order — جديد / وعد وصل / إعادة حان موعدها / الباقي — with their numbers, and the sentence', async () => {
    const body = await read();
    expect(body.waitingPlan.parts.map((p: { label: string }) => p.label)).toEqual(['جديد', 'وعد وصل', 'إعادة حان موعدها', 'الباقي']);
    expect(body.waitingPlan.parts.map((p: { value: number }) => p.value)).toEqual([5, 4, 100, 316]);
    expect(body.waitingPlan.rule).toBe(PLAN_RULE);
    expect(body.waitingPlan).toEqual(planWords({ fresh: 5, promise: 4, retry: 100, rest: 316 }, RETURNS_MODE.idleBusinessMinutes));
    // The sentence names the same four, in the same order, and no longer the two-day lead of the old order.
    const order = ['الجديد', 'الوعد', 'الإعادة', 'الباقي'].map((w) => PLAN_RULE.indexOf(w));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(PLAN_RULE).not.toContain('المؤجّل');
    // Ruling 36 (16/11): the idle figure is the setting's own, not a number written in the sentence — today «30 دقيقة دوام», never «90».
    expect(PLAN_RULE).toContain(`${RETURNS_MODE.idleBusinessMinutes} دقيقة دوام`);
    expect(RETURNS_MODE.idleBusinessMinutes).toBe(30);
    expect(PLAN_RULE).not.toContain('90');
    expect(planRule(45)).toContain('45 دقيقة دوام');
  });

  it.each([
    [{ fresh: 0, promise: 0, retry: 0, rest: 0 }],
    [{ fresh: 12, promise: 0, retry: 0, rest: 0 }],
    [{ fresh: 0, promise: 2, retry: 7, rest: 300 }],
    [{ fresh: 1, promise: 2, retry: 3, rest: 4 }],
  ])('%j: waiting = the sum of the four, and the two old keys still add up to it', async (parts) => {
    queue.waitingByPlan.mockResolvedValue(parts);
    const body = await read();
    const sum = parts.fresh + parts.promise + parts.retry + parts.rest;
    expect(body.waiting).toBe(sum);
    expect(body.waitingPlan.parts.reduce((n: number, p: { value: number }) => n + p.value, 0)).toBe(sum);
    expect(body.waitingNew + body.waitingReturned).toBe(sum);
    expect(body.waitingNew).toBe(parts.fresh);
    expect(body).not.toHaveProperty('waitingDue');
  });

  it('a supervisor reads the whole pool: no user id handed to the counter', async () => {
    as('boss', ['confirmation.supervise']);
    await read();
    expect(queue.waitingByPlan.mock.calls[0][3]).toBeUndefined();
  });

  it('the rest of the answer is untouched: the date line, the cap of five of the mode, canPull', async () => {
    const body = await read();
    expect(body).toMatchObject({ waitingOnADate: 67, canPull: true, refusal: null, orders: null });
    expect(body.caps.total).toBe(5);
  });
});

describe('OFF — byte for byte what it was (the pin)', () => {
  const OFF_KEYS = ['waiting', 'waitingNew', 'waitingReturned', 'waitingDue', 'waitingOnADate', 'reservedForColleagues', 'owned', 'caps', 'leadDays', 'canPull', 'refusal', 'autoReleased', 'orders'];

  it('the switch off: the same keys in the same order, the three-part counter asked, the plan’s counter never, no waitingPlan', async () => {
    const body = await read();
    expect(Object.keys(body)).toEqual(OFF_KEYS);
    expect(body).toMatchObject({ waiting: 425, waitingNew: 5, waitingReturned: 417, waitingDue: 3, waitingOnADate: 67 });
    expect(queue.waitingByPlan).not.toHaveBeenCalled();
    expect(queue.waitingBreakdown).toHaveBeenCalledTimes(1);
    expect(queue.waitingBreakdown.mock.calls[0][4]).toBeNull();
    expect(JSON.stringify(body)).not.toContain('وعد وصل');
  });

  it('only the older legacy mode on (rounds + returns, no cadence): still the three parts — the plan’s four are the key’s alone', async () => {
    sw.value = { enabled: true, enabledAt: new Date('2026-11-01T08:00:00.000Z') };
    rsw.value = { enabled: true, enabledAt: new Date('2026-11-01T08:00:00.000Z') };
    const body = await read();
    expect(Object.keys(body)).toEqual(OFF_KEYS);
    expect(queue.waitingByPlan).not.toHaveBeenCalled();
    expect(queue.waitingBreakdown.mock.calls[0][4]).toMatchObject({ readyCut: expect.any(Date) });
    expect(queue.waitingBreakdown.mock.calls[0][4]).not.toHaveProperty('cadence');
    expect(body).not.toHaveProperty('waitingPlan');
    expect(body.waitingDue).toBe(3);
  });
});
