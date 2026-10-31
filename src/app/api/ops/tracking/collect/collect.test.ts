import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settling a مندوب — or any courier with no API — by hand.
 *
 * It is the same gate as approving a statement, reached by a different road:
 * the wallet movement is written here and nowhere earlier, the amount is the
 * NET after the courier's fee, and nothing is settled twice.
 */

const { db, requireContext, requirePermission, logAudit, recordMovement, markPayableForOrders } = vi.hoisted(() => ({
  db: {
    wallet: { findFirst: vi.fn() },
    order: { findMany: vi.fn(), updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    // The statements that might already speak for an order (the door refuses those).
    statementLine: { findMany: vi.fn() },
    // Only the negative-expectation block below uses this: it runs the REAL
    // `recordMovement`, so the wallet's own `amount <= 0` guard is part of
    // the chain under test rather than mocked away.
    walletMovement: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  recordMovement: vi.fn(),
  markPayableForOrders: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => recordMovement(...a),
}));
vi.mock('@/lib/commission', async (orig) => ({
  ...(await orig<typeof import('@/lib/commission')>()),
  markPayableForOrders: (...a: unknown[]) => markPayableForOrders(...a),
}));

import { POST } from './route';

const ORDER_A = '11111111-1111-4111-8111-111111111111';
const ORDER_B = '22222222-2222-4222-8222-222222222222';
const WALLET = '33333333-3333-4333-8333-333333333333';

const post = (body: unknown) =>
  new Request('http://localhost/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * An order as `SETTLEMENT_ORDER_SELECT` returns it.
 *
 * The delivered lines and the return receipt are part of that select and are
 * required by `expectedAmountFor`: a door that did not ask the database for
 * them does not compile, because a partial delivery's expected net is built
 * from the units the customer actually kept. The default here is one line
 * nobody counted — a whole delivery recorded by a status change — so the
 * order's own total is the fact, exactly as in production.
 */
const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER_A, orderNumber: 'SY-2026-0001', currency: 'USD',
  shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
  totalAmount: 20, deliveryFee: 3,
  collectedAmount: null, priceIncludesDelivery: false, returnReceipt: null,
  items: [
    { quantity: 1, freeQuantity: 0, unitPrice: Number(over.totalAmount ?? 20), lineTotal: Number(over.totalAmount ?? 20), discountShare: 0, deliveredQty: null },
  ],
  deliveryProvider: { id: 'p1', name: 'أبو علي', kind: 'AGENT' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'محاسب' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD' },
  });
  requirePermission.mockResolvedValue({});
  db.wallet.findFirst.mockResolvedValue({ id: WALLET, name: 'صندوق سوريا', currencyCode: 'USD' });
  // The claim takes every order it is given unless a test says another press got there first.
  db.order.updateMany.mockImplementation(async (a: { where: { id: { in: string[] } } }) => ({ count: a.where.id.in.length }));
  db.statementLine.findMany.mockResolvedValue([]);
  db.orderActivity.create.mockResolvedValue({});
  db.walletMovement.create.mockResolvedValue({ id: 'm1' });
  recordMovement.mockResolvedValue({ id: 'm1' });
  markPayableForOrders.mockResolvedValue(0);
});

describe('what it collects', () => {
  it('takes the NET — the courier keeps their fee', async () => {
    db.order.findMany.mockResolvedValue([order(), order({ id: ORDER_B, orderNumber: 'SY-2026-0002', totalAmount: 15, deliveryFee: 4 })]);

    const res = await POST(post({ orderIds: [ORDER_A, ORDER_B], walletId: WALLET, note: 'استلمت منه نقداً' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.expected).toBe(28); // (20-3) + (15-4)
    expect(recordMovement.mock.calls[0][1]).toMatchObject({ direction: 'IN', amount: 28, category: 'COURIER_SETTLEMENT' });
  });

  it('reports the shortfall when less was handed over than expected', async () => {
    db.order.findMany.mockResolvedValue([order()]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, amount: 15, note: 'نقص معه' }));
    const body = await res.json();

    expect(body).toMatchObject({ expected: 17, amount: 15, difference: -2 });
    expect(body.message).toContain('بفارق');
  });

  it('makes commission payable and marks the orders settled, in the same transaction', async () => {
    db.order.findMany.mockResolvedValue([order()]);

    await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }));

    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ settlementStatus: 'SETTLED' });
    expect(markPayableForOrders).toHaveBeenCalledWith(expect.anything(), 'c1', [ORDER_A]);
  });
});

