// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * THE ROUND TRIP: THE BODY EACH ORDER FORM SENDS, HANDED TO THE REAL DOOR.
 *
 * `509306a` set the standard and this file applies it to the two forms that
 * write what a CUSTOMER IS CHARGED:
 *
 *   · `ProductLinesEditor`'s line-price box, through `CreateOrderModal` and
 *     `POST /api/orders`. It was `Number(e.target.value) || 0`, and
 *     `Number('')` is `0` — so CLEARING THE BOX MADE THE LINE FREE, on a
 *     real order, and the door is obliged to accept it because `min(0)` and
 *     a giveaway line is legitimate. `0aea050` fixed the same defect for
 *     `basePrice` in `ProductsScreen`; here the number is money owed.
 *
 *   · `AiOrderModal`'s price and quantity boxes, through
 *     `POST /api/orders/ai-intake`. Worse than a free line: that door reads
 *     `p.finalPrice || product.basePrice`, so a cleared price box silently
 *     charged THE PRODUCT'S BASE PRICE — the modal said one figure and the
 *     order said another, with nothing anywhere to say they disagreed.
 *
 * What is proved is the whole trip, not the form's good intentions:
 *
 *   · an empty line-price box   → the field is absent → 400 «سعر الوحدة مطلوب»
 *   · THE SAME CLICK, OLD CODE  → 200, and an order worth 0 is written
 *   · a typed 0                 → `'0'` → 200, a giveaway line stored as 0
 *   · a typed number            → `'25'` → 200, and the money matches computeCod
 *   · an empty AI price box     → absent → 400, and nothing is written
 *   · THE SAME CLICK, OLD CODE  → 200 at `product.basePrice`, not at 0
 *   · an empty AI quantity box  → absent → 400 «الكمية مطلوب»
 *   · a typed 0 AI price        → the door still reads it as the base price,
 *                                 which is the OPEN OWNER DECISION, recorded
 *                                 here as it stands and not changed
 */

/* ── the doors' dependencies ───────────────────────────────────────────── */

