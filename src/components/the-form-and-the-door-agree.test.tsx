// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * THE ROUND TRIP: THE BODY THE FORM SENDS, HANDED TO THE REAL DOOR.
 *
 * `0aea050` put a refusal behind `POST /api/production` and
 * `POST /api/orders/[id]/shipping`, and the browser was swallowing it
 * before it could fire — `parseFloat(…) || 0` and
 * `deliveryFee ? Number(deliveryFee) : 0` could only ever produce a number
 * the door is obliged to accept. Two test files assert what the forms now
 * put on the wire; two others assert what the doors do with a value. This
 * one JOINS THEM: it renders the real form, captures the body it actually
 * sent, and feeds that exact body to the real route handler.
 *
 * A fix that makes the form honest but never shows the refusal reaching it
 * is half a fix — so what is proved here is the whole trip:
 *
 *   · an empty quantity box    → the field is absent → 400 «الكمية المنتجة مطلوب»
 *   · a negative cost box      → the characters      → 400 «كلفة التصنيع: 0 على الأقل»
 *   · a filled form            → 200, and the batch Prisma is handed
 *   · an empty cost box        → absent → the column's own 0, and `costPerUnit` still right
 *   · an empty delivery fee    → `null` → NULL stored, NOT a free delivery
 *   · a typed delivery fee 0   → `0` stored, because a zero fee is policy
 *   · a negative delivery fee  → 400 «رسوم التوصيل: 0 على الأقل»
 */

/* ── the doors' dependencies ───────────────────────────────────────────── */

const { db, requireContext, requirePermission, assertOrderAccess, authorize, can, logAudit } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    product: { findFirst: vi.fn() },
    productionBatch: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    inventoryMovement: { create: vi.fn() },
    $transaction: vi.fn(),
    // 19/11 (W2a): the production run is ONE transaction now — it takes the product's stock lock and asks «is this store
    // placed in warehouses?» (never, here) through the transaction it is handed.
    $executeRaw: async () => 1,
    warehousePlacement: { findUnique: async () => null },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  assertOrderAccess: vi.fn(),
  authorize: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  authorize: (...a: unknown[]) => authorize(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/rbac', () => ({
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, FORBIDDEN: 403 },
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/delivery-attempts', () => ({ appendDeliveryAttempt: vi.fn() }));

/* ── the screens' dependencies ─────────────────────────────────────────── */

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar' }) }));
vi.mock('@/components/ui/ProductPicker', () => ({
  ProductPicker: ({ value }: { value: string }) => <div data-testid="picker">{value}</div>,
}));
vi.mock('@/components/production/BatchCostDialog', () => ({ BatchCostDialog: () => null }));

import { POST as PRODUCTION } from '@/app/api/production/route';
import { POST as SHIPPING } from '@/app/api/orders/[id]/shipping/route';
import { ManufacturingScreen } from '@/components/screens/ManufacturingScreen';
import { ShippingSection } from '@/components/orders/ShippingSection';
import { batchUnitCost } from '@/lib/product-cost';

/** `productId: z.string().min(10)`, so the fixture carries a real-length id. */
const PRODUCT = {
  id: 'prod-aaaaaaaaaa',
  name: 'كريم',
  sku: 'KR-1',
  sourceType: 'MANUFACTURED',
  basePrice: 10,
  companyId: 'c1',
};

const ORDER = {
  id: 'ord-1',
  orderNumber: 'SY-2026-0001',
  version: 7,
  shippingStatus: 'READY_FOR_SHIPPING',
  deliveryProviderId: null,
  deliveryProvider: null,
  shippingBatch: null,
  trackingNumber: null,
  deliveryFee: null,
  shippedAt: null,
  outForDeliveryAt: null,
  deliveredAt: null,
  storeId: 's1',
  lockedById: null,
  lockExpiresAt: null,
  totalAmount: 25_000,
  currency: 'SYP',
  priceIncludesDelivery: false,
};

