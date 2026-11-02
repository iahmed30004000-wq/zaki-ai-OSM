import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN APPROVED LINES EDIT ON A POSTPONED ORDER DOES NOT TAKE BACK THE STOCK THE POSTPONEMENT GAVE BACK (RV635).
 *
 * The owner: «وما تحجز رصيد الا بعد ما اشيلو من التأجيل وارجعو لانشاء شحنة». The hold door releases the units of an
 * order postponed before it left the warehouse, and takes them again only when the hold is lifted. The lines save
 * reserved again on any approved quantity change, held or not: ORD-1 postponed (4 units back on the shelf), 4 → 5
 * approved, and 5 were reserved while it still sat postponed.
 *
 * The REAL `PATCH /api/orders/[id]` and the REAL `POST /api/ops/shipments/hold`, over one fake database (the harness of
 * `an-approved-lines-edit-is-written-whole.test.ts`, with the two order calls the hold door makes).
 * ═══════════════════════════════════════════════════════════════════════
 */
type Row = Record<string, any>;

const { fake, requireContext, logAudit, notify, activeOffersFor, adapterFor, can, authorize } = vi.hoisted(() => {
  const fake = {
    order: {} as Row,
    lines: [] as Row[],
    products: [] as Row[],
    addOns: [] as Row[],
    /** Units physically on the shelf, per product. */
    shelf: {} as Record<string, number>,
    /** Units other orders hold, per product. */
    elsewhere: {} as Record<string, number>,
    /** What one unit of a product cost, per product. */
    costs: {} as Record<string, number>,
    /** The FIXED COST an admin set for a product (`ProductFixedCost`) — none, unless a test says so. */
    figures: {} as Record<string, number>,
    request: {} as Row,
    batch: null as Row | null,
    offerRow: null as Row | null,
    provider: { id: 'co1', name: 'أرامكس', code: 'ARAMEX', adapterCode: 'x', apiEnabled: true, apiConfig: null, apiCredentials: null } as Row,
    claims: 0,
    activities: [] as Row[],
    notes: [] as Row[],
    customerWrites: [] as Row[],
    /** `model.method` of every write, in order. */
    writes: [] as string[],
    hooks: {} as Record<string, () => void>,
    db: null as any,
    tx: null as any,
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === 'AND') return (want as Row[]).every((w) => matches(row, w));
      if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
      if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
        const value = row[key];
        if ('in' in want && !(want.in as unknown[]).includes(value)) return false;
        if ('gt' in want && !(typeof value === 'number' && value > want.gt)) return false;
        if ('not' in want && value === want.not) return false;
        return true;
      }
      return row[key] === want;
    });

  const pick = (row: Row, select?: Row): Row =>
    !select ? { ...row } : Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));

  const WRITE = new Set(['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert']);
  let newLine = 0;

  const models: Record<string, Record<string, (args: Row) => unknown>> = {
    order: {
      findUnique: () => ({ ...fake.order }),
      // The hold door's two calls: it reads the order, then writes it on the version it read.
      findFirst: ({ where, select }) => (where.id === fake.order.id ? pick(fake.order, select) : null),
      update: ({ where, data, select }) => {
        if (where.id !== fake.order.id || (where.version !== undefined && where.version !== fake.order.version)) {
          throw Object.assign(new Error('fake db: record not found'), { code: 'P2025' });
        }
        const { version, ...columns } = data;
        Object.assign(fake.order, columns);
        if (version?.increment) fake.order.version += version.increment;
        return pick(fake.order, select);
      },
      updateMany: ({ where, data }) => {
        if (where.id !== fake.order.id) return { count: 0 };
        if (where.version !== undefined && where.version !== fake.order.version) return { count: 0 };
        if (where.trackingNumber !== undefined && where.trackingNumber !== fake.order.trackingNumber) return { count: 0 };
        const { version, ...columns } = data;
        Object.assign(fake.order, columns);
        if (version?.increment) fake.order.version += version.increment;
        return { count: 1 };
      },
    },
    orderItem: {
      findMany: ({ where, select }) => fake.lines.filter((l) => matches(l, where)).map((l) => pick(l, select)),
      findFirst: ({ where, select }) => {
        const hit = fake.lines.find((l) => matches(l, where));
        return hit ? pick(hit, select) : null;
      },
      deleteMany: ({ where }) => {
        const kept = fake.lines.filter((l) => !matches(l, where));
        const count = fake.lines.length - kept.length;
        fake.lines = kept;
        return { count };
      },
      createMany: ({ data }) => {
        fake.hooks.beforeCreateMany?.();
        for (const row of data as Row[]) {
          newLine += 1;
          fake.lines.push({ id: `line-new-${newLine}`, createdAt: new Date(1), reservedQty: 0, deliveredQty: null, returnedQty: null, ...row });
        }
        return { count: (data as Row[]).length };
      },
      update: ({ where, data }) => {
        const hit = fake.lines.find((l) => l.id === where.id);
        if (!hit) throw new Error('fake db: orderItem.update on a line that is not there');
        Object.assign(hit, data);
        return { ...hit };
      },
      // `releaseOrderLines`: the hold door gives the lines' units back.
      updateMany: ({ where, data }) => {
        const hit = fake.lines.filter((l) => matches(l, where));
        for (const l of hit) Object.assign(l, data);
        return { count: hit.length };
      },
      // `reservedElsewhere`: what OTHER orders hold of one product.
      aggregate: ({ where }) => ({ _sum: { reservedQty: fake.elsewhere[where.productId] ?? 0 } }),
    },
    orderAddOn: {
      findMany: ({ where }) => fake.addOns.filter((a) => matches(a, where)).map((a) => ({ ...a })),
      update: ({ where, data }) => Object.assign(fake.addOns.find((a) => a.id === where.id)!, data),
      updateMany: ({ where, data }) => {
        const hit = fake.addOns.filter((a) => matches(a, where));
        for (const a of hit) Object.assign(a, data);
        return { count: hit.length };
      },
      aggregate: () => ({ _sum: { reservedQty: 0 } }),
    },
    product: {
      findMany: ({ where, select }) => {
        if (!select?.basePrice) fake.hooks.onLateProductRead?.();
        return fake.products.filter((p) => matches(p, where)).map((p) => pick(p, select));
      },
    },
    productionBatch: {
      aggregate: ({ where }) => ({ _sum: { quantityRemaining: fake.shelf[where.productId] ?? 0 } }),
      findMany: ({ where }) =>
        (where.productId.in as string[])
          .filter((id) => (fake.shelf[id] ?? 0) > 0)
          .map((id) => ({ productId: id, quantityRemaining: fake.shelf[id], costPerUnit: fake.costs[id] ?? 0 })),
    },
    // The fixed figures, answered the way the table does: this company's, for the products asked, and only the ones that have a row.
    productFixedCost: {
      findMany: ({ where }) =>
        Object.entries(fake.figures)
          // 'company-0001' is `COMPANY` below — hoisted code cannot see the constant, so the figure's company is spelled out here.
          .filter(([productId]) => where.companyId === 'company-0001' && (where.productId.in as string[]).includes(productId))
          .map(([productId, amount]) => ({ productId, amount })),
    },
    offer: { findFirst: () => fake.offerRow },
    shippingBatch: { findFirst: () => fake.batch },
    settlementMatch: { count: () => fake.claims },
    orderChangeRequest: {
      findFirst: ({ where }) => (where.id === fake.request.id ? { ...fake.request } : null),
      updateMany: ({ where, data }) => {
        // only what the filter asks: a write without `appliedAt: null` would stamp over the winner's name
        if (where.id !== fake.request.id || (where.appliedAt === null && fake.request.appliedAt)) return { count: 0 };
        Object.assign(fake.request, data);
        return { count: 1 };
      },
    },
    orderActivity: {
      create: ({ data }) => {
        fake.activities.push(data);
        return { id: `activity-${fake.activities.length}`, ...data };
      },
    },
    orderNote: {
      create: ({ data }) => {
        fake.notes.push(data);
        return data;
      },
    },
    orderStatusLog: { create: ({ data }) => data },
    deliveryProvider: { findFirst: () => fake.provider },
    customer: {
      update: ({ data }) => {
        fake.customerWrites.push(data);
        return data;
      },
      /*
       * The customer as the request found her (30/10): a request whose every value is already on the order is not stamped
       * «applied», so the route reads her row to tell a new name from the same one. The name the requests below start from.
       */
      findUnique: () => ({ fullName: 'أحمد', address: null, city: null, phone: '0790000001', rawPhone: '0790000001', altPhone: null }),
    },
  };

  const client = (withTransaction: boolean) => {
    const held: Row = {};
    for (const [name, methods] of Object.entries(models)) {
      held[name] = Object.fromEntries(
        Object.entries(methods).map(([method, answer]) => [
          method,
          async (args: Row = {}) => {
            if (WRITE.has(method)) fake.writes.push(`${name}.${method}`);
            return answer(args);
          },
        ])
      );
    }
    held.$executeRaw = async () => 0; // the advisory locks of `reserveOrderLines`
    if (withTransaction) {
      held.$transaction = async (fn: (t: unknown) => Promise<unknown>) => {
        fake.hooks.atTxStart?.();
        const before = {
          order: { ...fake.order },
          lines: fake.lines.map((l) => ({ ...l })),
          addOns: fake.addOns.map((a) => ({ ...a })),
          activities: [...fake.activities],
          notes: [...fake.notes],
          request: { ...fake.request },
        };
        try {
          return await fn(fake.tx);
        } catch (e) {
          fake.order = before.order;
          fake.lines = before.lines;
          fake.addOns = before.addOns;
          fake.activities = before.activities;
          fake.notes = before.notes;
          fake.request = before.request;
          throw e;
        }
      };
    }
    return new Proxy(held, {
      get: (target, key) => {
        if (typeof key === 'symbol' || key === 'then') return undefined;
        if (key in target) return target[key];
        throw new Error(`fake db: «${key}» is not modelled`);
      },
    });
  };

  fake.db = client(true);
  fake.tx = client(false);

  return {
    fake,
    requireContext: vi.fn(),
    logAudit: vi.fn(),
    notify: vi.fn(),
    activeOffersFor: vi.fn<(...a: unknown[]) => Promise<Row[]>>(),
    adapterFor: vi.fn(),
    can: vi.fn(),
    authorize: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db: fake.db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/authorization', () => ({
  authorize: (...a: unknown[]) => authorize(...a),
  can: (...a: unknown[]) => can(...a),
  requirePermission: async () => undefined,
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
}));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: async () => ({ allowed: true, order: { ...fake.order } }),
  orderVisibilityWhere: () => ({}),
}));
// What is on sale is the test's to say: nothing, unless a test says otherwise.
vi.mock('@/lib/offers', async (original) => ({
  ...(await original<typeof import('@/lib/offers')>()),
  activeOffersFor: (...a: unknown[]) => activeOffersFor(...a),
}));
vi.mock('@/lib/couriers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adapterFor: (...a: unknown[]) => adapterFor(...a),
}));