const {
  db,
  requireContext,
  requirePermission,
  findOrCreateCustomer,
  activeBlock,
  orderRefFields,
  productCosts,
  productCost,
  priceIncludesDeliveryFor,
  resolveRegionId,
  logAudit,
  parseOrderText,
  matchProduct,
  activeOffersFor,
} = vi.hoisted(() => ({
  db: {
    order: { create: vi.fn(), findFirst: vi.fn() },
    orderItem: { createMany: vi.fn(), create: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    customer: { update: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    region: { findFirst: vi.fn() },
    offer: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  activeBlock: vi.fn(),
  orderRefFields: vi.fn(),
  productCosts: vi.fn(),
  productCost: vi.fn(),
  priceIncludesDeliveryFor: vi.fn(),
  resolveRegionId: vi.fn(),
  logAudit: vi.fn(),
  parseOrderText: vi.fn(),
  matchProduct: vi.fn(),
  activeOffersFor: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  /*
   * `can` answers «does this account keep the orders it enters?»
   * (`entryOwnership`). False: these tests are about the money and the
   * payload, and an entry that goes to the pull queue is what every
   * one of them has always asserted. `order-entry-ownership.test.ts`
   * owns the rule itself.
   */
  can: () => false,
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  getPermissionScope: vi.fn(),
}));
vi.mock('@/lib/customer-identity', () => ({
  findOrCreateCustomer: (...a: unknown[]) => findOrCreateCustomer(...a),
}));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/order-ref', () => ({
  orderRefFields: (...a: unknown[]) => orderRefFields(...a),
}));
vi.mock('@/lib/product-cost', () => ({
  productCosts: (...a: unknown[]) => productCosts(...a),
  productCost: (...a: unknown[]) => productCost(...a),
}));
vi.mock('@/lib/delivery-fees', () => ({
  priceIncludesDeliveryFor: (...a: unknown[]) => priceIncludesDeliveryFor(...a),
}));
vi.mock('@/lib/regions', () => ({ resolveRegionId: (...a: unknown[]) => resolveRegionId(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/offers', () => ({ activeOffersFor: (...a: unknown[]) => activeOffersFor(...a) }));
vi.mock('@/lib/order-parser', () => ({
  parseOrderText: (...a: unknown[]) => parseOrderText(...a),
  matchProduct: (...a: unknown[]) => matchProduct(...a),
  normalizeArabic: (s: string) => s,
}));
vi.mock('@/lib/order-filters', () => ({ ordersWhere: vi.fn() }));
vi.mock('@/lib/rbac', () => ({ applyQueueFilter: vi.fn() }));

/* ── the screens' dependencies ─────────────────────────────────────────── */

const { apiFetch, apiJson } = vi.hoisted(() => ({ apiFetch: vi.fn(), apiJson: vi.fn() }));

/*
 * THE TOAST, SPIED ON.
 *
 * `useToast` returns no-op functions outside a provider, so what these
 * windows SAY went nowhere and could not be asserted. The entry doors now
 * return a `notice` when the agent's own cap pushed her order into the
 * shared queue, and whether she is told is the behaviour under test.
 */
const { toastDone, toastWarn, toastFailed } = vi.hoisted(() => ({
  toastDone: vi.fn(),
  toastWarn: vi.fn(),
  toastFailed: vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ done: toastDone, warn: toastWarn, failed: toastFailed }),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch, apiJson }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar', isRtl: true }),
}));
vi.mock('@/context/StoreCurrency', () => ({
  useStoreCurrency: () => ({ code: 'JOD', minorUnit: 2 }),
}));
// The picker is not this file's subject; a native select makes choosing a
// product one `selectOptions` call.
vi.mock('@/components/ui/ProductPicker', () => ({
  ProductPicker: ({
    value,
    onChange,
    products,
  }: {
    value: string;
    onChange: (id: string) => void;
    products: { id: string; name: string }[];
  }) => (
    <select aria-label="المنتج" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {products.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  ),
}));

import { POST as ORDERS } from '@/app/api/orders/route';
import { POST as AI_INTAKE } from '@/app/api/orders/ai-intake/route';
import { CreateOrderModal } from './CreateOrderModal';
import { AiOrderModal } from './AiOrderModal';
import { computeCod } from '@/lib/money';

/** `productId: z.string().min(10)`, so the fixture carries a real-length id. */
const PRODUCT = {
  id: 'prod-aaaaaaaaaa',
  name: 'كريم',
  sku: 'KR-1',
  image: null,
  basePrice: 14,
  companyId: 'c1',
  batches: [],
  // A product with NO offers, so the line opens at the base price and the
  // price box is editable rather than locked by an offer.
  offers: [],
};

const CONTEXT = {
  user: { id: 'u1', role: 'OPS', name: 'سامر' },
  companyId: 'c1',
  storeId: 's1',
  countryId: 'co1',
  country: {
    // A country with no phone rule, so the fixture number only has to be
    // seven digits — the phone rule is not what is under test.
    code: 'XX',
    currencyCode: 'JOD',
    minorUnit: 2,
    orderPrefix: 'JO',
    allowNegativeStock: false,
  },
};

const PARSED = {
  customerName: 'عبدالله',
  phone: '0936654998',
  governorate: 'دمشق',
  address: 'بانياس',
  productQuery: 'كريم',
  quantity: 2,
  price: null as number | null,
  notes: '-',
  source: 'الشيت',
};

/** Every non-GET body a screen sent, in order. */
let sent: { url: string; body: any }[] = [];

function freshDoors() {
  requireContext.mockResolvedValue(CONTEXT);
  requirePermission.mockResolvedValue(undefined);
  activeBlock.mockResolvedValue(null);
  findOrCreateCustomer.mockResolvedValue({ id: 'cust-1', firstOrderDate: null });
  orderRefFields.mockResolvedValue({ orderNumber: 'JO-2026-0001', merchantRef: 'JO-REF-1' });
  productCosts.mockResolvedValue(new Map([[PRODUCT.id, { average: 5 }]]));
  productCost.mockResolvedValue({ average: 5 });
  priceIncludesDeliveryFor.mockResolvedValue(false);
  resolveRegionId.mockResolvedValue(null);
  db.product.findMany.mockResolvedValue([PRODUCT]);
  db.product.findFirst.mockResolvedValue(PRODUCT);
  db.region.findFirst.mockResolvedValue({ id: 'reg-1' });
  db.offer.findFirst.mockResolvedValue(null);
  db.order.create.mockImplementation(async ({ data }: any) => ({ id: 'ord-1', ...data }));
  db.orderItem.createMany.mockResolvedValue({ count: 1 });
  db.orderItem.create.mockImplementation(async ({ data }: any) => ({ id: 'item-1', ...data }));
  db.customer.update.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
  db.orderStatusLog.create.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: any) =>
    fn({
      order: db.order,
      orderItem: db.orderItem,
      inventoryMovement: { create: vi.fn() },
      customer: db.customer,
      orderActivity: db.orderActivity,
      orderStatusLog: db.orderStatusLog,
      offer: db.offer,
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  freshDoors();
  // No bundle on this product: the reviewer's figure is the price. With one, the write asks
  // for the offer's price for that quantity (RV151) — `ai-intake-discount.test.ts` owns that.
  activeOffersFor.mockResolvedValue([]);

  apiJson.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/products')) return { products: [PRODUCT] };
    if (path.startsWith('/api/geo/regions')) {
      return {
        country: { name: 'سوريا', currencyCode: 'JOD', minorUnit: 2 },
        regions: [{ id: '11111111-1111-4111-8111-111111111111', name: 'دمشق' }],
      };
    }
    return {};
  });
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      // The screen only needs a shape back; the DOOR's answer is taken from
      // the real handler below, never from this stub.
      return new Response(
        JSON.stringify({
          success: true,
          order: { id: 'ord-1', orderNumber: 'JO-2026-0001' },
          parsed: PARSED,
          engine: 'parser',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.startsWith('/api/orders/ai-intake')) {
      return new Response(JSON.stringify({ parsed: PARSED }), { status: 200 });
    }
    return new Response(JSON.stringify({ users: [], channels: [] }), { status: 200 });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ── driving the two forms ─────────────────────────────────────────────── */

const priceBox = () => screen.getByPlaceholderText('سعر السطر') as HTMLInputElement;

/** Fill the quick-order form as described and return THE BODY IT SENT. */
async function orderBodyFor(fill: (u: ReturnType<typeof userEvent.setup>) => Promise<void>) {
  const user = userEvent.setup();
  render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText('المنتج')).toBeTruthy());
  await user.type(screen.getByPlaceholderText('مثال: عبدالله عبدالقادر'), 'عبدالله');
  await user.type(screen.getByPlaceholderText('مثال: 0936654998'), '0936654998');
  await user.type(screen.getByPlaceholderText('الشارع، البناء، المنطقة...'), 'بانياس');
  await user.selectOptions(screen.getByLabelText('المحافظة'), '11111111-1111-4111-8111-111111111111');
  await user.selectOptions(screen.getByLabelText('المنتج'), PRODUCT.id);
  await waitFor(() => expect(priceBox().value).toBe('14'));
  await fill(user);
  // `required` on the customer boxes is the browser's own guard; the DOOR is
  // what is being tested, so the submit is driven the way a client without
  // constraint validation drives it.
  const form = screen.getByText('إلغاء').closest('form') as HTMLFormElement;
  form.noValidate = true;
  await user.click(screen.getByText(/إنشاء الطلب/));
  await waitFor(() => expect(sent).toHaveLength(1));
  return sent[0].body;
}

/** Parse a message in the AI modal, fill as described, and return THE BODY IT SENT. */
/**
 * The AI modal on screen with a parse already answered, and NOTHING sent.
 *
 * `aiBodyFor` below submits, because what it measures is the body on the
 * wire. These two measure what the REVIEWER is looking at before they press
 * anything — the label, the sentence under it, the box after the product
 * changes — so they stop one step earlier.
 */
function renderModal(parsed: typeof PARSED = PARSED) {
  const user = userEvent.setup();
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.confirm) {
      sent.push({ url, body });
      return new Response(JSON.stringify({ success: true, order: { id: 'ord-1' } }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        parsed,
        engine: 'parser',
        matchedProduct: { id: PRODUCT.id, name: PRODUCT.name, score: 1 },
        productMatchConfident: true,
        suggestedPrice: null,
        suggestedOfferName: null,
        existingCustomer: null,
      }),
      { status: 200 }
    );
  });
  render(<AiOrderModal isOpen onClose={() => {}} onSuccess={() => {}} />);
  lastUser = user;
  return user;
}

