import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «بسعر اليوم» (23/11, F8) — THE DRAWS DOOR FILLS «ما يعادله» FROM TODAY'S RATE WHEN IT IS LEFT EMPTY, driven through the real POST.
 *
 * The real chain runs: the rates row and the company's typed rates (in memory) → `equivalentOf` → the real `recordMovement` inside the
 * real transaction function. What is held: the figure and the rate, its kind, its source and its date are written together and
 * frozen; a typed figure wins and carries no rate; no rate → the draw is still written, with no value, and the answer says why; the
 * pound is never converted without the owner's rate; USDT is not 1; a later rate leaves an old draw as it was; the network is never reached.
 */

type Row = Record<string, any>;

const { db, tx, tables, store, current, requireContext, logAudit } = vi.hoisted(() => {
  const tables = { wallet: [] as Row[], partner: [] as Row[], walletMovement: [] as Row[] };
  const store = { auto: undefined as unknown, manual: {} as Row };
  let seq = 0;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    wallet: { findFirst: vi.fn(async ({ where }: { where: Row }) => tables.wallet.find((w) => w.id === where.id && w.companyId === where.companyId && w.isActive) ?? null) },
    walletMovement: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `m${++seq}`, createdAt: new Date(), ...data };
        tables.walletMovement.push(row);
        return row;
      }),
    },
  };
  const db = {
    wallet: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const w = tables.wallet.find((x) => x.id === where.id && x.companyId === where.companyId && x.storeId === where.storeId);
        return w ? { ...w, country: { minorUnit: w.minor } } : null;
      }),
    },
    partner: { findFirst: vi.fn(async ({ where }: { where: Row }) => tables.partner.find((p) => p.id === where.id && p.companyId === where.companyId) ?? null) },
    company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify({ exchangeRates: { rates: store.manual } }) })) },
    $transaction: vi.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { db, tx, tables, store, current: { keys: [] as string[] }, requireContext: vi.fn(), logAudit: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/system-settings', () => ({ readSystemSetting: async () => store.auto, updateSystemSetting: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/wallets', async (orig) => ({ ...(await orig<typeof import('@/lib/wallets')>()), walletBalance: vi.fn(async () => ({ balance: 0 })) }));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => current.keys.includes(k),
  requirePermission: async (k: string) => {
    if (!current.keys.includes(k)) throw new Error(`Forbidden: missing required permission ${k}`);
  },
}));

import { POST } from './route';

const W_USD = '11111111-1111-4111-8111-111111111111';
const W_JOD = '22222222-2222-4222-8222-222222222222';
const W_SYP = '33333333-3333-4333-8333-333333333333';
const W_USDT = '44444444-4444-4444-8444-444444444444';
const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const post = async (body: Row) => {
  const res = await POST(new Request('http://localhost/api/finance/partners/draws', { method: 'POST', body: JSON.stringify({ partnerId: P, ...body }) }));
  return { status: res.status, body: await res.json() };
};
const last = () => tables.walletMovement.at(-1)!;
const iso = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const AUTO = () => ({
  attemptedAt: iso(1),
  fiat: { source: 'open.er-api.com', asOf: iso(2), fetchedAt: iso(1), perUsd: { JOD: 0.709, SYP: 13002 } },
  usdt: { source: 'api.kraken.com', asOf: iso(1), fetchedAt: iso(1), usdPerUnit: 0.998 },
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const t of Object.values(tables)) t.length = 0;
  store.auto = AUTO();
  store.manual = {};
  current.keys = ['finance.view', 'finance.partners', 'finance.cashbox'];
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'أحمد' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } });
  tables.wallet.push(
    { id: W_USD, companyId: 'c1', storeId: 's1', name: 'الصندوق', currencyCode: 'USD', minor: 2, isActive: true },
    { id: W_JOD, companyId: 'c1', storeId: 's1', name: 'صندوق الدينار', currencyCode: 'JOD', minor: 3, isActive: true },
    { id: W_SYP, companyId: 'c1', storeId: 's1', name: 'صندوق الليرة', currencyCode: 'SYP', minor: 2, isActive: true },
    { id: W_USDT, companyId: 'c1', storeId: 's1', name: 'محفظة USDT', currencyCode: 'USDT', minor: 2, isActive: true },
  );
  tables.partner.push({ id: P, companyId: 'c1', name: 'شريك د', sharePercent: 55, isActive: true });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the network was reached'); }));
});

