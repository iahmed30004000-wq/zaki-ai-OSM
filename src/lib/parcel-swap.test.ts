import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «كان من طرد طلب آخر» — THE PARCEL SWAP, AGAINST A FAKE DATABASE THAT ANSWERS ITS OWN QUESTIONS.
 *
 * The world below is rows. The `where` clauses the swap writes are APPLIED to them (equality, `in`, `not`, `gt`,
 * `OR`, a relation filter), so a refusal comes from the facts and not from a mock that was told what to say — and a
 * claim that must take exactly one row really takes one, or none.
 *
 * The worked example is the one the design was written from, in dinars (three places):
 *
 *   X = A, 1 × 20.000, fee 2.500 inside it.        Y = B, 2 pieces on an offer of 35.000. B cancelled after the
 *   shipment left. The courier gave Y's box to A and collected 40.000; the file reads Y «تم» 40.000 (fee 2.500, net
 *   37.500) and X «مرتجع» at 0.
 *
 * Stock, money, customers, commission, the lines and the story are each asserted against the table in the pull
 * request, row by row.
 */

vi.mock('./db', () => ({ db: {} }));

const state = vi.hoisted(() => ({ w: null as any, seq: 0 }));

vi.mock('./money', async (orig) => {
  const real = await orig<typeof import('./money')>();
  return { ...real, computeCod: vi.fn(real.computeCod) };
});

vi.mock('./order-ref', () => ({
  orderRefFields: vi.fn(async (_tx: unknown, _c: string, prefix: string, attempt: number) => ({
    orderNumber: `${prefix}-2026-${String(100 + attempt).padStart(4, '0')}`,
    merchantRef: `${prefix}-2026-${String(100 + attempt).padStart(4, '0')}`,
  })),
}));

/** The reservation, as the doors keep it: units held on the lines, released to zero, taken again for new lines. */
vi.mock('./reservation', () => ({
  reserveOrderLines: vi.fn(async (_tx: unknown, orderId: string) => {
    const W = state.w;
    for (const i of W.items.filter((r: any) => r.orderId === orderId)) i.reservedQty = i.quantity + i.freeQuantity;
    W.reserved.push(orderId);
    return { reserved: 1, shortages: [] };
  }),
  releaseOrderLines: vi.fn(async (_tx: unknown, orderId: string) => {
    const W = state.w;
    let n = 0;
    for (const i of W.items.filter((r: any) => r.orderId === orderId && r.reservedQty > 0)) {
      i.reservedQty = 0;
      n++;
    }
    W.released.push(orderId);
    return n;
  }),
}));

/** The draw-down: what leaves the shelf, once per order — the ledger asks itself, so a second call takes nothing. */
vi.mock('./stock-consumption', () => ({
  consumeOrderStock: vi.fn(async (_tx: unknown, input: { orderId: string }) => {
    const W = state.w;
    if (W.consumed.some((c: any) => c.orderId === input.orderId)) return { taken: 0, short: 0, alreadyDone: true, cost: 0 };
    const lines = W.items.filter((r: any) => r.orderId === input.orderId);
    const taken = lines.reduce((s: number, i: any) => s + i.quantity + i.freeQuantity, 0);
    W.consumed.push({ orderId: input.orderId, taken });
    for (const i of lines) i.reservedQty = 0;
    return { taken, short: 0, alreadyDone: false, cost: 0 };
  }),
}));

import {
  SWAP_WHY,
  SwapRefused,
  boxBlockers,
  findSwapCandidates,
  lineNote,
  ownerBlockers,
  paidFromLine,
  piecesSentence,
  recordParcelSwap,
  reusableReplacement,
  splitBox,
  inPackingOrder,
  type SwapInput,
} from './parcel-swap';
import { priceTheBox, takeFromBox, boxUnits, type BoxLine } from './replacement-order';
import { expectedAmountFor, judgeLine } from './settlement';
import { IN_FLIGHT } from './settlement-decisions';
import { isSuperseded } from './superseded';
import { expectedBackTotal } from './partial-delivery';
import { MANUAL_MATCH } from './match-integrity';
import { computeCod } from './money';

type Row = Record<string, any>;

/* ───────────────────────────── the fake database ───────────────────────────── */

const OPERATORS = ['in', 'notIn', 'not', 'equals', 'isNot', 'contains', 'lt', 'gt', 'none'];

function fits(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some((w) => fits(row, w));
    if (key === 'AND') return (want as Row[]).every((w) => fits(row, w));
    if (key === 'NOT') return !fits(row, want as Row);
    const have = row[key];
    if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
      const w = want as Row;
      if (!Object.keys(w).some((k) => OPERATORS.includes(k))) {
        return have !== null && typeof have === 'object' ? fits(have as Row, w) : false;
      }
      if ('in' in w) return (w.in as unknown[]).includes(have);
      if ('notIn' in w) return !(w.notIn as unknown[]).includes(have);
      if ('isNot' in w) return (have ?? null) !== w.isNot;
      if ('not' in w) return (have ?? null) !== w.not;
      if ('equals' in w) return String(have ?? '').toLowerCase() === String(w.equals).toLowerCase();
      if ('contains' in w) return String(have ?? '').toLowerCase().includes(String(w.contains).toLowerCase());
      if ('lt' in w) return have < w.lt;
      if ('gt' in w) return have > w.gt;
      return true;
    }
    return (have ?? null) === want;
  });
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && ('increment' in v || 'decrement' in v)) {
      row[k] = Number(row[k] ?? 0) + Number((v as Row).increment ?? 0) - Number((v as Row).decrement ?? 0);
    } else row[k] = v;
  }
}

interface World {
  statements: Row[];
  matches: Row[];
  orders: Row[];
  items: Row[];
  customers: Row[];
  users: Row[];
  requests: Row[];
  activities: Row[];
  notes: Row[];
  statusLogs: Row[];
  receipts: Row[];
  rules: Row[];
  entries: Row[];
  consumed: Row[];
  released: string[];
  reserved: string[];
  locks: string[];
  /** Every write, by name — a refusal must leave this empty. */
  writes: string[];
  /** Orders whose next conditional update finds the row moved (a press that raced this one). */
  moved: Set<string>;
  /** Runs when a new order is written — the moment another press can land. */
  onCreate?: () => void;
  /** The thank-you-page upsell rows (OrderAddOn), by order. */
  addOns: Row[];
  /** Runs ONCE just before the conditional update of that order — a press that lands after the read and before the write. */
  beforeOrderUpdate?: Record<string, () => void>;
}

let seq = 0;

