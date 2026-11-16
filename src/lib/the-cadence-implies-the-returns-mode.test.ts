import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE CADENCE BRINGS «الطلب يرجع للطابور فوراً» WITH IT (step B, decision D5)
 *
 *  1. `returnsModeOn` answers true when ONLY the cadence is on (neither legacy switch is even asked); with the cadence off it is exactly what it was.
 *  2. `readReturnsMode` hands out a mode that carries `cadence: { since: enabledAt }` when the cadence is on — whatever «نظام الجولات» says — and a mode WITHOUT the key when only
 *     the legacy switches are on. All off → `null`, and the calendar callback is not even called.
 *  3. The idle release (`releaseNoAnswerRounds`) runs for a cadence company whose rounds are OFF — but only when the CALLER handed the cadence mode in. Handed nothing, or a legacy
 *     mode, with the rounds off it is the 0 and the not-one-query it always was.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { cad, rsw, rtn, reads } = vi.hoisted(() => ({
  cad: { since: null as Date | null },
  rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  rtn: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  reads: { rounds: 0, returns: 0, cadence: 0 },
}));

vi.mock('./db', () => ({ db: {} }));
vi.mock('./no-answer-cadence-switch', () => ({ cadenceSince: async () => ((reads.cadence += 1), cad.since) }));
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => ((reads.rounds += 1), rsw.value) }));
vi.mock('./no-answer-returns-switch', () => ({ returnsSwitch: async () => ((reads.returns += 1), rtn.value) }));

import { IDLE_RETURNED_REASON, returnsMode } from './no-answer-returns';
import { RETURNS_MODE, readReturnsMode, releaseNoAnswerRounds, returnsModeOn } from './confirmation-queue';
import { workClock } from './no-answer-rounds';

const ON_AT = new Date('2026-11-01T05:00:00.000Z');
const ON = { enabled: true, enabledAt: ON_AT };
const OFF = { enabled: false, enabledAt: null };
const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const NOW = new Date('2026-11-02T10:00:00.000Z');
const scope = { companyId: 'c1', storeId: 's1' };

beforeEach(() => {
  cad.since = null;
  rsw.value = OFF;
  rtn.value = OFF;
  reads.rounds = 0;
  reads.returns = 0;
  reads.cadence = 0;
});

describe('returnsModeOn', () => {
  it('is true with ONLY the cadence on — neither legacy switch is asked', async () => {
    cad.since = ON_AT;
    expect(await returnsModeOn({} as never, 'c1')).toBe(true);
    expect(reads.rounds).toBe(0);
    expect(reads.returns).toBe(0);
  });

  it('with the cadence off it is what it was: false while the rounds are off, and the mode’s own switch is not even asked', async () => {
    expect(await returnsModeOn({} as never, 'c1')).toBe(false);
    expect(reads.rounds).toBe(1);
    expect(reads.returns).toBe(0);
  });

  it('with the cadence off and both legacy switches on it is true, as before', async () => {
    rsw.value = ON;
    rtn.value = ON;
    expect(await returnsModeOn({} as never, 'c1')).toBe(true);
  });

  it('a rounds switch handed in is used as it always was (the cadence off)', async () => {
    rtn.value = ON;
    expect(await returnsModeOn({} as never, 'c1', ON)).toBe(true);
    expect(await returnsModeOn({} as never, 'c1', OFF)).toBe(false);
    expect(reads.rounds).toBe(0);
  });
});

describe('readReturnsMode', () => {
  it('the cadence on and the rounds OFF → a mode that carries the floor, and the calendar is read', async () => {
    cad.since = ON_AT;
    const calendar = vi.fn(() => JO);
    const mode = await readReturnsMode({} as never, 'c1', { now: NOW, calendar });
    expect(mode?.cadence).toEqual({ since: ON_AT });
    expect(calendar).toHaveBeenCalledTimes(1);
    expect(mode?.idleCut.getTime()).toBe(returnsMode(NOW, workClock(JO), RETURNS_MODE.idleBusinessMinutes).idleCut.getTime());
    expect(reads.cadence).toBe(1);
  });

  it('everything off → null, and the calendar callback is not called', async () => {
    const calendar = vi.fn(() => JO);
    expect(await readReturnsMode({} as never, 'c1', { now: NOW, calendar })).toBeNull();
    expect(calendar).not.toHaveBeenCalled();
  });

  it('only the legacy switches on → the mode WITHOUT the cadence key', async () => {
    rsw.value = ON;
    rtn.value = ON;
    const mode = await readReturnsMode({} as never, 'c1', { now: NOW, calendar: () => JO });
    expect(mode).not.toBeNull();
    expect('cadence' in (mode ?? {})).toBe(false);
  });

  it('the cadence AND the legacy switches on → the cadence mode, read once', async () => {
    cad.since = ON_AT;
    rsw.value = ON;
    rtn.value = ON;
    const mode = await readReturnsMode({} as never, 'c1', { now: NOW, calendar: () => JO });
    expect(mode?.cadence).toEqual({ since: ON_AT });
    expect(reads.cadence).toBe(1);
  });
});

