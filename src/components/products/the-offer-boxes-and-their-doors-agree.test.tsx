// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * THE ROUND TRIP: THE BODY THE OFFERS FORM SENDS, HANDED TO THE REAL DOORS.
 *
 * `509306a` set the standard. The offers form had the same defect in three
 * boxes — `Number(e.target.value) || 0` on the selling price, `|| 0` on the
 * free quantity, `|| 1` on the quantity — and `Number('')` is `0`, so a
 * cleared box and a typed zero were ONE request. `compareAtPrice` beside
 * them was already right (`e.target.value === '' ? null : Number(…)`), which
 * is why the answer here is that file's own and not a new one.
 *
 * It had a second half, and it is the one `17cbe93` would recognise: the new
 * offer's draft opened pre-filled with `quantity: 1`, `freeQuantity: 0`,
 * `discount: 0`, `deliveryIncluded: true` and `status: 'ACTIVE'` — five
 * transcriptions of defaults that live in `schema.prisma` — and `save()`
 * then sent all five explicitly through `?? <literal>`. On the PATCH this
 * same function sends for an EXISTING offer, `discount: draft.discount ?? 0`
 * is a live hazard: `323e95a` stripped the defaults out of the patch schema
 * so that omitted could mean omitted, and a browser inventing the value
 * re-opens the door it shut.
 *
 * What is proved is the whole trip:
 *
 *   · an empty price box      → absent → 400 «سعر البيع مطلوب», nothing written
 *   · THE SAME CLICK, OLD CODE → 201-shaped 200 and an offer priced at 0
 *   · a typed 0 price         → `'0'` → stored 0, because a free bundle is
 *                               a pricing decision the schema allows
 *   · empty quantity / free   → absent → THE COLUMN's 1 and 0, not the
 *                               browser's
 *   · a PATCH of the price alone → the stored discount is untouched, and the
 *                               cross-field rule of `57eb1d6` fires on it
 *   · and the screen SHOWS the door's Arabic sentence
 */

/* ── the doors' dependencies ───────────────────────────────────────────── */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    offer: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    product: { findFirst: vi.fn() },
    order: { count: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

/* ── the screen's dependency ───────────────────────────────────────────── */

const { screenApi } = vi.hoisted(() => ({ screenApi: vi.fn() }));
vi.mock('@/lib/screen-api', () => ({ screenApi }));

import { POST as OFFERS_POST } from '@/app/api/offers/route';
import { PATCH as OFFERS_PATCH } from '@/app/api/offers/[id]/route';
import { ProductOffers } from './ProductOffers';

const PRODUCT_ID = 'prod-aaaaaaaaaa';
const PRODUCT = { id: PRODUCT_ID, name: 'كريم', companyId: 'c1', storeId: 's1', basePrice: 20 };

/**
 * A STORED OFFER WITH A REAL DISCOUNT — the row the PATCH case is measured
 * against. `57eb1d6` refuses an offer whose discount meets its price, and
 * the rule reads the row the edit WILL leave, not only the fields sent.
 */
const STORED = {
  id: 'offer-bbbbbbbbbb',
  companyId: 'c1',
  productId: PRODUCT_ID,
  name: 'قطعتان',
  quantity: 2,
  freeQuantity: 0,
  sellingPrice: 36,
  compareAtPrice: null,
  endsAt: null,
  discount: 3,
  deliveryIncluded: true,
  isDefault: true,
  sortOrder: 0,
  status: 'ACTIVE',
};

const CONTEXT = {
  user: { id: 'u1', role: 'OPS', name: 'سامر' },
  companyId: 'c1',
  storeId: 's1',
  // The store's currency: both doors round an offer's line («العرض ما بصير يكون اكثر من السعر الاساسي») by it.
  country: { currencyCode: 'JOD', minorUnit: 3 },
};

/** The stored offer as the edit door reads it — with its product's base price, the 20 of `PRODUCT`. */
const asStored = (row: object) => ({ ...row, product: { basePrice: PRODUCT.basePrice } });

/** Every non-GET body the screen sent, in order. */
let sent: { url: string; method: string; body: any }[] = [];
/** What the next non-GET call should throw, so a door's refusal can reach the screen. */
let refuseWith: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  refuseWith = null;

  requireContext.mockResolvedValue(CONTEXT);
  requirePermission.mockResolvedValue(undefined);
  db.product.findFirst.mockResolvedValue(PRODUCT);
  db.offer.findFirst.mockResolvedValue(asStored(STORED));
  db.offer.create.mockImplementation(async ({ data }: any) => ({ id: 'offer-new', ...data }));
  db.offer.update.mockImplementation(async ({ data }: any) => ({ ...STORED, ...data }));
  db.offer.updateMany.mockResolvedValue({ count: 0 });
  db.$transaction.mockImplementation(async (fn: any) => fn({ offer: db.offer }));

  screenApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return { offers: [] };
    sent.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    // The DOOR's answer is taken from the real handler below; this stub only
    // decides whether the screen is told «yes» or told the door's sentence.
    if (refuseWith) throw new Error(refuseWith);
    return { success: true };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ── driving the form ──────────────────────────────────────────────────── */

const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

/** Open the «عرض جديد» draft, fill as described, press حفظ, return THE BODY IT SENT. */
async function newOfferBodyFor(
  fill: (u: ReturnType<typeof userEvent.setup>) => Promise<void>,
  offers: any[] = []
) {
  const user = userEvent.setup();
  screenApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return { offers };
    sent.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (refuseWith) throw new Error(refuseWith);
    return { success: true };
  });
  render(<ProductOffers productId={PRODUCT_ID} basePrice={20} currency="JOD" />);
  await waitFor(() => expect(screen.getByText('عرض جديد')).toBeTruthy());
  await user.click(screen.getByText('عرض جديد'));
  await waitFor(() => expect(box('الكمية')).toBeTruthy());
  await user.type(screen.getByLabelText('اسم العرض'), 'ثلاث قطع');
  await fill(user);
  await user.click(screen.getByText('حفظ العرض'));
  await waitFor(() => expect(sent).toHaveLength(1));
  return sent[0];
}

