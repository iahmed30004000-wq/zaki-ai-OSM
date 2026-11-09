import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE QUEUE’S NUMBERS ARE THE MODE’S WHEN IT IS ON (the owner, 9/11: «الطلب يرجع للطابور فوراً»)
 *
 * `GET /api/confirmation/queue` is what the pull panel draws: «بانتظارك», «مؤجَّلة حتى موعدها», «بيدك 3 / 5» and the pull button’s
 * state. With the mode on the route hands the mode to the very counters the pull picks from (`waitingCount`, `postponedNotDueCount`
 * read `readyToPullWhere` / `duePostponedWhere`), so the number it shows is what the pull can hand out; the limit it reports is five,
 * and a hand at five cannot pull (`canPull`, with the owner’s sentence). With the mode OFF the route asks the counters exactly as it
 * always did and reports the cap of 500.
 *
 * Counters are mocked here only to RECORD what they are asked; their answers against a database that applies the filters are
 * `the-order-leaves-her-hand.test.ts` and `returns-filters-agree-with-the-rule.test.ts`.
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, queue, sw, rsw } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  queue: { waitingCount: vi.fn(), ownedCounts: vi.fn(), postponedNotDueCount: vi.fn(), reservedForColleaguesCount: vi.fn() },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn(async () => ({})) }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));
vi.mock('@/lib/confirmation-queue', async (orig) => ({
  ...(await orig<typeof import('@/lib/confirmation-queue')>()),
  waitingCount: (...a: unknown[]) => queue.waitingCount(...a),
  ownedCounts: (...a: unknown[]) => queue.ownedCounts(...a),
  postponedNotDueCount: (...a: unknown[]) => queue.postponedNotDueCount(...a),
  reservedForColleaguesCount: (...a: unknown[]) => queue.reservedForColleaguesCount(...a),
}));

import { GET } from './route';
import { zonedTimeToInstant } from '@/lib/business-calendar';

const t = (day: number, h: number, m = 0) => zonedTimeToInstant('Asia/Amman', 2026, 11, day, h, m);
const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const ON = { enabled: true, enabledAt: t(1, 8) };
const OFF = { enabled: false, enabledAt: null };
const owned = (total: number, extra: Record<string, unknown> = {}) => ({ total, withoutAttempt: 0, untouched: null, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(t(2, 12));
  requireContext.mockResolvedValue({ user: { id: 'huda' }, companyId: 'c1', storeId: 's1', country: COUNTRY });
  can.mockImplementation((_u: unknown, k: string) => k === 'confirmation.pull');
  sw.value = ON;
  rsw.value = ON;
  queue.waitingCount.mockResolvedValue(4);
  queue.ownedCounts.mockResolvedValue(owned(0));
  queue.postponedNotDueCount.mockResolvedValue(2);
  queue.reservedForColleaguesCount.mockResolvedValue(0);
  db.order.findMany.mockResolvedValue([]);
});

describe('ON — the counters are asked the mode’s question', () => {
  it('the mode is handed to the waiting number and to the “waiting on a date” number, with the cut-offs of the store’s calendar', async () => {
    await GET();
    const mode = queue.waitingCount.mock.calls[0][4];
    expect(mode.readyCut.getTime()).toBe(t(2, 9).getTime()); // Monday noon looks back three working hours
    expect(mode.idleCut.getTime()).toBe(t(2, 11, 30).getTime());
    expect(queue.postponedNotDueCount.mock.calls[0].slice(2)).toEqual([expect.any(Date), mode]);
  });

  it('the limit reported is five — and the cap of 40 untouched is still reported beside it', async () => {
    const body = await (await GET()).json();
    expect(body.caps).toEqual({ withoutAttempt: 40, total: 5 });
  });

  it('a hand of four can pull; a hand of five cannot, and the refusal is the owner’s sentence', async () => {
    queue.ownedCounts.mockResolvedValue(owned(4));
    expect(await (await GET()).json()).toMatchObject({ canPull: true, refusal: null });
    queue.ownedCounts.mockResolvedValue(owned(5));
    const full = await (await GET()).json();
    expect(full.canPull).toBe(false);
    expect(full.refusal).toEqual({ code: 'CAP_TOTAL', message: 'وصلت للحد (5) — خلّصي واحد أو اضغطي «أعِدْه إلى الطابور»' });
  });

  it('three in her hands and two held for her are five: she can still pull — what is held for her is hers to take', async () => {
    queue.ownedCounts.mockResolvedValue(owned(3, { heldForHer: 2 }));
    expect((await (await GET()).json()).canPull).toBe(true);
    queue.ownedCounts.mockResolvedValue(owned(5, { heldForHer: 2 }));
    expect((await (await GET()).json()).canPull).toBe(false);
  });

  it('a supervisor (who pulls nothing) reads the whole pool, and the mode’s numbers too', async () => {
    can.mockImplementation((_u: unknown, k: string) => k === 'confirmation.supervise');
    await GET();
    expect(queue.waitingCount.mock.calls[0][3]).toBeUndefined();
    expect(queue.waitingCount.mock.calls[0][4]).toMatchObject({ readyCut: expect.any(Date) });
  });
});

describe('OFF — the route asks the counters exactly as it always did', () => {
  it.each([
    ['its own switch off', () => { rsw.value = OFF; }],
    ['the rounds off, whatever the mode’s own switch holds', () => { sw.value = OFF; }],
  ])('%s: no mode to the waiting number, two arguments to the other, the cap of 500', async (_name, set) => {
    set();
    queue.ownedCounts.mockResolvedValue(owned(5));
    const body = await (await GET()).json();
    expect(queue.waitingCount.mock.calls[0][4]).toBeNull();
    expect(queue.postponedNotDueCount.mock.calls[0]).toHaveLength(2);
    expect(body.caps).toEqual({ withoutAttempt: 40, total: 500 });
    // Five in her hands is nothing against 500.
    expect(body.canPull).toBe(true);
  });

  it('and at 500 the old sentence, with the old number', async () => {
    rsw.value = OFF;
    queue.ownedCounts.mockResolvedValue(owned(500));
    const body = await (await GET()).json();
    expect(body.refusal).toMatchObject({ code: 'CAP_TOTAL', message: 'بلغت الحد الأقصى (500 طلب لديك).' });
  });

  it('a country the route cannot read is not asked while the mode is off', async () => {
    rsw.value = OFF;
    requireContext.mockResolvedValue({ user: { id: 'huda' }, companyId: 'c1', storeId: 's1' });
    expect((await GET()).status).toBe(200);
  });
});
