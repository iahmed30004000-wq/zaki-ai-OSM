import { beforeEach, describe, expect, it, vi } from 'vitest';
import { count, money as amount } from '@/lib/numeric-input';

/**
 * ONE COLUMN, TWO DOORS, TWO NOTATIONS — THE SHAPE `82ecac3` CLOSED FOR THE
 * COMMISSION RATE, STILL OPEN ON THE ORDER'S OWN COLUMNS.
 *
 * `POST /api/orders` reads `quantity` and `unitPrice` through `count()` and
 * `money()` from `numeric-input`. `PATCH /api/orders/[id]` read THE SAME
 * COLUMNS — `quantity`, `unitPrice`, `sellingPrice`, `discountAmount`,
 * `shippingCost` — through `z.coerce.number()`, which is `Number(value)`.
 *
 * So, measured: `'0x10'` was sixteen units or sixteen dinars on the edit
 * door and a 400 on the create door. `'0b11'` was three. `''` and `null`
 * and `[]` were zero. The caps caught none of them, because sixteen is a
 * perfectly ordinary number inside `[1, 999]`.
 *
 * TWO BOUNDS DIVERGED AS WELL, and only one of them is closed here:
 *
 *   · `quantity` was `max(10000)` on this door and `count(999, 1)` on the
 *     create door — a ceiling eleven times higher, declared nowhere else,
 *     and reachable only through this door since nothing could be CREATED
 *     above 999. Narrowed to 999. Measured against the database first: the
 *     largest quantity on any of the 56 orders is 3.
 *   · `shippingCost` was `max(1000)` here, copied from the create door.
 *     That is deliberately NOT what it is now: see the docblock in the
 *     route. 1000 cannot hold a shipping fee in Syrian pounds, and this is
 *     the door a real fee is corrected on. The remaining disagreement with
 *     the create door is named in the report rather than hidden.
 *
 * THE ROW HANDED TO PRISMA IS ASSERTED BEFORE THE STATUS, so a regression
 * prints the figure that was stored and not «200 instead of 400».
 */

const { db, requireContext, authorize, can, getPermissionScope, logAudit, notify } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    // `findMany`: the shorthand reads the order's line rows before it writes the columns (30/10); this order has none.
    orderItem: { findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    orderAddOn: { findMany: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    region: { findFirst: vi.fn() },
    customer: { findFirst: vi.fn(), update: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderChangeRequest: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  authorize: vi.fn(),
  can: vi.fn(),
  getPermissionScope: vi.fn(),
  logAudit: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/authorization', () => ({
  authorize: (...a: unknown[]) => authorize(...a),
  can: (...a: unknown[]) => can(...a),
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
}));
vi.mock('@/lib/rbac', () => ({
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, FORBIDDEN: 403 },
  assertOrderAccess: async () => ({ allowed: true, order: ORDER }),
  assertOrderReadable: async () => ({ allowed: true }),
  orderVisibilityWhere: () => ({}),
}));

const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const PRODUCT_ID = 'prod-000000001';

/** An order still on our own floor, so its lines are editable. */
const ORDER = {
  id: ORDER_ID,
  companyId: 'c1',
  storeId: 's1',
  countryId: 'co1',
  customerId: 'cu1',
  productId: PRODUCT_ID,
  productNameSnapshot: 'كريم مرطّب',
  version: 3,
  quantity: 2,
  sellingPrice: 25_000,
  shippingCost: 0,
  discountAmount: 0,
  totalAmount: 25_000,
  priceIncludesDelivery: false,
  status: 'CONFIRMED',
  /*
   * IN_PROGRESS, NOT CONFIRMED — and the change is the rule, not this file.
   *
   * Since «بعد التأكيد: التعديل بطلب», a direct edit of a customer or line
   * field on a CONFIRMED order is refused with `CHANGE_REQUEST_REQUIRED`
   * and goes through the change-request pipeline instead. This file's
   * subject is the money arithmetic on an edit, which is the same whichever
   * door the edit came through, so the order is put where a direct edit is
   * still right: still being worked on.
   */
  confirmationStatus: 'IN_PROGRESS',
  shippingStatus: 'NOT_READY',
  settlementStatus: 'PENDING',
  claimedById: null,
  channelId: null,
  lockedById: null,
  lockExpiresAt: null,
  shippedAt: null,
};

