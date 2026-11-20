import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { roadCostShown, roadReport, type RoadTransfer, type RoadViewer } from './stock-transfer-road';

/**
 * «بضاعة بالطريق» (W7c) — the report the transfers list door hands the screen. Every expected figure below is written by
 * hand from the rows, never computed with the function under test.
 */

const JOD = { code: 'JOD', minorUnit: 3 };
const USD = { code: 'USD', minorUnit: 2 };
const stores: Record<string, { name: string; currency: typeof JOD | null }> = {
  s1: { name: 'المتجر', currency: JOD },
  s3: { name: 'متجر البلد التاني', currency: USD },
  s9: { name: 'متجر بلا عملة', currency: null },
};
const storeOf = (id: string) => stores[id] ?? { name: null, currency: null };

const t = (over: Partial<RoadTransfer>): RoadTransfer => ({
  id: 't',
  kind: 'BETWEEN_STORES',
  status: 'SENT',
  storeId: 's1',
  sentById: 'u-sender',
  lines: [{ costOut: 1 }],
  ...over,
});

const costViewer: RoadViewer = { id: 'u-books', seesCost: true, mayReceive: false };

describe('what is on the road', () => {
  it('counts only SENT: a request waiting for the owner, a received, a short one and a cancelled one are not on the road', () => {
    const r = roadReport(
      [
        t({ id: 'a' }),
        t({ id: 'b', kind: 'INTERNAL', lines: [{ costOut: null }] }),
        t({ id: 'c', status: 'AWAITING_APPROVAL' }),
        t({ id: 'd', status: 'RECEIVED' }),
        t({ id: 'e', status: 'RECEIVED_WITH_DIFFERENCE' }),
        t({ id: 'f', status: 'CANCELLED' }),
      ],
      costViewer,
      storeOf
    );
    expect([r.onTheRoad, r.internal, r.across]).toEqual([2, 1, 1]);
  });

  it('adds up what left PER SOURCE STORE, each in its own currency, rounded once to its minor unit — two currencies never meet', () => {
    const r = roadReport(
      [
        t({ id: 'a', storeId: 's1', lines: [{ costOut: 1.0004 }, { costOut: 2.0004 }] }),
        t({ id: 'b', storeId: 's1', kind: 'BETWEEN_COUNTRIES', lines: [{ costOut: 0.0004 }] }),
        t({ id: 'c', storeId: 's3', kind: 'BETWEEN_COUNTRIES', lines: [{ costOut: 10.005 }] }),
        // Inside one store: its units are still the store's stock — no cost counted here.
        t({ id: 'd', storeId: 's1', kind: 'INTERNAL', lines: [{ costOut: 99 }] }),
      ],
      costViewer,
      storeOf
    );
    expect(r.totals).toEqual([
      // 1.0004 + 2.0004 + 0.0004 = 3.0012 → 3.001 (three decimals)
      { storeId: 's1', storeName: 'المتجر', currency: JOD, transfers: 2, cost: 3.001 },
      // 10.005 → 10.01 (half away from zero, two decimals)
      { storeId: 's3', storeName: 'متجر البلد التاني', currency: USD, transfers: 1, cost: 10.01 },
    ]);
    expect(r.heldBack).toBe(0);
  });

  it('a store with no known currency is rounded to two places and says no code', () => {
    const r = roadReport([t({ storeId: 's9', lines: [{ costOut: 1.005 }] })], costViewer, storeOf);
    expect(r.totals).toEqual([{ storeId: 's9', storeName: 'متجر بلا عملة', currency: null, transfers: 1, cost: 1.01 }]);
  });

  it('a line with no cost kept counts as nothing, not as a crash', () => {
    const r = roadReport([t({ lines: [{ costOut: null }, {}, { costOut: 4 }] })], costViewer, storeOf);
    expect(r.totals![0].cost).toBe(4);
  });

  it('nothing on the road: zeros and an empty list', () => {
    expect(roadReport([], costViewer, storeOf)).toEqual({ onTheRoad: 0, internal: 0, across: 0, totals: [], heldBack: 0 });
  });
});

describe('who is told the cost', () => {
  it('NEGATIVE: a viewer without the cost key gets counts and no totals at all — null, not zeros', () => {
    const r = roadReport([t({ lines: [{ costOut: 8 }] })], { id: 'u-x', seesCost: false, mayReceive: false }, storeOf);
    expect([r.onTheRoad, r.across, r.totals, r.heldBack]).toEqual([1, 1, null, 0]);
  });

  it('NEGATIVE: a cost holder who may RECEIVE it is told how many were held back, never their value (the count stays blind)', () => {
    const receiver: RoadViewer = { id: 'u-receiver', seesCost: true, mayReceive: true };
    const r = roadReport([t({ id: 'a', lines: [{ costOut: 8 }] }), t({ id: 'b', lines: [{ costOut: 5 }] })], receiver, storeOf);
    expect(r.totals).toEqual([]);
    expect(r.heldBack).toBe(2);
    expect(JSON.stringify(r)).not.toMatch(/\b8\b|\b5\b|13/);
  });

  it('the sender is told the cost of her own transfer even with the receive key; not of another person’s', () => {
    const sender: RoadViewer = { id: 'u-sender', seesCost: true, mayReceive: true };
    const r = roadReport([t({ id: 'mine', lines: [{ costOut: 8 }] }), t({ id: 'theirs', sentById: 'u-other', lines: [{ costOut: 5 }] })], sender, storeOf);
    expect(r.totals).toEqual([{ storeId: 's1', storeName: 'المتجر', currency: JOD, transfers: 1, cost: 8 }]);
    expect(r.heldBack).toBe(1);
    expect(roadCostShown({ sentById: 'u-other' }, sender)).toBe(false);
    expect(roadCostShown({ sentById: 'u-sender' }, sender)).toBe(true);
    expect(roadCostShown({ sentById: 'u-sender' }, { ...sender, seesCost: false })).toBe(false);
  });
});

describe('the module', () => {
  it('touches no money: it imports nothing of wallets, expenses or profit, and no database', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/stock-transfer-road.ts'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./money']);
    expect(src).not.toMatch(/wallet|expense|profit|prisma|\bdb\b/i);
  });
});
