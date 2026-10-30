import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE ASSISTANT ON THE CALL SEES ONE ORDER, AND NOT THE PHONE.
 *
 * Two things are being guarded here. The first is reach: an agent who types
 * an id belonging to another store must get nothing, because an id is not a
 * permission. The second is what travels: the agent is looking at the phone
 * number on their own screen, so putting it in the request to an outside
 * provider buys nothing and sends a customer's contact details somewhere
 * nobody in this company is accountable for them.
 *
 * And what it returns is a suggestion. Nothing in this route writes.
 */

const { db, requireContext, requirePermission, aiChat, customerRisk, customerHistory, AiNotConfigured } = vi.hoisted(() => ({
  db: { order: { findFirst: vi.fn(), findMany: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  aiChat: vi.fn(),
  customerRisk: vi.fn(),
  /*
   * The person's previous orders are asked of `customer-risk.ts`, not built
   * here — because «which orders are the same person's» is answered by the
   * PHONE, and the rule this file guards is that THIS route never selects one.
   * `Customer` is unique per store, so asking by id showed one shop's record
   * of somebody the agent is about to call.
   */
  customerHistory: vi.fn(),
  AiNotConfigured: class AiNotConfigured extends Error {},
}));

vi.mock('@/lib/db', () => ({ db }));
// The per-person ceiling is its own test (the-assistant-has-a-ceiling); this file asks many times on purpose.
vi.mock('@/lib/ai-rate', () => ({ tooManyAiCalls: () => null }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
// PR-10: the return-risk tier is a smart card; the key is asked of the user, and this file holds it unless a test says otherwise.
const { mayReadInsights } = vi.hoisted(() => ({ mayReadInsights: vi.fn() }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: (...a: unknown[]) => mayReadInsights(...a) }));
// The person's order envelope — the same one the order window reads through,
// which is the WORK door's now (`orderWorkWhere`: her envelope OR the order she
// holds). What it lets through is `the-order-she-holds.test.ts`'s question;
// this file asks that the route uses it and nothing else.
const { orderWorkWhere } = vi.hoisted(() => ({ orderWorkWhere: vi.fn() }));
vi.mock('@/lib/rbac', () => ({ orderWorkWhere: (...a: unknown[]) => orderWorkWhere(...a) }));
/*
 * `describeRoute` is new: the route now asks WHERE the call would go
 * before deciding what to put in the payload, because this assistant is
 * declared `pii: true` and the customer's name must not reach a vendor.
 * LOCAL here, so these cases keep reading the full payload they were
 * written for — the redaction has its own file.
 */
vi.mock('@/lib/ai-provider', () => ({
  aiChat: (...a: unknown[]) => aiChat(...a),
  describeRoute: async () => ({ provider: 'LOCAL', model: 'llama3.1:8b', keyFrom: 'none', baseUrl: 'http://127.0.0.1:11434' }),
  AiNotConfigured,
}));
vi.mock('@/lib/customer-risk', () => ({
  customerRisk: (...a: unknown[]) => customerRisk(...a),
  customerHistory: (...a: unknown[]) => customerHistory(...a),
}));

import { POST } from './route';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

const ask = (orderId: string = ORDER_ID) =>
  POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ orderId }) }));

const order = {
  id: ORDER_ID,
  orderNumber: 'SY-0044',
  totalAmount: 1200,
  currency: 'SYP',
  confirmationStatus: 'NEW',
  shippingStatus: 'NOT_READY',
  claimedById: null,
  shippedAt: null,
  labelPrintedAt: null,
  customerNotes: 'يرجى الاتصال مساءً',
  customer: { id: 'cust1', fullName: 'سارة', address: 'شارع بغداد ١٢', city: 'دمشق' },
  items: [{ productName: 'كريم', quantity: 2, freeQuantity: 1 }],
};

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);
  mayReadInsights.mockReturnValue(true);
  orderWorkWhere.mockReturnValue({});
  db.order.findFirst.mockResolvedValue(order);
  db.order.findMany.mockResolvedValue([]);
  customerHistory.mockResolvedValue([]);
  customerRisk.mockResolvedValue({
    tier: 'SAFE', returnRate: 0, orders: 3, returns: 0, windowDays: 182,
    recentReturns60d: 0, requiresPrepaymentOrApproval: false,
  });
  aiChat.mockResolvedValue('ابدئي بالسلام عليكم');
});

/** Everything the provider was told, as one string. */
const sentToModel = () => JSON.stringify(aiChat.mock.calls[0][0]);

