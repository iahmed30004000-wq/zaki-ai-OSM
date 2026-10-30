import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BIGGER ORDER COSTS MORE.
 *
 * «الكمية تُعدَّل ← السعرُ يُعدَّل معها مباشرة» — the owner's own words, and
 * the single-line shorthand of `PATCH /api/orders/[id]` did the opposite.
 *
 * `sellingPrice` on an order is the line's TOTAL, not the price of one
 * piece. The shorthand handed that stored total to a line whose quantity
 * had changed, and `computeCod` is given `unitPrice / quantity` — so the
 * division by the NEW quantity cancelled the multiplication straight back
 * out and the amount due never moved.
 *
 * MEASURED, not imagined. ORD-2026-0044 on this database: quantity 3,
 * sellingPrice 36.000, lineTotal 36.000, unitPrice 12.000. Raise the
 * quantity to 5 and the old code collected 36.000 for five pieces — 7.200
 * each instead of 12.000. A discount of 24.000 granted by the act of asking
 * for more, with no approval anywhere.
 *
 * THAT ROW IS THE FIXTURE BELOW, and the arithmetic is asserted on the
 * figure the route WRITES, not on the presence of a call.
 *
 * ── AND THE FREE PIECE IS NOT IN THE ARITHMETIC ──
 *
 * The same three rows carry `freeQuantity: 1`. Measured: 3 x 12.000 =
 * 36.000, so `quantity` is what is PAID for and the gift rides on top.
 * A fix that divided by `quantity + freeQuantity` would quietly cut every
 * piece price on an order with a gift, so one case below carries the gift
 * and pins the same figure.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { makeDb, requireContext, assertOrderAccess, authorize, can, getPermissionScope, logAudit, notify } =
  vi.hoisted(() => ({
    makeDb: { current: null as any },
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    authorize: vi.fn(),
    can: vi.fn(),
    getPermissionScope: vi.fn(),
    logAudit: vi.fn(),
    notify: vi.fn(),
  }));

vi.mock('@/lib/db', () => {
  const forward = (model: string, method: string) => (args: unknown) => makeDb.current[model][method](args);
  const models = [
    'order', 'orderItem', 'orderAddOn', 'customer', 'product', 'productionBatch',
    'inventoryMovement', 'orderStatusLog', 'orderActivity', 'changeRequest',
    'shippingBatch', 'region', 'notification',
    // a discount alone asks whether a courier statement holds the order
    'settlementMatch',
    /*
     * The route counts the order's contact attempts now: an agent holding
     * an order may not edit it before she has tried to reach the customer
     * («افتح وعدّل» joined C1's four). This file's subject is the money on
     * an edit, which is the same arithmetic whichever door the edit came
     * through — so the fixture below says she rang.
     */
    'orderContactAttempt',
  ];
  const methods = [
    'findFirst', 'findUnique', 'findMany', 'create', 'createMany', 'update',
    'updateMany', 'deleteMany', 'aggregate', 'count',
  ];
  const db: Record<string, unknown> = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  for (const m of models) {
    db[m] = Object.fromEntries(methods.map((k) => [k, forward(m, k)]));
  }
  return { db };
});
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: vi.fn(),
  orderVisibilityWhere: () => ({}),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/authorization', () => ({
  authorize: (...a: unknown[]) => authorize(...a),
  can: (...a: unknown[]) => can(...a),
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
}));

import { PATCH } from './route';

const ORDER = 'o-44';
const CREAM = 'p-cream';

type Row = Record<string, any>;

/**
 * ORD-2026-0044 AS IT STANDS: three pieces for 36.000, one free on top.
 * Nothing shipped, so the line is still editable.
 */
