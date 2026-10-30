import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CourierRefusal } from '@/lib/couriers/logestechs';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN APPROVED LINES REQUEST IS WRITTEN WHOLE — THE LINES, THE SHELF, THE GIFT, THE TOTAL, THE COST — OR NOT AT ALL.
 *
 * «الكمية أكيد بتتطلب أغير معها السعر… بدي تعمل بمنطق تحلل وبذكاء، والأهم بدون ما تخرب، وأي تأثير مالي أو مخزون بدك
 * تاخدو بعين الاعتبار» — and «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 * The route here is the REAL `PATCH /api/orders/[id]`, with the real plan (`order-line-apply`), the real engine, the real
 * facts reader, the real `reserveOrderLines` and the real `computeCod`. Only the database is a fake — one that holds the
 * order, its lines, its add-ons, the shelf and the batches, answers the questions the code asks of them, rolls a
 * transaction back when it throws, and LOGS EVERY WRITE so that a refusal can be shown to have written nothing.
 *
 * Every number is worked by hand in the comment beside it (three-place JOD).
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
      // `reservedElsewhere`: what OTHER orders hold of one product.
      aggregate: ({ where }) => ({ _sum: { reservedQty: fake.elsewhere[where.productId] ?? 0 } }),
    },
    orderAddOn: {
      findMany: ({ where }) => fake.addOns.filter((a) => matches(a, where)).map((a) => ({ ...a })),
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
          activities: [...fake.activities],
          notes: [...fake.notes],
          request: { ...fake.request },
        };
        try {
          return await fn(fake.tx);
        } catch (e) {
          fake.order = before.order;
          fake.lines = before.lines;
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
import { previewOrderEdit } from '@/lib/order-edit-facts';
import { reserveOrderLines } from '@/lib/reservation';
import { repoFile, stripComments } from '@/lib/guard-source';

const COMPANY = 'company-0001';
const STORE = 'store-0001';
const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';
const DROPS = 'prod-drops-0003';
const P_A = 'prod-alpha-00001';
const P_B = 'prod-bravo-00002';
const P_C = 'prod-charlie-003';

const JOD = { id: 'country-jo', code: 'JO', currencyCode: 'JOD', minorUnit: 3, allowNegativeStock: false };

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );

const apply = (extra: Row = {}) => patch({ expectedVersion: 3, changeRequestId: REQUEST_ID, ...extra });

const line = (over: Row): Row => ({
  companyId: COMPANY, orderId: ORDER_ID, discountShare: 0, reservedQty: 0, deliveredQty: null, returnedQty: null,
  addedById: 'agent-1', addedStage: 'INTAKE', createdAt: new Date(0), freeQuantity: 0, ...over,
});

/** The order: كريم 3 (+1) for 36, صابون 2 for 10, an add-on of 4, 2.500 to deliver — 52.500 collected. */
const seed = (over: { order?: Row; lines?: Row[]; addOns?: Row[] } = {}) => {
  fake.order = {
    id: ORDER_ID, orderNumber: 'SY-1', companyId: COMPANY, storeId: STORE, countryId: JOD.id, customerId: 'cu1',
    productId: CREAM, productNameSnapshot: 'كريم', quantity: 5, freeQuantity: 1, sellingPrice: 46, discountAmount: 0,
    shippingCost: 2.5, deliveryFee: null, totalAmount: 52.5, priceIncludesDelivery: false, estimatedCostOfGoods: 0,
    version: 3, status: 'CONFIRMED', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
    settlementStatus: 'PENDING_COLLECTION', shippedAt: null, labelPrintedAt: null, trackingNumber: null,
    courierSendStartedAt: null, shippingBatchId: 'b1', deliveryProviderId: null, moderatorId: null, claimedById: null,
    lockedById: null, lockExpiresAt: null, offerId: null, regionId: null, customerNotes: null,
    ...over.order,
  };
  fake.lines = over.lines ?? [
    line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 12, lineTotal: 36, reservedQty: 4 }),
    line({ id: 'line-soap-02', productId: SOAP, productName: 'صابون', quantity: 2, unitPrice: 5, lineTotal: 10, reservedQty: 2 }),
  ];
  fake.addOns = over.addOns ?? [{ companyId: COMPANY, orderId: ORDER_ID, productId: DROPS, productName: 'قطرة', quantity: 1, price: 4, reservedQty: 1 }];
  fake.products = [CREAM, SOAP, DROPS, P_A, P_B, P_C].map((id) => ({
    id, companyId: COMPANY, name: ({ [CREAM]: 'كريم', [SOAP]: 'صابون', [DROPS]: 'قطرة' } as Record<string, string>)[id] ?? id, basePrice: id === SOAP ? 5 : 12, status: 'ACTIVE',
  }));
  fake.shelf = { [CREAM]: 50, [SOAP]: 50, [DROPS]: 50, [P_A]: 50, [P_B]: 50, [P_C]: 50 };
  fake.elsewhere = {};
  fake.costs = { [CREAM]: 2.5, [SOAP]: 1.2, [P_A]: 1, [P_B]: 1, [P_C]: 1 };
  fake.batch = { status: 'READY', batchNumber: 'B-7' };
  fake.offerRow = null;
  fake.claims = 0;
  fake.activities = [];
  fake.notes = [];
  fake.customerWrites = [];
  fake.writes = [];
  fake.hooks = {};
};

const approve = (changes: Row, over: Row = {}) => {
  fake.request = {
    id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, reason: 'الزبون بدو يزيد', decisionNote: 'موافق',
    requestedById: 'agent-1', changes, ...over,
  };
};

/** Line 1 from 3 (+1) for 36 to 5 (+2) for 58. */
const cream5 = { lineId: 'line-cream-01', quantity: { from: 3, to: 5 }, lineTotal: { from: 36, to: 58 }, freeQuantity: { from: 1, to: 2 } };
const lines = (edits: Row[], more: Row = {}) => ({ v: 2, edits, ...more });

const linesNow = () => fake.lines.map((l) => ({ ...l }));
const byProduct = (id: string) => fake.lines.filter((l) => l.productId === id);
const activity = (action: string): Row | undefined => fake.activities.find((a) => a.action === action);
/** The activity that MUST be there: a missing one fails the test by name instead of by a TypeError. */
const activityOf = (action: string): Row => {
  const hit = activity(action);
  if (!hit) throw new Error(`no activity «${action}» on the order`);
  return hit;
};
const wroteNothing = () => expect(fake.writes.filter((w) => !w.startsWith('orderItem.update'))).toEqual([]);

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
  approve({ lines: lines([cream5], { snapshot: { after: { cod: 74.5 } } }) });
});

