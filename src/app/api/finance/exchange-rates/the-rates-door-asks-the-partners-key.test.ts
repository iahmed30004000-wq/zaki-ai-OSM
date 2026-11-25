import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * «أسعار الصرف» (23/11, F8) — THE DOOR, DRIVEN WITH PEOPLE BUILT THE WAY A SESSION BUILDS THEM.
 *
 * Who: `finance.partners` («الشركاء والسحوبات») opens both handlers, through the REAL engine (`computeEffectiveGrants`: role rows,
 * a personal «سماح» and «منع», a roleId-null legacy account); a holder of every other money key is refused before the body is read.
 * What: the rows say the rule of each currency (USD fixed, SYP «اكتب السعر» until typed, USDT and JOD automatic with their source,
 * the owner's rate wins), the dollar cannot be typed, a bad rate is refused in Arabic, and the door never goes to the network.
 */

const { state, requireContext, logAudit, current } = vi.hoisted(() => ({
  state: { auto: undefined as unknown, manual: {} as Record<string, { perUsd: number; at: string; byId?: string }>, writes: 0 },
  requireContext: vi.fn(),
  logAudit: vi.fn(),
  current: { user: null as unknown as SessionUser },
}));

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a), geoReach: async () => null }));
vi.mock('@/lib/exchange-rates', () => ({
  companyCurrencyCodes: async () => ['JOD', 'SYP', 'USD', 'USDT', 'XYZ'],
  readRateTable: async () => ({ auto: state.auto, manual: { rates: { ...state.manual } } }),
  saveManualRates: async (_c: string, changes: { code: string; perUsd: number | null }[], by: string) => {
    state.writes += 1;
    for (const ch of changes) {
      if (ch.perUsd === null) delete state.manual[ch.code];
      else state.manual[ch.code] = { perUsd: ch.perUsd, at: new Date().toISOString(), byId: by };
    }
    return { rates: { ...state.manual } };
  },
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
import { GET, PUT } from './route';

async function person(roleKeys: string[], overrides: { permission: string; effect: 'DENY' | 'ALLOW' }[] = [], base: Partial<SessionUser> = {}) {
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
  requireContext.mockResolvedValue({ user: u, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } });
}
const HOLDER = ['finance.view', 'finance.partners'];
const EVERY_OTHER_MONEY_KEY = PERMISSION_MODULES.filter((m) => m.module === 'finance' || m.module === 'settlement')
  .flatMap((m) => m.items.map((i) => i.key))
  .filter((k) => k !== 'finance.partners');

function req(body: unknown) {
  const json = vi.fn(async () => body);
  return { r: { method: 'PUT', json } as unknown as Request, json };
}
const put = async (body: unknown) => {
  const res = await PUT(req(body).r);
  return { status: res.status, body: await res.json() };
};
const get = async () => {
  const res = await GET();
  return { status: res.status, body: await res.json() };
};

const NOW_ISO = new Date().toISOString();
beforeEach(async () => {
  vi.clearAllMocks();
  state.writes = 0;
  state.manual = {};
  state.auto = {
    attemptedAt: NOW_ISO,
    fiat: { source: 'open.er-api.com', asOf: NOW_ISO, fetchedAt: NOW_ISO, perUsd: { JOD: 0.709 } },
    usdt: { source: 'api.kraken.com', asOf: NOW_ISO, fetchedAt: NOW_ISO, usdPerUnit: 0.998 },
  };
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the network was reached'); }));
  await as(await person(HOLDER));
});

describe.each([
  { name: 'GET', call: () => GET(), body: null as unknown },
  { name: 'PUT', call: (r: Request) => PUT(r), body: { rates: [{ code: 'SYP', perUsd: '13000' }] } },
])('who opens $name — through the real engine', ({ call, body }) => {
  const drive = async () => {
    const { r, json } = req(body);
    const res = await call(r);
    return { status: res.status, json };
  };

  it('the holder of «الشركاء والسحوبات» gets in', async () => {
    expect((await drive()).status).toBe(200);
  });
  it('SUPER_ADMIN (roleId null, the legacy account) gets in', async () => {
    await as(await person([], [], { role: 'SUPER_ADMIN', roleId: null } as Partial<SessionUser>));
    expect((await drive()).status).toBe(200);
  });
  it('a personal «سماح» on the key over a role without it gets in', async () => {
    await as(await person(['finance.view'], [{ permission: 'finance.partners', effect: 'ALLOW' }]));
    expect((await drive()).status).toBe(200);
  });
  it('NEGATIVE: every other money key but this one → 403, the body is never read, nothing written', async () => {
    await as(await person(EVERY_OTHER_MONEY_KEY));
    const { status, json } = await drive();
    expect(status).toBe(403);
    expect(json).not.toHaveBeenCalled();
    expect(state.writes).toBe(0);
  });
  it('NEGATIVE: a personal «منع» on the key over a role that has it → 403', async () => {
    await as(await person(HOLDER, [{ permission: 'finance.partners', effect: 'DENY' }]));
    expect((await drive()).status).toBe(403);
  });
});

describe('what the rows say', () => {
  it('USD fixed · JOD automatic with its source · USDT automatic and not 1 · SYP and an unknown code «اكتب السعر»', async () => {
    const { body } = await get();
    const row = (c: string) => body.rows.find((r: { code: string }) => r.code === c);
    expect(row('USD').effective).toMatchObject({ perUsd: 1, kind: 'FIXED' });
    expect(row('JOD').effective).toMatchObject({ perUsd: 0.709, kind: 'AUTO', source: 'open.er-api.com' });
    expect(row('USDT').effective.kind).toBe('AUTO');
    expect(row('USDT').effective.perUsd).not.toBe(1);
    for (const c of ['SYP', 'XYZ']) {
      expect(row(c).effective, c).toBeNull();
      expect(row(c).ownerOnly, c).toBe(true);
    }
    expect(row('SYP').missingSentence).toBe('ما في سعر — اكتب سعر الليرة بالإعدادات');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('a typed rate wins, and the automatic one is still shown beside it', async () => {
    const { body } = await put({ rates: [{ code: 'jod', perUsd: '0.71' }, { code: 'SYP', perUsd: '13000' }] });
    const row = (c: string) => body.rows.find((r: { code: string }) => r.code === c);
    expect(row('JOD').effective).toMatchObject({ perUsd: 0.71, kind: 'MANUAL' });
    expect(row('JOD').auto).toMatchObject({ perUsd: 0.709, kind: 'AUTO' });
    expect(row('SYP').effective).toMatchObject({ perUsd: 13000, kind: 'MANUAL' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXCHANGE_RATES_SAVED', entityId: 'c1' }));
  });

  it('a null takes a typed rate back: JOD returns to automatic, SYP to «اكتب السعر»', async () => {
    state.manual = { JOD: { perUsd: 0.71, at: NOW_ISO }, SYP: { perUsd: 13000, at: NOW_ISO } };
    const { body } = await put({ rates: [{ code: 'JOD', perUsd: null }, { code: 'SYP', perUsd: null }] });
    const row = (c: string) => body.rows.find((r: { code: string }) => r.code === c);
    expect(row('JOD').effective.kind).toBe('AUTO');
    expect(row('SYP').effective).toBeNull();
  });

  it('NEGATIVE: the dollar cannot be typed; zero, a word or a hex string is refused in Arabic — nothing written', async () => {
    const usd = await put({ rates: [{ code: 'USD', perUsd: '2' }] });
    expect(usd).toMatchObject({ status: 400, body: { code: 'USD_IS_ONE' } });
    for (const bad of ['0', 'abc', '0x10', '-5', '']) {
      const r = await put({ rates: [{ code: 'SYP', perUsd: bad }] });
      expect(r.status, bad).toBe(400);
      expect(r.body.code, bad).toBe('INVALID_RATES');
      expect(r.body.error, bad).toMatch(/[؀-ۿ]/);
    }
    expect(state.writes).toBe(0);
  });
});
