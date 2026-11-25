import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/stock-transfers.memory-db.test';

/**
 * THE PAIR DOORS (W7a) — GET/POST /api/inventory/pairs and DELETE /api/inventory/pairs/:id.
 *
 * People are built the way a session builds them: `computeEffectiveGrants` over role rows, personal overrides (ALLOW
 * and DENY) and a roleId-null legacy account (the system template it inherits), and the REAL `can` decides the key.
 * Reach is the real store-entry rule (`geo-context.reachesStore`) over the country and store rows of the in-memory
 * database (`stock-transfers.memory-db.test.ts`), which judges every `where` itself and answers the pairs' three unique
 * keys with P2002 as PostgreSQL does.
 */

const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  storeId: 's1',
  m: null as unknown as { db: Record<string, unknown>; data: Record<string, Row[]> },
  rolePerms: {} as Record<string, string[]>,
  overrides: {} as Record<string, { permission: string; effect: 'ALLOW' | 'DENY' }[]>,
  audit: [] as Row[],
}));

vi.mock('@/lib/db', () => {
  const extra: Row = {
    rolePermission: {
      findMany: async ({ where }: Row) =>
        (where.roleId ? S.rolePerms[where.roleId] ?? [] : S.rolePerms[`template:${where.role?.name}`] ?? []).map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
    },
    userPermission: { findMany: async ({ where }: Row) => (S.overrides[where.userId] ?? []).map((o) => ({ ...o, scope: 'ALL_COMPANY', scopeIds: null })) },
  };
  const db = new Proxy({} as Row, {
    get: (_t, prop: string) => (prop in extra ? extra[prop] : (S.m.db as Row)[prop]),
  });
  return { db };
});
vi.mock('@/lib/geo-context', async (orig) => {
  const real = await orig<typeof import('@/lib/geo-context')>();
  return { ...real, requireContext: async () => ({ user: S.current, companyId: (S.current as Row).companyId, storeId: S.storeId }) };
});
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(S.current, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return S.current;
    },
  };
});
vi.mock('@/lib/auth', async (orig) => {
  const real = await orig<typeof import('@/lib/auth')>();
  return { ...real, requireCompanyTenant: async () => ({ user: S.current, companyId: (S.current as Row).companyId }) };
});
vi.mock('@/lib/audit', () => ({ logAudit: async (e: Row) => void S.audit.push(e) }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { memoryDb } from '@/lib/stock-transfers.memory-db.test';
import * as list from './route';
import { DELETE as removeDoor } from './[id]/route';

const C1 = 'c1';

async function as(id: string, storeId = 's1') {
  const u = S.m.data.user.find((x) => x.id === id)!;
  S.storeId = storeId;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const save = (productId: string, otherProductId: string) =>
  list.POST(new Request('http://x/api/inventory/pairs', { method: 'POST', body: JSON.stringify({ productId, otherProductId }) })).then(json);
const read = (other?: string) => list.GET(new Request(`http://x/api/inventory/pairs${other ? `?otherStoreId=${other}` : ''}`)).then(json);
const remove = (id: string) => removeDoor(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id }) }).then(json);

