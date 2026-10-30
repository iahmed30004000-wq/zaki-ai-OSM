import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الخصم على الطلب» ANSWERS — ONCE, IN THE SAME FIGURES THE SCREEN SHOWED, AND THE SHELF NEVER FEELS IT.
 *
 * DEFINITION OF DONE (this is the test of the PR's items 1–3):
 *   · the card's save takes the discount ONCE — alone, with a line change, with a price change, with two lines, in the
 *     three currencies, at zero, emptied, beside a gift or an offer's reduction;
 *   · «بعد الخصم» on the screen (`previewOrderDiscount`) is the number this door writes: total, shares, line totals;
 *   · a discount bigger than the goods is refused with words and writes nothing — and the screen says so first;
 *   · the discount never touches the shelf: no reservation is made, moved or released by it;
 *   · THE DEFECT THIS FILE FOUND: a discount alone, applied through an approved request (the only way past
 *     confirmation), wrote the order's total and left every line's share as it was — and creating the shipment
 *     recomputes the COD from the LINES (`codForOrder`), so the courier was told the OLD price.
 *
 * The route is the REAL `PATCH /api/orders/[id]` with the real `computeCod`, the real price gate and the real plan;
 * only the database is a fake — one that holds the order, its lines and the shelf, rolls a transaction back when it
 * throws, and LOGS EVERY WRITE so that «touched nothing» can be shown. Every figure is worked by hand beside it.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const { fake, requireContext, logAudit, notify, activeOffersFor, adapterFor, can, authorize } = vi.hoisted(() => {
  const fake = {
    order: {} as Row,
    lines: [] as Row[],
    products: [] as Row[],
    addOns: [] as Row[],
    shelf: {} as Record<string, number>,
    request: {} as Row,
    /** Courier-statement rows that claim the order. */
    claims: 0,
    activities: [] as Row[],
    /** `model.method` of every write, in order. */
    writes: [] as string[],
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
          .map((id) => ({ productId: id, quantityRemaining: fake.shelf[id], costPerUnit: 1 })),
    },
    offer: { findFirst: () => null },
    shippingBatch: { findFirst: () => null },
    settlementMatch: { count: () => fake.claims },
    orderContactAttempt: { count: () => 1 },
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
    orderNote: { create: ({ data }) => data },
    orderStatusLog: { create: ({ data }) => data },
    deliveryProvider: { findFirst: () => null },
    customer: { update: ({ data }) => data },
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
    held.$executeRaw = async () => {
      // the advisory locks of `reserveOrderLines` — a discount must never reach them
      fake.writes.push('$executeRaw');
      return 0;
    };
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
vi.mock('@/lib/couriers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adapterFor: (...a: unknown[]) => adapterFor(...a),
}));

import { PATCH } from './route';
import { previewOrderDiscount } from '@/lib/order-discount-preview';
import { totalsBeforeDiscount } from '@/lib/money';
import { codForOrder } from '@/lib/delivery-fees';

const COMPANY = 'company-0001';
const STORE = 'store-0001';
const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';

const JOD = { id: 'country-jo', code: 'JO', currencyCode: 'JOD', minorUnit: 3, allowNegativeStock: false };
const USD = { id: 'country-iq', code: 'IQ', currencyCode: 'USD', minorUnit: 2, allowNegativeStock: false };
const SYP = { id: 'country-sy', code: 'SY', currencyCode: 'SYP', minorUnit: 0, allowNegativeStock: false };
type Country = typeof JOD;

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );

const line = (over: Row): Row => ({
  companyId: COMPANY, orderId: ORDER_ID, discountShare: 0, reservedQty: 0, deliveredQty: null, returnedQty: null,
  addedById: 'agent-1', addedStage: 'INTAKE', createdAt: new Date(0), freeQuantity: 0, ...over,
});

/** What the card sends: every line with the characters of its price box, the discount as a number. */
type Box = { productId: string; quantity: number; unitPrice: string };
const card = (items: Box[], discount: number) =>
  patch({ expectedVersion: 3, reason: 'تعديل الخصم', items, discountAmount: discount });

/**
 * THE ORDER: كريم 3 for 36 and صابون 2 for 10 — 46 before any discount, 2.500 to deliver, so 48.500 collected.
 * `confirmed` puts it past confirmation with its lines holding stock (4 = 3 + a gift of 1, and 2); otherwise it is
 * still being worked, with nothing held.
 */
