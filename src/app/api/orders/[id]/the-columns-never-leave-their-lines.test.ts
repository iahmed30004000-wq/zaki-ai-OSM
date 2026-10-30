import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER'S COLUMNS NEVER LEAVE ITS LINES — AND A REQUEST THAT CHANGES NOTHING IS NOT «APPLIED».
 *
 * ORD-2026-0733, measured on production (older code): the order's columns read «quantity 10, price 100» while its one line
 * still read 1 × 15. The shipping screen prices the parcel from the LINES (`codForOrder`) and asked for 15; the shelf held
 * one unit. On `main` the approved-request door already writes the lines (`planLineApply`); two small holes were left:
 *
 *   (1) the DIRECT door's single-line shorthand (`quantity` / `sellingPrice` / `productId` with no `items`) wrote the
 *       order's columns and never a line;
 *   (2) an approved request whose values the order already holds was written as the same figures and stamped «مطبَّق».
 *
 * The owner: «اي قرار بعد الان اتخذو دون الرجوع الي». Decided the cautious way (see the route and `order-line-apply.ts`):
 * the shorthand may not move the goods of an order that has lines (`LINES_REQUIRED` — every screen sends `items`), may not
 * write over columns that already disagree with the lines (`COD_DRIFT` by the preview's own rule, `FEE_SOURCE_DRIFT`,
 * `LINES_DRIFT`), and a request that would change nothing is refused (`NOTHING_TO_APPLY`) and not stamped.
 *
 * The route is the REAL `PATCH /api/orders/[id]` with the real plan, engine, reserver and `computeCod`. Only the database
 * is a fake — it holds the order, its lines, the shelf and the request, rolls a transaction back when it throws, and LOGS
 * EVERY WRITE, so a refusal can be shown to have written nothing. Three-place JOD; every figure is worked beside it.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const { fake, requireContext, logAudit, notify, activeOffersFor, can, authorize } = vi.hoisted(() => {
  const fake = {
    order: {} as Row,
    lines: [] as Row[],
    products: [] as Row[],
    addOns: [] as Row[],
    shelf: {} as Record<string, number>,
    customer: null as Row | null,
    request: {} as Row,
    batch: null as Row | null,
    claims: 0,
    activities: [] as Row[],
    customerWrites: [] as Row[],
    /** `model.method` of every write, in order. */
    writes: [] as string[],
    db: null as any,
    tx: null as any,
  };

  const matches = (row: Row, where: Row = {}): boolean =>
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
      updateMany: ({ where, data }) => {
        if (where.id !== fake.order.id) return { count: 0 };
        if (where.version !== undefined && where.version !== fake.order.version) return { count: 0 };
        const { version, ...columns } = data;
        Object.assign(fake.order, columns);
        if (version?.increment) fake.order.version += version.increment;
        return { count: 1 };
      },
    },
    orderItem: {
      findMany: ({ where, select }) => fake.lines.filter((l) => matches(l, where)).map((l) => pick(l, select)),
      // `skip`: the route asks for the line AFTER the first (by id) to tell one line from two.
      findFirst: ({ where, select, skip }) => {
        const hits = fake.lines.filter((l) => matches(l, where)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const hit = hits[skip ?? 0];
        return hit ? pick(hit, select) : null;
      },
      deleteMany: ({ where }) => {
        const kept = fake.lines.filter((l) => !matches(l, where));
        const count = fake.lines.length - kept.length;
        fake.lines = kept;
        return { count };
      },
      createMany: ({ data }) => {
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
      // what OTHER orders hold of one product: nothing here
      aggregate: () => ({ _sum: { reservedQty: 0 } }),
    },
    orderAddOn: {
      findMany: ({ where }) => fake.addOns.filter((a) => matches(a, where)).map((a) => ({ ...a })),
      aggregate: () => ({ _sum: { reservedQty: 0 } }),
    },
    product: {
      findMany: ({ where, select }) => fake.products.filter((p) => matches(p, where)).map((p) => pick(p, select)),
    },
    productionBatch: {
      aggregate: ({ where }) => ({ _sum: { quantityRemaining: fake.shelf[where.productId] ?? 0 } }),
      findMany: ({ where }) =>
        (where.productId.in as string[])
          .filter((id) => (fake.shelf[id] ?? 0) > 0)
          .map((id) => ({ productId: id, quantityRemaining: fake.shelf[id], costPerUnit: 0 })),
    },
    offer: { findFirst: () => null },
    shippingBatch: { findFirst: () => fake.batch },
    settlementMatch: { count: () => fake.claims },
    orderChangeRequest: {
      findFirst: ({ where }) => (where.id === fake.request.id ? { ...fake.request } : null),
      updateMany: ({ where, data }) => {
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
    orderStatusLog: { create: ({ data }) => data },
    customer: {
      findUnique: () => (fake.customer ? { ...fake.customer } : null),
      update: ({ data }) => {
        fake.customerWrites.push(data);
        if (fake.customer) Object.assign(fake.customer, data);
        return data;
      },
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
        const before = {
          order: { ...fake.order },
          lines: fake.lines.map((l) => ({ ...l })),
          activities: [...fake.activities],
          request: { ...fake.request },
        };
        try {
          return await fn(fake.tx);
        } catch (e) {
          fake.order = before.order;
          fake.lines = before.lines;
          fake.activities = before.activities;
          fake.request = before.request;
          throw e;
        }
      };
    }
    return new Proxy(held, {
      get: (target, key) => {
        if (typeof key === 'symbol' || key === 'then') return undefined;
        if (key in target) return target[key];
        throw new Error(`fake db: «${String(key)}» is not modelled`);
      },
    });
  };

  fake.db = client(true);
  fake.tx = client(false);

  return {
    fake,
    requireContext: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
    logAudit: vi.fn<(...a: unknown[]) => Promise<void>>(),
    notify: vi.fn<(...a: unknown[]) => void>(),
    activeOffersFor: vi.fn<(...a: unknown[]) => Promise<Row[]>>(),
    can: vi.fn<(user: unknown, key: string) => boolean>(),
    authorize: vi.fn<(...a: unknown[]) => { allowed: boolean; reason?: string }>(),
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
  can: (user: unknown, key: string) => can(user, key),
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
}));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: async () => ({ allowed: true, order: { ...fake.order } }),
  orderVisibilityWhere: () => ({}),
}));
vi.mock('@/lib/offers', async (original) => ({
  ...(await original<typeof import('@/lib/offers')>()),
  activeOffersFor: (...a: unknown[]) => activeOffersFor(...a),
}));

