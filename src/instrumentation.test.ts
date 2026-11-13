import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startPulse } = vi.hoisted(() => ({ startPulse: vi.fn() }));
vi.mock('./lib/server-pulse', () => ({ startPulse: (...a: unknown[]) => startPulse(...a) }));

import { register } from './instrumentation';

/**
 * THE START HOOK STARTS THE PULSE — in the Node server, and only there.
 *
 * Next calls `register` once for every runtime it serves; the pulse is a timer on the one Node process, so the edge
 * runtime (and a build, which has no runtime at all) must not start it.
 */

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('register', () => {
  it('starts the pulse once in the Node server', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await register();
    expect(startPulse).toHaveBeenCalledTimes(1);
  });

  it('starts nothing in the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(startPulse).not.toHaveBeenCalled();
  });

  it('and nothing where no runtime is named (a build, a script)', async () => {
    vi.stubEnv('NEXT_RUNTIME', '');
    await register();
    expect(startPulse).not.toHaveBeenCalled();
  });
});