const seed = (opts: { confirmed?: boolean; lines?: Row[]; order?: Row } = {}) => {
  const confirmed = opts.confirmed === true;
  fake.order = {
    id: ORDER_ID, orderNumber: 'SY-2026-0002', companyId: COMPANY, storeId: STORE, countryId: JOD.id, customerId: 'cu1',
    productId: CREAM, productNameSnapshot: 'كريم', quantity: 5, freeQuantity: 1, sellingPrice: 46, discountAmount: 0,
    shippingCost: 2.5, deliveryFee: null, totalAmount: 48.5, priceIncludesDelivery: false, estimatedCostOfGoods: 0,
    version: 3, status: confirmed ? 'CONFIRMED' : 'CONTACTING', confirmationStatus: confirmed ? 'CONFIRMED' : 'IN_PROGRESS',
    shippingStatus: 'NOT_READY', settlementStatus: 'PENDING_COLLECTION', shippedAt: null, labelPrintedAt: null,
    trackingNumber: null, courierSendStartedAt: null, shippingBatchId: null, deliveryProviderId: null, moderatorId: null,
    claimedById: null, lockedById: null, lockExpiresAt: null, offerId: null, regionId: null, customerNotes: null,
    ...opts.order,
  };
  fake.lines = opts.lines ?? [
    line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 12, lineTotal: 36, reservedQty: confirmed ? 4 : 0 }),
    line({ id: 'line-soap-02', productId: SOAP, productName: 'صابون', quantity: 2, unitPrice: 5, lineTotal: 10, reservedQty: confirmed ? 2 : 0 }),
  ];
  fake.addOns = [];
  fake.products = [CREAM, SOAP].map((id) => ({ id, companyId: COMPANY, name: id === CREAM ? 'كريم' : 'صابون', basePrice: 12, status: 'ACTIVE' }));
  fake.shelf = { [CREAM]: 50, [SOAP]: 50 };
  fake.activities = [];
  fake.writes = [];
  fake.claims = 0;
};

/** An order that already carries a discount of 4.600 — shares 3.600 and 1.000 — as a card save wrote it. */
const seedDiscounted = () =>
  seed({
    order: { discountAmount: 4.6, totalAmount: 43.9 },
    lines: [
      line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 12, discountShare: 3.6, lineTotal: 32.4 }),
      line({ id: 'line-soap-02', productId: SOAP, productName: 'صابون', quantity: 2, unitPrice: 5, discountShare: 1, lineTotal: 9 }),
    ],
  });

/** The boxes a card opens on — what `GET` sends as `beforeDiscount` — for the lines now stored. */
const opened = (): Box[] => {
  const stored = fake.lines.map((l) => ({ lineTotal: l.lineTotal as unknown, discountShare: l.discountShare as unknown }));
  const before = totalsBeforeDiscount(stored, Number(fake.order.discountAmount), JOD.minorUnit);
  return fake.lines.map((l, i) => ({ productId: l.productId, quantity: l.quantity, unitPrice: String(before[i]) }));
};

const approve = (changes: Row) => {
  fake.request = {
    id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, reason: 'الزبون طلب خصم', decisionNote: 'موافق',
    requestedById: 'agent-1', changes,
  };
};
const apply = () => patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

const as = (country: Country) => {
  requireContext.mockResolvedValue({
    user: { id: 'owner', name: 'المالك', role: 'COMPANY_ADMIN' }, companyId: COMPANY, storeId: STORE, countryId: country.id, country,
  });
  fake.order.countryId = country.id;
};

/** The figures a save writes. */
const written = () => ({
  totalAmount: fake.order.totalAmount,
  sellingPrice: fake.order.sellingPrice,
  discountAmount: fake.order.discountAmount,
  shares: fake.lines.map((l) => l.discountShare),
  lineTotals: fake.lines.map((l) => l.lineTotal),
});

beforeEach(() => {
  vi.clearAllMocks();
  can.mockImplementation(() => true);
  authorize.mockReturnValue({ allowed: true });
  logAudit.mockResolvedValue(undefined);
  notify.mockResolvedValue(undefined);
  activeOffersFor.mockResolvedValue([]);
  adapterFor.mockReturnValue({ automated: false, code: 'MANUAL', name: 'يدوي' });
  seed();
  as(JOD);
});

