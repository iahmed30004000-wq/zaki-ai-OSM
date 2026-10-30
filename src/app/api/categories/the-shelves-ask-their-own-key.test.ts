import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SHELVES ASK THEIR OWN KEY (perm-plan PR-11, D1m).
 *
 * The categories’ writes asked `products.edit` and never read its scope. They ask `categories.manage` now; reading the list
 * keeps the three keys it always took (categories.view · roles.edit · users.edit) and adds the new one — whoever may name the
 * shelves must see them. REAL engine over grants attached to the session user; the database is a recording fake.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { session, db, writes } = vi.hoisted(() => {
  const writes: string[] = [];
  return {
    writes,
    session: { user: null as unknown },
    db: {
      category: {
        findMany: vi.fn(async (): Promise<unknown[]> => [{ id: 'cat1', name: 'عطور', nameEn: null }]),
        findFirst: vi.fn(async (): Promise<unknown> => null),
        create: vi.fn(async () => { writes.push('create'); return { id: 'cat-new', name: 'جديد', nameEn: null }; }),
        update: vi.fn(async () => { writes.push('update'); return { id: 'cat1', name: 'جديد', nameEn: null }; }),
        delete: vi.fn(async () => { writes.push('delete'); }),
      },
    },
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => session.user),
  requireCompanyTenant: vi.fn(async () => ({ companyId: 'c1' })),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));

import { GET, POST, PATCH, DELETE } from './route';

const person = (grants: Record<string, { scope: string }>, over: Record<string, unknown> = {}) => ({
  id: 'u1', role: 'MODERATOR', status: 'ACTIVE', companyId: 'c1', effectiveGrants: { fullAccess: false, grants }, ...over,
});
const A = { scope: 'ALL_COMPANY' };

const post = () => POST(new Request('http://x/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'جديد' }) }));
const patch = () => PATCH(new Request('http://x/api/categories?id=cat1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'جديد' }) }));
const del = () => DELETE(new Request('http://x/api/categories?id=cat1', { method: 'DELETE' }));

beforeEach(() => {
  writes.length = 0;
  db.category.findFirst.mockImplementation(async () => null);
});

const WRITES: Array<[string, () => Promise<Response>]> = [['create', post], ['rename', patch], ['delete', del]];

describe('the three writes ask categories.manage — and the product edit, at any scope, no longer opens them', () => {
  for (const [name, call] of WRITES) {
    it(`${name}: a company-wide product editor without the shelves’ key is refused, in Arabic, and nothing is written`, async () => {
      session.user = person({ 'products.view': A, 'products.edit': A });
      const res = await call();
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Forbidden: missing categories.manage');
      expect(body.errorAr).toContain('إدارة التصنيفات');
      expect(writes).toEqual([]);
    });

    it(`${name}: NEGATIVE — a product editor scoped to a CATEGORY (the D1m leak) is refused even if he holds the view`, async () => {
      session.user = person({ 'products.view': { scope: 'CATEGORY' }, 'products.edit': { scope: 'CATEGORY' } });
      expect((await call()).status).toBe(403);
      expect(writes).toEqual([]);
    });

    it(`${name}: a person with only the reading key is refused`, async () => {
      session.user = person({ 'categories.view': A });
      expect((await call()).status).toBe(403);
      expect(writes).toEqual([]);
    });
  }

  it('and the holder of the key gets through all three (the rename and the delete find their row)', async () => {
    session.user = person({ 'products.view': A, 'categories.manage': A });
    expect((await post()).status).toBe(201);
    db.category.findFirst.mockImplementation(async () => ({ id: 'cat1', name: 'عطور', _count: { products: 0 } }));
    expect((await patch()).status).toBe(200);
    expect((await del()).status).toBe(200);
    expect(writes).toEqual(['create', 'update', 'delete']);
  });

  it('SUPER_ADMIN passes (the engine’s rule), a suspended holder does not', async () => {
    session.user = { id: 'root', role: 'SUPER_ADMIN', status: 'ACTIVE', companyId: null, effectiveGrants: { fullAccess: true, grants: {} } };
    expect((await post()).status).toBe(201);
    writes.length = 0;
    session.user = person({ 'categories.manage': A }, { status: 'SUSPENDED' });
    expect((await post()).status).toBe(403);
    expect(writes).toEqual([]);
  });
});

describe('reading the list: the three old keys still open it, and so does the new one; the product edit alone does not', () => {
  const reads: Array<[string, Record<string, { scope: string }>, number]> = [
    ['categories.view', { 'categories.view': A }, 200],
    ['roles.edit (the scope picker of a role)', { 'roles.edit': A }, 200],
    ['users.edit (the scope picker of a person)', { 'users.edit': A }, 200],
    ['categories.manage (whoever names the shelves must see them)', { 'categories.manage': A }, 200],
    ['products.edit alone', { 'products.view': A, 'products.edit': A }, 403],
    ['products.view alone', { 'products.view': A }, 403],
    ['nothing', {}, 403],
  ];
  for (const [name, grants, status] of reads) {
    it(`${name} → ${status}`, async () => {
      session.user = person(grants);
      expect((await GET()).status).toBe(status);
    });
  }
});
