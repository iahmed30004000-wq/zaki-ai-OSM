import { describe, it, expect } from 'vitest';
import {
  CHANGEABLE_FIELDS, CHANGE_FIELD_AR, LINES_FIELD, LINE_PRICE_BASES, MONEY_CHANGE_FIELDS, changeFieldLabel, describeLines,
  readLinesChange, touchesMoney, withFrom, type OrderSnapshot,
} from './change-request-fields';
import { PRICE_BASES } from './order-line-edit';
import { repoFile, stripComments } from './guard-source';

const order: OrderSnapshot = {
  quantity: 2,
  productId: 'p1',
  // The LINE total for the two units, not the price of one.
  sellingPrice: 50,
  discountAmount: 0,
  customerNotes: null,
  regionId: 'region-amman',
  customer: { fullName: 'أحمد', phone: '0791234567', altPhone: null, address: 'عمان، الشميساني', city: 'عمان' },
};

describe('one list of changeable fields', () => {
  it('names every field in Arabic', () => {
    // The dialog and the route kept a list each and they drifted: four of
    // the ten fields reached the person deciding as English code names.
    for (const f of CHANGEABLE_FIELDS) {
      expect(CHANGE_FIELD_AR[f]).toBeTruthy();
      expect(changeFieldLabel(f)).not.toBe(f);
    }
  });

  it('shows an unknown field as itself rather than as nothing', () => {
    expect(changeFieldLabel('somethingNew')).toBe('somethingNew');
  });

  /**
   * A RETIRED FIELD KEEPS ITS NAME.
   *
   * Requests raised before the offer left the list still carry it and are
   * still refused — but the refusal names «العرض», not `offerId`, because
   * the person reading it did not write the code.
   */
  it('still names the fields that were retired, so an old row reads in Arabic', () => {
    expect(CHANGEABLE_FIELDS).not.toContain('offerId');
    expect(changeFieldLabel('offerId')).toBe('العرض');
    expect(changeFieldLabel('customerCity')).toBe('المدينة');
  });

  /**
   * THE PRICE SAYS WHICH PRICE IT IS.
   *
   * `Order.sellingPrice` is the line's total for the quantity, in the order
   * route's own words. A menu entry reading «السعر» would be approved as a
   * discount whenever the person meant «per unit», and the approval applies
   * the number as typed.
   */
  it('says the price is the line total, not the price of one unit', () => {
    expect(CHANGEABLE_FIELDS).toContain('sellingPrice');
    expect(CHANGE_FIELD_AR.sellingPrice).toContain('إجمالي الكمية');
  });
});

/**
 * WHAT THE DIALOG DOES WITH THE LIST.
 *
 * The raise dialog held back two fields, and both reasons are gone: the
 * product now has a searchable picker, and the offer is no longer in the
 * list at all. A field that is askable and never offered is a feature
 * nobody can reach; one that is offered and cannot be applied is the bug
 * the seller reported twice.
 */