/**
 * THE SCREEN'S «بعد الخصم» AND THIS DOOR'S WRITE, side by side: the same boxes through both, held equal on every
 * figure — what is collected (the goods after the discount, plus the 2.500 fee), the discount, and each line's share.
 */
const sameAsTheScreen = async (boxes: Box[], discount: number, country: Country = JOD) => {
  const shown = previewOrderDiscount({
    lines: boxes.map((b) => ({ quantity: b.quantity, price: b.unitPrice })),
    discount: String(discount),
    minorUnit: country.minorUnit,
  });
  const res = await card(boxes, discount);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(shown.kind).toBe('ok');
  if (shown.kind !== 'ok') return shown;
  expect(fake.order.sellingPrice, 'قيمة البضاعة').toBe(shown.goods);
  expect(fake.order.discountAmount, 'الخصم').toBe(shown.discount);
  expect(fake.lines.map((l) => l.discountShare), 'حصص الأسطر').toEqual(shown.shares);
  expect(fake.lines.map((l) => l.lineTotal), 'أسطر بعد الخصم').toEqual(shown.linesAfter);
  // the collected total is the goods after the discount and then the fee, nothing else
  expect(fake.order.totalAmount - fake.order.shippingCost).toBeCloseTo(shown.after, country.minorUnit);
  return shown;
};

