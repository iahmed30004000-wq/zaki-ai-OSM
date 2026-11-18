import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SWITCH «منصّة تجريب» — the doors that write it and the sentences that refuse it (B1, 18/11).
 *
 * `Store.isTest` and its CHECK (`stores_test_bench_is_not_public`: a bench is never open to visitors) were in
 * production with NOTHING in the app able to write the column. These are the guards of the door that now does:
 *
 *   · create and update write `isTest`, the list reads it back, and the permission is the one that edits a store;
 *   · the answer to «a bench on an open storefront» (and the reverse) is a plain Arabic sentence from the door —
 *     the database CHECK is only the last line, and when it does fire the same sentence is what comes back;
 *   · the company's ONLY real store cannot become a bench;
 *   · nothing else about the save changed (a store that is not touched by the switch saves exactly as before).
 */

const { db, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    store: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn(), count: vi.fn() },
    country: { findFirst: vi.fn(), findMany: vi.fn() },
    storePage: { createMany: vi.fn() },
    landingPage: { findFirst: vi.fn() },
    product: { count: vi.fn() },
    $transaction: vi.fn(),
  },
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: async () => ({ user: { id: 'u1' }, companyId: 'c1' }) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/geo-context', () => ({ geoReach: async () => null, standingStoreId: async () => null }));
vi.mock('@/lib/landing-domain', () => ({ validateDomain: (d: string) => ({ ok: true, domain: d }), forgetHost: vi.fn(), dashboardHosts: () => [] }));

import { PATCH, DELETE } from './[id]/route';
import { GET, POST } from './route';
import { GET as COUNTRIES } from '../countries/route';
import {
  BENCH_CHECK_NAME,
  BENCH_STORE_CANNOT_OPEN_AR,
  BENCH_STORE_IS_OPEN_AR,
  LAST_REAL_STORE_AR,
  isBenchCheckViolation,
} from '@/lib/test-store';

const ID = '11111111-1111-4111-8111-111111111111';
const COUNTRY = '22222222-2222-4222-8222-222222222222';
const patch = (body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: ID }) });
const post = (body: unknown) => POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }));

let before: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  requirePermission.mockResolvedValue(undefined);
  before = {
    id: ID, companyId: 'c1', slug: 'mine', type: 'MULTI_PRODUCT', status: 'ACTIVE', name: 'متجر',
    storefrontEnabled: false, landingPageId: null, domain: null, isTest: false,
  };
  db.store.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (where.id === ID ? before : null));
  db.store.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...before, ...data }));
  db.store.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data }));
  // Another real store exists unless a test says otherwise.
  db.store.count.mockResolvedValue(1);
  db.product.count.mockResolvedValue(2);
  db.landingPage.findFirst.mockResolvedValue(null);
  db.country.findFirst.mockResolvedValue({ id: COUNTRY });
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
});

describe('the door writes the mark', () => {
  it('UPDATE writes isTest and says so in the audit row (before and after)', async () => {
    const res = await patch({ isTest: true });
    expect(res.status).toBe(200);
    expect(db.store.update.mock.calls[0][0].data).toEqual({ isTest: true });
    const row = logAudit.mock.calls[0][0];
    expect(row.action).toBe('STORE_UPDATED');
    expect(row.previousData.isTest).toBe(false);
    expect(row.newData.isTest).toBe(true);
  });

  it('UPDATE can take the mark off again', async () => {
    before.isTest = true;
    expect((await patch({ isTest: false })).status).toBe(200);
    expect(db.store.update.mock.calls[0][0].data).toEqual({ isTest: false });
    // Taking it off is never a question about «the last real store».
    expect(db.store.count).not.toHaveBeenCalled();
  });

  it('CREATE writes isTest: true when asked, and false when not', async () => {
    const body = { countryId: COUNTRY, name: 'منصة', slug: 'bench-1' };
    expect((await post({ ...body, isTest: true })).status).toBe(201);
    expect(db.store.create.mock.calls[0][0].data.isTest).toBe(true);
    expect((await post({ ...body, slug: 'shop-2' })).status).toBe(201);
    expect(db.store.create.mock.calls[1][0].data.isTest).toBe(false);
  });

  it('the schema takes a boolean and nothing else', async () => {
    expect((await patch({ isTest: 'yes' })).status).toBe(400);
    expect((await patch({ isTest: 1 })).status).toBe(400);
    expect((await post({ countryId: COUNTRY, name: 'x1', slug: 'x-1', isTest: 'true' })).status).toBe(400);
    expect(db.store.update).not.toHaveBeenCalled();
    expect(db.store.create).not.toHaveBeenCalled();
  });

  it('the LIST reads it back (the row is returned whole, not picked)', async () => {
    db.store.findMany.mockResolvedValue([{ id: ID, isTest: true }]);
    const res = await GET(new Request('http://localhost/x'));
    expect((await res.json()).stores[0].isTest).toBe(true);
    expect(db.store.findMany.mock.calls[0][0].select).toBeUndefined();
  });

  it('the COUNTRIES list — the one the settings screen draws — carries the mark and the store’s order count', async () => {
    db.country.findMany.mockResolvedValue([]);
    await COUNTRIES();
    const select = db.country.findMany.mock.calls[0][0].include.stores.select;
    expect(select.isTest).toBe(true);
    expect(select._count).toEqual({ select: { orders: true } });
  });

  it('needs the permission that edits a store — and no other', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission geo.manage'));
    expect((await patch({ isTest: true })).status).toBe(403);
    expect((await post({ countryId: COUNTRY, name: 'x1', slug: 'x-1', isTest: true })).status).toBe(403);
    expect(db.store.update).not.toHaveBeenCalled();
    expect(db.store.create).not.toHaveBeenCalled();
    requirePermission.mockResolvedValue(undefined);
    await patch({ isTest: true });
    expect(requirePermission.mock.calls.at(-1)).toEqual(['geo.manage']);
  });
});

