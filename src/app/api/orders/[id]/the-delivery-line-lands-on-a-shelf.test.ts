import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LEGACY DELIVERY DOOR, AFTER IT STOPPED DOING ITS OWN ARITHMETIC.
 *
 * `PATCH /api/orders/[id]` with `status: 'DELIVERED'` used to deduct stock by
 * hand: the OLDEST batch with units left, `Math.min(existing.quantity,
 * batch.quantityRemaining)` out of it, one SALE line, done. It now calls
 * `consumeOrderStock`, and this file asserts the DIFFERENCE IN QUANTITIES —
 * not that the call is present.
 *
 * Every number below is one the old block got wrong:
 *
 *   batches of 3 and 8, order for 10 → old: 3 taken, 7 delivered and still
 *   on the books. new: 3 + 7, one unit left.
 *
 *   a SALE already in the ledger → old: deducted again (26 orders and 52
 *   units on this database sit in exactly that state, DELIVERED by shipping
 *   status with `status` still 'SHIPPED'). new: nothing moves.
 *
 *   two lines → old: the first product only. new: both.
 *
 *   3 paid + 1 gift → old: 3. new: 4.
 *
 *   `balanceAfter` → old: one batch's remainder. new: the product's on hand.
 *
 * NOTHING IS MOCKED BELOW THE ROUTE. `consumeOrderStock`, `drawDownStock`
 * and `onHandTotal` are the real functions, running against a transaction
 * that actually applies the `where` it is handed and actually mutates the
 * rows — so the remainders asserted here are the remainders the code
 * produces, and the store clause is exercised rather than described.
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

/**
 * The route imports `db` once, at module load, so the object handed to it has
 * to be stable while its CONTENTS change per test. Every call is forwarded to
 * the world built for the test at hand.
 */
vi.mock('@/lib/db', () => {
  const forward = (model: string, method: string) => (args: unknown) => makeDb.current[model][method](args);
  const models = ['order', 'orderItem', 'orderAddOn', 'customer', 'productionBatch', 'productFixedCost', 'inventoryMovement', 'orderStatusLog', 'orderActivity'];
  const methods = ['findFirst', 'findUnique', 'findMany', 'create', 'createMany', 'update', 'updateMany', 'deleteMany', 'aggregate', 'count'];
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
/** The real filter the ledger screens use — not a restatement of it. */
import { inStore } from '@/lib/store-filter';
/** The real helper, called a second time where a second door would call it. */
import { consumeOrderStock } from '@/lib/stock-consumption';

const ORDER = 'o-1';
const CREAM = 'p-cream';
const SOAP = 'p-soap';
const MUBARAK = 's-mubarak';
const SIHHA = 's-sihha';

type Row = Record<string, any>;

/** Prisma's `where` for the shapes this route, the helper and `inStore` use. */
function matchesWhere(row: Row, where: Row): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (want && typeof want === 'object' && Array.isArray(want.in)) {
      if (!want.in.includes(row[key])) return false;
    } else if (want && typeof want === 'object' && 'gt' in want) {
      if (!((row[key] ?? 0) > want.gt)) return false;
    } else if (row[key] !== want) {
      return false;
    }
  }
  return true;
}

/** An order of المبارك ستور, shipped and awaiting delivery. */
const orderRow = (over: Row = {}) => ({
  id: ORDER,
  orderNumber: 'ORD-1',
  companyId: 'c1',
  storeId: MUBARAK,
  countryId: 'co1',
  customerId: 'cust-1',
  productId: CREAM,
  productNameSnapshot: 'كريم',
  quantity: 3,
  freeQuantity: 0,
  version: 7,
  status: 'SHIPPED',
  confirmationStatus: 'CONFIRMED',
  shippingStatus: 'SHIPPED',
  settlementStatus: 'PENDING_COLLECTION',
  shippedAt: new Date('2026-10-01'),
  deliveredAt: null,
  confirmedAt: new Date('2026-09-30'),
  totalAmount: 120,
  estimatedCostOfGoods: 0,
  moderatorId: 'u2',
  lockedById: null,
  lockExpiresAt: null,
  assignedToId: 'u1',
  claimedById: 'u1',
  currentOwnerId: 'u1',
  ...over,
});

const batch = (over: Row) => ({
  companyId: 'c1',
  storeId: MUBARAK,
  productId: CREAM,
  quantitySold: 0,
  costPerUnit: 4,
  productionDate: new Date('2026-01-01'),
  ...over,
});

/**
 * A transaction that answers honestly: it applies the `where` it is handed,
 * mutates the rows it is told to, and keeps what was written so the test can
 * read the ledger back.
 */
