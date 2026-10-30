import { describe, expect, it } from 'vitest';
import { expandApproved } from './change-request-apply';
import { readLinesChange } from './change-request-fields';
import {
  blockingRefusal,
  draftFromRaised,
  flatGoodsIn,
  raisedLinesSchema,
  readsBack,
  splitLinesKey,
  storedLinesFrom,
} from './change-request-raise-lines';
import { bindApprovedEdits, totalMoved } from './order-line-apply';
import {
  previewDraftSchema,
  previewLineEdit,
  type LineEditInput,
  type OrderEditFacts,
  type Problem,
  type StoredLine,
} from './order-line-edit';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PIECES OF RAISING A LINES REQUEST, each asked on its own.
 *
 * The route test holds the door; this holds what the door is made of — and, last, that what is written is something the
 * APPLY side can use: a line found again after a save gave it a new id, and a total that is still the one shown.
 * ═══════════════════════════════════════════════════════════════════════
 */

const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';

const line = (over: Partial<StoredLine> & { id: string }): StoredLine => ({
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

const facts = (): OrderEditFacts => ({
  minorUnit: 3,
  allowNegativeStock: false,
  order: {
    confirmed: true, closed: false, handed: false, labelled: false, statementLinked: false,
    priceIncludesDelivery: false, storedTotal: 48.5, shippingCost: 2.5, deliveryFee: null, discount: 0, version: 4,
  },
  lines: [line({ id: 'a' }), line({ id: 'b', productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10, reservedQty: 2 })],
  addOns: [],
  products: [
    { id: CREAM, name: 'كريم', basePrice: 12, status: 'ACTIVE' },
    { id: SOAP, name: 'صابون', basePrice: 5, status: 'ACTIVE' },
  ],
  offers: [],
  orderOffer: null,
  available: { [CREAM]: 50, [SOAP]: 50 },
  shipmentCod: 48.5,
  customer: { phoneInvalid: false, altPhoneInvalid: false, phoneDuplicate: false, regionOutsideCountry: false, regionFee: null },
});

const raised = (edits: unknown[]) => {
  const parsed = raisedLinesSchema.safeParse({ v: 2, edits });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message);
  return parsed.data;
};

/** The request exactly as the route makes it: parse, draft, preview, store. */
const raiseOver = (f: OrderEditFacts, edits: unknown[]) => {
  const r = raised(edits);
  const draft = previewDraftSchema.parse(draftFromRaised(r, {}));
  const preview = previewLineEdit(f, draft);
  return { preview, stored: storedLinesFrom(preview, new Set(r.edits.map((e) => e.lineId))) };
};

describe('splitLinesKey — `lines` leaves the body before the old schema reads it', () => {
  it('takes it out of `changes` and leaves the rest of the body exactly as it was', () => {
    const body = { reason: 'سبب التعديل', changes: { customerName: { to: 'x' }, lines: { v: 2 } }, blocking: true };
    const { rest, lines } = splitLinesKey(body);

    expect(lines).toEqual({ v: 2 });
    expect(rest).toEqual({ reason: 'سبب التعديل', changes: { customerName: { to: 'x' } }, blocking: true });
    // the body it was given is not touched
    expect(body.changes).toHaveProperty('lines');
  });

  it.each([
    ['no changes', { reason: 'x' }],
    ['changes without the key', { changes: { customerName: { to: 'x' } } }],
    ['a body that is not an object', 'x'],
    ['null', null],
    ['an array', []],
    ['changes that are an array', { changes: [1] }],
  ])('%s: nothing taken, the body returned as it is', (_name, body) => {
    const out = splitLinesKey(body);
    expect(out.lines).toBeUndefined();
    expect(out.rest).toBe(body);
  });

  it('a key that is present but null is PRESENT: it is judged, not skipped', () => {
    expect(splitLinesKey({ changes: { lines: null } }).lines).toBeNull();
  });
});

describe('raisedLinesSchema — what a browser may say', () => {
  it('drops a «from», a gift and a snapshot: they are not names it knows', () => {
    const parsed = raisedLinesSchema.parse({
      v: 2,
      edits: [{ lineId: 'a', quantity: { from: 9, to: 5 }, freeQuantity: { to: 3 }, productId: { from: 'zzzzzzzzzzzz', to: CREAM } }],
      snapshot: { after: { cod: 1 } },
    });
    expect(parsed.edits[0].quantity).toEqual({ to: 5 });
    expect(parsed.edits[0]).not.toHaveProperty('freeQuantity');
    expect(parsed.edits[0].productId).toEqual({ to: CREAM });
    expect(parsed).not.toHaveProperty('snapshot');
  });

  it('twenty lines at most, a line named once, a quantity of at least one', () => {
    const twenty = Array.from({ length: 20 }, (_v, i) => ({ lineId: `l${i}`, quantity: { to: 2 } }));
    expect(raisedLinesSchema.safeParse({ v: 2, edits: twenty }).success).toBe(true);
    expect(raisedLinesSchema.safeParse({ v: 2, edits: [...twenty, { lineId: 'extra', quantity: { to: 2 } }] }).success).toBe(false);
    expect(raisedLinesSchema.safeParse({ v: 2, edits: [twenty[0], twenty[0]] }).success).toBe(false);
    expect(raisedLinesSchema.safeParse({ v: 2, edits: [{ lineId: 'a', quantity: { to: 0 } }] }).success).toBe(false);
    expect(raisedLinesSchema.safeParse({ v: 3, edits: twenty }).success).toBe(false);
  });
});

describe('draftFromRaised — the same words as the preview', () => {
  it('turns `{ to }` into the values the engine takes, and carries the order’s own fields along', () => {
    const draft = draftFromRaised(
      raised([{ lineId: 'a', quantity: { to: 4 }, unitPrice: { to: 11.5 }, basis: 'MANUAL' }]),
      { discountAmount: { to: 1 }, customerName: { to: 'سامر' }, quantity: { to: 99 } }
    );
    expect(draft).toEqual({
      lines: [{ lineId: 'a', quantity: 4, unitPrice: 11.5, priceBasis: 'MANUAL' }],
      discountAmount: 1,
      customerName: 'سامر',
    });
  });
});

describe('flatGoodsIn — the shorthand that may not ride beside the lines', () => {
  it('names each of the three, and none of the others', () => {
    expect(flatGoodsIn({ quantity: { to: 1 }, sellingPrice: { to: 1 }, customerName: { to: 'x' } })).toEqual(['quantity', 'sellingPrice']);
    expect(flatGoodsIn({ productId: { to: 'x' } })).toEqual(['productId']);
    expect(flatGoodsIn({ discountAmount: { to: 1 }, customerNotes: { to: 'x' } })).toEqual([]);
    expect(flatGoodsIn(undefined)).toEqual([]);
  });
});

describe('storedLinesFrom — written from the preview, and readable by the apply side', () => {
  it('only the lines that were edited AND changed are written, each with its whole record', () => {
    const { stored } = raiseOver(facts(), [
      { lineId: 'a', quantity: { to: 5 } },
      { lineId: 'b', quantity: { to: 2 } }, // as it was
    ]);

    expect(stored?.edits.map((e) => e.lineId)).toEqual(['a']);
    expect(stored?.edits[0]).toMatchObject({
      productId: { from: CREAM, to: CREAM },
      quantity: { from: 3, to: 5 },
      lineTotal: { from: 36, to: 60 },
      freeQuantity: { from: 0, to: 0 },
    });
  });

  it('nothing changed → null: a request never carries a line that asks for nothing', () => {
    expect(raiseOver(facts(), [{ lineId: 'a', quantity: { to: 3 } }]).stored).toBeNull();
  });

  it('the snapshot carries the total the decider is shown, the order the lines were priced in, and the version', () => {
    const { stored } = raiseOver(facts(), [{ lineId: 'b', quantity: { to: 4 } }]);
    const snap = stored?.snapshot as Record<string, any>;

    // soap 5.000 × 4 = 20; 36 + 20 + 2.5
    expect(snap.after.cod).toBe(58.5);
    expect(snap.before.cod).toBe(48.5);
    expect(snap.lineOrder).toEqual(['a', 'b']);
    expect(snap.orderVersion).toBe(4);
    expect(snap.minorUnit).toBe(3);
  });

  it('reads back through the apply side’s own schema; a total that is not a number does not', () => {
    const { stored } = raiseOver(facts(), [{ lineId: 'a', quantity: { to: 5 } }]);
    expect(stored && readsBack(stored)).toBeNull();
    expect(readLinesChange({ lines: stored }).ok).toBe(true);

    if (!stored) throw new Error('expected a request');
    const broken = { ...stored, snapshot: { ...stored.snapshot, after: { cod: Number.NaN } } };
    expect(readsBack(broken)).not.toBeNull();
    const noBefore = { ...stored, edits: [{ ...stored.edits[0], quantity: { to: 5 } }] } as unknown as typeof stored;
    expect(readsBack(noBefore)).toContain('قبل');
  });

  it('a request of this shape is APPROVED-and-expandable: the apply side takes its lines and its snapshot', () => {
    const { stored } = raiseOver(facts(), [{ lineId: 'a', quantity: { to: 5 } }]);
    const out = expandApproved({ id: 'r', orderId: 'o', status: 'APPROVED', appliedAt: null, changes: { customerNotes: { from: null, to: 'x' }, lines: stored }, intent: 'EDIT' });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.lineEdits?.[0].quantity?.to).toBe(5);
      expect(out.linesSnapshot?.after?.cod).toBe(72.5);
    }
  });
});

