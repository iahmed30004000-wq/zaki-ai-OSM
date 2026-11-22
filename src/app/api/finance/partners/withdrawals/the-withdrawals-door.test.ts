import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/types/auth';
import { ROLE_PERMISSIONS, type UserRole } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «المسحوبات» (22/11) — THE DOOR, DRIVEN WITH PEOPLE BUILT THE WAY A SESSION BUILDS THEM, ON AN IN-MEMORY LEDGER.
 *
 * Who: `finance.partners` («الشركاء والسحوبات») opens all four handlers — through the REAL engine (`computeEffectiveGrants`: role rows,
 * a personal «منع» and «سماح», a roleId-null legacy account), and nobody who holds every other money key gets in.
 * What: one press records the standing amount, a typed figure wins for that press, refusals in Arabic with a code, a second press of
 * the same thing is one row, a cancel is a reversing row and only once, and the totals keep each currency to itself.
 * ═══════════════════════════════════════════════════════════════════════
 */

type W = {
  id: string; companyId: string; storeId: string; partnerId: string; currencyCode: string; amount: number; withdrawnOn: Date;
  fromStanding: boolean; note: string | null; reversalOfId: string | null; reversalReason: string | null; createdById: string; createdAt: Date;
};
type S = { id: string; companyId: string; partnerId: string; currencyCode: string; amount: number; updatedById: string };

const { state, db, requireContext, logAudit, current } = vi.hoisted(() => {
  const state = {
    partners: [] as { id: string; companyId: string; name: string; isActive: boolean; sortOrder: number; createdAt: Date }[],
    standing: [] as S[],
    rows: [] as W[],
    seq: 0,
    raceOnCreate: false,
    writes: 0,
  };
  const matches = (r: W, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'reversedBy') return v === null ? !state.rows.some((x) => x.reversalOfId === r.id) : true;
      if (k === 'createdAt') return r.createdAt.getTime() >= (v as { gte: Date }).gte.getTime();
      if (k === 'withdrawnOn') return r.withdrawnOn.getTime() === (v as Date).getTime();
      if (k === 'storeId' && v && typeof v === 'object') return (v as { in: string[] }).in.includes(r.storeId);
      if (k === 'amount') return Number(r.amount) === Number(v);
      return (r as unknown as Record<string, unknown>)[k] === v;
    });
  const withRev = (r: W) => ({ ...r, reversedBy: state.rows.find((x) => x.reversalOfId === r.id) ? { id: 'x' } : null });
  const db = {
    partner: {
      findFirst: async ({ where }: { where: { id: string; companyId: string } }) =>
        state.partners.find((p) => p.id === where.id && p.companyId === where.companyId) ?? null,
      findMany: async ({ where }: { where: { companyId: string } }) => state.partners.filter((p) => p.companyId === where.companyId),
    },
    country: { findMany: async () => [{ currencyCode: 'JOD', minorUnit: 3 }, { currencyCode: 'USD', minorUnit: 2 }] },
    wallet: { findMany: async () => [{ currencyCode: 'SYP', country: { minorUnit: 2 } }] },
    store: { findMany: async () => [{ id: 's1', name: 'المتجر الأول' }, { id: 's2', name: 'المتجر التاني' }] },
    user: { findMany: async () => [{ id: 'u1', name: 'سارة' }] },
    partnerStandingAmount: {
      findMany: async ({ where }: { where: { companyId: string } }) => state.standing.filter((s) => s.companyId === where.companyId),
      findUnique: async ({ where }: { where: { partnerId_currencyCode: { partnerId: string; currencyCode: string } } }) =>
        state.standing.find((s) => s.partnerId === where.partnerId_currencyCode.partnerId && s.currencyCode === where.partnerId_currencyCode.currencyCode) ?? null,
      deleteMany: async ({ where }: { where: { partnerId: string; currencyCode: { in: string[] } } }) => {
        state.standing = state.standing.filter((s) => !(s.partnerId === where.partnerId && where.currencyCode.in.includes(s.currencyCode)));
      },
      upsert: async ({ where, create, update }: { where: { partnerId_currencyCode: { partnerId: string; currencyCode: string } }; create: Omit<S, 'id'>; update: Partial<S> }) => {
        const k = where.partnerId_currencyCode;
        const found = state.standing.find((s) => s.partnerId === k.partnerId && s.currencyCode === k.currencyCode);
        if (found) Object.assign(found, update);
        else state.standing.push({ id: `st${++state.seq}`, ...create });
      },
    },
    partnerWithdrawal: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        state.rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const r = state.rows.find((x) => matches(x, where));
        return r ? withRev(r) : null;
      },
      create: async ({ data }: { data: Partial<W> }) => {
        if (state.raceOnCreate && data.reversalOfId) {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        }
        if (data.reversalOfId && state.rows.some((x) => x.reversalOfId === data.reversalOfId)) {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        }
        const row: W = {
          id: `w${++state.seq}`, note: null, reversalOfId: null, reversalReason: null, fromStanding: false,
          createdAt: new Date(Date.now() + state.seq), ...(data as W), amount: Number(data.amount),
        };
        state.rows.push(row);
        state.writes += 1;
        return { id: row.id };
      },
    },
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return {
    state,
    db,
    requireContext: vi.fn(),
    logAudit: vi.fn(),
    current: { user: null as unknown as SessionUser },
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: (...a: unknown[]) => requireContext(...a),
  geoReach: async () => null,
}));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { PERMISSION_MODULES } from '@/lib/permission-catalog';
import { GET, PATCH, POST, PUT } from './route';

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
async function as(u: SessionUser) {
  current.user = u;
  requireContext.mockResolvedValue({ user: u, companyId: 'c1', storeId: 's1', country: { currencyCode: 'JOD', minorUnit: 3 } });
}
const HOLDER = ['finance.view', 'finance.partners'];
const EVERY_OTHER_MONEY_KEY = PERMISSION_MODULES.filter((m) => m.module === 'finance' || m.module === 'settlement')
  .flatMap((m) => m.items.map((i) => i.key))
  .filter((k) => k !== 'finance.partners');

