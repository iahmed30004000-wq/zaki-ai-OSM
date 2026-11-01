import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/orders/import/migrate — the door behind «ترحيل طلبات قديمة».
 *
 * Owner-only; a preview writes nothing; applying writes the NEW rows only, one transaction each, so one failure is one
 * row; and the answer never carries a name, a phone or an address — file, line and reason.
 */

const { db, tx, requireContext, requirePermission, can, logAudit, sheet } = vi.hoisted(() => {
  const tx: any = {
    order: { create: vi.fn(async () => ({ id: 'o1', orderNumber: 'SY-1' })) },
    orderItem: { create: vi.fn() },
    customer: { update: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    // The fixed cost figures an admin set (`ProductFixedCost`): none, unless a test says so.
    productFixedCost: { findMany: vi.fn(async (): Promise<{ productId: string; amount: number }[]> => []) },
  };
  return {
    tx,
    db: {
      product: { findMany: vi.fn() },
      deliveryProvider: { findMany: vi.fn() },
      region: { findMany: vi.fn() },
      order: { findMany: vi.fn() },
      $transaction: vi.fn(),
    },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    can: vi.fn(),
    logAudit: vi.fn(),
    sheet: { rows: [] as string[][] },
  };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: (...a: unknown[]) => can(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) => new Response(String((e as Error).message), { status: (e as { status?: number }).status ?? 500 }),
  forbiddenAr: (s: string) => s,
}));
vi.mock('@/lib/xlsx-reader', () => ({ looksLikeXlsx: () => true, readXlsxRows: () => sheet.rows }));
vi.mock('@/lib/customer-identity', () => ({ findOrCreateCustomer: vi.fn(async () => ({ id: 'cu1', firstOrderDate: null })) }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: vi.fn(async () => ({ orderNumber: 'SY-1', merchantRef: 'SY-1' })) }));
// What the stock on hand says one unit costs: 4. A product with a fixed figure is not asked (`unitCostsOf` reads the figure first).
vi.mock('@/lib/product-cost', () => ({
  productCosts: vi.fn(async (_tx: unknown, _c: string, ids: string[]) => new Map(ids.map((id) => [id, { average: 4 }]))),
}));
vi.mock('@/lib/delivery-fees', () => ({ resolveDeliveryFee: vi.fn(async () => ({ fee: 3 })) }));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines: vi.fn(async () => ({ reserved: 1, shortages: [] })) }));

import { POST } from './route';
import { normalizePhoneNumber } from '@/lib/phone';

const HEADER = ['Order Number', 'Customer Name', 'Phone Number', 'Address', 'Region Name', 'Shipping Company', 'Total Price', 'Product Name', 'Quantity'];
// invented people
const ROWS = [
  HEADER,
  ['100', 'زبون أ', '0912345678', 'شارع', 'حمص', 'الباشا', '25.0', 'ماء الكمأ', '3.0'],
  ['100', 'زبون أ', '0912345678', 'شارع', 'حمص', 'الباشا', '25.0', 'ماء الكمأ', '3.0'], // the same order again
  ['101', 'زبون ب', '0933333333', 'شارع', 'حمص', 'الو دليفيري', '20.0', 'ماء الكمأ', '1.0'],
  ['102', 'زبون ج', '0944444444', 'شارع', 'حمص', 'الباشا', '', 'ماء الكمأ', '1.0'], // no price
];

const post = (opts: { apply?: boolean; dates?: string[]; files?: number; matching?: string } = {}) => {
  const form = new FormData();
  for (let i = 0; i < (opts.files ?? 1); i++) form.append('files', new File([new Uint8Array([80, 75, 3, 4])], `طلبات ${i}.xlsx`));
  for (const d of opts.dates ?? ['2026-10-22']) form.append('dates', d);
  form.append('matching', opts.matching ?? 'ref_and_phone');
  form.append('apply', opts.apply ? '1' : '0');
  return POST(new Request('http://x/api/orders/import/migrate', { method: 'POST', body: form }));
};

beforeEach(() => {
  vi.clearAllMocks();
  sheet.rows = ROWS;
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'احمد', role: 'SUPER_ADMIN' }, companyId: 'co', storeId: 'st',
    country: { id: 'sy', code: 'SY', orderPrefix: 'SY', currencyCode: 'USD', minorUnit: 2, allowNegativeStock: false },
  });
  requirePermission.mockResolvedValue(undefined);
  can.mockReturnValue(true);
  db.product.findMany.mockResolvedValue([{ id: 'p-kamaa', name: 'ماء الكمأ' }]);
  db.deliveryProvider.findMany.mockResolvedValue([{ id: 'c-basha', name: 'الباشا' }, { id: 'c-alo', name: 'الو دليفيري' }]);
  db.region.findMany.mockResolvedValue([{ id: 'r-homs', name: 'حمص' }]);
  db.order.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  tx.order.create.mockImplementation(async () => ({ id: 'o1', orderNumber: 'SY-1' }));
  tx.productFixedCost.findMany.mockImplementation(async () => []);
});

