import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readOrderEditFacts, availableStock } = vi.hoisted(() => ({
  readOrderEditFacts: vi.fn(),
  availableStock: vi.fn<(...a: unknown[]) => Promise<number>>(),
}));

vi.mock('./db', () => ({ db: {} }));
vi.mock('./order-edit-facts', () => ({ readOrderEditFacts: (...a: unknown[]) => readOrderEditFacts(...a) }));
vi.mock('./reservation', () => ({ availableStock: (...a: unknown[]) => availableStock(...a) }));

import {
  blockedByStock,
  bindApprovedEdits,
  costAfterEdit,
  costProductIds,
  flatGoodsEdit,
  linesAreStill,
  planLineApply,
  refusalOf,
  totalMoved,
} from './order-line-apply';
import type { ApprovedLineEdit } from './change-request-fields';
import type { LineAuditEntry } from './order-line-apply';
import type { OrderEditFacts, Problem, StoredLine } from './order-line-edit';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN APPROVED REQUEST IS CHECKED AGAINST THE ORDER IT WAS APPROVED FOR — AND NOTHING IS GUESSED.
 *
 * The order below is the one every test of the lines engine uses, in three-place JOD: كريم 3 (+1 free) for 36, صابون 2 for
 * 10, 2.500 to deliver — 48.500 collected. Worked by hand beside each case.
 * ═══════════════════════════════════════════════════════════════════════
 */

const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';
const DROPS = 'prod-drops-0003';

const line = (over: Partial<StoredLine> & { id: string }): StoredLine => ({
  productId: CREAM,
  productName: 'كريم',
  quantity: 3,
  freeQuantity: 0,
  lineTotal: 36,
  reservedQty: 0,
  deliveredQty: null,
  returnedQty: null,
  ...over,
});

const l1 = () => line({ id: 'l1', quantity: 3, freeQuantity: 1, lineTotal: 36, reservedQty: 4 });
const l2 = () => line({ id: 'l2', productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10, reservedQty: 2 });

const factsOf = (over: Partial<OrderEditFacts> = {}, order: Partial<OrderEditFacts['order']> = {}): OrderEditFacts => ({
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
  lines: [l1(), l2()],
  addOns: [],
  products: [
    { id: CREAM, name: 'كريم', basePrice: 12, status: 'ACTIVE' },
    { id: SOAP, name: 'صابون', basePrice: 5, status: 'ACTIVE' },
    { id: DROPS, name: 'قطرة', basePrice: 8.5, status: 'ACTIVE' },
  ],
  offers: [],
  orderOffer: null,
  available: { [CREAM]: 20, [SOAP]: 20, [DROPS]: 20 },
  shipmentCod: 48.5,
  customer: { phoneInvalid: false, altPhoneInvalid: false, phoneDuplicate: false, regionOutsideCountry: false, regionFee: null },
  ...over,
});

const COUNTRY = { code: 'JO', minorUnit: 3, allowNegativeStock: false };
const ORDER = { id: 'o1' } as never;

const plan = (over: Partial<Parameters<typeof planLineApply>[0]> = {}) =>
  planLineApply({ order: ORDER, companyId: 'c1', country: COUNTRY, edits: [], snapshot: null, flat: {}, ...over });

/** The request the screen of the future will raise: line 1 from 3 to 5 at 58, with the gift the server worked out. */
const cream5: ApprovedLineEdit = {
  lineId: 'l1',
  productId: undefined,
  quantity: { from: 3, to: 5 },
  lineTotal: { from: 36, to: 58 },
  freeQuantity: { from: 1, to: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  readOrderEditFacts.mockResolvedValue(factsOf());
  availableStock.mockResolvedValue(100_000);
});

/* ─────────────────────────── 1 · binding the request to the stored lines ─────────────────────────── */