/** A request whose body is a spy: a door that read it before asking the key would be caught. */
function req(method: string, body: unknown) {
  const json = vi.fn(async () => body);
  return { r: { method, json } as unknown as Request, json };
}
const send = async (method: 'POST' | 'PATCH' | 'PUT', body: unknown) => {
  const h = { POST, PATCH, PUT }[method];
  const res = await h(req(method, body).r);
  return { status: res.status, body: await res.json() };
};

beforeEach(async () => {
  vi.clearAllMocks();
  state.partners = [
    { id: 'p1', companyId: 'c1', name: 'شريك أ', isActive: true, sortOrder: 0, createdAt: new Date(0) },
    { id: 'p2', companyId: 'c1', name: 'شريك ب', isActive: true, sortOrder: 1, createdAt: new Date(0) },
    { id: 'p3', companyId: 'c1', name: 'شريك موقوف', isActive: false, sortOrder: 2, createdAt: new Date(0) },
    { id: 'px', companyId: 'c2', name: 'شريك شركة تانية', isActive: true, sortOrder: 0, createdAt: new Date(0) },
  ];
  state.standing = [];
  state.rows = [];
  state.raceOnCreate = false;
  state.writes = 0;
  await as(await person(HOLDER));
});

const HANDLERS = [
  { name: 'GET', call: () => GET(), body: null as unknown },
  { name: 'POST', call: (r: Request) => POST(r), body: { partnerId: 'p1', currencyCode: 'USD', amount: '100' } },
  { name: 'PATCH', call: (r: Request) => PATCH(r), body: { withdrawalId: 'w1', reason: 'غلط' } },
  { name: 'PUT', call: (r: Request) => PUT(r), body: { partnerId: 'p1', amounts: [{ currencyCode: 'USD', amount: '100' }] } },
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
    expect(state.writes).toBe(0);
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
    expect(state.writes).toBe(0);
  });
});

