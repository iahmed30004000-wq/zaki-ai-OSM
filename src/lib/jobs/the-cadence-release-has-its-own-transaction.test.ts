import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The five-minute job and the cadence (step B, decision D5): the cadence brings «الطلب يرجع للطابور فوراً» with it, so its IDLE release runs even while «نظام الجولات» is off —
 * in a transaction of its own, after the ninety-minute release, exactly as the rounds' release does. The existing job test (`the-rounds-release-has-its-own-transaction`) is left
 * as it is: with the cadence off nothing here changes what it pins.
 */

const { db, queue, sw, cad } = vi.hoisted(() => ({
  db: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn('tx')) },
  queue: {
    releaseStaleClaims: vi.fn(async (..._a: unknown[]) => 2),
    releaseNoAnswerRounds: vi.fn(async (..._a: unknown[]) => 3),
    readReturnsMode: vi.fn(async (..._a: unknown[]) => ({ marker: 'the-cadence-mode' })),
  },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  cad: { since: null as Date | null, asked: 0 },
}));

vi.mock('../db', () => ({ db }));
vi.mock('../confirmation-queue', () => queue);
vi.mock('../no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('../no-answer-cadence-switch', () => ({ cadenceSince: async () => ((cad.asked += 1), cad.since) }));
vi.mock('./definitions/shared', () => ({
  activeStores: async () => [
    { id: 's1', companyId: 'c1', country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' } },
  ],
}));

import { releaseClaims } from './definitions/release-stale-claims';
import { ROUNDS_OFF } from '../no-answer-rounds';

const NOW = new Date('2026-11-01T08:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  sw.value = { enabled: false, enabledAt: null };
  cad.since = null;
  cad.asked = 0;
});

describe('the release job with the cadence', () => {
  it('rounds OFF + cadence ON: a second transaction runs releaseNoAnswerRounds with { rounds, returns }, and the first call is still { rounds: ROUNDS_OFF }', async () => {
    cad.since = new Date('2026-11-01T05:00:00Z');
    const out = await releaseClaims.run({ now: NOW } as never);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(queue.releaseStaleClaims.mock.calls[0][4]).toEqual({ rounds: ROUNDS_OFF });
    expect(queue.readReturnsMode).toHaveBeenCalledTimes(1);
    expect(queue.releaseNoAnswerRounds).toHaveBeenCalledTimes(1);
    expect(queue.releaseNoAnswerRounds.mock.calls[0][4]).toEqual({ rounds: sw.value, returns: { marker: 'the-cadence-mode' } });
    expect(out.processed).toBe(5);
  });

  it('rounds OFF + cadence OFF: one transaction, and the cadence mode is never read', async () => {
    const out = await releaseClaims.run({ now: NOW } as never);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(queue.readReturnsMode).not.toHaveBeenCalled();
    expect(queue.releaseNoAnswerRounds).not.toHaveBeenCalled();
    expect(queue.releaseStaleClaims.mock.calls[0][4]).toEqual({ rounds: ROUNDS_OFF });
    expect(out.processed).toBe(2);
  });

  /*
   * UPDATED 2026-11-18 (request C2, decision 5): this test was «rounds ON: the fifth argument is exactly { rounds } and the cadence is never asked» — with BOTH switches on the
   * job handed the rounds alone, so their 12-hour / date + 3 h / 90-minute releases ran beside the plan. C2 stops them while the plan is on: the plan is asked FIRST and the
   * second transaction carries the plan's mode (`{ rounds, returns }`, whose `cadence` makes `releaseNoAnswerRounds` skip `releaseByRounds`). The rounds alone (plan off) is main's, below.
   */
  it('rounds ON + cadence ON (C2): the plan is asked first and the second transaction carries its mode — the rounds are never handed in alone', async () => {
    sw.value = { enabled: true, enabledAt: new Date('2026-11-01T05:00:00Z') };
    cad.since = new Date('2026-11-01T05:00:00Z');
    await releaseClaims.run({ now: NOW } as never);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(queue.readReturnsMode).toHaveBeenCalledTimes(1);
    expect(queue.releaseNoAnswerRounds).toHaveBeenCalledTimes(1);
    expect(queue.releaseNoAnswerRounds.mock.calls[0][4]).toEqual({ rounds: sw.value, returns: { marker: 'the-cadence-mode' } });
    expect(cad.asked).toBe(1);
  });

  it('rounds ON + cadence OFF: the fifth argument is exactly { rounds }, as on main — the way back', async () => {
    sw.value = { enabled: true, enabledAt: new Date('2026-11-01T05:00:00Z') };
    await releaseClaims.run({ now: NOW } as never);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(queue.releaseNoAnswerRounds.mock.calls[0][4]).toEqual({ rounds: sw.value });
    expect(queue.readReturnsMode).not.toHaveBeenCalled();
  });
});