describe('a preview', () => {
  it('writes nothing, and counts: two new, one repeat skipped, one refused for having no price', async () => {
    const body = await (await post()).json();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(body.applied).toBe(false);
    expect(body.summary.counts).toEqual({ NEW: 2, DUPLICATE_IN_FILE: 1, IN_SYSTEM: 0, REFUSED: 1 });
    expect(body.summary.byCourier).toEqual({ الباشا: 1, 'الو دليفيري': 1 });
    expect(body.summary.units).toEqual({ 'ماء الكمأ': 4 });
  });

  it('names every row it will not write — by file, line and reason', async () => {
    const body = await (await post()).json();
    expect(body.notNew).toEqual([
      { file: 'طلبات 0.xlsx', line: 3, verdict: 'DUPLICATE_IN_FILE', reasons: [expect.stringContaining('سطر 2')] },
      { file: 'طلبات 0.xlsx', line: 5, verdict: 'REFUSED', reasons: ['بلا سعر'] },
    ]);
  });

  it('NEGATIVE: the answer carries no name, no phone and no address', async () => {
    const text = await (await post()).text();
    for (const s of ['زبون', '0912345678', '912345678', 'شارع']) expect(text, s).not.toContain(s);
  });
});

describe('applying', () => {
  it('writes the NEW rows only — two orders, the sheet’s numbers, each in its own transaction', async () => {
    const body = await (await post({ apply: true })).json();
    expect(body).toMatchObject({ applied: true, written: 2, failed: [] });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.order.create.mock.calls.map((c: any[]) => c[0].data.merchantRef)).toEqual(['100', '101']);
    expect(tx.order.create.mock.calls.map((c: any[]) => c[0].data.deliveryProviderId)).toEqual(['c-basha', 'c-alo']);
  });

  it('one row failing is one row: the rest are written and the failure is named by file and line', async () => {
    tx.order.create
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002', meta: { target: ['merchantRef'] } }))
      .mockResolvedValueOnce({ id: 'o2', orderNumber: 'SY-2' });
    const body = await (await post({ apply: true })).json();
    expect(body.written).toBe(1);
    expect(body.failed).toEqual([{ file: 'طلبات 0.xlsx', line: 2, why: 'رقم الطلب مستعمل لطلب آخر' }]);
  });

  it('a row already in the system (same number and phone) is skipped, not written again', async () => {
    db.order.findMany.mockImplementation(async (a: any) =>
      a.where.merchantRef ? [{ merchantRef: '100', customer: { phone: normalizePhoneNumber('0912345678') } }] : []
    );
    const body = await (await post({ apply: true })).json();
    expect(body.summary.counts.IN_SYSTEM).toBe(2);
    expect(body.written).toBe(1);
  });

  it('is audited once, with the files and the counts', async () => {
    await post({ apply: true });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'ORDERS_MIGRATED', newData: { written: 2, matching: 'ref_and_phone' } });
  });
});

/*
 * WHAT A MIGRATED ORDER'S GOODS COST (the owner, 1/11: «ثابت لكل الطلبات»). The two rows written are 3 units (order 100) and 1 unit
 * (order 101) of the one product. The stock on hand says a unit costs 4; a fixed figure, where an admin set one, wins over it.
 */
describe('the cost of the goods on a migrated order', () => {
  const costs = async () => {
    await post({ apply: true });
    return tx.order.create.mock.calls.map((c: any[]) => c[0].data.estimatedCostOfGoods);
  };

  it('a product with NO fixed figure is costed at the stock on hand, exactly as before: 3 × 4 and 1 × 4', async () => {
    expect(await costs()).toEqual([12, 4]);
  });

  it('a product WITH a fixed figure is costed at the figure whatever the stock says: 3 × 5 and 1 × 5', async () => {
    tx.productFixedCost.findMany.mockImplementation(async () => [{ productId: 'p-kamaa', amount: 5 }]);
    expect(await costs()).toEqual([15, 5]);
  });

  it('ZERO is a figure: the order costs nothing, it does not fall back to the stock', async () => {
    tx.productFixedCost.findMany.mockImplementation(async () => [{ productId: 'p-kamaa', amount: 0 }]);
    expect(await costs()).toEqual([0, 0]);
  });

  it('the figure is asked for THIS company’s products, inside the order’s own transaction', async () => {
    tx.productFixedCost.findMany.mockImplementation(async () => [{ productId: 'p-kamaa', amount: 5 }]);
    await post({ apply: true });
    expect(tx.productFixedCost.findMany).toHaveBeenCalledWith({
      where: { companyId: 'co', productId: { in: ['p-kamaa'] } },
      select: { productId: true, amount: true },
    });
  });

  it('a PREVIEW writes nothing and so costs nothing: no figure is read', async () => {
    await post();
    expect(tx.productFixedCost.findMany).not.toHaveBeenCalled();
  });
});

describe('who and what it refuses', () => {
  it('NEGATIVE: somebody who may import but is not the owner is refused, and nothing is read or written', async () => {
    can.mockReturnValue(false);
    const res = await post({ apply: true });
    expect(res.status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('NEGATIVE: needs the import permission at all', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    expect((await post()).status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('orders.import');
  });

  it('NEGATIVE: every file needs its day, and an unknown mechanism is refused', async () => {
    expect((await post({ dates: [] })).status).toBe(400);
    expect((await post({ dates: ['22-10'] })).status).toBe(400);
    expect((await post({ matching: 'guess' })).status).toBe(400);
  });

  it('NEGATIVE: a sheet without the columns says which', async () => {
    sheet.rows = [['Customer Name'], ['x']];
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ينقصه/);
  });
});
