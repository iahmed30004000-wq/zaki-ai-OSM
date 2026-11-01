import { describe, expect, it, vi } from 'vitest';
import {
  MIGRATION_SOURCE,
  matchKey,
  planMigration,
  readMigrationSheet,
  shippedAt,
  summarize,
  writeMigratedOrder,
  type Known,
  type Lookups,
  type SourceRow,
  type WriteDeps,
} from './order-migration';

/**
 * «ترحيل طلبات قديمة» — the owner's ruling, word for word:
 *   · «المكرر بـOrder Number ورقم الهاتف بيتخطّى»
 *   · «الو دليفيري بينحفظ بشركته مش الباشا»
 *   · «الصفوف بلا سعر بتنرفض وبتنذكر»
 *   · and the figures are the sheet's: the amount, the day, the order number — confirmed and shipped, and the stock
 *     held ONCE.
 * Every name and phone below is invented.
 */

const HEADER = ['Order Number', 'Customer Name', 'Phone Number', 'Address', 'Region Name', 'Shipping Company', 'Total Price', 'Product Name', 'Quantity'];
const r = (ref: string, phone: string, product: string, qty: string, total: string, courier = 'الباشا', region = 'حمص') =>
  [ref, 'زبون تجريبي', phone, 'شارع تجريبي', region, courier, total, product, qty];

describe('reading a sheet', () => {
  const sheet = [HEADER, r('12345', '0912345678', 'ماء الكمأ', '3.0', '25.0'), ['', '', '', '', '', '', '', '', ''], r('12346.0', '0933333333', 'كريم حرير', '1.0', '')];
  const read = readMigrationSheet(sheet, 'طلبات 22-10.xlsx', '2026-10-22');

  it('reads every non-blank row, numbered as the spreadsheet numbers it (the header is line 1, a blank line still counts)', () => {
    expect(read.missing).toEqual([]);
    expect(read.rows.map((x) => x.line)).toEqual([2, 4]);
  });

  it('keeps the sheet’s figures: three units for 25 (the gift is a unit), the order number without a trailing «.0»', () => {
    expect(read.rows[0]).toMatchObject({ ref: '12345', quantity: 3, total: 25, product: 'ماء الكمأ', courier: 'الباشا', date: '2026-10-22' });
    expect(read.rows[1].ref).toBe('12346');
  });

  it('an empty price is null — never a zero that would be written as a free order', () => {
    expect(read.rows[1].total).toBeNull();
  });

  it('NEGATIVE: a sheet without the columns the door needs says which, and gives no rows', () => {
    const bad = readMigrationSheet([['Customer Name', 'Phone Number'], ['x', '0912345678']], 'x.xlsx', '2026-10-22');
    expect(bad.rows).toEqual([]);
    expect(bad.missing).toEqual(expect.arrayContaining(['رقم الطلب', 'السعر', 'المنتج', 'الكمية']));
  });
});

const lookups = (over: Partial<Lookups> = {}): Lookups => ({
  products: [{ id: 'p-kamaa', name: 'ماء الكمأ' }, { id: 'p-harir', name: 'كريم حرير' }],
  couriers: [{ id: 'c-basha', name: 'الباشا' }, { id: 'c-alo', name: 'الو دليفيري' }],
  regions: [{ id: 'r-homs', name: 'حمص' }],
  defaultCourierId: 'c-basha',
  validPhone: (raw) => /^09\d{8}$/.test(raw),
  ...over,
});
const none: Known = { refs: new Map(), phones: new Set() };
const row = (over: Partial<SourceRow> = {}): SourceRow => ({
  file: 'a.xlsx', line: 2, date: '2026-10-22', ref: '100', name: 'زبون', rawPhone: '0912345678', phone: '963912345678',
  address: 'شارع', region: 'حمص', courier: 'الباشا', total: 25, product: 'ماء الكمأ', quantity: 3, ...over,
});