/** Open تعديل on the stored offer, fill as described, press حفظ, return THE BODY IT SENT. */
async function editBodyFor(
  fill: (u: ReturnType<typeof userEvent.setup>) => Promise<void>,
  stored: typeof STORED = STORED
) {
  const user = userEvent.setup();
  db.offer.findFirst.mockResolvedValue(asStored(stored));
  db.offer.update.mockImplementation(async ({ data }: any) => ({ ...stored, ...data }));
  screenApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return { offers: [{ ...stored }] };
    sent.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (refuseWith) throw new Error(refuseWith);
    return { success: true };
  });
  render(<ProductOffers productId={PRODUCT_ID} basePrice={20} currency="JOD" />);
  await waitFor(() => expect(screen.getByTitle('تعديل')).toBeTruthy());
  await user.click(screen.getByTitle('تعديل'));
  await waitFor(() => expect(box('الكمية')).toBeTruthy());
  await fill(user);
  await user.click(screen.getByText('حفظ العرض'));
  await waitFor(() => expect(sent).toHaveLength(1));
  return sent[0];
}

/* ── handing the captured body to the real doors ───────────────────────── */

const atTheCreateDoor = (body: unknown) =>
  OFFERS_POST(
    new Request('http://localhost/api/offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const atTheEditDoor = (body: unknown) =>
  OFFERS_PATCH(
    new Request(`http://localhost/api/offers/${STORED.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: STORED.id }) }
  );

/** The `data` the offer was created with. */
const createdOffer = () => db.offer.create.mock.calls[0][0].data;
/** The `data` the offer was updated with. */
const updatedOffer = () => db.offer.update.mock.calls[0][0].data;

/* ══════════════════════════════════════════════════════════════════════ */

describe('POST /api/offers — the offers form’s own body, at the real door', () => {
  it('an UNTOUCHED draft sends a name and nothing else, and the door refuses by name', async () => {
    const { body } = await newOfferBodyFor(async () => {});

    /*
     * THE DOOR'S SENTENCE FIRST, because it is what a person reads. Restore
     * `sellingPrice: String(basePrice)` in the draft and this prints
     * `{ success: true, offer: … }` — the bundle that got written for a
     * form nobody filled in.
     */
    const res = await atTheCreateDoor({ ...body, productId: PRODUCT_ID });
    expect(await res.json()).toEqual({ error: 'سعر البيع مطلوب' });
    expect(res.status).toBe(400);
    expect(db.offer.create).not.toHaveBeenCalled();

    // Every numeric key absent — the five invented defaults are gone too.
    for (const key of ['quantity', 'freeQuantity', 'sellingPrice', 'discount', 'deliveryIncluded', 'status']) {
      expect(body[key], `${key} ما زال مُخترَعاً في المتصفّح`).toBeUndefined();
    }
    expect(Object.prototype.hasOwnProperty.call(body, 'sellingPrice')).toBe(false);
  });

  it('and THE SAME CLICK before this change wrote a bundle priced at ZERO', async () => {
    const { body } = await newOfferBodyFor(async () => {});

    /*
     * `Number('') || 0` for the price, and the four other literals the draft
     * opened with. The door is unchanged — only the body is — and it accepts,
     * correctly: `money(1_000_000)` is `min(0)`, and a free bundle is a real
     * pricing decision it cannot refuse. So the refusal was UNREACHABLE.
     */
    const old = await atTheCreateDoor({
      ...body,
      productId: PRODUCT_ID,
      quantity: 1,
      freeQuantity: 0,
      sellingPrice: 0,
      discount: 0,
      deliveryIncluded: true,
      status: 'ACTIVE',
    });
    expect(old.status).toBe(200);
    expect(createdOffer().sellingPrice).toBe(0);
  });

  /*
   * THE PRICE HERE WAS 36, AND THE OWNER'S RULE OF 28/10 REFUSES IT. «العرض ما بصير يكون اكثر من السعر الاساسي»:
   * an empty quantity box is ONE piece at the door, and one piece at a base price of 20 may cost 20 at most. This
   * case is about the defaults, not the price, so it is priced under the line now — and 36 has a case of its own
   * just below, as the refusal it has become.
   */
  it('empty quantity and free-quantity take THE COLUMN’s defaults, not the browser’s', async () => {
    const { body } = await newOfferBodyFor(async (user) => {
      await user.type(box('السعر (JOD)'), '18');
    });
    expect(body.sellingPrice).toBe('18');
    expect(Object.prototype.hasOwnProperty.call(body, 'quantity')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'freeQuantity')).toBe(false);

    const res = await atTheCreateDoor({ ...body, productId: PRODUCT_ID });
    expect(res.status).toBe(200);
    const saved = createdOffer();
    expect(saved.sellingPrice).toBe(18);
    /*
     * ONE COPY OF EACH DEFAULT, and this is where it lives: `offerFields`
     * reads `count(999, 1).default(1)` and `count(999).default(0)` over
     * `quantity Int @default(1)` and `freeQuantity Int @default(0)`, both
     * NOT NULL. Nothing in the browser says 1 or 0 any more.
     */
    expect(saved.quantity).toBe(1);
    expect(saved.freeQuantity).toBe(0);
    expect(saved.discount).toBe(0);
    expect(saved.deliveryIncluded).toBe(true);
    expect(saved.status).toBe('ACTIVE');
  });

  it('NEGATIVE: and the 36 this case used to save is refused — one piece, base 20, nothing written', async () => {
    const { body } = await newOfferBodyFor(async (user) => {
      await user.type(box('السعر (JOD)'), '36');
    });
    expect(body.sellingPrice).toBe('36');

    const res = await atTheCreateDoor({ ...body, productId: PRODUCT_ID });
    const answer = await res.json();
    // The sentence first, because it is what the seller reads: the owner's own words, at the store's three places.
    expect(answer.error).toBe('لا يمكنك إنشاء العرض: السعر 36.000 أعلى من السعر الأساسي لقطعة واحدة (20.000)');
    expect(answer).toMatchObject({ code: 'OFFER_ABOVE_BASE', maxPrice: 20 });
    expect(res.status).toBe(400);
    expect(db.offer.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and THE DOOR’S OWN SENTENCE is what the screen draws, through the message the form already had', async () => {
    // What the real door answers for this click — not a copy typed into the test, which would pass whatever the door
    // said.
    const { body } = await newOfferBodyFor(async (user) => {
      await user.type(box('السعر (JOD)'), '36');
    });
    const door = await (await atTheCreateDoor({ ...body, productId: PRODUCT_ID })).json();
    expect(door.code).toBe('OFFER_ABOVE_BASE');

    // The same click again, and this time the screen is told exactly that.
    cleanup();
    sent = [];
    refuseWith = door.error;
    await newOfferBodyFor(async (user) => {
      await user.type(box('السعر (JOD)'), '36');
    });
    const drawn = await screen.findByText(door.error);
    expect(drawn.textContent).toBe(door.error);
    expect(drawn.className).toContain('destructive');
  });

  it('a TYPED ZERO price is accepted as zero, so a free bundle stays sayable', async () => {
    const { body } = await newOfferBodyFor(async (user) => {
      await user.type(box('السعر (JOD)'), '0');
      await user.type(box('الكمية'), '3');
      await user.type(box('كمية مجانية'), '1');
    });
    expect(body.sellingPrice).toBe('0');
    expect(body.quantity).toBe('3');
    expect(body.freeQuantity).toBe('1');

    const res = await atTheCreateDoor({ ...body, productId: PRODUCT_ID });
    expect(res.status).toBe(200);
    expect(createdOffer().sellingPrice).toBe(0);
    expect(createdOffer().quantity).toBe(3);
    expect(createdOffer().freeQuantity).toBe(1);
  });

  it('and a cleared box can be RETYPED — it used to redraw as 0 and read «030»', async () => {
    const user = userEvent.setup();
    render(<ProductOffers productId={PRODUCT_ID} basePrice={20} currency="JOD" />);
    await waitFor(() => expect(screen.getByText('عرض جديد')).toBeTruthy());
    await user.click(screen.getByText('عرض جديد'));
    await waitFor(() => expect(box('الكمية')).toBeTruthy());

    // The three boxes OPEN EMPTY. `quantity: 1`/`freeQuantity: 0` and
    // `sellingPrice: basePrice` filled them before anybody typed.
    expect(box('الكمية').value).toBe('');
    expect(box('كمية مجانية').value).toBe('');
    expect(box('السعر (JOD)').value).toBe('');
    // And the base price is offered as a PLACEHOLDER, so it is read and not saved.
    expect(box('السعر (JOD)').placeholder).toContain('20');

    await user.type(box('السعر (JOD)'), '30');
    expect(box('السعر (JOD)').value).toBe('30');
    expect(box('السعر (JOD)').value).not.toBe('030');
  });
});

describe('PATCH /api/offers/[id] — an edit, at the real door', () => {
  it('opens on the STORED figures, including a stored zero', async () => {
    const user = userEvent.setup();
    screenApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return { offers: [{ ...STORED, freeQuantity: 0, sellingPrice: 0 }] };
      }
      return { success: true };
    });
    render(<ProductOffers productId={PRODUCT_ID} basePrice={20} currency="JOD" />);
    await waitFor(() => expect(screen.getByTitle('تعديل')).toBeTruthy());
    await user.click(screen.getByTitle('تعديل'));
    await waitFor(() => expect(box('الكمية')).toBeTruthy());

    expect(box('الكمية').value).toBe('2');
    // A STORED 0 IS A VALUE, NOT A BLANK — the distinction the whole change
    // is about, read in the other direction.
    expect(box('كمية مجانية').value).toBe('0');
    expect(box('السعر (JOD)').value).toBe('0');
  });

  /**
   * MEASURED ON AN OFFER WITH NO DISCOUNT — twenty-seven of the twenty-eight
   * on this database, 2026-10-07 — because the discount rule of `57eb1d6`
   * would otherwise catch the zero for a different reason and hide what this
   * box does. The row this is about is the ordinary one.
   */
  const NO_DISCOUNT = { ...STORED, discount: 0 };

  it('a CLEARED price box is absent, and the stored price survives — it used to be zeroed', async () => {
    const { method, body } = await editBodyFor(async (user) => {
      await user.clear(box('السعر (JOD)'));
    }, NO_DISCOUNT);
    expect(method).toBe('PATCH');

    /*
     * THE DOOR'S ANSWER FIRST. Restore `Number(e.target.value) || 0` on this
     * box and the wire carries `'0'`, which this door writes: a bundle
     * stored at 36 BECOMES FREE, over a `Float NOT NULL` column that has no
     * «unknown» to fall back to. `omittedMeansOmitted` (323e95a) is what
     * makes absence mean «leave it alone», and only an ABSENT field can
     * reach it — which is why `onTheWire` must never send `''` either.
     */
    const res = await atTheEditDoor(body);
    expect(res.status).toBe(200);
    // The VALUE first, so a mutation prints the zero rather than a boolean.
    expect(updatedOffer().sellingPrice, 'سعرٌ محفوظٌ كُتِب فوقَه').toBeUndefined();
    expect('sellingPrice' in updatedOffer()).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'sellingPrice')).toBe(false);
    // And the row keeps the 36 it had.
    expect(updatedOffer().sellingPrice ?? NO_DISCOUNT.sellingPrice).toBe(36);
  });

  it('an edit of the price alone LEAVES THE STORED DISCOUNT ALONE', async () => {
    const { method, body } = await editBodyFor(async (user) => {
      await user.clear(box('السعر (JOD)'));
      await user.type(box('السعر (JOD)'), '40');
    });
    expect(method).toBe('PATCH');
    expect(body.sellingPrice).toBe('40');
    // The stored 3 is sent back as 3 — not as the `?? 0` that used to stand
    // here, which would have wiped it.
    expect(body.discount).toBe(3);

    const res = await atTheEditDoor(body);
    expect(res.status).toBe(200);
    expect(updatedOffer().sellingPrice).toBe(40);
    expect(updatedOffer().discount).toBe(3);
  });

  it('and the cross-field rule of 57eb1d6 fires on a price the discount swallows', async () => {
    const { body } = await editBodyFor(async (user) => {
      await user.clear(box('السعر (JOD)'));
      // A discount of 3 is stored; a price of 2 is below it.
      await user.type(box('السعر (JOD)'), '2');
    });
    expect(body.sellingPrice).toBe('2');

    const res = await atTheEditDoor(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('الخصم (3) يساوي سعر العرض (2) أو يزيد عليه');
    expect(db.offer.update).not.toHaveBeenCalled();
  });

  it('and THAT SENTENCE IS DRAWN ON THE SCREEN, not swallowed', async () => {
    refuseWith = 'الخصم (3) يساوي سعر العرض (2) أو يزيد عليه — اكتب خصماً أقلّ من 2';
    await editBodyFor(async (user) => {
      await user.clear(box('السعر (JOD)'));
      await user.type(box('السعر (JOD)'), '2');
    });
    // `screenApi` throws with the server's own `error` string, and `save()`
    // puts it in `msg`. A form made honest whose refusal nobody can read is
    // half a fix.
    await waitFor(() => expect(screen.getByText(/يساوي سعر العرض/)).toBeTruthy());
    expect(screen.getByText(/يساوي سعر العرض/).className).toContain('destructive');
  });

  /**
   * AN OFFER SAVED ABOVE ITS LINE BEFORE THE RULE — one piece at 36, where the base price of 20 draws a line of 20.
   *
   * It stays on sale, and it must stay EDITABLE: the «تعديل» form sends the price, the quantity and the status on
   * every save, so a door that refused whenever those keys were present would refuse renaming it, or changing its
   * ending, until somebody repriced it. What the door measures is what the edit CHANGES.
   */
  const ABOVE_ITS_LINE = { ...STORED, name: 'قطعة', quantity: 1, sellingPrice: 36, discount: 0 };

  it('opening «تعديل» on one stored above its line and changing ONLY the name saves — the real body, the real door', async () => {
    const { body } = await editBodyFor(async (user) => {
      await user.clear(screen.getByLabelText('اسم العرض'));
      await user.type(screen.getByLabelText('اسم العرض'), 'قطعة — السعر القديم');
    }, ABOVE_ITS_LINE);
    // The form sent the figures it was opened on, untouched — the price and the quantity are ON the wire.
    expect(body.sellingPrice).toBe('36');
    expect(body.quantity).toBe('1');
    expect(body.status).toBe('ACTIVE');

    const res = await atTheEditDoor(body);
    expect(res.status).toBe(200);
    expect(updatedOffer().name).toBe('قطعة — السعر القديم');
    expect(updatedOffer().sellingPrice).toBe(36);
  });

  it('NEGATIVE: but the same form with the price moved, and still above the line, is refused', async () => {
    const { body } = await editBodyFor(async (user) => {
      await user.clear(box('السعر (JOD)'));
      await user.type(box('السعر (JOD)'), '30');
    }, ABOVE_ITS_LINE);

    const res = await atTheEditDoor(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'لا يمكنك تعديل العرض: السعر 30.000 أعلى من السعر الأساسي لقطعة واحدة (20.000)',
      code: 'OFFER_ABOVE_BASE',
      maxPrice: 20,
    });
    expect(db.offer.update).not.toHaveBeenCalled();
  });
});