function makeTx(w: World) {
  const wrote = (k: string) => w.writes.push(k);
  const itemsOf = (orderId: string) =>
    w.items.filter((i) => i.orderId === orderId).sort((a, b) => a.seq - b.seq);
  const enrich = (o: Row): Row => ({
    ...o,
    items: itemsOf(o.id),
    customer: w.customers.find((c) => c.id === o.customerId) ?? null,
    returnReceipt: w.receipts.find((r) => r.orderId === o.id) ?? null,
    replacedBy: (() => {
      const r = w.orders.find((x) => x.replacesOrderId === o.id);
      return r ? { ...r, addOns: [] } : null;
    })(),
    addOns: w.addOns.filter((a) => a.orderId === o.id),
    moderator: w.users.find((u) => u.id === o.moderatorId) ?? null,
    confirmer: w.users.find((u) => u.id === o.confirmedById) ?? null,
    changeRequests: w.requests.filter((r) => r.orderId === o.id),
  });
  const seen = (m: Row): Row => ({ ...m, statement: w.statements.find((s) => s.id === m.statementId) });

  const tx: Row = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      w.locks.push(`${strings.join('?')}|${vals.join(',')}`);
      return [];
    }),
    courierStatement: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => w.statements.find((s) => fits(s, where)) ?? null),
    },
    settlementMatch: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => w.matches.map(seen).find((m) => fits(m, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Row }) => w.matches.map(seen).filter((m) => fits(m, where))),
      count: vi.fn(async ({ where }: { where: Row }) => w.matches.map(seen).filter((m) => fits(m, where)).length),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = w.matches.filter((m) => fits(seen(m), where));
        for (const r of rows) applyData(r, data);
        if (rows.length) wrote('match.updateMany');
        return { count: rows.length };
      }),
    },
    order: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const o = w.orders.find((r) => fits(enrich(r), where));
        return o ? enrich(o) : null;
      }),
      findMany: vi.fn(async ({ where, take }: { where: Row; take?: number }) =>
        w.orders.map(enrich).filter((o) => fits(o, where)).slice(0, take ?? 1000)
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hook = w.beforeOrderUpdate?.[where.id as string];
        if (hook) {
          delete w.beforeOrderUpdate![where.id as string];
          hook();
        }
        const rows = w.orders.filter((r) => fits(enrich(r), where) && !w.moved.has(r.id));
        for (const r of rows) applyData(r, data);
        if (rows.length) wrote('order.updateMany');
        return { count: rows.length };
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        wrote('order.create');
        w.onCreate?.();
        const row = { id: `new${++seq}`, version: 1, ...data };
        w.orders.push(row);
        return { id: row.id, orderNumber: row.orderNumber };
      }),
    },
    orderItem: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        wrote('item.create');
        w.items.push({ id: `ni${++seq}`, seq: 1000 + seq, createdAt: new Date(T0.getTime() + 100000 + seq), reservedQty: 0, deliveredQty: null, returnedQty: null, ...data });
        return data;
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        wrote('item.update');
        const r = w.items.find((i) => i.id === where.id)!;
        applyData(r, data);
        return r;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        wrote('item.deleteMany');
        const keep = w.items.filter((i) => !fits(i, where));
        const n = w.items.length - keep.length;
        w.items.splice(0, w.items.length, ...keep);
        return { count: n };
      }),
    },
    orderChangeRequest: {
      count: vi.fn(async ({ where }: { where: Row }) => w.requests.filter((r) => fits(r, where)).length),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = w.requests.filter((r) => fits(r, where));
        for (const r of rows) applyData(r, data);
        if (rows.length) wrote('request.updateMany');
        return { count: rows.length };
      }),
    },
    orderActivity: {
      count: vi.fn(async ({ where }: { where: Row }) => w.activities.filter((a) => fits(a, where)).length),
      create: vi.fn(async ({ data }: { data: Row }) => {
        wrote('activity.create');
        w.activities.push(data);
        return data;
      }),
    },
    orderNote: { create: vi.fn(async ({ data }: { data: Row }) => { wrote('note.create'); w.notes.push(data); return data; }) },
    orderStatusLog: { create: vi.fn(async ({ data }: { data: Row }) => { wrote('log.create'); w.statusLogs.push(data); return data; }) },
    returnReceipt: { create: vi.fn(async ({ data }: { data: Row }) => { wrote('receipt.create'); w.receipts.push(data); return data; }) },
    customer: {
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        wrote('customer.update');
        applyData(w.customers.find((c) => c.id === where.id)!, data);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = w.customers.filter((c) => fits(c, where));
        for (const r of rows) applyData(r, data);
        if (rows.length) wrote('customer.updateMany');
        return { count: rows.length };
      }),
    },
    commissionRule: { findMany: vi.fn(async ({ where }: { where: Row }) => w.rules.filter((r) => fits(r, where))) },
    commissionEntry: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => w.entries.find((e) => fits(e, where)) ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => { wrote('commission.create'); w.entries.push(data); return data; }),
    },
  };
  return tx;
}

/* ───────────────────────────── the world of the worked example ───────────────────────────── */

const T0 = new Date('2026-10-18T10:00:00Z');
const PERIOD_TO = new Date('2026-10-20T00:00:00Z');

const item = (over: Row = {}): Row => ({
  id: 'xi1', orderId: 'x', seq: 1, createdAt: new Date(T0.getTime() + 1000), productId: 'p1', productName: 'عطر', quantity: 1, freeQuantity: 0,
  unitPrice: 20, lineTotal: 20, discountShare: 0, reservedQty: 1, deliveredQty: null, returnedQty: null, ...over,
});

function order(over: Row = {}): Row {
  return {
    id: 'x', companyId: 'c1', orderNumber: 'JO-2026-0001', merchantRef: 'JO-2026-0001', storeId: 's1', countryId: 'jo',
    regionId: 'r1', customerId: 'cuA', productId: 'p1', offerId: null, quantity: 1, freeQuantity: 0,
    sellingPrice: 20, discountAmount: 0, shippingCost: 0, totalAmount: 20, currency: 'JOD',
    priceIncludesDelivery: true, deliveryFee: 2.5, productNameSnapshot: 'عطر', productImageSnapshot: null,
    moderatorId: 'mod1', confirmedById: 'conf1', assignedToId: 'agent1', assignedAt: T0, estimatedCostOfGoods: 6,
    source: 'Landing Page', customerNotes: null, channelId: 'ch1', campaignId: 'camp1', landingPageId: 'lp1',
    deviceClass: 'mobile', adId: null, adSourceType: null, refCode: null, refCodeAt: null, touchAt: null,
    pageId: null, wabaId: null, conversationRef: null,
    confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE',
    deliveryProviderId: 'dp1', shippedAt: T0, labelPrintedAt: T0, trackingNumber: null, shippingBatchId: 'b1',
    returnReason: null, collectedAmount: null, version: 3, replacesOrderId: null,
    ...over,
  };
}

function makeWorld(over: Partial<World> = {}): World {
  const x = order();
  const y = order({
    id: 'y', orderNumber: 'JO-2026-0002', merchantRef: 'JO-2026-0002', customerId: 'cuB', quantity: 2,
    sellingPrice: 35, totalAmount: 35, moderatorId: 'mod2', confirmedById: 'conf2', estimatedCostOfGoods: 12,
    campaignId: 'camp2', landingPageId: 'lp2', version: 5,
  });
  return {
    statements: [
      { id: 'st1', companyId: 'c1', storeId: 's1', status: 'MATCHED', approvedAt: null, reference: 'ST-1', deliveryProviderId: 'dp1', currencyCode: 'JOD', fileHash: 'abc123', periodTo: PERIOD_TO },
      { id: 'st2', companyId: 'c1', storeId: 's1', status: 'APPROVED', approvedAt: new Date('2026-10-01T00:00:00Z'), reference: 'ST-2', deliveryProviderId: 'dp1', currencyCode: 'JOD', fileHash: 'def456', periodTo: null },
    ],
    matches: [
      // Y's line: «تم» with the money — the courier collected 40.000, kept 2.500 and handed over 37.500.
      { id: 'mY', companyId: 'c1', statementId: 'st1', statementLineId: 'lY', orderId: 'y', result: 'MISMATCHED', matchedBy: 'MERCHANT_REF', resolution: null,
        expectedAmount: 32.5, statementAmount: 37.5, statementLine: { amount: 37.5, fee: 2.5, status: 'تم' } },
      // X's line: «مرتجع» at zero.
      { id: 'mX', companyId: 'c1', statementId: 'st1', statementLineId: 'lX', orderId: 'x', result: 'MISMATCHED', matchedBy: 'MERCHANT_REF', resolution: null,
        expectedAmount: 17.5, statementAmount: 0, statementLine: { amount: 0, fee: null, status: 'مرتجع' } },
    ],
    orders: [x, y],
    items: [
      item(),
      item({ id: 'yi1', orderId: 'y', seq: 2, createdAt: new Date(T0.getTime() + 2000), quantity: 2, unitPrice: 17.5, lineTotal: 35, reservedQty: 2 }),
    ],
    customers: [
      { id: 'cuA', fullName: 'سارة', phone: '790000001', deliveredOrders: 0, cancelledOrders: 0, totalPurchaseValue: 0 },
      { id: 'cuB', fullName: 'ليلى', phone: '790000002', deliveredOrders: 0, cancelledOrders: 0, totalPurchaseValue: 0 },
    ],
    users: [
      { id: 'mod1', role: 'MODERATOR', commissionCurrency: null },
      { id: 'conf1', role: 'CONFIRMATION_AGENT', commissionCurrency: null },
      { id: 'mod2', role: 'MODERATOR', commissionCurrency: null },
      { id: 'conf2', role: 'CONFIRMATION_AGENT', commissionCurrency: null },
    ],
    requests: [
      { id: 'rq1', companyId: 'c1', orderId: 'y', intent: 'CANCEL', status: 'PENDING', appliedAt: null, cancelReason: 'CUSTOMER_CHANGED_MIND', reason: 'غيّرت رأيها' },
    ],
    activities: [],
    notes: [],
    statusLogs: [],
    receipts: [],
    rules: [
      { id: 'ru1', companyId: 'c1', storeId: 's1', isActive: true, appliesToRole: 'MODERATOR', appliesToUserId: null, type: 'PERCENT', value: 5, effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null, metric: 'ORDER_DELIVERED', period: 'PER_ORDER' },
      { id: 'ru2', companyId: 'c1', storeId: 's1', isActive: true, appliesToRole: 'CONFIRMATION_AGENT', appliesToUserId: null, type: 'PERCENT', value: 2, effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null, metric: 'ORDER_DELIVERED', period: 'PER_ORDER' },
    ],
    entries: [],
    consumed: [],
    released: [],
    reserved: [],
    locks: [],
    writes: [],
    moved: new Set<string>(),
    addOns: [],
    ...over,
  };
}