import { PATCH } from './route';
import { codForOrder } from '@/lib/delivery-fees';
import { changedKeys, columnsDrift } from '@/lib/order-line-apply';
import { repoFile, stripComments } from '@/lib/guard-source';

const COMPANY = 'company-0001';
const STORE = 'store-0001';
const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';
const JOD = { id: 'country-jo', code: 'JO', currencyCode: 'JOD', minorUnit: 3, allowNegativeStock: false };
const WHY = 'الزبون طلب عشر قطع على التلفون';

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );

/** The direct door, as a hand-written call would knock on it: the version, a reason, and the fields. */
const direct = (fields: Row) => patch({ expectedVersion: 3, reason: WHY, ...fields });
/** The request door: the id and the version, nothing else. */
const apply = () => patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

const line = (over: Row): Row => ({
  companyId: COMPANY, orderId: ORDER_ID, discountShare: 0, reservedQty: 0, deliveredQty: null, returnedQty: null,
  addedById: 'agent-1', addedStage: 'INTAKE', createdAt: new Date(0), freeQuantity: 0, ...over,
});

/** ONE line: كريم 1 × 15, 2.500 to deliver — 17.500 collected. Not yet confirmed: the direct door is the right door. */
const seed = (over: { order?: Row; lines?: Row[] } = {}) => {
  fake.order = {
    id: ORDER_ID, orderNumber: 'ORD-2026-0733', companyId: COMPANY, storeId: STORE, countryId: JOD.id, customerId: 'cu1',
    productId: CREAM, productNameSnapshot: 'كريم', quantity: 1, freeQuantity: 0, sellingPrice: 15, discountAmount: 0,
    shippingCost: 2.5, deliveryFee: null, totalAmount: 17.5, priceIncludesDelivery: false, estimatedCostOfGoods: 0,
    version: 3, status: 'CONTACTING', confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY',
    settlementStatus: 'NOT_APPLICABLE', shippedAt: null, labelPrintedAt: null, trackingNumber: null,
    courierSendStartedAt: null, shippingBatchId: null, deliveryProviderId: null, moderatorId: null, claimedById: null,
    lockedById: null, lockExpiresAt: null, offerId: null, regionId: null, customerNotes: null, deliveryAddress: 'عمّان',
    ...over.order,
  };
  fake.lines = over.lines ?? [line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 1, unitPrice: 15, lineTotal: 15 })];
  fake.addOns = [];
  fake.products = [CREAM, SOAP].map((id) => ({ id, companyId: COMPANY, name: id === CREAM ? 'كريم' : 'صابون', basePrice: id === SOAP ? 5 : 15, status: 'ACTIVE' }));
  fake.shelf = { [CREAM]: 50, [SOAP]: 50 };
  fake.customer = { fullName: 'أحمد', address: 'عمّان', city: null, phone: '0790000001', rawPhone: '0790000001', altPhone: null };
  fake.batch = null;
  fake.claims = 0;
  fake.activities = [];
  fake.customerWrites = [];
  fake.writes = [];
};