/* ─────────────────────────── Ⅰ · the whole write ─────────────────────────── */

describe('Ⅰ · quantity, price and gift together, atomically', () => {
  it('3 (+1) for 36 becomes 5 (+2) for 58: the lines, the reservation, the gift, the total, the cost — one write', async () => {
    // the goods cost 20 when the order was struck: the soap's share is in it and nobody is touching the soap
    fake.order.estimatedCostOfGoods = 20;
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);

    // the lines: 58 and 10 → 68 before any discount; the add-on of 4 and the fee of 2.500 on top → 74.500
    const cream = byProduct(CREAM)[0];
    expect(cream).toMatchObject({ quantity: 5, freeQuantity: 2, lineTotal: 58, discountShare: 0 });
    expect(byProduct(SOAP)[0]).toMatchObject({ quantity: 2, freeQuantity: 0, lineTotal: 10 });
    // the shelf follows: 5 + 2 gift = 7 held on the cream, 2 on the soap, and nothing is held twice
    expect(cream.reservedQty).toBe(7);
    expect(byProduct(SOAP)[0].reservedQty).toBe(2);
    expect(fake.lines).toHaveLength(2);

    expect(fake.order).toMatchObject({
      totalAmount: 74.5,
      sellingPrice: 68,
      quantity: 7,
      // the order's own count of gifts follows its lines (the courier is told quantity + gift)
      freeQuantity: 2,
      version: 4,
    });
    // 20 + 2.500 × (7 − 4): three more units of the cream, the gift counted, and nothing about the soap moves
    expect(fake.order.estimatedCostOfGoods).toBe(27.5);
    // the request is stamped, once, by whom
    expect(fake.request.appliedAt).toBeInstanceOf(Date);
    expect(fake.request.appliedById).toBe('owner');
  });

  it('leaves the add-ons the customer accepted exactly as they were — collected, held, never rewritten', async () => {
    await apply();
    expect(fake.writes.filter((w) => w.startsWith('orderAddOn'))).toEqual([]);
    expect(fake.addOns).toEqual([{ companyId: COMPANY, orderId: ORDER_ID, productId: DROPS, productName: 'قطرة', quantity: 1, price: 4, reservedQty: 1 }]);
  });

  it('says it ONCE on the order, with the request and what each line was and became — and nothing of the customer', async () => {
    await apply();
    const said = fake.activities.filter((a) => a.action === 'ORDER_UPDATED');
    expect(said).toHaveLength(1);
    const meta = JSON.parse(said[0].metadata);
    expect(meta).toMatchObject({
      requestId: REQUEST_ID,
      fields: ['items'],
      totalBefore: 52.5,
      totalAfter: 74.5,
      lines: [{ productId: CREAM, qtyBefore: 3, qtyAfter: 5, totalBefore: 36, totalAfter: 58, giftBefore: 1, giftAfter: 2 }],
    });
    expect(said[0].metadata).not.toMatch(/cu1|customerName|customerPhone|0791/);
    // and the audit carries the same, beside the decision that allowed it
    const audit = logAudit.mock.calls.map((c) => c[0]).find((e) => e.entity === 'Order');
    expect(audit.action).toBe('ORDER_UPDATED_BY_CHANGE_REQUEST');
    expect(audit.newData.changeRequest).toEqual({ id: REQUEST_ID, reason: 'الزبون بدو يزيد', decision: 'موافق' });
    expect(audit.newData.lineEdits).toHaveLength(1);
    expect(audit.newData.lineSummary).toEqual(['سطر 1 — الكمية: 3 ← 5 · إجمالي السطر: 36 ← 58 · الهدية: 1 ← 2']);
  });

  it('who added a line is a fact about the line’s past: the credit for cross-sell does not move to whoever applied it', async () => {
    await apply();
    for (const l of fake.lines) expect(l).toMatchObject({ addedById: 'agent-1', addedStage: 'INTAKE' });
  });

  it('a discount in the SAME request is spread over the new lines: 3.500 over 58 and 10', async () => {
    approve({ lines: lines([cream5]), discountAmount: { from: 0, to: 3.5 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    // 58/68 × 3.5 = 2.985 and 10/68 × 3.5 = 0.515; 68 − 3.5 + 4 + 2.5 = 71
    expect(fake.lines.map((l) => l.discountShare)).toEqual([2.985, 0.515]);
    expect(fake.order).toMatchObject({ discountAmount: 3.5, totalAmount: 71 });
  });

  it('the customer’s own fields beside the lines are written in the same save', async () => {
    approve({ lines: lines([cream5]), customerNotes: { from: null, to: 'قبل الظهر' } });
    const res = await apply();
    expect(res.status).toBe(200);
    expect(fake.order.customerNotes).toBe('قبل الظهر');
    expect(byProduct(CREAM)[0].quantity).toBe(5);
  });

  it('two lines of ONE product keep their own figures: only the line named is touched', async () => {
    seed({
      lines: [
        line({ id: 'line-a', productId: CREAM, productName: 'كريم', quantity: 3, unitPrice: 12, lineTotal: 36, reservedQty: 3 }),
        line({ id: 'line-b', productId: CREAM, productName: 'كريم', quantity: 2, unitPrice: 12, lineTotal: 24, reservedQty: 2 }),
      ],
      addOns: [],
      order: { quantity: 5, freeQuantity: 0, sellingPrice: 60, totalAmount: 62.5 },
    });
    // the second line from 2 for 24 to 6 for 72; the request remembers its line by id AND by what it read — here the id is gone
    approve({ lines: lines([{ lineId: 'a-line-id-from-before-a-save', quantity: { from: 2, to: 6 }, lineTotal: { from: 24, to: 72 } }]) });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.lines.map((l) => [l.quantity, l.lineTotal, l.reservedQty])).toEqual([[3, 36, 3], [6, 72, 6]]);
    expect(fake.order).toMatchObject({ quantity: 9, sellingPrice: 108, totalAmount: 110.5 });
  });
});

/* ─────────────────────────── Ⅱ · the preview's number is the number written ─────────────────────────── */

describe('Ⅱ · what the preview promised is what the save writes — the gift included', () => {
  const offerRow = {
    id: 'offer-3-plus-1', productId: CREAM, name: '3 + 1', quantity: 3, freeQuantity: 1, sellingPrice: 25,
    discount: 0, compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: null,
  };
  const onSale = [{ id: 'offer-3-plus-1', name: '3 + 1', quantity: 3, freeQuantity: 1, price: 25, listPrice: null }];

  const seedOffer = () => {
    seed({
      lines: [
        line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 8.333, lineTotal: 25, reservedQty: 4 }),
        line({ id: 'line-soap-02', productId: SOAP, productName: 'صابون', quantity: 2, unitPrice: 5, lineTotal: 10, reservedQty: 2 }),
      ],
      addOns: [],
      order: { offerId: 'offer-3-plus-1', sellingPrice: 35, totalAmount: 37.5 },
    });
    fake.offerRow = offerRow;
    activeOffersFor.mockImplementation(async (...a: unknown[]) => (a[2] === CREAM ? onSale : []));
  };

  /** The request the screen of the future will raise out of a preview: every changed line, with the preview's own figures. */
  const requestFrom = (preview: Awaited<ReturnType<typeof previewOrderEdit>>) =>
    lines(
      preview.lines
        .filter((l) => l.changed)
        .map((l) => ({
          lineId: l.lineId, quantity: l.quantity, lineTotal: l.lineTotal, freeQuantity: l.freeQuantity, basis: l.basis, offerId: l.offerId,
        })),
      { snapshot: { after: { cod: preview.after.cod } } }
    );

  it('3 + 1 for 25 → 6 + 2 for 50: the quantity, the price, the GIFT, the total and the shares are the preview’s', async () => {
    seedOffer();
    const preview = await previewOrderEdit({ order: { ...fake.order } as never, companyId: COMPANY, country: JOD, draft: { lines: [{ lineId: 'line-cream-01', quantity: 6 }] } });
    expect(preview.lines[0]).toMatchObject({ lineTotal: { to: 50 }, freeQuantity: { to: 2 }, basis: 'OFFER' });
    approve({ lines: requestFrom(preview) });

    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);

    expect(fake.order.totalAmount, 'ما يجمعه الكاشير ≠ ما وعدت به المعاينة').toBe(preview.after.cod);
    expect(fake.order.sellingPrice).toBe(preview.after.subtotal);
    expect(fake.lines.map((l) => l.discountShare)).toEqual(preview.after.discountShares);
    expect(fake.lines.map((l) => l.lineTotal)).toEqual(preview.lines.map((l) => l.totalAfterDiscount));
    // THE GIFT: line by line, and in the order's own total
    expect(fake.lines.map((l) => l.freeQuantity)).toEqual(preview.lines.map((l) => l.freeQuantity.to));
    expect(fake.order.freeQuantity).toBe(preview.after.giftUnits);
    expect(fake.order.freeQuantity).toBe(2);
    // two bundles of 25, the soap 10, 2.500 → 62.500
    expect(fake.order.totalAmount).toBe(62.5);
  });

  it('…and an offer that ENDED between the raising and the applying changes neither the price nor the gift: what was approved is what is written', async () => {
    seedOffer();
    const preview = await previewOrderEdit({ order: { ...fake.order } as never, companyId: COMPANY, country: JOD, draft: { lines: [{ lineId: 'line-cream-01', quantity: 6 }] } });
    approve({ lines: requestFrom(preview) });
    activeOffersFor.mockResolvedValue([]); // the offer is off sale now

    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(byProduct(CREAM)[0]).toMatchObject({ quantity: 6, freeQuantity: 2, lineTotal: 50 });
    expect(fake.order.totalAmount).toBe(62.5);
  });
});