import { PATCH } from './route';
import { POST as HOLD } from '@/app/api/ops/shipments/hold/route';

const COMPANY = 'company-0001';
const STORE = 'store-0001';
const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';
const DROPS = 'prod-drops-0003';

const JOD = { id: 'country-jo', code: 'JO', currencyCode: 'JOD', minorUnit: 3, allowNegativeStock: false };
const IN_THREE_DAYS = () => new Date(Date.now() + 3 * 86_400_000);

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );
const hold = (body: unknown) =>
  HOLD(new Request('http://localhost/api/ops/shipments/hold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

/** The approved request, carried out on the version the order is at now. */
const apply = () => patch({ expectedVersion: fake.order.version, changeRequestId: REQUEST_ID });

const line = (over: Row): Row => ({
  companyId: COMPANY, orderId: ORDER_ID, discountShare: 0, reservedQty: 0, deliveredQty: null, returnedQty: null,
  addedById: 'agent-1', addedStage: 'INTAKE', createdAt: new Date(0), freeQuantity: 0, ...over,
});

/**
 * ORD-1, confirmed, not yet on a trolley: كريم 4 for 48, صابون 2 for 10, an add-on (قطرة) of 4, 2.500 to deliver —
 * 64.500 collected. Every unit reserved: 4 + 2 on the lines, 1 on the add-on — or none, when a hold gave them back.
 */
const seed = (over: { order?: Row; stock?: 'RESERVED' | 'RELEASED' } = {}) => {
  const released = over.stock === 'RELEASED';
  fake.order = {
    id: ORDER_ID, orderNumber: 'ORD-1', companyId: COMPANY, storeId: STORE, countryId: JOD.id, customerId: 'cu1',
    productId: CREAM, productNameSnapshot: 'كريم', quantity: 6, freeQuantity: 0, sellingPrice: 58, discountAmount: 0,
    shippingCost: 2.5, deliveryFee: null, totalAmount: 64.5, priceIncludesDelivery: false, estimatedCostOfGoods: 0,
    version: 3, status: 'CONFIRMED', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_SHIPPING',
    settlementStatus: 'NOT_APPLICABLE', shippedAt: null, labelPrintedAt: null, trackingNumber: null,
    courierSendStartedAt: null, shippingBatchId: null, deliveryProviderId: null, moderatorId: null, claimedById: null,
    lockedById: null, lockExpiresAt: null, offerId: null, regionId: null, customerNotes: null,
    shipHoldUntil: null, shipHoldReason: null,
    ...over.order,
  };
  fake.lines = [
    line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 4, unitPrice: 12, lineTotal: 48, reservedQty: released ? 0 : 4 }),
    line({ id: 'line-soap-02', productId: SOAP, productName: 'صابون', quantity: 2, unitPrice: 5, lineTotal: 10, reservedQty: released ? 0 : 2 }),
  ];
  fake.addOns = [
    { id: 'addon-01', companyId: COMPANY, orderId: ORDER_ID, productId: DROPS, productName: 'قطرة', quantity: 1, price: 4, reservedQty: released ? 0 : 1 },
  ];
  fake.products = [CREAM, SOAP, DROPS].map((id) => ({
    id, companyId: COMPANY, name: ({ [CREAM]: 'كريم', [SOAP]: 'صابون', [DROPS]: 'قطرة' } as Record<string, string>)[id], basePrice: id === SOAP ? 5 : 12, status: 'ACTIVE',
  }));
  fake.shelf = { [CREAM]: 50, [SOAP]: 50, [DROPS]: 50 };
  fake.elsewhere = {};
  fake.costs = { [CREAM]: 2.5, [SOAP]: 1.2, [DROPS]: 1 };
  fake.figures = {};
  fake.batch = null;
  fake.offerRow = null;
  fake.claims = 0;
  fake.activities = [];
  fake.notes = [];
  fake.customerWrites = [];
  fake.writes = [];
  fake.hooks = {};
};