const INPUT: SwapInput = {
  companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'mY', ownerOrderId: 'x', pieces: 2, ownerBoxBack: true,
  user: { id: 'u1', name: 'المحاسبة', role: 'ACCOUNTANT' },
  minorUnit: 3, orderPrefix: 'JO', attempt: 0, allowNegativeStock: false, now: new Date('2026-10-22T09:00:00Z'),
};

let W: World;
beforeEach(() => {
  W = makeWorld();
  state.w = W;
  seq = 0;
});

const run = (over: Partial<SwapInput> = {}, world: World = W) => recordParcelSwap(makeTx(world) as any, { ...INPUT, ...over });
const orderOf = (id: string) => W.orders.find((o) => o.id === id)!;
const refusal = async (p: Promise<unknown>): Promise<SwapRefused> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof SwapRefused) return e;
    throw e;
  }
  throw new Error('expected a refusal');
};

/* ═════════════════════════════ THE WORKED EXAMPLE, ROW BY ROW ═════════════════════════════ */

describe('the worked example in dinars — every row of the table', () => {
  it('Orders: X′ is A\'s sale of two pieces at 20.000, delivered; X is a return; Y is returned with a receipt for no goods', async () => {
    const r = await run();
    const sale = orderOf(r.sale.id);

    // X′ = A, 2 × 20.000 = 40.000, DELIVERED — the customer, the people and the campaign are X's.
    expect(sale).toMatchObject({
      customerId: 'cuA', quantity: 2, freeQuantity: 0, sellingPrice: 40, totalAmount: 40, deliveryFee: 2.5,
      currency: 'JOD', priceIncludesDelivery: true, shippingStatus: 'DELIVERED', confirmationStatus: 'CONFIRMED',
      settlementStatus: 'NOT_APPLICABLE', replacesOrderId: 'x',
      moderatorId: 'mod1', confirmedById: 'conf1', assignedToId: 'agent1', campaignId: 'camp1', landingPageId: 'lp1',
      deliveryProviderId: 'dp1', storeId: 's1', source: 'Landing Page',
    });
    expect(sale.deliveredAt).toEqual(PERIOD_TO);
    expect(sale.shippedAt).toEqual(T0);
    const lines = W.items.filter((i) => i.orderId === sale.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ productId: 'p1', quantity: 2, unitPrice: 20, lineTotal: 40, discountShare: 0 });
    // the goods are Y's box: cost follows the pieces (the whole box here)
    expect(sale.estimatedCostOfGoods).toBe(12);

    // X is superseded and coming back, for the wrong box.
    expect(orderOf('x')).toMatchObject({ shippingStatus: 'RETURN_REQUESTED', returnReason: 'WRONG_PRODUCT' });
    // Y returned, with a receipt for zero goods that says where they went.
    expect(orderOf('y')).toMatchObject({ shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE', returnReason: 'CUSTOMER_REQUEST' });
    expect(W.receipts).toHaveLength(1);
    expect(W.receipts[0]).toMatchObject({
      orderId: 'y', expectedQty: 0, receivedQty: 0, damagedQty: 0, missingQty: 0, stockRestored: false,
      note: `بضاعته سُلِّمت لزبون ${sale.orderNumber}`,
    });
  });

  it('Stock: Y\'s 2 are released, X′ takes and consumes 2, X\'s 1 stays held for the desk — minus two, once', async () => {
    const r = await run();
    expect(W.released).toEqual(['y']);
    expect(W.items.find((i) => i.id === 'yi1')!.reservedQty).toBe(0);
    // X′ reserved its two and the draw-down took them.
    expect(W.reserved).toEqual([r.sale.id]);
    expect(W.consumed).toEqual([{ orderId: r.sale.id, taken: 2 }]);
    // X is not consumed and not released: its piece is counted back at the desk, where nothing is invented.
    expect(W.items.find((i) => i.id === 'xi1')!.reservedQty).toBe(1);
    expect(W.consumed.some((c) => c.orderId === 'x' || c.orderId === 'y')).toBe(false);
    expect(r.stock).toEqual({ released: 2, consumed: 2 });
  });

  it('Money: the swap moves none — X′ is not settled and has no amount; the line says 37.500 and matches it', async () => {
    const r = await run();
    const sale = orderOf(r.sale.id);
    expect(sale.settlementStatus).not.toBe('SETTLED');
    expect(sale.collectedAmount ?? null).toBeNull();
    // The fake has no wallet and no wallet movement: touching one would have thrown.
    const mY = W.matches.find((m) => m.id === 'mY')!;
    expect(mY).toMatchObject({
      orderId: r.sale.id, result: 'MATCHED', matchedBy: MANUAL_MATCH, expectedAmount: 37.5, statementAmount: 37.5,
      difference: 0, expectedFee: 2.5, statementFee: 2.5, feeDifference: 0,
    });
    expect(mY.note).toBe(lineNote('JO-2026-0002', r.sale.orderNumber));

    // What the approval will then do with it: settle X′ and write what A paid — the net plus the fee, 40.000 —
    // while the receipt's 37.500 goes into the wallet as it always did.
    expect(Number(mY.statementAmount) + Number(mY.statementFee)).toBe(40);
    expect(Number(mY.statementAmount)).toBe(37.5);
    // X′ is DELIVERED, so the approval's promotion of in-flight parcels (and its second stock draw) skips it.
    expect((IN_FLIGHT as readonly string[]).includes(sale.shippingStatus)).toBe(false);
  });

  it('Money: X\'s own line is judged again against a parcel that is coming back — MATCHED at 0', async () => {
    await run();
    expect(W.matches.find((m) => m.id === 'mX')).toMatchObject({
      orderId: 'x', result: 'MATCHED', expectedAmount: 0, statementAmount: 0, difference: 0,
    });
  });

  it('A: delivered +1, purchases +40.000, no cancellation; risk reads a customer who took delivery', async () => {
    await run();
    expect(W.customers.find((c) => c.id === 'cuA')).toMatchObject({ deliveredOrders: 1, totalPurchaseValue: 40, cancelledOrders: 0 });
  });

  it('B: cancelled +1 and nothing delivered or bought — Y counts as B\'s return, once', async () => {
    const r = await run();
    expect(W.customers.find((c) => c.id === 'cuB')).toMatchObject({ deliveredOrders: 0, totalPurchaseValue: 0, cancelledOrders: 1 });
    expect(r.counters).toEqual({ customerDelivered: 1, customerRefusalTakenBack: false, boxCustomerCancelled: true });
  });

  it('Commission: X\'s moderator and confirmer, on 37.500 at their rates, once — and Y\'s people earn nothing', async () => {
    const r = await run();
    const mine = W.entries.filter((e) => e.orderId === r.sale.id);
    expect(mine.map((e) => [e.userId, e.amount, e.status]).sort()).toEqual([
      ['conf1', 0.75, 'ACCRUED'], // 2 % of 37.500
      ['mod1', 1.875, 'ACCRUED'], // 5 % of 37.500
    ]);
    expect(W.entries.some((e) => e.userId === 'mod2' || e.userId === 'conf2')).toBe(false);
    expect(W.entries.some((e) => e.orderId === 'y' || e.orderId === 'x')).toBe(false);
    expect(r.commission).toEqual({ created: 2, amount: 2.625 });
    // pressed again by a retry of the job: the ledger refuses a second entry for the same person and order
    const { accrueForOrder } = await import('./commission');
    const again = await accrueForOrder(makeTx(W) as any, { companyId: 'c1', orderId: r.sale.id, minorUnit: 3 });
    expect(again.created).toBe(0);
    expect(W.entries.filter((e) => e.orderId === r.sale.id)).toHaveLength(2);
  });

  it('Returns desk: X expected (1 piece); Y never listed — nothing is owed back from the box that went', async () => {
    await run();
    const xLines = W.items.filter((i) => i.orderId === 'x');
    expect(expectedBackTotal(xLines as any)).toBe(1);
    // Y has a receipt (the desk lists parcels without one) and no unit is owed back.
    expect(W.receipts.some((r) => r.orderId === 'y')).toBe(true);
    expect(W.receipts[0].expectedQty).toBe(0);
  });

  it('Outcome words and the story: X is superseded by the swap, Y is not; each says it on its own activity', async () => {
    const r = await run();
    const acts = (id: string) => W.activities.filter((a) => a.orderId === id);
    const roleOf = (id: string, action: string) => JSON.parse(acts(id).find((a) => a.action === action)!.metadata).role;
    expect(roleOf('x', 'SWAP_RECORDED')).toBe('ORIGINAL');
    expect(roleOf(r.sale.id, 'SWAP_RECORDED')).toBe('REPLACEMENT');
    expect(roleOf('y', 'SWAP_BOX_GIVEN')).toBe('BOX');
    // The shared definition: X has a replacement AND carries the swap — superseded. The replacement's own copy is not a reason.
    const xRow = { replacedBy: { id: r.sale.id }, activities: acts('x') as any };
    expect(isSuperseded(xRow)).toBe(true);
    expect(isSuperseded({ replacedBy: { id: 'x2' }, activities: acts(r.sale.id) as any })).toBe(false);
    // Y has no replacement: it is a return that still counts, never "superseded".
    expect(isSuperseded({ replacedBy: null, activities: acts('y') as any })).toBe(false);
    // the person who pressed, and what they said about the other box
    expect(JSON.parse(acts('x')[0].metadata)).toMatchObject({ ownerBoxBack: true, pieces: 2, paid: 40, fee: 2.5, by: 'المحاسبة' });
    expect(W.notes).toHaveLength(3);
  });

  it('the requests asking something of these parcels are answered: Y\'s cancel is carried out', async () => {
    W.requests.push({ id: 'rq2', companyId: 'c1', orderId: 'x', intent: 'POSTPONE', status: 'PENDING', appliedAt: null });
    W.requests.push({ id: 'rq3', companyId: 'c1', orderId: 'y', intent: 'EDIT', status: 'APPROVED', appliedAt: null });
    const r = await run();
    const rq = (id: string) => W.requests.find((q) => q.id === id)!;
    expect(rq('rq1')).toMatchObject({ status: 'APPROVED', decidedById: 'u1', appliedById: 'u1' });
    expect(rq('rq1').appliedAt).toBeInstanceOf(Date);
    expect(rq('rq2')).toMatchObject({ status: 'CANCELLED', decidedById: 'u1' });
    expect(rq('rq3').appliedAt).toBeInstanceOf(Date);
    expect(r.closedRequests).toBe(3);
    // nothing open is left on either parcel: the matcher would flag neither again
    expect(W.requests.filter((q) => q.status === 'PENDING' || (q.status === 'APPROVED' && !q.appliedAt))).toEqual([]);
  });

  it('the status logs name the person, and X′ is born with its own', async () => {
    const r = await run();
    expect(W.statusLogs.map((l) => [l.orderId, l.previousValue, l.newValue]).sort()).toEqual([
      ['x', 'SHIPPED', 'RETURN_REQUESTED'],
      ['y', 'SHIPPED', 'RETURNED'],
      [r.sale.id, null, 'DELIVERED'],
    ].sort());
    expect(W.statusLogs.every((l) => l.changedById === 'u1' && l.changedByRole === 'ACCOUNTANT')).toBe(true);
  });

  it('the statement row is locked first, and the two orders by id after it', async () => {
    await run();
    expect(W.locks[0]).toContain('courier_statements');
    expect(W.locks.slice(1).map((l) => l.split('|')[1])).toEqual(['x', 'y']);
  });
});

/* ═════════════════════════════ THE LINE IS PRICED BY WHAT A PAID ═════════════════════════════ */

describe('if the courier collected Y\'s printed 35.000 instead', () => {
  it('X′ is priced at 35.000, the line matches it, and no shortfall reaches anyone', async () => {
    W.matches[0].statementAmount = 32.5;
    W.matches[0].statementLine = { amount: 32.5, fee: 2.5, status: 'تم' };
    const r = await run();
    expect(orderOf(r.sale.id)).toMatchObject({ totalAmount: 35, sellingPrice: 35, deliveryFee: 2.5 });
    expect(W.items.find((i) => i.orderId === r.sale.id)).toMatchObject({ quantity: 2, lineTotal: 35 });
    expect(W.matches.find((m) => m.id === 'mY')).toMatchObject({ result: 'MATCHED', difference: 0 });
  });
});

/* ═════════════════════════════ WHAT IT REFUSES ═════════════════════════════ */

describe('every refusal, and each one writes nothing', () => {
  const stops = async (code: string, mutate: (w: World) => void, input: Partial<SwapInput> = {}) => {
    mutate(W);
    const e = await refusal(run(input));
    expect(e.body.code).toBe(code);
    expect(W.writes, 'a refusal must not leave a write behind').toEqual([]);
    expect(W.consumed).toEqual([]);
    return e;
  };

  it('an approved statement — the correction is a settlement statement', async () => {
    const e = await stops('ALREADY_APPROVED', (w) => { w.statements[0].approvedAt = new Date(); w.statements[0].status = 'APPROVED'; });
    expect(e.body.error).toBe(SWAP_WHY.approved);
    expect(e.status).toBe(409);
  });

  it('a manual statement, and its open draft', async () => {
    await stops('MANUAL_STATEMENT', (w) => { w.statements[0].fileHash = 'manual:abc'; });
    await stops('MANUAL_STATEMENT', (w) => { w.statements[0].fileHash = 'manual:draft:abc'; });
  });

  it('a line that is not a difference with an order, one already linked by hand, and one with an answer', async () => {
    await stops('NOT_SWAPPABLE', (w) => { w.matches[0].result = 'MATCHED'; });
    W = makeWorld(); state.w = W;
    await stops('NOT_SWAPPABLE', (w) => { w.matches[0].matchedBy = 'MANUAL'; });
    W = makeWorld(); state.w = W;
    await stops('DECIDED', (w) => { w.matches[0].resolution = 'ACCEPTED_COURIER'; });
  });

  it('a line with no money — there is nothing A paid to build on', async () => {
    await stops('NO_MONEY', (w) => { w.matches[0].statementLine = { amount: 0, fee: null, status: 'مؤجلة' }; });
  });

  it('the box was counted at the desk', async () => {
    const e = await stops('BOX_COUNTED', (w) => { w.receipts.push({ orderId: 'y', receivedQty: 2 }); });
    expect(e.body.error).toBe(SWAP_WHY.boxCounted);
  });

  it('the box\'s order is not on the road (a door already delivered it) or is settled', async () => {
    await stops('BOX_NOT_ON_THE_ROAD', (w) => { orderOf('y').shippingStatus = 'DELIVERED'; });
    W = makeWorld(); state.w = W;
    await stops('SETTLED', (w) => { orderOf('y').settlementStatus = 'SETTLED'; });
  });

  it('the box\'s customer never cancelled — B still wants it', async () => {
    const e = await stops('BOX_NOT_CANCELLED', (w) => { w.requests.length = 0; });
    expect(e.body.error).toBe(SWAP_WHY.boxNotCancelled);
  });

  it('a cancel that was answered counts as asked, and a refused one does not', async () => {
    W.requests[0].status = 'APPROVED';
    W.requests[0].appliedAt = new Date();
    await run();
    W = makeWorld(); state.w = W;
    await stops('BOX_NOT_CANCELLED', (w) => { w.requests[0].status = 'REJECTED'; });
  });

  it('the store differs', async () => {
    await stops('OTHER_STORE', (w) => { orderOf('x').storeId = 's2'; });
    W = makeWorld(); state.w = W;
    await stops('OTHER_STORE', (w) => { orderOf('y').storeId = 's2'; });
  });

  it('the currency differs — on either order, or on the statement', async () => {
    await stops('OTHER_CURRENCY', (w) => { orderOf('x').currency = 'USD'; });
    W = makeWorld(); state.w = W;
    await stops('OTHER_CURRENCY', (w) => { orderOf('y').currency = 'USD'; });
    W = makeWorld(); state.w = W;
    await stops('OTHER_CURRENCY', (w) => { w.statements[0].currencyCode = 'USD'; });
  });

  it('the customer\'s order is with another courier', async () => {
    await stops('OTHER_COURIER', (w) => { orderOf('x').deliveryProviderId = 'dp9'; });
  });

  it('the same order, and the same customer', async () => {
    await stops('SAME_ORDER', () => undefined, { ownerOrderId: 'y' });
    W = makeWorld(); state.w = W;
    await stops('SAME_CUSTOMER', (w) => { orderOf('x').customerId = 'cuB'; });
  });

  it('the customer\'s order was recorded delivered, was settled, or never left', async () => {
    await stops('OWNER_DELIVERED', () => { orderOf('x').shippingStatus = 'DELIVERED'; });
    W = makeWorld(); state.w = W;
    await stops('SETTLED', () => { orderOf('x').settlementStatus = 'SETTLED'; });
    W = makeWorld(); state.w = W;
    await stops('OWNER_NOT_ON_THE_ROAD', () => { orderOf('x').shippingStatus = 'READY_FOR_SHIPPING'; });
  });

  it('more pieces than the box held, none, or a fraction', async () => {
    const e = await stops('PIECES_OUT_OF_RANGE', () => undefined, { pieces: 3 });
    expect(e.status).toBe(400);
    expect(e.body.error).toBe(piecesSentence(2));
    await stops('PIECES_OUT_OF_RANGE', () => undefined, { pieces: 0 });
    await stops('PIECES_OUT_OF_RANGE', () => undefined, { pieces: 1.5 });
  });

  it('an order another statement already holds cleanly — named by its reference', async () => {
    const e = await stops('CLAIMED_ELSEWHERE', (w) => {
      w.matches.push({ id: 'm9', companyId: 'c1', statementId: 'st2', statementLineId: 'l9', orderId: 'x', result: 'MATCHED', resolution: null });
    });
    expect(e.body.error).toContain('ST-2');
  });

  it('an order another LINE of this statement holds cleanly, and a second line naming the box\'s order', async () => {
    await stops('CLAIMED_HERE', (w) => {
      w.matches.push({ id: 'm8', companyId: 'c1', statementId: 'st1', statementLineId: 'l8', orderId: 'x', result: 'MATCHED', resolution: null });
    });
    W = makeWorld(); state.w = W;
    await stops('TWO_LINES', (w) => {
      w.matches.push({ id: 'm7', companyId: 'c1', statementId: 'st1', statementLineId: 'l7', orderId: 'y', result: 'MISMATCHED', resolution: null });
    });
  });

  it('a replacement that has already left the warehouse is somebody\'s sale', async () => {
    await stops('REPLACED', (w) => {
      w.orders.push(order({ id: 'xr', orderNumber: 'JO-2026-0009', replacesOrderId: 'x', shippingStatus: 'SHIPPED', shippingBatchId: 'b2', version: 1 }));
    });
  });

  it('a missing statement, line or order', async () => {
    await stops('NOT_FOUND', () => undefined, { statementId: 'nope' });
    W = makeWorld(); state.w = W;
    await stops('NOT_FOUND', () => undefined, { matchId: 'nope' });
    W = makeWorld(); state.w = W;
    await stops('ORDER_NOT_FOUND', () => undefined, { ownerOrderId: 'nope' });
  });

  it('every refusal is a sentence of Arabic and no English', () => {
    for (const s of Object.values(SWAP_WHY)) expect(s).not.toMatch(/[A-Za-z]/);
    expect(piecesSentence(1)).not.toMatch(/[A-Za-z]/);
    expect(piecesSentence(5)).toContain('5');
  });
});

/* ═════════════════════════════ THE PRESSES THAT RACE ═════════════════════════════ */

describe('two presses, one swap', () => {
  it('the second finds the line already linked and writes nothing — one sale, one draw-down, one commission', async () => {
    const first = await run();
    const before = W.writes.length;
    const e = await refusal(run());
    expect(e.body.code).toBe('NOT_SWAPPABLE');
    expect(W.writes.length).toBe(before);
    expect(W.orders.filter((o) => o.replacesOrderId === 'x')).toHaveLength(1);
    expect(W.consumed).toEqual([{ orderId: first.sale.id, taken: 2 }]);
    expect(W.entries.filter((e2) => e2.orderId === first.sale.id)).toHaveLength(2);
    expect(W.customers.find((c) => c.id === 'cuA')!.deliveredOrders).toBe(1);
    expect(W.customers.find((c) => c.id === 'cuB')!.cancelledOrders).toBe(1);
  });

  it('a press that read the box\'s order before another moved it finds the claim empty and stops', async () => {
    W.moved.add('y');
    const e = await refusal(run());
    expect(e.body.code).toBe('ORDER_MOVED');
    expect(e.body.error).toBe(SWAP_WHY.moved);
  });

  it('the customer\'s order moved after it was read', async () => {
    W.moved.add('x');
    const e = await refusal(run());
    expect(e.body.code).toBe('ORDER_MOVED');
  });
});

/* ═════════════════════════════ AN UNSHIPPED REPLACEMENT ALREADY EXISTS ═════════════════════════════ */

describe('a reorder already raised a replacement that has not shipped', () => {
  const withReorder = () => {
    orderOf('x').shippingStatus = 'RETURN_REQUESTED';
    W.orders.push(order({
      id: 'xr', orderNumber: 'JO-2026-0009', replacesOrderId: 'x', shippingStatus: 'READY_FOR_SHIPPING',
      shippedAt: null, labelPrintedAt: null, shippingBatchId: null, deliveryProviderId: null, version: 2,
      quantity: 1, totalAmount: 20, deliveryFee: null,
    }));
    W.items.push(item({ id: 'xri1', orderId: 'xr', seq: 3, createdAt: new Date(T0.getTime() + 3000), reservedQty: 1 }));
  };

  it('is reshaped into the sale — no second order is raised beside it', async () => {
    withReorder();
    const ordersBefore = W.orders.length;
    const r = await run();
    expect(W.orders).toHaveLength(ordersBefore);
    expect(r.sale).toMatchObject({ id: 'xr', orderNumber: 'JO-2026-0009', reshaped: true, total: 40 });
    expect(orderOf('xr')).toMatchObject({
      shippingStatus: 'DELIVERED', quantity: 2, totalAmount: 40, sellingPrice: 40, deliveryFee: 2.5, version: 3,
      deliveryProviderId: 'dp1',
    });
    // its own line went; the box's took its place, reserved and drawn down once
    const lines = W.items.filter((i) => i.orderId === 'xr');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 2, lineTotal: 40 });
    expect(W.released).toEqual(['y', 'xr']);
    expect(W.consumed).toEqual([{ orderId: 'xr', taken: 2 }]);
    // X was already a return: it stays one, and its status does not move.
    expect(orderOf('x').shippingStatus).toBe('RETURN_REQUESTED');
    expect(W.statusLogs.some((l) => l.orderId === 'x')).toBe(false);
  });

  it('that replacement is the one the commission and the line follow', async () => {
    withReorder();
    const r = await run();
    expect(W.matches.find((m) => m.id === 'mY')).toMatchObject({ orderId: 'xr', result: 'MATCHED' });
    expect(W.entries.every((e) => e.orderId === 'xr')).toBe(true);
    expect(r.commission.created).toBe(2);
  });

  it('is not reshaped once it sits on a trolley, and the swap says so', () => {
    withReorder();
    const xr = orderOf('xr');
    xr.shippingBatchId = 'b2';
    expect(reusableReplacement({ replacedBy: { ...xr, addOns: [] } } as any)).toBe(false);
    xr.shippingBatchId = null;
    expect(reusableReplacement({ replacedBy: { ...xr, addOns: [] } } as any)).toBe(true);
    expect(reusableReplacement({ replacedBy: { ...xr, addOns: [{ id: 'a1' }] } } as any)).toBe(false);
    expect(reusableReplacement({ replacedBy: null } as any)).toBe(false);
  });
});

