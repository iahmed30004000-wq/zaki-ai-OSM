import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinesChange } from './change-request-fields';
import type { OrderEditFacts, StoredLine } from './order-line-edit';
import type { EditableOrderRow } from './order-edit-facts';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A STORED `lines` REQUEST, JUDGED AGAINST THE ORDER AS IT IS NOW.
 *
 * The decider's screen shuts its button when this says the request cannot be carried out, so the one thing held here is
 * that it says so EXACTLY when the apply door would refuse: every scenario below is judged twice — by
 * `previewStoredRequest` and by the REAL `planLineApply` — over the same facts, and the two must agree on «refused».
 * Only what reads the world is a fake (the facts reader); the engine, the binder and the apply door's rules are real.
 *
 * The order, in three-place JOD:
 *   L1 · cream × 3 at 36.000 (12.000 each)      L2 · soap × 2 at 10.000 (5.000 each)
 *   subtotal 46.000, no discount, delivery 2.500  →  the courier collects 48.500
 * and the request: «L1 from 3 to 5, at 60.000» → 70.000 + 2.500 = 72.500.
 * ═══════════════════════════════════════════════════════════════════════
 */

const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';
const L1 = 'line-cream-1';
const L2 = 'line-soap-2';

const { state } = vi.hoisted(() => ({ state: { facts: null as unknown } }));

vi.mock('./db', () => ({ db: {} }));
vi.mock('./reservation', () => ({ availableStock: vi.fn() }));
// The facts reader is the one fake: the REAL engine and the REAL apply planner judge whatever order this file builds.
vi.mock('./order-edit-facts', () => ({ readOrderEditFacts: async () => state.facts }));

import { previewStoredRequest } from './change-request-review-facts';
import { planLineApply } from './order-line-apply';

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

type FactsOver = { order?: Partial<OrderEditFacts['order']> } & Partial<Omit<OrderEditFacts, 'order'>>;

const factsOf = (over: FactsOver = {}): OrderEditFacts => {
  const { order, ...rest } = over;
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
    available: { [CREAM]: 100, [SOAP]: 100 },
    shipmentCod: 48.5,
    customer: { phoneInvalid: false, altPhoneInvalid: false, phoneDuplicate: false, regionOutsideCountry: false, regionFee: null },
    ...rest,
  };
};

const snapshotOf = (over: Record<string, unknown> = {}): NonNullable<LinesChange['snapshot']> =>
  ({
    orderVersion: 7,
    minorUnit: 3,
    before: { cod: 48.5, subtotal: 46, discount: 0, deliveryFee: 2.5, revenue: 46, giftUnits: 0 },
    after: { cod: 72.5, subtotal: 70, discount: 0, deliveryFee: 2.5, revenue: 70, giftUnits: 0 },
    lineOrder: [L1, L2],
    stock: [{ productId: CREAM, productName: 'كريم', before: 3, after: 5, held: 3, freed: 0, enough: true, status: 'ENOUGH' }],
    door: 'REQUEST',
    warnings: [],
    ...over,
  }) as NonNullable<LinesChange['snapshot']>;

const FIVE: LinesChange = {
  v: 2,
  edits: [
    {
      lineId: L1,
      productId: { from: CREAM, to: CREAM },
      quantity: { from: 3, to: 5 },
      lineTotal: { from: 36, to: 60 },
      unitPrice: { from: 12, to: 12 },
      freeQuantity: { from: 0, to: 0 },
      basis: 'KEEP_UNIT',
    },
  ],
  snapshot: snapshotOf(),
};

const ORDER = {
  id: 'o1',
  customerId: 'cu1',
  confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY',
  settlementStatus: 'NOT_APPLICABLE',
  totalAmount: 48.5,
  version: 7,
} satisfies EditableOrderRow;

const COUNTRY = { code: 'JO', minorUnit: 3, allowNegativeStock: false };

const judge = (request: LinesChange = FIVE, flat: Record<string, unknown> = {}) =>
  previewStoredRequest({ requestId: 'cr1', changes: { lines: request, ...flat }, order: ORDER, companyId: 'c1', country: COUNTRY });

const plan = (request: LinesChange = FIVE) =>
  planLineApply({ order: ORDER, companyId: 'c1', country: COUNTRY, edits: request.edits, snapshot: request.snapshot ?? null, flat: {} });

const preview = async (request: LinesChange = FIVE) => {
  const out = await judge(request);
  if (!out.ok) throw new Error(`لم تُعاين: ${out.reason}`);
  return out.preview;
};

beforeEach(() => {
  state.facts = factsOf();
});

/* ─────────────────────────── 1 · a request that can still be carried out ─────────────────────────── */