/** The postponement as the hold door leaves an order it released: a date, and nothing reserved. */
const postponed = (until: Date = IN_THREE_DAYS()) => seed({ order: { shipHoldUntil: until, shipHoldReason: 'الزبون مسافر' }, stock: 'RELEASED' });

/** Approved: كريم 4 for 48 → 5 for 60. 60 + 10 + 4 + 2.500 = 76.500. */
const approveCream5 = () => {
  fake.request = {
    id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, reason: 'الزبون بدو يزيد', decisionNote: 'موافق',
    requestedById: 'agent-1',
    changes: {
      lines: {
        v: 2,
        edits: [{ lineId: 'line-cream-01', quantity: { from: 4, to: 5 }, lineTotal: { from: 48, to: 60 } }],
        snapshot: { after: { cod: 76.5 } },
      },
    },
  };
};

const reserved = () => ({
  cream: fake.lines.filter((l) => l.productId === CREAM).reduce((s, l) => s + l.reservedQty, 0),
  soap: fake.lines.filter((l) => l.productId === SOAP).reduce((s, l) => s + l.reservedQty, 0),
  addOn: fake.addOns[0].reservedQty,
});
const without = (row: Row, ...keys: string[]): Row => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
/** Everything the write left on the lines and the order except where the stock is and the hold columns: the money and the goods. */
const moneyAndGoods = () => ({
  // (a rewritten line's id is the fake's counter, which says only how many tests ran before)
  lines: fake.lines.map((l) => without(l, 'id', 'reservedQty')),
  order: without(fake.order, 'shipHoldUntil', 'shipHoldReason', 'version'),
});
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'owner', name: 'المالك', role: 'COMPANY_ADMIN' }, companyId: COMPANY, storeId: STORE, countryId: JOD.id, country: JOD,
  });
  can.mockImplementation(() => true);
  authorize.mockReturnValue({ allowed: false, reason: 'OUT_OF_SCOPE' });
  logAudit.mockResolvedValue(undefined);
  notify.mockResolvedValue(undefined);
  activeOffersFor.mockResolvedValue([]);
  adapterFor.mockReturnValue({ automated: false, code: 'MANUAL', name: 'يدوي' });
  seed();
  approveCream5();
});