/** The same order CONFIRMED, its one unit held on the shelf, in a batch still on our floor: the request door's. */
const seedConfirmed = (over: { order?: Row; lines?: Row[] } = {}) => {
  seed({
    order: { status: 'CONFIRMED', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', settlementStatus: 'PENDING_COLLECTION', shippingBatchId: 'b1', ...over.order },
    lines: over.lines ?? [line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 1, unitPrice: 15, lineTotal: 15, reservedQty: 1 })],
  });
  fake.batch = { status: 'READY', batchNumber: 'B-7' };
};

/** ORD-2026-0733's shape: the columns say ten for 150 (152.500 with the fee), the line still says one for 15. */
const BROKEN = { quantity: 10, sellingPrice: 150, totalAmount: 152.5 };

const approve = (changes: Row) => {
  fake.request = {
    id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, reason: 'الزبون بدو عشرة', decisionNote: 'موافق',
    requestedById: 'agent-1', changes,
  };
};

/** The only line of the order — a missing one fails the test by name, not by a TypeError. */
const onlyLine = (): Row => {
  expect(fake.lines, 'الطلب لازم يضل بسطر واحد').toHaveLength(1);
  const first = fake.lines[0];
  if (!first) throw new Error('no line on the order');
  return first;
};

/** The add-ons the customer accepted, as both calculators read them. */
const addOnsNow = (): Array<{ quantity: number; price: number }> =>
  fake.addOns.map((a) => ({ quantity: Number(a.quantity), price: Number(a.price) }));

/** What the shipping screen would collect for the order's lines, as it stands: the calculator that read 15 on 0733. */
const shipmentOfLines = (): number =>
  codForOrder({
    lines: fake.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: Number(l.unitPrice),
      freeQuantity: l.freeQuantity,
      discountShare: Number(l.discountShare),
      lineTotal: Number(l.lineTotal),
    })),
    addOns: addOnsNow(),
    deliveryFee: Number(fake.order.deliveryFee ?? fake.order.shippingCost),
    priceIncludesDelivery: fake.order.priceIncludesDelivery === true,
    minorUnit: JOD.minorUnit,
  }).cod;

/** The DoD in one assertion: the columns say what the lines say, by the same rule the preview judges. */
const columnsAgreeWithLines = () => {
  const o = fake.order;
  const drift = columnsDrift({
    order: {
      quantity: o.quantity, sellingPrice: o.sellingPrice, totalAmount: o.totalAmount, discount: o.discountAmount,
      shippingCost: o.shippingCost, deliveryFee: o.deliveryFee, priceIncludesDelivery: o.priceIncludesDelivery === true,
    },
    rows: fake.lines.map((l) => ({ quantity: l.quantity, freeQuantity: l.freeQuantity, unitPrice: l.unitPrice, discountShare: l.discountShare, lineTotal: l.lineTotal })),
    addOns: addOnsNow(),
    minorUnit: JOD.minorUnit,
    // the strict question: the total, the count and the subtotal
    goods: true,
  });
  expect(drift, 'أعمدة الطلب ما بتطابق أسطره').toBeNull();
  expect(o.totalAmount, 'شاشة الشحن بتحصّل غير اللي بالطلب').toBe(shipmentOfLines());
};