describe('a bench is never open to visitors — said by the door, in words', () => {
  it('marking an OPEN store is refused with the sentence, and nothing is written', async () => {
    before.storefrontEnabled = true;
    const res = await patch({ isTest: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(BENCH_STORE_IS_OPEN_AR);
    expect(BENCH_STORE_IS_OPEN_AR).toContain('سكّر واجهة المتجر');
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('opening a bench is refused with its own sentence', async () => {
    before.isTest = true;
    const res = await patch({ storefrontEnabled: true });
    expect(res.status).toBe(409);
    const said = (await res.json()).error;
    expect(said).toBe(BENCH_STORE_CANNOT_OPEN_AR);
    expect(said).not.toBe(BENCH_STORE_IS_OPEN_AR);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('asking for both in one save is the second refusal (the form asked to open it)', async () => {
    const res = await patch({ isTest: true, storefrontEnabled: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(BENCH_STORE_CANNOT_OPEN_AR);
  });

  it('closing the storefront in the same save as the mark is allowed', async () => {
    before.storefrontEnabled = true;
    expect((await patch({ isTest: true, storefrontEnabled: false })).status).toBe(200);
  });

  it('opening a store while taking the mark off in the same save is allowed', async () => {
    before.isTest = true;
    expect((await patch({ isTest: false, storefrontEnabled: true })).status).toBe(200);
  });

  it('an ordinary store opens and a bench still renames (the rule touches nothing else)', async () => {
    expect((await patch({ storefrontEnabled: true })).status).toBe(200);
    before.isTest = true;
    before.storefrontEnabled = false;
    expect((await patch({ name: 'اسم جديد' })).status).toBe(200);
  });

  it('when the database CHECK still fires (a race), the same sentence comes back — not a generic error', async () => {
    db.store.update.mockRejectedValue(new Error(`new row for relation "stores" violates check constraint "${BENCH_CHECK_NAME}"`));
    const res = await patch({ isTest: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(BENCH_STORE_IS_OPEN_AR);
  });

  it('any other database error is NOT dressed up as the bench sentence', async () => {
    db.store.update.mockRejectedValue(new Error('connection reset'));
    const res = await patch({ isTest: true });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(isBenchCheckViolation(new Error('connection reset'))).toBe(false);
    expect(isBenchCheckViolation(new Error(BENCH_CHECK_NAME))).toBe(true);
    expect(isBenchCheckViolation(undefined)).toBe(false);
  });
});

describe('the company keeps a real store', () => {
  it('refuses to turn its ONLY real store into a bench, with the sentence', async () => {
    db.store.count.mockResolvedValue(0);
    const res = await patch({ isTest: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(LAST_REAL_STORE_AR);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('asks about the OTHER real stores of THIS company (not this one, not a bench, not another company)', async () => {
    await patch({ isTest: true });
    expect(db.store.count.mock.calls[0][0].where).toEqual({ companyId: 'c1', id: { not: ID }, isTest: false });
  });

  it('a save that does not turn the mark on never asks', async () => {
    await patch({ name: 'اسم' });
    await patch({ isTest: false });
    expect(db.store.count).not.toHaveBeenCalled();
  });

  it('a store that is already a bench may be re-saved with the mark still on', async () => {
    before.isTest = true;
    db.store.count.mockResolvedValue(0);
    expect((await patch({ isTest: true })).status).toBe(200);
  });
});

describe('the delete door is unchanged', () => {
  it('still wants the typed name', async () => {
    const res = await DELETE(new Request('http://localhost/x', { method: 'DELETE', body: JSON.stringify({}) }), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(400);
  });
});