describe('«سجّل مسحوب» — one press', () => {
  it('with no amount sent, the standing amount is recorded, marked as from it', async () => {
    expect((await send('PUT', { partnerId: 'p1', amounts: [{ currencyCode: 'USD', amount: '250' }, { currencyCode: 'SYP', amount: '' }] })).status).toBe(200);
    const res = await send('POST', { partnerId: 'p1', currencyCode: 'USD', withdrawnOn: '2026-11-22' });
    expect(res.status).toBe(201);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ partnerId: 'p1', storeId: 's1', currencyCode: 'USD', amount: 250, fromStanding: true });
    expect(state.rows[0].withdrawnOn.toISOString().slice(0, 10)).toBe('2026-11-22');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PARTNER_WITHDRAWAL_RECORDED', entity: 'PartnerWithdrawal' }));
  });

  it('a figure changed for this press wins, and is not «from the standing amount»; the standing amount is unchanged', async () => {
    await send('PUT', { partnerId: 'p1', amounts: [{ currencyCode: 'USD', amount: '250' }] });
    expect((await send('POST', { partnerId: 'p1', currencyCode: 'USD', amount: '300', withdrawnOn: '2026-11-22' })).status).toBe(201);
    expect(state.rows[0]).toMatchObject({ amount: 300, fromStanding: false });
    expect(state.standing[0].amount).toBe(250);
  });

  it('a free-typed amount with no standing amount at all', async () => {
    expect((await send('POST', { partnerId: 'p2', currencyCode: 'JOD', amount: '12.345', withdrawnOn: '2026-11-21' })).status).toBe(201);
    expect(state.rows[0]).toMatchObject({ currencyCode: 'JOD', amount: 12.345, fromStanding: false });
  });

  const refusals: [string, Record<string, unknown>, string][] = [
    ['missing amount and no standing amount', { partnerId: 'p1', currencyCode: 'USD' }, 'AMOUNT_REQUIRED'],
    ['zero', { partnerId: 'p1', currencyCode: 'USD', amount: '0' }, 'AMOUNT_NOT_POSITIVE'],
    ['negative', { partnerId: 'p1', currencyCode: 'USD', amount: -5 }, 'AMOUNT_NOT_POSITIVE'],
    ['not a number', { partnerId: 'p1', currencyCode: 'USD', amount: '5abc' }, 'AMOUNT_NOT_A_NUMBER'],
    ['too many decimals', { partnerId: 'p1', currencyCode: 'USD', amount: '1.001' }, 'AMOUNT_DECIMALS'],
    ['unknown currency', { partnerId: 'p1', currencyCode: 'EUR', amount: '5' }, 'UNKNOWN_CURRENCY'],
    ['no currency', { partnerId: 'p1', amount: '5' }, 'UNKNOWN_CURRENCY'],
    ['no partner', { currencyCode: 'USD', amount: '5' }, 'PARTNER_REQUIRED'],
    ['another company’s partner', { partnerId: 'px', currencyCode: 'USD', amount: '5' }, 'PARTNER_NOT_FOUND'],
    ['a stopped partner', { partnerId: 'p3', currencyCode: 'USD', amount: '5' }, 'PARTNER_STOPPED'],
    ['a day in the future', { partnerId: 'p1', currencyCode: 'USD', amount: '5', withdrawnOn: '2999-01-01' }, 'DAY_IN_FUTURE'],
    ['not a day', { partnerId: 'p1', currencyCode: 'USD', amount: '5', withdrawnOn: 'امبارح' }, 'INVALID_DAY'],
  ];
  it.each(refusals)('NEGATIVE: %s → refused in Arabic, nothing written', async (_n, body, code) => {
    const res = await send('POST', body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.code).toBe(code);
    expect(res.body.errorAr).toMatch(/[؀-ۿ]/);
    expect(res.body.error).toBe(res.body.errorAr);
    expect(state.rows).toHaveLength(0);
  });

  it('NEGATIVE: a body that is not an object → INVALID_BODY', async () => {
    expect((await send('POST', [1, 2])).body.code).toBe('INVALID_BODY');
    expect((await send('POST', null)).body.code).toBe('INVALID_BODY');
  });

  it('NEGATIVE: the same press twice is ONE row (DUPLICATE_WITHDRAWAL)', async () => {
    const body = { partnerId: 'p1', currencyCode: 'USD', amount: '100', withdrawnOn: '2026-11-22' };
    expect((await send('POST', body)).status).toBe(201);
    const second = await send('POST', body);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('DUPLICATE_WITHDRAWAL');
    expect(state.rows).toHaveLength(1);
    // A different amount is a different withdrawal.
    expect((await send('POST', { ...body, amount: '101' })).status).toBe(201);
    expect(state.rows).toHaveLength(2);
  });
});