/**
 * A refusal: its code, an Arabic sentence, and NOTHING written — not the order, not a line, not the stamp. The state is
 * taken BEFORE the call is made, so «unchanged» compares the order as it was with the order as it is.
 */
const refused = async (call: () => Promise<Response>, code: string) => {
  const before = { order: { ...fake.order }, lines: fake.lines.map((l) => ({ ...l })), request: { ...fake.request } };
  const res = await call();
  expect(res.status, await res.clone().text()).toBe(409);
  const body = await res.json();
  expect(body.code).toBe(code);
  expect(String(body.errorAr)).toMatch(/[؀-ۿ]/);
  expect(body.error).toBe(body.errorAr);
  expect(fake.writes, 'انكتب شي رغم الرفض').toEqual([]);
  expect(fake.order).toEqual(before.order);
  expect(fake.lines).toEqual(before.lines);
  expect(fake.request).toEqual(before.request);
  return body as Row;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'owner', name: 'المالك', role: 'COMPANY_ADMIN' }, companyId: COMPANY, storeId: STORE, countryId: JOD.id, country: JOD,
  });
  // every key but the packing table's pen: this file is the ordinary door and the request door
  can.mockImplementation((_user: unknown, key: string) => key !== 'ops.edit_in_batch');
  authorize.mockReturnValue({ allowed: true });
  logAudit.mockResolvedValue(undefined);
  activeOffersFor.mockResolvedValue([]);
  seed();
});

/* ─────────────────────────── Ⅰ · the direct door ─────────────────────────── */

describe('Ⅰ · the direct door: the shorthand may not move the goods of an order that has lines', () => {
  it('(أ) quantity 1 → 10 on the one line: refused LINES_REQUIRED, and nothing is written — the line stays 1 × 15 and so do the columns', async () => {
    const body = await refused(() => direct({ quantity: 10 }), 'LINES_REQUIRED');
    expect(body.errorAr).toContain('قائمة البنود');
    expect(onlyLine()).toMatchObject({ quantity: 1, lineTotal: 15 });
    expect(fake.order).toMatchObject({ quantity: 1, sellingPrice: 15, totalAmount: 17.5, version: 3 });
  });

  it('…and the real door — the lines save the screen sends — does it whole: 10 × 15 = 150 on the line AND on the order', async () => {
    const res = await direct({ items: [{ productId: CREAM, quantity: 10, unitPrice: 150 }] });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(onlyLine()).toMatchObject({ productId: CREAM, quantity: 10, lineTotal: 150, discountShare: 0 });
    expect(Number(onlyLine().unitPrice)).toBe(15);
    // 150 + 2.500 to deliver
    expect(fake.order).toMatchObject({ quantity: 10, sellingPrice: 150, totalAmount: 152.5, version: 4 });
    columnsAgreeWithLines();
  });

  it('(ب) a price alone: refused the same way', async () => {
    await refused(() => direct({ sellingPrice: 150 }), 'LINES_REQUIRED');
  });

  it('(ب) a product alone: refused the same way', async () => {
    await refused(() => direct({ productId: SOAP }), 'LINES_REQUIRED');
  });

  it('(ج) two lines: the older refusal stands (MULTI_LINE_SHORTHAND), and nothing is written', async () => {
    // كريم 1 × 15 and صابون 2 × 5: 25, and 27.500 with the fee
    seed({
      order: { quantity: 3, sellingPrice: 25, totalAmount: 27.5 },
      lines: [
        line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 1, unitPrice: 15, lineTotal: 15 }),
        line({ id: 'line-soap-02', productId: SOAP, productName: 'صابون', quantity: 2, unitPrice: 5, lineTotal: 10 }),
      ],
    });
    await refused(() => direct({ quantity: 9 }), 'MULTI_LINE_SHORTHAND');
    await refused(() => direct({ sellingPrice: 30 }), 'MULTI_LINE_SHORTHAND');
  });

  it('(ج) …and two lines with the SAME figures and a discount: it passes, and the lines carry the discount — 3 and 2 of the 5', async () => {
    seed({
      order: { quantity: 3, sellingPrice: 25, totalAmount: 27.5 },
      lines: [
        line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 1, unitPrice: 15, lineTotal: 15 }),
        line({ id: 'line-soap-02', productId: SOAP, productName: 'صابون', quantity: 2, unitPrice: 5, lineTotal: 10 }),
      ],
    });
    const res = await direct({ quantity: 3, sellingPrice: 25, discountAmount: 5 });
    expect(res.status, await res.clone().text()).toBe(200);
    // 5 over 15 and 10 is 3 and 2; 25 − 5 + 2.500 = 22.500
    expect(fake.lines.map((l) => [l.discountShare, l.lineTotal])).toEqual([[3, 12], [2, 8]]);
    expect(fake.order).toMatchObject({ quantity: 3, sellingPrice: 25, discountAmount: 5, totalAmount: 22.5 });
    columnsAgreeWithLines();
  });

  it('the same figures again on the one line, with a discount, still pass — and the columns and the line still agree (12.500)', async () => {
    const res = await direct({ quantity: 1, sellingPrice: 15, discountAmount: 5 });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(onlyLine()).toMatchObject({ quantity: 1, discountShare: 5, lineTotal: 10 });
    expect(fake.order).toMatchObject({ quantity: 1, sellingPrice: 15, totalAmount: 12.5 });
    columnsAgreeWithLines();
  });

  it('an OLD order with no line rows keeps the shorthand: its columns are its only record (1 for 15 → 5 for 75)', async () => {
    seed({ lines: [] });
    const res = await direct({ quantity: 5 });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.order).toMatchObject({ quantity: 5, sellingPrice: 75, totalAmount: 77.5 });
    expect(fake.lines).toEqual([]);
  });
});

