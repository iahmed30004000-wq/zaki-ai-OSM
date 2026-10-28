import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * THE CART QUOTES WHAT THE DOOR WILL CHARGE — OR IT IS LYING TO A SHOPPER.
 *
 * `/api/public/stores/[store]/quote` exists for exactly one reason: a cart
 * holds identities and counts, never prices, so the page has to ask the
 * server what the basket costs. Its own file comment promised «the same
 * answer the order will give … called the same way with the same inputs».
 *
 * It was not. Commit 448ba22 taught `createPublicOrder` to pass the offer's
 * `discount` to `computeCod`; this door was not taught. An offer with
 * `sellingPrice: 25`, `discount: 3`, `quantity: 2` and one pick:
 *
 *   the cart said      25
 *   the order charged  22
 *
 * In the customer's favour, which is why nothing screamed — and still a lie,
 * because a cart that disagrees with the waybill is the one number a shopper
 * decides on. The comment claiming parity was the dangerous half: the next
 * reader trusts it and stops looking.
 *
 * WHAT WAS CHECKED BEFORE CHANGING ANYTHING. `discount` is an ABSOLUTE
 * amount, not a percentage — `allocateDiscount` clamps it with
 * `Math.min(discount, subtotal)` and `offers.ts` validates it as
 * `money(1_000_000)`. And it is `basketDiscount` from `public-order.ts` that
 * is imported here, not a second copy of that logic: the dedupe-by-offer-id
 * rule is the behaviour being matched, and two copies of it would agree on
 * the day the second was written and disagree after.
 */

const { db } = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn() },
    offer: { findMany: vi.fn() },
    order: { groupBy: vi.fn(async () => []) },
    country: { findUnique: vi.fn() },
  },
}));

const { getStorefront } = vi.hoisted(() => ({ getStorefront: vi.fn() }));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/storefront', () => ({ getStorefront: (...a: unknown[]) => getStorefront(...a) }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ allowed: true }),
  getClientIp: () => '1.1.1.1',
}));

import { POST } from './route';
import { computeCod } from '@/lib/money';
import { repoFile, stripComments, stripTemplates } from '@/lib/guard-source';

/** JOD: three decimals, like the real store this was measured on. */
const MINOR = 3;

const P = {
  a: { id: 'p-a', name: 'منتج أ', image: null, basePrice: 99 },
  b: { id: 'p-b', name: 'منتج ب', image: null, basePrice: 99 },
};

/**
 * THE OFFER THE BRIEF NAMES: 25 for a bundle of 2, reduced by 3.
 *
 * `quantity: 2` is PIECES PER PICK, so one pick is two pieces at a unit
 * price of 12.5 and a line value of 25 — the bundle's total, divided once,
 * on the server.
 */
const OFF = {
  id: 'off-25',
  name: 'قطعتان',
  quantity: 2,
  freeQuantity: 0,
  sellingPrice: 25,
  discount: 3,
  compareAtPrice: null,
  isDefault: true,
  deliveryIncluded: false,
  endsAt: null,
  sortOrder: 0,
};

/** A second bundle on another product, with a reduction of its own. */
const OFF_B = { ...OFF, id: 'off-10', name: 'واحدة', quantity: 1, sellingPrice: 10, discount: 1 };

/**
 * ONE READ OF THE OFFER TABLE NOW, AND IT CARRIES THE MONEY COLUMN.
 *
 * This mock used to serve two: the catalogue read, which it asserted must
 * NOT be handed `discount`, and a second by-id read for the whole basket.
 * That separation was the defect, not the discipline — keeping the column
 * out of the view is what made `OfferView.price` the figure BEFORE the
 * bundle's reduction while every door charged the figure after, so the
 * landing page printed 25 for a bundle the cart priced at 22.
 *
 * The catalogue read now selects it and `toOfferView` applies it once. The
 * mock asserts that, and asserts the second read is GONE — a by-id read
 * arriving here fails loudly rather than being answered.
 */