describe('the plan — refused rows are said, with the reason', () => {
  it('a row with no price is refused and named «بلا سعر»', () => {
    const [p] = planMigration([row({ total: null })], none, lookups(), 'ref_and_phone');
    expect(p.verdict).toBe('REFUSED');
    expect(p.reasons).toContain('بلا سعر');
  });

  it('and so is a phone that is no phone, a product the store does not have, a courier nobody knows', () => {
    expect(planMigration([row({ rawPhone: '123' })], none, lookups(), 'ref')[0].reasons).toContain('رقم هاتف غير صالح');
    expect(planMigration([row({ product: 'شي ثاني' })], none, lookups(), 'ref')[0].reasons[0]).toMatch(/منتج غير موجود/);
    expect(planMigration([row({ courier: 'مجهول' })], none, lookups(), 'ref')[0].reasons[0]).toMatch(/شركة شحن غير معروفة/);
  });

  it('a complete row is NEW, with its product, its region and its courier resolved by name', () => {
    expect(planMigration([row()], none, lookups(), 'ref_and_phone')[0]).toMatchObject({
      verdict: 'NEW', productId: 'p-kamaa', regionId: 'r-homs', courierId: 'c-basha',
    });
  });

  it('«الو دليفيري» stays with its own company — never the default', () => {
    expect(planMigration([row({ courier: 'الو دليفيري' })], none, lookups(), 'ref')[0].courierId).toBe('c-alo');
  });

  it('a row with no company goes to the default (الباشا)', () => {
    expect(planMigration([row({ courier: '' })], none, lookups(), 'ref')[0]).toMatchObject({ verdict: 'NEW', courierId: 'c-basha' });
  });
});

describe('the matching mechanism', () => {
  it('by order number AND phone: the second identical row is skipped, a same-number row for another phone is refused (the number cannot answer to two orders)', () => {
    const plan = planMigration(
      [row(), row({ line: 3 }), row({ line: 4, phone: '963999999999', rawPhone: '0999999999' })],
      none, lookups(), 'ref_and_phone'
    );
    expect(plan.map((p) => p.verdict)).toEqual(['NEW', 'DUPLICATE_IN_FILE', 'REFUSED']);
    expect(plan[1].reasons[0]).toContain('سطر 2');
  });

  it('an order the system already holds (same number AND phone) is skipped as IN_SYSTEM', () => {
    const known: Known = { refs: new Map([['100', '963912345678']]), phones: new Set() };
    expect(planMigration([row()], known, lookups(), 'ref_and_phone')[0].verdict).toBe('IN_SYSTEM');
  });

  it('by phone only: two different orders of one customer — the second is skipped', () => {
    const plan = planMigration([row(), row({ line: 3, ref: '101' })], none, lookups(), 'phone');
    expect(plan.map((p) => p.verdict)).toEqual(['NEW', 'DUPLICATE_IN_FILE']);
  });

  it('by number only: the same number with another phone is the same order — skipped', () => {
    const plan = planMigration([row(), row({ line: 3, phone: '963999999999', rawPhone: '0999999999' })], none, lookups(), 'ref');
    expect(plan.map((p) => p.verdict)).toEqual(['NEW', 'DUPLICATE_IN_FILE']);
  });

  it('none: nothing is matched — but a repeated number is still refused, never written twice', () => {
    const plan = planMigration([row(), row({ line: 3 })], none, lookups(), 'none');
    expect(plan.map((p) => p.verdict)).toEqual(['NEW', 'REFUSED']);
  });

  it('NEGATIVE: a number another order of the company already carries is refused, whatever the mechanism', () => {
    const known: Known = { refs: new Map([['100', '963000000000']]), phones: new Set() };
    expect(planMigration([row()], known, lookups(), 'ref_and_phone')[0]).toMatchObject({ verdict: 'REFUSED' });
    expect(planMigration([row()], known, lookups(), 'phone')[0]).toMatchObject({ verdict: 'REFUSED' });
  });

  it('the key is exactly the mechanism', () => {
    expect(matchKey({ ref: '1', phone: '9' }, 'ref_and_phone')).toBe('1|9');
    expect(matchKey({ ref: '1', phone: '9' }, 'ref')).toBe('1');
    expect(matchKey({ ref: '1', phone: '9' }, 'phone')).toBe('9');
    expect(matchKey({ ref: '1', phone: '9' }, 'none')).toBeNull();
  });
});