let lastUser: ReturnType<typeof userEvent.setup>;

/** Paste something, press analyse, and wait for the form to be drawn. */
async function openForm() {
  await lastUser.type(screen.getByRole('textbox'), 'الاسم: عبدالله');
  await lastUser.click(screen.getByText(/تحليل الطلب بالذكاء الاصطناعي/));
  await waitFor(() => expect(screen.getByLabelText('الكمية')).toBeTruthy());
}

async function aiBodyFor(
  parsed: typeof PARSED,
  fill: (u: ReturnType<typeof userEvent.setup>) => Promise<void>
) {
  const user = userEvent.setup();
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.confirm) {
      sent.push({ url, body });
      return new Response(JSON.stringify({ success: true, order: { id: 'ord-1' } }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        parsed,
        engine: 'parser',
        matchedProduct: { id: PRODUCT.id, name: PRODUCT.name, score: 1 },
        productMatchConfident: true,
        suggestedPrice: null,
        suggestedOfferName: null,
        existingCustomer: null,
      }),
      { status: 200 }
    );
  });
  render(<AiOrderModal isOpen onClose={() => {}} onSuccess={() => {}} />);
  await user.type(screen.getByRole('textbox'), 'الاسم: عبدالله');
  await user.click(screen.getByText(/تحليل الطلب بالذكاء الاصطناعي/));
  await waitFor(() => expect(screen.getByLabelText('الكمية')).toBeTruthy());
  await fill(user);
  await user.click(screen.getByText(/تسجيل الطلب/));
  await waitFor(() => expect(sent).toHaveLength(1));
  return sent[0].body;
}

