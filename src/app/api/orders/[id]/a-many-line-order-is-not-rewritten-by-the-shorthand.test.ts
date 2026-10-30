import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SINGLE-LINE SHORTHAND DOES NOT REWRITE A MANY-LINE ORDER (SF-RV57).
 *
 * `PATCH /api/orders/[id]` takes a price, a quantity or a product on the order
 * itself and rebuilds the order as ONE line from its own columns — where
 * `quantity` is the sum of the lines and `sellingPrice` their subtotal. On an
 * order with two lines that wrote one line's money over both, and the line rows
 * (never written by the shorthand) kept the old figures.
 *
 * The cautious answer, decided without asking the owner («اي قرار بعد الان
 * اتخذو دون الرجوع الي»): refuse the change when it moves the goods or the
 * price of an order that has more than one line; a discount or a delivery fee
 * alone touches no line and still passes. Asked on what the route WRITES.
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

/*
 * THE LINES THEMSELVES (30/10). The route now READS the rows whenever the shorthand names the goods — to refuse it on an
 * order that has lines, and to refuse writing over columns that disagree with them — so the rows are modelled, and they
 * say what the order's own columns say: one line of three for 36 (one free), or two lines of 3 × 12 and 2 × 12 for the
 * orders of five for 60 below.
 */
const linesFor = (order: Row, lineRows: number): Row[] =>
  lineRows === 0
    ? []
    : lineRows === 1
      ? [{ id: 'l-first', quantity: order.quantity, freeQuantity: order.freeQuantity, unitPrice: order.sellingPrice / order.quantity, discountShare: 0, lineTotal: order.sellingPrice }]
      : [
          { id: 'l-first', quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36 },
          { id: 'l-second', quantity: 2, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 24 },
        ];

/** A world that keeps what the route writes, so the figures can be read back. */
function world(order: Row, lineRows = 1) {
  const orderWrites: Row[] = [];
  const lines = linesFor(order, lineRows);
  const db: Row = {
    order: {
      updateMany: async ({ data }: any) => (orderWrites.push(data), { count: 1 }),
      update: async ({ data }: any) => (orderWrites.push(data), Object.assign(order, data)),
      findUnique: async () => order,
      findFirst: async () => ({ ...order, items: [], store: { country: { minorUnit: 3 } } }),
    },
    orderItem: {
      // The route asks for the line AFTER the first: it exists only when there are two or more.
      findFirst: async ({ skip }: any = {}) => (skip && lineRows > skip ? { id: 'l-second' } : null),
      findMany: async () => lines.map((l) => ({ ...l })),
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
      // a discount alone is spread over the lines in place (`the-discount-answers.test.ts`); this file reads the order
      update: async () => ({}),
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


const TWO = 2;
const wrote = (w: ReturnType<typeof world>) => w.orderWrites.length;

describe('an order with two lines', () => {
  it('refuses a new quantity and writes nothing', async () => {
    const w = install(world(orderRow({ quantity: 5, sellingPrice: 60 }), TWO));
    const res = await edit({ quantity: 9 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MULTI_LINE_SHORTHAND');
    expect(wrote(w), 'الطلب انكتب رغم الرفض').toBe(0);
  });

  it('refuses a new price and writes nothing', async () => {
    const w = install(world(orderRow({ quantity: 5, sellingPrice: 60 }), TWO));
    const res = await edit({ sellingPrice: 10 });
    expect(res.status).toBe(409);
    expect(wrote(w)).toBe(0);
  });

  it('refuses a new product and writes nothing', async () => {
    const w = install(world(orderRow({ quantity: 5, sellingPrice: 60 }), TWO));
    const res = await edit({ productId: '22222222-2222-4222-8222-222222222222' });
    expect(res.status).toBe(409);
    expect(wrote(w)).toBe(0);
  });

  it('still takes a discount alone, and the total moves by exactly that', async () => {
    const w = install(world(orderRow({ quantity: 5, sellingPrice: 60, totalAmount: 60 }), TWO));
    const res = await edit({ discountAmount: 10 });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(written(w)).toEqual({ sellingPrice: 60, quantity: 5, totalAmount: 50 });
  });

  it('and a price or quantity equal to what is stored is not a change', async () => {
    const w = install(world(orderRow({ quantity: 5, sellingPrice: 60, totalAmount: 60 }), TWO));
    const res = await edit({ quantity: 5, sellingPrice: 60, discountAmount: 10 });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(written(w).totalAmount).toBe(50);
  });
});

describe('an order with one line is refused too now; with none, it is as before', () => {
  /*
   * < 300 and 60 written → 409 LINES_REQUIRED and nothing written (30/10, fix/order-columns-never-leave-their-lines).
   *
   * The shorthand wrote 60 onto the order's columns and left the ONE line at three for 36: the order read 60 while the
   * shipping screen (which prices the parcel from the lines) and the shelf still read three. That is ORD-2026-0733. The
   * fixture used to say «one line» only to the second-line question and «no lines» to everything else, which is how this
   * passed. The lines save (`items`) is the door that moves them; the arithmetic this file guarded is now
   * `a-bigger-order-costs-more.test.ts`'s, on an order with no line rows, where the shorthand still works.
   */
  it('one line: 3 pieces for 36 raised to 5 is refused, and nothing is written', async () => {
    const w = install(world(orderRow(), 1));
    const res = await edit({ quantity: 5 });
    expect(res.status, await res.clone().text()).toBe(409);
    expect((await res.json()).code).toBe('LINES_REQUIRED');
    expect(wrote(w), 'الطلب انكتب رغم الرفض').toBe(0);
  });

  it('no line rows at all (an old order): the shorthand still works', async () => {
    const w = install(world(orderRow(), 0));
    const res = await edit({ quantity: 5 });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(written(w).totalAmount).toBe(60);
  });
});
