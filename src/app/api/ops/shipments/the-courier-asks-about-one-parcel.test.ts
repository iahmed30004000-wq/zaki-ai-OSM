import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE COURIER RINGS ABOUT ONE PARCEL.
 *
 * «إنشاء شحنة» lists every confirmed order waiting to go out and filters
 * by courier, governorate and date. None of those is «the one he just
 * named», so the only way to it was the eye, down a list of a hundred.
 *
 * These ask the route: does the search reach the query, does it keep the
 * filters that were already there, and — the one that would be easy to
 * break — does the hold window survive it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, noteCustomersHandedOut } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  noteCustomersHandedOut: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
// `can`: the list now asks the address-book key (the address column); nothing in this file is about the address.
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));
vi.mock('@/lib/operations', () => ({ shipmentBlocks: () => ({ hard: [], soft: [] }) }));
vi.mock('@/lib/delivery-fees', () => ({
  codForOrder: () => 0,
  resolveDeliveryFee: async () => 0,
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));

import { GET } from './route';

const ask = (query: string) =>
  GET(new Request(`http://localhost/api/ops/shipments${query ? `?${query}` : ''}`));

/** The `where` the route handed Prisma for the list. */
const listWhere = () => db.order.findMany.mock.calls[0]?.[0]?.where ?? {};

/** Every field named anywhere inside the search `OR`, flattened. */
function searchFields(where: Record<string, any>): string[] {
  const and: Record<string, any>[] = where.AND ?? [];
  const or = and.find((c) => Array.isArray(c.OR))?.OR ?? [];
  return or.map((b: Record<string, unknown>) => {
    const [key, value] = Object.entries(b)[0];
    return value && typeof value === 'object' && !('contains' in (value as object))
      ? `${key}.${Object.keys(value as object)[0]}`
      : key;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'مدير التوصيل', role: 'DELIVERY_MANAGER' },
    companyId: 'c1',
    storeId: 's1',
    country: { id: 'co', code: 'JO', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman' },
  });
  requirePermission.mockResolvedValue({ id: 'u1' });
  db.order.findMany.mockResolvedValue([]);
  db.order.count.mockResolvedValue(0);
  noteCustomersHandedOut.mockResolvedValue(undefined);
});

describe('the search box on «إنشاء شحنة»', () => {
  it('reaches the query, and asks all five things a person types', async () => {
    await ask('q=ORD-5');

    expect(searchFields(listWhere())).toEqual([
      'orderNumber',
      'merchantRef',
      'trackingNumber',
      'customer.fullName',
      'customer.phone',
      'customer.rawPhone',
      'customer.city',
    ]);
  });

  it('and the city is in it here, where parcels are sorted by where they go', async () => {
    await ask('q=عمّان');
    expect(searchFields(listWhere())).toContain('customer.city');
  });

  it('and an empty box changes nothing', async () => {
    await ask('');
    expect(listWhere().AND, 'بحث فاضي ضيّق القائمة').toBeUndefined();
  });

  it('and a box with only spaces is an empty box', async () => {
    await ask('q=%20%20');
    expect(listWhere().AND).toBeUndefined();
  });
});

describe('and it does not stand on the filters that were already there', () => {
  it('the governorate still narrows while a search is typed', async () => {
    await ask('q=سامر&region=r1');

    const where = listWhere();
    expect(where.regionId).toBe('r1');
    expect(searchFields(where).length).toBeGreaterThan(0);
  });

  it('and the hold window survives it — the one that was easy to break', async () => {
    /*
     * The route's `where` already carries an `OR` for the hold window
     * («on hold until a date that has passed, or not held at all»). A
     * second `OR` spread at the same level would silently replace it, and
     * the held orders would start appearing the moment somebody typed in
     * the box. So the search goes in as its own `AND` clause.
     */
    await ask('q=سامر');

    const where = listWhere();
    expect(where.OR, 'نافذة التأجيل انمسحت لمّا انكتب بحث').toBeDefined();
    expect(JSON.stringify(where.OR)).toContain('shipHoldUntil');
    expect(searchFields(where).length).toBeGreaterThan(0);
  });

  it('and «المؤجَّلة» keeps listing what is on hold while searching', async () => {
    await ask('q=سامر&held=only');

    const where = listWhere();
    expect(JSON.stringify(where.shipHoldUntil)).toContain('not');
    expect(searchFields(where).length).toBeGreaterThan(0);
  });

  it('and the date window still applies', async () => {
    await ask('q=سامر&from=2026-10-01&to=2026-10-15');

    const where = listWhere();
    expect(where.createdAt?.gte).toBeInstanceOf(Date);
    expect(where.createdAt?.lte).toBeInstanceOf(Date);
    expect(searchFields(where).length).toBeGreaterThan(0);
  });
});