describe('Ⅰ · the line a request means is found by what it recorded, and never guessed', () => {
  const stored = [l1(), l2()];

  it('an id that is still there and still reads as recorded is the line', () => {
    const r = bindApprovedEdits(stored, [cream5], 3);
    expect(r.ok && r.bound[0].line.id).toBe('l1');
  });

  it('a save gives the lines new ids: the line is found again by its recorded values, if exactly one fits', () => {
    const r = bindApprovedEdits(stored, [{ ...cream5, lineId: 'old-id' }], 3);
    expect(r.ok && r.bound[0].line.id).toBe('l1');
  });

  it('…and two lines that both fit are NOT told apart by a guess', () => {
    const twins = [
      line({ id: 'a', quantity: 3, freeQuantity: 1, lineTotal: 36 }),
      line({ id: 'b', quantity: 3, freeQuantity: 1, lineTotal: 36 }),
    ];
    expect(bindApprovedEdits(twins, [{ ...cream5, lineId: 'old-id' }], 3).ok).toBe(false);
  });

  it('an id that is there but whose line has changed since is STALE — it does not fall back to another line by value', () => {
    // somebody made line 1 four pieces: the id is the same, the line is not
    const r = bindApprovedEdits([line({ id: 'l1', quantity: 4, freeQuantity: 1, lineTotal: 48 }), l2()], [cream5], 3);
    expect(r.ok).toBe(false);
  });

  it('a recorded total is compared to half a minor unit, not to the bit', () => {
    const r = bindApprovedEdits([line({ id: 'l1', quantity: 3, freeQuantity: 1, lineTotal: 36.0004 })], [cream5], 3);
    expect(r.ok).toBe(true);
    expect(bindApprovedEdits([line({ id: 'l1', quantity: 3, freeQuantity: 1, lineTotal: 36.001 })], [cream5], 3).ok).toBe(false);
  });

  it('an edit that recorded nothing cannot be found by value, so only its id can find it', () => {
    // (the schema no longer lets such an edit in; the binder still refuses to guess if one is handed to it)
    const bare = { lineId: 'gone', quantity: { to: 5 } } as unknown as ApprovedLineEdit;
    expect(bindApprovedEdits(stored, [bare], 3).ok).toBe(false);
    expect(bindApprovedEdits(stored, [{ ...bare, lineId: 'l1' }], 3).ok).toBe(true);
  });

  it('one stored line serves one edit', () => {
    const r = bindApprovedEdits(stored, [cream5, { ...cream5, lineId: 'old-id' }], 3);
    expect(r.ok).toBe(false);
  });
});

/* ─────────────────────────── 2 · the old shorthand as an edit of its one line ─────────────────────────── */

describe('Ⅱ · the shorthand of an old request is an edit of the order’s one line', () => {
  const one = line({ id: 'only', quantity: 3, freeQuantity: 0, lineTotal: 36 });

  it('a quantity alone keeps the piece price the line has: KEEP_UNIT, as the shorthand always did', () => {
    expect(flatGoodsEdit(one, { quantity: 5 })).toEqual({ lineId: 'only', quantity: 5, priceBasis: 'KEEP_UNIT' });
  });

  it('a price is the line’s TOTAL for the quantity, taken whole', () => {
    expect(flatGoodsEdit(one, { sellingPrice: 50 })).toEqual({ lineId: 'only', lineTotal: 50 });
    expect(flatGoodsEdit(one, { quantity: 5, sellingPrice: 58 })).toEqual({ lineId: 'only', quantity: 5, lineTotal: 58 });
  });

  it('a product that is the line’s own is no edit', () => {
    expect(flatGoodsEdit(one, { productId: CREAM, quantity: 3 })).toEqual({ lineId: 'only', priceBasis: 'KEEP_UNIT' });
    expect(flatGoodsEdit(one, { productId: SOAP })).toMatchObject({ productId: SOAP });
  });
});

/* ─────────────────────────── 3 · the plan ─────────────────────────── */

describe('Ⅲ · what an approved lines request writes', () => {
  it('quantity, price and gift together: 3 for 36 (+1) becomes 5 for 58 (+2); the other line is carried untouched', async () => {
    const r = await plan({ edits: [cream5], snapshot: { after: { cod: 70.5 } } });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.apply) throw new Error('expected a plan');
    // 58 + 10 + 2.500 to deliver
    expect(r.apply.items).toEqual([
      { productId: CREAM, quantity: 5, unitPrice: 58 },
      { productId: SOAP, quantity: 2, unitPrice: 10 },
    ]);
    expect(r.apply.gifts).toEqual([2, 0]);
    expect(r.apply.lineIds).toEqual(['l1', 'l2']);
    expect(r.apply.before.cod).toBe(48.5);
    expect(r.apply.after.cod).toBe(70.5);
    expect(r.apply.audit).toEqual([
      { productId: CREAM, qtyBefore: 3, qtyAfter: 5, totalBefore: 36, totalAfter: 58, giftBefore: 1, giftAfter: 2 },
    ]);
  });

  it('THE GIFT IS THE ONE THE DECIDER SAW: even where today’s order would not derive it (no offer on this order), and where it would derive another', async () => {
    // no offer on the facts: the engine, asked to guess, would keep the 1 and say «not rescaled»
    const pinned = await plan({ edits: [cream5] });
    expect(pinned.ok && pinned.apply?.gifts).toEqual([2, 0]);
    // the request that fixed NO gift is left to the engine, which keeps what the line holds
    const guessed = await plan({ edits: [{ ...cream5, freeQuantity: undefined }] });
    expect(guessed.ok && guessed.apply?.gifts).toEqual([1, 0]);
    // and a pinned ZERO is a zero, not "unset"
    const none = await plan({ edits: [{ ...cream5, freeQuantity: { from: 1, to: 0 } }] });
    expect(none.ok && none.apply?.gifts).toEqual([0, 0]);
  });

  it('the lines come out in the engine’s own order, whatever order the request named them in', async () => {
    const soap6: ApprovedLineEdit = { lineId: 'l2', quantity: { from: 2, to: 6 }, lineTotal: { from: 10, to: 30 } };
    const r = await plan({ edits: [soap6, cream5] });
    expect(r.ok && r.apply?.lineIds).toEqual(['l1', 'l2']);
    expect(r.ok && r.apply?.items.map((i) => i.productId)).toEqual([CREAM, SOAP]);
  });

  it('a request that changes nothing leaves the lines alone: no rewrite, no new reservation', async () => {
    const same: ApprovedLineEdit = { lineId: 'l1', quantity: { from: 3, to: 3 } };
    const r = await plan({ edits: [same] });
    expect(r).toEqual({ ok: true, apply: null });
  });

  it('a request with no lines and no shorthand is not this plan’s business — and reads nothing', async () => {
    expect(await plan()).toEqual({ ok: true, apply: null });
    expect(readOrderEditFacts).not.toHaveBeenCalled();
  });

  it('the discount the same request sets is part of the judgement: over the new total it is refused, not trimmed', async () => {
    const r = await plan({ edits: [{ lineId: 'l1', quantity: { from: 3, to: 1 }, lineTotal: { from: 36, to: 12 } }], discountAmount: 40 });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'DISCOUNT_EXCEEDS_TOTAL' });
  });
});