function sellingOffers(...offers: (typeof OFF)[]) {
  const byProduct: Record<string, (typeof OFF)[]> = { 'p-a': [], 'p-b': [] };
  for (const o of offers) byProduct[o.id === OFF_B.id ? 'p-b' : 'p-a'].push(o);
  db.offer.findMany.mockImplementation(async ({ where, select }: any) => {
    if (where?.id?.in) {
      throw new Error('the second, by-id read of Offer.discount is gone — see toOfferView');
    }
    expect(select?.discount).toBe(true);
    return byProduct[where?.productId] ?? [];
  });
}

const quote = (items: { productId: string; offerId?: string; quantity: number }[]) =>
  POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ items }) }), {
    params: Promise.resolve({ store: 'sehha' }),
  });

const body = async (items: Parameters<typeof quote>[0]) => {
  const res = await quote(items);
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  return json as {
    lines: { lineTotal: number; unitPrice: number; quantity: number }[];
    subtotal: number;
    cod: number;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  getStorefront.mockResolvedValue({
    id: 'store-a',
    slug: 'sehha',
    companyId: 'c1',
    countryId: 'jo',
    currencyCode: 'JOD',
  });
  db.product.findMany.mockResolvedValue([P.a, P.b]);
  db.offer.findMany.mockImplementation(async () => []);
  db.order.groupBy.mockResolvedValue([]);
  db.country.findUnique.mockResolvedValue({ currencyCode: 'JOD', minorUnit: MINOR });
});

describe('the offer the brief names: 25, reduced by 3, a bundle of 2', () => {
  it('quotes 22, not 25 — the figure the door will actually collect', async () => {
    sellingOffers(OFF);
    const q = await body([{ productId: 'p-a', offerId: OFF.id, quantity: 1 }]);

    /*
     * WHY THESE NUMBERS. One pick of a bundle of 2 is two pieces at 12.5 —
     * the bundle's total divided once, on the server. The subtotal is 25,
     * the offer's reduction of 3 is allocated over the one line there is,
     * and what the shopper is told to expect at the door is 22.
     *
     * `cod` read 25 before this fix, while `createPublicOrder` wrote
     * `totalAmount: 22` from the very same basket.
     */
    expect(q.subtotal).toBe(25);
    expect(q.cod).toBe(22);
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0].quantity).toBe(2);
    expect(q.lines[0].unitPrice).toBe(12.5);
    // The per-line figure the cart prints beside the product carries it too,
    // or the lines would not add up to the total under them.
    expect(q.lines[0].lineTotal).toBe(22);
  });

  it('applies it ONCE per offer, not once per pick', async () => {
    sellingOffers(OFF);
    const q = await body([{ productId: 'p-a', offerId: OFF.id, quantity: 2 }]);
    /*
     * Two picks: four pieces, a subtotal of 50, and the reduction applied
     * once — 47. Flat is what every other door does, and scaling it per
     * pick would be a new pricing rule and the owner's to make, not this
     * door's. `basketDiscount` is where that rule lives; this asserts the
     * cart inherits it rather than re-deciding it.
     */
    expect(q.subtotal).toBe(50);
    expect(q.cod).toBe(47);
  });

  it('and reads the discounts in NO query of their own — the catalogue read carries them', async () => {
    sellingOffers(OFF, OFF_B);
    await body([
      { productId: 'p-a', offerId: OFF.id, quantity: 1 },
      { productId: 'p-b', offerId: OFF_B.id, quantity: 1 },
    ]);
    const discountReads = db.offer.findMany.mock.calls.filter((c: any[]) => c[0]?.where?.id?.in);
    expect(discountReads).toHaveLength(0);
    // One read per product, each already carrying the column.
    const catalogueReads = db.offer.findMany.mock.calls.filter((c: any[]) => c[0]?.where?.productId);
    expect(catalogueReads).toHaveLength(2);
    for (const [arg] of catalogueReads) expect(arg.select.discount).toBe(true);
  });
});