describe('the summary', () => {
  it('counts every verdict, and the units only of what will be written', () => {
    const plan = planMigration(
      [row(), row({ line: 3 }), row({ line: 4, ref: '101', phone: '963911111111', rawPhone: '0911111111', product: 'كريم حرير', quantity: 1, courier: 'الو دليفيري' }), row({ line: 5, ref: '102', total: null })],
      none, lookups(), 'ref_and_phone'
    );
    const s = summarize(plan);
    expect(s.counts).toEqual({ NEW: 2, DUPLICATE_IN_FILE: 1, IN_SYSTEM: 0, REFUSED: 1 });
    expect(s.units).toEqual({ 'ماء الكمأ': 3, 'كريم حرير': 1 });
    expect(s.byCourier).toEqual({ 'c-basha': 1, 'c-alo': 1 });
  });
});

describe('writing one migrated order', () => {
  function harness() {
    const calls: Record<string, any[]> = { order: [], item: [], log: [], activity: [], customer: [] };
    const tx: any = {
      order: { create: vi.fn(async (a: any) => (calls.order.push(a.data), { id: 'o1', orderNumber: 'SY-1' })) },
      orderItem: { create: vi.fn(async (a: any) => calls.item.push(a.data)) },
      customer: { update: vi.fn(async (a: any) => calls.customer.push(a.data)) },
      orderStatusLog: { create: vi.fn(async (a: any) => calls.log.push(a.data)) },
      orderActivity: { create: vi.fn(async (a: any) => calls.activity.push(a.data)) },
    };
    const deps: WriteDeps = {
      findOrCreateCustomer: vi.fn(async () => ({ id: 'cu1', firstOrderDate: null })),
      orderRefFields: vi.fn(async () => ({ orderNumber: 'SY-1', merchantRef: 'SY-1' })),
      unitCost: vi.fn(async () => 4),
      deliveryFee: vi.fn(async () => 3),
      reserve: vi.fn(async () => ({ shortages: [] })),
    };
    const ctx = {
      companyId: 'co', storeId: 'st', countryId: 'sy', orderPrefix: 'SY', currency: 'USD', minorUnit: 2,
      allowNegativeStock: false, user: { id: 'u1', name: 'احمد', role: 'SUPER_ADMIN' },
    };
    return { tx, deps, ctx, calls };
  }
  const planned = () => planMigration([row()], none, lookups(), 'ref_and_phone')[0];

  it('writes the sheet’s amount untouched, the sheet’s order number, confirmed and shipped with the courier, on the sheet’s day', async () => {
    const { tx, deps, ctx, calls } = harness();
    await writeMigratedOrder(tx, ctx, planned(), deps);
    const o = calls.order[0];
    expect(o).toMatchObject({
      totalAmount: 25, sellingPrice: 25, merchantRef: '100', priceIncludesDelivery: true,
      status: 'SHIPPED', confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', settlementStatus: 'PENDING_COLLECTION',
      deliveryProviderId: 'c-basha', regionId: 'r-homs', source: MIGRATION_SOURCE,
    });
    const day = shippedAt('2026-10-22');
    expect(o.createdAt).toEqual(day);
    expect(o.confirmedAt).toEqual(day);
    expect(o.shippedAt).toEqual(day);
  });

  it('the courier’s fee for the region is written beside the amount — never added to it', async () => {
    const { tx, deps, ctx, calls } = harness();
    await writeMigratedOrder(tx, ctx, planned(), deps);
    expect(calls.order[0].deliveryFee).toBe(3);
    expect(calls.order[0].totalAmount).toBe(25);
  });

  it('one line of three units (the gift is a unit), costed on all three', async () => {
    const { tx, deps, ctx, calls } = harness();
    await writeMigratedOrder(tx, ctx, planned(), deps);
    expect(calls.item[0]).toMatchObject({ productId: 'p-kamaa', quantity: 3, freeQuantity: 0, lineTotal: 25 });
    expect(calls.order[0].estimatedCostOfGoods).toBe(12);
  });

  it('asks what one unit costs for THIS row’s product, in the row’s company, inside the order’s own transaction', async () => {
    const { tx, deps, ctx } = harness();
    await writeMigratedOrder(tx, ctx, planned(), deps);
    expect(deps.unitCost).toHaveBeenCalledTimes(1);
    expect(deps.unitCost).toHaveBeenCalledWith(tx, 'co', 'p-kamaa');
  });

  it('a unit that costs nothing is a cost of nothing — the dependency’s zero is an answer, not a gap to fill', async () => {
    const { tx, deps, ctx, calls } = harness();
    (deps.unitCost as any).mockResolvedValue(0);
    await writeMigratedOrder(tx, ctx, planned(), deps);
    expect(calls.order[0].estimatedCostOfGoods).toBe(0);
  });

  it('and the cost is rounded by the currency: 3 × 1.1117 = 3.3351 is 3.34 at two places and 3.335 at three', async () => {
    const two = harness();
    (two.deps.unitCost as any).mockResolvedValue(1.1117);
    await writeMigratedOrder(two.tx, two.ctx, planned(), two.deps);
    expect(two.calls.order[0].estimatedCostOfGoods).toBe(3.34);
    const three = harness();
    (three.deps.unitCost as any).mockResolvedValue(1.1117);
    await writeMigratedOrder(three.tx, { ...three.ctx, minorUnit: 3 }, planned(), three.deps);
    expect(three.calls.order[0].estimatedCostOfGoods).toBe(3.335);
  });

  it('holds the stock ONCE — through the reservation every order uses, inside the same transaction', async () => {
    const { tx, deps, ctx } = harness();
    await writeMigratedOrder(tx, ctx, planned(), deps);
    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.reserve).toHaveBeenCalledWith(tx, 'o1', { allowNegativeStock: false });
  });

  it('says when the shelf was short', async () => {
    const { tx, deps, ctx } = harness();
    (deps.reserve as any).mockResolvedValue({ shortages: [{}] });
    expect((await writeMigratedOrder(tx, ctx, planned(), deps)).shortage).toBe(true);
  });

  it('logs both moves — confirmed and shipped — on the sheet’s day, and the customer’s first order is that day', async () => {
    const { tx, deps, ctx, calls } = harness();
    await writeMigratedOrder(tx, ctx, planned(), deps);
    expect(calls.log.map((l) => [l.statusType, l.newValue])).toEqual([['CONFIRMATION', 'CONFIRMED'], ['SHIPPING', 'SHIPPED']]);
    expect(calls.customer[0].firstOrderDate).toEqual(shippedAt('2026-10-22'));
  });

  it('NEGATIVE: only a NEW row is ever written', async () => {
    const { tx, deps, ctx } = harness();
    const refused = planMigration([row({ total: null })], none, lookups(), 'ref')[0];
    await expect(writeMigratedOrder(tx, ctx, refused, deps)).rejects.toThrow();
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a clash on the sheet’s own order number is not retried under another — it is the caller’s to report', async () => {
    const { tx, deps, ctx } = harness();
    tx.order.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002', meta: { target: ['companyId', 'merchantRef'] } }));
    await expect(writeMigratedOrder(tx, ctx, planned(), deps)).rejects.toMatchObject({ code: 'P2002' });
    expect(tx.order.create).toHaveBeenCalledTimes(1);
  });

  it('but a clash on the generated number is retried with the next one', async () => {
    const { tx, deps, ctx } = harness();
    tx.order.create
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002', meta: { target: ['companyId', 'orderNumber'] } }))
      .mockResolvedValueOnce({ id: 'o2', orderNumber: 'SY-2' });
    expect((await writeMigratedOrder(tx, ctx, planned(), deps)).orderId).toBe('o2');
  });
});
