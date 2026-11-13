import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE REPORTS RUN IN THEIR OWN LANE — A SOURCE GUARD (the owner, 13/11: «لوحة الأداء بتضل تعلق والسايت بطيء — حل المشكلة من جذورها»)
 *
 * The behaviour is proved where it lives: `heavy-lane.test.ts` (the lane, the shared answer), `db-lanes.test.ts` (two clients behind one
 * `db`), `the-board-answer-is-computed-once-in-the-lane.test.ts` (the board's bundle). What no behaviour test can see is a route
 * that quietly stops calling the lane — the board still draws, only the pool is full again. So this reads the sources:
 *
 *  1. Each report the performance board asks for goes through `heavyOnce(`.
 *  2. The shipping answer no longer starts a count per company (the seven-queries-per-courier fan-out that took the pool).
 *  3. `db.ts` routes by `inHeavyLane()` through a proxy and opens the reports' client with `withHeavyPool`; the main client is still
 *     opened through `withPoolFloor(process.env.DATABASE_URL)`.
 *  4. The lane and its answers live on `globalThis` (a production build makes a copy of a module per bundle).
 *  5. The board waits a minute for its four reports, not fifteen seconds.
 * ═══════════════════════════════════════════════════════════════════════
 */

const root = process.cwd();
const read = (file: string) => stripComments(readFileSync(join(root, file), 'utf8'));

const REPORTS: Record<string, string> = {
  'src/lib/analytics-answer.ts': 'the board’s and the dashboard’s numbers',
  'src/app/api/orders/confirmation/team/route.ts': 'the confirmation team table',
  'src/app/api/growth/attribution/route.ts': 'who brought the business, and through which door',
  'src/app/api/orders/shipping/performance/route.ts': 'the couriers',
};

describe('every report of the performance board goes through the lane', () => {
  for (const [file, what] of Object.entries(REPORTS)) {
    it(`${file} (${what}) computes through heavyOnce`, () => {
      const src = read(file);
      expect(src, 'the report no longer goes through the lane').toMatch(/heavyOnce\(/);
      expect(src).toMatch(/from '@\/lib\/heavy-lane'/);
    });
  }

  it('the questions are keyed by company and store (never by a person) — a key that held a user id would share nothing, and one without the store would share across stores', () => {
    for (const file of Object.keys(REPORTS)) {
      const src = read(file);
      const key = /const key = \[([\s\S]*?)\]\.join\('\|'\);/.exec(src)?.[1] ?? '';
      expect(key, `${file} has no key`).not.toBe('');
      expect(key, file).toMatch(/companyId/);
      expect(key, file).toMatch(/storeId/);
      expect(key, file).not.toMatch(/user/i);
    }
  });

  it('the dashboard’s answer shares the board’s computation: ONE builder behind both routes', () => {
    for (const route of ['src/app/api/analytics/route.ts', 'src/app/api/analytics/performance/route.ts']) {
      expect(read(route), route).toMatch(/answerAnalytics\(/);
    }
  });
});

describe('the shipping answer does not fan out a query per company any more', () => {
  const src = read('src/app/api/orders/shipping/performance/route.ts');

  it('it asks ONE grouped question — company × shipping status × settlement status — and counts in memory', () => {
    expect(src).toMatch(/db\.order\.groupBy\(/);
    expect(src).toMatch(/by: \['deliveryProviderId', 'shippingStatus', 'settlementStatus'\]/);
  });

  it('NEGATIVE: no `db.order.count(` is left in it (six counts for each of ten companies is sixty queries in the same instant)', () => {
    expect(src).not.toMatch(/db\.order\.count\(/);
  });
});

describe('`db` has two clients behind it', () => {
  const src = read('src/lib/db.ts');

  it('picks the client by the lane, through a proxy, at the moment a property is read', () => {
    expect(src).toMatch(/new Proxy\(main,/);
    expect(src).toMatch(/inLane\(\)\s*\?\s*reportsClient\(\)\s*:\s*main/);
    expect(src).toMatch(/value\.bind\(client\)/);
  });

  it('opens the reports’ client through withHeavyPool and keeps the main client on the floor of twenty', () => {
    expect(src).toMatch(/datasourceUrl:\s*withHeavyPool\(process\.env\.DATABASE_URL\)/);
    expect(src).toMatch(/datasourceUrl:\s*withPoolFloor\(process\.env\.DATABASE_URL\)/);
  });

  it('keeps both clients on globalThis (RV187), the main one under its old name', () => {
    expect(src).toMatch(/globalForPrisma\.prisma = main;/);
    expect(src).toMatch(/globalForPrisma\.prismaReports \?\?= new PrismaClient\(/);
    // …and the proxy that stands for `db` is one object per process, so a second copy of the module hands out the same one.
    expect(src).toMatch(/globalForPrisma\.prismaDb \?\?\s*new Proxy\(main,/);
    expect(src).toMatch(/globalForPrisma\.prismaDb = db;/);
  });

  it('builds the reports’ client when a report asks, not when the module loads', () => {
    expect(src).toMatch(/function reportsClient\(\): PrismaClient \{/);
    expect(src).not.toMatch(/^const reports =/m);
  });
});

describe('the lane lives on globalThis', () => {
  const src = read('src/lib/heavy-lane.ts');
  it('the storage and the answers are shared across copies of the module', () => {
    expect(src).toMatch(/shared\[LANE_KEY\] \?\?= new AsyncLocalStorage/);
    expect(src).toMatch(/__osmReportsAnswers \?\?= new Map/);
  });
  it('a computation that fails is dropped, never kept', () => {
    expect(src).toMatch(/answers\.delete\(key\);\s*throw error;/);
  });
});

describe('the dashboard waits a minute for its report too', () => {
  const src = read('src/components/screens/DashboardScreen.tsx');
  it('its analytics call carries the longer wait — it queues in the same lane as the board', () => {
    expect(src).toMatch(/apiFetch\(`\/api\/analytics\?period=\$\{period\}`, \{ timeoutMs: 60_000 \}\)/);
  });
});

describe('the board waits a minute for a report', () => {
  const src = read('src/components/screens/PerformanceScreen.tsx');
  it('all four of its calls carry the longer wait', () => {
    expect(src).toMatch(/const BOARD_WAIT_MS = 60_000;/);
    expect(src.match(/timeoutMs: BOARD_WAIT_MS/g)?.length).toBe(4);
  });
});