beforeEach(() => {
  S.audit = [];
  S.rolePerms = {
    'r-sender': ['inventory.view', 'inventory.transfer'],
    'r-viewer': ['inventory.view'],
    'r-products': ['products.view', 'products.edit', 'inventory.view', 'inventory.adjust'],
    // The system template a roleId-null WAREHOUSE account inherits: today's keeper keys, not the transfer key.
    'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
  };
  S.overrides = {
    'u-plus': [{ permission: 'inventory.transfer', effect: 'ALLOW' }],
    'u-sender-denied': [{ permission: 'inventory.transfer', effect: 'DENY' }],
  };
  const people = [
    ['u-owner', 'SUPER_ADMIN', null],
    ['u-sender', 'CUSTOM', 'r-sender'],
    ['u-viewer', 'CUSTOM', 'r-viewer'],
    ['u-products', 'CUSTOM', 'r-products'],
    ['u-plus', 'CUSTOM', 'r-viewer'],
    ['u-sender-denied', 'CUSTOM', 'r-sender'],
    ['u-legacy-wh', 'WAREHOUSE', null],
    ['u-confined', 'CUSTOM', 'r-sender'],
    ['u-other-co', 'CUSTOM', 'r-sender'],
  ] as const;
  S.m = memoryDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true },
      { id: 'k2', companyId: C1, isActive: true },
      { id: 'k3', companyId: C1, isActive: false },
      { id: 'k9', companyId: 'c2', isActive: true },
    ],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
      { id: 's3', companyId: C1, countryId: 'k2', name: 'متجر البلد التاني' },
      { id: 's4', companyId: C1, countryId: 'k3', name: 'متجر بلد موقوف' },
      { id: 's9', companyId: 'c2', countryId: 'k9', name: 'متجر شركة تانية' },
    ],
    user: people.map(([id, role, roleId]) => ({ id, name: id, role, roleId, status: 'ACTIVE', companyId: id === 'u-other-co' ? 'c2' : C1 })),
    userCountryAccess: people
      .filter(([id]) => id !== 'u-owner')
      .flatMap(([userId]): Row[] => (userId === 'u-other-co' ? [{ userId, countryId: 'k9' }] : ['k1', 'k2', 'k3'].map((countryId) => ({ userId, countryId })))),
    // Confined to the one store she stands in: she reaches no other.
    userStoreAccess: [{ userId: 'u-confined', storeId: 's1' }],
    product: [
      { id: 'p1', companyId: C1, storeId: 's1', name: 'كريم الوجه', nameEn: null, sku: 'ABC-1' },
      { id: 'p1b', companyId: C1, storeId: 's1', name: 'صوبة القدس ٤ شعلات', nameEn: null, sku: 'X' },
      { id: 'p1c', companyId: C1, storeId: 's1', name: 'شامبو', nameEn: null, sku: 'SH1' },
      { id: 'p1d', companyId: C1, storeId: 's1', name: 'ما إله شبيه', nameEn: null, sku: 'ONLY' },
      { id: 'p2', companyId: C1, storeId: 's2', name: 'اسم تاني', nameEn: null, sku: 'abc-1 ' },
      { id: 'p2b', companyId: C1, storeId: 's2', name: 'صوبة القدس 4 شعلات', nameEn: null, sku: 'Y' },
      { id: 'p2c', companyId: C1, storeId: 's2', name: 'شامبو', nameEn: null, sku: 'Z1' },
      { id: 'p2d', companyId: C1, storeId: 's2', name: 'شامبو', nameEn: null, sku: 'Z2' },
      { id: 'p3', companyId: C1, storeId: 's3', name: 'كريم', nameEn: null, sku: 'ABC-1' },
      { id: 'p4', companyId: C1, storeId: 's4', name: 'كريم', nameEn: null, sku: 'ABC-1' },
      { id: 'p0', companyId: C1, storeId: null, name: 'بلا متجر', nameEn: null, sku: 'ABC-1' },
      { id: 'p9', companyId: 'c2', storeId: 's9', name: 'كريم', nameEn: null, sku: 'ABC-1' },
    ],
  });
});

describe('who may use the pair doors — the transfer key, as a session computes it', () => {
  it('the sender, the owner, and a viewer given the key by a personal ALLOW', async () => {
    for (const [who, other] of [
      ['u-sender', 'p2'],
      ['u-owner', 'p3'],
    ] as const) {
      await as(who);
      expect((await save('p1', other)).status, who).toBe(201);
    }
    await as('u-plus');
    expect((await save('p1b', 'p2b')).status).toBe(201);
  });

  it('NEGATIVE: the inventory viewer, the product editor, the legacy keeper and a sender with a personal DENY are refused', async () => {
    for (const who of ['u-viewer', 'u-products', 'u-legacy-wh', 'u-sender-denied']) {
      await as(who);
      expect((await save('p1', 'p2')).status, who).toBe(403);
      expect((await read('s2')).status, who).toBe(403);
      expect((await remove('anything')).status, who).toBe(403);
    }
    expect(S.m.data.productPair).toEqual([]);
  });
});

