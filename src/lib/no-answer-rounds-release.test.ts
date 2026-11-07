import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «نظام الجولات» R1 and R1b through the queue's own functions (`confirmation-queue.ts`), the database a fake that answers by
 * the `where` it is asked: the ninety-minute query (no attempt at all) and the rounds query are told apart by their keys.
 *
 * The owner, 7/11: six working hours to let a run go (it was three), and a dated order that nobody opened after its date goes
 * back too. The pull's order (a new order first) is not behind the switch any more — see `the pull` below and
 * `new-orders-first-and-a-cap-of-five-hundred.test.ts`, which runs it against a database that applies the filters.
 */

const { db, calls } = vi.hoisted(() => {
  const calls = { zoned: 0, business: 0 };
  const db = {
    order: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    notification: { createMany: vi.fn() },
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

import { pickNextCandidate, releaseNoAnswerRounds, releaseStaleClaims, ROUNDS_SCAN_PAGE } from './confirmation-queue';
import { DUE_RELEASE_REASON, ROUNDS_OFF, ROUND_RELEASE_REASON, REPULL_RELEASE_REASON } from './no-answer-rounds';
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
    orderNumber: `ORD-${i}`,
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

  it('and a run six hours old, a dated order nobody opened: nothing is released, nothing is even read', async () => {
    // The very rows that go back with the switch ON (below) — the fake would hand them over if they were asked for.
    roundsRows = [heldRow(1), heldRow(2, { postponedUntil: t(2, 10) })];
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 16), { rounds: ROUNDS_OFF })).toBe(0);
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('ON — R1', () => {
  it('lets go a run six working hours old, writing exactly what the ninety-minute release writes', async () => {
    roundsRows = [heldRow(1)];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 15, 30), { rounds: ON })).toBe(1);
    const write = db.order.updateMany.mock.calls[0][0];
    expect(write.data).toEqual({ claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null });
    expect(write.where).toMatchObject({ id: 'o00001', claimedById: 'sara', claimedAt: t(1, 9) });
    expect(db.orderClaimHistory.create).toHaveBeenCalledWith({
      data: {
        companyId: 'c1',
        orderId: 'o00001',
        userId: 'sara',
        action: 'RELEASED',
        reason: ROUND_RELEASE_REASON,
        // Nobody pressed it — the system did (the owner's ruling 4/11, `auto-release.ts`).
        metadata: JSON.stringify({ automatic: true, holder: 'sara' }),
      },
    });
  });

  it('and lets go his other orders held for her in the same step — one customer, one agent', async () => {
    roundsRows = [heldRow(1)];
    await releaseStaleClaims(db as never, scope, JO, t(1, 15, 30), { rounds: ON });
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

  it('not a minute before: 5h59 stays, 6h00 goes', async () => {
    roundsRows = [heldRow(1)];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 15, 29), { rounds: ON })).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 15, 30), { rounds: ON })).toBe(1);
  });

  it('three hours — what it used to be — is no longer enough', async () => {
    roundsRows = [heldRow(1)];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 12, 30), { rounds: ON })).toBe(0);
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
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 15, 30), { rounds: ON })).toBe(0);
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it('switched on less than ninety working minutes ago: nothing is read at all', async () => {
    roundsRows = [heldRow(1)];
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 12, 30), { rounds: { enabled: true, enabledAt: t(1, 11, 30) } })).toBe(0);
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
  });

  it('the database is asked only for held, open, never-shipped orders — and a date only once it is three working hours old', async () => {
    const now = t(1, 16);
    await releaseStaleClaims(db as never, scope, JO, now, { rounds: ON });
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
    // 16:00 less three working hours: 13:00. The grace is asked in the database too, not only in the verdict.
    const threeHoursAgo = t(1, 13);
    expect(q.where.AND[0]).toEqual({ OR: [{ postponedUntil: null }, { postponedUntil: { lte: threeHoursAgo } }] });
    expect(q.where.AND[1]).toEqual({ OR: [{ nextFollowUpAt: null }, { nextFollowUpAt: { lte: threeHoursAgo } }] });
    expect(JSON.stringify(q.where.AND), 'a date is no longer compared with the present moment').not.toContain(now.toISOString());
  });

  it('inside the pull, fewer: the limit it is given', async () => {
    roundsRows = Array.from({ length: 60 }, (_, i) => heldRow(i));
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 15, 30), { rounds: ON, roundsLimit: 25 })).toBe(25);
  });

  /*
   * SALWA'S 237 (6/11): «لا يرد» pressed on Sunday 1/11, the switch turned on Monday 2/11 at 10:00. Before this they never
   * moved — every run was older than the switch. Now: six working hours after the switch, and not a minute before.
   */
  it('THE PILE FROM BEFORE THE SWITCH goes back six working hours after it went on', async () => {
    const switchedOn = { enabled: true, enabledAt: t(2, 10) };
    roundsRows = Array.from({ length: 3 }, (_, i) => heldRow(i));
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 15, 59), { rounds: switchedOn })).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 16), { rounds: switchedOn })).toBe(3);
    expect(db.orderClaimHistory.create.mock.calls.map(([a]) => a.data.reason)).toEqual(Array(3).fill(ROUND_RELEASE_REASON));
  });

  it('and the database is asked for no-answers of any age once the switch is six working hours old — none before', async () => {
    const switchedOn = { enabled: true, enabledAt: t(2, 10) };
    const roundsWhere = () => JSON.stringify(db.order.findMany.mock.calls.find(([a]) => isRoundsQuery(a))![0].where.AND);
    await releaseStaleClaims(db as never, scope, JO, t(2, 16), { rounds: switchedOn });
    expect(roundsWhere()).toContain('NO_ANSWER');
    expect(roundsWhere()).not.toContain('"gte"');
    vi.clearAllMocks();
    db.order.findMany.mockImplementation(async (q: { where: Row; take?: number }) => (isRoundsQuery(q) ? roundsRows : []));
    await releaseStaleClaims(db as never, scope, JO, t(2, 15, 59), { rounds: switchedOn });
    expect(roundsWhere(), 'the switch is not six working hours old yet').not.toContain('NO_ANSWER');
  });
});