/* ── handing the captured body to the real door ────────────────────────── */

const atTheOrdersDoor = (body: unknown) =>
  ORDERS(
    new Request('http://localhost/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const atTheIntakeDoor = (body: unknown) =>
  AI_INTAKE(
    new Request('http://localhost/api/orders/ai-intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

/** The `data` the order was created with. */
const createdOrder = () => db.order.create.mock.calls[0][0].data;
/** The `data` the lines were created with. */
const createdLines = () => db.orderItem.createMany.mock.calls[0][0].data;

/* ══════════════════════════════════════════════════════════════════════ */

describe('POST /api/orders — the quick-order form’s own body, at the real door', () => {
  it('an EMPTY price box is absent on the wire, and the door refuses it by name', async () => {
    const body = await orderBodyFor(async (user) => {
      await user.clear(priceBox());
    });

    /*
     * THE DOOR'S SENTENCE FIRST, AND THE ORDER IS DELIBERATE — it is the
     * lesson of `0aea050`'s seventh mutation, which reached only `box.value`
     * and had to be reordered so that the request's own answer prints. The
     * sentence is what a person reads: restore `Number(e.target.value) || 0`
     * and this prints `{ success: true, order: … }` — the order that got
     * written for a cleared box.
     */
    const res = await atTheOrdersDoor(body);
    expect(await res.json()).toEqual({ error: 'سعر الوحدة مطلوب' });
    expect(res.status).toBe(400);
    expect(db.order.create).not.toHaveBeenCalled();
    expect(db.orderItem.createMany).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(body.items[0], 'unitPrice')).toBe(false);
  });

  it('and THE SAME CLICK before this change wrote a FREE ORDER', async () => {
    const body = await orderBodyFor(async (user) => {
      await user.clear(priceBox());
    });

    /*
     * `Number('') || 0` is what the box used to put here. The door is
     * unchanged — only the body is — and it accepts, correctly: `min(0)` has
     * to allow a giveaway line, so the refusal was UNREACHABLE from this
     * form. A real customer, a real product, and nothing owed.
     */
    const old = await atTheOrdersDoor({
      ...body,
      items: [{ ...body.items[0], unitPrice: 0 }],
    });
    expect(old.status).toBe(200);
    expect(createdOrder().totalAmount).toBe(0);
    expect(createdOrder().sellingPrice).toBe(0);
    expect(createdLines()[0].unitPrice).toBe(0);
  });

  it('a TYPED ZERO still gets through, because a giveaway line is a real decision', async () => {
    const body = await orderBodyFor(async (user) => {
      await user.clear(priceBox());
      await user.type(priceBox(), '0');
    });
    // The characters, not a number — the door's own reader decides.
    expect(body.items[0].unitPrice).toBe('0');

    const res = await atTheOrdersDoor(body);
    expect(res.status).toBe(200);
    expect(createdLines()[0].unitPrice).toBe(0);
    expect(createdOrder().totalAmount).toBe(0);
  });

  it('a TYPED NUMBER gets through, and the money is computeCod’s', async () => {
    const body = await orderBodyFor(async (user) => {
      await user.clear(priceBox());
      await user.type(priceBox(), '25');
    });
    expect(body.items[0].unitPrice).toBe('25');
    expect(body.items[0].quantity).toBe(1);

    const res = await atTheOrdersDoor(body);
    expect(res.status).toBe(200);
    expect(createdOrder().sellingPrice).toBe(25);
    expect(createdLines()[0].unitPrice).toBe(25);
    // The one COD function, not this test's arithmetic.
    expect(createdOrder().totalAmount).toBe(
      computeCod({ lines: [{ quantity: 1, unitPrice: 25 }], minorUnit: 2 }).cod
    );
  });

  /**
   * A SECOND PIECE IS CHARGED FOR.
   *
   * The box holds the line's TOTAL, and the quantity buttons never touched
   * it: 14 for one piece, + pressed, and the order went out at 14 for two.
   * The box now follows the quantity (`atBasePrice`, see
   * `the-line-price-follows-the-quantity.test.tsx`). The door is not
   * touched — it takes the total it is sent, as it always has, which is why
   * the same click with the old body still stores 14.
   */
  it('a SECOND PIECE goes out as 28, and the door stores 28 at 14 a piece', async () => {
    const body = await orderBodyFor(async (user) => {
      await user.click(screen.getByRole('button', { name: 'زد الكمية' }));
      await waitFor(() => expect(priceBox().value).toBe('28'));
    });
    expect(body.items[0]).toEqual({ productId: PRODUCT.id, offerId: null, quantity: 2, unitPrice: '28' });
    // The same four keys as ever: the editor's own bookkeeping never leaves the screen.
    expect(Object.keys(body.items[0]).sort()).toEqual(['offerId', 'productId', 'quantity', 'unitPrice']);
    expect(body.items[0]).not.toHaveProperty('pricing');

    const res = await atTheOrdersDoor(body);
    expect(res.status).toBe(200);
    expect(createdOrder().quantity).toBe(2);
    expect(createdOrder().sellingPrice).toBe(28);
    expect(createdLines()[0].unitPrice).toBe(14);
    expect(createdOrder().totalAmount).toBe(
      computeCod({ lines: [{ quantity: 2, unitPrice: 14 }], minorUnit: 2 }).cod
    );
  });

  it('and THE SAME CLICK before this change charged two pieces as one', async () => {
    const body = await orderBodyFor(async (user) => {
      await user.click(screen.getByRole('button', { name: 'زد الكمية' }));
    });
    // `'14'` is what the box used to hold for two pieces. Same door, same
    // quantity — the door stores what it is given, so the fix is the body.
    const old = await atTheOrdersDoor({ ...body, items: [{ ...body.items[0], unitPrice: '14' }] });
    expect(old.status).toBe(200);
    expect(createdOrder().quantity).toBe(2);
    expect(createdOrder().sellingPrice).toBe(14);
    expect(createdLines()[0].unitPrice).toBe(7);
  });

  it('and a cleared box can be RETYPED — it used to redraw as 0 and read «020»', async () => {
    const user = userEvent.setup();
    render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('المنتج')).toBeTruthy());
    await user.selectOptions(screen.getByLabelText('المنتج'), PRODUCT.id);
    await waitFor(() => expect(priceBox().value).toBe('14'));

    await user.clear(priceBox());
    // THE STATE AFTER CLEARING IS THE PROOF. `Number('') || 0` wrote `0`
    // back into the box here, so the next keystroke landed beside it.
    expect(priceBox().value).toBe('');
    await user.type(priceBox(), '20');
    expect(priceBox().value).toBe('20');
    expect(priceBox().value).not.toBe('020');
  });

  it('a BRAND-NEW LINE opens with an EMPTY price box, never a 0', async () => {
    const user = userEvent.setup();
    render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('المنتج')).toBeTruthy());

    /*
     * `newLine()` ended `offer?.sellingPrice ?? product?.basePrice ?? 0`,
     * and `newLine()` WITH NO PRODUCT — which is exactly what «أضف منتجاً
     * آخر» calls — took that last branch. So every added line opened holding
     * a price of nothing-at-all drawn as `0`, and pressing حفظ sent a free
     * line the door is obliged to accept.
     *
     * The FIRST line is seeded from the catalogue (this dialog adopts the
     * only product when there is one), and 14 is the product's own base
     * price — a real figure, which is the whole distinction: a catalogue
     * number may fill a box, an invented one may not.
     */
    await waitFor(() => expect(priceBox().value).toBe('14'));

    await user.click(screen.getByText('أضف منتجاً آخر'));
    const boxes = screen.getAllByPlaceholderText('سعر السطر') as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes[0].value).toBe('14');
    expect(boxes[1].value, 'سطرٌ جديدٌ وُلِدَ بسعرٍ صفر').toBe('');
  });

  it('and «قيمة البضاعة» says «nothing written» rather than «worth nothing»', async () => {
    const user = userEvent.setup();
    render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('المنتج')).toBeTruthy());

    // An untouched form: one line, no product, no price.
    const goods = screen.getByText(/قيمة البضاعة/);
    expect(goods.textContent).toContain('—');
    expect(goods.textContent).not.toContain('0.00');
    // And the submit button does not name a price it does not have.
    expect(screen.getByText(/إنشاء الطلب/).textContent).toContain('—');

    await user.selectOptions(screen.getByLabelText('المنتج'), PRODUCT.id);
    await waitFor(() => expect(priceBox().value).toBe('14'));
    expect(screen.getByText(/قيمة البضاعة/).textContent).toContain('14.00');
  });
});