/* ═════════════════════════════ THE BOX, THE OTHER BOX, AND THE PIECES ═════════════════════════════ */

describe('how many pieces, and whether the customer\'s own box came back', () => {
  it('fewer pieces than the box: Y keeps what did not go and waits for it; the desk expects exactly those', async () => {
    W.items.find((i) => i.id === 'yi1')!.quantity = 3;
    W.items.find((i) => i.id === 'yi1')!.reservedQty = 3;
    const r = await run({ pieces: 2 });
    expect(r.box).toMatchObject({ endedAs: 'RETURN_REQUESTED', pieces: 2, total: 3 });
    expect(orderOf('y')).toMatchObject({ shippingStatus: 'RETURN_REQUESTED', settlementStatus: 'CANCELLED' });
    const yLine = W.items.find((i) => i.id === 'yi1')!;
    expect(yLine).toMatchObject({ deliveredQty: 2, returnedQty: 1, reservedQty: 1 });
    expect(expectedBackTotal([yLine] as any)).toBe(1);
    // no receipt: nothing has been counted yet
    expect(W.receipts).toEqual([]);
    // the sale is two pieces, priced at what A paid, and only two were drawn down
    expect(orderOf(r.sale.id)).toMatchObject({ quantity: 2, totalAmount: 40 });
    expect(W.consumed).toEqual([{ orderId: r.sale.id, taken: 2 }]);
    // one reserved piece is still held; two were released
    expect(r.stock.released).toBe(2);
    // the cost follows the pieces: two of three at 12 → 8
    expect(orderOf(r.sale.id).estimatedCostOfGoods).toBe(8);
  });

  it('one piece out of a box of two, with the whole price on it', async () => {
    const r = await run({ pieces: 1 });
    expect(orderOf(r.sale.id)).toMatchObject({ quantity: 1, totalAmount: 40, sellingPrice: 40 });
    expect(W.items.find((i) => i.orderId === r.sale.id)).toMatchObject({ quantity: 1, lineTotal: 40, unitPrice: 40 });
    expect(orderOf('y').shippingStatus).toBe('RETURN_REQUESTED');
  });

  it('a gift is a piece like any other', async () => {
    const yi = W.items.find((i) => i.id === 'yi1')!;
    yi.quantity = 1;
    yi.freeQuantity = 1;
    const r = await run({ pieces: 2 });
    expect(r.box.total).toBe(2);
    expect(W.items.find((i) => i.orderId === r.sale.id)).toMatchObject({ quantity: 2, freeQuantity: 0, lineTotal: 40 });
  });

  it('the customer\'s own box came back — and did not: both end as a return, the answer is on the story', async () => {
    const a = await run({ ownerBoxBack: true });
    expect(orderOf('x').shippingStatus).toBe('RETURN_REQUESTED');
    expect(JSON.parse(W.activities.find((x) => x.orderId === 'x')!.metadata).ownerBoxBack).toBe(true);

    W = makeWorld();
    state.w = W;
    const b = await run({ ownerBoxBack: false });
    expect(orderOf('x').shippingStatus).toBe('RETURN_REQUESTED');
    expect(JSON.parse(W.activities.find((x) => x.orderId === 'x')!.metadata).ownerBoxBack).toBe(false);
    expect(a.owner.boxBack).toBe(true);
    expect(b.owner.boxBack).toBe(false);
  });

  it('X was already counted at the desk: it stays RETURNED, with its receipt, and only the sale is added', async () => {
    orderOf('x').shippingStatus = 'RETURNED';
    W.receipts.push({ orderId: 'x', expectedQty: 1, receivedQty: 1, damagedQty: 0, missingQty: 0 });
    const r = await run();
    expect(orderOf('x').shippingStatus).toBe('RETURNED');
    expect(W.receipts.filter((q) => q.orderId === 'x')).toHaveLength(1);
    expect(r.sale.total).toBe(40);
  });
});

