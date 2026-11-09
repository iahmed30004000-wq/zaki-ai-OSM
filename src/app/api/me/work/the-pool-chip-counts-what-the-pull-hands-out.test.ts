import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «بانتظار التأكيد» ON THE HEADER COUNTS WHAT THE PULL CAN HAND OUT — also in «الطلب يرجع للطابور فوراً».
 *
 * The chip (`CONFIRM_POOL` of `GET /api/me/work`) and the button «اسحب» are two readings of one pool. In the mode the pool is
 * narrower — a returned order counts from its ready-time, a dated one from its date — and the number only agrees with the button if
 * the chip hands the mode to the very counter the pull uses (`waitingCount`). A chip that forgot to is a number that promises a pull
 * the button answers «لا توجد طلبات» for, three hours at a time, and nothing else in the app notices.
 *
 * `waitingCount` is the real counter's stand-in here: it answers the way the real one does (fewer with the mode, more without), so
 * the number on the chip is the proof, not only the argument.
 */

const { db, requireContext, waitingCount, readReturnsMode, grants } = vi.hoisted(() => ({
  db: {
    order: { count: vi.fn(), findMany: vi.fn() },
    orderChangeRequest: { count: vi.fn() },
    orderIssue: { count: vi.fn() },
    courierStatement: { count: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  waitingCount: vi.fn(),
  readReturnsMode: vi.fn(),
  grants: { allows: ((): boolean => true) as (permission: string) => boolean },
}));
vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: (...a: unknown[]) => requireContext(...a),
  ContextError: class extends Error {},
}));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, p: string) => grants.allows(p) }));
vi.mock('@/lib/confirmation-queue', () => ({
  POSTPONE_LEAD_DAYS: 2,
  readReturnsMode: (...a: unknown[]) => readReturnsMode(...a),
  waitingCount: (...a: unknown[]) => waitingCount(...a),
  awaitingConfirmationCount: async () => 0,
}));

import { GET } from './route';

/** The mode, as `readReturnsMode` hands it over — opaque to the route, which must pass the very same object on. */
const MODE = { now: new Date('2026-11-02T09:00:00.000Z'), readyCut: new Date('2026-11-02T06:00:00.000Z'), idleCut: new Date('2026-11-02T08:30:00.000Z') };
const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
/** What the pull can hand out with the mode on, and without it — the chip must show the first when it is on. */
const IN_THE_MODE = 3;
const OFF_AS_EVER = 8;

const chip = async () => {
  const items = ((await (await GET()).json()) as { items: { key: string; count: number }[] }).items;
  return items.find((i) => i.key === 'CONFIRM_POOL')?.count;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u' }, companyId: 'c', storeId: 's', country: COUNTRY });
  grants.allows = (p) => p === 'confirmation.pull';
  db.order.count.mockResolvedValue(0);
  db.order.findMany.mockResolvedValue([]);
  db.orderChangeRequest.count.mockResolvedValue(0);
  db.orderIssue.count.mockResolvedValue(0);
  db.courierStatement.count.mockResolvedValue(0);
  db.deliveryFee.findMany.mockResolvedValue([]);
  readReturnsMode.mockResolvedValue(MODE);
  waitingCount.mockImplementation(async (_db: unknown, _scope: unknown, _now: unknown, _forUser: unknown, returns: unknown) =>
    returns ? IN_THE_MODE : OFF_AS_EVER
  );
});

describe('the mode ON: the chip counts what the pull hands out', () => {
  it('— she who pulls: the number is the mode’s, and the counter was handed the very mode that was read', async () => {
    expect(await chip()).toBe(IN_THE_MODE);
    expect(waitingCount).toHaveBeenCalledTimes(1);
    const [, scope, now, forUser, returns] = waitingCount.mock.calls[0];
    expect(scope).toEqual({ companyId: 'c', storeId: 's' });
    expect(forUser, 'the number is HERS').toBe('u');
    expect(returns).toBe(MODE);
    // The mode was read for the same moment the count is asked about, from the store’s own working hours.
    const [, companyId, args] = readReturnsMode.mock.calls[0];
    expect(companyId).toBe('c');
    expect(args.now.getTime()).toBe((now as Date).getTime());
    expect(args.calendar()).toEqual(COUNTRY);
  });

  it('— the supervisor, who pulls nothing, reads the whole pool — and still the mode’s readiness of it', async () => {
    grants.allows = (p) => p === 'confirmation.supervise';
    expect(await chip()).toBe(IN_THE_MODE);
    const [, , , forUser, returns] = waitingCount.mock.calls[0];
    expect(forUser).toBeUndefined();
    expect(returns).toBe(MODE);
  });
});

describe('the mode OFF: the chip is the old number, asked the old way', () => {
  it('— the counter is given no mode, and the number is the one it always gave', async () => {
    readReturnsMode.mockResolvedValue(null);
    expect(await chip()).toBe(OFF_AS_EVER);
    const [, , , forUser, returns] = waitingCount.mock.calls[0];
    expect(forUser).toBe('u');
    expect(returns).toBeNull();
  });
});