const orderRow = (over: Row = {}) => ({
  id: ORDER,
  orderNumber: 'ORD-2026-0044',
  companyId: 'c1',
  storeId: 's1',
  countryId: 'co1',
  customerId: 'cust-1',
  productId: CREAM,
  productNameSnapshot: 'كريم',
  quantity: 3,
  freeQuantity: 1,
  sellingPrice: 36,
  discountAmount: 0,
  shippingCost: 0,
  totalAmount: 36,
  priceIncludesDelivery: true,
  estimatedCostOfGoods: 0,
  version: 7,
  status: 'CONFIRMED',
  /*
   * IN_PROGRESS, NOT CONFIRMED — and the change is the rule, not this file.
   *
   * Since «بعد التأكيد: التعديل بطلب», a direct edit of a customer or line
   * field on a CONFIRMED order is refused with `CHANGE_REQUEST_REQUIRED`
   * and goes through the change-request pipeline instead. This file's
   * subject is the money arithmetic on an edit, which is the same whichever
   * door the edit came through, so the order is put where a direct edit is
   * still right: still being worked on.
   */
  confirmationStatus: 'IN_PROGRESS',
  shippingStatus: 'NOT_READY',
  shippedAt: null,
  deliveredAt: null,
  settlementStatus: 'PENDING_COLLECTION',
  moderatorId: null,
  lockedById: null,
  lockExpiresAt: null,
  assignedToId: 'u1',
  claimedById: 'u1',
  currentOwnerId: 'u1',
  ...over,
});

/** A world that keeps what the route writes, so the figures can be read back. */
function world(order: Row) {
  const orderWrites: Row[] = [];
  const db: Row = {
    order: {
      updateMany: async ({ data }: any) => (orderWrites.push(data), { count: 1 }),
      update: async ({ data }: any) => (orderWrites.push(data), Object.assign(order, data)),
      findUnique: async () => order,
      findFirst: async () => ({ ...order, items: [], store: { country: { minorUnit: 3 } } }),
    },
    orderItem: {
      findFirst: async () => null,
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
    },
    // No add-ons on this order. The route reads them so an accepted upsell
    // is not dropped by a line edit; an empty answer is the measured state.
    orderAddOn: { findMany: async () => [] },
    customer: { update: async () => ({}), findUnique: async () => null },
    product: { findMany: async () => [], findUnique: async () => null },
    productionBatch: { findMany: async () => [], findFirst: async () => null, aggregate: async () => ({ _sum: {} }) },
    inventoryMovement: { findFirst: async () => null, create: async () => ({}) },
    orderStatusLog: { create: async () => ({}) },
    orderActivity: { create: async () => ({}) },
    changeRequest: { findUnique: async () => null, update: async () => ({}) },
    // Nothing sealed: the order has not been put in a batch.
    shippingBatch: { findFirst: async () => null },
    settlementMatch: { count: async () => 0 },
    region: { findFirst: async () => null, findUnique: async () => null },
    notification: { create: async () => ({}), createMany: async () => ({ count: 0 }) },
    /*
     * SHE RANG. «افتح وعدّل» joined C1's locked actions, so the route now
     * refuses a HOLDER's edit on an order with no contact attempt — and
     * this fixture's order is held by the caller. One attempt is the
     * ordinary state of an order being edited, and it keeps this file
     * about the arithmetic it is named for.
     */
    orderContactAttempt: { count: async () => 1 },
  };
  db.$transaction = (fn: (tx: unknown) => unknown) => fn(db);
  return { db, order, orderWrites };
}

function install(w: ReturnType<typeof world>) {
  makeDb.current = w.db;
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سامر', role: 'MANAGER' },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    // JOD: three decimals, which is why 7.200 below is a figure and not a
    // rounding artefact.
    country: { id: 'co1', code: 'JO', currencyCode: 'JOD', minorUnit: 3, allowNegativeStock: false },
  });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: w.order });
  return w;
}

const edit = (body: Record<string, unknown>) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 7, reason: 'العميل طلب كمية أكبر', ...body }),
    }),
    { params: Promise.resolve({ id: ORDER }) } as never
  );