/*
 * What `main` (b6771dff) writes for the SAME approved edit on ORD-1 when it is NOT postponed — captured by running this
 * file against main's route before the fix. The fix must leave every column of it as it was.
 */
const MAIN_WROTE_NOT_HELD = {
  lines: [
    {
      createdAt: '1970-01-01T00:00:00.001Z',
      reservedQty: 5,
      deliveredQty: null,
      returnedQty: null,
      companyId: 'company-0001',
      orderId: '11111111-2222-4333-8444-555555555555',
      productId: 'prod-cream-0001',
      productName: 'كريم',
      quantity: 5,
      freeQuantity: 0,
      unitPrice: 12,
      discountShare: 0,
      lineTotal: 60,
      addedById: 'agent-1',
      addedStage: 'INTAKE',
    },
    {
      createdAt: '1970-01-01T00:00:00.001Z',
      reservedQty: 2,
      deliveredQty: null,
      returnedQty: null,
      companyId: 'company-0001',
      orderId: '11111111-2222-4333-8444-555555555555',
      productId: 'prod-soap-00002',
      productName: 'صابون',
      quantity: 2,
      freeQuantity: 0,
      unitPrice: 5,
      discountShare: 0,
      lineTotal: 10,
      addedById: 'agent-1',
      addedStage: 'INTAKE',
    },
  ],
  addOns: [
    {
      id: 'addon-01',
      companyId: 'company-0001',
      orderId: '11111111-2222-4333-8444-555555555555',
      productId: 'prod-drops-0003',
      productName: 'قطرة',
      quantity: 1,
      price: 4,
      reservedQty: 1,
    },
  ],
  order: {
    id: '11111111-2222-4333-8444-555555555555',
    orderNumber: 'ORD-1',
    companyId: 'company-0001',
    storeId: 'store-0001',
    countryId: 'country-jo',
    customerId: 'cu1',
    productId: 'prod-cream-0001',
    productNameSnapshot: 'كريم',
    quantity: 7,
    freeQuantity: 0,
    sellingPrice: 70,
    discountAmount: 0,
    shippingCost: 2.5,
    deliveryFee: null,
    totalAmount: 76.5,
    priceIncludesDelivery: false,
    estimatedCostOfGoods: 0,
    version: 4,
    status: 'CONFIRMED',
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'READY_FOR_SHIPPING',
    settlementStatus: 'NOT_APPLICABLE',
    shippedAt: null,
    labelPrintedAt: null,
    trackingNumber: null,
    courierSendStartedAt: null,
    shippingBatchId: null,
    deliveryProviderId: null,
    moderatorId: null,
    claimedById: null,
    lockedById: null,
    lockExpiresAt: null,
    offerId: null,
    regionId: null,
    customerNotes: null,
    shipHoldUntil: null,
    shipHoldReason: null,
  },
  writes: [
    'order.updateMany',
    'orderChangeRequest.updateMany',
    'orderItem.deleteMany',
    'orderItem.createMany',
    'orderItem.update',
    'orderActivity.create',
  ],
};