describe('the return risk is a smart card — insights.view (PR-10)', () => {
  it('without the key: the risk is not looked up, not sent to the model and not sent back — absent, not «SAFE»', async () => {
    mayReadInsights.mockReturnValue(false);
    const body = await (await ask()).json();
    expect(customerRisk).not.toHaveBeenCalled();
    for (const f of ['tier', 'returnRate', 'returns', 'orders', 'requiresPrepaymentOrApproval']) {
      expect(body.context.customer, f).not.toHaveProperty(f);
      expect(sentToModel(), f).not.toContain(`"${f}"`);
    }
    expect(body.context.customer.previous).toBeDefined();
  });
});

describe('what reaches the provider', () => {
  it('never the phone and never the address — the agent already has both on screen', async () => {
    await ask();
    const sent = sentToModel();
    expect(sent).not.toContain('شارع بغداد');
    // The fact that an address EXISTS is what the agent needs; the address is not.
    expect(sent).toContain('hasAddress');
    // And nothing selected a phone in the first place.
    const select = db.order.findFirst.mock.calls[0][0].select;
    expect(select.customer.select.phone).toBeUndefined();
  });

  it('says when the address is missing, because that is a reason to call', async () => {
    db.order.findFirst.mockResolvedValue({ ...order, customer: { ...order.customer, address: '   ' } });
    await ask();
    expect(JSON.parse(aiChat.mock.calls[0][0].user).order.hasAddress).toBe(false);
  });

  it('uses the company’s own wording for this job, not a prompt written here', async () => {
    await ask();
    expect(aiChat.mock.calls[0][0].job).toBe('confirmation');
    expect(aiChat.mock.calls[0][0].system).toBeUndefined();
  });

  it('a clean history goes as numbers, so the model cannot invent a worry', async () => {
    const body = await (await ask()).json();
    expect(body.context.customer).toMatchObject({ orders: 3, returns: 0, tier: 'SAFE', previous: [] });
  });

  it('and a previous order travels as a STATE and a date, not as three columns', async () => {
    /*
     * The projection is this route's own work and nothing tested it: the
     * three status columns are collapsed into the one derived state, in the
     * operator's Arabic, and the timestamp is cut to a day. A model handed
     * `shippingStatus: 'RETURNED', confirmationStatus: 'CONFIRMED'` is being
     * asked to derive the state itself, which is the one thing the frontend
     * and anything downstream must never do.
     */
    customerHistory.mockResolvedValue([
      {
        orderNumber: 'SY-0041',
        confirmationStatus: 'CONFIRMED',
        shippingStatus: 'RETURNED',
        createdAt: new Date('2026-08-14T09:30:00.000Z'),
        totalAmount: 800,
      },
    ]);
    const body = await (await ask()).json();
    expect(body.context.customer.previous).toEqual([
      { number: 'SY-0041', state: 'مرتجع', total: 800, at: '2026-08-14' },
    ]);
    // And it is the SAME person's list, asked of the one module that may
    // resolve that — this route never selects a phone.
    expect(customerHistory).toHaveBeenCalledWith(db, 'c1', 'cust1', { exceptOrderId: ORDER_ID });
  });
});

describe('what it refuses', () => {
  it('anyone without the permission to work the confirmation queue', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission confirmation.work'));
    expect((await ask()).status).toBe(403);
    expect(aiChat).not.toHaveBeenCalled();
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });

  it('an order of another store — an id is not a permission', async () => {
    db.order.findFirst.mockResolvedValue(null);
    expect((await ask()).status).toBe(404);
    expect(aiChat).not.toHaveBeenCalled();
  });

  it('and it asks for the order inside this company and this store', async () => {
    await ask();
    expect(db.order.findFirst.mock.calls[0][0].where).toMatchObject({
      id: ORDER_ID, companyId: 'c1', storeId: 's1',
    });
  });

  it('and only one THIS person may open — the work door’s envelope, as the order window asks', async () => {
    const mine = { OR: [{ OR: [{ assignedToId: 'u1' }] }, { claimedById: 'u1' }] };
    orderWorkWhere.mockReturnValue(mine);
    await ask();
    expect(orderWorkWhere).toHaveBeenCalledWith({ id: 'u1' });
    expect(db.order.findFirst.mock.calls[0][0].where.AND).toEqual([mine]);
  });

  it('an order that moved to a colleague is not found, and the model is not asked', async () => {
    orderWorkWhere.mockReturnValue({ claimedById: 'u1' });
    db.order.findFirst.mockResolvedValue(null);
    expect((await ask()).status).toBe(404);
    expect(aiChat).not.toHaveBeenCalled();
  });

  it('a body that is not an order id', async () => {
    expect((await ask('not-a-uuid')).status).toBe(400);
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });
});

describe('when the provider does not answer', () => {
  it('the facts still come back — the agent is on a call', async () => {
    aiChat.mockRejectedValue(new AiNotConfigured());
    const body = await (await ask()).json();
    expect(body.suggestion).toBeNull();
    expect(body.context.order.number).toBe('SY-0044');
    expect(body.error).toContain('لم يُضبط');
  });
});
