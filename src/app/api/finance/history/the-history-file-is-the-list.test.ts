import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * «سحب السجل» AT ITS THREE DOORS (22/11, F5) — driven through the real routes over in-memory tables that read Prisma's `where`.
 *
 *   1. THE FILE IS THE LIST: with the same filters, the file holds the same rows in the same order as the list on the screen
 *      (movements, transfers, withdrawals) — a differential over many random ledgers; with a span and a direction, the rows an
 *      independent reading of the store's days picks.
 *   2. The list's own key, through the real engine (`computeEffectiveGrants` → `can`): a role row without it, a personal DENY over a
 *      role that has it, and a legacy account with no roleId — 403, and nothing is read.
 *   3. Past the cap: an Arabic refusal naming a narrower span (JSON for the file, a page for the print), never a file.
 *   4. The print page carries the company, the filters and the totals.
 */

type Row = Record<string, any>;

const { db, tables, requireContext, current, reads } = vi.hoisted(() => {
  const tables = {
    wallet: [] as Row[], walletMovement: [] as Row[], walletTransfer: [] as Row[], partnerWithdrawal: [] as Row[],
    partner: [] as Row[], user: [] as Row[], store: [] as Row[], company: [] as Row[], country: [] as Row[], partnerStandingAmount: [] as Row[],
  };
  const reads = { count: 0 };

  /** Prisma's `where`, as far as these doors use it: equality, null, `in`, `gte`/`lt`, `OR`, `AND`. */
  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
      if (k === 'AND') return (v as Row[]).every((w) => matches(row, w));
      // A movement's wallet, read through the relation (23/11, F7: the draws clause is `wallet: { storeId: { in } }`).
      if (k === 'wallet' && 'walletId' in row) return matches(tables.wallet.find((w) => w.id === row.walletId) ?? {}, v as Row);
      const cell = row[k];
      if (v === null) return cell === null || cell === undefined;
      if (v instanceof Date) return cell instanceof Date && cell.getTime() === v.getTime();
      if (typeof v === 'object') {
        const o = v as Row;
        if ('in' in o && !(o.in as unknown[]).includes(cell)) return false;
        if ('gte' in o && !(cell instanceof Date && cell.getTime() >= o.gte.getTime())) return false;
        if ('lt' in o && !(cell instanceof Date && cell.getTime() < o.lt.getTime())) return false;
        return true;
      }
      return cell === v;
    });
  };

  const model = (name: keyof typeof tables, decorate: (r: Row) => Row = (r) => r) => ({
    findMany: vi.fn(async (args: Row = {}) => {
      reads.count += 1;
      let rows = tables[name].filter((r) => matches(r, args.where));
      if (args.orderBy?.createdAt === 'desc') rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (args.distinct) rows = rows.filter((r, i) => rows.findIndex((x) => args.distinct.every((d: string) => x[d] === r[d])) === i);
      if (typeof args.take === 'number') rows = rows.slice(0, args.take);
      return rows.map(decorate);
    }),
    findFirst: vi.fn(async (args: Row = {}) => tables[name].find((r) => matches(r, args.where)) ?? null),
    findUnique: vi.fn(async (args: Row = {}) => tables[name].find((r) => matches(r, args.where)) ?? null),
    aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })),
    count: vi.fn(async () => 0),
  });

  const movementDecorate = (m: Row) => {
    const of = m.reversalOfId ? tables.walletMovement.find((x) => x.id === m.reversalOfId) : null;
    const by = tables.walletMovement.find((x) => x.reversalOfId === m.id);
    return {
      ...m,
      reversalOf: of ? { id: of.id, note: of.note } : null,
      reversedBy: by ? { id: by.id, reversalReason: by.reversalReason, createdAt: by.createdAt } : null,
      wallet: { storeId: tables.wallet.find((w) => w.id === m.walletId)?.storeId ?? null },
    };
  };

  const db = {
    wallet: model('wallet'),
    walletMovement: model('walletMovement', movementDecorate),
    walletTransfer: model('walletTransfer'),
    partnerWithdrawal: model('partnerWithdrawal'),
    partner: model('partner'),
    user: model('user'),
    store: model('store'),
    company: model('company'),
    country: model('country'),
    partnerStandingAmount: model('partnerStandingAmount'),
  };
  return { db, tables, reads, requireContext: vi.fn(), current: { user: null as unknown as SessionUser } };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: (...a: unknown[]) => requireContext(...a),
  geoReach: async () => null,
}));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  walletBalance: vi.fn(async () => ({ balance: 0 })),
}));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    can: (_u: unknown, k: string) => real.can(current.user, k),
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { readXlsxRows } from '@/lib/xlsx-reader';
import { HISTORY_ROW_CAP, TOO_MANY_ROWS, MOVEMENT_HEADER, TRANSFER_HEADER, WITHDRAWAL_HEADER, TOTALS_TITLE } from '@/lib/history-export-core';
import { GET as listMovements } from '../wallets/[id]/movements/route';
import { GET as listTransfers } from '../transfers/route';
import { GET as listWithdrawals } from '../partners/withdrawals/route';
import { GET as movementsFile } from './movements/route';
import { GET as transfersFile } from './transfers/route';
import { GET as withdrawalsFile } from './withdrawals/route';