describe('written as differences against what the doors already wrote', () => {
  it('a door counted A\'s refusal (a nothing-taken record): it is taken back, and not twice', async () => {
    orderOf('x').shippingStatus = 'RETURNED';
    W.activities.push({ companyId: 'c1', orderId: 'x', action: 'PARTIAL_DELIVERY_RECORDED', newStatus: 'RETURNED' });
    W.customers.find((c) => c.id === 'cuA')!.cancelledOrders = 1;
    const r = await run();
    expect(W.customers.find((c) => c.id === 'cuA')).toMatchObject({ cancelledOrders: 0, deliveredOrders: 1, totalPurchaseValue: 40 });
    expect(r.counters.customerRefusalTakenBack).toBe(true);
  });

  it('it never takes a count below zero', async () => {
    orderOf('x').shippingStatus = 'RETURNED';
    W.activities.push({ companyId: 'c1', orderId: 'x', action: 'PARTIAL_DELIVERY_RECORDED', newStatus: 'RETURNED' });
    const r = await run();
    expect(W.customers.find((c) => c.id === 'cuA')!.cancelledOrders).toBe(0);
    expect(r.counters.customerRefusalTakenBack).toBe(false);
  });

  it('a door already counted B\'s cancellation: it is not counted again', async () => {
    W.activities.push({ companyId: 'c1', orderId: 'y', action: 'PARTIAL_DELIVERY_RECORDED', newStatus: 'RETURNED' });
    const r = await run();
    expect(W.customers.find((c) => c.id === 'cuB')!.cancelledOrders).toBe(0);
    expect(r.counters.boxCustomerCancelled).toBe(false);
  });

  it('Y\'s units were already released (the cancel carried out first): releasing again changes nothing', async () => {
    W.items.find((i) => i.id === 'yi1')!.reservedQty = 0;
    const r = await run();
    expect(r.stock.released).toBe(0);
    expect(W.items.find((i) => i.id === 'yi1')!.reservedQty).toBe(0);
    expect(W.consumed).toEqual([{ orderId: r.sale.id, taken: 2 }]);
  });
});