/* ─────────────────────────── Ⅱ · columns that already disagree ─────────────────────────── */

describe('Ⅱ · columns that already disagree with the lines are not written over', () => {
  it('ORD-2026-0733 at the direct door, the same figures again (quantity 10): COD_DRIFT, with both totals in the sentence', async () => {
    seed({ order: BROKEN });
    const body = await refused(() => direct({ quantity: 10 }), 'COD_DRIFT');
    // the stored 152.500 against the lines' 17.500
    expect(body.errorAr).toContain('152.500');
    expect(body.errorAr).toContain('17.500');
  });

  it('…a figure that differs: the direct door is told to send the lines (LINES_REQUIRED)', async () => {
    seed({ order: BROKEN });
    await refused(() => direct({ quantity: 1 }), 'LINES_REQUIRED');
  });

  it('…and the lines save is the way out: it writes the line and the columns from one computeCod', async () => {
    seed({ order: BROKEN });
    const res = await direct({ items: [{ productId: CREAM, quantity: 10, unitPrice: 150 }] });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(onlyLine()).toMatchObject({ quantity: 10, lineTotal: 150 });
    columnsAgreeWithLines();
  });

  it('LINES_DRIFT: the total agrees and the count does not (10 for 15 against one for 15)', async () => {
    seed({ order: { quantity: 10 } });
    const body = await refused(() => direct({ quantity: 10 }), 'LINES_DRIFT');
    expect(body.errorAr).toContain('10 بـ15.000');
    expect(body.errorAr).toContain('1 بـ15.000');
  });

  it('FEE_SOURCE_DRIFT: two delivery fees on the order — which one the total carries cannot be said', async () => {
    seed({ order: { deliveryFee: 3.5 } });
    await refused(() => direct({ quantity: 1 }), 'FEE_SOURCE_DRIFT');
  });

  it('NEGATIVE: a fee alone is how the two fees become one again — not refused for them, and afterwards the two sides agree (15 + 3.500)', async () => {
    seed({ order: { deliveryFee: 3.5 } });
    const res = await direct({ shippingCost: 3.5 });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.order).toMatchObject({ shippingCost: 3.5, totalAmount: 18.5 });
    columnsAgreeWithLines();
  });
});

/* ─────────────────────────── Ⅲ · the request door ─────────────────────────── */