const TZ = 'Asia/Damascus'; // UTC+3, no daylight saving
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const W3 = '33333333-3333-4333-8333-333333333333'; // another store's wallet, same company

async function as(user: Record<string, unknown>, keys: string[], overrides: { permission: string; effect: 'ALLOW' | 'DENY' }[] = []) {
  const base = { id: 'u1', email: 'u@x', name: 'سلوى', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1', ...user } as unknown as SessionUser;
  current.user = attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => overrides.map((o) => ({ ...o, scope: 'ALL_COMPANY', scopeIds: null })) as never,
    })
  );
  requireContext.mockResolvedValue({
    user: current.user, companyId: 'c1', storeId: 's1', countryId: 'SY',
    country: { currencyCode: 'USD', minorUnit: 2, timezone: TZ },
  });
}

/** A small deterministic generator, so a failing seed can be replayed. */
function rng(seed: number) {
  let h = seed >>> 0;
  return () => {
    h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}

const DAY0 = Date.parse('2026-11-01T00:00:00.000Z');
const HOUR = 3600_000;

function seedLedger(seed: number, n: number) {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  tables.walletMovement.length = 0;
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(DAY0 + Math.floor(r() * 20 * 24) * HOUR + i * 1000);
    const typed = r() < 0.4 ? new Date(createdAt.getTime() - Math.floor(r() * 72) * HOUR) : null;
    const walletId = pick([W1, W1, W2]);
    tables.walletMovement.push({
      id: `m${i}`, companyId: 'c1', walletId, direction: pick(['IN', 'OUT']), amount: Math.round(r() * 100000) / 1000,
      currencyCode: walletId === W2 ? 'SYP' : 'USD', party: 'طرف', category: pick(['OTHER', 'EXPENSE', 'COURIER_SETTLEMENT', 'ADJUSTMENT']), note: `n${i}`,
      referenceType: null, referenceId: null, reversalOfId: null, reversalReason: null, partnerId: null, valueInStoreCurrency: null,
      createdById: pick(['u1', 'u2']), createdAt, occurredAt: typed,
    });
  }
  // A few reversals: a later entry pointing back at an earlier one of the same wallet.
  for (const m of tables.walletMovement.slice(0, Math.floor(n / 8))) {
    if (r() < 0.5) continue;
    tables.walletMovement.push({
      ...m, id: `${m.id}r`, note: `${m.note}r`, direction: m.direction === 'IN' ? 'OUT' : 'IN', reversalOfId: m.id, reversalReason: 'سبب',
      createdAt: new Date(m.createdAt.getTime() + HOUR), occurredAt: null,
    });
  }
}

const fileRows = async (res: Response) => {
  expect(res.status).toBe(200);
  return readXlsxRows(Buffer.from(await res.arrayBuffer()));
};
/** The data rows of a file: everything before the empty line that opens the totals. */
const dataRows = (rows: string[][]) => {
  const end = rows.findIndex((r, i) => i > 0 && (r.length === 0 || r[0] === TOTALS_TITLE));
  return rows.slice(1, end === -1 ? undefined : end);
};
const url = (path: string, q: Record<string, string> = {}) => `http://x/api/finance/history/${path}?${new URLSearchParams(q)}`;