describe('the cart and the order door agree', () => {
  /**
   * THE ORDER DOOR'S OWN CALL, with the order door's own inputs.
   *
   * `createPublicOrder` builds `computeCod({ lines, discount:
   * basketDiscount(lines), minorUnit })` — no fee and no delivery policy,
   * because the fee is settled when the order is raised. Reproducing that
   * expression here, rather than driving the whole intake through its
   * dedupe guard and its customer writes, is what makes this a comparison
   * of the two doors' ARITHMETIC — which is where they disagreed. The
   * source guard below holds the expression itself.
   */
  const atTheDoor = (
    offers: { sellingPrice: number; discount: number; quantity: number }[],
    picks = 1
  ) =>
    computeCod({
      lines: offers.map((o) => ({
        quantity: o.quantity * picks,
        unitPrice: o.sellingPrice / o.quantity,
      })),
      discount: offers.reduce((s, o) => s + o.discount, 0),
      minorUnit: MINOR,
    });

  it('on the offer the brief names', async () => {
    sellingOffers(OFF);
    const q = await body([{ productId: 'p-a', offerId: OFF.id, quantity: 1 }]);
    const door = atTheDoor([OFF]);
    expect(door.cod).toBe(22);
    expect(q.cod).toBe(door.cod);
    expect(q.lines[0].lineTotal).toBe(door.lineTotals[0]);
  });

  it('on a basket of two bundles, each with its own reduction', async () => {
    sellingOffers(OFF, OFF_B);
    const q = await body([
      { productId: 'p-a', offerId: OFF.id, quantity: 1 },
      { productId: 'p-b', offerId: OFF_B.id, quantity: 1 },
    ]);
    // Subtotal 25 + 10 = 35, reductions 3 + 1 = 4, due at the door 31. A
    // promise printed on one offer is not voided by the other.
    const door = atTheDoor([OFF, OFF_B]);
    expect(q.subtotal).toBe(35);
    expect(q.cod).toBe(31);
    expect(q.cod).toBe(door.cod);
    // And the printed lines still add up to the total printed under them.
    expect(q.lines.reduce((s, l) => s + l.lineTotal, 0)).toBe(q.cod);
  });

  it('and a basket split across two cart lines does not buy the reduction twice', async () => {
    sellingOffers(OFF);
    const q = await body([
      { productId: 'p-a', offerId: OFF.id, quantity: 1 },
      { productId: 'p-a', offerId: OFF.id, quantity: 1 },
    ]);
    // Two lines, one offer: a subtotal of 50 and a single reduction of 3.
    // The same 47 the order door writes — `basketDiscount` dedupes by offer
    // id, and the cart inherits that because it calls that function.
    expect(q.subtotal).toBe(50);
    expect(q.cod).toBe(47);
  });
});

describe('a basket with nothing to reduce', () => {
  it('is quoted the base price, whole, and never asks for a discount it has no offer for', async () => {
    const q = await body([{ productId: 'p-a', quantity: 1 }]);
    expect(q.subtotal).toBe(99);
    expect(q.cod).toBe(99);
    expect(db.offer.findMany.mock.calls.filter((c: any[]) => c[0]?.where?.id?.in)).toHaveLength(0);
  });

  it('and an empty basket is an empty basket, not an error', async () => {
    const res = await quote([]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lines: [], subtotal: 0, cod: 0 });
  });
});