describe('«إلغاء» — a reversing row, once', () => {
  const recordOne = async () => {
    await send('POST', { partnerId: 'p1', currencyCode: 'USD', amount: '100', withdrawnOn: '2026-11-22' });
    return state.rows[0].id;
  };

  it('writes a second row pointing at the original, with the reason; the original is untouched', async () => {
    const id = await recordOne();
    const before = { ...state.rows[0] };
    const res = await send('PATCH', { withdrawalId: id, reason: 'انسجّل بالغلط' });
    expect(res.status).toBe(200);
    expect(state.rows).toHaveLength(2);
    expect(state.rows[1]).toMatchObject({ reversalOfId: id, reversalReason: 'انسجّل بالغلط', amount: 100, currencyCode: 'USD', partnerId: 'p1' });
    expect(state.rows[0]).toEqual(before);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PARTNER_WITHDRAWAL_CANCELLED', entityId: id }));
  });

  it('NEGATIVE: cancel twice → ALREADY_CANCELLED, still two rows', async () => {
    const id = await recordOne();
    await send('PATCH', { withdrawalId: id, reason: 'انسجّل بالغلط' });
    const again = await send('PATCH', { withdrawalId: id, reason: 'مرة تانية' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_CANCELLED');
    expect(state.rows).toHaveLength(2);
  });

  it('NEGATIVE: two cancels at the same instant — the database’s unique key answers ALREADY_CANCELLED', async () => {
    const id = await recordOne();
    state.raceOnCreate = true;
    const res = await send('PATCH', { withdrawalId: id, reason: 'سباق' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_CANCELLED');
  });

  it('NEGATIVE: a cancel row is not cancelled (IS_A_CANCEL)', async () => {
    const id = await recordOne();
    await send('PATCH', { withdrawalId: id, reason: 'انسجّل بالغلط' });
    const res = await send('PATCH', { withdrawalId: state.rows[1].id, reason: 'رجّعه' });
    expect(res.body.code).toBe('IS_A_CANCEL');
    expect(state.rows).toHaveLength(2);
  });

  it('NEGATIVE: no reason → REASON_REQUIRED; another store’s row → WITHDRAWAL_NOT_FOUND', async () => {
    const id = await recordOne();
    expect((await send('PATCH', { withdrawalId: id, reason: ' ' })).body.code).toBe('REASON_REQUIRED');
    state.rows[0].storeId = 's2';
    expect((await send('PATCH', { withdrawalId: id, reason: 'انسجّل بالغلط' })).body.code).toBe('WITHDRAWAL_NOT_FOUND');
    expect(state.rows).toHaveLength(1);
  });
});

describe('the standing amounts', () => {
  it('saved once per currency, changed in place, and an empty box clears one', async () => {
    await send('PUT', { partnerId: 'p1', amounts: [{ currencyCode: 'USD', amount: '100' }, { currencyCode: 'JOD', amount: '70' }] });
    await send('PUT', { partnerId: 'p1', amounts: [{ currencyCode: 'USD', amount: '120' }, { currencyCode: 'JOD', amount: '' }] });
    expect(state.standing.map((s) => [s.currencyCode, s.amount])).toEqual([['USD', 120]]);
  });

  it.each([
    ['zero', [{ currencyCode: 'USD', amount: '0' }], 'AMOUNT_NOT_POSITIVE'],
    ['unknown currency', [{ currencyCode: 'EUR', amount: '5' }], 'UNKNOWN_CURRENCY'],
    ['one currency twice', [{ currencyCode: 'USD', amount: '5' }, { currencyCode: 'usd', amount: '6' }], 'CURRENCY_TWICE'],
    ['not a list', 'USD', 'INVALID_AMOUNTS'],
  ])('NEGATIVE: %s → refused, nothing saved', async (_n, amounts, code) => {
    const res = await send('PUT', { partnerId: 'p1', amounts });
    expect(res.body.code).toBe(code);
    expect(state.standing).toHaveLength(0);
  });
});

describe('the book — totals per currency, never across', () => {
  it('a partner with dollars and dinars has two lines, and the cancelled one is not in them', async () => {
    await send('POST', { partnerId: 'p1', currencyCode: 'USD', amount: '100', withdrawnOn: '2026-11-20' });
    await send('POST', { partnerId: 'p1', currencyCode: 'USD', amount: '50.5', withdrawnOn: '2026-11-21' });
    await send('POST', { partnerId: 'p1', currencyCode: 'JOD', amount: '70', withdrawnOn: '2026-11-21' });
    await send('POST', { partnerId: 'p1', currencyCode: 'JOD', amount: '30', withdrawnOn: '2026-11-22' });
    const jod30 = state.rows.find((r) => r.amount === 30)!.id;
    await send('PATCH', { withdrawalId: jod30, reason: 'غلط' });
    state.rows.push({ ...state.rows[0], id: 'other-store', storeId: 's2', amount: 5 });

    const book = await (await GET()).json();
    const p1 = book.totals.filter((t: { partnerId: string }) => t.partnerId === 'p1');
    expect(p1.map((t: { currencyCode: string; total: number }) => [t.currencyCode, t.total]).sort()).toEqual([['JOD', 70], ['USD', 150.5]]);
    // The other store is in «كل المتاجر», not in this store's totals.
    expect(book.byStore.find((t: { storeId: string }) => t.storeId === 's2')).toMatchObject({ currencyCode: 'USD', total: 5, storeName: 'المتجر التاني' });
    // The list: originals only, the cancelled one says so with its reason.
    expect(book.rows).toHaveLength(4);
    expect(book.rows.find((r: { id: string }) => r.id === jod30).cancelled.reason).toBe('غلط');
    expect(book.currencies.map((c: { code: string }) => c.code)).toEqual(['JOD', 'SYP', 'USD']);
  });
});
