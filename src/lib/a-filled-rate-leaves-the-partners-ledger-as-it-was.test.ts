import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * «سعر الصرف التلقائي» (23/11, F8) — THE PARTNERS' LEDGER READS THE STORED EQUIVALENT EXACTLY AS BEFORE.
 *
 * F8 fills `valueInStoreCurrency` from today's rate when the person leaves it empty, and keeps the rate beside it in four new columns.
 * The ledger (`partnerStatement`) must read the stored equivalent and NOTHING ELSE: the same stored equivalent gives the same statement,
 * whatever rate it was filled at — or whether it was filled at all.
 *
 *   1. ALWAYS (CI too): many random ledgers, each read twice — bare, and with the four rate columns filled with noise — give the
 *      same statement, and the movement query does not even select the new columns.
 *   2. DIFFERENTIAL, where `osm/main` (or `origin/main`) is in the clone: the same random ledgers through `git show <main>`'s
 *      `partner-statement.ts` and through this branch's give the same statement. Skipped where the main branch is not fetched.
 */

const { tables } = vi.hoisted(() => ({ tables: { partners: [] as unknown[], movements: [] as Record<string, unknown>[], users: [] as unknown[] } }));
const selects: unknown[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    partner: { findMany: async () => tables.partners },
    walletMovement: {
      findMany: async (q: { select: unknown }) => {
        selects.push(q.select);
        return tables.movements;
      },
    },
    user: { findMany: async () => tables.users },
  },
}));
vi.mock('@/lib/profit-to-date', () => ({
  profitToDate: async () => ({ summary: { netProfit: 1234.56 }, deliveredOrders: [{ estimatedCostOfGoods: 1 }, { estimatedCostOfGoods: 0 }] }),
}));

import { partnerStatement } from './partner-statement';

/** A small deterministic random source, so a failure names its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function ledger(seed: number) {
  const r = rng(seed);
  const partners = ['pa', 'pb', 'pc'].map((id, i) => ({ id, name: `شريك ${i}`, sharePercent: [50, 30, 20][i], isActive: true, sortOrder: i, createdAt: new Date(0) }));
  const movements: Record<string, unknown>[] = [];
  const n = 1 + Math.floor(r() * 12);
  for (let i = 0; i < n; i++) {
    const value = r() < 0.2 ? null : Math.round(r() * 100000) / 100;
    const row = {
      id: `m${seed}-${i}`, walletId: 'w1', direction: 'OUT', amount: Math.round(r() * 9e6) / 100, currencyCode: ['SYP', 'JOD', 'USDT', 'USD'][Math.floor(r() * 4)],
      valueInStoreCurrency: value, partnerId: r() < 0.1 ? null : partners[Math.floor(r() * 3)].id, party: 'سحب', note: '', reversalOfId: null,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)), createdById: 'u1', wallet: { name: 'الصندوق' },
    };
    movements.push(row);
    if (r() < 0.15) movements.push({ ...row, id: `${row.id}-r`, direction: 'IN', reversalOfId: row.id, createdAt: new Date(Date.UTC(2026, 10, 2, 0, i)) });
  }
  return { partners, movements };
}

/** The same rows with the four F8 columns filled with noise: a rate the ledger must never multiply by. */
const withRates = (rows: Record<string, unknown>[], seed: number) => {
  const r = rng(seed + 7);
  return rows.map((m) => ({
    ...m,
    equivalentRate: r() * 20000,
    equivalentRateKind: r() < 0.5 ? 'AUTO' : 'MANUAL',
    equivalentRateSource: 'open.er-api.com',
    equivalentRateAt: new Date(Date.UTC(2020, 0, 1)),
  }));
};

const SCOPE = { companyId: 'c1', storeId: 's1', currency: 'USD', minorUnit: 2 };
const SEEDS = Array.from({ length: 60 }, (_, i) => 1000 + i);

beforeEach(() => {
  tables.users = [{ id: 'u1', name: 'أحمد' }];
  selects.length = 0;
});

describe('1 · the rate columns are invisible to the ledger', () => {
  it.each(SEEDS)('seed %i: the statement with the rate columns filled is the statement without them', async (seed) => {
    const { partners, movements } = ledger(seed);
    tables.partners = partners;
    tables.movements = movements;
    const bare = await partnerStatement(SCOPE);
    tables.movements = withRates(movements, seed);
    const filled = await partnerStatement(SCOPE);
    expect(filled).toEqual(bare);
  });

  it('NEGATIVE: the movement query selects none of the four new columns', async () => {
    tables.partners = [];
    tables.movements = [];
    await partnerStatement(SCOPE);
    const keys = Object.keys(selects[0] as object);
    expect(keys).toContain('valueInStoreCurrency');
    for (const k of ['equivalentRate', 'equivalentRateKind', 'equivalentRateSource', 'equivalentRateAt']) expect(keys).not.toContain(k);
  });
});

/* ───────────── 2 · differential against the main branch's own file ───────────── */

function mainSource(): string | null {
  for (const ref of ['osm/main', 'origin/main']) {
    try {
      return execSync(`git show ${ref}:src/lib/partner-statement.ts`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      /* try the next one */
    }
  }
  return null;
}
const MAIN = mainSource();
const dir = MAIN ? mkdtempSync(join(tmpdir(), 'f8-main-')) : null;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!MAIN)('2 · differential: the main branch’s partner-statement.ts and this branch’s give the same statement', () => {
  const load = async () => {
    const lib = join(process.cwd(), 'src/lib').replace(/\\/g, '/');
    // The main file's relative imports point back at this tree's modules, so the same mocks stand behind both.
    const text = MAIN!.replace(/from '\.\/([^']+)'/g, (_m, p) => `from '${lib}/${p}'`);
    const file = join(dir!, 'partner-statement.main.ts');
    writeFileSync(file, text);
    return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as typeof import('./partner-statement');
  };

  it('this branch’s file is read from disk, not from the main branch (the comparison is not a file with itself)', () => {
    expect(readFileSync(join(process.cwd(), 'src/lib/partner-statement.ts'), 'utf8').length).toBeGreaterThan(0);
  });

  it.each(SEEDS)('seed %i: same ledger (with the rate columns filled) → identical statement', async (seed) => {
    const main = await load();
    const { partners, movements } = ledger(seed);
    tables.partners = partners;
    tables.movements = withRates(movements, seed);
    const ours = await partnerStatement(SCOPE);
    const theirs = await main.partnerStatement(SCOPE);
    expect(ours).toEqual(theirs);
  });
});