describe('what it refuses', () => {
  it('refuses an order that is already settled', async () => {
    db.order.findMany.mockResolvedValue([order({ settlementStatus: 'SETTLED' })]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'مرة ثانية' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_SETTLED');
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('refuses an order that was never delivered — nothing was collected', async () => {
    db.order.findMany.mockResolvedValue([order({ shippingStatus: 'SHIPPED' })]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }));
    expect((await res.json()).code).toBe('NOT_DELIVERED');
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('ACCEPTS a partially delivered order — the customer paid at the door', async () => {
    // The refusal here was money with nowhere to go. The customer took some
    // lines and paid for them, `collectedAmount` holds the figure, and the
    // agent-custody report already counts it among what the courier is
    // holding — but this is the only endpoint that takes cash in, and it
    // turned the order away. The debt sat in his owing list with no way to
    // clear it.
    db.order.findMany.mockResolvedValue([order({ shippingStatus: 'PARTIALLY_DELIVERED' })]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }));
    expect(res.status).toBe(200);
    expect(recordMovement).toHaveBeenCalled();
  });

  it('expects what the customer PAID on a partial, not the order’s full value', async () => {
    // Otherwise every partial reads as the courier coming up short, and the
    // screen accuses him of a shortfall that exists only in the arithmetic.
    db.order.findMany.mockResolvedValue([
      order({ shippingStatus: 'PARTIALLY_DELIVERED', totalAmount: 100, collectedAmount: 60, deliveryFee: 5 }),
    ]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }));
    const body = await res.json();
    // 60 taken at the door, less his 5 fee.
    expect(body.expected ?? body.amount).toBe(55);
    expect(body.difference).toBe(0);
  });

  it('and reads the DELIVERED LINES when no statement has written a figure', async () => {
    /*
     * The real shape of a partial delivery, measured end to end on
     * 2026-10-02: `collectedAmount` is NULL, because the door deliberately
     * does not write it — the money is the courier's statement's to write.
     *
     * 3 units at 12 with a 2.5 fee, two taken. The customer paid 24 + 2.5 at
     * the door and the courier keeps the 2.5, so he owes 24. This dialog
     * used to ask the operator to take 36 off him.
     */
    db.order.findMany.mockResolvedValue([
      order({
        shippingStatus: 'PARTIALLY_DELIVERED',
        totalAmount: 38.5,
        collectedAmount: null,
        deliveryFee: 2.5,
        items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, lineTotal: 36, discountShare: 0, deliveredQty: 2 }],
      }),
    ]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }));
    const body = await res.json();
    expect(body.expected).toBe(24);
    expect(body.difference).toBe(0);
    // And the wallet movement defaults to that figure, not to 36.
    expect(recordMovement).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 24 }));
  });

  it('and the courier’s return fee comes out of what he owes', async () => {
    db.order.findMany.mockResolvedValue([
      order({
        shippingStatus: 'PARTIALLY_DELIVERED',
        totalAmount: 38.5,
        collectedAmount: null,
        deliveryFee: 2.5,
        items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, lineTotal: 36, discountShare: 0, deliveredQty: 2 }],
        returnReceipt: { courierFeeAmount: 1.5 },
      }),
    ]);

    const body = await (await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }))).json();
    expect(body.expected).toBe(22.5);
  });

  it('refuses a returned order, which owes nothing', async () => {
    db.order.findMany.mockResolvedValue([order({ shippingStatus: 'RETURNED' })]);
    expect((await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }))).status).toBe(409);
  });

  it('refuses a wallet in the wrong currency rather than guessing a rate', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    db.wallet.findFirst.mockResolvedValue({ id: WALLET, name: 'صندوق الأردن', currencyCode: 'JOD' });

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }));
    expect((await res.json()).code).toBe('WALLET_CURRENCY_MISMATCH');
  });

  it('refuses a mixed-currency batch', async () => {
    db.order.findMany.mockResolvedValue([order(), order({ id: ORDER_B, currency: 'JOD' })]);

    const res = await POST(post({ orderIds: [ORDER_A, ORDER_B], walletId: WALLET, note: 'استلمت منه' }));
    expect((await res.json()).code).toBe('MIXED_CURRENCY');
  });

  it('insists on a note — a hand-settled payment with no words is unauditable', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    expect((await POST(post({ orderIds: [ORDER_A], walletId: WALLET }))).status).toBe(400);
    expect((await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'x' }))).status).toBe(400);
  });
});

