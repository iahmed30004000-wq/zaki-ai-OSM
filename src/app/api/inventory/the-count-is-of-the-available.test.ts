import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «الجرد بدي اياه للمتاح وليس على الرف» (the owner, 8/11) — a stock count is of the AVAILABLE.
 *
 * The shelf figure is what the batches hold, and the batches still hold the units of an order that has left in a courier's bag
 * and not been delivered (`reservation.ts`: delivery consumes them) — nobody standing at the shelf can count those. What a
 * counter counts is the free stock: the available = the shelf minus what open orders hold (`reservedElsewhere`). The door takes
 * that count, derives the difference from the AVAILABLE, and moves the shelf by it, so the available afterwards is what was
 * counted. A shelf that holds less than what is promised is refused by name: counting by the available would add units to cover
 * promises, stock nobody found, entering at a cost.
 *
 * Every number below is invented.
 */
const { db, requireContext, requirePermission, logAudit, receiveStock, drawDownStock, onHandTotal, reservedElsewhere } = vi.hoisted(() => ({
  db: {
    product: { findFirst: vi.fn() },
    productionBatch: { findFirst: vi.fn() },
    inventoryMovement: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  receiveStock: vi.fn(),
  drawDownStock: vi.fn(),
  onHandTotal: vi.fn(),
  reservedElsewhere: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/reservation', () => ({ reservedElsewhere: (...a: unknown[]) => reservedElsewhere(...a) }));
vi.mock('@/lib/receiving', () => ({
  receiveStock: (...a: unknown[]) => receiveStock(...a),
  drawDownStock: (...a: unknown[]) => drawDownStock(...a),
  onHandTotal: (...a: unknown[]) => onHandTotal(...a),
}));

import { POST } from './route';

const PRODUCT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const count = (countedQuantity: number, reason = 'جرد نهاية الشهر') =>
  POST(
    new Request('http://localhost/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'recount', productId: PRODUCT_ID, countedQuantity, reason }),
    })
  );

/** A shelf of `shelf` units with `held` of them held by open orders. */
const stock = (shelf: number, held: number) => {
  onHandTotal.mockResolvedValue(shelf);
  reservedElsewhere.mockResolvedValue(held);
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({});
  db.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, name: 'ماء الكمأ', sourceType: 'PURCHASED' });
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  db.inventoryMovement.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, balanceAfter: 777 }));
  db.productionBatch.findFirst.mockResolvedValue({ costPerUnit: 6 });
  receiveStock.mockResolvedValue({ batch: { batchNumber: 'ADJ-1' }, movement: {}, balanceAfter: 0 });
  drawDownStock.mockResolvedValue(undefined);
});

describe('the count is compared with the AVAILABLE — the shelf less what open orders hold', () => {
  it('a count that equals the available agrees, even though it is far from the shelf: nothing is written', async () => {
    stock(500, 120); // available 380
    const res = await count(380);
    expect((await res.json()).difference).toBe(0);
    expect(drawDownStock).not.toHaveBeenCalled();
    expect(receiveStock).not.toHaveBeenCalled();
    expect(db.inventoryMovement.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('fewer than the available takes the shortfall off the shelf', async () => {
    stock(500, 120);
    const res = await count(360);
    expect((await res.json()).difference).toBe(-20);
    expect(drawDownStock.mock.calls[0][1]).toMatchObject({ quantity: 20, allowNegative: false, storeId: 's1' });
    expect(receiveStock).not.toHaveBeenCalled();
  });

  it('more than the available brings the surplus in at the cost of the stock already there', async () => {
    stock(500, 120);
    const res = await count(400);
    expect((await res.json()).difference).toBe(20);
    expect(receiveStock.mock.calls[0][1]).toMatchObject({ quantity: 20, unitCost: 6, storeId: 's1' });
    expect(drawDownStock).not.toHaveBeenCalled();
  });

  it('the old comparison is gone: the shelf figure typed as the count is a surplus of exactly what is held', async () => {
    stock(500, 120);
    const res = await count(500); // «على الرف» — what the dialog used to compare with
    expect((await res.json()).difference).toBe(120);
    expect(receiveStock.mock.calls[0][1]).toMatchObject({ quantity: 120 });
  });

  it('nothing held: the available is the shelf, as before', async () => {
    stock(500, 0);
    expect((await (await count(480)).json()).difference).toBe(-20);
    expect(drawDownStock.mock.calls[0][1]).toMatchObject({ quantity: 20 });
  });

  it('an empty free stock counted as empty agrees', async () => {
    stock(120, 120); // available 0
    expect((await (await count(0)).json()).difference).toBe(0);
    expect(db.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('asks for the reserved units of THIS store, the same figure the balances screen prints as «محجوز»', async () => {
    stock(500, 120);
    await count(380);
    expect(reservedElsewhere).toHaveBeenCalledTimes(1);
    expect(reservedElsewhere.mock.calls[0].slice(1)).toEqual(['c1', PRODUCT_ID, undefined, 's1']);
  });
});

describe('a shelf that holds less than what is promised cannot be counted by its available', () => {
  it('is refused by name, with both numbers, and nothing is written', async () => {
    stock(5, 8); // available −3
    const res = await count(0);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('RESERVED_EXCEEDS_SHELF');
    expect(body.error).toContain('(8)');
    expect(body.error).toContain('(5)');
    expect(body.error).toContain('ماء الكمأ');
    expect(receiveStock).not.toHaveBeenCalled();
    expect(drawDownStock).not.toHaveBeenCalled();
    expect(db.inventoryMovement.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('exactly equal (available 0) is not negative: it is counted', async () => {
    stock(8, 8);
    expect((await count(3)).status).toBe(200);
    expect(receiveStock.mock.calls[0][1]).toMatchObject({ quantity: 3 });
  });
});

describe('what is recorded', () => {
  it('the ledger line says what was counted, the available the system held, the shelf and the held units — and why', async () => {
    stock(500, 120);
    await count(360, 'تالف');
    const reason = db.inventoryMovement.create.mock.calls[0][0].data.reason as string;
    for (const part of ['جرد المتاح', '360', '380', '500', '120', 'تالف']) expect(reason, part).toContain(part);
    expect(db.inventoryMovement.create.mock.calls[0][0].data.quantity).toBe(-20);
  });

  it('the audit row keeps the three figures and the basis', async () => {
    stock(500, 120);
    await count(360);
    expect(logAudit).toHaveBeenCalledTimes(1);
    const entry = logAudit.mock.calls[0][0];
    expect(entry.action).toBe('STOCK_RECOUNTED');
    expect(entry.previousData).toEqual({ onHand: 500, reserved: 120, available: 380 });
    expect(entry.newData).toMatchObject({ counted: 360, basis: 'AVAILABLE', difference: -20 });
  });

  it('the answer carries the difference and the shelf after the correction', async () => {
    stock(500, 120);
    const body = await (await count(360)).json();
    expect(body).toMatchObject({ success: true, difference: -20, balanceAfter: 777 });
  });
});