/** The money the route actually wrote. */
const written = (w: ReturnType<typeof world>) => {
  const data = w.orderWrites.at(-1) ?? {};
  return {
    sellingPrice: Number(data.sellingPrice),
    quantity: Number(data.quantity),
    totalAmount: Number(data.totalAmount),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  authorize.mockReturnValue({ allowed: true });
  can.mockReturnValue(true);
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  logAudit.mockResolvedValue(undefined);
  notify.mockResolvedValue(undefined);
});

describe('Ⅰ · the quantity moves and the money moves with it', () => {
  it('3 pieces at 36.000 raised to 5 is 60.000 — not 36.000', async () => {
    const w = install(world(orderRow()));
    const res = await edit({ quantity: 5 });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    // THE DEFECT IN ONE NUMBER. The old shorthand wrote 36 here: five
    // pieces at 7.200, a 24.000 discount nobody approved.
    expect(written(w)).toEqual({ sellingPrice: 60, quantity: 5, totalAmount: 60 });
  });

  it('and lowered to 1 is 12.000 — the piece price, not the old total', async () => {
    const w = install(world(orderRow()));
    const res = await edit({ quantity: 1 });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    // And the old shorthand wrote 36 here too: ONE piece for the price of
    // three. The same defect overcharges just as readily as it undercharges.
    expect(written(w)).toEqual({ sellingPrice: 12, quantity: 1, totalAmount: 12 });
  });

  it('and the free piece is not paid for — the gift does not cut the price', async () => {
    // `freeQuantity: 1` is on the fixture already. Dividing by 4 instead of
    // 3 would make the piece 9.000 and five pieces 45.000.
    const w = install(world(orderRow({ freeQuantity: 1 })));
    await edit({ quantity: 5 });
    expect(written(w).sellingPrice, 'القطعةُ المجانيّةُ دخلت الحساب').toBe(60);
  });

  it('and a price sent WITH the quantity is taken as the new line total', async () => {
    /*
     * The screen says it beside the field: «هذا سعر السطر كاملاً للكمية
     * الحالية، لا سعر القطعة». So 50 for 5 pieces is 50, not 250 — scaling
     * it as well would apply the quantity twice.
     */
    const w = install(world(orderRow()));
    const res = await edit({ quantity: 5, sellingPrice: 50 });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(written(w)).toEqual({ sellingPrice: 50, quantity: 5, totalAmount: 50 });
  });

  it('and a price sent ALONE still replaces the total', async () => {
    const w = install(world(orderRow()));
    await edit({ sellingPrice: 40 });
    expect(written(w)).toEqual({ sellingPrice: 40, quantity: 3, totalAmount: 40 });
  });

  it('and an edit that touches neither leaves the money exactly where it was', async () => {
    const w = install(world(orderRow()));
    await edit({ discountAmount: 6 });
    expect(written(w)).toEqual({ sellingPrice: 36, quantity: 3, totalAmount: 30 });
  });
});

describe('Ⅱ · the arithmetic is generated, not sampled', () => {
  it('every quantity from 1 to 12 reads quantity x 12.000', async () => {
    /*
     * GENERATED. The three figures somebody thinks of are the three a
     * cancelling pair of operations can still agree with — 36 raised to 3
     * is 36 whichever formula is used. Walking the range is what separates
     * them.
     */
    const wrong: string[] = [];
    for (let q = 1; q <= 12; q++) {
      const w = install(world(orderRow()));
      await edit({ quantity: q });
      const got = written(w).sellingPrice;
      if (got !== q * 12) wrong.push(`كمية ${q}: كُتب ${got} والصحيح ${q * 12}`);
    }
    expect(wrong, `السعرُ لا يتبعُ الكمية:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('and a quantity of zero on the stored order carries its total over rather than dividing by it', async () => {
    // Not a real state, and that is the point: a divisor of zero must not
    // produce `Infinity` in a money column.
    const w = install(world(orderRow({ quantity: 0, sellingPrice: 36 })));
    await edit({ quantity: 4 });
    expect(Number.isFinite(written(w).sellingPrice), 'قيمةٌ غيرُ منتهيةٍ في عمودِ مال').toBe(true);
    expect(written(w).sellingPrice).toBe(36);
  });
});