function world(opts: {
  order?: Row;
  items?: Row[];
  shelf?: Row[];
  /** A SALE already recorded for this order — the 26-order state measured. */
  priorSale?: boolean;
  /** The FIXED COST an admin set for these products (`ProductFixedCost`): none, unless a test says so. */
  figures?: Record<string, number>;
}) {
  const order = opts.order ?? orderRow();
  const items = opts.items ?? [{ productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 0 }];
  const shelf: Row[] = (opts.shelf ?? [batch({ id: 'b-only', quantityRemaining: 50 })]).map((b) => ({ ...b }));
  const movements: Row[] = opts.priorSale
    ? [{ id: 'm-prior', companyId: 'c1', storeId: order.storeId, productId: CREAM, type: 'SALE', quantity: -4, balanceAfter: 9, referenceId: ORDER }]
    : [];
  const logs: Row[] = [];
  const orderWrites: Row[] = [];
  const shelfQueries: Row[] = [];
  const figureQueries: Row[] = [];
  let seq = 0;

  const db: Row = {
    order: {
      updateMany: async ({ data }: any) => {
        orderWrites.push(data);
        return { count: 1 };
      },
      update: async ({ data }: any) => {
        orderWrites.push(data);
        Object.assign(order, data);
        return order;
      },
      findUnique: async () => order,
      findFirst: async () => ({
        orderNumber: order.orderNumber,
        storeId: order.storeId,
        items,
        store: { country: { minorUnit: 2 } },
      }),
    },
    // An order with no add-ons, unless a test says otherwise — plain functions, so a mock reset leaves them answering.
    orderAddOn: { aggregate: async () => ({ _sum: { reservedQty: 0 } }), findMany: async () => [], update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    orderItem: {
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
    customer: { update: async () => ({}) },
    productionBatch: {
      findMany: async ({ where, orderBy }: any) => {
        shelfQueries.push(where);
        // COPIES, as Prisma returns: a fake that hands back the live row
        // lets a writer read a value it has already changed — which is how a
        // revert of this fix told a different story about its own arithmetic.
        const rows = shelf.filter((b) => matchesWhere(b, where)).map((b) => ({ ...b }));
        // THE ORDER IS APPLIED, NOT ASSUMED. A fake that returns rows in
        // array order lets «oldest batch first» pass because the fixture
        // happened to list them that way — so the batches below are listed
        // NEWEST first and the sort is what puts them right.
        // DIRECTION INCLUDED. Sorting ascending whatever the query asked is
        // how a fake swallows a mutation: flipping `drawDownStock`'s
        // `productionDate: 'asc'` to `'desc'` left every test passing until
        // this read the direction too.
        const specs: Array<[string, string]> = (Array.isArray(orderBy) ? orderBy : [orderBy ?? {}]).flatMap(
          (o: any) => Object.entries<string>(o ?? {})
        );
        for (const [key, dir] of [...specs].reverse()) {
          rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
          if (dir === 'desc') rows.reverse();
        }
        return rows;
      },
      findFirst: async ({ where, orderBy }: any) => {
        shelfQueries.push(where);
        // Sorted for the same reason `findMany` is — and here it matters for
        // the REVERT: the deleted block asked for the oldest batch with
        // `orderBy: { productionDate: 'asc' }`, and a fake that ignores it
        // tells a different story about what that block did.
        const rows = shelf.filter((b) => matchesWhere(b, where)).map((b) => ({ ...b }));
        const spec = (Array.isArray(orderBy) ? orderBy[0] : orderBy) ?? {};
        const key = Object.keys(spec)[0];
        if (key) {
          rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
          if (spec[key] === 'desc') rows.reverse();
        }
        return rows[0] ?? null;
      },
      update: async ({ where, data }: any) => {
        const row = shelf.find((b) => b.id === where.id)!;
        // `{ increment: n }` and `{ decrement: n }` are APPLIED, so a writer
        // that uses them — the deleted block did — moves real numbers here
        // and a revert of this fix prints the quantities it actually
        // produces rather than an unevaluated object.
        for (const [key, value] of Object.entries<any>(data)) {
          if (value && typeof value === 'object' && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment;
          else if (value && typeof value === 'object' && 'decrement' in value) row[key] = (row[key] ?? 0) - value.decrement;
          else row[key] = value;
        }
        return row;
      },
      create: async ({ data }: any) => {
        const row = { id: `b-new-${++seq}`, ...data };
        shelf.push(row);
        return row;
      },
      aggregate: async ({ where }: any) => ({
        _sum: {
          quantityRemaining: shelf
            .filter((b) => matchesWhere(b, where))
            .reduce((s, b) => s + (b.quantityRemaining ?? 0), 0),
        },
      }),
    },
    // The fixed figures, answered the way the table does: this company's, for the products asked, and only the ones that have a row.
    productFixedCost: {
      findMany: async ({ where }: any) => {
        figureQueries.push(where);
        return Object.entries(opts.figures ?? {})
          .filter(([productId]) => where.companyId === 'c1' && where.productId.in.includes(productId))
          .map(([productId, amount]) => ({ productId, amount }));
      },
    },
    inventoryMovement: {
      findFirst: async ({ where }: any) =>
        movements.find((m) => m.referenceId === where.referenceId && m.type === where.type) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `m${movements.length + 1}`, ...data };
        movements.push(row);
        return row;
      },
    },
    orderStatusLog: { create: async ({ data }: any) => (logs.push(data), data) },
    orderActivity: {
      create: async ({ data }: any) => (logs.push(data), data),
      findFirst: async ({ where }: any) => logs.find((l) => l.orderId === where.orderId && l.action === where.action) ?? null,
    },
  };
  db.$transaction = (fn: (tx: unknown) => unknown) => fn(db);

  return { db, order, items, shelf, movements, orderWrites, shelfQueries, figureQueries, activities: logs };
}

const deliver = (body: Record<string, unknown> = {}) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // A company-wide-scope edit on somebody else's order demands a written
      // reason (`REASON_REQUIRED`), which is a separate rule from this one.
      body: JSON.stringify({
        status: 'DELIVERED',
        expectedVersion: 7,
        reason: 'تأكيد التسليم من المندوب',
        ...body,
      }),
    }),
    { params: Promise.resolve({ id: ORDER }) } as never
  );