describe('Ⅰ · a request the order can still take', () => {
  it('shows the order now and with the request in it — the stored figures, not re-priced ones', async () => {
    const p = await preview();

    expect(p.stale).toBe(false);
    expect(p.blocked).toBe(false);
    // 46 + 2.5 collected today; the request's 60 for L1 → 70 + 2.5 after.
    expect(p.before.cod).toBe(48.5);
    expect(p.after?.cod).toBe(72.5);
    expect(p.after?.subtotal).toBe(70);

    const l1 = p.lines.find((l) => l.lineId === L1);
    expect(l1).toMatchObject({
      changed: true,
      productName: { from: 'كريم', to: 'كريم' },
      quantity: { from: 3, to: 5 },
      lineTotal: { from: 36, to: 60 },
      freeQuantity: { from: 0, to: 0 },
    });
    // The other line is there, unchanged — the screen counts it and does not draw it.
    expect(p.lines.find((l) => l.lineId === L2)?.changed).toBe(false);
  });

  it('prices the request at the figure it STORED, even when today’s catalogue says otherwise', async () => {
    // The catalogue price of cream moved to 20 since the request was raised: the request still says 60 for five.
    state.facts = factsOf({ products: [{ id: CREAM, name: 'كريم', basePrice: 20, status: 'ACTIVE' }, { id: SOAP, name: 'صابون', basePrice: 5, status: 'ACTIVE' }] });
    const p = await preview();
    expect(p.after?.cod).toBe(72.5);
    expect(p.lines.find((l) => l.lineId === L1)?.lineTotal.to).toBe(60);
  });

  it('says what the shelf does for the order and nothing about how many the warehouse holds', async () => {
    const p = await preview();
    const cream = p.stock.find((s) => s.productId === CREAM);
    expect(cream).toMatchObject({ before: 3, after: 5, status: 'ENOUGH', enough: true });
    for (const s of p.stock) {
      expect(Object.keys(s)).not.toContain('needed');
      expect(Object.keys(s)).not.toContain('missing');
    }
  });

  it('carries no cost, no profit and no revenue — the decider reads a quantity, not the books', async () => {
    const p = await preview();
    const text = JSON.stringify(p);
    for (const word of ['revenue', 'profit', 'margin', 'cost', 'discountShares']) {
      expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
    }
  });

  it('and nothing has moved since the request was raised', async () => {
    const p = await preview();
    expect(p.drift).toEqual({ known: true, moved: false, items: [] });
  });

  it('reads the fields that travel with the lines (the discount) through the same draft', async () => {
    // The request also sets the order’s discount to 5: 70 − 5 + 2.5 = 67.5 after, against 72.5 recorded → it is stale.
    const out = await judge(FIVE, { discountAmount: { from: 0, to: 5 } });
    if (!out.ok) throw new Error('لم تُعاين');
    expect(out.preview.after?.discount).toBe(5);
    expect(out.preview.after?.cod).toBe(67.5);
    expect(out.preview.problems.map((p) => p.code)).toContain('TOTAL_CHANGED');
  });
});

/* ─────────────────────────── 2 · the gate says «refused» exactly when the apply door does ─────────────────────────── */