/* ─────────────────────────── Ⅲ · the order the lines are written in ─────────────────────────── */

describe('Ⅲ · the lines are written in the order they were priced in', () => {
  it('three equal lines under a discount that does not divide: the remainder lands on the first largest — the same line the preview named', async () => {
    // three lines of 10, rows stored in the order c, a, b (one createdAt; ids a < b < c). The engine orders them a, b, c.
    seed({
      lines: [
        line({ id: 'line-c', productId: P_C, productName: 'ج', quantity: 1, unitPrice: 10, lineTotal: 10, reservedQty: 1 }),
        line({ id: 'line-a', productId: P_A, productName: 'أ', quantity: 1, unitPrice: 10, lineTotal: 10, reservedQty: 1 }),
        line({ id: 'line-b', productId: P_B, productName: 'ب', quantity: 1, unitPrice: 10, lineTotal: 10, reservedQty: 1 }),
      ],
      addOns: [],
      order: { quantity: 3, freeQuantity: 0, sellingPrice: 30, totalAmount: 32.5, productId: P_A },
    });
    const all = ['line-a', 'line-b', 'line-c'].map((lineId) => ({ lineId, quantity: { from: 1, to: 2 }, lineTotal: { from: 10, to: 20 } }));
    approve({ lines: lines(all), discountAmount: { from: 0, to: 1 } });

    const preview = await previewOrderEdit({
      order: { ...fake.order } as never, companyId: COMPANY, country: JOD,
      draft: { lines: all.map((e) => ({ lineId: e.lineId, quantity: 2 })), discountAmount: 1 },
    });
    // 1.000 over three equal lines: 0.333 each and the 0.001 left over goes to the FIRST of them — line a
    expect(preview.lineOrder).toEqual(['line-a', 'line-b', 'line-c']);
    expect(preview.after.discountShares).toEqual([0.334, 0.333, 0.333]);

    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    const share = (p: string) => byProduct(p)[0].discountShare;
    expect([share(P_A), share(P_B), share(P_C)]).toEqual([0.334, 0.333, 0.333]);
    // and the rows really were written a, b, c — not as the rows happened to come back
    expect(fake.lines.map((l) => l.productId)).toEqual([P_A, P_B, P_C]);
  });
});

/* ─────────────────────────── Ⅳ · the shelf ─────────────────────────── */

