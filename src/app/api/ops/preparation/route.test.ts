import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * GET /api/ops/preparation — THE WAREHOUSE'S LOAD CARRIES NO PHONE AND NO ADDRESS (Q16).
 *
 * The packer needs the product, the count, the order number and the first name on the box. The phone and the address are
 * the customer's, and a screen that holds them is a screen that can leak them. `redactCustomerForWarehouse` had a test;
 * THIS door — the one the packer actually reads — had none, so nothing stopped a later `select` from adding
 * `customer: { select: { phone: true } }` and quietly handing every packer the customer's number.
 *
 * Three walls, each its own test:
 *   · the READ never asks the database for a contact column (the `select` is checked, not the answer);
 *   · the ANSWER never contains one, even when the database is made to hand one over (a hostile fixture);
 *   · the SOURCE of the grouping names no contact column at all.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  db: {
    orderAddOn: { aggregate: async () => ({ _sum: { reservedQty: 0 } }), findMany: async () => [] },
    orderItem: { findMany: vi.fn(), aggregate: vi.fn() },
    productionBatch: { aggregate: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));

import { GET } from './route';

const CONTACT_KEYS = ['phone', 'rawPhone', 'altPhone', 'address', 'whatsapp', 'email', 'notes'];
const PHONE = '0791234567';
const ADDRESS = 'شارع الجامعة، عمارة 12';

/** Every key and every string value anywhere inside a JSON-ish value. */
function walk(value: unknown, keys: string[] = [], strings: string[] = []): { keys: string[]; strings: string[] } {
  if (Array.isArray(value)) value.forEach((v) => walk(v, keys, strings));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      walk(v, keys, strings);
    }
  } else if (typeof value === 'string') strings.push(value);
  return { keys, strings };
}

/** A customer row as a careless `select` would return it — contact columns included. */
const leakyCustomer = { fullName: 'أحمد', phone: PHONE, rawPhone: '079 123 4567', altPhone: '0780000000', address: ADDRESS, notes: 'ملاحظة' };

const line = (over: Record<string, unknown> = {}) => ({
  productId: 'p1', productName: 'مقشر', quantity: 2, freeQuantity: 1, reservedQty: 0,
  order: {
    id: 'o1', orderNumber: 'ORD-1', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY',
    customer: leakyCustomer, region: { name: 'عمّان' }, changeRequests: [],
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false } });
  requirePermission.mockResolvedValue(undefined);
  db.productionBatch.aggregate.mockResolvedValue({ _sum: { quantityRemaining: 10 } });
  db.orderItem.aggregate.mockResolvedValue({ _sum: { reservedQty: 0 } });
  db.orderItem.findMany.mockResolvedValue([line(), line({ order: { ...line().order, id: 'o2', orderNumber: 'ORD-2' } })]);
});

describe('the read never asks for a contact column', () => {
  it('— the customer is selected by name alone', async () => {
    await GET();
    const select = db.orderItem.findMany.mock.calls[0][0].select;
    expect(Object.keys(select.order.select.customer.select)).toEqual(['fullName']);
  });

  it('— and nothing else in the selection names a contact column, at any depth', async () => {
    await GET();
    const { keys } = walk(db.orderItem.findMany.mock.calls[0][0].select);
    for (const k of CONTACT_KEYS) expect(keys, `القراءة تطلب ${k}`).not.toContain(k);
  });
});

describe('the answer carries none, even when the database hands one over', () => {
  it('— no contact key anywhere in the JSON', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const { keys } = walk(body);
    for (const k of CONTACT_KEYS) expect(keys, `الجواب فيه ${k}`).not.toContain(k);
  });

  it('— and neither the number nor the address appears as a value', async () => {
    const text = JSON.stringify(await (await GET()).json());
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain('079 123 4567');
    expect(text).not.toContain('0780000000');
    expect(text).not.toContain(ADDRESS);
  });

  it('— while the packer still gets what the box needs', async () => {
    const body = await (await GET()).json();
    expect(body.totals).toEqual({ products: 1, orders: 2, shortages: 0 });
    expect(body.allowNegativeStock).toBe(false);
    expect(body.groups[0].required).toBe(6);
    expect(body.groups[0].lines[0]).toMatchObject({ orderNumber: 'ORD-1', customerName: 'أحمد', regionName: 'عمّان', quantity: 2, freeQuantity: 1 });
  });
});

describe('who may read it, and whose goods', () => {
  it('— NEGATIVE: without `ops.prepare` nothing is read', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission ops.prepare'));
    const res = await GET();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('— the read is this company’s and this store’s confirmed orders that are not yet on the road', async () => {
    await GET();
    const where = db.orderItem.findMany.mock.calls[0][0].where;
    expect(where.companyId).toBe('c1');
    expect(where.order).toMatchObject({ storeId: 's1', confirmationStatus: 'CONFIRMED', shippingStatus: { in: ['NOT_READY', 'PACKING'] } });
  });
});

describe('the source of the grouping names no contact column', () => {
  const body = () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/lib/operations.ts'), 'utf8'));
    const from = src.indexOf('export async function preparationGroups');
    return src.slice(from, src.indexOf('export type BlockCode'));
  };

  it('— `preparationGroups` selects and builds lines without one', () => {
    const src = body();
    expect(src.length, 'لم أجد الدالة').toBeGreaterThan(500);
    for (const k of CONTACT_KEYS) expect(src, `الدالة تذكر ${k}`).not.toMatch(new RegExp(`\\b${k}\\b`));
  });

  it('— and the door itself never reads a customer', () => {
    const door = stripComments(readFileSync(join(process.cwd(), 'src/app/api/ops/preparation/route.ts'), 'utf8'));
    expect(door).not.toMatch(/customer/);
  });
});