describe('Ⅰ · the card’s save takes the discount once — and the screen showed that figure', () => {
  it('(أ) a discount alone: 4.600 off 46 is 41.400, and 43.900 with the fee — shares 3.600 and 1.000', async () => {
    const shown = await sameAsTheScreen(opened(), 4.6);
    expect(written()).toEqual({
      totalAmount: 43.9, sellingPrice: 46, discountAmount: 4.6, shares: [3.6, 1], lineTotals: [32.4, 9],
    });
    expect(shown).toMatchObject({ after: 41.4 });
  });

  it('(ب) a discount AND a line changed: كريم 5 for 60 beside صابون 10, 6.800 off 70 — 63.200 and 65.700 with the fee', async () => {
    // 60/70 × 6.8 = 5.829 and 10/70 × 6.8 = 0.971 — together exactly 6.800
    const shown = await sameAsTheScreen(
      [{ productId: CREAM, quantity: 5, unitPrice: '60' }, { productId: SOAP, quantity: 2, unitPrice: '10' }],
      6.8
    );
    expect(written()).toEqual({
      totalAmount: 65.7, sellingPrice: 70, discountAmount: 6.8, shares: [5.829, 0.971], lineTotals: [54.171, 9.029],
    });
    expect(shown).toMatchObject({ after: 63.2 });
  });

  it('(ب) and a PRICE changed beside it: صابون 2 for 14 instead of 10, with the same 4.600 — 50 less 4.600', async () => {
    const shown = await sameAsTheScreen(
      [{ productId: CREAM, quantity: 3, unitPrice: '36' }, { productId: SOAP, quantity: 2, unitPrice: '14' }],
      4.6
    );
    // 36/50 × 4.6 = 3.312 and 14/50 × 4.6 = 1.288
    expect(written()).toMatchObject({ sellingPrice: 50, discountAmount: 4.6, shares: [3.312, 1.288], totalAmount: 47.9 });
    expect(shown).toMatchObject({ after: 45.4 });
  });

  it('(ج) a line changed with the discount left alone: the 4.600 is taken once — never again on the next press', async () => {
    seedDiscounted();
    // the boxes open on 36 and 10 (before the discount); صابون goes to 3 pieces for 15 and nothing else is touched
    const boxes = opened();
    expect(boxes.map((b) => b.unitPrice)).toEqual(['36', '10']);
    boxes[1] = { productId: SOAP, quantity: 3, unitPrice: '15' };
    await sameAsTheScreen(boxes, 4.6);
    // 51 less 4.600 once = 46.400, and 48.900 with the fee — not 41.8 (twice) nor 51 (never)
    expect(written()).toMatchObject({ sellingPrice: 51, discountAmount: 4.6, totalAmount: 48.9 });
  });

  it('(ج) and pressing حفظ with nothing touched, three times, moves nothing', async () => {
    seedDiscounted();
    for (let press = 1; press <= 3; press++) {
      fake.order.version = 3;
      const res = await card(opened(), 4.6);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(written(), `الضغطة ${press}`).toEqual({
        totalAmount: 43.9, sellingPrice: 46, discountAmount: 4.6, shares: [3.6, 1], lineTotals: [32.4, 9],
      });
    }
  });

  it('(ز) discount removed: 4.600 → 0 gives every line its full price back; an EMPTIED box is the same 0', async () => {
    seedDiscounted();
    // the card sends Number('') = 0 for an emptied box
    const shown = await sameAsTheScreen(opened(), Number(''));
    expect(written()).toEqual({ totalAmount: 48.5, sellingPrice: 46, discountAmount: 0, shares: [0, 0], lineTotals: [36, 10] });
    expect(shown).toMatchObject({ discount: 0, after: 46 });
  });

  it('(ز) a discount of 0 on an order with none changes nothing', async () => {
    await sameAsTheScreen(opened(), 0);
    expect(written()).toEqual({ totalAmount: 48.5, sellingPrice: 46, discountAmount: 0, shares: [0, 0], lineTotals: [36, 10] });
  });

  it('(هـ) one line: the order in the photo — 5 pieces for 125 in dollars, 10 off — 115 after it', async () => {
    seed({
      order: { quantity: 5, freeQuantity: 0, sellingPrice: 125, totalAmount: 125, shippingCost: 0 },
      lines: [line({ id: 'line-hoodie', productId: CREAM, productName: 'هودي بديل المازوت', quantity: 5, unitPrice: 25, lineTotal: 125 })],
    });
    as(USD);
    const shown = await sameAsTheScreen([{ productId: CREAM, quantity: 5, unitPrice: '125' }], 10, USD);
    expect(shown).toMatchObject({ goods: 125, discount: 10, after: 115, shares: [10] });
    expect(written()).toEqual({ totalAmount: 115, sellingPrice: 125, discountAmount: 10, shares: [10], lineTotals: [115] });
  });

  it('(و) USD: 33.33 and 66.67 with 10.01 off — the shares are the screen’s, to the cent', async () => {
    as(USD);
    const boxes = [{ productId: CREAM, quantity: 1, unitPrice: '33.33' }, { productId: SOAP, quantity: 2, unitPrice: '66.67' }];
    const shown = await sameAsTheScreen(boxes, 10.01, USD);
    expect(shown).toMatchObject({ goods: 100, discount: 10.01 });
    expect((shown as { shares: number[] }).shares.reduce((a, b) => a + b, 0)).toBeCloseTo(10.01, 2);
  });

  it('(و) SYP, no decimals: 1001 and 2002 with 100 off — 33 and 67, 2903 after', async () => {
    as(SYP);
    // no decimals at all: a fee of 2.500 would itself be rounded, so this order has none
    fake.order.shippingCost = 0;
    const boxes = [{ productId: CREAM, quantity: 1, unitPrice: '1001' }, { productId: SOAP, quantity: 2, unitPrice: '2002' }];
    const shown = await sameAsTheScreen(boxes, 100, SYP);
    expect(shown).toMatchObject({ goods: 3003, after: 2903, shares: [33, 67] });
    expect(fake.order.totalAmount).toBe(2903);
  });

  it('(ح) a gift stays the line’s: كريم 3+1 with 4.600 off — the gift is still 1 and is not priced', async () => {
    await sameAsTheScreen(opened(), 4.6);
    expect(fake.lines.find((l) => l.productId === CREAM)?.freeQuantity).toBe(1);
    expect(fake.lines.find((l) => l.productId === SOAP)?.freeQuantity).toBe(0);
    expect(fake.order.freeQuantity).toBe(1);
  });

  it('(ح) an offer’s reduction is inside the price: 3 for 25 with 3 off (22) and 2 more off by hand — 20, not 17', async () => {
    seed({
      order: { quantity: 3, freeQuantity: 1, sellingPrice: 22, discountAmount: 0, totalAmount: 24.5 },
      lines: [line({ id: 'line-offer', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 8.333, discountShare: 3, lineTotal: 22 })],
    });
    // the screen opens the box on 22 (`totalsBeforeDiscount`: the share is the offer's, not the order's)
    expect(opened()).toEqual([{ productId: CREAM, quantity: 3, unitPrice: '22' }]);
    const shown = await sameAsTheScreen(opened(), 2);
    expect(shown).toMatchObject({ goods: 22, after: 20 });
    expect(written()).toMatchObject({ discountAmount: 2, shares: [2], lineTotals: [20] });
    expect(fake.lines[0].freeQuantity).toBe(1);
  });
});

