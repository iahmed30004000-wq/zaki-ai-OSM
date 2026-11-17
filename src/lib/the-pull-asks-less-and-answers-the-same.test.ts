import { describe, expect, it, vi } from 'vitest';
import { workClock } from './no-answer-rounds';
import { returnsMode } from './no-answer-returns';
import { RETURNS_MODE, pickNextCandidate } from './confirmation-queue';
import { readBacklogShare } from './queue-priority-share';
import { PULL_SWEEP_GAP_MS, sweepIntakeForPull } from './intake-filter';
import { intakeFilterSwitch } from './intake-filter-switch';

// The switch is what every sweep reads first: counting its calls counts the sweeps that ran. It answers «off», so a sweep that runs is one read and writes nothing.
vi.mock('./intake-filter-switch', () => ({ intakeFilterSwitch: vi.fn(async () => ({ enabled: false, enabledAt: null })) }));

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PULL ASKS THE DATABASE LESS AND ANSWERS THE SAME (perf, 17/11 — the owner: «السايت بيعلق، فحص شامل وابني الحل»)
 *
 * What must work. Three reads that a pull did again and again are done once, and the order a pull deals does not change:
 *   1. the two ranking scans (promises, retries by due — up to 2,000 orders each): when the v2 pick answers «nothing for me» the old order after it used to run both a second time;
 *      now one `pickNextCandidate` reads each scan at most once and the old order reads back what the v2 pick already read — the same order, the same answers;
 *   2. the half-hour share of the backlog: pulls that arrive while the first read is still running share that read (one `distinct` + two counts, not one set per agent);
 *   3. the intake sweep before «اسحب التالي»: not more than once in `PULL_SWEEP_GAP_MS` per store, and a sweep that is running is shared.
 *
 * Edge cases. A store's throttle is its own; a failed sweep never throws into the pull; the old pull (no priority plan) and the two time-of-day modes still read each scan once;
 * a retry found by the v2 pick but not dealt by it is still dealt by the old order — from the memo.
 * Blockers: no money, no order creation, no migration, no change of the pick order, the page size or any predicate.
 * ═════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-12T12:00:00.000Z');
const SINCE = new Date('2026-11-10T08:00:00.000Z');
const scope = { companyId: 'c1', storeId: 's1' };
const MODE = returnsMode(NOW, workClock({ workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [], timezone: 'UTC' }), RETURNS_MODE.idleBusinessMinutes, SINCE);
const WITH_CADENCE = MODE as typeof MODE & { cadence: { since: Date } };

/** One ready retry, due half an hour ago (not aged: the aging rule is two hours) — and carrying no promise date, so the promise scan finds nothing in it. */
const RETRY_ROW = {
  id: 'r1',
  createdAt: new Date(NOW.getTime() - 3 * 3_600_000),
  postponedUntil: null,
  nextFollowUpAt: null,
  contactAttempts: [{ result: 'NO_ANSWER', createdAt: new Date(NOW.getTime() - 3_600_000), nextFollowUpAt: new Date(NOW.getTime() - 30 * 60_000) }],
};

/** A transaction whose scans answer `scanRows` and whose single-row reads answer nothing: no new order, no postponed one. */
const tx = (scanRows: unknown[]) => ({ order: { findMany: vi.fn(async () => scanRows), findFirst: vi.fn(async () => null) } });
const pick = (t: ReturnType<typeof tx>, opts: Record<string, unknown>) =>
  pickNextCandidate(t as never, scope, NOW, 'sara', { heldForHerAsked: true, returns: WITH_CADENCE, ...opts } as never);