describe('Ⅰ · ORD-1, postponed — the edit changes the lines and reserves nothing', () => {
  it('4 → 5 approved while postponed: the lines say 5, the total follows, and nothing is reserved', async () => {
    postponed();
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.lines.find((l) => l.productId === CREAM)).toMatchObject({ quantity: 5, lineTotal: 60 });
    expect(fake.order).toMatchObject({ totalAmount: 76.5, quantity: 7 });
    // the whole order stays as the postponement left it: not the cream, not the soap, not the add-on
    expect(reserved()).toEqual({ cream: 0, soap: 0, addOn: 0 });
    expect(fake.writes.filter((w) => w === 'orderItem.update' || w.startsWith('orderAddOn'))).toEqual([]);
    // still postponed
    expect(fake.order.shipHoldUntil).toBeInstanceOf(Date);
  });

  it('a passed hold date that nobody lifted is still a hold: the edit reserves nothing («أرجِعه» does)', async () => {
    postponed(new Date(Date.now() - 86_400_000));
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.lines.find((l) => l.productId === CREAM)?.quantity).toBe(5);
    expect(reserved()).toEqual({ cream: 0, soap: 0, addOn: 0 });
  });

  it('the money and the goods it writes are exactly those of the same edit on an order that is not held', async () => {
    expect((await apply()).status).toBe(200);
    const notHeld = plain(moneyAndGoods());
    postponed();
    approveCream5();
    expect((await apply()).status).toBe(200);
    expect(plain(moneyAndGoods())).toEqual(notHeld);
  });

  it('the shelf is still asked at the write, as before: a growth it can no longer cover stops the edit and nothing is written', async () => {
    postponed();
    // between the plan and the write, all the cream but 4 is taken by other orders: 5 do not fit
    fake.hooks.atTxStart = () => {
      fake.elsewhere[CREAM] = 46;
    };
    const before = plain({ lines: fake.lines, addOns: fake.addOns, order: fake.order });
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STOCK_SHORT');
    expect(plain({ lines: fake.lines, addOns: fake.addOns, order: fake.order })).toEqual(before);
    expect(fake.request.appliedAt).toBeNull();
  });
});

