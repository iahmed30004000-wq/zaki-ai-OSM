import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import { ROLE_PERMISSIONS, type UserRole } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «المسحوبات» — THE DOOR, DRIVEN WITH PEOPLE BUILT THE WAY A SESSION BUILDS THEM, ON IN-MEMORY TABLES.
 *
 * 23/11 (F7) — REWRITTEN: a withdrawal IS a wallet movement. Old (22/11): POST wrote a `partner_withdrawals` row («moves no wallet»),
 * PATCH wrote its cancel, GET totalled those rows. New: GET is a dashboard over the PARTNER_DRAW wallet movements (the partners'
 * statement's own rows — the same figures, proven below), the old rows are listed apart and counted nowhere, POST and PATCH are
 * RETIRED (an Arabic sentence pointing at the wallet, nothing written), and PUT saves the standing amounts (an amount per currency).
 * The one change at the draws door: «ما يعادله» is optional — a draw in its own currency alone is counted in no share. The draw itself goes through `POST /api/finance/partners/draws` — the wallet's own rules, driven here too.
 * Why: «والحركات تكون من المحافظ … ما بدي الحركات المالية بكل مكان، خلص مكان واحد».
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const { tables, db, requireContext, logAudit, current, writes } = vi.hoisted(() => {
  const tables = {
    partner: [] as Row[], partnerStandingAmount: [] as Row[], partnerWithdrawal: [] as Row[], walletMovement: [] as Row[],
    wallet: [] as Row[], store: [] as Row[], country: [] as Row[], user: [] as Row[], expense: [] as Row[],
  };
  const writes = { count: 0 };
  let seq = 0;

  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
      if (k === 'AND') return (v as Row[]).every((w) => matches(row, w));
      if (k === 'NOT') return !matches(row, v as Row);
      if (k === 'reversedBy' && v === null) return !tables.walletMovement.some((x) => x.reversalOfId === row.id);
      if (k === 'wallet' && 'walletId' in row) return matches(tables.wallet.find((w) => w.id === row.walletId) ?? {}, v as Row);
      if (k === 'partnerId_currencyCode') return row.partnerId === v.partnerId && row.currencyCode === v.currencyCode;
      const cell = row[k];
      if (v === null) return cell === null || cell === undefined;
      if (v instanceof Date) return cell instanceof Date && cell.getTime() === v.getTime();
      if (typeof v === 'object') {
        const o = v as Row;
        if ('in' in o && !(o.in as unknown[]).includes(cell)) return false;
        if ('not' in o && cell === o.not) return false;
        if ('gte' in o && !(cell instanceof Date && cell.getTime() >= o.gte.getTime())) return false;
        if ('lt' in o && !(cell instanceof Date && cell.getTime() < o.lt.getTime())) return false;
        return true;
      }
      if (k === 'amount') return Number(cell) === Number(v);
      return cell === v;
    });
  };
  const decorate = (name: string, r: Row): Row => {
    if (name === 'walletMovement') {
      const by = tables.walletMovement.find((x) => x.reversalOfId === r.id);
      const of = r.reversalOfId ? tables.walletMovement.find((x) => x.id === r.reversalOfId) : null;
      const w = tables.wallet.find((x) => x.id === r.walletId);
      return {
        ...r,
        reversedBy: by ? { id: by.id, reversalReason: by.reversalReason, createdAt: by.createdAt } : null,
        reversalOf: of ? { id: of.id, note: of.note } : null,
        wallet: { storeId: w?.storeId ?? null, name: w?.name ?? '—' },
      };
    }
    if (name === 'wallet') {
      const c = tables.country.find((x) => x.id === r.countryId);
      return { ...r, country: { minorUnit: c?.minorUnit ?? 2, timezone: 'Asia/Damascus' } };
    }
    if (name === 'store') return { ...r, country: tables.country.find((x) => x.id === r.countryId) };
    return r;
  };
  const model = (name: keyof typeof tables) => ({
    findMany: async (args: Row = {}) => {
      let rows = tables[name].filter((r) => matches(r, args.where));
      if (args.orderBy?.createdAt === 'desc') rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (args.distinct) rows = rows.filter((r, i) => rows.findIndex((x) => args.distinct.every((d: string) => x[d] === r[d])) === i);
      if (typeof args.take === 'number') rows = rows.slice(0, args.take);
      return rows.map((r) => decorate(name, r));
    },
    findFirst: async (args: Row = {}) => {
      const r = tables[name].find((x) => matches(x, args.where));
      return r ? decorate(name, r) : null;
    },
    findUnique: async (args: Row = {}) => {
      const r = tables[name].find((x) => matches(x, args.where));
      return r ? decorate(name, r) : null;
    },
    create: async ({ data }: Row) => {
      writes.count += 1;
      const row = { id: `${name}${++seq}`, createdAt: new Date(Date.now() + seq), reversalOfId: null, reversalReason: null, ...data };
      tables[name].push(row);
      return row;
    },
    upsert: async ({ where, create, update }: Row) => {
      writes.count += 1;
      const found = tables[name].find((x) => matches(x, where));
      if (found) Object.assign(found, update);
      else tables[name].push({ id: `${name}${++seq}`, createdAt: new Date(), ...create });
    },
    deleteMany: async ({ where }: Row) => {
      writes.count += 1;
      tables[name] = tables[name].filter((x) => !matches(x, where)) as never;
    },
    aggregate: async ({ where }: Row) => ({ _sum: { amount: tables[name].filter((r) => matches(r, where)).reduce((s, r) => s + Number(r.amount), 0) } }),
    count: async ({ where }: Row = {}) => tables[name].filter((r) => matches(r, where)).length,
  });
  const db: Row = {};
  for (const name of Object.keys(tables) as (keyof typeof tables)[]) db[name] = model(name);
  db.$queryRaw = async () => [];
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { tables, db, writes, requireContext: vi.fn(), logAudit: vi.fn(), current: { user: null as unknown as SessionUser } };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: (...a: unknown[]) => requireContext(...a),
  geoReach: async () => null,
}));
vi.mock('@/lib/profit-to-date', () => ({
  profitToDate: async () => ({ summary: { netProfit: 1000 }, deliveredOrders: [] }),
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
import { PERMISSION_MODULES } from '@/lib/permission-catalog';
import { partnerStatement } from '@/lib/partner-statement';
import { recordMovement, reverseMovement } from '@/lib/wallets';
import { GET, PATCH, POST, PUT } from './route';
import { POST as DRAW } from '../draws/route';

const WU = '11111111-1111-4111-8111-111111111111'; // dollars, this store
const WJ = '22222222-2222-4222-8222-222222222222'; // dinars, this store
const WX = '33333333-3333-4333-8333-333333333333'; // dollars, the other store
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

async function person(
  roleKeys: string[],
  overrides: { permission: string; effect: 'DENY' | 'ALLOW' }[] = [],
  base: Partial<SessionUser> = {}
): Promise<SessionUser> {
  const u = { id: 'u1', email: 'u@x', name: 'سارة', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1', ...base } as unknown as SessionUser;
  return attachGrants(
    u,
    await computeEffectiveGrants(u as never, {
      roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => overrides.map((o) => ({ permission: o.permission, effect: o.effect, scope: null, scopeIds: null })),
    })
  );
}
async function as(u: SessionUser, storeId = 's1') {
  current.user = u;
  requireContext.mockResolvedValue({ user: u, companyId: 'c1', storeId, country: { currencyCode: 'USD', minorUnit: 2, timezone: 'Asia/Damascus' } });
}
const HOLDER = ['finance.view', 'finance.partners'];
const CASHIER_PARTNER = ['finance.view', 'finance.partners', 'finance.cashbox_view', 'finance.cashbox'];
const EVERY_OTHER_MONEY_KEY = PERMISSION_MODULES.filter((m) => m.module === 'finance' || m.module === 'settlement')
  .flatMap((m) => m.items.map((i) => i.key))
  .filter((k) => k !== 'finance.partners');

/** A request whose body is a spy: a door that read it before asking the key would be caught. */
function req(method: string, body: unknown, url = 'http://x/api/finance/partners/withdrawals') {
  const json = vi.fn(async () => body);
  return { r: { method, url, json } as unknown as Request, json };
}
const send = async (method: 'POST' | 'PATCH' | 'PUT', body: unknown) => {
  const h = { POST, PATCH, PUT }[method];
  const res = await h(req(method, body).r);
  return { status: res.status, body: await res.json() };
};
const book = async (q = '') => {
  const res = await GET(new Request(`http://x/api/finance/partners/withdrawals${q}`));
  return { status: res.status, body: await res.json() };
};
const drawOf = async (body: Record<string, unknown>) => {
  const res = await DRAW(req('POST', body, 'http://x/api/finance/partners/draws').r);
  return { status: res.status, body: await res.json() };
};
/** A draw already in the ledger — what the draws door writes (lib/wallets `recordMovement`). */
const seeded = (over: Row) => {
  const row = {
    id: `d${tables.walletMovement.length + 1}`, companyId: 'c1', walletId: WU, direction: 'OUT', amount: 100, currencyCode: 'USD', party: 'شريك أ',
    category: 'PARTNER_DRAW', note: 'سحب', referenceType: 'PARTNER_DRAW', referenceId: P1, partnerId: P1, valueInStoreCurrency: 100,
    reversalOfId: null, reversalReason: null, createdById: 'u1', createdAt: new Date('2026-11-20T09:00:00Z'), occurredAt: null, ...over,
  };
  tables.walletMovement.push(row);
  return row;
};

beforeEach(async () => {
  vi.clearAllMocks();
  for (const k of Object.keys(tables) as (keyof typeof tables)[]) tables[k] = [] as never;
  writes.count = 0;
  tables.partner.push(
    { id: P1, companyId: 'c1', name: 'شريك أ', isActive: true, sortOrder: 0, sharePercent: 60, createdAt: new Date(0) },
    { id: P2, companyId: 'c1', name: 'شريك ب', isActive: true, sortOrder: 1, sharePercent: 40, createdAt: new Date(0) },
    { id: P3, companyId: 'c2', name: 'شريك شركة تانية', isActive: true, sortOrder: 0, sharePercent: 100, createdAt: new Date(0) },
  );
  tables.country.push({ id: 'US', companyId: 'c1', currencyCode: 'USD', minorUnit: 2 }, { id: 'JO', companyId: 'c1', currencyCode: 'JOD', minorUnit: 3 });
  tables.store.push({ id: 's1', companyId: 'c1', name: 'المتجر الأول', countryId: 'US' }, { id: 's2', companyId: 'c1', name: 'المتجر التاني', countryId: 'US' });
  tables.wallet.push(
    { id: WU, companyId: 'c1', storeId: 's1', countryId: 'US', name: 'صندوق دولار', currencyCode: 'USD', isActive: true, openingBalance: 0, createdAt: new Date(1) },
    { id: WJ, companyId: 'c1', storeId: 's1', countryId: 'JO', name: 'كاش دينار', currencyCode: 'JOD', isActive: true, openingBalance: 0, createdAt: new Date(2) },
    { id: WX, companyId: 'c1', storeId: 's2', countryId: 'US', name: 'صندوق بعيد', currencyCode: 'USD', isActive: true, openingBalance: 0, createdAt: new Date(3) },
  );
  tables.user.push({ id: 'u1', name: 'سارة' });
  await as(await person(HOLDER));
});

const HANDLERS = [
  { name: 'GET', call: (r: Request) => GET(r), body: null as unknown },
  { name: 'POST', call: () => POST(), body: { partnerId: P1, currencyCode: 'USD', amount: '100' } },
  { name: 'PATCH', call: () => PATCH(), body: { withdrawalId: 'w1', reason: 'غلط' } },
  { name: 'PUT', call: (r: Request) => PUT(r), body: { partnerId: P1, amounts: [{ currencyCode: 'USD', amount: '100' }] } },
];

describe.each(HANDLERS)('who opens $name — through the real engine', ({ call, body }) => {
  const drive = async () => {
    const { r, json } = req('X', body);
    const res = await call(r);
    return { status: res.status, json };
  };

  it('the holder of «الشركاء والسحوبات» gets past the gate', async () => {
    expect((await drive()).status).not.toBe(403);
  });

  it('SUPER_ADMIN (roleId null) gets past the gate', async () => {
    await as(await person([], [], { role: 'SUPER_ADMIN', roleId: null } as Partial<SessionUser>));
    expect((await drive()).status).not.toBe(403);
  });

  it('a personal «سماح» on the key over a role without it gets past the gate', async () => {
    await as(await person(['finance.view'], [{ permission: 'finance.partners', effect: 'ALLOW' }]));
    expect((await drive()).status).not.toBe(403);
  });

  it('NEGATIVE: every other money key but this one → 403, the body is never read, nothing written', async () => {
    await as(await person(EVERY_OTHER_MONEY_KEY));
    const { status, json } = await drive();
    expect(status).toBe(403);
    expect(json).not.toHaveBeenCalled();
    expect(writes.count).toBe(0);
  });

  it('NEGATIVE: a personal «منع» beats a role that carries the key', async () => {
    await as(await person(HOLDER, [{ permission: 'finance.partners', effect: 'DENY' }]));
    const { status, json } = await drive();
    expect(status).toBe(403);
    expect(json).not.toHaveBeenCalled();
  });

  it('NEGATIVE: no legacy role with roleId null holds it through the in-code fallback', async () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as UserRole[]) {
      if (role === 'SUPER_ADMIN') continue;
      await as(await person([], [], { role, roleId: null } as Partial<SessionUser>));
      expect((await drive()).status, role).toBe(403);
    }
    expect(writes.count).toBe(0);
  });
});

describe('the old record’s two write doors are RETIRED — marked, not removed', () => {
  it.each(['POST', 'PATCH'] as const)('NEGATIVE: %s → 410 with an Arabic sentence pointing at the wallet; the body is never read; nothing written', async (method) => {
    tables.partnerWithdrawal.push({ id: 'w1', companyId: 'c1', storeId: 's1', partnerId: P1, currencyCode: 'USD', amount: 5, reversalOfId: null, createdById: 'u1', createdAt: new Date() });
    const { r, json } = req(method, { partnerId: P1, currencyCode: 'USD', amount: '100', withdrawalId: 'w1', reason: 'غلط' });
    const res = await (method === 'POST' ? POST() : PATCH());
    const body = await res.json();
    expect(res.status).toBe(410);
    expect(body.code).toBe('WITHDRAWALS_MOVED_TO_WALLET');
    expect(body.errorAr).toMatch(/حركة محفظة/);
    expect(body.error).toBe(body.errorAr);
    expect(json).not.toHaveBeenCalled();
    void r;
    expect(writes.count).toBe(0);
    expect(tables.partnerWithdrawal).toHaveLength(1);
    expect(tables.walletMovement).toHaveLength(0);
  });
});

describe('the dashboard reads the wallet movements', () => {
  it('per partner per WALLET currency, with the store-currency worth; a reversed draw, another kind and the old record are not counted', async () => {
    seeded({ amount: 100, valueInStoreCurrency: 100 });
    seeded({ amount: 50.5, valueInStoreCurrency: 50.5 });
    seeded({ walletId: WJ, currencyCode: 'JOD', amount: 70, valueInStoreCurrency: 98.7 });
    const gone = seeded({ walletId: WJ, currencyCode: 'JOD', amount: 30, valueInStoreCurrency: 42.3 });
    seeded({ id: 'rev', direction: 'IN', reversalOfId: gone.id, reversalReason: 'غلط', walletId: WJ, currencyCode: 'JOD', amount: 30, valueInStoreCurrency: 42.3 });
    seeded({ walletId: WX, amount: 5, valueInStoreCurrency: 5 }); // the other store
    seeded({ category: 'OTHER', partnerId: null, valueInStoreCurrency: null, amount: 999 }); // not a withdrawal
    tables.partnerWithdrawal.push({
      id: 'old', companyId: 'c1', storeId: 's1', partnerId: P1, currencyCode: 'USD', amount: 777, withdrawnOn: new Date('2026-11-22T00:00:00Z'),
      fromStanding: false, note: 'قديم', reversalOfId: null, reversalReason: null, createdById: 'u1', createdAt: new Date('2026-11-22T08:00:00Z'),
    });

    const { status, body } = await book();
    expect(status).toBe(200);
    const p1 = body.totals.filter((t: Row) => t.partnerId === P1).map((t: Row) => [t.currencyCode, t.total, t.valueTotal, t.count]).sort();
    expect(p1).toEqual([['JOD', 70, 98.7, 1], ['USD', 150.5, 150.5, 2]]);
    expect(body.byStore.find((t: Row) => t.storeId === 's2')).toMatchObject({ currencyCode: 'USD', total: 5, storeName: 'المتجر التاني' });
    // The list: this store's originals only, the reversed one says so; the other kind and the reversal row are not withdrawals.
    expect(body.rows.map((r: Row) => r.id).sort()).toEqual(['d1', 'd2', 'd3', 'd4']);
    expect(body.rows.find((r: Row) => r.id === gone.id)).toMatchObject({ wasReversed: true, walletName: 'كاش دينار', partnerName: 'شريك أ' });
    // The old record: listed apart, in no total.
    expect(body.legacy.map((r: Row) => [r.id, r.amount])).toEqual([['old', 777]]);
    expect(body.legacyTotals.map((t: Row) => [t.partnerId, t.currencyCode, t.total])).toEqual([[P1, 'USD', 777]]);
    expect(JSON.stringify(body.totals)).not.toContain('777');
    expect(writes.count).toBe(0);
  });

  it('THE SAME NUMBER AS THE PARTNERS’ STATEMENT: per partner, the store-currency worth the dashboard shows is the statement’s «سحب لحد هلق»', async () => {
    for (let i = 0; i < 25; i++) {
      const jod = i % 3 === 0;
      const m = seeded({
        id: `r${i}`, partnerId: i % 2 ? P1 : P2, referenceId: i % 2 ? P1 : P2, walletId: jod ? WJ : i % 7 === 0 ? WX : WU,
        currencyCode: jod ? 'JOD' : 'USD', amount: 10 + i * 1.5, valueInStoreCurrency: jod ? 14.1 + i : 10 + i * 1.5,
        createdAt: new Date(Date.UTC(2026, 10, 1 + i)),
      });
      if (i % 5 === 0) seeded({ id: `r${i}x`, direction: 'IN', reversalOfId: m.id, amount: m.amount, walletId: m.walletId, currencyCode: m.currencyCode, partnerId: m.partnerId });
    }
    const statement = await partnerStatement({ companyId: 'c1', storeId: 's1', currency: 'USD', minorUnit: 2 });
    const { body } = await book();
    for (const line of statement.lines) {
      const units = body.totals.filter((t: Row) => t.partnerId === line.id).reduce((s: number, t: Row) => s + Math.round(t.valueTotal * 100), 0);
      expect(units / 100, line.name).toBe(line.draws);
    }
    // And by hand, for one partner, from the rows themselves (not from either function): the standing originals of this store.
    const p2 = tables.walletMovement.filter(
      (m) => m.partnerId === P2 && m.category === 'PARTNER_DRAW' && !m.reversalOfId && m.walletId !== WX && !tables.walletMovement.some((x) => x.reversalOfId === m.id)
    );
    expect(statement.lines.find((l) => l.id === P2)!.draws).toBe(Math.round(p2.reduce((s, m) => s + m.valueInStoreCurrency * 100, 0)) / 100);
  });

  it('a span on the real date: a draw typed for an earlier day is in that day’s span, not in its registration’s', async () => {
    seeded({ id: 'a', createdAt: new Date('2026-11-20T09:00:00Z'), occurredAt: new Date('2026-11-05T09:00:00Z'), amount: 11, valueInStoreCurrency: 11 });
    seeded({ id: 'b', createdAt: new Date('2026-11-20T09:00:00Z'), amount: 22, valueInStoreCurrency: 22 });
    const early = (await book('?from=2026-11-01&to=2026-11-10')).body;
    expect(early.rows.map((r: Row) => r.id)).toEqual(['a']);
    expect(early.totals.map((t: Row) => t.total)).toEqual([11]);
    const late = (await book('?from=2026-11-20&to=2026-11-20')).body;
    expect(late.rows.map((r: Row) => r.id)).toEqual(['b']);
  });

  it('NEGATIVE: a span that runs backwards is an Arabic refusal, and nothing is read as a book', async () => {
    const { status, body } = await book('?from=2026-11-10&to=2026-11-01');
    expect(status).toBe(400);
    expect(body.code).toBe('HISTORY_BAD_RANGE');
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
  });

  it('READ-ONLY: the book offers no wallet, no press and no standing figure — nothing on this tab records a withdrawal', async () => {
    await as(await person(CASHIER_PARTNER));
    const { body } = await book();
    expect(Object.keys(body).sort()).toEqual(['byStore', 'currencies', 'legacy', 'legacyTotals', 'partners', 'rows', 'storeCurrency', 'storeId', 'totals']);
  });

  it('`?part=standing` answers the standing amounts alone — an amount per currency, nothing else', async () => {
    tables.partnerStandingAmount.push({ id: 's', companyId: 'c1', partnerId: P1, currencyCode: 'JOD', amount: 50 });
    const { body } = await book('?part=standing');
    expect(body).toEqual({ standing: [{ partnerId: P1, currencyCode: 'JOD', amount: 50 }] });
  });

  it('draws in their own currency (USDT, dinars, lira) with NO store value: each currency on its own, said apart, in no share', async () => {
    seeded({ walletId: WJ, currencyCode: 'JOD', amount: 1000, valueInStoreCurrency: null });
    seeded({ walletId: WJ, currencyCode: 'JOD', amount: 70, valueInStoreCurrency: 98.7 });
    seeded({ amount: 1000, valueInStoreCurrency: 1000 });
    const { body } = await book();
    const jod = body.totals.find((t: Row) => t.currencyCode === 'JOD');
    expect([jod.total, jod.count, jod.valueTotal, jod.valueCount, jod.unvaluedTotal, jod.unvaluedCount]).toEqual([1070, 2, 98.7, 1, 1000, 1]);
    const usd = body.totals.find((t: Row) => t.currencyCode === 'USD');
    expect([usd.total, usd.unvaluedCount]).toEqual([1000, 0]);
    // The statement counts only the draws with a worth; the one without is «uncounted», never added at 1:1.
    const statement = await partnerStatement({ companyId: 'c1', storeId: 's1', currency: 'USD', minorUnit: 2 });
    expect(statement.lines.find((l) => l.id === P1)!.draws).toBe(1098.7);
    expect(statement.uncounted).toBe(1);
  });
});

/*
 * 23/11 (F7) — the standing amounts are back to an AMOUNT per currency, as on osm/main (22/11): the fixed store-currency equivalent of
 * the first F7 draft (columns storeValue / storeCurrencyCode) is dropped with its migration — «بدون ما يجيني سعر الصرف» (the owner).
 */
describe('the standing amounts — an amount per currency', () => {
  it('saved once per currency, changed in place, and an empty box clears one', async () => {
    await send('PUT', { partnerId: P1, amounts: [{ currencyCode: 'USD', amount: '100' }, { currencyCode: 'JOD', amount: '70' }] });
    await send('PUT', { partnerId: P1, amounts: [{ currencyCode: 'USD', amount: '120' }, { currencyCode: 'JOD', amount: '' }] });
    expect(tables.partnerStandingAmount.map((s) => [s.currencyCode, Number(s.amount)])).toEqual([['USD', 120]]);
    expect(tables.walletMovement).toHaveLength(0);
  });

  it('NEGATIVE: a store value sent beside an amount is not kept — there is no such column', async () => {
    await send('PUT', { partnerId: P1, amounts: [{ currencyCode: 'JOD', amount: '50', storeValue: '70.5' }] });
    expect(Object.keys(tables.partnerStandingAmount[0])).not.toContain('storeValue');
  });

  it.each([
    ['zero', [{ currencyCode: 'USD', amount: '0' }], 'AMOUNT_NOT_POSITIVE'],
    ['unknown currency', [{ currencyCode: 'EUR', amount: '5' }], 'UNKNOWN_CURRENCY'],
    ['one currency twice', [{ currencyCode: 'USD', amount: '5' }, { currencyCode: 'usd', amount: '6' }], 'CURRENCY_TWICE'],
    ['not a list', 'USD', 'INVALID_AMOUNTS'],
  ])('NEGATIVE: %s → refused in Arabic, nothing saved', async (_n, amounts, code) => {
    const res = await send('PUT', { partnerId: P1, amounts });
    expect(res.body.code).toBe(code);
    expect(res.body.errorAr).toMatch(/[؀-ۿ]/);
    expect(tables.partnerStandingAmount).toHaveLength(0);
  });

  it('NEGATIVE: another company’s partner → PARTNER_NOT_FOUND, nothing saved', async () => {
    expect((await send('PUT', { partnerId: P3, amounts: [{ currencyCode: 'USD', amount: '5' }] })).body.code).toBe('PARTNER_NOT_FOUND');
    expect(tables.partnerStandingAmount).toHaveLength(0);
  });
});

describe('THE DRAW IS WRITTEN AT THE WALLET — the draws door, its rules unchanged but one', () => {
  beforeEach(async () => {
    await as(await person(CASHIER_PARTNER));
  });

  it('writes ONE OUT movement of PARTNER_DRAW with the partner and the worth, through `recordMovement`; no old-record row, no expense', async () => {
    const res = await drawOf({ walletId: WJ, partnerId: P1, amount: '50', valueInStoreCurrency: '70.5' });
    expect(res.status).toBe(201);
    expect(tables.walletMovement).toHaveLength(1);
    expect(tables.walletMovement[0]).toMatchObject({
      walletId: WJ, direction: 'OUT', category: 'PARTNER_DRAW', partnerId: P1, amount: 50, valueInStoreCurrency: 70.5, currencyCode: 'JOD',
    });
    expect(tables.partnerWithdrawal).toHaveLength(0);
    expect(tables.expense).toHaveLength(0);
    expect((await book()).body.totals).toEqual([expect.objectContaining({ partnerId: P1, currencyCode: 'JOD', total: 50, valueTotal: 70.5 })]);
  });

  it('THE ONE CHANGE: a foreign-currency draw without «ما يعادله» is written in its own currency with NO store value (was STORE_VALUE_REQUIRED)', async () => {
    const res = await drawOf({ walletId: WJ, partnerId: P1, amount: '1000' });
    expect(res.status).toBe(201);
    expect(tables.walletMovement[0]).toMatchObject({ currencyCode: 'JOD', amount: 1000, category: 'PARTNER_DRAW', partnerId: P1 });
    expect(tables.walletMovement[0].valueInStoreCurrency ?? null).toBeNull();
    // Counted in no share: the statement's draws for him stay at zero, and it says one draw is uncounted.
    const statement = await partnerStatement({ companyId: 'c1', storeId: 's1', currency: 'USD', minorUnit: 2 });
    expect(statement.lines.find((l) => l.id === P1)!.draws).toBe(0);
    expect(statement.uncounted).toBe(1);
  });

  it('NEGATIVE: «الشركاء والسحوبات» without the cash box’s key — a clear refusal, the body unread, NOTHING written', async () => {
    await as(await person(HOLDER));
    const { r, json } = req('POST', { walletId: WU, partnerId: P1, amount: '10' }, 'http://x/api/finance/partners/draws');
    const res = await DRAW(r);
    expect(res.status).toBe(403);
    expect(json).not.toHaveBeenCalled();
    expect(writes.count).toBe(0);
  });

  it('NEGATIVE: a wallet of ANOTHER store (no wallet access) → 404, nothing written', async () => {
    const res = await drawOf({ walletId: WX, partnerId: P1, amount: '10' });
    expect(res.status).toBe(404);
    expect(tables.walletMovement).toHaveLength(0);
  });

  it('NEGATIVE: the bounds are unchanged — a typed equivalent with too many decimals, or a zero one, is refused; so is an amount past the wallet’s decimals', async () => {
    expect((await drawOf({ walletId: WJ, partnerId: P1, amount: '50', valueInStoreCurrency: '70.505' })).body.code).toBe('VALUE_DECIMALS');
    expect((await drawOf({ walletId: WJ, partnerId: P1, amount: '50', valueInStoreCurrency: '0' })).status).toBe(400);
    expect((await drawOf({ walletId: WU, partnerId: P1, amount: '1.001' })).body.code).toBe('AMOUNT_DECIMALS');
    expect((await drawOf({ walletId: WU, partnerId: P1, amount: '10', valueInStoreCurrency: '11' })).body.code).toBe('VALUE_NOT_ALLOWED');
    expect(tables.walletMovement).toHaveLength(0);
  });

  it('NEGATIVE: another category still refuses a store value, and «مصروف» still needs its reference — the relaxation is PARTNER_DRAW’s only', async () => {
    await expect(
      recordMovement(db as never, { companyId: 'c1', walletId: WU, direction: 'OUT', amount: 5, party: 'x', category: 'OTHER', note: 'x', valueInStoreCurrency: 5, createdById: 'u1' })
    ).rejects.toThrow(/Only a partner draw/);
    await expect(
      recordMovement(db as never, { companyId: 'c1', walletId: WU, direction: 'OUT', amount: 5, party: 'x', category: 'EXPENSE', note: 'x', createdById: 'u1' })
    ).rejects.toThrow(/reference/);
    expect(tables.walletMovement).toHaveLength(0);
  });

  it('NEGATIVE: the standing amount is never taken behind the person’s back — no amount sent is a refusal, even with a standing row', async () => {
    tables.partnerStandingAmount.push({ id: 's', companyId: 'c1', partnerId: P1, currencyCode: 'USD', amount: 250 });
    const res = await drawOf({ walletId: WU, partnerId: P1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DRAW');
    expect(tables.walletMovement).toHaveLength(0);
  });

  it('NEGATIVE: taken back twice — the wallet’s reversal writes once, the second is refused, and the dashboard counts it nowhere', async () => {
    await drawOf({ walletId: WU, partnerId: P1, amount: '10' });
    const id = tables.walletMovement[0].id;
    await reverseMovement(db as never, { companyId: 'c1', walletId: WU, movementId: id, reason: 'غلط', createdById: 'u1', mayReversePartnerDraw: true });
    await expect(
      reverseMovement(db as never, { companyId: 'c1', walletId: WU, movementId: id, reason: 'مرة تانية', createdById: 'u1', mayReversePartnerDraw: true })
    ).rejects.toThrow(/already reversed/);
    expect(tables.walletMovement.filter((m) => m.reversalOfId === id)).toHaveLength(1);
    const { body } = await book();
    expect(body.totals).toEqual([]);
    expect(body.rows).toEqual([expect.objectContaining({ id, wasReversed: true })]);
  });

  it('NEGATIVE: the reversal of a draw asks the partners’ key — the wallet’s own rule, unchanged', async () => {
    await drawOf({ walletId: WU, partnerId: P1, amount: '10' });
    await expect(
      reverseMovement(db as never, { companyId: 'c1', walletId: WU, movementId: tables.walletMovement[0].id, reason: 'غلط', createdById: 'u1' })
    ).rejects.toThrow(/الشركاء والسحوبات/);
    expect(tables.walletMovement).toHaveLength(1);
  });
});