describe('Ⅲb · what a line keeps of its reservation', () => {
  it('a price alone moves no line’s units: every line keeps exactly the stock it holds', async () => {
    const r = await plan({ edits: [{ lineId: 'l1', lineTotal: { from: 36, to: 40 } }] });
    expect(r.ok && r.apply?.keepReserved).toEqual([4, 2]);
  });

  it('a quantity moves that line only: the other keeps its reservation', async () => {
    const r = await plan({ edits: [cream5] });
    expect(r.ok && r.apply?.keepReserved).toEqual([null, 2]);
  });

  it('a gift alone moves the units too (they are reserved like any unit)', async () => {
    const r = await plan({ edits: [{ lineId: 'l1', freeQuantity: { from: 1, to: 2 } }] });
    expect(r.ok && r.apply?.keepReserved).toEqual([null, 2]);
  });

  it('a swap of product moves it', async () => {
    const r = await plan({ edits: [{ lineId: 'l2', productId: { from: SOAP, to: DROPS }, lineTotal: { from: 10, to: 17 } }] });
    expect(r.ok && r.apply?.keepReserved).toEqual([4, null]);
  });
});

describe('Ⅳ · and it is refused — whole, with a code — when the order is not what the decision was about', () => {
  it('LINES_STALE: the line the request names is not there as it was', async () => {
    readOrderEditFacts.mockResolvedValue(factsOf({ lines: [line({ id: 'l1', quantity: 4, freeQuantity: 1, lineTotal: 48 }), l2()] }));
    expect(await plan({ edits: [cream5] })).toMatchObject({ ok: false, status: 409, code: 'LINES_STALE' });
  });

  it('TOTAL_CHANGED: the total the decider was shown is no longer what the lines come to', async () => {
    // somebody added a 4.000 add-on after the approval: 70.5 is now 74.5
    readOrderEditFacts.mockResolvedValue(factsOf({ addOns: [{ productId: DROPS, quantity: 1, price: 4 }], shipmentCod: 52.5 }, { storedTotal: 52.5 }));
    expect(await plan({ edits: [cream5], snapshot: { after: { cod: 70.5 } } })).toMatchObject({ ok: false, status: 409, code: 'TOTAL_CHANGED' });
    // …and the same order, with the total the decider saw, goes through
    expect((await plan({ edits: [cream5], snapshot: { after: { cod: 74.5 } } })).ok).toBe(true);
    // no snapshot recorded: nothing to compare
    expect((await plan({ edits: [cream5], snapshot: null })).ok).toBe(true);
  });

  it('FEE_SOURCE_DRIFT: two delivery fees on one order', async () => {
    readOrderEditFacts.mockResolvedValue(factsOf({}, { deliveryFee: 3.5 }));
    expect(await plan({ edits: [cream5] })).toMatchObject({ ok: false, status: 409, code: 'FEE_SOURCE_DRIFT' });
  });

  it('COD_DRIFT: the stored total is not the lines’ total', async () => {
    readOrderEditFacts.mockResolvedValue(factsOf({}, { storedTotal: 50 }));
    expect(await plan({ edits: [cream5] })).toMatchObject({ ok: false, status: 409, code: 'COD_DRIFT' });
  });

  it('STATEMENT_LINKED: a courier statement writes the money', async () => {
    readOrderEditFacts.mockResolvedValue(factsOf({}, { statementLinked: true }));
    expect(await plan({ edits: [cream5] })).toMatchObject({ ok: false, status: 409, code: 'STATEMENT_LINKED' });
  });

  it('LINES_COMMITTED: a line that was delivered or returned is a record', async () => {
    readOrderEditFacts.mockResolvedValue(factsOf({ lines: [l1(), { ...l2(), deliveredQty: 1 }] }));
    expect(await plan({ edits: [cream5] })).toMatchObject({ ok: false, status: 409, code: 'LINES_COMMITTED' });
  });

  it('CANCEL_AND_REORDER: the company holds the parcel — its goods are not edited from here', async () => {
    readOrderEditFacts.mockResolvedValue(factsOf({}, { handed: true }));
    const r = await plan({ edits: [cream5] });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'CANCEL_AND_REORDER' });
    expect(!r.ok && r.error).toContain('ألغِ الطلب');
  });

  it('PRODUCT_INACTIVE: a product swapped in has been switched off since (a warning for a draft, a stop for a decision)', async () => {
    readOrderEditFacts.mockResolvedValue(
      factsOf({ products: [{ id: CREAM, name: 'كريم', basePrice: 12, status: 'ACTIVE' }, { id: SOAP, name: 'صابون', basePrice: 5, status: 'ACTIVE' }, { id: DROPS, name: 'قطرة', basePrice: 8.5, status: 'INACTIVE' }] })
    );
    const swap: ApprovedLineEdit = { lineId: 'l2', productId: { from: SOAP, to: DROPS }, lineTotal: { from: 10, to: 17 } };
    expect(await plan({ edits: [swap] })).toMatchObject({ ok: false, status: 409, code: 'PRODUCT_INACTIVE' });
  });

  it('a product that is not in the company at all is a 404', async () => {
    const swap: ApprovedLineEdit = { lineId: 'l2', productId: { from: SOAP, to: 'prod-gone-000099' }, lineTotal: { from: 10, to: 17 } };
    expect(await plan({ edits: [swap] })).toMatchObject({ ok: false, status: 404 });
  });

  it('ZERO_PRICE: a paid line at nothing is not a gift', async () => {
    const free: ApprovedLineEdit = { lineId: 'l2', quantity: { from: 2, to: 2 }, lineTotal: { from: 10, to: 0 } };
    expect(await plan({ edits: [free] })).toMatchObject({ ok: false, status: 409, code: 'ZERO_PRICE' });
  });

  it('STOCK_SHORT: the shelf cannot give what the lines need, and says which product', async () => {
    // 5 + 2 gift = 7 against 4 on the shelf, and the order held 4 before
    readOrderEditFacts.mockResolvedValue(factsOf({ available: { [CREAM]: 4, [SOAP]: 20 } }));
    const r = await plan({ edits: [cream5] });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'STOCK_SHORT' });
    expect(!r.ok && r.error).toContain('كريم');
  });

  it('…but a country that lets stock go negative is told, not stopped', async () => {
    readOrderEditFacts.mockResolvedValue(factsOf({ available: { [CREAM]: 4, [SOAP]: 20 }, allowNegativeStock: true }));
    expect((await plan({ edits: [cream5] })).ok).toBe(true);
  });
});

