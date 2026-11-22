import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as wallets from './wallets';

/**
 * THE REAL DATE MOVES NO MONEY — A DIFFERENTIAL AGAINST osm/main (22/11).
 *
 * `real-date-money.main-golden.json` was frozen by running THIS file with `F4_WRITE_GOLDEN=1` while `src/lib/wallets.ts` was
 * `git show osm/main:src/lib/wallets.ts` (main cd4ff14d, before the real date existed): 60 seeded scenarios of `recordMovement`
 * (good and refused inputs, a stopped wallet, transfer legs), a `reverseMovement` (which carries a transfer's other leg), and
 * `walletBalance` of each wallet. Today's `lib/wallets.ts` must write the SAME rows, refuse the SAME inputs with the SAME messages
 * and answer the SAME balances when no real date is typed. And a typed real date changes no balance.
 *
 * An in-memory ledger plays the database. The golden is the main side; nothing here computes the expected figures with the
 * function under test.
 */

type Row = Record<string, unknown>;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function fakeLedger() {
  const movements: Row[] = [];
  let seq = 0;
  const writes: Row[] = [];
  const match = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o = v as Row;
        if ('not' in o) return row[k] !== o.not;
        if ('in' in o) return (o.in as unknown[]).includes(row[k]);
        return true;
      }
      return v === null ? row[k] == null : row[k] === v;
    });
  const tx = {
    wallet: {
      findFirst: async ({ where }: { where: Row }) =>
        where.id === 'w-off' ? null : { id: where.id, currencyCode: 'USD' },
      findUnique: async ({ where }: { where: Row }) => ({ id: where.id, currencyCode: 'USD', openingBalance: 100 }),
    },
    walletMovement: {
      create: async ({ data }: { data: Row }) => {
        writes.push(JSON.parse(JSON.stringify(data)));
        const row = { id: `m${++seq}`, createdAt: new Date(Date.UTC(2026, 10, 1) + seq * 60_000), ...data };
        movements.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Row }) => movements.find((m) => match(m, where)) ?? null,
      findUnique: async ({ where }: { where: Row }) => movements.find((m) => m.reversalOfId === where.reversalOfId) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        movements
          .filter((m) => match(m, where))
          .map((m) => ({ ...m, reversedBy: movements.find((r) => r.reversalOfId === m.id) ? { id: 'x' } : null })),
      aggregate: async ({ where }: { where: Row }) => ({
        _sum: { amount: movements.filter((m) => match(m, where)).reduce((a, m) => a + Number(m.amount), 0) },
      }),
      count: async ({ where }: { where: Row }) => movements.filter((m) => match(m, where)).length,
    },
    expense: { updateMany: async () => ({ count: 1 }), findFirst: async () => null },
  };
  return { tx, writes, movements };
}

type Wallets = {
  recordMovement: (tx: never, input: never) => Promise<Row>;
  reverseMovement: (tx: never, p: never) => Promise<Row>;
  walletBalance: (tx: never, walletId: string, minor?: number) => Promise<Row>;
};

/** Runs N random scenarios through the given `lib/wallets` and answers what was written and read, in order. */
async function runScenarios(w: Wallets, n = 60) {
  const r = rng(20261122);
  const out: unknown[] = [];
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  for (let i = 0; i < n; i++) {
    const { tx, writes, movements } = fakeLedger();
    const results: unknown[] = [];
    const steps = 2 + Math.floor(r() * 4);
    for (let s = 0; s < steps; s++) {
      const walletId = pick(['w1', 'w2', 'w-off']);
      const category = pick(['OTHER', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'COURIER_SETTLEMENT']);
      const input = {
        companyId: 'c1', walletId, direction: pick(['IN', 'OUT']), amount: pick([0, -1, 1, 12.5, 1000, Math.round(r() * 1e6) / 1e3]),
        party: `طرف ${s}`, category, note: `ملاحظة ${i}.${s}`, createdById: 'u1',
        ...(category.startsWith('TRANSFER') ? { referenceType: 'TRANSFER', referenceId: `t${i}` } : {}),
      };
      try {
        const row = await w.recordMovement(tx as never, input as never);
        results.push({ ok: true, direction: row.direction, amount: row.amount });
      } catch (e) {
        results.push({ ok: false, message: (e as Error).message });
      }
    }
    if (movements.length && r() < 0.6) {
      const target = pick(movements);
      try {
        await w.reverseMovement(tx as never, { companyId: 'c1', walletId: target.walletId, movementId: target.id, reason: 'تصحيح', createdById: 'u2' } as never);
        results.push({ reversed: true });
      } catch (e) {
        results.push({ reversed: false, message: (e as Error).message });
      }
    }
    for (const id of ['w1', 'w2']) results.push(await w.walletBalance(tx as never, id, 2));
    out.push({ writes, results });
  }
  return out;
}


