import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderEditFacts, PreviewDraft, StoredLine } from '@/lib/order-line-edit';
import { readLinesChange, touchesMoney } from '@/lib/change-request-fields';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * RAISING A REQUEST THAT EDITS SEVERAL LINES — THE SERVER JUDGES IT, THE SERVER WRITES IT.
 *
 * «أقدر أعدل كذا شغلة بنفس الوقت، مثلاً الكمية أكيد بتتطلب أغير معها السعر» — and «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 * The route here is the REAL `POST /api/orders/:id/change-requests`, with the real lines engine and the real fields
 * library. Only what reads the world is a fake: the database, the permission check, and the facts reader (it hands the
 * engine an order built in this file, so a test can make the shelf short, the stored total wrong, or the parcel gone).
 *
 * The order, in three-place JOD:
 *   L1 · cream  × 3 at 36.000 (12.000 each)      L2 · soap × 2 at 10.000 (5.000 each)
 *   subtotal 46.000, no discount, delivery 2.500  →  the courier collects 48.500
 * ═══════════════════════════════════════════════════════════════════════
 */

const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';
const L1 = 'line-cream-1';
const L2 = 'line-soap-2';

interface PreviewCall {
  draft: PreviewDraft;
}

const { db, requireContext, assertOrderAccess, can, state, createNotification } = vi.hoisted(() => ({
  db: {
    orderChangeRequest: {
      findFirst: vi.fn<(args: { where: Record<string, unknown> }) => Promise<unknown>>(),
      create: vi.fn<(args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>>(),
      update: vi.fn<(args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>>(),
    },
    shippingBatch: { findFirst: vi.fn<(...a: unknown[]) => Promise<unknown>>() },
    order: { findFirst: vi.fn<(...a: unknown[]) => Promise<unknown>>() },
    orderNote: { create: vi.fn<(...a: unknown[]) => Promise<unknown>>() },
  },
  requireContext: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  assertOrderAccess: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  can: vi.fn<(...a: unknown[]) => boolean>(),
  createNotification: vi.fn<(...a: unknown[]) => Promise<number>>(),
  state: { facts: null as unknown, previews: [] as unknown[] },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: vi.fn(),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/notify', () => ({ afterResponse: (fn: () => Promise<void>) => void fn() }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a) }));
// The facts reader is the one fake: the REAL engine judges whatever order this file builds.
vi.mock('@/lib/order-edit-facts', async () => {
  const engine = await vi.importActual<typeof import('@/lib/order-line-edit')>('@/lib/order-line-edit');
  return {
    previewOrderEdit: async (args: { draft: PreviewDraft }) => {
      state.previews.push({ draft: args.draft } satisfies PreviewCall);
      return engine.previewLineEdit(state.facts as OrderEditFacts, args.draft);
    },
  };
});

import { POST } from './route';

const stored = (over: Partial<StoredLine> & { id: string }): StoredLine => ({
  productId: CREAM,
  productName: 'كريم',
  quantity: 3,
  freeQuantity: 0,
  lineTotal: 36,
  reservedQty: 3,
  deliveredQty: null,
  returnedQty: null,
  ...over,
});

const factsOf = (over: { order?: Partial<OrderEditFacts['order']>; customer?: Partial<OrderEditFacts['customer']> } & Partial<Omit<OrderEditFacts, 'order' | 'customer'>> = {}): OrderEditFacts => {
  const { order, customer, ...rest } = over;
  return {
    minorUnit: 3,
    allowNegativeStock: false,
    order: {
      confirmed: true,
      closed: false,
      handed: false,
      labelled: false,
      statementLinked: false,
      priceIncludesDelivery: false,
      storedTotal: 48.5,
      shippingCost: 2.5,
      deliveryFee: null,
      discount: 0,
      version: 7,
      ...order,
    },
    lines: [stored({ id: L1 }), stored({ id: L2, productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10, reservedQty: 2 })],
    addOns: [],
    products: [
      { id: CREAM, name: 'كريم', basePrice: 12, status: 'ACTIVE' },
      { id: SOAP, name: 'صابون', basePrice: 5, status: 'ACTIVE' },
    ],
    offers: [],
    orderOffer: null,
    // What the shelf can give THIS order beyond its own holding.
    available: { [CREAM]: 100, [SOAP]: 100 },
    shipmentCod: 48.5,
    customer: { phoneInvalid: false, altPhoneInvalid: false, phoneDuplicate: false, regionOutsideCountry: false, regionFee: null, ...customer },
    ...rest,
  };
};

const BUNDLE = { id: 'offer-3-plus-1', productId: CREAM, name: '3 + 1', quantity: 3, freeQuantity: 1, listPrice: 25, price: 25, live: true };

const ours = () => ({
  id: 'o1', companyId: 'c1', storeId: 's1', orderNumber: 'SY-5', confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null, claimedById: null,
});

const SELLER = { id: 'rim', name: 'ريم', role: 'CONFIRMATION_AGENT' };
const ctx = {
  user: SELLER, companyId: 'c1', storeId: 's1',
  country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Amman' },
};

/** The keys the person raising holds. Everything else is refused, as in the real check. */
const holds = (...keys: string[]) => can.mockImplementation((_user, key) => keys.includes(key as string));

const raise = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const REASON = 'الزبون طلب كمية أكبر';

/** «L1: five instead of three» — nothing else said; the price follows by the piece. */
const FIVE = { v: 2, edits: [{ lineId: L1, quantity: { to: 5 } }] };

const asked = (lines: unknown, more: Record<string, unknown> = {}) => ({ reason: REASON, changes: { lines, ...more } });

const created = () => {
  const call = db.orderChangeRequest.create.mock.calls[0];
  if (!call) throw new Error('لم يُكتب طلب');
  return call[0].data as { changes: Record<string, any>; intent: string };
};

beforeEach(() => {
  vi.clearAllMocks();
  state.facts = factsOf();
  state.previews = [];
  requireContext.mockResolvedValue(ctx);
  holds('orders.request_change');
  assertOrderAccess.mockResolvedValue({ allowed: true, order: ours() });
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.create.mockImplementation(async ({ data }) => ({ id: 'cr1', ...data }));
  db.orderChangeRequest.update.mockResolvedValue({});
  db.order.findFirst.mockResolvedValue({
    quantity: 5, productId: CREAM, sellingPrice: 46, discountAmount: 0, customerNotes: null, regionId: null,
    customer: { fullName: 'سامر', phone: '0791234567', altPhone: null, address: 'عمان', city: 'عمان' },
  });
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.orderNote.create.mockResolvedValue({});
  createNotification.mockResolvedValue(1);
});

/* ─────────────────────────── 1 · a valid request is written from the preview ─────────────────────────── */

describe('Ⅰ · a valid lines request is stored with the SERVER’s figures', () => {
  it('«five instead of three»: every figure is the preview’s — the line, its total, the gift, the totals before and after', async () => {
    const res = await raise(asked(FIVE));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { lines } = created().changes as { lines: Record<string, any> };
    // 12.000 a piece kept → 60.000 for five; the other line is untouched and so is not in the request.
    expect(lines.v).toBe(2);
    expect(lines.edits).toHaveLength(1);
    expect(lines.edits[0]).toMatchObject({
      lineId: L1,
      productId: { from: CREAM, to: CREAM },
      quantity: { from: 3, to: 5 },
      lineTotal: { from: 36, to: 60 },
      unitPrice: { from: 12, to: 12 },
      freeQuantity: { from: 0, to: 0 },
      basis: 'KEEP_UNIT',
    });
    // collected: 46 + 2.5 = 48.5 before; 70 + 2.5 = 72.5 after. The apply door insists the order still comes to the latter.
    expect(lines.snapshot.before.cod).toBe(48.5);
    expect(lines.snapshot.after.cod).toBe(72.5);
    expect(lines.snapshot.orderVersion).toBe(7);
    expect(lines.snapshot.lineOrder).toEqual([L1, L2]);
    expect(created().intent).toBe('EDIT');
  });

  it('what is written reads back through the schema the apply door reads it with', async () => {
    await raise(asked(FIVE));

    const back = readLinesChange(created().changes);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.value?.edits[0].quantity).toEqual({ from: 3, to: 5 });
      expect(back.value?.snapshot?.after?.cod).toBe(72.5);
    }
  });

  it('a line total typed beside a quantity is kept whole and marked as typed by hand: 3 → 4 at 40.000', async () => {
    const res = await raise(asked({ v: 2, edits: [{ lineId: L1, quantity: { to: 4 }, lineTotal: { to: 40 } }] }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edit = created().changes.lines.edits[0];
    expect(edit.lineTotal).toEqual({ from: 36, to: 40 });
    expect(edit.basis).toBe('MANUAL');
    // 40 + 10 + 2.5
    expect(created().changes.lines.snapshot.after.cod).toBe(52.5);
  });

  it('the unit price by the piece is turned into a line total by the engine, to the currency’s own unit: 3 → 4 on 25.000', async () => {
    state.facts = factsOf({ lines: [stored({ id: L1, lineTotal: 25 }), stored({ id: L2, productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10 })], order: { storedTotal: 37.5 }, shipmentCod: 37.5 });
    const res = await raise(asked({ v: 2, edits: [{ lineId: L1, quantity: { to: 4 } }] }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // 25 ÷ 3 = 8.3333…, × 4 = 33.3333… → 33.333 (a fils, not a cent)
    expect(created().changes.lines.edits[0].lineTotal.to).toBe(33.333);
  });

  it('the gift is worked out by the engine and written into the request: 3 + 1 on 25.000, six instead of three, gives two free', async () => {
    state.facts = factsOf({
      lines: [stored({ id: L1, freeQuantity: 1, lineTotal: 25, quantity: 3 }), stored({ id: L2, productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10 })],
      offers: [BUNDLE],
      orderOffer: BUNDLE,
      order: { storedTotal: 37.5 },
      shipmentCod: 37.5,
    });
    const res = await raise(asked({ v: 2, edits: [{ lineId: L1, quantity: { to: 6 } }] }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edit = created().changes.lines.edits[0];
    // two bundles: 50.000 paid, 2 free — the gift comes from the offer rule, never from a box
    expect(edit.freeQuantity).toEqual({ from: 1, to: 2 });
    expect(edit.lineTotal).toEqual({ from: 25, to: 50 });
    expect(edit.basis).toBe('OFFER');
  });

  it('it travels beside the customer’s own fields and the discount, each with its «before» read from the order', async () => {
    const res = await raise(asked(FIVE, { customerPhone: { to: '0797654321' }, customerNotes: { to: 'بعد العصر' }, discountAmount: { to: 2 } }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const changes = created().changes;
    expect(changes.customerPhone).toEqual({ from: '0791234567', to: '0797654321' });
    expect(changes.customerNotes).toEqual({ from: null, to: 'بعد العصر' });
    expect(changes.discountAmount).toEqual({ from: 0, to: 2 });
    expect(changes.lines.edits).toHaveLength(1);
    // the engine judged the whole draft, not the lines alone
    const sent = (state.previews[0] as PreviewCall).draft;
    expect(sent.customerPhone).toBe('0797654321');
    expect(sent.discountAmount).toBe(2);
    expect(sent.lines).toHaveLength(1);
  });

  it('an edit that comes out as it was is not written: with a note beside it only the note is stored; alone, the request is refused', async () => {
    const same = { v: 2, edits: [{ lineId: L1, quantity: { to: 3 } }] };

    const alone = await raise(asked(same));
    expect(alone.status).toBe(400);
    expect(alone.body.code).toBe('NOTHING_CHANGED');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();

    const withNote = await raise(asked(same, { customerNotes: { to: 'اتصال قبل الوصول' } }));
    expect(withNote.status, JSON.stringify(withNote.body)).toBe(201);
    expect(created().changes.lines).toBeUndefined();
    expect(created().changes.customerNotes.to).toBe('اتصال قبل الوصول');
  });
});

/* ─────────────────────────── 2 · the browser is never believed about the past ─────────────────────────── */

describe('Ⅱ · a «before», a gift or a snapshot from the browser is not read', () => {
  it('the figures the browser sends as «from», as a gift or as a snapshot are ignored: the server’s are written', async () => {
    const lying = {
      v: 2,
      edits: [{ lineId: L1, quantity: { from: 99, to: 5 }, lineTotal: undefined, freeQuantity: { from: 7, to: 9 }, productId: { from: 'prod-other-0001', to: CREAM } }],
      snapshot: { orderVersion: 1, after: { cod: 1 } },
    };
    const res = await raise(asked(lying));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edit = created().changes.lines.edits[0];
    expect(edit.quantity.from).toBe(3);
    expect(edit.productId.from).toBe(CREAM);
    expect(edit.freeQuantity).toEqual({ from: 0, to: 0 });
    expect(created().changes.lines.snapshot.after.cod).toBe(72.5);
    expect(created().changes.lines.snapshot.orderVersion).toBe(7);
    // and the draft the engine judged carried no gift and no «before» either
    const sent = JSON.stringify((state.previews[0] as PreviewCall).draft);
    expect(sent).not.toContain('99');
    expect(sent).not.toContain('freeQuantity');
  });

  it('a «from» on a flat field is still taken from the order, as it always was', async () => {
    const res = await raise({ reason: REASON, changes: { customerName: { from: 'غير صحيح', to: 'سامر الجديد' } } });

    expect(res.status).toBe(201);
    expect(created().changes.customerName).toEqual({ from: 'سامر', to: 'سامر الجديد' });
  });
});

/* ─────────────────────────── 3 · one shape for the goods ─────────────────────────── */

describe('Ⅲ · the shorthand and the lines are not asked together', () => {
  it.each([
    ['quantity', { to: 4 }],
    ['productId', { to: SOAP }],
    ['sellingPrice', { to: 40 }],
  ])('%s beside lines is refused with 422 and nothing is judged or written', async (field, change) => {
    const res = await raise(asked(FIVE, { [field]: change }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LINES_AND_FLAT');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
    expect(state.previews).toHaveLength(0);
  });

  it('lines belong to an edit: with a cancellation or a postponement they are refused', async () => {
    const res = await raise({ intent: 'CANCEL', cancelReason: 'PRICE_TOO_HIGH', reason: REASON, changes: { lines: FIVE } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LINES_NEED_EDIT');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('adding or removing a line is not offered yet: refused at the door, not half-done at the apply', async () => {
    const res = await raise(asked({ ...FIVE, added: [{ productId: SOAP }] }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NOT_APPLICABLE');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it.each([
    ['no version', { edits: FIVE.edits }],
    ['an empty list', { v: 2, edits: [] }],
    ['the same line twice', { v: 2, edits: [FIVE.edits[0], FIVE.edits[0]] }],
    ['not an object', 'x'],
    ['null', null],
    ['a quantity of zero', { v: 2, edits: [{ lineId: L1, quantity: { to: 0 } }] }],
    ['twenty-one lines', { v: 2, edits: Array.from({ length: 21 }, (_v, i) => ({ lineId: `line-${i}`, quantity: { to: 2 } })) }],
  ])('a malformed request (%s) is refused with 400 and a sentence', async (_name, lines) => {
    const res = await raise(asked(lines));

    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('a unit price AND a line total for one line is two answers to one question: refused in the engine’s own words', async () => {
    const res = await raise(asked({ v: 2, edits: [{ lineId: L1, unitPrice: { to: 12 }, lineTotal: { to: 36 } }] }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('سعر القطعة أو إجمالي السطر');
  });
});

/* ─────────────────────────── 4 · a blocking problem is a refusal now ─────────────────────────── */

describe('Ⅳ · a blocking problem refuses the request, in Arabic, and writes nothing', () => {
  const refused = async (reason: string) => {
    const res = await raise(asked(FIVE));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('LINES_BLOCKED');
    expect(res.body.error).toContain(reason);
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
    expect(db.orderNote.create).not.toHaveBeenCalled();
    return res;
  };

  it('the shelf cannot give five creams (only four): the refusal names the product', async () => {
    state.facts = factsOf({ available: { [CREAM]: 4, [SOAP]: 100 } });

    const res = await refused('المخزون ما بيكفي لـكريم');
    expect(res.body.problems[0].code).toBe('STOCK_SHORT_BLOCKED');
  });

  it('a country that lets the shelf go negative says it and lets the request through', async () => {
    state.facts = factsOf({ available: { [CREAM]: 4, [SOAP]: 100 }, allowNegativeStock: true });

    const res = await raise(asked(FIVE));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(created().changes.lines.snapshot.warnings).toContain('STOCK_SHORT_ALLOWED');
  });

  it('the stored total disagrees with the order’s own lines (50.000 against 48.500): no request on top of a wrong figure', async () => {
    state.facts = factsOf({ order: { storedTotal: 50 } });

    await refused('إجمالي الطلب المخزّن');
  });

  it('two delivery fees on one order: refused, because the save would collect one without saying which', async () => {
    state.facts = factsOf({ order: { deliveryFee: 3 } });

    await refused('رقمين مختلفين');
  });

  it('the parcel is with the courier: the goods are not edited from here', async () => {
    state.facts = factsOf({ order: { handed: true } });

    await refused('الطرد عند شركة الشحن');
  });

  it('a courier statement claims the order: the statement writes the money', async () => {
    state.facts = factsOf({ order: { statementLinked: true } });

    await refused('كشف شركة الشحن');
  });

  it('a line already delivered or returned is a record, not a draft', async () => {
    state.facts = factsOf({ lines: [stored({ id: L1, deliveredQty: 3 }), stored({ id: L2, productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10 })] });

    await refused('انسلّم أو ارتجع');
  });

  it('a line that is not on the order', async () => {
    const res = await raise(asked({ v: 2, edits: [{ lineId: 'line-nowhere', quantity: { to: 5 } }] }));

    expect(res.status).toBe(409);
    expect(res.body.problems[0].code).toBe('UNKNOWN_LINE');
  });

  it('a discount above the new total: refused, with the ceiling in the sentence', async () => {
    const res = await raise(asked(FIVE, { discountAmount: { to: 90 } }));

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('الخصم أكبر من إجمالي الطلب');
    expect(res.body.error).toContain('70');
  });

  it('the customer’s own fields are judged too: a phone that is not a phone of this country', async () => {
    state.facts = factsOf({ customer: { phoneInvalid: true } });

    const res = await raise(asked(FIVE, { customerPhone: { to: '0791112222' } }));
    expect(res.status).toBe(409);
    expect(res.body.problems.map((p: { code: string }) => p.code)).toContain('PHONE_INVALID');
  });

  it('an order not yet confirmed is edited on its own screen: a request on it could never be applied', async () => {
    state.facts = factsOf({ order: { confirmed: false } });

    const res = await raise(asked(FIVE));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_CONFIRMED');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('every reason is named, not only the first', async () => {
    state.facts = factsOf({ available: { [CREAM]: 4, [SOAP]: 100 }, order: { storedTotal: 50, statementLinked: true } });

    const res = await raise(asked(FIVE));
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('المخزون ما بيكفي');
    expect(res.body.error).toContain('كشف شركة الشحن');
    expect(res.body.error).toContain('إجمالي الطلب المخزّن');
  });
});

/* ─────────────────────────── 5 · one pending request, and who may decide it ─────────────────────────── */

describe('Ⅴ · the rules of the door that were there before are still there', () => {
  it('a second request while one is pending is refused before anything is judged', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue({ id: 'cr-open' });

    const res = await raise(asked(FIVE));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHANGE_REQUEST_PENDING');
    expect(state.previews).toHaveLength(0);
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('without the key to raise a request, nothing is judged (403)', async () => {
    holds();

    const res = await raise(asked(FIVE));
    expect(res.status).toBe(403);
    expect(state.previews).toHaveLength(0);
  });

  it('an order the person cannot see is not there (404)', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: false });

    const res = await raise(asked(FIVE));
    expect(res.status).toBe(404);
    expect(state.previews).toHaveLength(0);
  });

  describe('deciding it herself', () => {
    const SUPERVISOR = { id: 'sup', name: 'مشرفة', role: 'CONFIRMATION_SUPERVISOR' };
    beforeEach(() => {
      requireContext.mockResolvedValue({ ...ctx, user: SUPERVISOR });
    });

    it('a supervisor with the price key decides it at once: approved, with her name and a reason', async () => {
      holds('orders.request_change', 'control.change_requests', 'orders.change_price');

      const res = await raise(asked(FIVE));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.readyToApply).toBe(true);
      const update = db.orderChangeRequest.update.mock.calls[0][0].data;
      expect(update.status).toBe('APPROVED');
      expect(update.decidedById).toBe('sup');
    });

    it('the SAME supervisor without orders.change_price waits for somebody who holds it — a quantity moves the total', async () => {
      holds('orders.request_change', 'control.change_requests');

      const res = await raise(asked(FIVE));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.readyToApply).toBe(false);
      expect(db.orderChangeRequest.update).not.toHaveBeenCalled();
      // …and it tells whoever may decide, since nobody here did.
      expect(createNotification).toHaveBeenCalled();
    });

    it('while a request that moves no figure (a note) is decided by her at once — it is the lines that ask for the key', async () => {
      holds('orders.request_change', 'control.change_requests');

      const res = await raise({ reason: REASON, changes: { customerNotes: { to: 'بعد العصر' } } });
      expect(res.status).toBe(201);
      expect(res.body.readyToApply).toBe(true);
    });

    it('a printed waybill seals an edit: even with every key it waits', async () => {
      holds('orders.request_change', 'control.change_requests', 'orders.change_price');
      assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ours(), labelPrintedAt: new Date() } });
      state.facts = factsOf({ order: { labelled: true } });

      const res = await raise(asked(FIVE));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.readyToApply).toBe(false);
      expect(created().changes.lines.snapshot.warnings).toContain('LABEL_WILL_RESET');
    });

    it('the key the decision is held to is asked of the request as it is STORED: `touchesMoney` reads `lines`', () => {
      expect(touchesMoney({ lines: { v: 2 } })).toBe(true);
      expect(touchesMoney({ customerNotes: { to: 'x' } })).toBe(false);
    });
  });
});

/* ─────────────────────────── 6 · the old request is the old request ─────────────────────────── */

describe('Ⅵ · a flat request is raised exactly as before', () => {
  it('a name and a price: stored with their «before» from the order, no preview asked, no `lines` key', async () => {
    const res = await raise({ reason: REASON, changes: { customerName: { to: 'سامر الجديد' }, sellingPrice: { to: 40 }, quantity: { to: 4 } } });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(created().changes).toEqual({
      customerName: { from: 'سامر', to: 'سامر الجديد' },
      sellingPrice: { from: 46, to: 40 },
      quantity: { from: 5, to: 4 },
    });
    expect(state.previews).toHaveLength(0);
  });

  it('a request of no field is still refused, in the old words', async () => {
    const res = await raise({ reason: REASON, changes: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('حدّد حقلاً واحداً على الأقل');
  });

  it('an unknown field is still refused by the old schema', async () => {
    const res = await raise({ reason: REASON, changes: { totalAmount: { to: 1 } } });

    expect(res.status).toBe(400);
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });
});
