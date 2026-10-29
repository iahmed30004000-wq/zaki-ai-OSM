import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ONE DATABASE CLIENT, ONE POOL — IN PRODUCTION TOO (RV187).
 *
 * `db.ts` kept its client on `globalThis` everywhere EXCEPT production, so
 * every bundle that evaluated the module opened a client and a pool of its
 * own. A production build evaluates it several times; `globalThis` is what
 * those copies share.
 *
 * The test imports the module afresh, twice, the way two bundles do, with the
 * client class replaced by a counter.
 */

const { made } = vi.hoisted(() => ({ made: { count: 0 } }));
vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor() {
      made.count++;
    }
  },
}));

const slot = globalThis as unknown as { prisma?: unknown };

beforeEach(() => {
  made.count = 0;
  delete slot.prisma;
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete slot.prisma;
});

describe('the database client is built once per process', () => {
  it('in production, two evaluations of the module share one client', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const first = (await import('./db')).db;
    vi.resetModules(); // a second bundle evaluating the same file
    const second = (await import('./db')).db;

    expect(second, 'عميل ثاني بحوض اتصالات ثاني').toBe(first);
    expect(made.count).toBe(1);
  });

  it('and out of production it still does, as before', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const first = (await import('./db')).db;
    vi.resetModules();
    const second = (await import('./db')).db;
    expect(second).toBe(first);
    expect(made.count).toBe(1);
  });

  it('NEGATIVE: with nothing on the global, a fresh evaluation does build one', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await import('./db');
    expect(made.count).toBe(1);
  });
});