describe('Ⅲ · the request door: the line and the shelf follow, or nothing is stamped', () => {
  it('(ز) confirmed and held: quantity 1 → 10 writes the line (10 × 15 = 150), holds ten on the shelf, and the columns follow', async () => {
    seedConfirmed();
    approve({ quantity: { from: 1, to: 10 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(onlyLine()).toMatchObject({ quantity: 10, lineTotal: 150, reservedQty: 10 });
    expect(fake.order).toMatchObject({ quantity: 10, sellingPrice: 150, totalAmount: 152.5, version: 4 });
    expect(fake.request.appliedAt).toBeInstanceOf(Date);
    columnsAgreeWithLines();
  });

  it('(د) a quantity «changed» to the one it has: NOTHING_TO_APPLY — no write, no version, no stamp', async () => {
    seedConfirmed();
    approve({ quantity: { from: 1, to: 1 } });
    const body = await refused(() => apply(), 'NOTHING_TO_APPLY');
    expect(body.errorAr).toContain('ما في شي يتغيّر');
    expect(fake.request.appliedAt).toBeNull();
  });

  it('(د) …a price kept as it is, the same', async () => {
    seedConfirmed();
    approve({ sellingPrice: { from: 15, to: 15 } });
    await refused(() => apply(), 'NOTHING_TO_APPLY');
    expect(fake.request.appliedAt).toBeNull();
  });

  it('(د) …a note the order already carries, the same', async () => {
    seedConfirmed({ order: { customerNotes: 'قبل الظهر' } });
    approve({ customerNotes: { from: 'قبل الظهر', to: 'قبل الظهر' } });
    await refused(() => apply(), 'NOTHING_TO_APPLY');
  });

  it('(د) …and the customer’s own name, as her row already reads it, the same', async () => {
    seedConfirmed();
    approve({ customerName: { from: 'أحمد', to: 'أحمد' } });
    await refused(() => apply(), 'NOTHING_TO_APPLY');
    expect(fake.customerWrites).toEqual([]);
  });

  it('NEGATIVE: a name that IS new is written and stamped — the question is the write, not the request', async () => {
    seedConfirmed();
    approve({ customerName: { from: 'أحمد', to: 'محمد علي' } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.customer?.fullName).toBe('محمد علي');
    expect(fake.request.appliedAt).toBeInstanceOf(Date);
  });

  it('NEGATIVE: the same quantity beside a new note — the note is written, no line is touched, and it is stamped', async () => {
    seedConfirmed();
    approve({ quantity: { from: 1, to: 1 }, customerNotes: { from: null, to: 'بعد العصر' } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.order.customerNotes).toBe('بعد العصر');
    expect(fake.writes.filter((w) => w.startsWith('orderItem'))).toEqual([]);
    expect(fake.request.appliedAt).toBeInstanceOf(Date);
  });

  it('(هـ) ORD-2026-0733 and a request for 10 — the figure the columns already say: COD_DRIFT, never «applied»', async () => {
    seedConfirmed({ order: BROKEN });
    approve({ quantity: { from: 1, to: 10 } });
    await refused(() => apply(), 'COD_DRIFT');
    expect(fake.request.appliedAt).toBeNull();
    expect(onlyLine()).toMatchObject({ quantity: 1, reservedQty: 1 });
  });

  it('(هـ) …and a request for 1 — the figure the line says: the plan refuses it with the same word', async () => {
    seedConfirmed({ order: BROKEN });
    approve({ quantity: { from: 10, to: 1 } });
    await refused(() => apply(), 'COD_DRIFT');
    expect(fake.request.appliedAt).toBeNull();
  });

  it('(هـ) …a request that names no goods (a note) is still a note: the drift is the goods’ question', async () => {
    seedConfirmed({ order: BROKEN });
    approve({ customerNotes: { from: null, to: 'بعد العصر' } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.writes.filter((w) => w.startsWith('orderItem'))).toEqual([]);
  });
});

/* ─────────────────────────── Ⅲb · a discount alone ─────────────────────────── */

describe('Ⅲb · a discount alone rebuilds the total from the two columns — so they must describe the lines', () => {
  /** A storefront basket: the head columns are the LARGEST line (2 × 10 = 20); the lines are 20 and 5; 27.500 with the fee. */
  const basket = () =>
    seedConfirmed({
      order: { quantity: 2, sellingPrice: 20, totalAmount: 27.5 },
      lines: [
        line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 2, unitPrice: 10, lineTotal: 20, reservedQty: 2 }),
        line({ id: 'line-soap-02', productId: SOAP, productName: 'صابون', quantity: 1, unitPrice: 5, lineTotal: 5, reservedQty: 1 }),
      ],
    });

  it('a 0 → 3 discount on that basket is refused LINES_DRIFT — it used to write 19.500 while the lines said 24.500', async () => {
    basket();
    approve({ discountAmount: { from: 0, to: 3 } });
    const body = await refused(() => apply(), 'LINES_DRIFT');
    expect(body.errorAr).toContain('2 بـ20.000');
    expect(fake.request.appliedAt).toBeNull();
    // and what the shipping screen collects is still the whole basket
    expect(shipmentOfLines()).toBe(27.5);
  });

  it('NEGATIVE: columns that describe the lines take the discount, and the two still agree afterwards (25 − 3 + 2.500)', async () => {
    basket();
    fake.order.quantity = 3;
    fake.order.sellingPrice = 25;
    approve({ discountAmount: { from: 0, to: 3 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.order.totalAmount).toBe(24.5);
    columnsAgreeWithLines();
  });

  it('a stored total that drifts, with the two columns right: the discount is not refused (the preview only warns) — and the write leaves them agreeing', async () => {
    // the order says 20, the line 15 + 2.500 = 17.500; a discount of 2 rebuilds both from 15: 15 − 2 + 2.500 = 15.500
    seedConfirmed({ order: { totalAmount: 20 } });
    approve({ discountAmount: { from: 0, to: 2 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.order.totalAmount).toBe(15.5);
    columnsAgreeWithLines();
  });
});

/* ─────────────────────────── Ⅳ · the two questions, on their own ─────────────────────────── */

describe('Ⅳ · columnsDrift — the one rule, asked of figures', () => {
  type DriftOrder = Parameters<typeof columnsDrift>[0]['order'];
  type DriftRow = { quantity: number; freeQuantity: number; unitPrice: number; discountShare: number; lineTotal: number };
  const ask = (
    order: Partial<DriftOrder>,
    rows: Array<Partial<DriftRow>>,
    addOns: Array<{ quantity: number; price: number }> = [],
    goods = true
  ) => {
    const base: DriftOrder = { quantity: 1, sellingPrice: 15, totalAmount: 17.5, discount: 0, shippingCost: 2.5, deliveryFee: null, priceIncludesDelivery: false };
    const one: DriftRow = { quantity: 1, freeQuantity: 0, unitPrice: 15, discountShare: 0, lineTotal: 15 };
    return columnsDrift({
      order: { ...base, ...order },
      rows: rows.map((r) => ({ ...one, ...r })),
      addOns,
      minorUnit: 3,
      goods,
    });
  };

  it('agreeing figures: null — with an add-on the customer accepted counted on both sides', () => {
    expect(ask({}, [{}])).toBeNull();
    expect(ask({ totalAmount: 21.5 }, [{}], [{ quantity: 1, price: 4 }])).toBeNull();
    // a price that includes delivery: the fee is not added
    expect(ask({ totalAmount: 15, priceIncludesDelivery: true }, [{}])).toBeNull();
  });

  it('no line rows: nothing to disagree with', () => {
    expect(ask(BROKEN, [])).toBeNull();
  });

  it('the stored total off by more than half a fils: COD_DRIFT; within it: the same figure', () => {
    expect(ask({ totalAmount: 17.501 }, [{}])?.code).toBe('COD_DRIFT');
    expect(ask({ totalAmount: 17.5004 }, [{}])).toBeNull();
  });

  it('the lines that never got the discount: the order says 12.500, the shipping screen would collect 17.500 — COD_DRIFT', () => {
    // the order's own 5 off, and the line's share left at 0: priced by the order's discount the lines come to 12.500, but
    // `codForOrder` sums the lines' own shares and asks 17.500
    const hit = ask({ discount: 5, totalAmount: 12.5 }, [{}]);
    expect(hit?.code).toBe('COD_DRIFT');
    expect(hit?.error).toContain('17.500');
  });

  it('two fees: FEE_SOURCE_DRIFT first, whatever the rest says', () => {
    expect(ask({ deliveryFee: 3.5 }, [{}])?.code).toBe('FEE_SOURCE_DRIFT');
  });

  it('the count off with the money right: LINES_DRIFT; the subtotal off with the total right: LINES_DRIFT', () => {
    expect(ask({ quantity: 2 }, [{}])?.code).toBe('LINES_DRIFT');
    expect(ask({ sellingPrice: 16 }, [{}])?.code).toBe('LINES_DRIFT');
  });

  it('a discount or a fee alone (no goods named): the stored money is not judged — only the two columns the total is rebuilt from', () => {
    expect(ask({ totalAmount: 20 }, [{}], [], false)).toBeNull();
    expect(ask({ totalAmount: 20 }, [{}], [], true)?.code).toBe('COD_DRIFT');
    expect(ask({ deliveryFee: 3.5 }, [{}], [], false)).toBeNull();
    expect(ask({ deliveryFee: 3.5 }, [{}], [], true)?.code).toBe('FEE_SOURCE_DRIFT');
    expect(ask({ quantity: 2 }, [{}], [], false)?.code).toBe('LINES_DRIFT');
  });

  it('a storefront basket’s head columns (the largest line) do not describe its two lines: LINES_DRIFT, with both readings', () => {
    // 2 × 10 and 1 × 5; the head says 2 for 20, the lines 3 for 25; the total (27.500) is the whole basket's and agrees
    const hit = ask({ quantity: 2, sellingPrice: 20, totalAmount: 27.5 }, [{ quantity: 2, unitPrice: 10, lineTotal: 20 }, { quantity: 1, unitPrice: 5, lineTotal: 5 }], [], false);
    expect(hit?.code).toBe('LINES_DRIFT');
    expect(hit?.error).toContain('2 بـ20.000');
    expect(hit?.error).toContain('3 بـ25.000');
  });

  it('the total is the preview’s own rule: both files call the one function, and neither carries a second formula', () => {
    const engine = stripComments(repoFile('src/lib/order-line-edit.ts'));
    const door = stripComments(repoFile('src/lib/order-line-apply.ts'));
    expect(engine).toMatch(/storedMoneyDrift\(o, before\.cod, facts\.shipmentCod, mu, lineDraft\)/);
    expect(door).toMatch(/storedMoneyDrift\(/);
    // the drift test is written once: only inside `storedMoneyDrift`
    expect(engine.match(/problem\('COD_DRIFT'/g) ?? []).toHaveLength(1);
    expect(door).not.toMatch(/'COD_DRIFT'/);
  });
});

describe('Ⅳ · changedKeys — what a write would really change', () => {
  const decimal = (v: number) => ({ valueOf: () => v, toString: () => String(v) });

  it('a figure within half a minor unit is the same figure; one beyond it is a change', () => {
    expect(changedKeys({ totalAmount: decimal(17.5) }, { totalAmount: 17.5 }, 3)).toEqual([]);
    expect(changedKeys({ totalAmount: 17.5 }, { totalAmount: 17.5004 }, 3)).toEqual([]);
    expect(changedKeys({ totalAmount: 17.5 }, { totalAmount: 17.501 }, 3)).toEqual(['totalAmount']);
  });

  it('a column the row does not carry is a change — the cautious side', () => {
    expect(changedKeys({}, { shippingCost: 0 }, 3)).toEqual(['shippingCost']);
    expect(changedKeys({ shippingCost: null }, { shippingCost: 0 }, 3)).toEqual(['shippingCost']);
  });

  it('text by its letters, an empty one as empty, a date by its instant, and a key the write leaves out is no change', () => {
    expect(changedKeys({ customerNotes: null }, { customerNotes: null }, 3)).toEqual([]);
    expect(changedKeys({ customerNotes: undefined }, { customerNotes: null }, 3)).toEqual([]);
    expect(changedKeys({ customerNotes: 'أ' }, { customerNotes: 'ب' }, 3)).toEqual(['customerNotes']);
    const at = new Date('2026-10-30T10:00:00Z');
    expect(changedKeys({ postponedUntil: new Date(at) }, { postponedUntil: at }, 3)).toEqual([]);
    expect(changedKeys({ postponedUntil: at }, { postponedUntil: new Date('2026-10-31T10:00:00Z') }, 3)).toEqual(['postponedUntil']);
    expect(changedKeys({ quantity: 1 }, { quantity: undefined }, 3)).toEqual([]);
  });
});