/**
 * R1b (the owner, 7/11: «حلّ الثغرتين»): a postponed or called-back order whose holder never came back to it. The order is held
 * with a date; the last call REACHED the customer, so no run and no re-pull ever took it.
 */
describe('ON — R1b: a dated order nobody opened after its date', () => {
  const D = t(2, 10); // Monday 10:00
  /** Sara rang on Sunday and the customer asked for Monday 10:00. The claim stays with her. */
  const dated = (i: number, over: Row = {}): Row =>
    heldRow(i, {
      postponedUntil: D,
      contactAttempts: [
        { createdAt: t(1, 9, 29), result: 'OPENED', attemptNumber: 1, employeeId: 'sara' },
        { createdAt: t(1, 9, 30), result: 'POSTPONED', attemptNumber: 2, employeeId: 'sara' },
      ],
      ...over,
    });
  const noticesWritten = () => db.notification.createMany.mock.calls.flatMap(([a]) => (a as { data: Row[] }).data);

  it('three working hours after its date it goes back — its own reason, the same writes, and she is told', async () => {
    roundsRows = [dated(1)];
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 13), { rounds: ON })).toBe(1);

    const write = db.order.updateMany.mock.calls[0][0];
    // Exactly the three releases’ write: the claim goes, `assignedAt` goes — and the STATUS and the DATES are not in it.
    expect(write.data).toEqual({ claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null });
    expect(write.data).not.toHaveProperty('confirmationStatus');
    expect(write.data).not.toHaveProperty('status');
    expect(write.data).not.toHaveProperty('postponedUntil');
    expect(write.data).not.toHaveProperty('nextFollowUpAt');
    expect(write.where).toMatchObject({ id: 'o00001', claimedById: 'sara', claimedAt: t(1, 9), shippingStatus: 'NOT_READY' });

    expect(db.orderClaimHistory.create).toHaveBeenCalledWith({
      data: {
        companyId: 'c1',
        orderId: 'o00001',
        userId: 'sara',
        action: 'RELEASED',
        reason: DUE_RELEASE_REASON,
        metadata: JSON.stringify({ automatic: true, holder: 'sara' }),
      },
    });
    expect(noticesWritten()).toEqual([
      expect.objectContaining({
        companyId: 'c1',
        storeId: 's1',
        userId: 'sara',
        title: 'رجع ORD-1 للطابور',
        message: 'رجع ORD-1 للطابور: مرّت 3 ساعات عمل على موعد الطلب وما حدا فتحه',
        link: '/confirmation/mine',
      }),
    ]);
  });

  it('and his other orders held for her go back with it — one customer, one agent', async () => {
    roundsRows = [dated(1)];
    await releaseStaleClaims(db as never, scope, JO, t(2, 13), { rounds: ON });
    const twins = db.order.updateMany.mock.calls[1][0];
    expect(twins.where).toMatchObject({ customerId: 'cust1', id: { not: 'o00001' }, assignedToId: 'sara', confirmationStatus: 'NEW', claimHistory: { none: {} } });
    expect(twins.data).toEqual({ assignedToId: null, assignedAt: null, version: { increment: 1 } });
  });

  it('2h59 after the date it is still hers: nothing written, nobody told', async () => {
    roundsRows = [dated(1)];
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 12, 59), { rounds: ON })).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });

  it('a callback date (`nextFollowUpAt`) is a date like a postponement', async () => {
    roundsRows = [dated(1, { postponedUntil: null, nextFollowUpAt: D })];
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 12, 59), { rounds: ON })).toBe(0);
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 13), { rounds: ON })).toBe(1);
  });

  it('with two dates the later one decides', async () => {
    roundsRows = [dated(1, { postponedUntil: t(2, 10), nextFollowUpAt: t(2, 14) })];
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 13), { rounds: ON })).toBe(0);
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 17), { rounds: ON })).toBe(1);
  });

  it('anything logged after the date keeps it from this release — here an «اتصل» of hers', async () => {
    roundsRows = [
      dated(1, {
        contactAttempts: [
          { createdAt: t(1, 9, 29), result: 'OPENED', attemptNumber: 1, employeeId: 'sara' },
          { createdAt: t(1, 9, 30), result: 'POSTPONED', attemptNumber: 2, employeeId: 'sara' },
          { createdAt: t(2, 10, 30), result: 'OPENED', attemptNumber: 3, employeeId: 'sara' },
        ],
      }),
    ];
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 13), { rounds: ON })).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a date left alone for a week: the stale pile goes at once', async () => {
    roundsRows = [dated(1, { postponedUntil: t(1, 10), claimedAt: t(1, 9) })];
    expect(await releaseStaleClaims(db as never, scope, JO, t(8, 10), { rounds: ON })).toBe(1);
    expect(db.orderClaimHistory.create.mock.calls[0][0].data.reason).toBe(DUE_RELEASE_REASON);
  });

  it('the five-minute job’s own pass (`releaseNoAnswerRounds`) releases it just the same', async () => {
    roundsRows = [dated(1)];
    expect(await releaseNoAnswerRounds(db as never, scope, JO, t(2, 13), { rounds: ON })).toBe(1);
    expect(db.orderClaimHistory.create.mock.calls[0][0].data.reason).toBe(DUE_RELEASE_REASON);
    expect(noticesWritten()).toHaveLength(1);
  });

  it('switch OFF: not asked, not written', async () => {
    roundsRows = [dated(1)];
    expect(await releaseStaleClaims(db as never, scope, JO, t(2, 13), { rounds: ROUNDS_OFF })).toBe(0);
    expect(await releaseNoAnswerRounds(db as never, scope, JO, t(2, 13), { rounds: ROUNDS_OFF })).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.notification.createMany).not.toHaveBeenCalled();
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
        // A third of them carry a date too: the pass places the calendar for the dates once, not for each of them.
        postponedUntil: i % 3 === 0 ? t(1, 12) : null,
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

/**
 * THE PULL (the owner, 7/11: «الأولوية دائما للطلبات الجديدة لما يسحبو الطلبات»), asked of `pickNextCandidate` one query at a
 * time. The order of the queries IS the order of the pull: what is held for her, a new order, a due postponed one, the oldest.
 * No switch is read here — `new-orders-first-and-a-cap-of-five-hundred.test.ts` runs the same pull with it off and on.
 */
describe('the pull — a new order first, with the switch nowhere in it', () => {
  beforeEach(() => {
    db.order.findFirst.mockReset();
  });
  const asked = (n: number) => db.order.findFirst.mock.calls[n][0];

  it('after what is held for her, an order nobody has rung yet — BEFORE a due postponed one', async () => {
    db.order.findFirst
      .mockResolvedValueOnce(null) // held for her
      .mockResolvedValueOnce({ id: 'fresh' });
    expect(await pickNextCandidate(db as never, scope, t(1, 10), 'sara')).toBe('fresh');
    expect(asked(1)).toMatchObject({ where: { contactAttempts: { none: {} } }, orderBy: { createdAt: 'asc' } });
    expect(db.order.findFirst, 'the due postponed order is not even asked about').toHaveBeenCalledTimes(2);
  });

  it('then the due postponed one, by its date', async () => {
    db.order.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'due' });
    expect(await pickNextCandidate(db as never, scope, t(1, 10), 'sara')).toBe('due');
    expect(asked(2).where.confirmationStatus).toBe('POSTPONED');
    expect(asked(2).orderBy).toEqual([{ postponedUntil: 'asc' }, { nextFollowUpAt: 'asc' }]);
  });

  it('and when every waiting order was rung already, the oldest of those', async () => {
    db.order.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'rung' });
    expect(await pickNextCandidate(db as never, scope, t(1, 10), 'sara')).toBe('rung');
    expect(asked(3).where).not.toHaveProperty('contactAttempts');
    expect(asked(3).orderBy).toEqual({ createdAt: 'asc' });
  });

  it('what is held for her is still first of all', async () => {
    db.order.findFirst.mockResolvedValueOnce({ id: 'hers' });
    expect(await pickNextCandidate(db as never, scope, t(1, 10), 'sara')).toBe('hers');
    expect(db.order.findFirst).toHaveBeenCalledTimes(1);
  });

  it('the pull, which has asked about hers already, starts with the new order', async () => {
    db.order.findFirst.mockResolvedValueOnce({ id: 'fresh' });
    expect(await pickNextCandidate(db as never, scope, t(1, 10), 'sara', { heldForHerAsked: true })).toBe('fresh');
    expect(db.order.findFirst).toHaveBeenCalledTimes(1);
    expect(asked(0).where.contactAttempts).toEqual({ none: {} });
  });
});