beforeEach(async () => {
  vi.clearAllMocks();
  for (const t of Object.values(tables)) t.length = 0;
  reads.count = 0;
  const wallet = (id: string, name: string, storeId: string, currencyCode: string, minorUnit: number) => ({
    id, name, companyId: 'c1', storeId, countryId: 'SY', currencyCode, isActive: true, openingBalance: 0,
    country: { minorUnit, timezone: TZ }, store: { name: storeId === 's1' ? 'المتجر الأول' : 'المتجر التاني' },
    imageKey: null, iconKey: null, colorKey: null,
  });
  tables.wallet.push(wallet(W1, 'صندوق', 's1', 'USD', 2), wallet(W2, 'ليرة', 's1', 'SYP', 0), wallet(W3, 'بعيد', 's2', 'USD', 2));
  tables.user.push({ id: 'u1', name: 'سلوى' }, { id: 'u2', name: 'رنا' });
  tables.store.push(
    { id: 's1', companyId: 'c1', name: 'المتجر الأول', countryId: 'SY', country: { currencyCode: 'USD', minorUnit: 2 } },
    { id: 's2', companyId: 'c1', name: 'المتجر التاني', countryId: 'SY', country: { currencyCode: 'USD', minorUnit: 2 } }
  );
  tables.company.push({ id: 'c1', name: 'شركة التجربة' });
  tables.country.push({ id: 'SY', companyId: 'c1', currencyCode: 'SYP', minorUnit: 0 });
  tables.partner.push({ id: 'p1', companyId: 'c1', name: 'الشريك أ', isActive: true, sortOrder: 0, createdAt: new Date(DAY0) }, { id: 'p2', companyId: 'c1', name: 'الشريك ب', isActive: true, sortOrder: 1, createdAt: new Date(DAY0) });
  await as({}, ['finance.cashbox_view', 'finance.view', 'finance.partners']);
});

describe('the movements file is the movements list', () => {
  it('DIFFERENTIAL: the same wallet, no span — the same rows in the same order, over 40 random ledgers', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      seedLedger(seed, 30 + (seed % 50));
      for (const id of [W1, W2]) {
        const list = await (await listMovements(new Request('http://x'), { params: Promise.resolve({ id }) })).json();
        const file = dataRows(await fileRows(await movementsFile(new Request(url('movements', { walletId: id })))));
        const NOTE = MOVEMENT_HEADER.indexOf('ملاحظة');
        expect(file.map((r) => r[NOTE]), `seed ${seed} ${id}`).toEqual(list.movements.map((m: Row) => m.note));
        // The reversed state is the list's own reading.
        const STATE = MOVEMENT_HEADER.indexOf('الحالة');
        expect(file.map((r) => r[STATE].split(' — ')[0]), `seed ${seed}`).toEqual(
          list.movements.map((m: Row) => (m.isReversal ? 'قيد عكسي' : m.wasReversed ? 'معكوس' : 'ساري'))
        );
      }
    }
  });

  it('a span and a direction pick what an independent reading of the store days picks (real date, then registration)', async () => {
    for (let seed = 100; seed < 115; seed++) {
      seedLedger(seed, 60);
      for (const basis of ['real', 'registered'] as const) {
        const res = await movementsFile(new Request(url('movements', { from: '2026-11-05', to: '2026-11-12', basis, direction: 'OUT' })));
        const got = dataRows(await fileRows(res)).map((r) => r[MOVEMENT_HEADER.indexOf('ملاحظة')]).sort();
        // Damascus is UTC+3: the 5th starts at 21:00Z of the 4th, the 12th ends at 21:00Z of the 12th.
        const lo = Date.parse('2026-11-04T21:00:00.000Z');
        const hi = Date.parse('2026-11-12T21:00:00.000Z');
        const want = tables.walletMovement
          .filter((m) => [W1, W2].includes(m.walletId) && m.direction === 'OUT')
          .filter((m) => {
            const at = (basis === 'real' ? (m.occurredAt ?? m.createdAt) : m.createdAt).getTime();
            return at >= lo && at < hi;
          })
          .map((m) => m.note)
          .sort();
        expect(got, `seed ${seed} ${basis}`).toEqual(want);
      }
    }
  });

  it('NEGATIVE: another store\'s wallet is never in the file, even when it is asked for by id', async () => {
    seedLedger(7, 20);
    tables.walletMovement.push({ ...tables.walletMovement[0], id: 'far', walletId: W3, note: 'بعيد' });
    const all = dataRows(await fileRows(await movementsFile(new Request(url('movements')))));
    expect(all.some((r) => r.includes('بعيد'))).toBe(false);
    const asked = dataRows(await fileRows(await movementsFile(new Request(url('movements', { walletId: W3 })))));
    expect(asked).toEqual([]);
  });

  it('the totals are per currency, never across: a dollar wallet and a lira wallet', async () => {
    seedLedger(3, 40);
    const rows = await fileRows(await movementsFile(new Request(url('movements'))));
    const at = rows.findIndex((r) => r[0] === TOTALS_TITLE);
    const currencies = rows.slice(at + 2).map((r) => r[1]);
    expect(new Set(currencies)).toEqual(new Set(['USD', 'SYP']));
  });
});

