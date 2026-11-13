import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — `db` IS ONE OBJECT WITH TWO CLIENTS BEHIND IT (the owner, 13/11: «لوحة الأداء بتضل تعلق والسايت بطيء»)
 *
 *  1. There are two Prisma clients: the main one (a pool of at least twenty, as since 4/11) and the REPORTS' one (exactly six
 *     connections, a two-minute wait). The reports' client is BUILT the first time a report asks — loading the module builds one
 *     client only (`one-client-one-pool.test.ts` holds that), so a request that never runs a report pays nothing for it.
 *  2. A property read on `db` goes to the reports' client inside `runInHeavyLane` — however many queries a report starts at once —
 *     and to the main client everywhere else, so no caller changed. Methods run on the client they were read from
 *     (`db.$transaction` on the same client as the models around it).
 *  3. The clients live on `globalThis` (RV187): a second copy of the module opens no third and fourth.
 *  4. Nothing about the main client changed: its URL is still the pool-floored one.
 * ═══════════════════════════════════════════════════════════════════════
 */

const made: { kind: 'main' | 'reports'; url: string }[] = [];

vi.mock('@prisma/client', () => {
  class PrismaClient {
    kind: 'main' | 'reports';
    constructor(options: { datasourceUrl?: string }) {
      const limit = new URL(options.datasourceUrl ?? 'postgresql://x').searchParams.get('connection_limit');
      this.kind = limit === '6' ? 'reports' : 'main';
      made.push({ kind: this.kind, url: options.datasourceUrl ?? '' });
    }
    get order() {
      return { client: this.kind };
    }
    $transaction(fn: (tx: { client: string }) => unknown) {
      return fn({ client: this.kind });
    }
    $queryRaw() {
      return this.kind;
    }
  }
  return { PrismaClient };
});

type Fake = { order: { client: string }; $transaction: (fn: (tx: { client: string }) => unknown) => unknown; $queryRaw: () => string };
const g = globalThis as unknown as { prisma?: unknown; prismaReports?: unknown; prismaDb?: unknown };

async function load() {
  vi.resetModules();
  const { db } = (await import('./db')) as unknown as { db: Fake };
  const { runInHeavyLane } = await import('./heavy-lane');
  return { db, runInHeavyLane };
}

beforeEach(() => {
  made.length = 0;
  delete g.prisma;
  delete g.prismaReports;
  delete g.prismaDb;
  process.env.DATABASE_URL = ['postgresql://', ['u', 'p'].join(':'), '@localhost:5432/osm?schema=public&connection_limit=10'].join('');
});
afterEach(() => {
  delete g.prisma;
  delete g.prismaReports;
  delete g.prismaDb;
});

describe('two clients, one `db`', () => {
  it('opens a main client of at least twenty connections and, when a report asks, a reports client of exactly six with a two-minute wait', async () => {
    const { db, runInHeavyLane } = await load();
    // loading the module builds the main client and nothing else
    expect(made.map((m) => m.kind)).toEqual(['main']);
    await runInHeavyLane(async () => db.order.client);
    expect(made.map((m) => m.kind).sort()).toEqual(['main', 'reports']);
    const main = new URL(made.find((m) => m.kind === 'main')!.url);
    const reports = new URL(made.find((m) => m.kind === 'reports')!.url);
    expect(Number(main.searchParams.get('connection_limit'))).toBeGreaterThanOrEqual(20);
    expect(reports.searchParams.get('connection_limit')).toBe('6');
    expect(reports.searchParams.get('pool_timeout')).toBe('120');
    // everything else in the URL is the same database
    expect([reports.host, reports.pathname, reports.searchParams.get('schema')]).toEqual([main.host, main.pathname, main.searchParams.get('schema')]);
  });

  it('a read outside the lane is the main client’s; inside it the reports’; and after it the main’s again', async () => {
    const { db, runInHeavyLane } = await load();
    expect(db.order.client).toBe('main');
    const inside = await runInHeavyLane(async () => {
      await Promise.resolve();
      return db.order.client;
    });
    expect(inside).toBe('reports');
    expect(db.order.client).toBe('main');
  });

  it('a report that starts fifty queries at once keeps every one of them in the reports’ client', async () => {
    const { db, runInHeavyLane } = await load();
    const kinds = await runInHeavyLane(() => Promise.all(Array.from({ length: 50 }, async (_, i) => {
      if (i % 2) await new Promise((r) => setTimeout(r, 1));
      return db.order.client;
    })));
    expect(new Set(kinds)).toEqual(new Set(['reports']));
  });

  it('while a report runs, a request that is not one still gets the main client', async () => {
    const { db, runInHeavyLane } = await load();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const report = runInHeavyLane(async () => {
      await gate;
      return db.order.client;
    });
    expect(db.order.client).toBe('main');
    release();
    expect(await report).toBe('reports');
  });

  it('methods run on the client they were read from: a transaction opened in a report is the reports’ transaction', async () => {
    const { db, runInHeavyLane } = await load();
    expect(db.$transaction((tx) => tx.client)).toBe('main');
    expect(await runInHeavyLane(async () => db.$transaction((tx) => tx.client))).toBe('reports');
    expect(await runInHeavyLane(async () => db.$queryRaw())).toBe('reports');
    expect(db.$queryRaw()).toBe('main');
  });

  it('the clients are kept on globalThis, and a second copy of the module opens no more', async () => {
    const first = await load();
    await first.runInHeavyLane(async () => first.db.order.client);
    expect(made).toHaveLength(2);
    expect((g.prisma as { kind: string }).kind).toBe('main');
    expect((g.prismaReports as { kind: string }).kind).toBe('reports');
    const second = await load();
    await second.runInHeavyLane(async () => second.db.order.client);
    expect(made, 'a second copy of the module must reuse the two clients').toHaveLength(2);
  });

  it('and `db` itself is ONE object per process: a second copy of the module hands out the same proxy', async () => {
    const first = await load();
    const second = await load();
    expect(second.db).toBe(first.db);
    expect(g.prismaDb).toBe(first.db);
  });

  it('the reports’ client is built once, however many queries a report starts and however many reports run', async () => {
    const { db, runInHeavyLane } = await load();
    await runInHeavyLane(() => Promise.all(Array.from({ length: 30 }, async () => db.order.client)));
    await runInHeavyLane(async () => db.$queryRaw());
    expect(made.filter((m) => m.kind === 'reports')).toHaveLength(1);
  });

  it('NEGATIVE: no read outside a report ever builds the reports’ client', async () => {
    const { db } = await load();
    for (let i = 0; i < 20; i++) db.order.client;
    db.$queryRaw();
    expect(made.map((m) => m.kind)).toEqual(['main']);
    expect(g.prismaReports).toBeUndefined();
  });
});
