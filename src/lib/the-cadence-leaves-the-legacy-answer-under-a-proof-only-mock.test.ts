import { describe, expect, it, vi } from 'vitest';

/**
 * A `call-proof-switch` mock that exports ONLY `callProofOn` (the shape of the three step-A route tests) must leave `returnsModeOn` on its legacy answer: the cadence reads «off»
 * through the reader's try/catch, the rounds switch is asked as it always was, and nothing throws at a door.
 */

vi.mock('./call-proof-switch', () => ({ callProofOn: async () => true }));
vi.mock('./db', () => ({ db: {} }));
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('./no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: true, enabledAt: new Date('2026-11-01T05:00:00Z') }) }));

import { returnsModeOn } from './confirmation-queue';

describe('returnsModeOn under a proof-only call-proof-switch mock', () => {
  it('is the legacy answer: the rounds are off, so the mode is off', async () => {
    expect(await returnsModeOn({} as never, 'c1')).toBe(false);
  });
});