describe('POST /api/orders/ai-intake — the AI modal’s own body, at the real door', () => {
  it('an EMPTY price box is absent, and the door refuses instead of charging the base price', async () => {
    const body = await aiBodyFor({ ...PARSED, price: 20 }, async (user) => {
      await user.clear(screen.getByLabelText(/^الإجمالي/));
    });

    // The door's sentence first: restore `parseFloat(box) || 0` and this
    // prints `{ success: true, … }` for an order charged at the base price.
    const res = await atTheIntakeDoor(body);
    expect(await res.json()).toEqual({ error: 'السعر مطلوب' });
    expect(res.status).toBe(400);
    expect(db.order.create).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(body.parsed, 'finalPrice')).toBe(false);
  });

  it('and THE SAME CLICK before this change charged the PRODUCT’S BASE PRICE', async () => {
    const body = await aiBodyFor({ ...PARSED, price: 20 }, async (user) => {
      await user.clear(screen.getByLabelText(/^الإجمالي/));
    });

    /*
     * `parseFloat('') || 0` is what the box used to put here, and
     * `ai-intake/route.ts` read `p.finalPrice || product.basePrice`. So the
     * cleared box did not record a free order: it recorded an order at 14,
     * a figure the reviewer never saw and never typed.
     *
     * THAT LINE IS GONE NOW, and this test keeps its name because what it
     * measures is the gap between then and now. Two things closed it, and
     * neither was a new policy:
     *
     *   · `offers.ts` already ruled, in writing, that «a free bundle is a
     *     pricing decision», and named this very expression as the one door
     *     of four that disagreed — three gave the bundle away, this one
     *     charged the base price.
     *   · `finalPrice` is a REQUIRED field, so an absent price is refused
     *     by name (the test above). The fallback could therefore never be a
     *     safety net for a missing price; it could only ever override a
     *     zero somebody meant.
     *
     * AND A SECOND DEFECT IT CARRIED, which is why «just leave it» was the
     * wrong answer: `finalPrice` is the LINE TOTAL on this door — the typed
     * 30 below is stored as `sellingPrice: 30` for a quantity of two —
     * while `basePrice` is PER UNIT. The `||` dropped a per-unit figure
     * straight into a line-total slot, so the substituted order charged 14
     * for TWO pieces rather than 28. Not one of those three numbers was
     * asked for by anybody.
     */
    const now = await atTheIntakeDoor({
      ...body,
      parsed: { ...body.parsed, finalPrice: 0 },
    });
    expect(now.status).toBe(200);
    expect(createdOrder().sellingPrice, 'سعرُ المنتجِ عادَ ليحلَّ محلَّ صفر').not.toBe(
      PRODUCT.basePrice
    );
    expect(createdOrder().sellingPrice).toBe(0);
    expect(PRODUCT.basePrice).not.toBe(0);
    // And the unit muddle goes with it: nothing is substituted at all.
    expect(createdOrder().quantity).toBe(2);
    expect(createdOrder().sellingPrice).not.toBe(PRODUCT.basePrice * 2);
  });

  it('an EMPTY quantity box is absent, and the door names the field', async () => {
    const body = await aiBodyFor({ ...PARSED, price: 20 }, async (user) => {
      await user.clear(screen.getByLabelText('الكمية'));
    });

    const res = await atTheIntakeDoor(body);
    expect(await res.json()).toEqual({ error: 'الكمية مطلوب' });
    expect(res.status).toBe(400);
    expect(db.order.create).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(body.parsed, 'quantity')).toBe(false);
  });

  it('typed figures go through as characters, and the order is priced at what was typed', async () => {
    const body = await aiBodyFor({ ...PARSED, price: 20 }, async (user) => {
      await user.clear(screen.getByLabelText(/^الإجمالي/));
      await user.type(screen.getByLabelText(/^الإجمالي/), '30');
    });
    expect(body.parsed.finalPrice).toBe('30');
    expect(body.parsed.quantity).toBe('2');

    const res = await atTheIntakeDoor(body);
    expect(res.status).toBe(200);
    expect(createdOrder().sellingPrice).toBe(30);
    expect(createdOrder().quantity).toBe(2);
  });

  it('and a TYPED zero is written as zero, like every other door', async () => {
    const body = await aiBodyFor({ ...PARSED, price: 20 }, async (user) => {
      await user.clear(screen.getByLabelText(/^الإجمالي/));
      await user.type(screen.getByLabelText(/^الإجمالي/), '0');
    });
    // The box can now say zero, and it says zero rather than nothing.
    expect(body.parsed.finalPrice).toBe('0');

    const res = await atTheIntakeDoor(body);
    expect(res.status).toBe(200);
    /*
     * A reviewer who deliberately types 0 used to be overridden by
     * `p.finalPrice || product.basePrice`. The change that first made this
     * box able to SAY zero — rather than manufacture one from a cleared
     * field — left that override standing and called it an open decision.
     * It is closed now, against the ruling `offers.ts` already carried:
     * three doors honoured a zero and this was the fourth.
     */
    expect(createdOrder().sellingPrice).toBe(0);
    expect(createdOrder().sellingPrice).not.toBe(PRODUCT.basePrice);
  });

  /**
   * «السعر» BESIDE «الكمية» IS A QUESTION WITH TWO ANSWERS.
   *
   * The door reads this field as the LINE TOTAL: `computeCod` is handed
   * `unitPrice: price / qty`, and `offers.ts` says of the figure that
   * pre-fills it that «25 is the bundle's total, never a unit price». But
   * the box said only «السعر», sat beside a quantity of 2, and was filled
   * from sources that do not agree about units — the offer's bundle total,
   * and whatever number the parser lifted out of «السعر: 20» in a pasted
   * message, where the sender's own meaning is unknown.
   *
   * So «الكمية: ٢ · السعر: ٢٠» was confirmed as an order of 20, when 20
   * EACH was just as likely to be what the message meant.
   */
  it('names the field as the TOTAL, and says out loud how many pieces it covers', async () => {
    renderModal();
    await openForm();
    // The label itself, not a tooltip: this is what a reviewer reads.
    const box = screen.getByLabelText(/^الإجمالي/) as HTMLInputElement;
    expect(box).toBeTruthy();
    expect(screen.queryByLabelText(/^السعر/)).toBeNull();
    // And the quantity is named in words, so «٢٠ للقطعتين» cannot be read
    // as «٢٠ للقطعة».
    expect(document.body.textContent).toContain('للكمية كلّها (2 قطعة)');
    expect(document.body.textContent).toContain('لا لقطعة واحدة');
  });

  it('and for a single piece it says what the figure is, without a plural nobody needs', async () => {
    renderModal({ ...PARSED, quantity: 1 });
    await openForm();
    expect(document.body.textContent).toContain('إجمالي ما يُحصَّل عن هذا السطر');
    expect(document.body.textContent).not.toContain('لا لقطعة واحدة');
  });

  /**
   * AND CHANGING THE PRODUCT NO LONGER INVENTS A PRICE.
   *
   * This read `prod.offers[0].sellingPrice`, which is the figure BEFORE the
   * reduction — `/api/products` selects `id, name, quantity, sellingPrice,
   * status` and NOT `discount`, so the number cannot be made right from
   * what the screen is given. An offer of 25 with a discount of 3 put 25 in
   * the box while the landing page, the cart quote and this door's own
   * suggestion all charge 22: the defect `ai-intake-discount.test.ts`
   * exists for, surviving on a second path that reaches a different
   * endpoint for a raw column.
   */
  it('clears the price when the product changes, rather than filling in a pre-discount figure', async () => {
    apiJson.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/products')) {
        return {
          products: [
            PRODUCT,
            {
              ...PRODUCT,
              id: 'prod-bbbbbbbbbb',
              name: 'غسول',
              // Exactly what the endpoint returns: no `discount` column.
              offers: [{ id: 'off-1', name: 'قطعتان', quantity: 2, sellingPrice: 25, status: 'ACTIVE' }],
            },
          ],
        };
      }
      if (path.startsWith('/api/geo/regions')) {
        return {
          country: { name: 'سوريا', currencyCode: 'JOD', minorUnit: 2 },
          regions: [{ id: '11111111-1111-4111-8111-111111111111', name: 'دمشق' }],
        };
      }
      return {};
    });

    const user = renderModal({ ...PARSED, price: 20 });
    await openForm();
    const box = () => screen.getByLabelText(/^الإجمالي/) as HTMLInputElement;
    await user.clear(box());
    await user.type(box(), '20');
    expect(box().value).toBe('20');

    await user.selectOptions(screen.getByLabelText('المنتج'), 'prod-bbbbbbbbbb');

    // 25 is the offer's listed price; every other door charges 22 for it.
    expect(box().value, 'سعرٌ ما قبلَ الخصمِ كُتِبَ في الخانة').not.toBe('25');
    expect(box().value).toBe('');
    // And the button stops naming a figure the form no longer holds.
    expect(screen.getByText(/تسجيل الطلب/).textContent).toContain('—');
  });

  it('and the button never names a price the form does not hold', async () => {
    const user = userEvent.setup();
    apiFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            // The parser found no price at all, which is `price: null`.
            parsed: { ...PARSED, price: null },
            engine: 'parser',
            matchedProduct: { id: PRODUCT.id, name: PRODUCT.name, score: 1 },
            productMatchConfident: true,
            suggestedPrice: null,
            suggestedOfferName: null,
            existingCustomer: null,
          }),
          { status: 200 }
        )
    );
    render(<AiOrderModal isOpen onClose={() => {}} onSuccess={() => {}} />);
    await user.type(screen.getByRole('textbox'), 'الاسم: عبدالله');
    await user.click(screen.getByText(/تحليل الطلب بالذكاء الاصطناعي/));
    await waitFor(() => expect(screen.getByLabelText('الكمية')).toBeTruthy());

    // `?? 0` opened this box at 0 and the button read «تسجيل الطلب (0.00)».
    expect((screen.getByLabelText(/^الإجمالي/) as HTMLInputElement).value).toBe('');
    const btn = screen.getByText(/تسجيل الطلب/);
    expect(btn.textContent).toContain('—');
    expect(btn.textContent).not.toContain('0.00');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AND THE SELLER IS TOLD WHEN THE CAP TOOK HER ORDER.
 *
 * An agent keeps the orders she enters — unless she is already holding
 * 120, in which case the entry goes to the shared queue instead. The door
 * returns `notice` for exactly that case, and the first version of this
 * work had both windows ignore it: she read «تم إنشاء الطلب», went to
 * «طلباتي», and the order was not there.
 *
 * `warn` and not `done`: the order WAS created. What failed is the
 * assumption that it is hers.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('the cap notice reaches the seller', () => {
  const NOTICE = 'وصلت للحد (120) — الطلب راح للطابور';

  it('the quick-entry window says it', async () => {
    const user = userEvent.setup();
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/orders') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ success: true, order: { id: 'o1', orderNumber: 'ORD-9' }, notice: NOTICE }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('المنتج')).toBeTruthy());
    await user.type(screen.getByPlaceholderText('مثال: عبدالله عبدالقادر'), 'عبدالله');
    await user.type(screen.getByPlaceholderText('مثال: 0936654998'), '0936654998');
    await user.type(screen.getByPlaceholderText('الشارع، البناء، المنطقة...'), 'بانياس');
    await user.selectOptions(screen.getByLabelText('المحافظة'), '11111111-1111-4111-8111-111111111111');
    await user.selectOptions(screen.getByLabelText('المنتج'), PRODUCT.id);
    await waitFor(() => expect(priceBox().value).toBe('14'));
    await user.click(screen.getByText(/إنشاء الطلب/));

    await waitFor(() =>
      expect(toastWarn, 'ما قالت للبائعة إنّ الطلب راح للطابور').toHaveBeenCalled()
    );
    expect(String(toastWarn.mock.calls[0][0])).toContain(NOTICE);
    expect(toastDone, 'قالت «تمّ» عن طلبٍ ليس لها').not.toHaveBeenCalled();
  });

  it('and the extractor window says the same thing', async () => {
    const user = userEvent.setup();
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.confirm) {
        return new Response(
          JSON.stringify({ success: true, order: { id: 'o1' }, notice: NOTICE }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          parsed: PARSED,
          engine: 'parser',
          matchedProduct: { id: PRODUCT.id, name: PRODUCT.name, score: 1 },
          productMatchConfident: true,
          suggestedPrice: null,
          suggestedOfferName: null,
          existingCustomer: null,
        }),
        { status: 200 }
      );
    });
    render(<AiOrderModal isOpen onClose={() => {}} onSuccess={() => {}} />);
    await user.type(screen.getByRole('textbox'), 'الاسم: عبدالله');
    await user.click(screen.getByText(/تحليل الطلب بالذكاء الاصطناعي/));
    await waitFor(() => expect(screen.getByLabelText('الكمية')).toBeTruthy());
    await user.click(screen.getByText(/تسجيل الطلب/));

    await waitFor(() =>
      expect(toastWarn, 'المستخرج ما قال للبائعة وين راح الطلب').toHaveBeenCalled()
    );
    expect(String(toastWarn.mock.calls[0][0])).toContain(NOTICE);
  });

  it('and says nothing extra when the order IS hers', async () => {
    // No notice means the ordinary path: one «تمّ», no warning.
    const user = userEvent.setup();
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/orders') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ success: true, order: { id: 'o1', orderNumber: 'ORD-9' } }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    render(<CreateOrderModal isOpen onClose={() => {}} onSuccess={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('المنتج')).toBeTruthy());
    await user.type(screen.getByPlaceholderText('مثال: عبدالله عبدالقادر'), 'عبدالله');
    await user.type(screen.getByPlaceholderText('مثال: 0936654998'), '0936654998');
    await user.type(screen.getByPlaceholderText('الشارع، البناء، المنطقة...'), 'بانياس');
    await user.selectOptions(screen.getByLabelText('المحافظة'), '11111111-1111-4111-8111-111111111111');
    await user.selectOptions(screen.getByLabelText('المنتج'), PRODUCT.id);
    await waitFor(() => expect(priceBox().value).toBe('14'));
    await user.click(screen.getByText(/إنشاء الطلب/));

    await waitFor(() => expect(toastDone).toHaveBeenCalled());
    expect(toastWarn, 'حذّرت عن طلبٍ لم يُؤخَذ منها').not.toHaveBeenCalled();
  });
});