describe('a discount larger than the basket cannot invert the quote', () => {
  it('is clamped to the subtotal, so no cart ever promises money back', async () => {
    sellingOffers({ ...OFF, discount: 500 });
    const q = await body([{ productId: 'p-a', offerId: OFF.id, quantity: 1 }]);
    // `allocateDiscount` clamps with Math.min(discount, subtotal).
    expect(q.subtotal).toBe(25);
    expect(q.cod).toBe(0);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * THE RULE, HELD IN THE SOURCE — AND HELD FOR EVERY DOOR AT ONCE.
 *
 * This defect's shape is not wrong arithmetic. It is AN ARGUMENT LEFT OFF
 * ONE CALL SITE OUT OF SEVERAL, and no numeric test of any single door can
 * see it: every test above passes happily while a fourth door drifts. It
 * has now happened twice — the public order door in 448ba22, this cart door
 * right after — because each fix guarded only the doors that existed when it
 * was written.
 *
 * So the guard enumerates the call sites instead of listing them. Every
 * `computeCod({…})` in shipped code must pass `discount`, and a site that
 * genuinely has none must be WRITTEN DOWN HERE WITH ITS REASON. A new door
 * added tomorrow is on no list, so it fails until somebody decides which it
 * is — which is the only way this class of defect gets caught at all.
 * ───────────────────────────────────────────────────────────────────────────
 */

/**
 * Every shipped `.ts`/`.tsx` under `src`, tests excluded.
 *
 * NOT `dashboardFiles`/`shopperFiles` from `guard-source`: those two split
 * the tree by whose design governs a file, and deliberately drop two
 * editor-only components between them. A money rule has to see every file
 * there is, so this walks the lot.
 */
function shippedFiles(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !p.includes('.test.')) {
        out.push({
          rel: relative(process.cwd(), p).split('\\').join('/'),
          src: readFileSync(p, 'utf8'),
        });
      }
    }
  };
  walk(join(process.cwd(), 'src'));
  return out;
}

/**
 * The argument list of one `computeCod(` call, by matching its parens.
 *
 * Comments and template literals are blanked first, for the reason
 * `guard-source` exists: a guard that reads the prose above a call finds
 * whatever the prose happens to mention. If the matcher ever fails to close
 * the call it returns the short slice, which makes the assertion FAIL rather
 * than quietly pass — the safe direction for a guard.
 */
/**
 * Whether one call's argument list hands over a discount.
 *
 * `discount: x` AND the shorthand `discount,` both count — `delivery-fees.ts`
 * and `replacement-order.ts` compute the figure into a local of that name and
 * pass it by shorthand, and a guard that insisted on the colon would have
 * reported two innocent files and taught the next reader to widen the
 * exemption list instead of reading them.
 */
function passesDiscount(args: string): boolean {
  return /(^|[\s{,(])discount\s*[:,}]/.test(args);
}

function callArgs(src: string, at: number): string {
  let depth = 0;
  for (let i = src.indexOf('(', at); i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

/**
 * THE SITES THAT HAVE NO DISCOUNT TO PASS, each with the reason it has none.
 *
 * Both of these price an order from a figure a PERSON stated, with no offer
 * row bound to it — so there is no `discount` column in play and passing 0
 * would be theatre. If either ever starts binding an offer, it moves off
 * this list.
 */
const NO_OFFER_BOUND: Record<string, string> = {
  // `src/lib/telegram/order-creation.ts` was here, for «the price is the operator's advertised total; no offer is bound».
  // It left on 29/10: the message's «إسم العرض» is now bound to a real offer (28/10: «نص العرض مربوط بالعرض») and
  // `priceTelegramLine` passes `discount: basketDiscount([line])` to `computeCod`, as the storefront door does.
  // `const price = p.finalPrice || product.basePrice` — a human-confirmed
  // figure or the product's base price, and the confirm payload carries no
  // `offerId` at all. This file's OTHER `computeCod` call — the preview that
  // suggests a price — does pass the chosen offer's discount, and that is
  // why the write path must not: the reviewer is handed the NET figure (25
  // with a discount of 3 is suggested as 22) and the modal copies it into
  // `finalPrice`, so reducing it again here would charge 19.
  'src/app/api/orders/ai-intake/route.ts':
    'the write path prices a reviewer-confirmed total with no offer bound; its preview call already ' +
    'passes the offer’s discount, so subtracting it again here would take it off twice',
  /*
   * «العرض بعد الطلب» — `computeCod({ lines: [], addOns: [one] })`, called
   * for one reason: to read back `.addOns`, which is the add-on's value
   * computed by the one COD authority and rounded by the order's own
   * currency. There are no LINES in that call, so there is nothing for a
   * discount to be allocated across — and the offer's own reduction is
   * already inside the price it is handed, because `postOrderOfferFor`
   * returns what the customer is CHARGED (`toOfferView` applies it through
   * `allocateDiscount`). Passing it again here would take it off twice,
   * which is the same trap the AI intake's entry above describes.
   *
   * `computeCod` itself says why an add-on is never discounted: «the
   * order's discount was agreed on the original order, before any add-on
   * existed». An add-on changes what is collected, not what was discounted.
   */
  'src/lib/post-order-offer.ts':
    'computeCod is called with no lines, only to value one add-on; the offer’s own reduction is ' +
    'already inside the charged price it is handed, and an add-on is never discounted by contract',
};

describe('every door that computes money passes a discount', () => {
  const sites = shippedFiles().flatMap(({ rel, src }) => {
    const clean = stripTemplates(stripComments(src));
    const found: { rel: string; args: string }[] = [];
    for (let i = clean.indexOf('computeCod({'); i > -1; i = clean.indexOf('computeCod({', i + 1)) {
      found.push({ rel, args: callArgs(clean, i) });
    }
    return found;
  });

  it('finds the call sites at all — a guard over an empty list proves nothing', () => {
    // If a rename or a refactor makes this guard stop seeing the calls, it
    // must fail loudly rather than pass over nothing. Seven worthless
    // guards in this audit were exactly that.
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(sites.map((s) => s.rel)).toContain('src/lib/public-order.ts');
    expect(sites.map((s) => s.rel)).toContain(
      'src/app/api/public/stores/[store]/quote/route.ts'
    );
  });

  it.each([
    'src/app/api/public/stores/[store]/quote/route.ts',
    'src/lib/public-order.ts',
    'src/app/api/orders/route.ts',
  ])('%s — a door a customer’s money comes through', (rel) => {
    const mine = sites.filter((s) => s.rel === rel);
    expect(mine.length, `no computeCod({ call found in ${rel}`).toBeGreaterThan(0);
    for (const s of mine) expect(passesDiscount(s.args), s.rel).toBe(true);
  });

  it('and so does every other one, or it is written down above with its reason', () => {
    const silent = sites.filter((s) => !passesDiscount(s.args)).map((s) => s.rel);
    const unexplained = silent.filter((rel) => !(rel in NO_OFFER_BOUND));
    expect(
      unexplained,
      `These compute money without a discount. Either pass one, or add the file to ` +
        `NO_OFFER_BOUND in this test with the reason it has no offer bound.`
    ).toEqual([]);
    // And the list does not rot: an entry whose file has started passing a
    // discount, or has gone away, is removed rather than left to excuse the
    // next omission.
    for (const rel of Object.keys(NO_OFFER_BOUND)) {
      expect(silent, `${rel} no longer needs its NO_OFFER_BOUND entry`).toContain(rel);
    }
  });

  it('and the cart door passes the order door’s own function, not a copy of it', () => {
    const cart = stripComments(repoFile('src/app/api/public/stores/[store]/quote/route.ts'));
    // The imported function, by name — not a second «what does this basket
    // come to» that would drift from `basketDiscount`'s dedupe rule.
    expect(cart).toContain('discount: basketDiscount(resolved.lines)');
    expect(cart).toMatch(/import \{[^}]*\bbasketDiscount\b[^}]*\} from '@\/lib\/public-order'/);
    // One cod call in this door, in the one place.
    expect(cart.match(/computeCod\(/g) ?? []).toHaveLength(1);
    // No arithmetic of its own on the figure.
    expect(cart).not.toMatch(/offerDiscount\s*[+*/-]/);
  });
});
