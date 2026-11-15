import { describe, expect, it, vi } from 'vitest';

/**
 * THE SHAPE THREE STEP-A ROUTE TESTS DEPEND ON.
 *
 * `a-no-answer-needs-a-call-thirty-seconds-old`, `a-status-no-answer-needs-its-line-first` and `the-desk-says-what-the-no-answer-waits-for` mock `@/lib/call-proof-switch` with ONLY
 * `callProofOn`. Step B's `cadenceSince` asks `callProofSwitch`, which such a mock does not export — and vitest THROWS on the access of a missing mock export. The reader catches
 * it, so those tests keep reading «the cadence is off» and stay what they were.
 *
 * This file pins that assumption: if a vitest upgrade ever stops throwing there (or starts returning something else), THIS test fails — not production, and not three unrelated
 * suites at once.
 */

vi.mock('./call-proof-switch', () => ({ callProofOn: async () => true }));

import { cadenceSince } from './no-answer-cadence-switch';

describe('a call-proof-switch mock without callProofSwitch', () => {
  it('reads as «the cadence is off» and throws nothing', async () => {
    await expect(cadenceSince({} as never, 'c1')).resolves.toBeNull();
  });
});