/**
 * WHEN THE SUM RUNS THE OTHER WAY.
 *
 * `expectedAmountFor` reconstructs the expectation from the delivered lines
 * and subtracts the courier's return fee, and its own comment
 * (`settlement.ts:352-355`) says a negative answer is returned as it stands
 * — deliberately, because rounding a real debt up to zero would hide it.
 *
 * The door then handed that figure to `recordMovement`, which refuses any
 * amount at or below zero (`wallets.ts:83`), and the operator could not
 * correct it by hand either: the schema at `route.ts:33` is
 * `z.number().positive()` and the dialog's own field carries `min="0.001"`.
 * So the order could be closed by NO amount at all.
 */
describe('when the sum runs the other way', () => {
  /**
   * The measured case, 2026-10-02: 3 units at 1.000 with a 2.5 delivery fee,
   * the customer took one, and the returns desk charged the courier a 2.5
   * return fee.
   *
   *   at the door   1.000 + 2.5 = 3.5
   *   expected      3.5 − 2.5 (his fee) − 2.5 (the return) = −1.5
   *
   * That 2.5 was `fee.returnFee || fee.fee` reading a row that configures 0
   * as the whole outbound fee. `2aa703a` deleted the fallback, so
   * `returns/route.ts:230` now charges the row's `returnFee` as written and
   * that particular route to −1.5 is closed. The guard stands because a
   * CONFIGURED return fee still reaches a negative sum — 12 of the 25 active
   * fee rows hold 1.5, and this parcel against one of them is
   * 3.5 − 2.5 − 1.5 = −0.5 — and because the receipt's `courierFeeAmount`
   * is what this route reads, whatever wrote it. The 2.5 below is kept as
   * the figure the refusal was first measured on.
   */
  const owing = () =>
    order({
      shippingStatus: 'PARTIALLY_DELIVERED',
      totalAmount: 5.5,
      collectedAmount: null,
      deliveryFee: 2.5,
      items: [{ quantity: 3, freeQuantity: 0, unitPrice: 1, lineTotal: 3, discountShare: 0, deliveredQty: 1 }],
      returnReceipt: { courierFeeAmount: 2.5 },
    });

  it('refuses −1.5 by NAME and in Arabic, instead of a raw English 500', async () => {
    /*
     * BEFORE: `amount = parsed.data.amount ?? expected` = −1.5 reached
     * `recordMovement`, which threw the English
     * «Amount must be greater than zero». That matches no branch in
     * `api-error.ts`, so the operator read
     *
     *   500 { error: 'حدث خطأ داخلي' }
     *
     * on an order that no amount could close.
     */
    db.order.findMany.mockResolvedValue([owing()]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }));
    const body = await res.json();

    // Asserted FIRST so that breaking the guard names the figure: without
    // it this reads «called 1 times with … amount: -1.5».
    expect(recordMovement).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(body.code).toBe('OWED_TO_COURIER');
    // The SENTENCE must carry the figure and the direction — a named code
    // with a vague sentence is the same dead end in a nicer wrapper.
    expect(body.error).toContain('1.5');
    expect(body.error).toMatch(/ندفع/);
    expect(body.expected).toBe(-1.5);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('and the wallet is never handed a figure it must refuse — the real guard, not a mock', async () => {
    /*
     * The whole chain, with `recordMovement` as it actually is: without the
     * door's refusal this test reads 500 «حدث خطأ داخلي», which is the
     * defect as the operator met it.
     */
    const real = await vi.importActual<typeof import('@/lib/wallets')>('@/lib/wallets');
    recordMovement.mockImplementation(real.recordMovement as never);
    db.order.findMany.mockResolvedValue([owing()]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }));
    const body = await res.json();

    expect(res.status).not.toBe(500);
    expect(body.error).not.toContain('حدث خطأ داخلي');
    expect(body.code).toBe('OWED_TO_COURIER');
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a zero expectation the same way — the fees ate the whole collection', async () => {
    // 1 unit at 2.5 with a 2.5 fee, taken, and a 2.5 return fee:
    // (2.5 + 2.5) − 2.5 − 2.5 = 0. `recordMovement` refuses zero too.
    db.order.findMany.mockResolvedValue([
      order({
        shippingStatus: 'PARTIALLY_DELIVERED',
        totalAmount: 5,
        collectedAmount: null,
        deliveryFee: 2.5,
        items: [{ quantity: 1, freeQuantity: 0, unitPrice: 2.5, lineTotal: 2.5, discountShare: 0, deliveredQty: 1 }],
        returnReceipt: { courierFeeAmount: 2.5 },
      }),
    ]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('NOTHING_TO_COLLECT');
    expect(body.expected).toBe(0);
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('refuses a typed amount that rounds away to nothing, rather than 500-ing on it', async () => {
    /*
     * The second road to the same wall: `z.number().positive()` accepts
     * 0.004, and `roundMinor(0.004, 2)` is 0 — so the schema passed a figure
     * the wallet refuses. The sentence names the expected amount, which is
     * what the operator should have left the field empty for.
     */
    db.order.findMany.mockResolvedValue([order()]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, amount: 0.004, note: 'مبلغ صغير' }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('AMOUNT_TOO_SMALL');
    expect(body.error).toContain('17');
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('does NOT refuse a healthy collection — the guard reads the figure, not the door', async () => {
    // A guard that refused everything would pass every test above. 20 less
    // a 3 fee is 17, and it still goes through untouched.
    db.order.findMany.mockResolvedValue([order()]);

    const res = await POST(post({ orderIds: [ORDER_A], walletId: WALLET, note: 'استلمت منه' }));
    expect(res.status).toBe(200);
    expect((await res.json()).expected).toBe(17);
    expect(recordMovement).toHaveBeenCalled();
  });

  it('nets a negative order against the batch it is collected with, and settles both', async () => {
    /*
     * DELIBERATE, and the reason the guard reads the batch total rather than
     * each order: the courier settles a handful of parcels in one handover.
     * −1.5 on one of them against 17 on another is 15.5 in the hand, and
     * both orders are closed — which is exactly what netting means.
     */
    db.order.findMany.mockResolvedValue([order(), { ...owing(), id: ORDER_B, orderNumber: 'SY-2026-0002' }]);

    const res = await POST(post({ orderIds: [ORDER_A, ORDER_B], walletId: WALLET, note: 'استلمت منه' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.expected).toBe(15.5);
    expect(recordMovement).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 15.5 }));
    expect(db.order.updateMany.mock.calls[0][0].where.id.in).toEqual([ORDER_A, ORDER_B]);
  });
});