describe('Ⅱ · a discount bigger than the goods is told before the press — and the door refuses it in words', () => {
  it('(د) 47 off 46: the screen says too big (46), the door answers 400 and writes NOTHING', async () => {
    const boxes = opened();
    const shown = previewOrderDiscount({ lines: boxes.map((b) => ({ quantity: b.quantity, price: b.unitPrice })), discount: '47', minorUnit: 3 });
    expect(shown).toEqual({ kind: 'tooBig', goods: 46 });

    const res = await card(boxes, 47);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('الخصم لا يمكن أن يتجاوز إجمالي قيمة الطلب');
    expect(fake.writes).toEqual([]);
    expect(fake.order.discountAmount).toBe(0);
  });

  it('(د) and all 46 off is allowed, by both: the screen shows 0 after and the door writes 2.500 (the fee)', async () => {
    const shown = await sameAsTheScreen(opened(), 46);
    expect(shown).toMatchObject({ after: 0, shares: [36, 10] });
    expect(written()).toMatchObject({ totalAmount: 2.5, discountAmount: 46, lineTotals: [0, 0] });
  });

  it('(د) a line made dearer lifts the ceiling, a line made cheaper lowers it — the screen and the door agree on 46.001', async () => {
    const boxes = opened();
    const over = previewOrderDiscount({ lines: boxes.map((b) => ({ quantity: b.quantity, price: b.unitPrice })), discount: '46.001', minorUnit: 3 });
    expect(over.kind).toBe('tooBig');
    expect((await card(boxes, 46.001)).status).toBe(400);
    const dearer = [{ ...boxes[0], unitPrice: '40' }, boxes[1]];
    expect(previewOrderDiscount({ lines: dearer.map((b) => ({ quantity: b.quantity, price: b.unitPrice })), discount: '46.001', minorUnit: 3 }).kind).toBe('ok');
    expect((await card(dearer, 46.001)).status).toBe(200);
  });
});

describe('Ⅲ · the discount never touches the shelf', () => {
  it('before confirmation: a discount and a changed quantity hold NOTHING — no reservation, no movement, the shelf as it was', async () => {
    const shelfBefore = { ...fake.shelf };
    const res = await card(
      [{ productId: CREAM, quantity: 5, unitPrice: '60' }, { productId: SOAP, quantity: 2, unitPrice: '10' }],
      6.8
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.lines.map((l) => l.reservedQty)).toEqual([0, 0]);
    expect(fake.shelf).toEqual(shelfBefore);
    // only the order, its lines, and the story of the edit were written
    expect(new Set(fake.writes)).toEqual(new Set(['order.updateMany', 'orderItem.deleteMany', 'orderItem.createMany', 'orderActivity.create']));
    expect(fake.writes).not.toContain('$executeRaw');
  });

  it('a lines save is refused outright when stock is already held — a discount cannot sneak a re-reservation in', async () => {
    seed({ confirmed: false });
    fake.lines[0].reservedQty = 3;
    const res = await card(opened(), 4.6);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('LINES_COMMITTED');
    expect(fake.writes).toEqual([]);
  });
});