describe('the transfers file is the transfers list', () => {
  const seedTransfers = (seed: number, n: number) => {
    const r = rng(seed);
    for (let i = 0; i < n; i++) {
      const pair = [[W1, W2], [W2, W1], [W1, W3], [W3, W1]][Math.floor(r() * 4)];
      const createdAt = new Date(DAY0 + Math.floor(r() * 20 * 24) * HOUR + i * 1000);
      tables.walletTransfer.push({
        id: `t${i}`, companyId: 'c1', fromWalletId: pair[0], toWalletId: pair[1], amountOut: 100, amountIn: 100, exchangeRate: 1, kind: 'INTERNAL',
        note: `t${i}`, createdById: 'u1', createdAt, occurredAt: r() < 0.3 ? new Date(createdAt.getTime() - 30 * HOUR) : null,
      });
    }
  };

  it('DIFFERENTIAL: no filter — the list\'s rows in the list\'s order; with a wallet — the rows with that wallet on either side', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      tables.walletTransfer.length = 0;
      seedTransfers(seed, 20 + seed * 3);
      const list = await (await listTransfers()).json();
      const NOTE = TRANSFER_HEADER.indexOf('ملاحظة');
      const all = dataRows(await fileRows(await transfersFile(new Request(url('transfers')))));
      expect(all.map((r) => r[NOTE]), `seed ${seed}`).toEqual(list.transfers.map((t: Row) => t.note));
      const one = dataRows(await fileRows(await transfersFile(new Request(url('transfers', { walletId: W2 })))));
      expect(one.map((r) => r[NOTE])).toEqual(list.transfers.filter((t: Row) => t.fromWalletId === W2 || t.toWalletId === W2).map((t: Row) => t.note));
    }
  });
});

/*
 * 23/11 (F7) — UPDATED: the withdrawals tab and its file read PARTNER_DRAW wallet movements, not `partner_withdrawals`.
 * Old: the file's rows were the tab's partner_withdrawals rows (cancelled ones «ملغى»). New: both are the store's PARTNER_DRAW
 * movements (reversed ones «معكوس»), and an old partner_withdrawals row is in neither the file nor the totals. Why: the owner's
 * «والحركات تكون من المحافظ … خلص مكان واحد».
 */