/** Install a world and point the route's mocked `db` and guards at it. */
function install(w: ReturnType<typeof world>, store: string = MUBARAK) {
  makeDb.current = w.db;
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سامر', role: 'MANAGER' },
    companyId: 'c1',
    storeId: store,
    countryId: 'co1',
    country: { id: 'co1', code: 'SY', currencyCode: 'SYP', minorUnit: 2, allowNegativeStock: false },
  });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: w.order });
  return w;
}

const left = (w: ReturnType<typeof world>, id: string) => w.shelf.find((b) => b.id === id)!.quantityRemaining;
const sold = (w: ReturnType<typeof world>, id: string) => w.shelf.find((b) => b.id === id)!.quantitySold;
const sales = (w: ReturnType<typeof world>) => w.movements.filter((m) => m.type === 'SALE' && m.id !== 'm-prior');

beforeEach(() => {
  vi.clearAllMocks();
  authorize.mockReturnValue({ allowed: true });
  can.mockReturnValue(true);
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  logAudit.mockResolvedValue(undefined);
});

describe('the delivery door takes every unit off the shelf', () => {
  it('walks PAST the first batch — 3 and 8 against an order for 10 leaves 0 and 1', async () => {
    // THE DEFECT, IN ONE ASSERTION. `Math.min(10, 3)` is 3: the old block
    // emptied the oldest batch, stopped, raised nothing, and left the other
    // seven units on the books after the customer had them.
    const w = install(
      world({
        order: orderRow({ quantity: 10 }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 10, freeQuantity: 0 }],
        // Listed NEWEST first on purpose: array order would take 8 out of
        // June and 2 out of March, which is a different pair of remainders
        // from the one asserted below.
        shelf: [
          batch({ id: 'b-june', quantityRemaining: 8, productionDate: new Date('2026-06-01'), costPerUnit: 5 }),
          batch({ id: 'b-march', quantityRemaining: 3, productionDate: new Date('2026-03-01'), costPerUnit: 3 }),
        ],
      })
    );

    const res = await deliver();
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    // Oldest first, and all the way: 3 out of March, 7 out of June.
    expect(left(w, 'b-march')).toBe(0);
    expect(left(w, 'b-june')).toBe(1);
    expect(sold(w, 'b-march')).toBe(3);
    expect(sold(w, 'b-june')).toBe(7);
    // 11 on the shelf, 10 delivered, 1 left. The old block left 8.
    expect(w.shelf.reduce((s, b) => s + b.quantityRemaining, 0)).toBe(1);

    // One ledger line for the whole draw, carrying the whole quantity.
    expect(sales(w)).toHaveLength(1);
    expect(sales(w)[0].quantity).toBe(-10);
    // AND THE BALANCE IS THE BALANCE. The old block wrote
    // `activeBatch.quantityRemaining - deductQty` = 0 here, while the
    // product held 1.
    expect(sales(w)[0].balanceAfter).toBe(1);
    expect(sales(w)[0].balanceAfter).toBe(w.shelf.reduce((s, b) => s + b.quantityRemaining, 0));

    // And the cost is each batch at ITS price: 3×3 + 7×5 = 44, never 10×3
    // and never an average.
    expect(w.orderWrites.some((d) => d.estimatedCostOfGoods === 44)).toBe(true);
  });

  it('and `balanceAfter` is the product’s on hand, not the batch it last touched', async () => {
    // Two units out of batches of 3 and 8: the draw never reaches the second
    // batch, so the old arithmetic (`3 - 2`) wrote 1 while 9 were on the
    // shelf. That row described a balance that did not exist.
    const w = install(
      world({
        order: orderRow({ quantity: 2 }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 2, freeQuantity: 0 }],
        // Newest first again, so the draw's own ordering is what reaches
        // March and leaves June alone.
        shelf: [
          batch({ id: 'b-june', quantityRemaining: 8, productionDate: new Date('2026-06-01') }),
          batch({ id: 'b-march', quantityRemaining: 3, productionDate: new Date('2026-03-01') }),
        ],
      })
    );

    expect((await deliver()).status).toBe(200);
    expect(left(w, 'b-march')).toBe(1);
    expect(left(w, 'b-june')).toBe(8);
    expect(sales(w)[0].balanceAfter).toBe(9);
    expect(sales(w)[0].balanceAfter).not.toBe(1);
  });

  it('and a SALE already in the ledger stops it dead — nothing moves a second time', async () => {
    // THE STATE MEASURED ON THIS DATABASE: 26 orders are DELIVERED or
    // PARTIALLY_DELIVERED with their SALE written, and all 26 still read
    // `status: 'SHIPPED'` because `partial-delivery.ts`, the statement sweep
    // and the write-off door set `shippingStatus` and leave `status` alone.
    // So `status !== previousStatus` is TRUE here — the only guard the old
    // block had — and it deducted again. 52 units of exposure.
    const w = install(
      world({
        order: orderRow({ quantity: 4, shippingStatus: 'DELIVERED' }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 4, freeQuantity: 0 }],
        shelf: [batch({ id: 'b-only', quantityRemaining: 9 })],
        priorSale: true,
      })
    );

    expect((await deliver()).status).toBe(200);

    // The gate the old block relied on DID open: the order's own write for
    // this request carries the new status, so `status !== previousStatus`
    // was true and the deleted block would have run.
    expect(w.order.status).toBe('SHIPPED');
    expect(w.orderWrites.some((d) => d.status === 'DELIVERED')).toBe(true);
    // And still nothing came off the shelf, because the ledger said so.
    expect(left(w, 'b-only')).toBe(9);
    expect(sold(w, 'b-only')).toBe(0);
    expect(sales(w)).toHaveLength(0);
    expect(w.movements.filter((m) => m.type === 'SALE')).toHaveLength(1);
  });

  it('and a PATCH repeated after an EMPTY-shelf delivery takes none of the stock that arrived since (P0-13 review)', async () => {
    // An empty-shelf delivery wrote no SALE, so the ledger key cannot see it; its review line is the key.
    const w = install(
      world({
        order: orderRow({ quantity: 4 }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 4, freeQuantity: 0 }],
        shelf: [],
      })
    );
    expect((await deliver()).status).toBe(200);
    expect(sales(w)).toHaveLength(0);
    w.shelf.push(batch({ id: 'b-late', quantityRemaining: 9 }));

    const again = await consumeOrderStock(w.db as never, { orderId: ORDER, companyId: 'c1', userId: 'u1' });
    expect(again.alreadyDone).toBe(true);
    expect(left(w, 'b-late')).toBe(9);
    expect(sales(w)).toHaveLength(0);
  });

  it('and a second door arriving after this one also moves nothing', async () => {
    // The statement sweep in `/api/finance/statements/[id]` calls the same
    // helper on orders it promotes. An order delivered here and then settled
    // there must be deducted ONCE, and the key is the ledger, not a column.
    const w = install(
      world({
        order: orderRow({ quantity: 4 }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 4, freeQuantity: 0 }],
        shelf: [batch({ id: 'b-only', quantityRemaining: 9 })],
      })
    );

    expect((await deliver()).status).toBe(200);
    expect(left(w, 'b-only')).toBe(5);

    const again = await consumeOrderStock(w.db as never, {
      orderId: ORDER,
      companyId: 'c1',
      userId: 'u1',
    });
    expect(again.alreadyDone).toBe(true);
    expect(again.taken).toBe(0);
    expect(left(w, 'b-only')).toBe(5);
    expect(w.movements.filter((m) => m.type === 'SALE')).toHaveLength(1);
  });

  it('and a TWO-LINE order deducts both lines, not the first product only', async () => {
    // `existing.productId` is one column on a denormalised order; the second
    // line was invisible to the old block and its units never left the shelf.
    const w = install(
      world({
        order: orderRow({ quantity: 2 }),
        items: [
          { productId: CREAM, productName: 'كريم', quantity: 2, freeQuantity: 0 },
          { productId: SOAP, productName: 'صابون', quantity: 4, freeQuantity: 0 },
        ],
        shelf: [
          batch({ id: 'b-cream', productId: CREAM, quantityRemaining: 5 }),
          batch({ id: 'b-soap', productId: SOAP, quantityRemaining: 9 }),
        ],
      })
    );

    expect((await deliver()).status).toBe(200);

    expect(left(w, 'b-cream')).toBe(3);
    expect(left(w, 'b-soap')).toBe(5);
    expect(sold(w, 'b-cream')).toBe(2);
    expect(sold(w, 'b-soap')).toBe(4);

    // One ledger line per line of the order, each naming its own product.
    expect(sales(w)).toHaveLength(2);
    const byProduct = new Map(sales(w).map((m) => [m.productId, m]));
    expect(byProduct.get(CREAM)!.quantity).toBe(-2);
    expect(byProduct.get(SOAP)!.quantity).toBe(-4);
    // And each balance is ITS OWN product's on hand — 3 and 5, two different
    // numbers, so neither can be the other's by accident.
    expect(byProduct.get(CREAM)!.balanceAfter).toBe(3);
    expect(byProduct.get(SOAP)!.balanceAfter).toBe(5);
  });

  it('and a GIFT unit leaves the shelf with the paid ones — 3 + 1 is four units', async () => {
    // Three such orders are on this database. The old block read
    // `existing.quantity`, which is 3, and the gift stayed in stock after it
    // was given away — while `reservation.ts` had HELD all four.
    const w = install(
      world({
        order: orderRow({ quantity: 3, freeQuantity: 1 }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1 }],
        shelf: [batch({ id: 'b-only', quantityRemaining: 10 })],
      })
    );

    expect((await deliver()).status).toBe(200);
    expect(left(w, 'b-only')).toBe(6);
    expect(sold(w, 'b-only')).toBe(4);
    expect(sales(w)[0].quantity).toBe(-4);
    expect(sales(w)[0].balanceAfter).toBe(6);
  });

  /*
   * CHANGED 30/10 (P0-13, OLD → NEW). Old: «a shelf too short to cover the order refuses, rather than
   * under-deducting in silence» — with `allowNegativeStock: false` the draw threw and the whole transaction (status,
   * counters, ledger) went with it, so a parcel in the customer's hands stayed «open». New: the country's flag is
   * asked where a promise is made (confirmation, shipment), not where a delivery is recorded; this door records the
   * delivery whatever the flag says, takes what the shelf has, and says the rest on the order. What the old test
   * protected — «not in silence» — is asserted in the next test.
   */
  it('and a shelf too short to cover the order is still a delivery — the flag does not matter here', async () => {
    const w = install(
      world({
        order: orderRow({ quantity: 10 }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 10, freeQuantity: 0 }],
        shelf: [batch({ id: 'b-only', quantityRemaining: 5 })],
      })
    );

    // allowNegativeStock is FALSE for this country (the world's default) and the door still records it.
    expect((await deliver()).status).toBe(200);
    expect(left(w, 'b-only')).toBe(0);
    expect(sales(w)).toHaveLength(1);
    expect(sales(w)[0].quantity).toBe(-5);
    // …and the five it could not give are on the order, not silent.
    const said = w.activities.filter((a: Row) => a.action === 'STOCK_SHORT_AT_DELIVERY');
    expect(said).toHaveLength(1);
    expect(JSON.parse(said[0].metadata)).toMatchObject({ short: 5 });
  });

  it('and where the country allows it, the shortfall is drawn to zero and recorded', async () => {
    const w = install(
      world({
        order: orderRow({ quantity: 10 }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 10, freeQuantity: 0 }],
        shelf: [batch({ id: 'b-only', quantityRemaining: 5 })],
      })
    );
    requireContext.mockResolvedValue({
      user: { id: 'u1', name: 'سامر', role: 'MANAGER' },
      companyId: 'c1',
      storeId: MUBARAK,
      countryId: 'co1',
      country: { id: 'co1', code: 'SY', currencyCode: 'SYP', minorUnit: 2, allowNegativeStock: true },
    });

    expect((await deliver()).status).toBe(200);
    // Never a negative remainder: the shelf goes to zero and the five units
    // it could not supply are the shortfall, not an invented deduction.
    expect(left(w, 'b-only')).toBe(0);
    expect(sales(w)[0].quantity).toBe(-5);
    expect(sales(w)[0].balanceAfter).toBe(0);
  });
});