describe('Ⅱ · the hold ends — the goods are taken per the lines as they are now', () => {
  it('ORD-1 through the real doors: postponed (4 back) → 4 → 5 (still 0) → «أرجِعه» (5 + 2 + 1 reserved)', async () => {
    // reserved as confirmed
    expect(reserved()).toEqual({ cream: 4, soap: 2, addOn: 1 });

    const set = await hold({ orderId: ORDER_ID, until: IN_THREE_DAYS().toISOString(), reason: 'الزبون مسافر' });
    expect(set.status, await set.clone().text()).toBe(200);
    expect(reserved()).toEqual({ cream: 0, soap: 0, addOn: 0 });
    expect(fake.order.shipHoldUntil).toBeInstanceOf(Date);

    const edited = await apply();
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(fake.lines.find((l) => l.productId === CREAM)?.quantity).toBe(5);
    expect(reserved()).toEqual({ cream: 0, soap: 0, addOn: 0 });

    const lifted = await hold({ orderId: ORDER_ID, release: true });
    expect(lifted.status, await lifted.clone().text()).toBe(200);
    expect(fake.order.shipHoldUntil).toBeNull();
    // the new five, not the old four
    expect(reserved()).toEqual({ cream: 5, soap: 2, addOn: 1 });
  });
});

describe('Ⅲ · a postponed parcel that KEPT its goods — today’s rule, unchanged', () => {
  it('packed and labelled, taken off a trolley: its 4 stay reserved, and 4 → 5 reserves the fifth, as before', async () => {
    seed({
      order: {
        shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date('2026-11-01T08:00:00Z'),
        shipHoldUntil: IN_THREE_DAYS(), shipHoldReason: 'الزبون مسافر',
      },
    });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.lines.find((l) => l.productId === CREAM)?.quantity).toBe(5);
    expect(reserved()).toEqual({ cream: 5, soap: 2, addOn: 1 });
  });

  it('packed, its hold lifted back to the out-tray (the date set to now): the same', async () => {
    seed({ order: { shippingStatus: 'READY_FOR_PICKUP', shipHoldUntil: new Date() } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(reserved()).toEqual({ cream: 5, soap: 2, addOn: 1 });
  });
});

describe('Ⅳ · an order that is not held — exactly what main writes', () => {
  it('the same edit reserves the fifth unit, and every column it writes is main’s', async () => {
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(reserved()).toEqual({ cream: 5, soap: 2, addOn: 1 });
    const wrote = plain({ lines: fake.lines.map((l) => without(l, 'id')), addOns: fake.addOns, order: fake.order, writes: fake.writes });
    expect(wrote).toEqual(MAIN_WROTE_NOT_HELD);
  });
});