describe('Ⅴ · the old shorthand, translated — only for an order of exactly one line', () => {
  const oneLine = () =>
    factsOf({ lines: [line({ id: 'only', quantity: 3, freeQuantity: 0, lineTotal: 36, reservedQty: 3 })] }, { storedTotal: 38.5, shippingCost: 2.5 });

  it('a quantity: the piece price is kept — 36 for three is 60 for five', async () => {
    readOrderEditFacts.mockResolvedValue({ ...oneLine(), shipmentCod: 38.5 });
    const r = await plan({ flat: { quantity: 5 } });
    expect(r.ok && r.apply?.items).toEqual([{ productId: CREAM, quantity: 5, unitPrice: 60 }]);
    expect(r.ok && r.apply?.after.cod).toBe(62.5);
  });

  it('a price: taken as the line’s total for the quantity it has', async () => {
    readOrderEditFacts.mockResolvedValue({ ...oneLine(), shipmentCod: 38.5 });
    const r = await plan({ flat: { sellingPrice: 30 } });
    expect(r.ok && r.apply?.items).toEqual([{ productId: CREAM, quantity: 3, unitPrice: 30 }]);
  });

  it('a price is a price because it is THERE: «keep it at 50» beside a quantity of six asks for 50, not 100', async () => {
    readOrderEditFacts.mockResolvedValue({
      ...factsOf({ lines: [line({ id: 'only', quantity: 3, freeQuantity: 0, lineTotal: 50, reservedQty: 3 })] }, { storedTotal: 52.5 }),
      shipmentCod: 52.5,
    });
    const r = await plan({ flat: { quantity: 6, sellingPrice: 50 } });
    expect(r.ok && r.apply?.items).toEqual([{ productId: CREAM, quantity: 6, unitPrice: 50 }]);
    expect(r.ok && r.apply?.after.cod).toBe(52.5);
    // …and without the price it is the piece price: 50 for three is 100 for six
    const scaled = await plan({ flat: { quantity: 6 } });
    expect(scaled.ok && scaled.apply?.items[0].unitPrice).toBe(100);
  });

  it('THE GIFT IS PINNED TO WHAT THE LINE HOLDS: 3 → 6 on a line priced by a live «3 + 1» does not earn a free unit nobody approved', async () => {
    const offer = { id: 'o', productId: CREAM, name: '3 + 1', quantity: 3, freeQuantity: 1, listPrice: 25, price: 25, live: true };
    readOrderEditFacts.mockResolvedValue({
      ...factsOf({ lines: [line({ id: 'only', quantity: 3, freeQuantity: 1, lineTotal: 25, reservedQty: 4 })], orderOffer: offer, offers: [offer] }, { storedTotal: 27.5 }),
      shipmentCod: 27.5,
    });
    const r = await plan({ flat: { quantity: 6 } });
    expect(r.ok && r.apply?.gifts).toEqual([1]);
    // the new request shape, where the decider saw the gift, is the one that derives it
    const lines = await plan({ edits: [{ lineId: 'only', quantity: { from: 3, to: 6 }, lineTotal: { from: 25, to: 50 }, freeQuantity: { from: 1, to: 2 } }] });
    expect(lines.ok && lines.apply?.gifts).toEqual([2]);
  });

  it('…and on a swap to ANOTHER product the old product’s gift is not carried across', async () => {
    readOrderEditFacts.mockResolvedValue({
      ...factsOf({ lines: [line({ id: 'only', quantity: 3, freeQuantity: 1, lineTotal: 36, reservedQty: 4 })] }, { storedTotal: 38.5 }),
      shipmentCod: 38.5,
    });
    const r = await plan({ flat: { productId: SOAP } });
    expect(r.ok && r.apply?.gifts).toEqual([0]);
  });

  it('with TWO lines it is left to the older rules (and their refusals): the plan answers «not mine»', async () => {
    expect(await plan({ flat: { quantity: 5 } })).toEqual({ ok: true, apply: null });
  });

  it('with NO line rows it is left to the older rules too', async () => {
    readOrderEditFacts.mockResolvedValue(factsOf({ lines: [] }));
    expect(await plan({ flat: { quantity: 5 } })).toEqual({ ok: true, apply: null });
  });
});