describe('the proposals', () => {
  it('the other stores she reaches, and the proposals for ONE of them: the same sku first, then the same name', async () => {
    await as('u-sender');
    const { status, body } = await read('s2');
    expect(status).toBe(200);
    // Not the store she stands in, not a store of a stopped country, not another company's.
    expect(body.stores.map((s: Row) => s.id).sort()).toEqual(['s2', 's3']);
    expect(body.proposals.map((x: Row) => [x.product.id, x.hint, x.candidates.map((c: Row) => c.id), x.sure])).toEqual([
      ['p1', 'SKU', ['p2'], true],
      ['p1c', 'NAME', ['p2c', 'p2d'], false],
      ['p1b', 'NAME', ['p2b'], true],
    ]);
    expect(body.proposals[0]).toMatchObject({ hintAr: 'نفس الرمز', product: { name: 'كريم الوجه', sku: 'ABC-1' } });
    expect(body.pairs).toEqual([]);
  });

  it('without another store named: the stores and the pairs, no proposals', async () => {
    await as('u-sender');
    // 21/11 (W7c): and no list of the other store's products either.
    expect((await read()).body).toMatchObject({ proposals: null, pairs: [], otherProducts: null });
  });

  it('21/11 (W7c): for ONE other store named, its products not paired yet — the twin picker offers them; a paired one leaves', async () => {
    await as('u-sender');
    expect((await read('s2')).body.otherProducts.map((p: Row) => p.id).sort()).toEqual(['p2', 'p2b', 'p2c', 'p2d']);
    await save('p1', 'p2');
    const after = (await read('s2')).body.otherProducts;
    // NEGATIVE: the twin already taken is not offered again, and nothing of another store, company or no store is.
    expect(after.map((p: Row) => p.id).sort()).toEqual(['p2b', 'p2c', 'p2d']);
    expect(after[0]).toEqual({ id: expect.any(String), name: expect.any(String), sku: expect.any(String) });
    expect((await read('s3')).body.otherProducts.map((p: Row) => p.id)).toEqual(['p3']);
  });

  it('NEGATIVE: a store she does not reach, of another company, or her own, has no proposals', async () => {
    await as('u-confined');
    expect((await read('s2')).body).toMatchObject({ code: 'STORE_NOT_FOUND' });
    expect((await read()).body.stores).toEqual([]);
    await as('u-sender');
    for (const s of ['s9', 's4', 's1']) {
      const r = await read(s);
      expect(r.status, s).toBe(404);
      expect(r.body.errorAr, s).toMatch(/[؀-ۿ]/);
    }
  });

  it('a saved pair leaves the proposals on both sides, and shows in the pairs of both stores', async () => {
    await as('u-sender');
    await save('p1', 'p2');
    const here = (await read('s2')).body;
    expect(here.proposals.map((x: Row) => x.product.id)).not.toContain('p1');
    expect(here.pairs).toEqual([expect.objectContaining({ hint: 'SKU', product: expect.objectContaining({ id: 'p1' }), otherProduct: expect.objectContaining({ id: 'p2' }), otherStore: { id: 's2', name: 'متجر تاني' } })]);
    await as('u-sender', 's2');
    const there = (await read('s1')).body;
    expect(there.proposals.flatMap((x: Row) => x.candidates.map((c: Row) => c.id))).not.toContain('p1');
    expect(there.pairs[0]).toMatchObject({ product: { id: 'p2' }, otherProduct: { id: 'p1' }, otherStore: { id: 's1' } });
  });
});