describe('X has no line at all in the file', () => {
  it('nothing else is touched — the money line alone is linked', async () => {
    W.matches = W.matches.filter((m) => m.id === 'mY');
    const r = await run();
    expect(W.matches).toHaveLength(1);
    expect(W.matches[0]).toMatchObject({ orderId: r.sale.id, result: 'MATCHED' });
  });

  it('X\'s line stays what it was if the company wrote money on it too (not a zero) — judged, still a difference', async () => {
    W.matches.find((m) => m.id === 'mX')!.statementLine = { amount: 5, fee: null, status: 'تم' };
    await run();
    expect(W.matches.find((m) => m.id === 'mX')).toMatchObject({ result: 'MISMATCHED', statementAmount: 5 });
  });
});

/* ═════════════════════════════ THE SAME NUMBERS, WITHOUT A DATABASE ═════════════════════════════ */

describe('the price of the box — through the one COD function, in the currency\'s own places', () => {
  const lines = (qs: number[]): BoxLine[] =>
    qs.map((q, i) => ({ id: `l${i}`, productId: `p${i}`, productName: `منتج ${i}`, quantity: q, freeQuantity: 0 }));

  it('40.000 over two pieces is two at 20.000, with the fee inside', () => {
    const p = priceTheBox({ taken: takeFromBox(lines([2]), 2), paid: 40, fee: 2.5, priceIncludesDelivery: true, minorUnit: 3 });
    expect(p).toMatchObject({ subtotal: 40, cod: 40, fee: 2.5 });
    expect(p.lines[0]).toMatchObject({ qty: 2, lineTotal: 40, unitPrice: 20 });
  });

  it('with the fee on top the goods are what is left: 37.500 + 2.500 = 40.000', () => {
    const p = priceTheBox({ taken: takeFromBox(lines([2]), 2), paid: 40, fee: 2.5, priceIncludesDelivery: false, minorUnit: 3 });
    expect(p).toMatchObject({ subtotal: 37.5, cod: 40, fee: 2.5 });
  });

  it('three single pieces of one dinar-ten-thousand: 10.000 does not become 9.999', () => {
    const p = priceTheBox({ taken: takeFromBox(lines([1, 1, 1]), 3), paid: 10, fee: 0, priceIncludesDelivery: true, minorUnit: 3 });
    expect(p.lines.map((l) => l.lineTotal).reduce((a, b) => a + b, 0)).toBeCloseTo(10, 6);
    expect(p.cod).toBe(10);
    expect(p.lines.map((l) => l.lineTotal).sort()).toEqual([3.333, 3.333, 3.334]);
  });

  it('a figure it cannot reproduce is never written', () => {
    expect(() => priceTheBox({ taken: takeFromBox(lines([1]), 1), paid: 2, fee: 2.5, priceIncludesDelivery: false, minorUnit: 3 })).toThrow('BOX_PRICE_NOT_POSITIVE');
  });

  it('the pieces come out of the lines in the order the box was packed, and never more than it held', () => {
    const l = lines([2, 3]);
    expect(boxUnits(l)).toBe(5);
    expect(takeFromBox(l, 4).map((t) => t.qty)).toEqual([2, 2]);
    expect(takeFromBox(l, 1).map((t) => t.qty)).toEqual([1]);
    expect(() => takeFromBox(l, 6)).toThrow('BOX_PIECES_OUT_OF_RANGE');
    expect(() => takeFromBox(l, 0)).toThrow('BOX_PIECES_OUT_OF_RANGE');
    expect(splitBox(l, 4).map((s) => [s.taken, s.remaining])).toEqual([[2, 0], [2, 1]]);
  });

  it('what the line says A paid: the net plus the fee, rounded to three places, a missing fee being none', () => {
    expect(paidFromLine({ amount: 37.5, fee: 2.5 }, 3)).toEqual({ net: 37.5, fee: 2.5, paid: 40 });
    expect(paidFromLine({ amount: '9.9996', fee: null }, 3)).toEqual({ net: 10, fee: 0, paid: 10 });
    expect(paidFromLine({ amount: '0.1', fee: '0.2' }, 3).paid).toBe(0.3);
  });

  it('the same order, priced by the door\'s rule, comes back as the line says — never a fils off', () => {
    for (const paid of [40, 35, 12.345, 99.999, 0.5]) {
      for (const includes of [true, false]) {
        const fee = paid > 3 ? 2.5 : 0;
        const p = priceTheBox({ taken: takeFromBox(lines([2, 1]), 3), paid, fee, priceIncludesDelivery: includes, minorUnit: 3 });
        const facts = {
          shippingStatus: 'DELIVERED', totalAmount: p.cod, collectedAmount: null, deliveryFee: p.fee,
          priceIncludesDelivery: includes, addOns: [], returnReceipt: null,
          items: p.lines.map((l) => ({ quantity: l.qty, freeQuantity: 0, unitPrice: l.unitPrice, discountShare: 0, lineTotal: l.lineTotal, deliveredQty: null })),
        };
        // the courier hands over the paid sum less its fee — that is what the swapped order must expect
        expect(expectedAmountFor(facts as any, 3)).toBeCloseTo(paid - fee, 6);
        const v = judgeLine({
          order: { ...facts, settlementStatus: 'NOT_APPLICABLE' } as any,
          line: { amount: paid - fee, fee },
          minorUnit: 3,
          integrity: { claimedByAnotherLine: false, otherStatements: [], openRequests: [] },
        });
        expect(v.result).toBe('MATCHED');
      }
    }
  });
});

