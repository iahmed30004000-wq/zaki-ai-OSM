import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «نظام الجولات» R1 and R4 through the queue's own functions (`confirmation-queue.ts`), the database a fake that answers by
 * the `where` it is asked: the ninety-minute query (no attempt at all) and the rounds query are told apart by their keys.
 */

const { db, calls } = vi.hoisted(() => {
  const calls = { zoned: 0, business: 0 };
  const db = {
    order: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  return { db, calls };
});
vi.mock('./db', () => ({ db }));
// Counted, never changed: one release pass must place the calendar a handful of times, whatever the number of orders.
vi.mock('./business-calendar', async (load) => {
  const real = await load<typeof import('./business-calendar')>();
  return {
    ...real,
    zonedTimeToInstant: (...a: Parameters<typeof real.zonedTimeToInstant>) => {
      calls.zoned++;
      return real.zonedTimeToInstant(...a);
    },
    businessMinutesBetween: (...a: Parameters<typeof real.businessMinutesBetween>) => {
      calls.business++;
      return real.businessMinutesBetween(...a);
    },
  };
});

import { pickNextCandidate, releaseStaleClaims, ROUNDS_SCAN_PAGE } from './confirmation-queue';
import { ROUNDS_OFF, ROUND_RELEASE_REASON, REPULL_RELEASE_REASON } from './no-answer-rounds';
import { zonedTimeToInstant } from './business-calendar';

const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const t = (day: number, h: number, m = 0) => zonedTimeToInstant(JO.timezone, 2026, 11, day, h, m);
const scope = { companyId: 'c1', storeId: 's1' };
const ON = { enabled: true, enabledAt: t(1, 8) };

type Row = Record<string, unknown>;
/** The ninety-minute query asks for orders with NO attempt; the rounds query for orders with SOME. */
const isRoundsQuery = (q: { where: Row }) => !!(q.where.contactAttempts as Row | undefined)?.some;

function heldRow(i: number, over: Row = {}): Row {
  return {
    id: `o${String(i).padStart(5, '0')}`,
    claimedAt: t(1, 9),
    claimedById: 'sara',
    companyId: 'c1',
    customerId: `cust${i}`,
    postponedUntil: null,
    nextFollowUpAt: null,
    contactAttempts: [
      { createdAt: t(1, 9, 29), result: 'OPENED', attemptNumber: 1 },
      { createdAt: t(1, 9, 30), result: 'NO_ANSWER', attemptNumber: 2 },
    ],
    ...over,
  };
}

let roundsRows: Row[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  calls.zoned = 0;
  calls.business = 0;
  roundsRows = [];
  db.order.findMany.mockImplementation(async (q: { where: Row; take?: number }) =>
    isRoundsQuery(q) ? roundsRows.slice(0, q.take ?? roundsRows.length) : []
  );
  db.order.updateMany.mockResolvedValue({ count: 1 });
});