/* ─────────────────────────── 4 · what a «no» says ─────────────────────────── */

describe('Ⅵ · every refusal is a code and an Arabic sentence', () => {
  const p = (code: Problem['code'], blocking = true, detail?: Problem['detail']): Problem => ({ code, blocking, messageAr: `جملة ${code}`, detail });

  it('maps each blocking problem to one code and status', () => {
    expect(refusalOf([p('UNKNOWN_LINE')])).toMatchObject({ status: 409, code: 'LINES_STALE' });
    expect(refusalOf([p('LINE_SETTLED')])).toMatchObject({ status: 409, code: 'LINES_COMMITTED' });
    expect(refusalOf([p('PARCEL_HANDED')])).toMatchObject({ status: 409, code: 'CANCEL_AND_REORDER' });
    expect(refusalOf([p('PRODUCT_UNAVAILABLE')])).toMatchObject({ status: 404 });
    expect(refusalOf([p('DISCOUNT_EXCEEDS_TOTAL')])).toMatchObject({ status: 400 });
    expect(refusalOf([p('STOCK_SHORT_BLOCKED', true, { name: 'كريم' })])).toMatchObject({ status: 409, code: 'STOCK_SHORT' });
    expect(refusalOf([p('FEE_SOURCE_DRIFT')])).toMatchObject({ status: 409, code: 'FEE_SOURCE_DRIFT', error: 'جملة FEE_SOURCE_DRIFT' });
  });

  it('a warning stops nothing — except a product switched off, which a decision cannot carry', () => {
    expect(refusalOf([p('OFFER_ENDED', false), p('GIFT_NOT_RESCALED', false), p('STOCK_ALREADY_SHORT', false)])).toBeNull();
    expect(refusalOf([p('PRODUCT_INACTIVE', false)])).toMatchObject({ code: 'PRODUCT_INACTIVE' });
    expect(refusalOf([])).toBeNull();
  });

  it('a blocking problem is preferred to the switched-off product', () => {
    expect(refusalOf([p('PRODUCT_INACTIVE', false), p('FEE_SOURCE_DRIFT')])).toMatchObject({ code: 'FEE_SOURCE_DRIFT' });
  });

  it('the total the decider saw is compared to half a minor unit', () => {
    expect(totalMoved({ after: { cod: 70.5 } }, 70.5004, 3)).toBe(false);
    expect(totalMoved({ after: { cod: 70.5 } }, 70.502, 3)).toBe(true);
    expect(totalMoved(null, 70.5, 3)).toBe(false);
    expect(totalMoved({ before: { cod: 1 } }, 70.5, 3)).toBe(false);
  });
});

