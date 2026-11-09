import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «طلباتي» DOES NOT SAY WHAT THE PULL NO LONGER ASKS (the owner, 9/11: «الطلب يرجع للطابور فوراً»)
 *
 * With the mode ON the pull no longer holds her back for calls she owes (`workFirstGate` is quiet). The desk used to say it did: a
 * banner («عندك N طلبات لازم ترني عليهم هلّق») and a pull button turned into «اسحب طلب جديد — خلّصي اللي فوق أول» that opened the oldest
 * card instead of pulling. A sentence that lies is worse than none, and the screen may not grow (its first-load JavaScript is
 * held under a ceiling), so the SERVER says the right thing: the response carries no `due` — the screen draws the banner and the
 * button from it and draws neither when it is absent.
 *
 * Everything else on the desk is what it was: the cards, their words (`dueNow`, `dueWords`), the tabs.
 *
 * With the mode OFF — its own switch, or the rounds — the response is today’s, `due` included, to the digit.
 *
 * Amman, 09:00–17:00, Friday and Saturday off. Time is frozen at Monday 2 November 2026, 14:00.
 * Blockers: no money, no permission, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, sw, rsw } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn(async () => 0) },
    orderContactAttempt: { groupBy: vi.fn(), findMany: vi.fn() },
  },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'Sara', role: 'CONFIRMATION_AGENT', companyId: 'c1', permissions: [] },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined, can: () => false }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));

import { GET } from './route';
import { zonedTimeToInstant } from '@/lib/business-calendar';

const t = (day: number, h: number, m = 0) => zonedTimeToInstant('Asia/Amman', 2026, 11, day, h, m);
const NOW = t(2, 14);
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber: `ORD-${id}`, confirmationStatus: 'IN_PROGRESS', claimedAt: t(2, 13, 45), postponedUntil: null, nextFollowUpAt: null,
  customer: { id: `c-${id}`, totalOrders: 1 }, _count: { contactAttempts: 0, notes: 0 }, ...over,
});
const desk = async () => (await GET(new Request('http://localhost/api/confirmation/mine'))).json();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // She pulled one order a quarter of an hour ago and has not rung it: a call she owes, by the rounds’ own reading.
  db.order.findMany.mockReset();
  db.order.findMany.mockResolvedValueOnce([row('fresh')]).mockResolvedValue([]);
  db.orderContactAttempt.findMany.mockResolvedValue([]);
  // With the rounds off the desk counts no-answers with one grouped read (today’s way); nobody has any.
  db.orderContactAttempt.groupBy.mockResolvedValue([]);
  sw.value = { enabled: true, enabledAt: t(1, 8) };
  rsw.value = { enabled: true, enabledAt: t(1, 8) };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ON — the desk does not say “finish what is above first”', () => {
  it('no `due` in the answer: no banner, and no button that opens a card instead of pulling', async () => {
    const data = await desk();
    expect(data).not.toHaveProperty('due');
  });

  it('and the rest of the desk is what it was: the card, its words, its tab, the rounds’ counter', async () => {
    const data = await desk();
    expect(data.rounds).toBe(true);
    expect(data.work.map((o: { id: string }) => o.id)).toEqual(['fresh']);
    expect(data.work[0]).toMatchObject({ dueNow: true, dueReason: 'NEW', dueWords: 'جديد — سحبتيه هلّق' });
    expect(data.noAnswer).toEqual([]);
  });
});

describe('OFF — the desk is today’s, with its banner and its button', () => {
  it.each([
    ['its own switch off', () => { rsw.value = { enabled: false, enabledAt: null }; }],
    ['the rounds off, whatever the mode’s own switch holds', () => { sw.value = { enabled: false, enabledAt: null }; }],
  ])('%s', async (_name, set) => {
    set();
    const data = await desk();
    expect(data.due).toBeDefined();
    expect(data.due.count).toBe(1);
    expect(data.due.sentence).toBe('عندك طلب واحد لازم ترني عليه هلّق');
    expect(data.due.button).toBe('اسحب طلب جديد — خلّصي اللي فوق أول');
  });

  it('rounds on, the mode off: the owed call is counted and the banner is said', async () => {
    rsw.value = { enabled: false, enabledAt: null };
    const data = await desk();
    expect(data.due).toMatchObject({ count: 1, first: { id: 'fresh' } });
  });
});