describe('the raise dialog offers the whole list', () => {
  const dialog = () => stripComments(repoFile('src/components/screens/confirmation/ActionDialogs.tsx'));

  it('derives its menu from the list with nothing filtered out', () => {
    const src = dialog();
    expect(src.length).toBeGreaterThan(200);
    expect(src).toMatch(/CHANGE_FIELDS = CHANGEABLE_FIELDS\.map\(/);
    expect(src, 'عاد حقلٌ يُحجب عن الشاشة').not.toMatch(/NOT_OFFERED_HERE/);
  });

  it('chooses the product with the shared searchable picker, never a bare list', () => {
    const src = dialog();
    expect(src).toMatch(/field === 'productId' \? \(\s*<ProductPicker/);
    // ONE fetch for the catalogue, and it is the shared hook — two screens
    // had asked for `?limit=200` against a route that caps at 100.
    expect(src).toMatch(/useProducts\(\)/);
  });

  /**
   * THE WHOLE CATALOGUE, NOT THE FIRST HUNDRED.
   *
   * `/api/products` caps `?limit` at 100, and two screens asked it for 200
   * — so past a hundred products the tail of the catalogue was unreachable
   * from them, and a search box over a truncated list answers «لا يوجد»
   * about a product that exists. The shared hook asks for no limit.
   */
  it('fetches the catalogue whole, through the one hook', () => {
    const hook = stripComments(repoFile('src/hooks/useProducts.ts'));
    expect(hook.length).toBeGreaterThan(200);
    // The type it is read into is not the point — the point is one fetch,
    // through the client that redirects on an expired session, with no
    // limit on it. (It is `CatalogueProduct` now: the route always sent
    // `basePrice` and the offers, and three order dialogs were fetching
    // the catalogue again by hand to reach them.)
    expect(hook).toMatch(/apiJson<\{ products: \w+\[\] \}>\('\/api\/products'\)/);
    expect(hook, 'عاد الحدُّ الذي يقصّ آخر الكتالوج').not.toMatch(/limit=/);
  });

  it('will not send an edit with no new value', () => {
    // `required` cannot guard the picker, so the button carries the rule —
    // and it says "not ready", not «جارٍ الحفظ…».
    expect(dialog()).toMatch(/disabled=\{intent === 'EDIT' && !to\.trim\(\)\}/);
  });
});

describe('withFrom — the value BEFORE, taken by the server', () => {
  it('answers "three instead of what?"', () => {
    expect(withFrom(order, { quantity: { to: 3 } })).toEqual({ quantity: { from: 2, to: 3 } });
  });

  it('reads customer fields from the customer', () => {
    expect(withFrom(order, { customerPhone: { to: '0799999999' } })).toEqual({
      customerPhone: { from: '0791234567', to: '0799999999' },
    });
  });

  /**
   * THE GOVERNORATE, NOT THE CITY.
   *
   * The city was free text and the order has no column for it, so every
   * request to change it was accepted, approved, and then refused with
   * «عدّلها يدوياً» — reported as «طلب تعديل: لا يمكن تعديل المدينة».
   * The order ships to a region, and that is what the request carries.
   */
  it('reads the governorate from the order, not the customer’s typed city', () => {
    expect(withFrom(order, { regionId: { to: 'region-zarqa' } })).toEqual({
      regionId: { from: 'region-amman', to: 'region-zarqa' },
    });
    expect(CHANGEABLE_FIELDS).not.toContain('customerCity');
  });

  /**
   * THE LINE TOTAL, TAKEN AS IT STANDS.
   *
   * Dividing it by the quantity here would show the decider «25 ← 60» on an
   * order of two at fifty, and they would approve what looks like a rise
   * when the seller asked for a ten-unit increase on the line. The order
   * route stores the line total; the request shows the line total.
   */
  it('reads the price as the line total, without dividing it by the quantity', () => {
    expect(withFrom(order, { sellingPrice: { to: 60 } })).toEqual({
      sellingPrice: { from: 50, to: 60 },
    });
  });

  it('records an empty before as null, not as a missing key', () => {
    expect(withFrom(order, { customerAltPhone: { to: '0781111111' } })).toEqual({
      customerAltPhone: { from: null, to: '0781111111' },
    });
  });

  it('ignores a "from" the browser sent — it could say anything', () => {
    // The negative test: a requester who claims the quantity was 10 must not
    // be believed. Only the order's own value is recorded.
    const forged = { quantity: { from: 10, to: 3 } } as unknown as Parameters<typeof withFrom>[1];
    expect(withFrom(order, forged)).toEqual({ quantity: { from: 2, to: 3 } });
  });

  it('touches only the fields that were asked for', () => {
    expect(Object.keys(withFrom(order, { customerName: { to: 'محمد' } }))).toEqual(['customerName']);
  });
});

/* ═══════════════════════════ THE LINES KEY (طلب التعديل متعدد الحقول، المرحلة ٤) ═══════════════════════════ */

const cream: Record<string, unknown> = {
  lineId: 'line-1',
  quantity: { from: 3, to: 5 },
  lineTotal: { from: 36, to: 58 },
  freeQuantity: { from: 1, to: 2 },
  basis: 'OFFER',
};
const lines = (over: Record<string, unknown> = {}) => ({ v: 2, edits: [cream], ...over });

describe('the `lines` key of a request', () => {
  it('is a money key: whoever decides a price decides it — even when it is "only a quantity"', () => {
    expect(MONEY_CHANGE_FIELDS).toContain(LINES_FIELD);
    expect(touchesMoney({ lines: lines() })).toBe(true);
    expect(touchesMoney({ lines: lines(), customerNotes: { to: 'x' } })).toBe(true);
    // the negatives: the customer's own fields still need no price key
    expect(touchesMoney({ customerName: { to: 'x' } })).toBe(false);
    expect(touchesMoney(null)).toBe(false);
  });

  it('is NOT in the list a person picks a field from, and is named in Arabic', () => {
    expect(CHANGEABLE_FIELDS).not.toContain(LINES_FIELD);
    expect(changeFieldLabel('lines')).toBe('أسطر الطلب');
  });

  it('speaks the same four words for how a total was reached as the engine does', () => {
    expect([...LINE_PRICE_BASES]).toEqual([...PRICE_BASES]);
  });

  it('is read strictly: the shape or a sentence, never a half-read object', () => {
    const ok = readLinesChange({ lines: lines() });
    expect(ok.ok && ok.value?.edits[0]).toMatchObject({ lineId: 'line-1', quantity: { from: 3, to: 5 }, lineTotal: { to: 58 } });

    const bad = (value: unknown) => readLinesChange({ lines: value });
    expect(bad(lines({ v: 1 })).ok).toBe(false);
    expect(bad({ edits: [cream] }).ok).toBe(false);
    expect(bad(lines({ edits: [] })).ok).toBe(false);
    expect(bad(lines({ edits: Array.from({ length: 21 }, (_, i) => ({ ...cream, lineId: `l${i}` })) })).ok).toBe(false);
    expect(bad(lines({ edits: [cream, { ...cream }] })).ok).toBe(false);
    expect(bad(lines({ edits: [{ lineId: 'line-1' }] })).ok).toBe(false);
    expect(bad(lines({ edits: [{ ...cream, quantity: { from: 3, to: 0 } }] })).ok).toBe(false);
    expect(bad(lines({ edits: [{ ...cream, quantity: { from: 3, to: 2.5 } }] })).ok).toBe(false);
    expect(bad(lines({ edits: [{ ...cream, lineTotal: { from: 36, to: -1 } }] })).ok).toBe(false);
    expect(bad(lines({ edits: [{ ...cream, freeQuantity: { from: 1, to: -1 } }] })).ok).toBe(false);
    expect(bad(lines({ edits: [{ ...cream, basis: 'GUESS' }] })).ok).toBe(false);
    expect(bad('text').ok).toBe(false);
    const sentence = bad(lines({ edits: [] }));
    expect(!sentence.ok && sentence.error).toMatch(/[؀-ۿ]/);
  });

  it('wants a «before» for what a decision is about — the product, the quantity and the line’s total — or it is not this shape', () => {
    const no = (edit: Record<string, unknown>) => readLinesChange({ lines: lines({ edits: [{ lineId: 'a', ...edit }] }) });
    for (const edit of [{ quantity: { to: 5 } }, { lineTotal: { to: 58 } }, { productId: { to: 'prod-soap-00002' } }]) {
      const r = no(edit);
      expect(r.ok, JSON.stringify(edit)).toBe(false);
      expect(!r.ok && r.error).toContain('قبل');
    }
    // with the «before», the same edits are fine; a gift without one is let through (a stale gift shows in the quantity)
    expect(no({ quantity: { from: 3, to: 5 }, lineTotal: { from: 36, to: 58 }, productId: { from: 'prod-cream-0001', to: 'prod-soap-00002' } }).ok).toBe(true);
    expect(no({ freeQuantity: { to: 2 } }).ok).toBe(true);
    // null is not a «before» either
    expect(no({ quantity: { from: null, to: 5 } }).ok).toBe(false);
  });

  it('is absent, not an error, for a request of plain fields — and for a stored value that is not an object', () => {
    expect(readLinesChange({ customerName: { to: 'x' } })).toEqual({ ok: true, value: null });
    expect(readLinesChange(null)).toEqual({ ok: true, value: null });
    expect(readLinesChange('x')).toEqual({ ok: true, value: null });
    expect(readLinesChange({ lines: null })).toEqual({ ok: true, value: null });
  });

  it('keeps what the decider was shown, and lets a later version add to it', () => {
    const r = readLinesChange({ lines: lines({ snapshot: { orderVersion: 12, after: { cod: 62, subtotal: 58 }, stock: [{ productId: 'p', need: 5 }] } }) });
    expect(r.ok && r.value?.snapshot?.after?.cod).toBe(62);
  });

  it('an unknown key inside an edit does not break an old reader', () => {
    const r = readLinesChange({ lines: lines({ edits: [{ ...cream, somethingNew: 1 }] }) });
    expect(r.ok).toBe(true);
  });
});

describe('describeLines — a request in words, one sentence per line', () => {
  it('names the line, and each figure as it was and became', () => {
    const r = readLinesChange({ lines: lines() });
    if (!r.ok || !r.value) throw new Error('expected lines');
    expect(describeLines(r.value, { minorUnit: 3, names: { 'prod-a-0000001': 'كريم' } })).toEqual([
      'سطر 1 — الكمية: 3 ← 5 · إجمالي السطر: 36 ← 58 · الهدية: 1 ← 2',
    ]);
  });

  it('uses the product’s name when it is known, says a swap in words, and flags a typed price', () => {
    const r = readLinesChange({
      lines: lines({
        edits: [{ lineId: 'a', productId: { from: 'prod-cream-0001', to: 'prod-soap-00002' }, lineTotal: { from: 36, to: 17.5 }, basis: 'MANUAL' }],
      }),
    });
    if (!r.ok || !r.value) throw new Error('expected lines');
    const [sentence] = describeLines(r.value, { minorUnit: 2, names: { 'prod-cream-0001': 'كريم', 'prod-soap-00002': 'صابون' } });
    expect(sentence).toBe('كريم — المنتج: كريم ← صابون · إجمالي السطر: 36 ← 17.5 · السعر يدوي');
  });

  it('rounds at the currency’s own unit and prints no JSON and no English', () => {
    const r = readLinesChange({ lines: lines({ edits: [{ lineId: 'a', lineTotal: { from: 25, to: 41.6667 } }] }) });
    if (!r.ok || !r.value) throw new Error('expected lines');
    expect(describeLines(r.value, { minorUnit: 3 })[0]).toContain('41.667');
    expect(describeLines(r.value, { minorUnit: 0 })[0]).toContain('25 ← 42');
    for (const s of describeLines(r.value)) {
      expect(s).not.toMatch(/[{}\[\]"]/);
      expect(s).not.toMatch(/[A-Za-z]{3,}/);
    }
  });

  it('a figure that did not move is not printed — the server records the whole line, and the sentence says what changed', () => {
    const r = readLinesChange({
      lines: lines({
        edits: [
          {
            lineId: 'a',
            productId: { from: 'prod-cream-0001', to: 'prod-cream-0001' },
            quantity: { from: 3, to: 5 },
            lineTotal: { from: 36, to: 60 },
            freeQuantity: { from: 0, to: 0 },
          },
        ],
      }),
    });
    if (!r.ok || !r.value) throw new Error('expected lines');
    expect(describeLines(r.value, { minorUnit: 3, names: { 'prod-cream-0001': 'كريم' } })).toEqual(['كريم — الكمية: 3 ← 5 · إجمالي السطر: 36 ← 60']);
  });

  it('and a line where nothing moved says so instead of ending on a dash', () => {
    const r = readLinesChange({ lines: lines({ edits: [{ lineId: 'a', quantity: { from: 3, to: 3 } }] }) });
    if (!r.ok || !r.value) throw new Error('expected lines');
    expect(describeLines(r.value)[0]).toBe('سطر 1 — بلا تغيير');
  });

  it('a figure with no recorded “before” is shown alone, not as «undefined ← 5» (the gift may lack one; the schema lets it)', () => {
    const r = readLinesChange({ lines: lines({ edits: [{ lineId: 'a', freeQuantity: { to: 2 } }] }) });
    if (!r.ok || !r.value) throw new Error('expected lines');
    expect(describeLines(r.value)[0]).toBe('سطر 1 — الهدية: 2');
  });
});
