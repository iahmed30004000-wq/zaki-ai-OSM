import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * A STORE READS ITS OWN — THE DOORS THAT LOOKED BY COMPANY ALONE.
 *
 * The stores of one company are separate businesses: separate cash, couriers,
 * catalogues and customers. These doors found a record by its id and the
 * COMPANY, so somebody working one store reached another's by knowing an id:
 *
 *   · recording a delivery from tracking (stock consumed, money written);
 *   · spending an expense from another store's wallet;
 *   · editing or deleting another store's courier;
 *   · opening or deleting another store's product;
 *   · reading another store's Telegram messages (names, phones, addresses);
 *   · listing every country and store in the geo settings;
 *   · finding any product by name in the command palette, whatever one's
 *     product permission.
 *
 * Each case is asked both ways: the other store's record is not found, and
 * this store's — or one not yet placed, where the door is how it gets placed
 * — still is.
 */

const { db, ctx, held } = vi.hoisted(() => ({
  db: {
    orderItem: { findMany: vi.fn() },
    order: { findFirst: vi.fn(), count: vi.fn() },
    wallet: { findFirst: vi.fn() },
    deliveryProvider: { findFirst: vi.fn(), update: vi.fn() },
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    country: { findMany: vi.fn() },
    userStoreAccess: { findMany: vi.fn() },
    store: { findMany: vi.fn() },
  },
  ctx: { storeId: 's1' as string | null },
  held: { keys: {} as Record<string, unknown> },
}));

vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('@/lib/geo-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/geo-context')>()),
  requireContext: async () => ({
    user: { id: 'u1', role: 'CUSTOM', status: 'ACTIVE', companyId: 'c1' },
    companyId: 'c1', storeId: ctx.storeId, countryId: 'co1',
    country: { minorUnit: 2, currencyCode: 'JOD', allowNegativeStock: false },
  }),
}));
vi.mock('@/lib/auth', () => ({
  requireCompanyTenant: async () => ({ user: { id: 'u1', role: 'CUSTOM', status: 'ACTIVE', companyId: 'c1' }, companyId: 'c1' }),
}));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  const scopeOf = (k: string) => {
    const v = held.keys[k];
    return v ? (typeof v === 'string' ? { scope: v } : v) : null;
  };
  return {
    ...real,
    requirePermission: async () => ({ id: 'u1', role: 'CUSTOM', status: 'ACTIVE', companyId: 'c1' }),
    can: (_u: unknown, k: string) => !!scopeOf(k),
    getPermissionScope: (_u: unknown, k: string) => scopeOf(k),
    authorize: () => ({ allowed: true }),
  };
});
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));

import { POST as deliver } from '@/app/api/ops/tracking/deliver/route';
import { POST as recordExpense } from '@/app/api/finance/route';
import { GET as productGet } from '@/app/api/products/[id]/route';
import { PATCH as courierPatch } from '@/app/api/delivery-providers/[id]/route';
import { telegramStoreWhere } from '@/lib/telegram/store-scope';
import { geoReach } from '@/lib/geo-context';
import { paletteCounts } from '@/lib/palette-intel';

beforeEach(() => {
  vi.clearAllMocks();
  ctx.storeId = 's1';
  held.keys = {};
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('recording a delivery from tracking', () => {
  it('reads the order’s lines inside this store — another store’s order is not found', async () => {
    db.orderItem.findMany.mockResolvedValue([]);
    const res = await deliver(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ orderId: '11111111-2222-4333-8444-555555555555', outcome: 'ALL', preview: true }) }),
    );
    expect(res.status).toBe(404);
    expect(db.orderItem.findMany.mock.calls[0][0].where.order).toEqual({ companyId: 'c1', storeId: 's1' });
  });
});

describe('an expense', () => {
  it('is spent from this store’s wallet or an unplaced one — another store’s wallet is not found', async () => {
    db.wallet.findFirst.mockResolvedValue(null);
    const res = await recordExpense(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ title: 'إيجار', category: 'OFFICE', amount: 100, walletId: 'w-other' }) }),
    );
    expect(res.status).toBe(404);
    expect(db.wallet.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'w-other', companyId: 'c1', isActive: true, OR: [{ storeId: 's1' }, { storeId: null }],
    });
  });
});

describe('a product', () => {
  it('is read inside this store, as editing it already was', async () => {
    db.product.findFirst.mockResolvedValue(null);
    const res = await productGet(new Request('http://x'), params('p9'));
    expect(res.status).toBe(404);
    expect(db.product.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'p9', companyId: 'c1', storeId: 's1' });
  });
});

describe('a courier', () => {
  it('this store’s, or one not placed yet — never another store’s', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue(null);
    const res = await courierPatch(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'الباشا' }) }), params('dp9'));
    expect(res.status).toBe(404);
    expect(db.deliveryProvider.findFirst.mock.calls[0][0].where).toEqual({
      id: 'dp9', companyId: 'c1', OR: [{ storeId: 's1' }, { storeId: null }],
    });
  });
});

describe('Telegram messages', () => {
  it('this store’s sources; the unplaced ones only for the manager', () => {
    expect(telegramStoreWhere('s1', false)).toEqual({ OR: [{ source: { storeId: 's1' } }] });
    expect(telegramStoreWhere('s1', true).OR).toHaveLength(3);
    expect(telegramStoreWhere(null, false)).toEqual({ id: { in: [] } });
  });
});

describe('the geo settings', () => {
  const user = (keys: Record<string, unknown>) => {
    held.keys = keys;
    return { id: 'u1', role: 'CUSTOM', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  };

  it('somebody who sees every country gets no filter', async () => {
    expect(await geoReach(user({ 'geo.manage': 'ALL_COMPANY' }), 'c1')).toBeNull();
  });

  it('somebody confined to a country gets that country, and every store in it', async () => {
    db.country.findMany.mockResolvedValue([{ id: 'co1' }]);
    db.userStoreAccess.findMany.mockResolvedValue([]);
    expect(await geoReach(user({ 'geo.view': 'ALL_COMPANY' }), 'c1')).toEqual({ countryIds: ['co1'], storeIds: null });
  });

  it('somebody named to one store gets that store, and only its country', async () => {
    db.country.findMany.mockResolvedValue([{ id: 'co1' }, { id: 'co2' }]);
    db.userStoreAccess.findMany.mockResolvedValue([{ storeId: 's1', store: { countryId: 'co1' } }]);
    expect(await geoReach(user({ 'geo.view': 'ALL_COMPANY' }), 'c1')).toEqual({ countryIds: ['co1'], storeIds: ['s1'] });
  });
});

describe('the command palette, finding a product by name', () => {
  const scope = { companyId: 'c1', storeId: 's1' } as never;
  const person = { id: 'u1', role: 'CUSTOM', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;

  it('finds none for somebody without «عرض المنتجات»', async () => {
    held.keys = { 'orders.view': 'ALL_COMPANY' };
    expect(await paletteCounts(scope, person, 'كريم')).toEqual([]);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it('finds only the categories a category-scoped reader holds', async () => {
    held.keys = { 'orders.view': 'ALL_COMPANY', 'products.view': { scope: 'CATEGORY', scopeIds: ['cat-1'] } };
    db.product.findMany.mockResolvedValue([]);
    await paletteCounts(scope, person, 'كريم');
    expect(db.product.findMany.mock.calls[0][0].where.categoryId).toEqual({ in: ['cat-1'] });
  });
});
