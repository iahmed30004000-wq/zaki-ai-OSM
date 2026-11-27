import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * «شكل القطعة» — THE DOOR (27/11): `products.view` reads, `products.edit` writes, this store's product only; one key of
 * the company's settings; a value nobody offers is refused. People are built by the real permission engine.
 */

const { db, current, settings, logAudit } = vi.hoisted(() => ({
  db: { product: { findFirst: vi.fn() }, company: { findUnique: vi.fn() } },
  current: { user: null as unknown as SessionUser },
  settings: { doc: {} as Record<string, unknown> },
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: current.user, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (_c: string, key: string, change: (cur: unknown) => unknown) => {
    const next = change(settings.doc[key]);
    if (next === undefined) delete settings.doc[key];
    else settings.doc[key] = next;
    return next;
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
import { GET, PUT } from './route';

let n = 0;
async function as(keys: string[]) {
  const base = { id: `u${++n}`, email: 'u@x', name: 'موظف', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  current.user = attachGrants(base, await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  }));
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id = 'p1') => GET(new Request('http://x'), ctx(id));
const put = (body: unknown, id = 'p1') =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), ctx(id));

beforeEach(() => {
  vi.clearAllMocks();
  settings.doc = { ai: { keep: true } };
  db.product.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === 'p1' || where.id === 'p2' ? { id: where.id, companyId: 'c1', storeId: 's1', categoryId: null } : null
  );
  db.company.findUnique.mockImplementation(async () => ({ settings: JSON.stringify(settings.doc) }));
});

describe('who may do what', () => {
  it('«products.view» reads and may not write', async () => {
    await as(['products.view']);
    expect(await (await get()).json()).toEqual({ shape: null });
    expect((await put({ shape: 'jar' })).status).toBe(403);
    expect(settings.doc.productShapes).toBeUndefined();
  });

  it('NEGATIVE: with neither key nothing is read or written', async () => {
    await as(['orders.view']);
    expect((await get()).status).toBe(403);
    expect((await put({ shape: 'jar' })).status).toBe(403);
    expect(db.product.findFirst).not.toHaveBeenCalled();
  });

  it('the product is looked for inside this store; another store’s is «not found», and nothing is written', async () => {
    await as(['products.view', 'products.edit']);
    expect((await put({ shape: 'jar' }, 'elsewhere')).status).toBe(404);
    expect((await get('elsewhere')).status).toBe(404);
    expect(db.product.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'elsewhere', companyId: 'c1', storeId: 's1' });
    expect(settings.doc.productShapes).toBeUndefined();
  });
});

describe('the choice', () => {
  it('is saved for that product alone, read back, audited, and cleared with null — the other settings untouched', async () => {
    await as(['products.view', 'products.edit']);
    expect((await put({ shape: 'jar' })).status).toBe(200);
    await put({ shape: 'shoe' }, 'p2');
    expect(settings.doc).toEqual({ ai: { keep: true }, productShapes: { p1: 'jar', p2: 'shoe' } });
    expect(await (await get()).json()).toEqual({ shape: 'jar' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_SHAPE_SET', entityId: 'p1', previousData: { shape: null }, newData: { shape: 'jar' } }));
    await put({ shape: null });
    await put({ shape: null }, 'p2');
    expect(settings.doc).toEqual({ ai: { keep: true } });
  });

  it('the same choice again writes no second audit row', async () => {
    await as(['products.edit']);
    await put({ shape: 'box' });
    await put({ shape: 'box' });
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it.each([{ shape: 'rocket' }, { shape: '' }, {}, { shape: 'jar', price: 1 }, null])('NEGATIVE: %j is refused in Arabic', async (body) => {
    await as(['products.edit']);
    const res = await put(body);
    expect(res.status).toBe(400);
    expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
    expect(settings.doc.productShapes).toBeUndefined();
  });
});