describe('Ⅱ · blocked ⇔ the apply door refuses (the same facts, judged twice)', () => {
  const lines = (...over: Array<Partial<StoredLine> & { id: string }>) => {
    const base = factsOf().lines;
    return base.map((l) => ({ ...l, ...(over.find((o) => o.id === l.id) ?? {}) }));
  };

  const swapToSoap: LinesChange = {
    v: 2,
    edits: [{ lineId: L1, productId: { from: CREAM, to: SOAP } }],
  };

  const scenarios: Array<{ name: string; facts: () => OrderEditFacts; request?: LinesChange; refused: boolean; code?: string }> = [
    { name: 'the order is as it was raised', facts: () => factsOf(), refused: false },
    {
      name: 'the shelf cannot give five',
      facts: () => factsOf({ available: { [CREAM]: 4, [SOAP]: 100 } }),
      refused: true,
      code: 'STOCK_SHORT_BLOCKED',
    },
    {
      name: 'the shelf is short but the country allows it',
      facts: () => factsOf({ available: { [CREAM]: 4, [SOAP]: 100 }, allowNegativeStock: true }),
      refused: false,
    },
    {
      name: 'a discount appeared since: the total the decider saw is gone',
      facts: () => factsOf({ order: { discount: 5, storedTotal: 43.5 }, shipmentCod: 43.5 }),
      refused: true,
      code: 'TOTAL_CHANGED',
    },
    {
      name: 'the line was saved again and no longer reads as recorded',
      facts: () => factsOf({ lines: lines({ id: L1, quantity: 4, lineTotal: 48 }) }),
      refused: true,
      code: 'LINES_STALE',
    },
    {
      name: 'the line was saved again under a new id but reads the same: found by value',
      facts: () => factsOf({ lines: lines({ id: 'line-cream-NEW' }) }),
      refused: false,
    },
    { name: 'a courier statement claims the order', facts: () => factsOf({ order: { statementLinked: true } }), refused: true, code: 'STATEMENT_LINKED' },
    { name: 'the courier has the parcel', facts: () => factsOf({ order: { handed: true } }), refused: true, code: 'PARCEL_HANDED' },
    { name: 'the order was cancelled', facts: () => factsOf({ order: { closed: true } }), refused: true, code: 'ORDER_CLOSED' },
    { name: 'two delivery fees', facts: () => factsOf({ order: { deliveryFee: 3 } }), refused: true, code: 'FEE_SOURCE_DRIFT' },
    {
      name: 'a line was delivered',
      facts: () => factsOf({ lines: lines({ id: L2, deliveredQty: 1 }) }),
      refused: true,
      code: 'LINE_SETTLED',
    },
    {
      name: 'the stored total disagrees with its own lines',
      facts: () => factsOf({ order: { storedTotal: 50 }, shipmentCod: 50 }),
      refused: true,
      code: 'COD_DRIFT',
    },
    {
      name: 'the product it swaps to has been switched off since',
      facts: () =>
        factsOf({ products: [{ id: CREAM, name: 'كريم', basePrice: 12, status: 'ACTIVE' }, { id: SOAP, name: 'صابون', basePrice: 5, status: 'INACTIVE' }] }),
      request: swapToSoap,
      refused: true,
      code: 'PRODUCT_INACTIVE',
    },
    {
      name: 'the product it swaps to is gone',
      facts: () => factsOf({ products: [{ id: CREAM, name: 'كريم', basePrice: 12, status: 'ACTIVE' }] }),
      request: swapToSoap,
      refused: true,
      code: 'PRODUCT_UNAVAILABLE',
    },
  ];

  for (const s of scenarios) {
    it(`${s.name} → ${s.refused ? 'shut' : 'open'}, as the apply door says`, async () => {
      state.facts = s.facts();
      const request = s.request ?? FIVE;

      const p = await preview(request);
      const planned = await plan(request);

      expect(p.blocked, `الفحص: ${JSON.stringify(p.problems)}`).toBe(s.refused);
      expect(planned.ok === false, `الباب: ${JSON.stringify(planned)}`).toBe(s.refused);
      if (s.code) {
        expect(p.problems.find((x) => x.blocking && x.code === s.code), `لا سبب باسم ${s.code}`).toBeDefined();
      }
      // A shut button always has its reason in words.
      if (s.refused) expect(p.problems.some((x) => x.blocking && x.messageAr.length > 0)).toBe(true);
    });
  }

  it('what the apply door would write is what the screen shows: the same lines, the same totals, the same gifts', async () => {
    const p = await preview();
    const planned = await plan();
    if (!planned.ok || !planned.apply) throw new Error('الباب رفض أو ما كتب شيئاً');

    expect(planned.apply.after.cod).toBe(p.after?.cod);
    expect(planned.apply.before.cod).toBe(p.before.cod);
    // Same lines in the same order (the order the discount's remainder is spread in).
    expect(planned.apply.lineIds).toEqual(p.lines.map((l) => l.lineId));
    const idOf = (name: string) => (name === 'كريم' ? CREAM : SOAP);
    expect(planned.apply.items.map((i) => [i.productId, i.quantity, i.unitPrice])).toEqual(
      p.lines.map((l) => [idOf(l.productName.to), l.quantity.to, l.lineTotal.to])
    );
    expect(planned.apply.gifts).toEqual(p.lines.map((l) => l.freeQuantity.to));
  });

  it('a gift the request fixed is the gift shown, whatever an offer says today', async () => {
    // Raised with «three + one»: five paid and two free. An offer that has since changed must not move it.
    const gifted: LinesChange = {
      v: 2,
      edits: [
        {
          lineId: L1,
          productId: { from: CREAM, to: CREAM },
          quantity: { from: 3, to: 6 },
          lineTotal: { from: 36, to: 50 },
          freeQuantity: { from: 0, to: 2 },
        },
      ],
    };
    const p = await preview(gifted);
    const planned = await plan(gifted);
    expect(p.lines.find((l) => l.lineId === L1)?.freeQuantity).toEqual({ from: 0, to: 2 });
    if (!planned.ok || !planned.apply) throw new Error('الباب رفض أو ما كتب شيئاً');
    expect(planned.apply.gifts[0]).toBe(2);
  });
});