describe('the round trip: raised here, found and priced again there', () => {
  it('after a save has rewritten the lines with new ids, the request still finds each line by what it recorded', () => {
    const { stored } = raiseOver(facts(), [{ lineId: 'a', quantity: { to: 5 } }]);
    if (!stored) throw new Error('expected a request');

    const rewritten = [line({ id: 'new-1' }), line({ id: 'new-2', productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10 })];
    const bound = bindApprovedEdits(rewritten, stored.edits, 3);
    expect(bound.ok).toBe(true);
    if (bound.ok) expect(bound.bound[0].line.id).toBe('new-1');
  });

  it('and a line that is no longer what was recorded is NOT found — the «before» is what makes the refusal possible', () => {
    const { stored } = raiseOver(facts(), [{ lineId: 'a', quantity: { to: 5 } }]);
    if (!stored) throw new Error('expected a request');

    const moved = [line({ id: 'new-1', quantity: 4, lineTotal: 48 }), line({ id: 'new-2', productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10 })];
    expect(bindApprovedEdits(moved, stored.edits, 3).ok).toBe(false);
  });

  it('priced again from what was stored, the order comes to the total that was shown (and to a different one it does not)', () => {
    const f = facts();
    const { stored } = raiseOver(f, [{ lineId: 'a', quantity: { to: 5 } }, { lineId: 'b', lineTotal: { to: 12 } }]);
    if (!stored) throw new Error('expected a request');

    const again: LineEditInput[] = stored.edits.map((e) => ({
      lineId: e.lineId,
      ...(e.productId ? { productId: e.productId.to } : {}),
      ...(e.quantity ? { quantity: e.quantity.to } : {}),
      ...(e.lineTotal ? { lineTotal: e.lineTotal.to } : {}),
    }));
    const pinned = new Map(stored.edits.flatMap((e) => (e.freeQuantity ? [[e.lineId, e.freeQuantity.to] as const] : [])));
    const priced = previewLineEdit(f, { lines: again }, pinned);

    // 60 + 12 + 2.5
    expect(priced.after.cod).toBe(74.5);
    expect(totalMoved(stored.snapshot, priced.after.cod, 3)).toBe(false);
    expect(totalMoved(stored.snapshot, priced.after.cod + 0.001, 3)).toBe(true);
  });
});

describe('blockingRefusal — the engine’s own sentences', () => {
  const p = (code: Problem['code'], blocking: boolean, messageAr: string): Problem => ({ code, blocking, messageAr });

  it('null when nothing blocks; warnings never refuse', () => {
    expect(blockingRefusal([])).toBeNull();
    expect(blockingRefusal([p('STOCK_SHORT_ALLOWED', false, 'تحذير')])).toBeNull();
  });

  it('names every blocking reason once, in the order given, and none of the warnings', () => {
    const out = blockingRefusal([p('STOCK_SHORT_BLOCKED', true, 'أ'), p('COD_DRIFT', false, 'تحذير'), p('STATEMENT_LINKED', true, 'ب'), p('STOCK_SHORT_BLOCKED', true, 'أ')]);

    expect(out?.error).toBe('أ — ب');
    expect(out?.reasons).toHaveLength(3);
  });
});
