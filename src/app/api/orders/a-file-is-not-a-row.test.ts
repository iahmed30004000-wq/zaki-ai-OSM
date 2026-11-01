import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE ORDER IS NOT THREE HUNDRED.
 *
 * «استيراد طلبات» has no bulk endpoint. The dialog reads the file in the
 * browser and posts the rows to `POST /api/orders`, one call each, exactly
 * like somebody typing an order — so `orders.create`, «may type an order»,
 * was also «may feed a spreadsheet through». The owner's rule is that a
 * confirmation agent does the first and not the second.
 *
 * The dialog now says what it is, and the door asks for the matching
 * permission when it sees that. Asked at the door: the status, and whether
 * an order row was written.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, can, logAudit, activeBlock, createNotification } = vi.hoisted(() => ({
  db: {
    customer: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    offer: { findFirst: vi.fn() },
    store: { findFirst: vi.fn() },
    region: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    order: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    orderItem: { createMany: vi.fn(), create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    productionBatch: { findMany: vi.fn() },
    // No fixed figure for any product here: `unitCostsOf` falls through to the batches above (plain function, so a mock reset leaves it answering).
    productFixedCost: { findMany: async () => [] },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  activeBlock: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/rbac', () => ({ applyQueueFilter: (_u: unknown, w: unknown) => w }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
  can: (...a: unknown[]) => can(...a),
}));
// Surfaced, not swallowed: the route's own handler answers «حدث خطأ داخلي»
// for everything, and a test that cannot see the cause cannot be fixed.
vi.mock('@/lib/api-error', () => ({
  apiError: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));
vi.mock('@/lib/order-ref', () => ({
  orderRefFields: async () => ({ orderNumber: 'SY-2026-0300', merchantRef: 'SY-2026-0300' }),
}));

import { POST } from './route';

const CREAM = { id: 'prod-cream-0001', name: 'كريم حرير', image: null, basePrice: 20, batches: [{ costPerUnit: 5 }] };

const syria = {
  id: 'co-sy', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2,
  timezone: 'Asia/Damascus', orderPrefix: 'SY', allowNegativeStock: false,
};

/** One row, as the dialog sends it — `viaImport` is the only difference. */
const row = (over: Record<string, unknown> = {}) => ({
  customerName: 'محمد الحسن',
  customerPhone: '0944555666',
  customerAddress: 'دوما',
  items: [{ productId: CREAM.id, quantity: 1, unitPrice: 20 }],
  source: 'استيراد ملفّ',
  ...over,
});

const post = (b: unknown) =>
  POST(new Request('http://localhost/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  }));

/** Everything this role may do, by permission key. */
const holding = (...keys: string[]) => can.mockImplementation((_u: unknown, k: string) => keys.includes(k));

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1', storeId: 's1', countryId: 'co-sy', country: syria,
  });
  requirePermission.mockResolvedValue({ id: 'u1', companyId: 'c1' });
  activeBlock.mockResolvedValue(null);
  db.customer.findUnique.mockResolvedValue({ id: 'cu1', fullName: 'محمد الحسن', totalOrders: 0 });
  db.customer.findFirst.mockResolvedValue({ id: 'cu1', fullName: 'محمد الحسن', totalOrders: 0 });
  db.product.findMany.mockImplementation(async ({ where }: any) =>
    [CREAM].filter((p) => where.id.in.includes(p.id))
  );
  db.product.findFirst.mockResolvedValue(CREAM);
  db.offer.findFirst.mockResolvedValue(null);
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
  db.user.findFirst.mockResolvedValue({ id: 'u1', commissionRate: 0 });
  db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0300' });
  db.order.count.mockResolvedValue(0);
  db.productionBatch.findMany.mockResolvedValue([{ productId: CREAM.id, quantityRemaining: 100, costPerUnit: 5 }]);
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
});

describe('a row that says it came from a file', () => {
  it('is refused from somebody who may create orders but not import them', async () => {
    holding('orders.create');

    const res = await post(row({ viaImport: true }));
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.code).toBe('IMPORT_NOT_ALLOWED');
    expect(body.error).toContain('استيراد');
    expect(db.order.create, 'انكتب طلب من ملفّ بلا صلاحية').not.toHaveBeenCalled();
  });

  it('and goes through with orders.import', async () => {
    holding('orders.create', 'orders.import');

    await post(row({ viaImport: true }));
    // The gate is what is under test, so the assertion is on whether the
    // route got PAST it and reached the write. What happens after the write
    // — totals, lines, stock — belongs to `multi-line.test.ts`, which owns
    // the full creation fixture.
    expect(db.order.create, 'الاستيراد انرفض مع إنّه معه الصلاحية').toHaveBeenCalledTimes(1);
  });
});

describe('and typing one order is untouched', () => {
  it('the same row without the flag still creates, with no import permission at all', async () => {
    // This is the whole point of the split: the agent keeps her job. If
    // this ever goes red, the permission stopped being about importing and
    // started being about creating.
    holding('orders.create');

    await post(row());
    expect(db.order.create, 'الإدخال اليدوي انكسر مع صلاحية الاستيراد الجديدة').toHaveBeenCalledTimes(1);
  });

  it('and a flag that is not literally true is not an import', async () => {
    // `viaImport: 'yes'` or `1` is a malformed client, not a claim about
    // provenance. The check is `=== true` so a stray value can never turn
    // an ordinary entry into a refusal.
    holding('orders.create');

    for (const value of ['yes', 1, {}, null]) {
      vi.clearAllMocks();
      beforeEachState();
      await post(row({ viaImport: value }));
      expect(db.order.create, `viaImport=${JSON.stringify(value)}`).toHaveBeenCalledTimes(1);
    }
  });
});

/** The beforeEach body, callable inside a loop that clears the mocks. */
function beforeEachState() {
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1', storeId: 's1', countryId: 'co-sy', country: syria,
  });
  requirePermission.mockResolvedValue({ id: 'u1', companyId: 'c1' });
  can.mockImplementation((_u: unknown, k: string) => k === 'orders.create');
  activeBlock.mockResolvedValue(null);
  db.customer.findUnique.mockResolvedValue({ id: 'cu1', fullName: 'محمد الحسن', totalOrders: 0 });
  db.customer.findFirst.mockResolvedValue({ id: 'cu1', fullName: 'محمد الحسن', totalOrders: 0 });
  db.product.findMany.mockImplementation(async ({ where }: any) =>
    [CREAM].filter((p) => where.id.in.includes(p.id))
  );
  db.product.findFirst.mockResolvedValue(CREAM);
  db.offer.findFirst.mockResolvedValue(null);
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
  db.user.findFirst.mockResolvedValue({ id: 'u1', commissionRate: 0 });
  db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0300' });
  db.order.count.mockResolvedValue(0);
  db.productionBatch.findMany.mockResolvedValue([{ productId: CREAM.id, quantityRemaining: 100, costPerUnit: 5 }]);
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
}