describe('left empty → filled from today’s rate, with the rate frozen beside it', () => {
  it('100 JOD at 0.709 JOD a dollar → 141.04 $, rate 1/0.709, AUTO, its source, its date', async () => {
    const { status, body } = await post({ walletId: W_JOD, amount: 100 });
    expect(status).toBe(201);
    const m = last();
    expect(m.valueInStoreCurrency).toBe(141.04);
    expect(m.equivalentRate).toBeCloseTo(1 / 0.709, 10);
    expect(m.equivalentRateKind).toBe('AUTO');
    expect(m.equivalentRateSource).toBe('open.er-api.com');
    expect(m.equivalentRateAt).toEqual(new Date((store.auto as Row).fiat.asOf));
    expect(body.equivalent).toMatchObject({ value: 141.04, noRate: null, filled: { kind: 'AUTO' } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('USDT is not 1: 500 USDT at 0.998 $ a coin → 499.00', async () => {
    await post({ walletId: W_USDT, amount: 500 });
    expect(last()).toMatchObject({ valueInStoreCurrency: 499, equivalentRateKind: 'AUTO', equivalentRateSource: 'api.kraken.com' });
    expect(last().equivalentRate).toBeCloseTo(0.998, 10);
  });

  it('the owner’s pound rate: 1,300,000 SYP at 13,000 → 100.00 $, MANUAL', async () => {
    store.manual = { SYP: { perUsd: 13000, at: iso(48) } };
    await post({ walletId: W_SYP, amount: 1_300_000 });
    expect(last()).toMatchObject({ valueInStoreCurrency: 100, equivalentRateKind: 'MANUAL' });
  });

  it('the manual override wins over the automatic rate', async () => {
    store.manual = { JOD: { perUsd: 0.5, at: iso(1) } };
    await post({ walletId: W_JOD, amount: 100 });
    expect(last()).toMatchObject({ valueInStoreCurrency: 200, equivalentRateKind: 'MANUAL' });
  });
});

describe('the person’s figure, and no figure', () => {
  it('a typed figure wins over today’s rate and carries NO rate', async () => {
    await post({ walletId: W_JOD, amount: 100, valueInStoreCurrency: 150 });
    const m = last();
    expect(m.valueInStoreCurrency).toBe(150);
    for (const k of ['equivalentRate', 'equivalentRateKind', 'equivalentRateSource', 'equivalentRateAt']) expect(m, k).not.toHaveProperty(k);
  });

  it('NEGATIVE: SYP with no typed rate is NEVER converted — even though the source listed it; the draw is still written, and the answer says why', async () => {
    const { status, body } = await post({ walletId: W_SYP, amount: 1_300_000 });
    expect(status).toBe(201);
    expect(last().valueInStoreCurrency).toBeUndefined();
    expect(last()).not.toHaveProperty('equivalentRate');
    expect(body.equivalent).toEqual({ value: null, filled: null, noRate: 'ما في سعر — اكتب سعر الليرة بالإعدادات' });
  });

  it('NEGATIVE: a USDT price never fetched → no figure (never 1:1), and the save still succeeds', async () => {
    store.auto = { ...AUTO(), usdt: undefined };
    const { status, body } = await post({ walletId: W_USDT, amount: 500 });
    expect(status).toBe(201);
    expect(last().valueInStoreCurrency).toBeUndefined();
    expect(body.equivalent.noRate).toBe('ما في سعر — اكتب سعر USDT بالإعدادات');
  });

  it('NEGATIVE: no rates row at all (the job never ran) → no figure, saved', async () => {
    store.auto = undefined;
    expect((await post({ walletId: W_JOD, amount: 100 })).status).toBe(201);
    expect(last().valueInStoreCurrency).toBeUndefined();
  });

  it('a stale rate (older than three days) is still used — the last good value', async () => {
    store.auto = { ...AUTO(), fiat: { ...AUTO().fiat, asOf: iso(24 * 5) } };
    await post({ walletId: W_JOD, amount: 100 });
    expect(last().valueInStoreCurrency).toBe(141.04);
  });

  it('the store’s own currency: the amount, as always, and no rate is written (byte for byte as before)', async () => {
    await post({ walletId: W_USD, amount: 100 });
    expect(last().valueInStoreCurrency).toBe(100);
    expect(last()).not.toHaveProperty('equivalentRate');
  });
});

describe('frozen at write time', () => {
  it('an old draw is unchanged after the rate changes; the new draw takes the new rate', async () => {
    await post({ walletId: W_JOD, amount: 100 });
    const first = { ...last() };
    store.manual = { JOD: { perUsd: 0.8, at: iso(0) } };
    await post({ walletId: W_JOD, amount: 100 });
    expect(tables.walletMovement[0]).toEqual(first);
    expect(last()).toMatchObject({ valueInStoreCurrency: 125, equivalentRateKind: 'MANUAL' });
    // Nothing but `create` touched the movements: no update path exists to rewrite the old row.
    expect(Object.keys(tx.walletMovement).sort()).toEqual(['create', 'findFirst']);
  });

  it('the audit row carries the rate it was filled at', async () => {
    await post({ walletId: W_JOD, amount: 100 });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PARTNER_DRAW_RECORDED', newData: expect.objectContaining({ valueInStoreCurrency: 141.04, rateKind: 'AUTO' }) }));
  });
});