/* ─────────────────────────── 5 · the shelf at the write ─────────────────────────── */

describe('Ⅶ · the shelf is asked per PRODUCT — RV400, closed the stricter way', () => {
  const ask = (over: Partial<Parameters<typeof blockedByStock>[1]> = {}) =>
    blockedByStock({} as never, {
      companyId: 'c1',
      orderId: 'o1',
      stored: [line({ id: 'a', quantity: 2, lineTotal: 24, reservedQty: 2 }), line({ id: 'b', quantity: 3, lineTotal: 36, reservedQty: 3 })],
      next: [
        { productId: CREAM, quantity: 3, freeQuantity: 0 },
        { productId: CREAM, quantity: 4, freeQuantity: 0 },
      ],
      addOns: [],
      names: new Map([[CREAM, 'كريم']]),
      allowNegativeStock: false,
      ...over,
    });

  it('a product on two lines of 3 and 4 against a shelf of 5: each fits ALONE, together they do not — blocked', async () => {
    availableStock.mockResolvedValue(5);
    expect(await ask()).toEqual(['كريم']);
  });

  it('the same two lines against a shelf of 7: fine', async () => {
    availableStock.mockResolvedValue(7);
    expect(await ask()).toEqual([]);
  });

  it('an order that was ALREADY short is not stopped by a gap that did not grow', async () => {
    availableStock.mockResolvedValue(3);
    // before 2 + 3 = 5 against 3; after 3 + 0... 5 against 3 again
    expect(await ask({ next: [{ productId: CREAM, quantity: 2, freeQuantity: 0 }, { productId: CREAM, quantity: 3, freeQuantity: 0 }] })).toEqual([]);
    // one more missing unit is
    expect(await ask({ next: [{ productId: CREAM, quantity: 2, freeQuantity: 0 }, { productId: CREAM, quantity: 4, freeQuantity: 0 }] })).toEqual(['كريم']);
  });

  it('where the country lets stock go negative the shortage is let through', async () => {
    availableStock.mockResolvedValue(1);
    expect(await ask({ allowNegativeStock: true })).toEqual([]);
  });

  it('the gift and the add-ons the customer accepted are units on the shelf too', async () => {
    availableStock.mockResolvedValue(5);
    // 3 + 1 gift = 4 fits 5; with 2 add-ons of the same product it is 6
    const lines = [{ productId: CREAM, quantity: 3, freeQuantity: 1 }];
    const stored = [line({ id: 'a', quantity: 2, lineTotal: 24, reservedQty: 2 })];
    expect(await ask({ stored, next: lines })).toEqual([]);
    expect(await ask({ stored, next: lines, addOns: [{ productId: CREAM, quantity: 2 }] })).toEqual(['كريم']);
  });

  it('asks twelve products five at a time — not one after another, and not all at once', async () => {
    let live = 0;
    let peak = 0;
    availableStock.mockImplementation(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 1));
      live -= 1;
      return 100;
    });
    const ids = Array.from({ length: 12 }, (_, i) => `prod-${i}-0000000`);
    const blocked = await ask({ stored: [], next: ids.map((productId) => ({ productId, quantity: 1, freeQuantity: 0 })) });
    expect(blocked).toEqual([]);
    expect(availableStock).toHaveBeenCalledTimes(12);
    expect(peak).toBe(5);
  });

  it('asks the shelf with THIS order left out of what is held elsewhere', async () => {
    availableStock.mockResolvedValue(100);
    await ask();
    expect(availableStock.mock.calls[0].slice(1)).toEqual(['c1', CREAM, 'o1']);
  });
});

/* ─────────────────────────── 6 · the race, and the cost ─────────────────────────── */

describe('Ⅷ · the rows at the write are the rows the plan read', () => {
  const rows = (over: Partial<{ id: string; productId: string; quantity: number; freeQuantity: number }>[] = []) =>
    [l1(), l2()].map((s, i) => ({ id: s.id, productId: s.productId, quantity: s.quantity, freeQuantity: s.freeQuantity, ...(over[i] ?? {}) }));

  it('the same rows: yes', () => expect(linesAreStill(rows(), [l1(), l2()])).toBe(true));
  it('a line added since: no', () => expect(linesAreStill([...rows(), { id: 'l3', productId: DROPS, quantity: 1, freeQuantity: 0 }], [l1(), l2()])).toBe(false));
  it('a line gone: no', () => expect(linesAreStill(rows().slice(0, 1), [l1(), l2()])).toBe(false));
  it('a quantity changed: no', () => expect(linesAreStill(rows([{ quantity: 4 }]), [l1(), l2()])).toBe(false));
  it('a gift changed: no', () => expect(linesAreStill(rows([{ freeQuantity: 2 }]), [l1(), l2()])).toBe(false));
  it('a product changed: no', () => expect(linesAreStill(rows([{ productId: DROPS }]), [l1(), l2()])).toBe(false));
  it('a line that took another id (a save in between): no', () => expect(linesAreStill(rows([{ id: 'x' }]), [l1(), l2()])).toBe(false));
});