describe('OFF — the release is today’s, and asks nothing more', () => {
  it('the switch passed OFF: one query, the ninety-minute one', async () => {
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 16), { rounds: ROUNDS_OFF })).toBe(0);
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    expect(isRoundsQuery(db.order.findMany.mock.calls[0][0])).toBe(false);
  });

  it('the switch not passed and unreadable (no company table in this fake): OFF, still one query', async () => {
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 16))).toBe(0);
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('ON — R1', () => {
  it('lets go a run three working hours old, writing exactly what the ninety-minute release writes', async () => {
    roundsRows = [heldRow(1)];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 12, 30), { rounds: ON })).toBe(1);
    const write = db.order.updateMany.mock.calls[0][0];
    expect(write.data).toEqual({ claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null });
    expect(write.where).toMatchObject({ id: 'o00001', claimedById: 'sara', claimedAt: t(1, 9) });
    expect(db.orderClaimHistory.create).toHaveBeenCalledWith({
      data: { companyId: 'c1', orderId: 'o00001', userId: 'sara', action: 'RELEASED', reason: ROUND_RELEASE_REASON },
    });
  });

  it('and lets go his other orders held for her in the same step — one customer, one agent', async () => {
    roundsRows = [heldRow(1)];
    await releaseStaleClaims(db as never, scope, JO, t(1, 12, 30), { rounds: ON });
    const twins = db.order.updateMany.mock.calls[1][0];
    expect(twins.where).toEqual({
      companyId: 'c1',
      storeId: 's1',
      customerId: 'cust1',
      id: { not: 'o00001' },
      claimedById: null,
      confirmationStatus: 'NEW',
      shippingStatus: 'NOT_READY',
      claimHistory: { none: {} },
      assignedToId: 'sara',
    });
    expect(twins.data).toEqual({ assignedToId: null, assignedAt: null, version: { increment: 1 } });
  });

  it('not a minute before', async () => {
    roundsRows = [heldRow(1)];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 12, 29), { rounds: ON })).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a re-pulled order nobody touched goes after ninety working minutes, with its own reason', async () => {
    roundsRows = [heldRow(2, { claimedAt: t(1, 13) })];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 14, 30), { rounds: ON })).toBe(1);
    expect(db.orderClaimHistory.create.mock.calls[0][0].data.reason).toBe(REPULL_RELEASE_REASON);
  });

  it('a press that won the race keeps it (the conditional write missed): no history, no twins', async () => {
    roundsRows = [heldRow(1)];
    db.order.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 12, 30), { rounds: ON })).toBe(0);
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it('switched on less than ninety working minutes ago: nothing is read at all', async () => {
    roundsRows = [heldRow(1)];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 12, 30), { rounds: { enabled: true, enabledAt: t(1, 11, 30) } })).toBe(0);
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
  });

  it('the database is asked only for held, open, never-shipped orders with no date ahead', async () => {
    await releaseStaleClaims(db as never, scope, JO, t(1, 16), { rounds: ON });
    const q = db.order.findMany.mock.calls.find(([a]) => isRoundsQuery(a))![0];
    expect(q.where).toMatchObject({
      companyId: 'c1',
      storeId: 's1',
      claimedById: { not: null },
      shippingStatus: 'NOT_READY',
      shippingBatchId: null,
      trackingNumber: null,
      labelPrintedAt: null,
    });
    expect(JSON.stringify(q.where.AND)).toContain('postponedUntil');
    expect(JSON.stringify(q.where.AND)).toContain('nextFollowUpAt');
  });

  it('inside the pull, fewer: the limit it is given', async () => {
    roundsRows = Array.from({ length: 60 }, (_, i) => heldRow(i));
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 12, 30), { rounds: ON, roundsLimit: 25 })).toBe(25);
  });
});

describe('ON — a few thousand held orders', () => {
  it('one pass is linear: one page read, the calendar placed a handful of times, never per order', async () => {
    roundsRows = Array.from({ length: 3000 }, (_, i) =>
      heldRow(i, {
        contactAttempts: [
          { createdAt: t(1, 9, 29), result: 'OPENED', attemptNumber: 1 },
          { createdAt: t(1, 9, 30), result: 'NO_ANSWER', attemptNumber: 2 },
          { createdAt: t(1, 10), result: 'ANSWERED', attemptNumber: 3 },
          { createdAt: t(1, 11), result: 'OPENED', attemptNumber: 4 },
          { createdAt: t(1, 11, 1), result: i % 2 ? 'NO_ANSWER' : 'CALLBACK_REQUESTED', attemptNumber: 5 },
        ],
      })
    );
    // The rows above were built with the same calendar function: count only the pass.
    calls.zoned = 0;
    calls.business = 0;
    const now = t(2, 16);
    // The rows above were built with `t()` — counted from here on, the pass alone.
    calls.zoned = 0;
    calls.business = 0;
    const started = performance.now();
    const released = await releaseStaleClaims(db as never, scope, JO, now, { rounds: ON });
    const ms = performance.now() - started;

    const read = db.order.findMany.mock.calls.find(([a]) => isRoundsQuery(a))![0];
    expect(read.take, 'a pass reads one page, not the store').toBe(ROUNDS_SCAN_PAGE);
    expect(released).toBe(200);
    expect(calls.business, 'businessMinutesBetween per order').toBe(0);
    expect(calls.zoned, 'the calendar placed per order').toBeLessThan(20);
    expect(calls.zoned, 'the cut-offs were placed').toBeGreaterThan(0);
    // A wide bound on purpose: the counts above are the proof; the clock only catches a pass that went quadratic, and a
    // loaded CI runner must not fail it.
    expect(ms).toBeLessThan(10_000);
  });

  it('a full page is carried on from next time, so every held order is read in turn', async () => {
    roundsRows = Array.from({ length: ROUNDS_SCAN_PAGE }, (_, i) => heldRow(i, { contactAttempts: [{ createdAt: t(1, 10), result: 'ANSWERED' }] }));
    await releaseStaleClaims(db as never, { companyId: 'c1', storeId: 'page' }, JO, t(2, 16), { rounds: ON });
    await releaseStaleClaims(db as never, { companyId: 'c1', storeId: 'page' }, JO, t(2, 16), { rounds: ON });
    const reads = db.order.findMany.mock.calls.filter(([a]) => isRoundsQuery(a)).map(([a]) => a.where.id);
    expect(reads[0]).toBeUndefined();
    expect(reads[1]).toEqual({ gt: `o${String(ROUNDS_SCAN_PAGE - 1).padStart(5, '0')}` });
  });
});

