import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE QUEUE READ IS A READ — the owner's ruling 4/11 («طلباتي أخف»).
 *
 * `GET /api/confirmation/queue` is polled every 30 seconds by every agent's
 * screen, and it used to WRITE on each poll: the ninety-minute release
 * (`releaseStaleClaims`) and the returning-customer hold
 * (`reserveReturningCustomers`). Both already have their own clocks — the
 * `release-stale-claims` job every 300 s and `reserve-returning-customers`
 * every 120 s — and the pull makes both before it takes anything. A poll that
 * writes holds a connection and row locks the agent's next navigation waits
 * behind.
 *
 * So this runs the REAL route over the REAL queue library with a database
 * that answers every read and records every write. Nothing in the library is
 * mocked away: a write that comes back by any path is caught.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { writes, db, requireContext, can } = vi.hoisted(() => {
  const writes: string[] = [];
  const READS: Record<string, unknown> = {
    findMany: [],
    findFirst: null,
    findUnique: null,
    findFirstOrThrow: null,
    count: 0,
    groupBy: [],
    aggregate: { _count: { _all: 0 }, _sum: {}, _min: {}, _max: {} },
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args?: { where?: Record<string, unknown> }) => {
            // NOT VACUOUS: a claim held three days with no attempt — the ninety-minute release WOULD let it go
            // (an `updateMany` + a claim-history `create`) if anything on this path still ran it.
            if (name === 'order' && method === 'findMany' && args?.where && 'contactAttempts' in args.where) {
              return [{ id: 'o-stale', claimedAt: new Date(Date.now() - 3 * 86_400_000), claimedById: 'u2', companyId: 'c1' }];
            }
            if (method in READS) return READS[method];
            writes.push(`${name}.${method}`);
            return { count: 0 };
          }),
      }
    );
  const db: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'then') return undefined;
        if (prop === '$queryRaw' || prop === '$queryRawUnsafe') return vi.fn(async () => []);
        if (prop.startsWith('$')) {
          // `$executeRaw`, `$executeRawUnsafe`, and `$transaction` — a transaction is where the release lived.
          return vi.fn(async (fn?: unknown) => {
            writes.push(prop);
            return typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : 0;
          });
        }
        return model(prop);
      },
    }
  );
  return { writes, db, requireContext: vi.fn(), can: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
// Called through, only watched: the hold's own reads find nothing here, so it is caught by being CALLED at all.
const { reserveSpy } = vi.hoisted(() => ({ reserveSpy: vi.fn() }));
vi.mock('@/lib/reserve-returning-customers', async (orig) => {
  const real = await orig<typeof import('@/lib/reserve-returning-customers')>();
  return {
    ...real,
    reserveReturningCustomers: (...a: Parameters<typeof real.reserveReturningCustomers>) => {
      reserveSpy(...a);
      return real.reserveReturningCustomers(...a);
    },
  };
});
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn(async () => ({})) }));

import { GET } from './route';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const as = (id: string, keys: string[]) => {
  requireContext.mockResolvedValue({ user: { id }, companyId: 'c1', storeId: 's1', country: COUNTRY });
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
};

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
});

describe('GET /api/confirmation/queue writes nothing', () => {
  it.each([
    ['an agent', ['confirmation.pull']],
    ['a supervisor', ['confirmation.supervise']],
  ])('for %s: no update, create, insert, delete, raw execute or transaction', async (_who, keys) => {
    as('huda', keys);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(writes).toEqual([]);
    expect(reserveSpy).not.toHaveBeenCalled();
  });

  it('and the two writes it dropped are still made by their own jobs and by the pull', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (p: string) => readFileSync(p, 'utf8');
    const route = read('src/app/api/confirmation/queue/route.ts');
    expect(route).not.toMatch(/releaseStaleClaims\(/);
    expect(route).not.toMatch(/reserveReturningCustomers\(/);
    // The clocks: release every five minutes, the hold every two.
    expect(read('src/lib/jobs/definitions/release-stale-claims.ts')).toMatch(/everySeconds: 300,[\s\S]*releaseStaleClaims\(tx, scope, cal, now/);
    expect(read('src/lib/jobs/definitions/reserve-returning-customers.ts')).toMatch(/everySeconds: 120,[\s\S]*reserveReturningCustomers\(/);
    // And the pull makes both before it takes anything.
    expect(read('src/app/api/confirmation/pull/route.ts')).toMatch(/await reserveReturningCustomers\(/);
    const pull = read('src/lib/confirmation-queue.ts');
    const fn = pull.slice(pull.indexOf('export async function pullNextOrder('));
    expect(fn.slice(0, fn.indexOf('ownedCounts('))).toMatch(/releaseStaleClaims\(tx, scope, cal, now/);
  });
});