describe('Ⅸ · what the goods cost: an estimate by the share of the units, moved by the lines that moved', () => {
  const avg = (id: string) => ({ [CREAM]: 2.5, [SOAP]: 7, [DROPS]: 0 })[id] ?? 0;
  const entry = (over: Partial<LineAuditEntry>): LineAuditEntry => ({
    productId: CREAM, qtyBefore: 3, qtyAfter: 5, totalBefore: 36, totalAfter: 58, giftBefore: 1, giftAfter: 2, ...over,
  });
  const cost = (...a: Parameters<typeof costAfterEdit>) => costAfterEdit(...a).cost;

  it('MORE units go on at today’s average: 3 (+1) → 5 (+2) of the cream is three more at 2.500, on the 20 it had', () => {
    // the order holds 6 units (cream 4, soap 2): the soap’s share is in the 20 and nobody is touching it
    expect(cost(20, 6, [entry({})], avg, 3)).toBe(27.5);
  });

  it('a line nobody touched is not in the list, so its share of the old figure stands', () => {
    expect(cost(20, 6, [], avg, 3)).toBe(20);
  });

  it('a price alone moves no units, so it moves no cost', () => {
    expect(costAfterEdit(20, 6, [entry({ qtyAfter: 3, giftAfter: 1, totalAfter: 40 })], avg, 3)).toEqual({ cost: 20, kept: false });
  });

  it('(أ) FEWER units come off at the ORDER’S OWN average, not today’s: 3 → 1 on a cost of 12 (4 a unit) with today’s average at 9 leaves 4, not nothing', () => {
    const nine = () => 9;
    // the old way: 12 + 9 × 1 − 9 × 3 = −6 → cut to 0, with a unit still on the order (profit inflated)
    expect(cost(12, 3, [entry({ qtyBefore: 3, giftBefore: 0, qtyAfter: 1, giftAfter: 0 })], nine, 3)).toBe(4);
  });

  it('…and taking every unit off leaves nothing, never less', () => {
    expect(cost(12, 3, [entry({ qtyBefore: 3, giftBefore: 0, qtyAfter: 0, giftAfter: 0 })], avg, 3)).toBe(0);
    expect(cost(5, 3, [entry({ qtyBefore: 3, giftBefore: 0, qtyAfter: 0, giftAfter: 0 }), entry({ productId: SOAP, qtyBefore: 3, giftBefore: 0, qtyAfter: 0, giftAfter: 0 })], avg, 3)).toBe(0);
  });

  it('(ب) A SWAP takes the old line’s share off by the share and puts the new product on at its own average — whatever the old product’s average is today', () => {
    // 3 units, cost 12; the old product (DROPS) has no batch now (average 0); the new one (SOAP) averages 7 → 12 − 12 + 3 × 7
    const swap = entry({ productId: SOAP, productBefore: DROPS, qtyBefore: 3, giftBefore: 0, qtyAfter: 3, giftAfter: 0 });
    expect(cost(12, 3, [swap], avg, 3)).toBe(21);
    // the old way left the old cost standing and added the new one beside it: 12 + 21 − 0 = 33
    expect(cost(12, 3, [swap], avg, 3)).not.toBe(33);
  });

  it('a swap to a product with no batch either does not double: the order’s own average stands in', () => {
    const swap = entry({ productId: DROPS, productBefore: CREAM, qtyBefore: 3, giftBefore: 0, qtyAfter: 3, giftAfter: 0 });
    expect(cost(12, 3, [swap], () => 0, 3)).toBe(12);
  });

  it('MORE units of a product with no batch now go on at the order’s own average', () => {
    // 4 units cost 20 (5 a unit); three more of a product with no batch → 20 + 3 × 5
    expect(cost(20, 4, [entry({ productId: DROPS, qtyBefore: 1, giftBefore: 0, qtyAfter: 4, giftAfter: 0 })], avg, 3)).toBe(35);
  });

  it('(ج) A COST THAT IS NOT KNOWN IS NOT INVENTED: struck at nothing, it stays nothing — and says it was kept, only when a unit really moved', () => {
    expect(costAfterEdit(0, 6, [entry({})], avg, 3)).toEqual({ cost: 0, kept: true });
    expect(costAfterEdit(0, 0, [entry({})], avg, 3)).toEqual({ cost: 0, kept: true });
    // a price alone moved nothing: nothing to say
    expect(costAfterEdit(0, 6, [entry({ qtyAfter: 3, giftAfter: 1 })], avg, 3)).toEqual({ cost: 0, kept: false });
  });

  it('is rounded at the currency’s own unit', () => {
    const third = () => 0.3333;
    const more = [entry({ qtyBefore: 0, giftBefore: 0, qtyAfter: 7, giftAfter: 0 })];
    expect(cost(1, 1, more, third, 2)).toBe(3.33);
    expect(cost(1, 1, more, third, 0)).toBe(3);
  });

  it('names the products it needs the averages of: what the changed lines were and became, once each', () => {
    expect(costProductIds([entry({}), entry({ productId: SOAP, productBefore: CREAM })]).sort()).toEqual([CREAM, SOAP].sort());
  });

  /*
   * THE OWNER'S FIXED COST (1/11: «ثابت لكل الطلبات»). `fixedOf` answers a product's figure — ZERO included — and wins over the
   * average for the units that GO ON. The units that come off still come off at the order's own average. With no `fixedOf` at all
   * (every caller before this) nothing above changes.
   */
  describe('Ⅸb · with a fixed figure for a product', () => {
    const figure = (rows: Record<string, number>) => (id: string) => rows[id];
    const more = [entry({})]; // cream 3 (+1) → 5 (+2): three more units

    it('MORE units go on at the FIGURE, not at today’s average: three more at 4 on the 20 it had is 32 (the average said 2.5 → 27.5)', () => {
      expect(costAfterEdit(20, 6, more, avg, 3, figure({ [CREAM]: 4 })).cost).toBe(32);
      expect(costAfterEdit(20, 6, more, avg, 3).cost).toBe(27.5);
    });

    it('ZERO is a figure: three more units of an item that costs nothing add nothing — not the average (2.5), not the order’s own (20 ÷ 6)', () => {
      expect(costAfterEdit(20, 6, more, avg, 3, figure({ [CREAM]: 0 })).cost).toBe(20);
      // …where an average of 0 (no batch now) is «not known», and the order’s own stands in:
      expect(costAfterEdit(20, 6, more, () => 0, 3).cost).toBeCloseTo(20 + (20 / 6) * 3, 3);
    });

    it('a figure beats a product with NO batch now: the order’s own average does not stand in for it', () => {
      expect(costAfterEdit(20, 6, more, () => 0, 3, figure({ [CREAM]: 4 })).cost).toBe(32);
    });

    it('the figure of ANOTHER product moves nothing, and a line nobody touched keeps its share', () => {
      expect(costAfterEdit(20, 6, more, avg, 3, figure({ [SOAP]: 9 })).cost).toBe(27.5);
      expect(costAfterEdit(20, 6, [], avg, 3, figure({ [CREAM]: 4, [SOAP]: 9 })).cost).toBe(20);
    });

    it('FEWER units still come off at the ORDER’S OWN average — a figure is for the units that go on: 12 over 3 units, 3 → 1, at a figure of 9, is 4', () => {
      const fewer = [entry({ qtyBefore: 3, giftBefore: 0, qtyAfter: 1, giftAfter: 0 })];
      expect(costAfterEdit(12, 3, fewer, avg, 3, figure({ [CREAM]: 9 })).cost).toBe(4);
    });

    it('A SWAP puts the new product on at ITS figure and takes the old line off at the order’s own: soap → drops at 7, 3 units on 12, is 12 − 12 + 21', () => {
      const swap = entry({ productId: DROPS, productBefore: SOAP, qtyBefore: 3, giftBefore: 0, qtyAfter: 3, giftAfter: 0 });
      expect(costAfterEdit(12, 3, [swap], avg, 3, figure({ [DROPS]: 7 })).cost).toBe(21);
      // with no figure DROPS has no batch (average 0): the order’s own stands in — nothing moves
      expect(costAfterEdit(12, 3, [swap], avg, 3).cost).toBe(12);
    });

    it('a cost struck at nothing is NOT invented even where a figure exists — it stays nothing and says it was kept', () => {
      expect(costAfterEdit(0, 6, more, avg, 3, figure({ [CREAM]: 4 }))).toEqual({ cost: 0, kept: true });
    });

    it('rounds at the currency’s own unit: three more at 1.11117 on 20 is 23.33351 → 23.334 (three places), 23.33 (two)', () => {
      expect(costAfterEdit(20, 6, more, avg, 3, figure({ [CREAM]: 1.11117 })).cost).toBe(23.334);
      expect(costAfterEdit(20, 6, more, avg, 2, figure({ [CREAM]: 1.11117 })).cost).toBe(23.33);
    });
  });
});

describe('Ⅹ · the plan adds no arithmetic of its own', () => {
  it('prices nothing: no computeCod, no allocateDiscount, no toFixed in the file', () => {
    const src = stripComments(repoFile('src/lib/order-line-apply.ts'));
    expect(src).not.toMatch(/computeCod\(|allocateDiscount\(|toFixed\(/);
  });

  it('writes nothing: no row is created, updated or deleted from it', () => {
    const src = stripComments(repoFile('src/lib/order-line-apply.ts'));
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });
});