/** Every non-GET body a screen sent, in order. */
let sent: { url: string; body: any }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'OPS', name: 'سامر' },
    companyId: 'c1',
    storeId: 's1',
    country: { allowNegativeStock: false, minorUnit: 2, currencyCode: 'SYP' },
  });
  requirePermission.mockResolvedValue(undefined);
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER } });
  authorize.mockReturnValue({ allowed: true });
  can.mockReturnValue(true);
  db.productionBatch.findUnique.mockResolvedValue(null);
  // What `onHandTotal` answers for a product with no batches yet. The
  // production door takes the ledger line's `balanceAfter` from it now,
  // instead of writing the run's own quantity into the balance column.
  db.productionBatch.aggregate.mockResolvedValue({ _sum: { quantityRemaining: null } });
  db.product.findFirst.mockResolvedValue({ ...PRODUCT });
  db.productionBatch.create.mockImplementation(async ({ data }: any) => ({ id: 'batch-1', ...data }));
  db.inventoryMovement.create.mockResolvedValue({});
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ ...ORDER });
  db.$transaction.mockImplementation(async (fn: any) => fn({ order: db.order, productionBatch: db.productionBatch, inventoryMovement: db.inventoryMovement, warehousePlacement: db.warehousePlacement, $executeRaw: db.$executeRaw }));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        // The screens only need a shape back; the DOOR's answer is taken
        // from the real handler below, not from this stub.
        return new Response(JSON.stringify({ order: { version: 8 }, success: true, batch: { id: 'b' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('/api/products')) {
        return new Response(JSON.stringify({ products: [PRODUCT] }), { status: 200 });
      }
      if (url.includes('delivery-attempts')) return new Response(JSON.stringify({ attempts: [] }), { status: 200 });
      if (url.includes('delivery-providers')) return new Response(JSON.stringify({ providers: [] }), { status: 200 });
      return new Response(JSON.stringify({ batches: [], currency: 'SYP' }), { status: 200 });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ── driving the two forms ─────────────────────────────────────────────── */

const QTY = 'الكمية المنتَجة (قطعة) *';
const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

/** Fill the production form as described and return THE BODY IT SENT. */
async function productionBodyFor(fill: (u: ReturnType<typeof userEvent.setup>) => Promise<void>) {
  const user = userEvent.setup();
  render(<ManufacturingScreen />);
  await waitFor(() => expect(screen.getByText('لا تشغيلاتِ إنتاجٍ بعد')).toBeTruthy());
  await user.click(screen.getByText('تشغيلة جديدة'));
  await waitFor(() => expect(screen.getByTestId('picker').textContent).toBe(PRODUCT.id));
  await fill(user);
  // `required` on the quantity box is the browser's own guard; the door is
  // what is being tested, so the submit is driven the way a client without
  // constraint validation drives it.
  const saveBtn = screen.getByText('احفظ الدفعة وأضفها للمخزون');
  (saveBtn.closest('form') as HTMLFormElement).noValidate = true;
  await user.click(saveBtn);
  await waitFor(() => expect(sent).toHaveLength(1));
  return sent[0].body;
}

/** Fill the tracking form as described and return THE BODY IT SENT. */
async function trackingBodyFor(order: any, fill: (u: ReturnType<typeof userEvent.setup>) => Promise<void>) {
  const user = userEvent.setup();
  render(<ShippingSection order={order} ar isRtl onRefreshOrder={() => {}} />);
  await waitFor(() => expect(screen.getByText('الشحن والتوصيل')).toBeTruthy());
  await user.click(screen.getByRole('button', { name: /رقم التتبع/ }));
  await waitFor(() => expect(screen.getByLabelText('رسوم التوصيل ($)')).toBeTruthy());
  await fill(user);
  await user.click(screen.getByText('حفظ'));
  await waitFor(() => expect(sent).toHaveLength(1));
  return sent[0].body;
}

/* ── handing the captured body to the real door ────────────────────────── */

const atProductionDoor = (body: unknown) =>
  PRODUCTION(
    new Request('http://localhost/api/production', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const atShippingDoor = (body: unknown) =>
  SHIPPING(
    new Request('http://localhost/api/orders/ord-1/shipping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'ord-1' }) }
  );

/** The `data` the batch was created with. */
const createdBatch = () => db.productionBatch.create.mock.calls[0][0].data;
/** The `data` the order was updated with. */
const savedOrder = () => db.order.updateMany.mock.calls[0][0].data;

/* ══════════════════════════════════════════════════════════════════════ */

describe('POST /api/production — the form’s own body, at the real door', () => {
  it('an untouched form is refused, and the sentence is «you did not fill it in»', async () => {
    const body = await productionBodyFor(async () => {});

    /*
     * THE DOOR'S SENTENCE FIRST, AND THE ORDER IS DELIBERATE — it is the
     * lesson of `0aea050`'s seventh mutation, which reached only
     * `box.value` and had to be reordered to print the request body. The
     * sentence is what a person reads: restore `parseInt(…, 10) || 0` and
     * this prints «الكمية المنتجة: 1 على الأقل» — a lower bound, about a box
     * that was never filled in.
     */
    const res = await atProductionDoor(body);
    expect(await res.json()).toEqual({ error: 'الكمية المنتجة مطلوب' });
    expect(res.status).toBe(400);
    expect(Object.prototype.hasOwnProperty.call(body, 'quantityProduced')).toBe(false);
    expect(db.productionBatch.create).not.toHaveBeenCalled();

    /*
     * AND THE SAME CLICK BEFORE THIS CHANGE. The browser held
     * `useState(1000)`, `2500`, `800`, `700`, `0`, so the body was complete
     * and the door — rightly — accepted it. This is the refusal that was
     * unreachable, replayed: the door is unchanged, only the body is.
     */
    vi.clearAllMocks();
    requireContext.mockResolvedValue({
      user: { id: 'u1', role: 'OPS', name: 'سامر' },
      companyId: 'c1',
      storeId: 's1',
      country: { allowNegativeStock: false, minorUnit: 2, currencyCode: 'SYP' },
    });
    requirePermission.mockResolvedValue(undefined);
    db.productionBatch.findUnique.mockResolvedValue(null);
    db.product.findFirst.mockResolvedValue({ ...PRODUCT });
    db.productionBatch.create.mockImplementation(async ({ data }: any) => ({ id: 'batch-1', ...data }));
    const old = await atProductionDoor({
      ...body,
      quantityProduced: 1000,
      manufacturingCost: 2500,
      packagingCost: 800,
      rawMaterialCost: 700,
      otherCosts: 0,
    });
    expect(old.status).toBe(200);
    expect(createdBatch().costPerUnit).toBe(4);
    // Four units of cost per unit of stock, from five numbers nobody typed.
  });

  it('a negative cost box is refused by name, and nothing is written', async () => {
    const body = await productionBodyFor(async (user) => {
      await user.type(box(QTY), '1000');
      await user.type(box('كلفة التصنيع'), '-500');
    });
    expect(body.manufacturingCost).toBe('-500');

    const res = await atProductionDoor(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'كلفة التصنيع: 0 على الأقل' });
    expect(db.productionBatch.create).not.toHaveBeenCalled();
  });

  it('a filled form is accepted, and the figures Prisma gets are the figures on screen', async () => {
    const body = await productionBodyFor(async (user) => {
      await user.type(box(QTY), '1000');
      await user.type(box('كلفة التصنيع'), '2500');
      await user.type(box('كلفة التغليف'), '500');
    });
    // Three keys present, two absent — the characters, not numbers.
    expect(body.quantityProduced).toBe('1000');
    expect(body.manufacturingCost).toBe('2500');
    expect(body.packagingCost).toBe('500');
    expect(Object.prototype.hasOwnProperty.call(body, 'rawMaterialCost')).toBe(false);

    const res = await atProductionDoor(body);
    expect(res.status).toBe(200);
    const saved = createdBatch();
    expect(saved.quantityProduced).toBe(1000);
    expect(saved.manufacturingCost).toBe(2500);
    expect(saved.packagingCost).toBe(500);
    // THE ABSENT ONES TOOK THE DOOR'S OWN DEFAULT, declared once in
    // `createSchema` over a `Float @default(0)` NOT NULL column — not a
    // `?? 0` in a browser.
    expect(saved.rawMaterialCost).toBe(0);
    expect(saved.otherCosts).toBe(0);
    expect(saved.totalProductionCost).toBe(3000);
    expect(saved.costPerUnit).toBe(3);
    // And it is the number the screen printed, from the same function.
    expect(batchUnitCost(3000, 1000)).toBe(3);
  });

  it('a typed zero is accepted as zero, so «this run had no packaging cost» is sayable', async () => {
    const body = await productionBodyFor(async (user) => {
      await user.type(box(QTY), '100');
      await user.type(box('كلفة التصنيع'), '100');
      await user.type(box('كلفة التغليف'), '0');
    });
    expect(body.packagingCost).toBe('0');

    const res = await atProductionDoor(body);
    expect(res.status).toBe(200);
    expect(createdBatch().packagingCost).toBe(0);
    expect(createdBatch().costPerUnit).toBe(1);
  });

  it('and a named cost line with no amount is refused, not counted as nothing', async () => {
    const body = await productionBodyFor(async (user) => {
      await user.type(box(QTY), '100');
      await user.selectOptions(screen.getByDisplayValue('+ أضف بنداً…'), 'قالب');
    });
    expect(body.costLines).toEqual([{ label: 'قالب' }]);

    const res = await atProductionDoor(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'المبلغ مطلوب' });
    expect(db.productionBatch.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/orders/[id]/shipping — the tracking form’s own body, at the real door', () => {
  it('an EMPTY fee box writes NULL, not a free delivery', async () => {
    const body = await trackingBodyFor({ ...ORDER, deliveryFee: 5 }, async (user) => {
      await user.clear(box('رسوم التوصيل ($)'));
    });
    expect(body.deliveryFee).toBeNull();

    const res = await atShippingDoor(body);
    expect(res.status).toBe(200);
    expect(savedOrder().deliveryFee).toBeNull();

    /*
     * AND WHAT THE OLD BROWSER SENT FOR THE SAME CLICK — `0`. The door
     * accepts it, because a zero fee is a real policy it cannot refuse, and
     * `settlement.ts` then deducts a fee of nothing from the courier: a
     * 25,000 collection settles at 25,000 instead of at 25,000 less the fee
     * nobody recorded.
     */
    vi.clearAllMocks();
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, deliveryFee: 5 } });
    authorize.mockReturnValue({ allowed: true });
    can.mockReturnValue(true);
    requireContext.mockResolvedValue({
      user: { id: 'u1', role: 'OPS', name: 'سامر' },
      companyId: 'c1',
      storeId: 's1',
      country: { allowNegativeStock: false, minorUnit: 2, currencyCode: 'SYP' },
    });
    db.order.updateMany.mockResolvedValue({ count: 1 });
    db.order.findUnique.mockResolvedValue({ ...ORDER });
    db.$transaction.mockImplementation(async (fn: any) => fn({ order: db.order, productionBatch: db.productionBatch, inventoryMovement: db.inventoryMovement, warehousePlacement: db.warehousePlacement, $executeRaw: db.$executeRaw }));
    const old = await atShippingDoor({ ...body, deliveryFee: 0 });
    expect(old.status).toBe(200);
    expect(savedOrder().deliveryFee).toBe(0);
  });

  it('a typed ZERO writes 0, which is a different thing from NULL', async () => {
    const body = await trackingBodyFor({ ...ORDER }, async (user) => {
      await user.type(box('رسوم التوصيل ($)'), '0');
    });
    expect(body.deliveryFee).toBe('0');

    const res = await atShippingDoor(body);
    expect(res.status).toBe(200);
    expect(savedOrder().deliveryFee).toBe(0);
    expect(savedOrder().deliveryFee).not.toBeNull();
  });

  it('a typed NUMBER writes that number', async () => {
    const body = await trackingBodyFor({ ...ORDER }, async (user) => {
      await user.type(box('رسوم التوصيل ($)'), '1500');
    });
    expect(body.deliveryFee).toBe('1500');

    const res = await atShippingDoor(body);
    expect(res.status).toBe(200);
    expect(savedOrder().deliveryFee).toBe(1500);
    // The settlement arithmetic the figure is for.
    expect(25_000 - 1_500).toBe(23_500);
  });

  it('and a NEGATIVE fee is refused by name, with nothing written', async () => {
    const body = await trackingBodyFor({ ...ORDER }, async (user) => {
      await user.type(box('رسوم التوصيل ($)'), '-5');
    });
    expect(body.deliveryFee).toBe('-5');

    const res = await atShippingDoor(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'رسوم التوصيل: 0 على الأقل' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});