import { PATCH } from './[id]/route';

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );

/** The `data` the order was updated with — or undefined if it never was. */
const savedRow = (): Record<string, any> | undefined =>
  db.order.updateMany.mock.calls[0]?.[0]?.data;

/** One column of that row as a string a failure message can print. */
const stored = (column: string): string | undefined => {
  const v = savedRow()?.[column];
  return v === undefined || v === null ? undefined : String(v);
};

/** What a company-wide edit must say; see order-edit-reason.ts. */
const WHY = { reason: 'تصحيح بعد مكالمة مع شركة التوصيل' };
const edit = (fields: Record<string, unknown>) => patch({ expectedVersion: 3, ...WHY, ...fields });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سارة', role: 'MANAGER' },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'SY', minorUnit: 2, currencyCode: 'SYP' },
  });
  authorize.mockReturnValue({ allowed: true });
  can.mockReturnValue(true);
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  db.order.findUnique.mockResolvedValue(ORDER);
  db.orderAddOn.findMany.mockResolvedValue([]);
  db.orderItem.findFirst.mockResolvedValue(null);
  // No line rows: an order whose columns are its only record, where the single-line shorthand still edits the order.
  db.orderItem.findMany.mockResolvedValue([]);
  db.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, name: 'كريم مرطّب' });
  db.product.findMany.mockResolvedValue([{ id: PRODUCT_ID, name: 'كريم مرطّب' }]);
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.update.mockResolvedValue(ORDER);
  db.$transaction.mockImplementation(async (fn: never) =>
    typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn
  );
});

/* ─────────── what the two doors answered for one column, side by side ───── */

describe('the create door and the edit door, asked the same question', () => {
  /** The create door's readers, imported rather than described. */
  const createQuantity = count(999, 1);
  const createUnitPrice = amount(100_000);

  it('disagreed about what a quantity is', () => {
    expect(createQuantity.safeParse('0x10').success, 'create door accepted 0x10').toBe(false);
    // And what the edit door did with the same string, replayed:
    const old = { quantity: Number('0x10') };
    expect(old.quantity, 'the edit door read sixteen units').toBe(16);
  });

  it('and about what a price is', () => {
    expect(createUnitPrice.safeParse('0x10').success).toBe(false);
    expect(Number('0x10')).toBe(16);
    expect(Number('0b11')).toBe(3);
    expect(Number('0o17')).toBe(15);
    expect(Number('')).toBe(0);
    expect(Number(null)).toBe(0);
    expect(Number([])).toBe(0);
  });
});

/* ──────────────────────── the edit door, as it stands ───────────────────── */

describe('a quantity written in a notation nobody meant', () => {
  it('never reaches the row, where it used to arrive as sixteen units', async () => {
    const res = await edit({ quantity: '0x10' });
    expect(stored('quantity'), 'كميّةٌ لم يَكتُبْها أحدٌ وَصَلَت الصفَّ').toBeUndefined();
    expect(savedRow(), 'الطلبُ عُدِّلَ بكميّةٍ ست عشريّة').toBeUndefined();
    expect(res.status).toBe(400);
  });

  it('nor does the binary one, which was three', async () => {
    const res = await edit({ quantity: '0b11' });
    expect(stored('quantity')).toBeUndefined();
    expect(res.status).toBe(400);
  });

  it('and a quantity that really is a number still edits the order', async () => {
    const res = await edit({ quantity: 4 });
    expect(stored('quantity'), 'كميّةٌ صحيحةٌ لم تُكتَب').toBe('4');
    expect(res.status).toBe(200);
  });

  /**
   * THE BOUND THAT DIVERGED. 1000 was accepted here and refused on the
   * create door; it is refused on both now.
   */
  it('and a thousand units is refused here as it is on the create door', async () => {
    const res = await edit({ quantity: 1000 });
    expect(stored('quantity'), 'ألفُ وحدةٍ عَبَرَت سقفَ بابِ الإنشاء').toBeUndefined();
    expect(res.status).toBe(400);
    expect(count(999, 1).safeParse(1000).success, 'the create door accepts 1000').toBe(false);
  });

  it('and nine hundred and ninety-nine is accepted on both', async () => {
    expect(count(999, 1).safeParse(999).success).toBe(true);
    const res = await edit({ quantity: 999 });
    expect(stored('quantity')).toBe('999');
    expect(res.status).toBe(200);
  });
});