describe('one pick reads each ranking scan at most once', () => {
  it('the v2 pick finds nothing: the old order reads the promise scan and the retry scan back — two scans in all, not four', async () => {
    const t = tx([]);
    expect(await pick(t, { priority: { mode: 'NORMAL', backlogTurn: false } })).toBeNull();
    expect(t.order.findMany).toHaveBeenCalledTimes(2);
  });

  it('a retry that the v2 pick read but did not deal (not aged, not the backlog turn) is dealt by the old order — the same id, from the memo, with two scans in all', async () => {
    const t = tx([RETRY_ROW]);
    expect(await pick(t, { priority: { mode: 'NORMAL', backlogTurn: false } })).toBe('r1');
    expect(t.order.findMany).toHaveBeenCalledTimes(2);
  });

  it('the same retry is dealt the same way with no priority plan at all — the old pull, one scan each', async () => {
    const t = tx([RETRY_ROW]);
    expect(await pick(t, { priority: null })).toBe('r1');
    expect(t.order.findMany).toHaveBeenCalledTimes(2);
  });

  it('in a named time-of-day mode the v2 pick reads nothing and the old order reads each scan once', async () => {
    const t = tx([RETRY_ROW]);
    expect(await pick(t, { priority: { mode: 'NIGHT', backlogTurn: false } })).toBe('r1');
    expect(t.order.findMany).toHaveBeenCalledTimes(2);
  });

  it('a promise found by the v2 pick ends the pick at one scan', async () => {
    const promised = { id: 'p1', createdAt: new Date(NOW.getTime() - 5 * 3_600_000), postponedUntil: new Date(NOW.getTime() - 3_600_000), nextFollowUpAt: null, contactAttempts: [] };
    const t = tx([promised]);
    expect(await pick(t, { priority: { mode: 'NORMAL', backlogTurn: false } })).toBe('p1');
    expect(t.order.findMany).toHaveBeenCalledTimes(1);
  });

  it('without the cadence neither scan is read at all — the legacy pull is the old four queries', async () => {
    const t = tx([RETRY_ROW]);
    await pickNextCandidate(t as never, scope, NOW, 'sara', { heldForHerAsked: true, returns: null, priority: null } as never);
    expect(t.order.findMany).not.toHaveBeenCalled();
  });
});

describe('the share is read once while it is being read', () => {
  const client = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    return {
      release: () => release(),
      c: {
        order: {
          findMany: vi.fn(async () => { await gate; return [{ customerId: 'a' }, { customerId: 'b' }]; }),
          count: vi.fn(async () => { await gate; return 3; }),
        },
      },
    };
  };

  it('three pulls that arrive together share one read — one distinct and two counts — and one answer', async () => {
    const { c, release } = client();
    const key = { companyId: 'share-co-1', storeId: 'share-st-1' };
    const reads = [1, 2, 3].map(() => readBacklogShare(c as never, key, NOW, ['NEW']));
    release();
    const [a, b, d] = await Promise.all(reads);
    expect(c.order.findMany).toHaveBeenCalledTimes(1);
    expect(c.order.count).toHaveBeenCalledTimes(2);
    expect(b).toBe(a);
    expect(d).toBe(a);
  });

  it('once it has answered, the next pull is the cache’s — and another store is its own read', async () => {
    const { c, release } = client();
    release();
    const one = { companyId: 'share-co-2', storeId: 'share-st-2' };
    await readBacklogShare(c as never, one, NOW, ['NEW']);
    await readBacklogShare(c as never, one, NOW, ['NEW']);
    expect(c.order.findMany).toHaveBeenCalledTimes(1);
    await readBacklogShare(c as never, { companyId: 'share-co-2', storeId: 'share-st-3' }, NOW, ['NEW']);
    expect(c.order.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('the intake sweep before a pull', () => {
  const ran = () => (intakeFilterSwitch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
  const store = (n: string) => ({ companyId: `sweep-co-${n}`, storeId: `sweep-st-${n}`, countryCode: 'SY' });

  it('the first press of a store runs the sweep, and answers a number', async () => {
    const before = ran();
    await expect(sweepIntakeForPull(store('a'), 1_000)).resolves.toBe(0);
    expect(ran()).toBe(before + 1);
  });

  it('inside the gap a second press does not run it again; at the gap it does', async () => {
    await sweepIntakeForPull(store('b'), 10_000);
    const after = ran();
    await expect(sweepIntakeForPull(store('b'), 10_000 + PULL_SWEEP_GAP_MS - 1)).resolves.toBe(0);
    expect(ran()).toBe(after);
    await sweepIntakeForPull(store('b'), 10_000 + PULL_SWEEP_GAP_MS + 1);
    expect(ran()).toBe(after + 1);
  });

  it('while one runs, a second press shares it — the very same promise, one sweep', async () => {
    const before = ran();
    const first = sweepIntakeForPull(store('c'), 20_000);
    const second = sweepIntakeForPull(store('c'), 20_001);
    expect(second).toBe(first);
    await first;
    expect(ran()).toBe(before + 1);
  });

  it('the gap is half a minute, and another store has its own', async () => {
    expect(PULL_SWEEP_GAP_MS).toBe(30_000);
    const before = ran();
    await sweepIntakeForPull(store('d'), 30_000);
    await sweepIntakeForPull(store('e'), 30_001);
    expect(ran()).toBe(before + 2);
  });
});