/** A transaction that records what is asked of it. `claims` is what the idle query finds; the release writes succeed. */
function txOf(claims: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  const tx = {
    order: {
      findMany: vi.fn(async (_a: unknown) => (calls.push('order.findMany'), claims)),
      updateMany: vi.fn(async (_a: unknown) => (calls.push('order.updateMany'), { count: 1 })),
    },
    orderClaimHistory: { create: vi.fn(async (a: { data: { reason: string } }) => (calls.push(`history:${a.data.reason}`), {})) },
    notification: { createMany: vi.fn(async () => (calls.push('notification.createMany'), { count: 1 })) },
  };
  return { tx, calls };
}
const claim = (id: string) => ({ id, claimedAt: new Date('2026-11-02T06:00:00Z'), claimedById: 'sara', companyId: 'c1', customerId: null, orderNumber: `ORD-${id}` });

describe('releaseNoAnswerRounds with the rounds OFF', () => {
  const rounds = OFF as never;

  it('a cadence mode handed in → the idle release runs, with its own reason, bounded by the limit', async () => {
    const mode = returnsMode(NOW, workClock(JO), RETURNS_MODE.idleBusinessMinutes, ON_AT);
    const { tx, calls } = txOf([claim('o1')]);
    const n = await releaseNoAnswerRounds(tx as never, scope, JO, NOW, { rounds, roundsLimit: 25, returns: mode });
    expect(n).toBe(1);
    expect(tx.order.findMany).toHaveBeenCalledTimes(1);
    expect((tx.order.findMany.mock.calls[0][0] as { take: number }).take).toBe(25);
    expect(calls).toContain(`history:${IDLE_RETURNED_REASON}`);
  });

  it('R1 (the rounds’ own release) does not run: the only read is the idle one', async () => {
    const mode = returnsMode(NOW, workClock(JO), RETURNS_MODE.idleBusinessMinutes, ON_AT);
    const { tx } = txOf([]);
    await releaseNoAnswerRounds(tx as never, scope, JO, NOW, { rounds, returns: mode });
    expect(tx.order.findMany).toHaveBeenCalledTimes(1);
  });

  it('nothing handed in → 0 with not one query (what the job’s first transaction relies on)', async () => {
    const { tx, calls } = txOf([claim('o1')]);
    expect(await releaseNoAnswerRounds(tx as never, scope, JO, NOW, { rounds })).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a legacy mode (no cadence key) handed in → still 0 with not one query', async () => {
    const legacy = returnsMode(NOW, workClock(JO), RETURNS_MODE.idleBusinessMinutes);
    const { tx, calls } = txOf([claim('o1')]);
    expect(await releaseNoAnswerRounds(tx as never, scope, JO, NOW, { rounds, returns: legacy })).toBe(0);
    expect(calls).toEqual([]);
  });

  it('null handed in (the pull’s «off») → 0', async () => {
    const { tx, calls } = txOf([claim('o1')]);
    expect(await releaseNoAnswerRounds(tx as never, scope, JO, NOW, { rounds, returns: null })).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a zero limit is no query and no release', async () => {
    const mode = returnsMode(NOW, workClock(JO), RETURNS_MODE.idleBusinessMinutes, ON_AT);
    const { tx, calls } = txOf([claim('o1')]);
    expect(await releaseNoAnswerRounds(tx as never, scope, JO, NOW, { rounds, roundsLimit: 0, returns: mode })).toBe(0);
    expect(calls).toEqual([]);
  });
});