describe('Ⅳ · after confirmation the discount is a request — and APPLYING it writes the lines too, without touching the shelf', () => {
  beforeEach(() => {
    seed({ confirmed: true });
    authorize.mockReturnValue({ allowed: false, reason: 'OUT_OF_SCOPE' });
  });

  it('a direct save is still refused with «التعديل بيصير بطلب تعديل» — the card raises a request instead', async () => {
    authorize.mockReturnValue({ allowed: true });
    const res = await card(opened(), 4.6);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGE_REQUEST_REQUIRED');
    expect(fake.writes).toEqual([]);
  });

  it('THE DEFECT: 0 → 10 approved on its own writes the order AND the lines (it wrote only the order)', async () => {
    approve({ discountAmount: { from: 0, to: 10 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    // 46 less 10 = 36, and 38.500 with the fee
    expect(fake.order).toMatchObject({ discountAmount: 10, totalAmount: 38.5, sellingPrice: 46 });
    // 36/46 × 10 = 7.826 and 10/46 × 10 = 2.174 — the shares add up to the 10
    expect(fake.lines.map((l) => l.discountShare)).toEqual([7.826, 2.174]);
    expect(fake.lines.map((l) => l.lineTotal)).toEqual([28.174, 7.826]);
  });

  it('and the shipment agrees: `codForOrder`, which prices the parcel from the LINES, gives the order’s total', async () => {
    approve({ discountAmount: { from: 0, to: 10 } });
    expect((await apply()).status).toBe(200);
    const money = codForOrder({
      lines: fake.lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, freeQuantity: l.freeQuantity, discountShare: l.discountShare, lineTotal: l.lineTotal })),
      deliveryFee: Number(fake.order.shippingCost),
      priceIncludesDelivery: false,
      minorUnit: JOD.minorUnit,
    });
    expect(money.cod).toBe(fake.order.totalAmount);
    expect(money.cod).toBe(38.5);
  });

  it('the shelf does not feel it: reservations stay 4 and 2, no line is deleted or recreated, nothing is reserved again', async () => {
    approve({ discountAmount: { from: 0, to: 10 } });
    expect((await apply()).status).toBe(200);
    expect(fake.lines.map((l) => l.reservedQty)).toEqual([4, 2]);
    expect(fake.lines.map((l) => l.id)).toEqual(['line-cream-01', 'line-soap-02']);
    expect(fake.lines.map((l) => l.freeQuantity)).toEqual([1, 0]);
    expect(fake.lines.map((l) => l.addedStage)).toEqual(['INTAKE', 'INTAKE']);
    expect(fake.writes).not.toContain('orderItem.deleteMany');
    expect(fake.writes).not.toContain('orderItem.createMany');
    expect(fake.writes).not.toContain('$executeRaw');
    expect(fake.writes.filter((w) => w === 'orderItem.update')).toHaveLength(2);
  });

  it('the quantities, unit prices and the gift total are exactly as they were', async () => {
    approve({ discountAmount: { from: 0, to: 10 } });
    expect((await apply()).status).toBe(200);
    expect(fake.lines.map((l) => [l.quantity, l.unitPrice])).toEqual([[3, 12], [2, 5]]);
    expect(fake.order).toMatchObject({ quantity: 5, freeQuantity: 1 });
  });

  it('a discount taken OFF (4.600 → 0, approved) gives the lines their price back', async () => {
    seedDiscounted();
    fake.order.confirmationStatus = 'CONFIRMED';
    fake.order.status = 'CONFIRMED';
    approve({ discountAmount: { from: 4.6, to: 0 } });
    expect((await apply()).status).toBe(200);
    expect(written()).toEqual({ totalAmount: 48.5, sellingPrice: 46, discountAmount: 0, shares: [0, 0], lineTotals: [36, 10] });
  });

  it('a discount CHANGED (4.600 → 6.900, approved) is spread afresh, never added to the old shares', async () => {
    seedDiscounted();
    fake.order.confirmationStatus = 'CONFIRMED';
    fake.order.status = 'CONFIRMED';
    approve({ discountAmount: { from: 4.6, to: 6.9 } });
    expect((await apply()).status).toBe(200);
    // 46 less 6.900 = 39.100, and 41.600 with the fee; 36/46 × 6.9 = 5.4 and 10/46 × 6.9 = 1.5
    expect(written()).toEqual({ totalAmount: 41.6, sellingPrice: 46, discountAmount: 6.9, shares: [5.4, 1.5], lineTotals: [30.6, 8.5] });
  });

  it('an offer’s reduction (the line’s 3 off, no discount on the order) stands under a new discount of 2: 22 → 20', async () => {
    seed({
      confirmed: true,
      order: { quantity: 3, freeQuantity: 1, sellingPrice: 22, discountAmount: 0, totalAmount: 24.5 },
      lines: [line({ id: 'line-offer', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 8.333, discountShare: 3, lineTotal: 22, reservedQty: 4 })],
    });
    authorize.mockReturnValue({ allowed: false, reason: 'OUT_OF_SCOPE' });
    approve({ discountAmount: { from: 0, to: 2 } });
    expect((await apply()).status).toBe(200);
    expect(written()).toMatchObject({ discountAmount: 2, shares: [2], lineTotals: [20], totalAmount: 22.5 });
    expect(fake.lines[0].reservedQty).toBe(4);
  });

  it('a discount bigger than the goods is refused here too, and NOTHING — not the order, not a line — is written', async () => {
    approve({ discountAmount: { from: 0, to: 47 } });
    const res = await apply();
    expect(res.status).toBe(400);
    expect(fake.writes).toEqual([]);
    expect(fake.lines.map((l) => l.discountShare)).toEqual([0, 0]);
    expect(fake.request.appliedAt).toBeNull();
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════
 * THE PARCEL IS PRICED FROM THE LINES — AND SO AN OFFER'S ORDER MUST COME OUT THE SAME ON BOTH SIDES.
 *
 * (The adversarial review of this PR.) A storefront order with an offer is written at the price BEFORE the offer in
 * `unitPrice`, the offer's reduction in `discountShare`, and 0 in `discountAmount`. `codForOrder` trusts
 * `lineTotal + discountShare` only where it equals `quantity × unitPrice`; a discount written on the lines alone, with
 * `unitPrice` left at the old price, made the two disagree and the shipment dropped the offer's reduction: the order said
 * 22.500 and the courier was told 25.499. So a discount rewrites `unitPrice` too, and every case below asks the shipment.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** What creating the shipment would tell the courier to collect: priced from the LINES, the way `ops/shipments` does. */
const shipment = (): number =>
  codForOrder({
    lines: fake.lines.map((l) => ({
      quantity: l.quantity, unitPrice: l.unitPrice, freeQuantity: l.freeQuantity, discountShare: l.discountShare, lineTotal: l.lineTotal,
    })),
    addOns: fake.addOns.map((a) => ({ quantity: a.quantity, price: a.price })),
    deliveryFee: Number(fake.order.shippingCost),
    priceIncludesDelivery: false,
    minorUnit: JOD.minorUnit,
  }).cod;

/** 3 for 25 with the offer's 3 off: the line is 22, a gift of 1, 2.500 to deliver — 24.500 collected, from either side. */
const seedOffer = (confirmed: boolean) => {
  seed({
    confirmed,
    order: { quantity: 3, freeQuantity: 1, sellingPrice: 22, discountAmount: 0, totalAmount: 24.5 },
    lines: [
      line({ id: 'line-offer', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 8.333, discountShare: 3, lineTotal: 22, reservedQty: confirmed ? 4 : 0 }),
    ],
  });
  if (confirmed) authorize.mockReturnValue({ allowed: false, reason: 'OUT_OF_SCOPE' });
};

describe('Ⅴ · an offer’s order: the order and the shipment say the same, whatever is done to its discount', () => {
  it('the fixture itself: before anything, 24.500 on both sides', () => {
    seedOffer(true);
    expect(fake.order.totalAmount).toBe(24.5);
    expect(shipment()).toBe(24.5);
  });

  it('a discount of 2 approved: the order 22.500 and the shipment 22.500 — the offer’s 3 is not dropped', async () => {
    seedOffer(true);
    approve({ discountAmount: { from: 0, to: 2 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.order.totalAmount).toBe(22.5);
    expect(shipment()).toBe(22.5);
    // the line is priced BEFORE the discount again (22 over 3), the share is the 2, the line 20
    expect(fake.lines[0]).toMatchObject({ discountShare: 2, lineTotal: 20, reservedQty: 4, freeQuantity: 1 });
    expect(Number(fake.lines[0].unitPrice) * 3).toBeCloseTo(22, 6);
  });

  it('a discount “changed” to the one it has (0 → 0) writes no line at all, and the shipment is still the order’s 24.500', async () => {
    seedOffer(true);
    approve({ discountAmount: { from: 0, to: 0 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.writes).not.toContain('orderItem.update');
    expect(fake.order.totalAmount).toBe(24.5);
    expect(shipment()).toBe(24.5);
  });

  it('the card’s save with nothing touched (0 → 0), pressed twice: 24.500 on both sides each time', async () => {
    seedOffer(false);
    for (const press of [1, 2]) {
      fake.order.version = 3;
      const res = await card([{ productId: CREAM, quantity: 3, unitPrice: '22' }], 0);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(fake.order.totalAmount, `الضغطة ${press}`).toBe(24.5);
      expect(shipment(), `الضغطة ${press}`).toBe(24.5);
    }
  });

  it('the card’s save with 2 off an offer’s line: 22.500 on both sides', async () => {
    seedOffer(false);
    const res = await card([{ productId: CREAM, quantity: 3, unitPrice: '22' }], 2);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.order.totalAmount).toBe(22.5);
    expect(shipment()).toBe(22.5);
  });

  it('an order with NO offer: 10 off approved, the order and the shipment 38.500, the unit prices exactly as they were', async () => {
    seed({ confirmed: true });
    authorize.mockReturnValue({ allowed: false, reason: 'OUT_OF_SCOPE' });
    approve({ discountAmount: { from: 0, to: 10 } });
    expect((await apply()).status).toBe(200);
    expect(fake.order.totalAmount).toBe(38.5);
    expect(shipment()).toBe(38.5);
    expect(fake.lines.map((l) => l.unitPrice)).toEqual([12, 5]);
  });
});

describe('Ⅵ · the add-ons a customer accepted are collected, never discounted — in the card’s save and in the approved discount', () => {
  const withAddOn = (confirmed: boolean) => {
    seed({ confirmed, order: { totalAmount: 52.5 } });
    fake.addOns = [{ companyId: COMPANY, orderId: ORDER_ID, productId: SOAP, productName: 'صابون', quantity: 1, price: 4, reservedQty: confirmed ? 1 : 0 }];
    if (confirmed) authorize.mockReturnValue({ allowed: false, reason: 'OUT_OF_SCOPE' });
  };

  it('approved 5 off: 46 − 5 + 4 + 2.500 = 47.500 on the order and on the shipment; the shares add up to the 5 alone', async () => {
    withAddOn(true);
    approve({ discountAmount: { from: 0, to: 5 } });
    expect((await apply()).status).toBe(200);
    expect(fake.order.totalAmount).toBe(47.5);
    expect(shipment()).toBe(47.5);
    expect(fake.lines.reduce((sum, l) => sum + Number(l.discountShare), 0)).toBeCloseTo(5, 6);
    expect(fake.writes.filter((w) => w.startsWith('orderAddOn'))).toEqual([]);
  });

  it('the card’s save, 5 off: the same 47.500 — and the screen’s “بعد الخصم” is the goods alone, 41, as it says', async () => {
    withAddOn(false);
    const boxes = opened();
    const shown = previewOrderDiscount({ lines: boxes.map((b) => ({ quantity: b.quantity, price: b.unitPrice })), discount: '5', minorUnit: 3 });
    expect(shown).toMatchObject({ kind: 'ok', after: 41 });
    expect((await card(boxes, 5)).status).toBe(200);
    expect(fake.order.totalAmount).toBe(47.5);
    expect(shipment()).toBe(47.5);
  });
});

describe('Ⅶ · a statement writes the money, a delivered line is a record: the discount is refused, in words, with nothing written', () => {
  beforeEach(() => {
    seed({ confirmed: true });
    authorize.mockReturnValue({ allowed: false, reason: 'OUT_OF_SCOPE' });
    approve({ discountAmount: { from: 0, to: 10 } });
  });

  const refused = async (code: string) => {
    const res = await apply();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(code);
    expect(String(body.errorAr)).toMatch(/[؀-ۿ]/);
    expect(fake.writes).toEqual([]);
    expect(fake.order.discountAmount).toBe(0);
    expect(fake.request.appliedAt).toBeNull();
    expect(fake.lines.map((l) => l.discountShare)).toEqual([0, 0]);
  };

  it('a courier statement claims the order', async () => {
    fake.claims = 1;
    await refused('DISCOUNT_STATEMENT_LINKED');
  });

  it('its settlement has moved already', async () => {
    fake.order.settlementStatus = 'SETTLED';
    await refused('DISCOUNT_STATEMENT_LINKED');
  });

  it('a line has been delivered', async () => {
    fake.lines[0].deliveredQty = 3;
    await refused('DISCOUNT_LINE_SETTLED');
  });

  it('a line has been sent back', async () => {
    fake.lines[1].returnedQty = 1;
    await refused('DISCOUNT_LINE_SETTLED');
  });

  it('a discount that is the one it already has is not refused for it, and writes no line', async () => {
    fake.claims = 1;
    approve({ discountAmount: { from: 0, to: 0 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.writes).not.toContain('orderItem.update');
  });
});