const GOLDEN = join(process.cwd(), 'src', 'lib', 'real-date-money.main-golden.json');

describe('with no real date typed, the money is exactly osm/main', () => {
  it('the same rows written, the same refusals, the same balances — 60 scenarios', async () => {
    const now = JSON.parse(JSON.stringify(await runScenarios(wallets as never)));
    if (process.env.F4_WRITE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(now, null, 1)}\n`);
    expect(existsSync(GOLDEN)).toBe(true);
    expect(now).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('the golden is not empty: it holds writes, refusals and reversals', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { writes: Row[]; results: Row[] }[];
    expect(golden).toHaveLength(60);
    expect(golden.flatMap((g) => g.writes).length).toBeGreaterThan(60);
    expect(golden.flatMap((g) => g.results).some((r) => r.ok === false)).toBe(true);
    expect(golden.flatMap((g) => g.results).some((r) => r.reversed === true)).toBe(true);
  });
});

/**
 * WHAT ADDS MONEY UP NEVER READS THE REAL DATE. Balances, the daily closing, the matching, the profit to date and the partners'
 * statement stay on `createdAt` exactly as on osm/main; these are the files that do that arithmetic. Comments are blanked first.
 */
const MONEY_READERS = [
  'src/app/api/finance/closing/route.ts',
  'src/app/api/finance/route.ts',
  'src/lib/profit-to-date.ts',
  'src/lib/profit-summary.ts',
  'src/lib/partner-statement.ts',
  'src/lib/partner-statement-core.ts',
  'src/lib/statement-close.ts',
  'src/lib/match-integrity.ts',
  'src/lib/manual-statement.ts',
  'src/lib/pay-from-wallet.ts',
  'src/lib/expense-void.ts',
];
const code = (p: string) =>
  readFileSync(join(process.cwd(), p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('the arithmetic does not read the real date', () => {
  it.each(MONEY_READERS)('%s never mentions occurredAt', (file) => {
    expect(code(file)).not.toMatch(/occurredAt/);
  });

  it('walletBalance — the book balance every closing compares with — sums every movement, whatever its date', () => {
    const src = code('src/lib/wallets.ts');
    const body = src.slice(src.indexOf('export async function walletBalance'), src.indexOf('export interface MovementInput'));
    expect(body).toContain("where: { walletId, direction: 'IN' }");
    expect(body).not.toMatch(/occurredAt|createdAt/);
  });
});

describe('a typed real date changes no balance', () => {
  it('the same movements with and without a real date: one balance', async () => {
    const plain = fakeLedger();
    const dated = fakeLedger();
    const inputs = [
      { direction: 'IN', amount: 500 }, { direction: 'OUT', amount: 120.5 }, { direction: 'IN', amount: 33 },
    ];
    for (const [i, x] of inputs.entries()) {
      const base = { companyId: 'c1', walletId: 'w1', party: 'طرف', category: 'OTHER', note: 'ملاحظة', createdById: 'u1', ...x };
      await wallets.recordMovement(plain.tx as never, base as never);
      await wallets.recordMovement(dated.tx as never, { ...base, occurredAt: new Date(Date.UTC(2026, 9, 1 + i)) } as never);
    }
    // 100 opening + 500 − 120.5 + 33, worked by hand.
    expect(await wallets.walletBalance(plain.tx as never, 'w1', 2)).toMatchObject({ balance: 512.5 });
    expect(await wallets.walletBalance(dated.tx as never, 'w1', 2)).toEqual(await wallets.walletBalance(plain.tx as never, 'w1', 2));
    // And the only difference in what was written is the real date itself.
    expect(dated.writes.map((w) => Object.fromEntries(Object.entries(w).filter(([k]) => k !== 'occurredAt')))).toEqual(plain.writes);
    expect(dated.writes.every((w) => typeof w.occurredAt === 'string')).toBe(true);
  });

  it('NEGATIVE: a future real date is refused where every writer passes, and nothing is written', async () => {
    const ledger = fakeLedger();
    await expect(
      wallets.recordMovement(ledger.tx as never, {
        companyId: 'c1', walletId: 'w1', direction: 'IN', amount: 5, party: 'طرف', category: 'OTHER', note: 'ملاحظة', createdById: 'u1',
        occurredAt: new Date(Date.now() + 3600_000),
      } as never)
    ).rejects.toMatchObject({ code: 'OCCURRED_AT_FUTURE' });
    expect(ledger.writes).toHaveLength(0);
  });
});