describe('the verdicts the dialog and the door share', () => {
  const statement = { storeId: 's1', currencyCode: 'JOD', deliveryProviderId: 'dp1' };
  const y = { shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', returnReceipt: null, addOns: [], storeId: 's1', currency: 'JOD', deliveryProviderId: 'dp1' };

  it('a box that can be swapped has no blocker', () => {
    expect(boxBlockers(y as any, { statement, cancelAsked: true })).toEqual([]);
  });

  it('each blocker is its own code, and the receipt outranks the state', () => {
    expect(boxBlockers({ ...y, returnReceipt: { id: 'r' }, shippingStatus: 'RETURNED' } as any, { statement, cancelAsked: true }).map((b) => b.code)).toEqual(['BOX_COUNTED']);
    expect(boxBlockers(y as any, { statement, cancelAsked: false }).map((b) => b.code)).toEqual(['BOX_NOT_CANCELLED']);
  });

  it('a customer who cannot be the one: every reason is reported, not only the first', () => {
    const x = { id: 'y2', customerId: 'cuB', storeId: 's2', currency: 'USD', deliveryProviderId: 'dp9', shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED', replacedBy: null };
    const codes = ownerBlockers(x as any, { id: 'y', customerId: 'cuB' } as any, { statement, cancelAsked: true }).map((b) => b.code);
    expect(codes).toEqual(['SAME_CUSTOMER', 'OTHER_STORE', 'OTHER_CURRENCY', 'OTHER_COURIER', 'SETTLED', 'OWNER_DELIVERED']);
  });
});

/* ═════════════════════════════ THE SEARCH ═════════════════════════════ */

describe('the search for the customer who took the box', () => {
  const search = (q: string, w: World = W) =>
    findSwapCandidates(makeTx(w) as any, { companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'mY', query: q, minorUnit: 3 });

  it('says what the box is, and asks for three characters before it lists half the shop', async () => {
    const r = await search('79');
    expect(r.box).toMatchObject({ orderNumber: 'JO-2026-0002', pieces: 2, products: ['عطر'], blockedBy: [] });
    expect(r.candidates).toEqual([]);
    expect(r.hint).toContain('3');
  });

  it('lists a customer\'s order on the road with what the courier owes for it', async () => {
    // the fake does not narrow a text search; the candidate is whichever order fits the fixed scope
    const r = await search('JO-2026-0001');
    const c = r.candidates.find((k) => k.id === 'x')!;
    expect(c).toMatchObject({ orderNumber: 'JO-2026-0001', expected: 17.5, blockedBy: [] });
    expect(c.customer?.fullName).toBe('سارة');
  });

  it('never offers the box\'s own order, a settled one, or another courier\'s', async () => {
    orderOf('x').settlementStatus = 'SETTLED';
    const r = await search('JO-2026');
    expect(r.candidates.map((k) => k.id)).not.toContain('y');
    expect(r.candidates.map((k) => k.id)).not.toContain('x');
  });

  it('greys an order another statement holds, with the sentence', async () => {
    W.matches.push({ id: 'm9', companyId: 'c1', statementId: 'st2', statementLineId: 'l9', orderId: 'x', result: 'MATCHED', resolution: null });
    const r = await search('JO-2026-0001');
    expect(r.candidates[0].blockedBy).toContain(SWAP_WHY.claimedElsewhere);
  });

  it('refuses a line that is not a difference', async () => {
    W.matches[0].result = 'MATCHED';
    const e = await refusal(search('JO-2026-0001'));
    expect(e.body.code).toBe('NOT_SWAPPABLE');
  });

  it('says up front when the box cannot be swapped', async () => {
    W.requests.length = 0;
    const r = await search('JO-2026-0001');
    expect(r.box.blockedBy).toEqual([SWAP_WHY.boxNotCancelled]);
  });
});

/* ═════════════════════════════ A BOX OF TWO LINES ═════════════════════════════ */

describe('a box of two lines', () => {
  const twoLines = () => {
    W.items.push(
      item({ id: 'yi2', orderId: 'y', seq: 4, createdAt: new Date(T0.getTime() + 2500), productId: 'p2', productName: 'كريم', quantity: 1, unitPrice: 10, lineTotal: 10, reservedQty: 1 })
    );
  };

  it('the whole box: the 40.000 is shared by pieces, 26.667 and 13.333, and the sale\'s first product is the box\'s first', async () => {
    twoLines();
    const r = await run({ pieces: 3 });
    const lines = W.items.filter((i) => i.orderId === r.sale.id);
    expect(lines.map((l) => [l.productId, l.quantity, l.lineTotal])).toEqual([['p1', 2, 26.667], ['p2', 1, 13.333]]);
    expect(orderOf(r.sale.id)).toMatchObject({ productId: 'p1', quantity: 3, totalAmount: 40, sellingPrice: 40 });
    expect(W.consumed).toEqual([{ orderId: r.sale.id, taken: 3 }]);
    expect(W.receipts[0]).toMatchObject({ orderId: 'y', expectedQty: 0 });
  });

  it('two pieces: only the first line goes; the second line is what is still owed back', async () => {
    twoLines();
    const r = await run({ pieces: 2 });
    expect(W.items.filter((i) => i.orderId === r.sale.id).map((l) => [l.productId, l.quantity])).toEqual([['p1', 2]]);
    expect(W.items.find((i) => i.id === 'yi1')).toMatchObject({ deliveredQty: 2, returnedQty: 0, reservedQty: 0 });
    expect(W.items.find((i) => i.id === 'yi2')).toMatchObject({ deliveredQty: 0, returnedQty: 1, reservedQty: 1 });
    expect(expectedBackTotal(W.items.filter((i) => i.orderId === 'y') as any)).toBe(1);
  });

  it('packing order is by when a line was written, then by its id', () => {
    const at = (s: number) => new Date(1_000 + s);
    const out = inPackingOrder([
      { id: 'c', createdAt: at(2) }, { id: 'b', createdAt: at(1) }, { id: 'a', createdAt: at(1) }, { id: 'd', createdAt: null },
    ]);
    expect(out.map((l) => l.id)).toEqual(['d', 'a', 'b', 'c']);
  });
});

/* ═════════════════════════════ RE-RUNNING THE MATCHING KEEPS IT ═════════════════════════════ */

describe('the link is a MANUAL row, so the matcher leaves it alone', () => {
  it('it is exactly the kind of row a re-run neither deletes nor re-matches', async () => {
    const r = await run();
    const row = W.matches.find((m) => m.id === 'mY')!;
    // runMatching deletes only rows with no answer that are not MANUAL, and skips the lines it already holds.
    expect(row.matchedBy).toBe(MANUAL_MATCH);
    expect(row.statementLineId).toBe('lY');
    expect(row.orderId).toBe(r.sale.id);
  });
});

/* ═════════════════════════════ THE PRESSES THAT LAND IN THE MIDDLE ═════════════════════════════ */

describe('a press that lands while the swap is being written', () => {
  it('the line was answered in the meantime: the claim on it finds nothing and the whole swap stops', async () => {
    W.onCreate = () => { W.matches[0].resolution = 'ACCEPTED_COURIER'; };
    const e = await refusal(run());
    expect(e.body.code).toBe('ORDER_MOVED');
    expect(W.matches[0].orderId).toBe('y');
  });

  it('the statement was approved in the meantime: the same claim stops it', async () => {
    W.onCreate = () => { W.statements[0].approvedAt = new Date(); };
    const e = await refusal(run());
    expect(e.body.code).toBe('ORDER_MOVED');
  });

  it('the unshipped replacement moved after it was read: reshaping it stops, in words', async () => {
    orderOf('x').shippingStatus = 'RETURN_REQUESTED';
    W.orders.push(order({
      id: 'xr', orderNumber: 'JO-2026-0009', replacesOrderId: 'x', shippingStatus: 'READY_FOR_SHIPPING',
      shippedAt: null, labelPrintedAt: null, shippingBatchId: null, deliveryProviderId: null, version: 2,
    }));
    W.items.push(item({ id: 'xri1', orderId: 'xr', seq: 3, createdAt: new Date(T0.getTime() + 3000), reservedQty: 1 }));
    W.moved.add('xr');
    const e = await refusal(run());
    expect(e.body.code).toBe('ORDER_MOVED');
    expect(e.body.error).toBe(SWAP_WHY.moved);
  });

  it('the COD function disagreeing with the courier\'s figure writes nothing and says so', async () => {
    vi.mocked(computeCod).mockImplementationOnce(((input: any) => {
      const real = (vi.importActual('./money') as any);
      return { ...real, subtotal: 40, discount: 0, deliveryFee: 2.5, cod: 40.001, revenue: 0, addOns: 0, discountShares: [0], lineTotals: [40] };
    }) as any);
    const e = await refusal(run());
    expect(e.body.code).toBe('PRICE_DRIFT');
    expect(e.body.error).toBe(SWAP_WHY.priceDrift);
    expect(W.customers.find((c) => c.id === 'cuA')!.deliveredOrders).toBe(0);
  });
});


/* ═════════════════════════════ A BOX WITH AN ADD-ON ═════════════════════════════ */

describe('a box with an add-on is refused whole, before any write', () => {
  const upsell = { id: 'a1', orderId: 'y', productId: 'p9', productName: 'غطاء', quantity: 1, price: 5, reservedQty: 1 };

  it('Y = two pieces + an upsell piece: the whole box went, the sale would draw 2 — so nothing is recorded', async () => {
    W.addOns.push(upsell);
    const e = await refusal(run());
    expect(e.body.code).toBe('BOX_HAS_ADD_ONS');
    expect(e.body.error).toBe(SWAP_WHY.boxHasAddOns);
    expect(W.writes).toEqual([]);
    expect(W.consumed).toEqual([]);
    expect(W.released).toEqual([]);
  });

  it('without the upsell the same swap goes through (the add-on is the only difference)', async () => {
    const r = await run();
    expect(r.stock.consumed).toBe(2);
  });

  it('the dialog says so up front', async () => {
    W.addOns.push(upsell);
    const r = await findSwapCandidates(makeTx(W) as any, {
      companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'mY', query: 'JO-2026-0001', minorUnit: 3,
    });
    expect(r.box.blockedBy).toContain(SWAP_WHY.boxHasAddOns);
  });

  it("an upsell on the customer's own order is read and does not matter: the sale is built from the box alone", async () => {
    W.addOns.push({ ...upsell, id: 'a2', orderId: 'x' });
    const r = await run();
    expect(orderOf(r.sale.id).totalAmount).toBe(40);
    expect(W.consumed).toEqual([{ orderId: r.sale.id, taken: 2 }]);
  });

  it('the sentence is Arabic', () => {
    expect(SWAP_WHY.boxHasAddOns).not.toMatch(/[A-Za-z]/);
  });
});

/* ═════════════════════════════ A CLAIM LEFT OPEN ON THE COMPANY ═════════════════════════════ */

describe('an order with an open claim on the company is refused — a settlement statement would pay it twice', () => {
  const claim = (orderId: string, statementId = 'st2'): Row => ({
    id: `c-${orderId}`, companyId: 'c1', statementId, statementLineId: 'lc', orderId, result: 'MISMATCHED', resolution: 'OURS_STANDS',
  });

  it("on the customer's order: X was answered «رقمنا» earlier", async () => {
    W.matches.push(claim('x'));
    const e = await refusal(run());
    expect(e.body.code).toBe('OPEN_CLAIM');
    expect(e.body.error).toBe(SWAP_WHY.openClaim);
    expect(W.writes).toEqual([]);
  });

  it("on the box's order", async () => {
    W.matches.push(claim('y'));
    expect((await refusal(run())).body.code).toBe('OPEN_CLAIM');
    expect(W.writes).toEqual([]);
  });

  it('on THIS statement too — a decision not yet carried out is still a claim', async () => {
    W.matches.push(claim('x', 'st1'));
    expect((await refusal(run())).body.code).toBe('OPEN_CLAIM');
  });

  it('a row answered the other way is not a claim (it is a different refusal: it holds the order)', async () => {
    W.matches.push({ ...claim('x'), resolution: 'ACCEPTED_COURIER' });
    expect((await refusal(run())).body.code).toBe('CLAIMED_ELSEWHERE');
  });

  it('the search greys that customer with the sentence', async () => {
    W.matches.push(claim('x'));
    const r = await findSwapCandidates(makeTx(W) as any, {
      companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'mY', query: 'JO-2026-0001', minorUnit: 3,
    });
    expect(r.candidates[0].blockedBy).toContain(SWAP_WHY.openClaim);
  });

  it('the sentence is Arabic', () => {
    expect(SWAP_WHY.openClaim).not.toMatch(/[A-Za-z]/);
  });
});

/* ═════════════════════════════ EACH CONDITION OF EACH CLAIM, ON ITS OWN ═════════════════════════════ */

/*
 * The tests above play a press that lands by making a write find nothing (`moved`). That proves the code stops when a
 * claim comes back empty — not that each condition INSIDE the claim is there. These change the row itself between
 * the read and the write, so only the one condition that notices it can stop the swap: take that condition out and
 * the swap goes through, and the test goes red.
 */
describe('every condition of every claim, one at a time', () => {
  const stopsOn = async (code: string) => {
    const e = await refusal(run());
    expect(e.body.code).toBe(code);
  };

  it('Y moved on a version', async () => {
    W.beforeOrderUpdate = { y: () => { orderOf('y').version += 1; } };
    await stopsOn('ORDER_MOVED');
  });

  it('Y left the road (a door delivered it)', async () => {
    W.beforeOrderUpdate = { y: () => { orderOf('y').shippingStatus = 'DELIVERED'; } };
    await stopsOn('ORDER_MOVED');
  });

  it('Y was settled by hand', async () => {
    W.beforeOrderUpdate = { y: () => { orderOf('y').settlementStatus = 'SETTLED'; } };
    await stopsOn('ORDER_MOVED');
  });

  it('X moved on a version', async () => {
    W.beforeOrderUpdate = { x: () => { orderOf('x').version += 1; } };
    await stopsOn('ORDER_MOVED');
  });

  it('X was delivered by a door', async () => {
    W.beforeOrderUpdate = { x: () => { orderOf('x').shippingStatus = 'DELIVERED'; } };
    await stopsOn('ORDER_MOVED');
  });

  it('X was settled by hand', async () => {
    W.beforeOrderUpdate = { x: () => { orderOf('x').settlementStatus = 'SETTLED'; } };
    await stopsOn('ORDER_MOVED');
  });

  it('the line was tied to another order in the meantime', async () => {
    W.onCreate = () => { W.matches[0].orderId = 'someone-else'; };
    await stopsOn('ORDER_MOVED');
  });

  it('the line stopped being a difference in the meantime', async () => {
    W.onCreate = () => { W.matches[0].result = 'MATCHED'; };
    await stopsOn('ORDER_MOVED');
  });
});