describe('a price written in a notation nobody meant', () => {
  it('never reaches the row', async () => {
    const res = await edit({ sellingPrice: '0x10' });
    expect(stored('sellingPrice'), 'سعرٌ ست عشريٌّ وَصَلَ الصفَّ').toBeUndefined();
    expect(savedRow()).toBeUndefined();
    expect(res.status).toBe(400);
  });

  it('and neither does a discount', async () => {
    const res = await edit({ discountAmount: '0b11' });
    expect(stored('discountAmount')).toBeUndefined();
    expect(res.status).toBe(400);
  });

  it('and neither does a line of an explicit items[] set', async () => {
    const res = await edit({ items: [{ productId: PRODUCT_ID, quantity: 1, unitPrice: '0x10' }] });
    expect(savedRow(), 'بندٌ بسعرٍ ست عشريٍّ وَصَلَ الصفَّ').toBeUndefined();
    expect(db.orderItem.createMany).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it('and a line quantity in one is refused too', async () => {
    const res = await edit({ items: [{ productId: PRODUCT_ID, quantity: '0b11', unitPrice: 100 }] });
    expect(savedRow()).toBeUndefined();
    expect(res.status).toBe(400);
  });

  it('and a real price still edits the order and rebuilds the total', async () => {
    const res = await edit({ sellingPrice: 30_000 });
    expect(stored('sellingPrice'), 'سعرٌ صحيحٌ لم يُكتَب').toBe('30000');
    expect(stored('totalAmount')).toBe('30000');
    expect(res.status).toBe(200);
  });
});

/**
 * THE SHIPPING FEE, AND THE BOUND THIS DOOR DOES NOT SHARE.
 *
 * The create door caps it at 1000. This system will run Syrian pounds,
 * where a shipping fee is tens of thousands, and this is the door an
 * operator corrects a real fee on after the courier tells them what it was.
 * 1_000_000 is borrowed from `PATCH /api/orders/[id]/shipping`, which
 * declares `deliveryFee: money(1_000_000)` for the same economic quantity.
 */
describe('a shipping fee', () => {
  it('is refused when it is a notation rather than a number', async () => {
    const res = await edit({ shippingCost: '0x10' });
    expect(stored('shippingCost'), 'أجرةُ شحنٍ ست عشريّةٌ وَصَلَت الصفَّ').toBeUndefined();
    expect(res.status).toBe(400);
  });

  it('and a real Syrian fee of 25,000 is now writable, which 1000 refused', async () => {
    expect(amount(1000).safeParse(25_000).success, 'the create door accepts 25000').toBe(false);
    const res = await edit({ shippingCost: 25_000 });
    expect(stored('shippingCost'), 'أجرةٌ حقيقيّةٌ رُفِضَت').toBe('25000');
    expect(res.status).toBe(200);
  });

  it('and the ceiling is real: a million and one is refused', async () => {
    const res = await edit({ shippingCost: 1_000_001 });
    expect(stored('shippingCost')).toBeUndefined();
    expect(res.status).toBe(400);
  });
});