function seedDraws(seed: number, n: number) {
  const r = rng(seed);
  tables.walletMovement.length = 0;
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(DAY0 + i * HOUR);
    const walletId = r() < 0.15 ? W3 : r() < 0.6 ? W1 : W2;
    tables.walletMovement.push({
      id: `d${i}`, companyId: 'c1', walletId, direction: 'OUT', amount: 50 + i, currencyCode: walletId === W2 ? 'SYP' : 'USD',
      party: 'شريك', category: 'PARTNER_DRAW', note: `d${i}`, referenceType: 'PARTNER_DRAW', partnerId: r() < 0.5 ? 'p1' : 'p2',
      referenceId: null, valueInStoreCurrency: walletId === W2 ? 1 + i : 50 + i, reversalOfId: null, reversalReason: null,
      createdById: 'u1', createdAt, occurredAt: r() < 0.3 ? new Date(createdAt.getTime() - 30 * HOUR) : null,
    });
  }
  for (const m of tables.walletMovement.slice(0, 6)) {
    if (r() < 0.5) continue;
    tables.walletMovement.push({ ...m, id: `${m.id}r`, direction: 'IN', reversalOfId: m.id, reversalReason: 'غلط', occurredAt: null, createdAt: new Date(m.createdAt.getTime() + 99 * HOUR) });
  }
  // Another kind of movement in the same wallets is never a withdrawal.
  tables.walletMovement.push({ ...tables.walletMovement[0], id: 'other', category: 'OTHER', partnerId: null, valueInStoreCurrency: null, note: 'ليس سحب' });
}

describe('the withdrawals file is the withdrawals dashboard', () => {
  it('DIFFERENTIAL: the dashboard\'s rows of this store, in its order, with the reversed ones marked', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      seedDraws(seed, 15 + seed);
      // An old record row: shown on the dashboard in its own block, in neither the file nor the totals.
      tables.partnerWithdrawal.length = 0;
      tables.partnerWithdrawal.push({
        id: 'legacy', companyId: 'c1', storeId: 's1', partnerId: 'p1', currencyCode: 'USD', amount: 999, withdrawnOn: new Date('2026-11-02T00:00:00Z'),
        fromStanding: false, note: 'قديم', reversalOfId: null, reversalReason: null, createdById: 'u1', createdAt: new Date(DAY0),
      });
      const book = await (await listWithdrawals(new Request('http://x/api/finance/partners/withdrawals'))).json();
      const file = dataRows(await fileRows(await withdrawalsFile(new Request(url('withdrawals')))));
      const expected = tables.walletMovement.filter((m) => m.category === 'PARTNER_DRAW' && !m.reversalOfId && m.walletId !== W3);
      expect(book.rows.map((x: Row) => x.note).sort(), `seed ${seed}`).toEqual(expected.map((m) => m.note).sort());
      expect(file.map((x) => x[WITHDRAWAL_HEADER.indexOf('ملاحظة')]), `seed ${seed}`).toEqual(book.rows.map((x: Row) => x.note));
      expect(file.map((x) => x[WITHDRAWAL_HEADER.indexOf('الحالة')].startsWith('معكوس'))).toEqual(book.rows.map((x: Row) => !!x.wasReversed));
      expect(file.some((x) => x.includes('قديم'))).toBe(false);
      expect(book.legacy.map((x: Row) => x.id)).toEqual(['legacy']);
    }
  });

  it('a span on the real date of the movement, and a partner', async () => {
    for (let i = 0; i < 10; i++) {
      tables.walletMovement.push({
        id: `d${i}`, companyId: 'c1', walletId: W1, direction: 'OUT', amount: 10, currencyCode: 'USD', party: 'شريك', category: 'PARTNER_DRAW',
        note: `d${i}`, referenceType: 'PARTNER_DRAW', referenceId: null, partnerId: i % 2 ? 'p1' : 'p2', valueInStoreCurrency: 10,
        reversalOfId: null, reversalReason: null, createdById: 'u1',
        // Registered on the 20th; really on the (1 + i)th at noon, Damascus.
        createdAt: new Date('2026-11-20T09:00:00Z'), occurredAt: new Date(`2026-11-${String(1 + i).padStart(2, '0')}T09:00:00Z`),
      });
    }
    const file = dataRows(await fileRows(await withdrawalsFile(new Request(url('withdrawals', { from: '2026-11-03', to: '2026-11-06', partnerId: 'p1' })))));
    expect(file.map((x) => x[WITHDRAWAL_HEADER.indexOf('ملاحظة')]).sort()).toEqual(['d3', 'd5']);
  });
});