describe('saving a pair', () => {
  it('one row, in one direction, with the hint read by the server — and the same couple again from either store is a replay', async () => {
    await as('u-sender', 's2');
    const first = await save('p2', 'p1');
    expect(first.status).toBe(201);
    expect(S.m.data.productPair).toEqual([
      expect.objectContaining({ companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 'p2', storeBId: 's2', hint: 'SKU', createdById: 'u-sender' }),
    ]);
    expect(S.audit).toEqual([expect.objectContaining({ action: 'PRODUCT_PAIR_SAVED', entity: 'ProductPair', entityId: first.body.pair.id })]);
    await as('u-sender', 's1');
    const again = await save('p1', 'p2');
    expect(again).toMatchObject({ status: 200, body: { replay: true, pair: { id: first.body.pair.id, productId: 'p1', otherProductId: 'p2' } } });
    expect(S.m.data.productPair).toHaveLength(1);
    expect(S.audit).toHaveLength(1);
  });

  it('one twin per other store: a second store is fine, a second twin in the same store is refused from either side', async () => {
    await as('u-sender');
    expect((await save('p1', 'p2')).status).toBe(201);
    expect((await save('p1', 'p3')).status).toBe(201);
    expect((await save('p1', 'p2b')).body).toMatchObject({ code: 'MINE_ALREADY_PAIRED', otherProductId: 'p2' });
    expect((await save('p1b', 'p2')).body).toMatchObject({ code: 'OTHER_ALREADY_PAIRED', productId: 'p1' });
    expect(S.m.data.productPair).toHaveLength(2);
  });

  it('a name chosen by hand with no hint is saved with none', async () => {
    await as('u-sender');
    expect((await save('p1d', 'p2c')).body.pair).toMatchObject({ hint: null });
  });

  it('NEGATIVE: one store, another company, no store, a product of another store standing here, an unreached store — refused in Arabic', async () => {
    await as('u-sender');
    const cases: [string, string, number, string][] = [
      ['p1', 'p1c', 409, 'SAME_STORE'],
      ['p1', 'p9', 404, 'OTHER_NOT_FOUND'],
      ['p1', 'p0', 404, 'OTHER_NOT_FOUND'],
      ['p1', 'p4', 404, 'OTHER_NOT_FOUND'],
      ['p2', 'p1', 404, 'PRODUCT_NOT_FOUND'],
      ['p1', 'nope', 404, 'OTHER_NOT_FOUND'],
    ];
    for (const [a, b, status, code] of cases) {
      const r = await save(a, b);
      expect([r.status, r.body.code], `${a}→${b}`).toEqual([status, code]);
      expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
    }
    await as('u-confined');
    expect((await save('p1', 'p2')).body).toMatchObject({ code: 'OTHER_NOT_FOUND' });
    await as('u-other-co');
    S.storeId = 's9';
    expect((await save('p9', 'p1')).body).toMatchObject({ code: 'OTHER_NOT_FOUND' });
    expect(S.m.data.productPair).toEqual([]);
  });

  it('NEGATIVE: a body that does not parse is refused in Arabic', async () => {
    await as('u-sender');
    for (const body of [null, {}, { productId: 'p1' }, { productId: '', otherProductId: 'p2' }]) {
      const r = await list.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) })).then(json);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: 'INVALID' });
      expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
    }
  });

  it('two presses at one moment: the database refuses the second, and asked again it is a replay', async () => {
    await as('u-sender');
    const root = S.m.db as Row;
    const real = root.$transaction;
    let once = true;
    root.$transaction = async (fn: unknown, opts: unknown) => {
      if (once) {
        once = false;
        // The other press committed first; this one's insert met the unique key and its transaction rolled back whole.
        S.m.data.productPair.push({ id: 'twin', companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 'p2', storeBId: 's2', hint: 'SKU', createdById: 'u-other', createdAt: new Date() });
        throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'memory' });
      }
      return real(fn, opts);
    };
    expect(await save('p1', 'p2')).toMatchObject({ status: 200, body: { replay: true, pair: { id: 'twin' } } });
    expect(S.m.data.productPair).toHaveLength(1);
    expect(S.audit).toEqual([]);
  });
});

describe('removing a pair', () => {
  it('from either store; the row goes and the audit keeps who removed which', async () => {
    await as('u-sender');
    const id = (await save('p1', 'p2')).body.pair.id;
    await as('u-sender', 's2');
    expect(await remove(id)).toEqual({ status: 200, body: { removed: { id } } });
    expect(S.m.data.productPair).toEqual([]);
    expect(S.audit.at(-1)).toMatchObject({ action: 'PRODUCT_PAIR_REMOVED', entityId: id, previousData: { productId: 'p2', otherProductId: 'p1', otherStoreId: 's1' } });
    // Gone: a second press is «not found».
    expect((await remove(id)).body).toMatchObject({ code: 'PAIR_NOT_FOUND' });
  });

  it('NEGATIVE: from a third store, by a person who does not reach the other store, or of another company — not found, and it stays', async () => {
    await as('u-sender');
    const id = (await save('p1', 'p2')).body.pair.id;
    await as('u-sender', 's3');
    expect((await remove(id)).status).toBe(404);
    await as('u-confined');
    expect((await remove(id)).body).toMatchObject({ code: 'PAIR_NOT_FOUND' });
    await as('u-other-co');
    S.storeId = 's9';
    expect((await remove(id)).status).toBe(404);
    expect(S.m.data.productPair).toHaveLength(1);
  });
});