/* ─────────────────────────── 3 · what moved since the request was raised ─────────────────────────── */

describe('Ⅲ · what moved since the request was raised', () => {
  it('a discount that appeared: the total, the discount and the result all say so', async () => {
    state.facts = factsOf({ order: { discount: 5, storedTotal: 43.5 }, shipmentCod: 43.5 });
    const p = await preview();
    const kinds = p.drift.items.map((d) => d.kind);
    expect(p.drift.moved).toBe(true);
    expect(kinds).toEqual(expect.arrayContaining(['TOTAL', 'DISCOUNT', 'RESULT']));
    expect(p.blocked).toBe(true);
  });

  it('the delivery fee was rewritten', async () => {
    state.facts = factsOf({ order: { shippingCost: 3, storedTotal: 49, deliveryFee: null }, shipmentCod: 49 });
    const p = await preview();
    expect(p.drift.items.map((d) => d.kind)).toContain('FEE');
  });

  it('the shelf ran out since: the screen says the stock is no longer enough', async () => {
    state.facts = factsOf({ available: { [CREAM]: 4, [SOAP]: 100 } });
    const p = await preview();
    expect(p.drift.items.find((d) => d.kind === 'SHELF')?.messageAr).toContain('كريم');
  });

  it('a line was added or removed since', async () => {
    state.facts = factsOf({
      lines: [...factsOf().lines, stored({ id: 'line-extra', productId: SOAP, productName: 'صابون', quantity: 1, lineTotal: 5, reservedQty: 1 })],
      order: { storedTotal: 53.5 },
      shipmentCod: 53.5,
    });
    const p = await preview();
    expect(p.drift.items.map((d) => d.kind)).toContain('LINES');
  });

  it('the parcel left: the door changed', async () => {
    state.facts = factsOf({ order: { handed: true } });
    const p = await preview();
    expect(p.drift.items.map((d) => d.kind)).toContain('DOOR');
  });

  it('a request raised without a record of the moment says so, rather than «nothing changed»', async () => {
    const p = await preview({ ...FIVE, snapshot: undefined });
    expect(p.drift).toEqual({ known: false, moved: false, items: [] });
  });
});

/* ─────────────────────────── 4 · the lines moved: there is no «after» ─────────────────────────── */

describe('Ⅳ · the lines are no longer the ones the request was raised on', () => {
  beforeEach(() => {
    state.facts = factsOf({ lines: factsOf().lines.map((l) => (l.id === L1 ? { ...l, quantity: 4, lineTotal: 48 } : l)) });
  });

  it('draws no result, shuts the button, and keeps what was asked', async () => {
    const p = await preview();
    expect(p.stale).toBe(true);
    expect(p.after).toBeNull();
    expect(p.blocked).toBe(true);
    expect(p.problems[0]).toMatchObject({ code: 'LINES_STALE', blocking: true });
    // What the request recorded is still shown, with the product named.
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ lineId: L1, changed: true, quantity: { from: 3, to: 5 }, productName: { from: 'كريم', to: 'كريم' } });
    expect(p.drift.items.map((d) => d.kind)).toContain('LINES');
  });
});

/* ─────────────────────────── 5 · what is not a lines request ─────────────────────────── */

describe('Ⅴ · what it refuses to preview', () => {
  it('a request with no lines is not previewed', async () => {
    const out = await previewStoredRequest({ requestId: 'cr1', changes: { customerName: { from: 'أ', to: 'ب' } }, order: ORDER, companyId: 'c1', country: COUNTRY });
    expect(out).toEqual({ ok: false, reason: 'NOT_LINES' });
  });

  it('lines that cannot be read are said, not guessed', async () => {
    const out = await previewStoredRequest({ requestId: 'cr1', changes: { lines: { v: 2, edits: [] } }, order: ORDER, companyId: 'c1', country: COUNTRY });
    expect(out.ok).toBe(false);
    if (!out.ok && out.reason === 'UNREADABLE') expect(out.error.length).toBeGreaterThan(0);
    else throw new Error('كان يجب أن تكون غير مقروءة');
  });

  it('a request that dropped the «before» of a line is not this shape', async () => {
    const out = await previewStoredRequest({
      requestId: 'cr1',
      changes: { lines: { v: 2, edits: [{ lineId: L1, quantity: { to: 5 } }] } },
      order: ORDER,
      companyId: 'c1',
      country: COUNTRY,
    });
    expect(out.ok).toBe(false);
  });
});