describe('NEGATIVE: the list\'s own key, read the way a session reads it', () => {
  const doors = [
    { name: 'movements', call: () => movementsFile(new Request(url('movements'))), key: 'finance.cashbox_view' },
    { name: 'transfers', call: () => transfersFile(new Request(url('transfers'))), key: 'finance.cashbox_view' },
    { name: 'withdrawals', call: () => withdrawalsFile(new Request(url('withdrawals'))), key: 'finance.partners' },
  ];

  it('a role row without the key → 403, and nothing is read', async () => {
    for (const d of doors) {
      // Everything a finance person could hold, except this door's key.
      await as({}, ['finance.view', 'finance.cashbox', 'finance.cashbox_view', 'finance.partners', 'finance.update'].filter((k) => k !== d.key && !(d.key === 'finance.cashbox_view' && k === 'finance.cashbox')));
      reads.count = 0;
      const res = await d.call();
      expect(res.status, d.name).toBe(403);
      expect(reads.count, d.name).toBe(0);
    }
  });

  it('a personal DENY over a role that holds the key → 403', async () => {
    for (const d of doors) {
      await as({}, ['finance.view', 'finance.cashbox_view', 'finance.partners'], [{ permission: d.key, effect: 'DENY' }]);
      const res = await d.call();
      expect(res.status, d.name).toBe(403);
    }
  });

  it('a legacy account with no roleId is read from its role template: the confirmation agent opens none of the three', async () => {
    await as({ role: 'CONFIRMATION_AGENT' as never, roleId: null }, []);
    for (const d of doors) expect((await d.call()).status, d.name).toBe(403);
  });

  it('and the key alone opens the door (the mutation partner of the three above)', async () => {
    await as({}, ['finance.cashbox_view']);
    expect((await doors[0].call()).status).toBe(200);
    expect((await doors[1].call()).status).toBe(200);
    expect((await doors[2].call()).status).toBe(403);
    await as({}, ['finance.view', 'finance.partners']);
    expect((await doors[2].call()).status).toBe(200);
  });
});

describe('past the cap', () => {
  it(`more than ${HISTORY_ROW_CAP} rows: an Arabic refusal naming a narrower span — JSON for the file, a page for the print`, async () => {
    for (let i = 0; i <= HISTORY_ROW_CAP; i++) {
      tables.walletMovement.push({
        id: `m${i}`, companyId: 'c1', walletId: W1, direction: 'IN', amount: 1, currencyCode: 'USD', party: 'ط', category: 'OTHER', note: 'n',
        reversalOfId: null, reversalReason: null, createdById: 'u1', createdAt: new Date(DAY0 + i * 1000), occurredAt: null, valueInStoreCurrency: null,
      });
    }
    const res = await movementsFile(new Request(url('movements', { walletId: W1 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'HISTORY_TOO_MANY_ROWS', errorAr: TOO_MANY_ROWS.errorAr });
    const page = await movementsFile(new Request(url('movements', { walletId: W1, format: 'print' })));
    expect(page.status).toBe(422);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('ضيّق التاريخ');
    // At the cap exactly, the file is made.
    tables.walletMovement.pop();
    expect((await movementsFile(new Request(url('movements', { walletId: W1 })))).status).toBe(200);
  });

  it('NEGATIVE: a span that runs backwards is refused before anything is read', async () => {
    reads.count = 0;
    const res = await movementsFile(new Request(url('movements', { from: '2026-11-20', to: '2026-11-01' })));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('HISTORY_BAD_RANGE');
    expect(reads.count).toBe(0);
  });
});

describe('the print page', () => {
  it('names the company and the store, the filters, and the totals per currency', async () => {
    seedLedger(5, 25);
    const res = await movementsFile(new Request(url('movements', { from: '2026-11-01', to: '2026-11-30', format: 'print' })));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('شركة التجربة — المتجر الأول');
    expect(html).toContain('الفترة: من 2026-11-01 إلى 2026-11-30 (حسب تاريخ الحركة)');
    expect(html).toContain('المحفظة: كل محافظ المتجر');
    expect(html).toContain(TOTALS_TITLE);
  });
});