describe('and it files that SALE on the order’s own shelf', () => {
  it('writes the order’s store onto the movement — the value, not the word', async () => {
    const w = install(
      world({
        shelf: [
          batch({ id: 'b-m', quantityRemaining: 50 }),
          batch({ id: 'b-s', storeId: SIHHA, quantityRemaining: 50 }),
        ],
      })
    );

    expect((await deliver()).status).toBe(200);
    const row = sales(w)[0];
    // THE VALUE. `undefined` is what this door wrote for as long as the
    // defect existed, and a revert prints exactly that here.
    expect(row.storeId).toBe(MUBARAK);
    expect(row.companyId).toBe('c1');
    expect(row.type).toBe('SALE');
    expect(row.referenceId).toBe(ORDER);
    expect(row.createdById).toBe('u1');
    expect(typeof row.storeId).toBe('string');

    // And it is the SAME store the units came out of: the draw asked the
    // shelf for this store and no other, and the other store's batch is
    // untouched at its full 50.
    const draw = w.shelfQueries.find((q) => q.quantityRemaining)!;
    expect(draw.storeId).toBe(MUBARAK);
    expect(draw.companyId).toBe('c1');
    expect(row.storeId).toBe(draw.storeId);
    expect(left(w, 'b-s')).toBe(50);
    expect(left(w, 'b-m')).toBe(47);
  });

  it('and that store is the one the access guard already matched the context against', async () => {
    const w = install(world({}));
    await deliver();
    // `assertOrderAccess(id, user, { companyId, storeId })` returns NOT_FOUND
    // unless `order.storeId === scope.storeId`, so these two are one value.
    const scope = assertOrderAccess.mock.calls[0][2] as { companyId: string; storeId: string };
    expect(scope).toMatchObject({ companyId: 'c1', storeId: MUBARAK });
    expect(sales(w)[0].storeId).toBe(scope.storeId);
  });

  it('and the row it writes is a row the ledger screen returns — before, it was not', async () => {
    const w = install(world({}));
    await deliver();
    const row = sales(w)[0];

    const mine = inStore('c1', MUBARAK);
    expect(matchesWhere(row, mine)).toBe(true);
    // The row as this door used to write it: the same sale, no shelf. Twenty
    // six of them are on this database.
    expect(matchesWhere({ ...row, storeId: undefined }, mine)).toBe(false);
    expect(matchesWhere({ ...row, storeId: null }, mine)).toBe(false);
    // And it is not handed to another store, which is the same rule working.
    expect(matchesWhere(row, inStore('c1', SIHHA))).toBe(false);
    // Nor to a session with no store selected, answered with the company.
    expect(matchesWhere(row, inStore('c1', null))).toBe(false);
  });

  it('and it follows the order, not a constant', async () => {
    // A session in صحة بلس delivering صحة بلس's order. Both halves move
    // together, because they are the same value.
    const w = install(
      world({
        order: orderRow({ storeId: SIHHA }),
        shelf: [
          batch({ id: 'b-m', quantityRemaining: 50 }),
          batch({ id: 'b-s', storeId: SIHHA, quantityRemaining: 50 }),
        ],
      }),
      SIHHA
    );

    expect((await deliver()).status).toBe(200);
    expect(sales(w)[0].storeId).toBe(SIHHA);
    // And the units came off صحة بلس's batch, not المبارك's.
    expect(left(w, 'b-s')).toBe(47);
    expect(left(w, 'b-m')).toBe(50);
    expect(matchesWhere(sales(w)[0], inStore('c1', SIHHA))).toBe(true);
    expect(matchesWhere(sales(w)[0], inStore('c1', MUBARAK))).toBe(false);
  });

  it('and an order of another store never reaches the write at all', async () => {
    // Which is why `order.storeId` has one possible value here: the guard is
    // what makes the context store and the order's store the same fact.
    const w = install(world({}));
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_FOUND' });
    const res = await deliver();
    expect(res.status).toBe(404);
    expect(w.movements).toHaveLength(0);
    expect(left(w, 'b-only')).toBe(50);
  });

  it('and with no batch to draw from, no ledger line is written', async () => {
    // Nothing moved, so nothing is recorded — a row here would describe a
    // deduction that never happened. The country allows the shortfall, or
    // the draw would refuse instead.
    const w = install(world({ shelf: [] }));
    requireContext.mockResolvedValue({
      user: { id: 'u1', name: 'سامر', role: 'MANAGER' },
      companyId: 'c1',
      storeId: MUBARAK,
      countryId: 'co1',
      country: { id: 'co1', code: 'SY', currencyCode: 'SYP', minorUnit: 2, allowNegativeStock: true },
    });
    expect((await deliver()).status).toBe(200);
    expect(w.movements).toHaveLength(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PRODUCT WITH A FIXED COST IS COSTED AT IT WHEN THE GOODS LEAVE (the owner, 1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… ثابت لكل الطلبات وما يتغير تحت اي ظرف». The complaint was this very overwrite: the order
 * was costed once when it was raised and again, from whichever batches were oldest, when it was delivered — two numbers for one
 * order. Through the real door and the real draw-down: the SHELF is what it always was (the batches, the ledger, the remainders); only
 * the cost WRITTEN ON THE ORDER follows the figure.
 *
 * The batches below cost 3 (March, 3 units) and 5 (June, 8 units): 10 units drawn FIFO cost 3×3 + 7×5 = 44. A product with no
 * figure is written at 44, as ever.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('a fixed cost is what the order is written at, and the shelf is still the shelf’s', () => {
  const march = () => batch({ id: 'b-march', quantityRemaining: 3, productionDate: new Date('2026-03-01'), costPerUnit: 3 });
  const june = () => batch({ id: 'b-june', quantityRemaining: 8, productionDate: new Date('2026-06-01'), costPerUnit: 5 });
  const ten = () => ({
    order: orderRow({ quantity: 10 }),
    items: [{ productId: CREAM, productName: 'كريم', quantity: 10, freeQuantity: 0 }],
    shelf: [june(), march()],
  });
  /** Every cost of goods written on the order during the request — the last one is what stays. */
  const costsWritten = (w: ReturnType<typeof world>) => w.orderWrites.filter((d) => 'estimatedCostOfGoods' in d).map((d) => d.estimatedCostOfGoods);

  it('NO FIGURE: the batches price it, exactly as before — 3×3 + 7×5 = 44', async () => {
    const w = install(world(ten()));
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([44]);
  });

  it('A FIGURE OF 6: the order is written at 10 × 6 = 60, not at the 44 the batches say', async () => {
    const w = install(world({ ...ten(), figures: { [CREAM]: 6 } }));
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([60]);
  });

  it('…and the SHELF is untouched by the figure: the same remainders, the same sold, the same ledger line', async () => {
    const w = install(world({ ...ten(), figures: { [CREAM]: 6 } }));
    expect((await deliver()).status).toBe(200);
    expect(left(w, 'b-march')).toBe(0);
    expect(left(w, 'b-june')).toBe(1);
    expect(sold(w, 'b-march')).toBe(3);
    expect(sold(w, 'b-june')).toBe(7);
    expect(sales(w)).toHaveLength(1);
    expect(sales(w)[0].quantity).toBe(-10);
    // …and no batch's own cost was rewritten: the figure is the ORDER's, the batches keep what they cost.
    expect(w.shelf.find((b) => b.id === 'b-march')!.costPerUnit).toBe(3);
    expect(w.shelf.find((b) => b.id === 'b-june')!.costPerUnit).toBe(5);
  });

  it('A FIGURE WINS OVER BATCHES THAT COST NOTHING: a free batch does not make the order free', async () => {
    const w = install(world({ ...ten(), shelf: [batch({ id: 'b-free', quantityRemaining: 20, costPerUnit: 0 })], figures: { [CREAM]: 6 } }));
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([60]);
  });

  it('ZERO IS A FIGURE: an item that costs nothing is written at 0, not at the 44 of the batches', async () => {
    const w = install(world({ ...ten(), figures: { [CREAM]: 0 } }));
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([0]);
  });

  it('THE GIFT COSTS THE FIGURE TOO: 3 paid + 1 free at 6 is 4 × 6 = 24', async () => {
    const w = install(
      world({
        order: orderRow({ quantity: 3, freeQuantity: 1 }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1 }],
        shelf: [batch({ id: 'b-only', quantityRemaining: 10 })],
        figures: { [CREAM]: 6 },
      })
    );
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([24]);
  });

  it('A MIXED ORDER sums both ways: the cream at its figure (2 × 6), the soap at its batches (4 × 2)', async () => {
    const w = install(
      world({
        order: orderRow({ quantity: 2 }),
        items: [
          { productId: CREAM, productName: 'كريم', quantity: 2, freeQuantity: 0 },
          { productId: SOAP, productName: 'صابون', quantity: 4, freeQuantity: 0 },
        ],
        shelf: [
          batch({ id: 'b-cream', productId: CREAM, quantityRemaining: 5, costPerUnit: 9 }),
          batch({ id: 'b-soap', productId: SOAP, quantityRemaining: 9, costPerUnit: 2 }),
        ],
        figures: { [CREAM]: 6 },
      })
    );
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([20]); // 12 + 8 — not 18 + 8 (the cream's batches) and not 24 + 8 (a figure for both)
  });

  it('A SHORT SHELF keeps the estimate it was raised with, figure or not: nothing is written over it', async () => {
    const w = install(
      world({
        order: orderRow({ quantity: 10 }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 10, freeQuantity: 0 }],
        shelf: [batch({ id: 'b-only', quantityRemaining: 5 })],
        figures: { [CREAM]: 6 },
      })
    );
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([]);
  });

  it('AN EMPTY SHELF writes no cost either — nothing left, so nothing is priced', async () => {
    const w = install(world({ ...ten(), shelf: [], figures: { [CREAM]: 6 } }));
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([]);
  });

  it('A DELIVERY ALREADY RECORDED does nothing twice: a second door finds the sale and writes no cost and reads no figure', async () => {
    const w = install(world({ ...ten(), figures: { [CREAM]: 6 } }));
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([60]);
    w.figureQueries.length = 0;
    w.orderWrites.length = 0;
    const again = await consumeOrderStock(w.db as never, { orderId: ORDER, companyId: 'c1', userId: 'u1' });
    expect(again.alreadyDone).toBe(true);
    expect(costsWritten(w)).toEqual([]);
    expect(w.figureQueries).toEqual([]);
  });

  it('THE FIGURE IS ASKED FOR THIS COMPANY’S PRODUCTS IN THE ORDER, once for the whole parcel', async () => {
    const w = install(
      world({
        order: orderRow({ quantity: 2 }),
        items: [
          { productId: CREAM, productName: 'كريم', quantity: 2, freeQuantity: 0 },
          { productId: SOAP, productName: 'صابون', quantity: 4, freeQuantity: 0 },
          { productId: CREAM, productName: 'كريم', quantity: 1, freeQuantity: 0 },
        ],
        shelf: [
          batch({ id: 'b-cream', productId: CREAM, quantityRemaining: 5 }),
          batch({ id: 'b-soap', productId: SOAP, quantityRemaining: 9 }),
        ],
        figures: { [CREAM]: 6 },
      })
    );
    expect((await deliver()).status).toBe(200);
    expect(w.figureQueries).toEqual([{ companyId: 'c1', productId: { in: [CREAM, SOAP] } }]);
  });

  it('A SECOND LINE OF THE SAME PRODUCT costs the figure as well: 2 + 1 cream at 6 and 4 soap at 2 is 18 + 8', async () => {
    const w = install(
      world({
        order: orderRow({ quantity: 2 }),
        items: [
          { productId: CREAM, productName: 'كريم', quantity: 2, freeQuantity: 0 },
          { productId: SOAP, productName: 'صابون', quantity: 4, freeQuantity: 0 },
          { productId: CREAM, productName: 'كريم', quantity: 1, freeQuantity: 0 },
        ],
        shelf: [
          batch({ id: 'b-cream', productId: CREAM, quantityRemaining: 5, costPerUnit: 9 }),
          batch({ id: 'b-soap', productId: SOAP, quantityRemaining: 9, costPerUnit: 2 }),
        ],
        figures: { [CREAM]: 6 },
      })
    );
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([26]);
  });

  it('THE CURRENCY ROUNDS IT: 3 × 1.1117 = 3.3351 is written as 3.34 (the world’s currency has two places)', async () => {
    const w = install(
      world({
        order: orderRow({ quantity: 3 }),
        items: [{ productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 0 }],
        shelf: [batch({ id: 'b-only', quantityRemaining: 10 })],
        figures: { [CREAM]: 1.1117 },
      })
    );
    expect((await deliver()).status).toBe(200);
    expect(costsWritten(w)).toEqual([3.34]);
  });
});

describe('and the hand-rolled deduction does not grow back', () => {
  /*
   * ONE source assertion, and it is about ROT, not about behaviour: every
   * rule above is asserted in quantities. This exists because the block that
   * was deleted is the kind of thing a later edit re-adds «just for the
   * legacy column», and the quantities would then still pass — the helper
   * would run AND the hand-rolled arithmetic beside it.
   */
  it('the single-batch arithmetic is gone from the route', async () => {
    const { repoFile, stripComments } = await import('@/lib/guard-source');
    const route = stripComments(repoFile('src/app/api/orders/[id]/route.ts'));
    expect(route).not.toMatch(/Math\.min\(existing\.quantity/);
    expect(route).not.toMatch(/activeBatch/);
    expect(route).toMatch(/await consumeOrderStock\(tx, \{/);
  });
});