describe('R4 — the pull', () => {
  beforeEach(() => {
    db.order.findFirst.mockReset();
  });

  it('ON: after what is due, an order nobody has rung comes first', async () => {
    db.order.findFirst
      .mockResolvedValueOnce(null) // held for her
      .mockResolvedValueOnce(null) // due postponed
      .mockResolvedValueOnce({ id: 'fresh' });
    expect(await pickNextCandidate(db as never, scope, t(1, 10), 'sara', { rounds: ON })).toBe('fresh');
    expect(db.order.findFirst.mock.calls[2][0]).toMatchObject({ where: { contactAttempts: { none: {} } }, orderBy: { createdAt: 'asc' } });
  });

  it('ON: and when every waiting order was rung, the oldest of those', async () => {
    db.order.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'rung' });
    expect(await pickNextCandidate(db as never, scope, t(1, 10), 'sara', { rounds: ON })).toBe('rung');
    expect(db.order.findFirst.mock.calls[3][0].where).not.toHaveProperty('contactAttempts');
  });

  it('ON: what is held for her and what is due still come before', async () => {
    db.order.findFirst.mockResolvedValueOnce({ id: 'hers' });
    expect(await pickNextCandidate(db as never, scope, t(1, 10), 'sara', { rounds: ON })).toBe('hers');
    db.order.findFirst.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'due' });
    expect(await pickNextCandidate(db as never, scope, t(1, 10), 'sara', { rounds: ON })).toBe('due');
  });

  it('OFF: the oldest, whatever it carries — three questions, as today', async () => {
    db.order.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'oldest' });
    expect(await pickNextCandidate(db as never, scope, t(1, 10), 'sara')).toBe('oldest');
    expect(db.order.findFirst).toHaveBeenCalledTimes(3);
    for (const [q] of db.order.findFirst.mock.calls) expect(q.where).not.toHaveProperty('contactAttempts');
  });
});

describe('R1 — she is on the call', () => {
  it('an attempt of hers in the last fifteen working minutes keeps the order this pass', async () => {
    roundsRows = [
      heldRow(1, {
        contactAttempts: [
          { createdAt: t(1, 9, 29), result: 'OPENED', attemptNumber: 1, employeeId: 'sara' },
          { createdAt: t(1, 9, 30), result: 'NO_ANSWER', attemptNumber: 2, employeeId: 'sara' },
          { createdAt: t(1, 12, 25), result: 'OPENED', attemptNumber: 3, employeeId: 'sara' },
        ],
      }),
    ];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 12, 30), { rounds: ON })).toBe(0);
    const read = db.order.findMany.mock.calls.find(([a]) => isRoundsQuery(a))![0];
    expect(read.select.contactAttempts.select, 'who pressed is read').toHaveProperty('employeeId', true);
  });
});