describe('Ⅳ · a shelf that cannot carry the lines stops everything', () => {
  it('seen by the plan: nothing is written, and the answer names the product', async () => {
    // 5 + 2 = 7 wanted, the order held 4, and 5 are on the shelf: three short
    fake.shelf[CREAM] = 5;
    const res = await apply();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('STOCK_SHORT');
    expect(body.error).toContain('كريم');
    wroteNothing();
    expect(fake.request.appliedAt).toBeNull();
  });

  it('seen only INSIDE the write (somebody took the stock in between): the old lines come back WITH their reservation, and nothing else is written', async () => {
    const before = linesNow();
    const orderBefore = { ...fake.order };
    fake.hooks.beforeCreateMany = () => {
      fake.shelf[CREAM] = 5; // the stock went while the plan was being made
    };
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STOCK_SHORT');
    expect(fake.lines).toEqual(before);
    expect(fake.lines.map((l) => l.reservedQty)).toEqual([4, 2]);
    expect(fake.order).toEqual(orderBefore);
    expect(fake.activities).toEqual([]);
    expect(fake.request.appliedAt).toBeNull();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('RV400: a product on two lines of 3 and 4 against a shelf of 5 — each fits ALONE, and the sum does not: refused', async () => {
    seed({
      lines: [
        line({ id: 'line-a', productId: CREAM, productName: 'كريم', quantity: 2, unitPrice: 12, lineTotal: 24, reservedQty: 2 }),
        line({ id: 'line-b', productId: CREAM, productName: 'كريم', quantity: 3, unitPrice: 12, lineTotal: 36, reservedQty: 3 }),
      ],
      addOns: [],
      order: { quantity: 5, freeQuantity: 0, sellingPrice: 60, totalAmount: 62.5 },
    });
    approve({
      lines: lines([
        { lineId: 'line-a', quantity: { from: 2, to: 3 }, lineTotal: { from: 24, to: 36 } },
        { lineId: 'line-b', quantity: { from: 3, to: 4 }, lineTotal: { from: 36, to: 48 } },
      ]),
    });
    // 3 + 4 = 7 against 5 on the shelf; the order held 5 before
    fake.hooks.beforeCreateMany = () => {
      fake.shelf[CREAM] = 5;
    };
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STOCK_SHORT');
    expect(fake.lines.map((l) => [l.quantity, l.reservedQty])).toEqual([[2, 2], [3, 3]]);
  });

  it('…and the per-line reserver ALONE would have let that through — which is why the sum is asked (RV400, documented)', async () => {
    seed({
      lines: [
        line({ id: 'line-a', productId: CREAM, productName: 'كريم', quantity: 3, unitPrice: 12, lineTotal: 36, reservedQty: 0 }),
        line({ id: 'line-b', productId: CREAM, productName: 'كريم', quantity: 4, unitPrice: 12, lineTotal: 48, reservedQty: 0 }),
      ],
      addOns: [],
    });
    fake.shelf[CREAM] = 5;
    const held = await reserveOrderLines(fake.tx, ORDER_ID, { allowNegativeStock: false });
    expect(held.shortages).toEqual([]);
    expect(fake.lines.reduce((sum, l) => sum + l.reservedQty, 0)).toBe(7);
  });

  it('where the country lets stock go negative, the shortage is let through and the lines are written', async () => {
    requireContext.mockResolvedValue({
      user: { id: 'owner', name: 'المالك', role: 'COMPANY_ADMIN' }, companyId: COMPANY, storeId: STORE, countryId: JOD.id,
      country: { ...JOD, allowNegativeStock: true },
    });
    fake.shelf[CREAM] = 5;
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(byProduct(CREAM)[0]).toMatchObject({ quantity: 5, freeQuantity: 2, reservedQty: 7 });
  });

  it('an order that was ALREADY short is not stopped by an edit that does not make it worse', async () => {
    // the order holds 4 of the cream, the shelf has 3 (counted down since); a quantity of 3 (+1) asks for the same 4
    fake.shelf[CREAM] = 3;
    approve({ lines: lines([{ lineId: 'line-soap-02', quantity: { from: 2, to: 3 }, lineTotal: { from: 10, to: 15 } }]) });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(byProduct(SOAP)[0].quantity).toBe(3);
  });
});

/* ─────────────────────────── Ⅴ · it refuses, it does not guess ─────────────────────────── */

describe('Ⅴ · a decision is carried out against the order it was about — or not at all', () => {
  const refused = async (code: string, status = 409) => {
    const before = { order: { ...fake.order }, lines: linesNow() };
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(status);
    expect((await res.json()).code).toBe(code);
    wroteNothing();
    expect(fake.order).toEqual(before.order);
    expect(fake.lines).toEqual(before.lines);
    expect(fake.request.appliedAt).toBeNull();
  };

  it('LINES_STALE: the line the request names is not as it was', async () => {
    fake.lines[0] = { ...fake.lines[0], quantity: 4, lineTotal: 48, freeQuantity: 1 };
    await refused('LINES_STALE');
  });

  it('LINES_STALE: the line is gone and nothing on the order answers to what the request recorded', async () => {
    approve({ lines: lines([{ ...cream5, lineId: 'long-gone' }]) });
    fake.lines.splice(0, 1);
    await refused('LINES_STALE');
  });

  it('LINES_STALE inside the write: a line appeared after the plan was made — the rows are looked at once more', async () => {
    fake.hooks.atTxStart = () => {
      fake.lines.push(line({ id: 'line-late-03', productId: DROPS, productName: 'قطرة', quantity: 1, unitPrice: 4, lineTotal: 4 }));
    };
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('LINES_STALE');
    expect(fake.lines.map((l) => l.id)).toEqual(['line-cream-01', 'line-soap-02', 'line-late-03']);
    expect(fake.request.appliedAt).toBeNull();
  });

  it('TOTAL_CHANGED: the total the decider was shown is not what the lines now come to', async () => {
    approve({ lines: lines([cream5], { snapshot: { after: { cod: 99 } } }) });
    await refused('TOTAL_CHANGED');
  });

  it('FEE_SOURCE_DRIFT: two delivery fees on one order — nothing is touched, whichever of them is right', async () => {
    fake.order.deliveryFee = 3.5;
    await refused('FEE_SOURCE_DRIFT');
  });

  it('COD_DRIFT: the stored total is not the lines’ total — the save would rewrite it in silence', async () => {
    fake.order.totalAmount = 55;
    await refused('COD_DRIFT');
  });

  it('STATEMENT_LINKED: a courier statement claims the order — it writes the money', async () => {
    fake.claims = 1;
    await refused('STATEMENT_LINKED');
  });

  it('STATEMENT_LINKED: and so does a settlement that has moved past «قيد التحصيل»', async () => {
    fake.order.settlementStatus = 'COLLECTED';
    await refused('STATEMENT_LINKED');
  });

  it('LINES_COMMITTED: a line already delivered is a record', async () => {
    fake.lines[1] = { ...fake.lines[1], deliveredQty: 1 };
    await refused('LINES_COMMITTED');
  });

  it('CANCEL_AND_REORDER: the company holds the parcel — even when somebody says the courier was told', async () => {
    fake.batch = { status: 'SHIPPED', batchNumber: 'B-7' };
    await refused('CANCEL_AND_REORDER');
    const told = await apply({ courierNotified: true });
    expect(told.status).toBe(409);
    expect((await told.json()).code).toBe('CANCEL_AND_REORDER');
    wroteNothing();
  });

  it('PRODUCT_INACTIVE: a product swapped in has been switched off since', async () => {
    fake.products = fake.products.map((p) => (p.id === DROPS ? { ...p, status: 'INACTIVE' } : p));
    approve({ lines: lines([{ lineId: 'line-soap-02', productId: { from: SOAP, to: DROPS }, lineTotal: { from: 10, to: 17 } }]) });
    await refused('PRODUCT_INACTIVE');
  });

  it('VERSION_CONFLICT: the order moved since the screen loaded it — refused before anybody is asked anything', async () => {
    const res = await patch({ expectedVersion: 2, changeRequestId: REQUEST_ID });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('VERSION_CONFLICT');
    wroteNothing();
  });

  it('a stale version is the word VERSION_CONFLICT even when a line is stale too — and no line is read for a decision the order has moved past', async () => {
    fake.lines[0] = { ...fake.lines[0], quantity: 4, lineTotal: 48 };
    const res = await patch({ expectedVersion: 2, changeRequestId: REQUEST_ID });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('VERSION_CONFLICT');
    wroteNothing();
  });

  it('VERSION_CONFLICT inside the write: the order moved during it — everything goes back', async () => {
    const before = linesNow();
    fake.hooks.atTxStart = () => {
      fake.order.version += 1;
    };
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('VERSION_CONFLICT');
    expect(fake.lines).toEqual(before);
    expect(fake.request.appliedAt).toBeNull();
  });

  it('a request already applied, or not approved, is refused before any of this is asked', async () => {
    approve({ lines: lines([cream5]) }, { status: 'PENDING' });
    expect((await (await apply()).json()).code).toBe('NOT_APPROVED');
    approve({ lines: lines([cream5]) }, { appliedAt: new Date() });
    expect((await (await apply()).json()).code).toBe('ALREADY_APPLIED');
    wroteNothing();
  });
});

/* ─────────────────────────── Ⅵ · the waybill, the barcode and the company ─────────────────────────── */

describe('Ⅵ · the parcel is still ours: the waybill is printed again, the barcode is cancelled — AFTER the shelf is asked', () => {
  const barcoded = (cancelShipment: () => Promise<void> = async () => undefined) => {
    seed({ order: { deliveryProviderId: 'co1', trackingNumber: 'LG-9', courierSendStartedAt: new Date(), labelPrintedAt: new Date('2026-10-28T08:00:00Z') } });
    approve({ lines: lines([cream5], { snapshot: { after: { cod: 74.5 } } }) });
    const adapter = { automated: true, code: 'LOGESTECHS', name: 'LogesTechs', cancelShipment: vi.fn(cancelShipment) };
    adapterFor.mockReturnValue(adapter);
    return adapter;
  };

  it('a printed waybill is cleared in the same write, and the order says it is printed again', async () => {
    seed({ order: { labelPrintedAt: new Date('2026-10-28T08:00:00Z') } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.order.labelPrintedAt).toBeNull();
    const stale = activityOf('LABEL_STALE_REPRINT');
    expect(JSON.parse(stale.metadata)).toMatchObject({ fields: ['items'], requestId: REQUEST_ID });
  });

  it('NEGATIVE: an order with no waybill has nothing to reprint', async () => {
    await apply();
    expect(activity('LABEL_STALE_REPRINT')).toBeUndefined();
  });

  it('a barcode the company holds is cancelled THERE, once the shelf has said yes — and the barcode goes with it', async () => {
    const adapter = barcoded();
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(adapter.cancelShipment).toHaveBeenCalledWith('LG-9');
    expect(fake.order).toMatchObject({ trackingNumber: null, courierSendStartedAt: null, labelPrintedAt: null, totalAmount: 74.5 });
  });

  it('a shelf that cannot carry the lines is found BEFORE the company is told to cancel anything', async () => {
    const adapter = barcoded();
    fake.shelf[CREAM] = 5;
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STOCK_SHORT');
    expect(adapter.cancelShipment, 'انلغى طرد الشركة لتعديل ما بيتحفظ').not.toHaveBeenCalled();
    wroteNothing();
  });

  it('…and so is a shelf that went short AFTER the plan and before the company was asked (the fresh question)', async () => {
    const adapter = barcoded();
    // the item-lookup of the write is the first thing after the plan: the stock is gone by then
    fake.hooks.onLateProductRead = () => {
      fake.shelf[CREAM] = 5;
    };
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STOCK_SHORT');
    expect(adapter.cancelShipment).not.toHaveBeenCalled();
    expect(fake.order.trackingNumber).toBe('LG-9');
  });

  it('if the stock goes in the very last instant, after the company said yes: it is said on the order, and the dead barcode is cleared', async () => {
    const adapter = barcoded();
    fake.hooks.beforeCreateMany = () => {
      fake.shelf[CREAM] = 5;
    };
    const res = await apply();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('STOCK_SHORT');
    expect(body.error).toContain('أُلغي الطرد');
    expect(adapter.cancelShipment).toHaveBeenCalledTimes(1);
    // the rollback gave the order back its barcode; it is cleared, because the company no longer has that parcel
    expect(fake.order.trackingNumber).toBeNull();
    expect(fake.order.courierSendStartedAt).toBeNull();
    expect(JSON.parse(activityOf('COURIER_CANCELLED_EDIT_NOT_SAVED').metadata)).toMatchObject({ barcode: 'LG-9', door: 'LINE_EDIT' });
    expect(fake.lines.map((l) => l.reservedQty)).toEqual([4, 2]);
  });

  it('the same for lines that changed under the write', async () => {
    barcoded();
    fake.hooks.atTxStart = () => {
      fake.lines.push(line({ id: 'line-late-03', productId: DROPS, productName: 'قطرة', quantity: 1, unitPrice: 4, lineTotal: 4 }));
    };
    const res = await apply();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('LINES_STALE');
    expect(body.error).toContain('أُلغي الطرد');
    expect(fake.order.trackingNumber).toBeNull();
    expect(activity('COURIER_CANCELLED_EDIT_NOT_SAVED')).toBeDefined();
  });

  it('on the company’s refusal: their words, and NOTHING is edited', async () => {
    barcoded(async () => {
      throw new CourierRefusal('x', 400, 'الطرد مع السائق');
    });
    const before = linesNow();
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('الطرد مع السائق');
    expect(fake.lines).toEqual(before);
    expect(fake.order.trackingNumber).toBe('LG-9');
  });
});

/* ─────────────────────────── Ⅶ · the older request, translated ─────────────────────────── */

describe('Ⅶ · the request the old way (a quantity, a price) on an order of ONE line is carried out, whole', () => {
  const oneLine = () =>
    seed({
      lines: [line({ id: 'line-only-01', productId: CREAM, productName: 'كريم', quantity: 3, unitPrice: 12, lineTotal: 36, reservedQty: 3 })],
      addOns: [],
      order: { quantity: 3, freeQuantity: 0, sellingPrice: 36, totalAmount: 38.5 },
    });

  it('RV310 CLOSED: a quantity on a confirmed, reserved order is no longer refused — it is applied at the piece price the line had', async () => {
    oneLine();
    approve({ quantity: { from: 3, to: 5 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    // 36 for three is 12 each: sixty for five, the shelf holds five, and the total follows (60 + 2.500)
    expect(fake.lines).toHaveLength(1);
    expect(fake.lines[0]).toMatchObject({ quantity: 5, lineTotal: 60, reservedQty: 5 });
    expect(fake.order).toMatchObject({ quantity: 5, sellingPrice: 60, totalAmount: 62.5 });
  });

  it('a price: taken as the line’s total for the quantity it has', async () => {
    oneLine();
    approve({ sellingPrice: { from: 36, to: 30 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.lines[0]).toMatchObject({ quantity: 3, lineTotal: 30, reservedQty: 3 });
    expect(fake.order.totalAmount).toBe(32.5);
  });

  it('a quantity AND a price together, as the old request could say them', async () => {
    oneLine();
    approve({ quantity: { from: 3, to: 5 }, sellingPrice: { from: 36, to: 58 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.lines[0]).toMatchObject({ quantity: 5, lineTotal: 58, reservedQty: 5 });
    expect(fake.order.totalAmount).toBe(60.5);
  });

  it('a product: the line moves to it, the shelf follows, and the gift is not carried across', async () => {
    oneLine();
    approve({ productId: { from: CREAM, to: SOAP } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.lines[0]).toMatchObject({ productId: SOAP, quantity: 3, reservedQty: 3 });
    expect(fake.order.productId).toBe(SOAP);
  });

  it('NEGATIVE: with TWO lines the old refusals stand — the shorthand cannot say which line it means', async () => {
    approve({ quantity: { from: 5, to: 7 } });
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RESERVED_GOODS_EDIT');
    wroteNothing();
  });

  it('NEGATIVE: an address, a phone or a note touches no line, reads no shelf, and writes no line', async () => {
    approve({ customerNotes: { from: null, to: 'قبل الظهر' } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.writes.filter((w) => w.startsWith('orderItem'))).toEqual([]);
    expect(fake.lines.map((l) => l.reservedQty)).toEqual([4, 2]);
  });
});

/* ─────────────────────────── Ⅷ · no new door ─────────────────────────── */

describe('Ⅷ · nothing else gained a way to write a gift or a line', () => {
  it('a DIRECT save of the lines cannot send a gift: the key is dropped and the gift is carried as it always was', async () => {
    seed({ order: { confirmationStatus: 'IN_PROGRESS', status: 'CONTACTING', shippingStatus: 'NOT_READY', shippingBatchId: null, settlementStatus: 'NOT_APPLICABLE' } });
    fake.lines = fake.lines.map((l) => ({ ...l, reservedQty: 0 }));
    authorize.mockReturnValue({ allowed: true });
    can.mockImplementation((_u: unknown, key: string) => key !== 'ops.edit_in_batch');
    const res = await patch({
      expectedVersion: 3,
      reason: 'تصحيح الأسطر قبل التأكيد',
      items: [
        { productId: CREAM, quantity: 3, unitPrice: 36, freeQuantity: 9 },
        { productId: SOAP, quantity: 2, unitPrice: 10, freeQuantity: 9 },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    // the cream keeps the 1 it had; the soap had none and gets none — never the 9
    expect(fake.lines.map((l) => l.freeQuantity)).toEqual([1, 0]);
    // and a direct save is not an approved edit: it does not touch the order's gift total or its cost
    expect(fake.order.freeQuantity).toBe(1);
    expect(fake.order.estimatedCostOfGoods).toBe(0);
  });

  it('the lines save names no `freeQuantity` in its schema, and takes none from a body', () => {
    const src = stripComments(repoFile('src/app/api/orders/[id]/route.ts'));
    const schema = src.slice(src.indexOf('const patchSchema'), src.indexOf('export async function'));
    expect(schema).not.toMatch(/freeQuantity/);
  });

  it('a DIRECT save of lines on a confirmed order is still a request to raise', async () => {
    authorize.mockReturnValue({ allowed: true });
    can.mockImplementation((_u: unknown, key: string) => key !== 'ops.edit_in_batch');
    const res = await patch({ expectedVersion: 3, items: [{ productId: CREAM, quantity: 4, unitPrice: 48 }] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGE_REQUEST_REQUIRED');
    wroteNothing();
  });
});

/* ─────────────────────────── Ⅸ · the reviews of #120, each with its negative ─────────────────────────── */

describe('Ⅸ · the request is stamped applied INSIDE the write', () => {
  it('two presses on one approval: the loser’s whole write goes back, and the winner’s name stays on the stamp (ALREADY_APPLIED)', async () => {
    const before = linesNow();
    const orderBefore = { ...fake.order };
    fake.hooks.atTxStart = () => {
      fake.request.appliedAt = new Date('2026-10-30T10:00:00Z');
      fake.request.appliedById = 'someone-else';
    };
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPLIED');
    expect(fake.lines).toEqual(before);
    expect(fake.order).toEqual(orderBefore);
    expect(fake.activities).toEqual([]);
    expect(fake.request.appliedById).toBe('someone-else');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a write that fails AFTER the stamp takes the stamp with it: the request is still «approved, not applied»', async () => {
    fake.hooks.beforeCreateMany = () => {
      fake.shelf[CREAM] = 5;
    };
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STOCK_SHORT');
    // the stamp WAS written (inside the write), and went back with it
    expect(fake.writes).toContain('orderChangeRequest.updateMany');
    expect(fake.request.appliedAt).toBeNull();
    expect(fake.request.appliedById).toBeUndefined();
  });

  it('a crash after the commit (the audit cannot be written) leaves an edit AND its stamp — never an edit the request does not know about', async () => {
    logAudit.mockRejectedValue(new Error('the audit store is down'));
    const res = await apply();
    expect(res.status).toBe(500);
    expect(byProduct(CREAM)[0].quantity).toBe(5);
    expect(fake.request.appliedAt).toBeInstanceOf(Date);
  });

  it('stamps once, in the same write as the order, and not again afterwards', async () => {
    await apply();
    expect(fake.writes.filter((w) => w === 'orderChangeRequest.updateMany')).toHaveLength(1);
    expect(fake.writes.indexOf('order.updateMany')).toBeLessThan(fake.writes.indexOf('orderChangeRequest.updateMany'));
  });

  it('an address-only request is stamped the same way (the door is the one door)', async () => {
    approve({ customerNotes: { from: null, to: 'قبل الظهر' } });
    fake.hooks.atTxStart = () => {
      fake.request.appliedAt = new Date();
    };
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPLIED');
    expect(fake.order.customerNotes).toBeNull();
  });
});

describe('Ⅹ · the answer to the person who applied it is the few fields the screen needs', () => {
  const KEYS = ['id', 'orderNumber', 'quantity', 'regionId', 'sellingPrice', 'totalAmount', 'version'];

  it('a lines request: no cost of goods, no profit, no commission — whatever the applier’s keys', async () => {
    fake.order.estimatedCostOfGoods = 20;
    fake.order.netProfit = 12;
    const res = await apply();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.order).sort()).toEqual(KEYS);
    expect(JSON.stringify(body)).not.toMatch(/estimatedCostOfGoods|netProfit/);
    expect(body.order).toMatchObject({ totalAmount: 74.5, version: 4 });
  });

  it('and so is an address-only request', async () => {
    approve({ customerNotes: { from: null, to: 'قبل الظهر' } });
    const body = await (await apply()).json();
    expect(Object.keys(body.order).sort()).toEqual(KEYS);
  });
});

describe('Ⅺ · an old shorthand request, translated, is what the old door would have done', () => {
  const offerRow = {
    id: 'offer-3-plus-1', productId: CREAM, name: '3 + 1', quantity: 3, freeQuantity: 1, sellingPrice: 25,
    discount: 0, compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: null,
  };
  const onSale = [{ id: 'offer-3-plus-1', name: '3 + 1', quantity: 3, freeQuantity: 1, price: 25, listPrice: null }];

  it('THE GIFT IS NOT WORKED OUT AGAIN: 3 → 6 on a line priced by a live «3 + 1» keeps the gift it holds (1), not 2', async () => {
    seed({
      lines: [line({ id: 'line-only-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 8.333, lineTotal: 25, reservedQty: 4 })],
      addOns: [],
      order: { offerId: 'offer-3-plus-1', quantity: 3, freeQuantity: 1, sellingPrice: 25, totalAmount: 27.5 },
    });
    fake.offerRow = offerRow;
    activeOffersFor.mockImplementation(async (...a: unknown[]) => (a[2] === CREAM ? onSale : []));
    approve({ quantity: { from: 3, to: 6 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    // 25 for three is 50 for six — the piece price, as it always was — and ONE free unit, as the line held
    expect(fake.lines[0]).toMatchObject({ quantity: 6, freeQuantity: 1, lineTotal: 50, reservedQty: 7 });
    expect(fake.order.freeQuantity).toBe(1);
    // NEGATIVE: the new request shape, whose gift the decider saw, does carry the 2
    seed({
      lines: [line({ id: 'line-only-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 8.333, lineTotal: 25, reservedQty: 4 })],
      addOns: [],
      order: { offerId: 'offer-3-plus-1', quantity: 3, freeQuantity: 1, sellingPrice: 25, totalAmount: 27.5 },
    });
    fake.offerRow = offerRow;
    approve({
      lines: lines([{ lineId: 'line-only-01', quantity: { from: 3, to: 6 }, lineTotal: { from: 25, to: 50 }, freeQuantity: { from: 1, to: 2 } }]),
    });
    expect((await apply()).status).toBe(200);
    expect(fake.lines[0].freeQuantity).toBe(2);
  });

  it('A PRICE THAT IS THERE IS A PRICE: «3 → 6, keep the price at 50» on a line that already costs 50 is 50 for six', async () => {
    seed({
      lines: [line({ id: 'line-only-01', productId: CREAM, productName: 'كريم', quantity: 3, unitPrice: 16.667, lineTotal: 50, reservedQty: 3 })],
      addOns: [],
      order: { quantity: 3, freeQuantity: 0, sellingPrice: 50, totalAmount: 52.5 },
    });
    approve({ quantity: { from: 3, to: 6 }, sellingPrice: { from: 50, to: 50 } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.lines[0]).toMatchObject({ quantity: 6, lineTotal: 50, reservedQty: 6 });
    expect(fake.order).toMatchObject({ sellingPrice: 50, totalAmount: 52.5 });
  });

  it('NEGATIVE: without the price the same quantity is re-priced by the piece — 50 for three is 100 for six', async () => {
    seed({
      lines: [line({ id: 'line-only-01', productId: CREAM, productName: 'كريم', quantity: 3, unitPrice: 16.667, lineTotal: 50, reservedQty: 3 })],
      addOns: [],
      order: { quantity: 3, freeQuantity: 0, sellingPrice: 50, totalAmount: 52.5 },
    });
    approve({ quantity: { from: 3, to: 6 } });
    await apply();
    expect(fake.lines[0]).toMatchObject({ quantity: 6, lineTotal: 100 });
    expect(fake.order.totalAmount).toBe(102.5);
  });
});

describe('Ⅻ · the order keeps its name', () => {
  const three = () => {
    seed({
      lines: [
        line({ id: 'line-c', productId: P_C, productName: 'ج', quantity: 1, unitPrice: 10, lineTotal: 10, reservedQty: 1 }),
        line({ id: 'line-a', productId: P_A, productName: 'أ', quantity: 1, unitPrice: 10, lineTotal: 10, reservedQty: 1 }),
        line({ id: 'line-b', productId: P_B, productName: 'ب', quantity: 1, unitPrice: 10, lineTotal: 10, reservedQty: 1 }),
      ],
      addOns: [],
      order: { quantity: 3, freeQuantity: 0, sellingPrice: 30, totalAmount: 32.5, productId: P_C, productNameSnapshot: 'ج' },
    });
  };

  it('the main product stays while it is still among the lines — "first by (createdAt, id)" would be a coin toss after every save', async () => {
    three();
    approve({ lines: lines([{ lineId: 'line-b', quantity: { from: 1, to: 2 }, lineTotal: { from: 10, to: 20 } }]) });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.order.productId).toBe(P_C);
    expect(fake.order.productNameSnapshot).toBe('ج');
  });

  it('NEGATIVE: when the line of the main product is swapped away, the first line in the priced order is the new name', async () => {
    three();
    approve({ lines: lines([{ lineId: 'line-c', productId: { from: P_C, to: P_B }, lineTotal: { from: 10, to: 10 } }]) });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    // lines are a, b, c in the priced order, and the first of them is a
    expect(fake.order.productId).toBe(P_A);
  });
});

describe('ⅩⅢ · what the goods cost moves with the lines that moved', () => {
  it('a line nobody touched keeps its share: the soap’s cost is not re-struck at today’s batches', async () => {
    fake.order.estimatedCostOfGoods = 20;
    fake.costs[SOAP] = 9; // today's batches say the soap costs far more; the order was struck at its own day's figure
    await apply();
    // only the cream's three extra units move it: 20 + 2.500 × 3
    expect(fake.order.estimatedCostOfGoods).toBe(27.5);
  });

  it('NEGATIVE: a price alone moves no units and so no cost', async () => {
    fake.order.estimatedCostOfGoods = 20;
    approve({ lines: lines([{ lineId: 'line-cream-01', lineTotal: { from: 36, to: 40 } }]) });
    expect((await apply()).status).toBe(200);
    expect(fake.order.estimatedCostOfGoods).toBe(20);
  });
});

describe('ⅩⅢb · the cost is an estimate by the share of the units', () => {
  it('(أ) fewer units come off at the order’s own average — not at today’s, which would cut it to nothing with a unit still on the order', async () => {
    // 6 units (cream 3+1, soap 2) cost 24: 4 a unit. The cream goes to ONE unit: three units off at 4. Today's cream average is 9.
    fake.order.estimatedCostOfGoods = 24;
    fake.costs[CREAM] = 9;
    approve({ lines: lines([{ lineId: 'line-cream-01', quantity: { from: 3, to: 1 }, lineTotal: { from: 36, to: 12 }, freeQuantity: { from: 1, to: 0 } }]) });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.order.estimatedCostOfGoods).toBe(12);
  });

  it('(ج) a cost struck at nothing is not invented — it stays nothing, and the order says it was not re-estimated', async () => {
    fake.order.estimatedCostOfGoods = 0;
    const res = await apply();
    expect(res.status).toBe(200);
    expect(fake.order.estimatedCostOfGoods).toBe(0);
    expect(JSON.parse(activityOf('ORDER_UPDATED').metadata).costNote).toContain('غير معروفة');
  });

  it('NEGATIVE: a cost that is known says nothing of the kind', async () => {
    fake.order.estimatedCostOfGoods = 20;
    await apply();
    expect(JSON.parse(activityOf('ORDER_UPDATED').metadata)).not.toHaveProperty('costNote');
  });
});

describe('ⅩⅢc · a request that changes no line is a plain edit of the customer', () => {
  it('a quantity «changed» to the one the order has, beside a new name, on an order a statement claims: it goes through — no STATEMENT_LINKED, no shelf, no line written', async () => {
    // one line, so the plan WOULD judge a shorthand quantity if it were asked
    seed({
      lines: [line({ id: 'line-only-01', productId: CREAM, productName: 'كريم', quantity: 3, unitPrice: 12, lineTotal: 36, reservedQty: 3 })],
      addOns: [],
      order: { quantity: 3, freeQuantity: 0, sellingPrice: 36, totalAmount: 38.5 },
    });
    fake.claims = 1;
    approve({ quantity: { from: 3, to: 3 }, customerName: { from: 'أحمد', to: 'محمد علي' } });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(JSON.stringify(fake.customerWrites)).toContain('محمد علي');
    expect(fake.writes.filter((w) => w.startsWith('orderItem'))).toEqual([]);
  });

  it('NEGATIVE: the same order and a quantity that really changes IS judged as goods — and refused as the statement’s', async () => {
    fake.claims = 1;
    seed({
      lines: [line({ id: 'line-only-01', productId: CREAM, productName: 'كريم', quantity: 3, unitPrice: 12, lineTotal: 36, reservedQty: 3 })],
      addOns: [],
      order: { quantity: 3, freeQuantity: 0, sellingPrice: 36, totalAmount: 38.5 },
    });
    fake.claims = 1;
    approve({ quantity: { from: 3, to: 5 }, customerName: { from: 'أحمد', to: 'محمد علي' } });
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATEMENT_LINKED');
    wroteNothing();
  });

  it('«keep the price at 50» beside a quantity that changes stays a price (all its keys go to the plan)', async () => {
    seed({
      lines: [line({ id: 'line-only-01', productId: CREAM, productName: 'كريم', quantity: 3, unitPrice: 16.667, lineTotal: 50, reservedQty: 3 })],
      addOns: [],
      order: { quantity: 3, freeQuantity: 0, sellingPrice: 50, totalAmount: 52.5 },
    });
    approve({ quantity: { from: 3, to: 6 }, sellingPrice: { from: 50, to: 50 } });
    expect((await apply()).status).toBe(200);
    expect(fake.lines[0]).toMatchObject({ quantity: 6, lineTotal: 50 });
  });
});

describe('ⅩⅣ · a price alone does not touch what a line holds on the shelf', () => {
  it('even when the shelf has been sold past the order: no line loses its reservation, and none is written again', async () => {
    fake.shelf[CREAM] = 3; // the order holds 4 of it
    approve({ lines: lines([{ lineId: 'line-cream-01', lineTotal: { from: 36, to: 40 } }]) });
    const res = await apply();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fake.lines.map((l) => l.reservedQty)).toEqual([4, 2]);
    expect(fake.writes).not.toContain('orderItem.update');
    expect(byProduct(CREAM)[0].lineTotal).toBe(40);
    expect(fake.order.totalAmount).toBe(56.5);
  });

  it('NEGATIVE: a quantity does re-reserve the line it moves (and only that one keeps nothing)', async () => {
    await apply();
    expect(byProduct(CREAM)[0].reservedQty).toBe(7);
    expect(byProduct(SOAP)[0].reservedQty).toBe(2);
  });
});

describe('ⅩⅤ · a request without its «before» is not this shape', () => {
  it('422 LINES_INVALID, naming the missing «before», and nothing is written', async () => {
    approve({ lines: lines([{ lineId: 'line-cream-01', quantity: { to: 5 }, lineTotal: { to: 58 } }]) });
    const res = await apply();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('LINES_INVALID');
    expect(body.error).toContain('قبل');
    wroteNothing();
  });
});
