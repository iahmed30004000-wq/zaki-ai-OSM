import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The five-minute job: the ninety-minute release in its transaction, as always; with «نظام الجولات» ON, the rounds release in a
 * transaction of its OWN, so a pass that runs out of time cannot roll back the ninety-minute releases with it.
 */

const { db, queue, sw } = vi.hoisted(() => ({
  db: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn('tx')) },
  queue: { releaseStaleClaims: vi.fn(async () => 2), releaseNoAnswerRounds: vi.fn(async () => 3) },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
}));

vi.mock('../db', () => ({ db }));
vi.mock('../confirmation-queue', () => queue);
vi.mock('../no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('./definitions/shared', () => ({
  activeStores: async () => [
    { id: 's1', companyId: 'c1', country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' } },
  ],
}));

import { releaseClaims } from './definitions/release-stale-claims';
import { ROUNDS_OFF } from '../no-answer-rounds';

beforeEach(() => vi.clearAllMocks());

describe('the release job', () => {
  it('OFF: one transaction, the ninety-minute release only', async () => {
    sw.value = { enabled: false, enabledAt: null };
    const out = await releaseClaims.run({ now: new Date('2026-11-01T08:00:00Z') } as never);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(queue.releaseNoAnswerRounds).not.toHaveBeenCalled();
    expect(queue.releaseStaleClaims.mock.calls[0][4]).toEqual({ rounds: ROUNDS_OFF });
    expect(out.processed).toBe(2);
  });

  it('ON: the rounds release in a second transaction of its own', async () => {
    sw.value = { enabled: true, enabledAt: new Date('2026-11-01T05:00:00Z') };
    const out = await releaseClaims.run({ now: new Date('2026-11-01T08:00:00Z') } as never);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(queue.releaseStaleClaims.mock.calls[0][4]).toEqual({ rounds: ROUNDS_OFF });
    expect(queue.releaseNoAnswerRounds.mock.calls[0][4]).toEqual({ rounds: sw.value });
    expect(out.processed).toBe(5);
  });
});