describe('R1 — she is on the call', () => {
  it('an attempt of hers in the last fifteen working minutes keeps the order this pass', async () => {
    const rows = (withPress: boolean) => [
      heldRow(1, {
        contactAttempts: [
          { createdAt: t(1, 9, 29), result: 'OPENED', attemptNumber: 1, employeeId: 'sara' },
          { createdAt: t(1, 9, 30), result: 'NO_ANSWER', attemptNumber: 2, employeeId: 'sara' },
          ...(withPress ? [{ createdAt: t(1, 15, 25), result: 'OPENED', attemptNumber: 3, employeeId: 'sara' }] : []),
        ],
      }),
    ];
    // The control: the same order, without her press, goes at 15:30 — six working hours after 09:30.
    roundsRows = rows(false);
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 15, 30), { rounds: ON })).toBe(1);
    vi.clearAllMocks();
    db.order.findMany.mockImplementation(async (q: { where: Row; take?: number }) => (isRoundsQuery(q) ? roundsRows : []));
    db.order.updateMany.mockResolvedValue({ count: 1 });

    roundsRows = rows(true);
    expect(await releaseStaleClaims(db as never, scope, JO, t(1, 15, 30), { rounds: ON })).toBe(0);
    const read = db.order.findMany.mock.calls.find(([a]) => isRoundsQuery(a))![0];
    expect(read.select.contactAttempts.select, 'who pressed is read').toHaveProperty('employeeId', true);
  });
});
