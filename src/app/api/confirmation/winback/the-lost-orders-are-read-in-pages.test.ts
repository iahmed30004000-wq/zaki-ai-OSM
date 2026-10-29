import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE LOST ORDERS, READ IN PAGES — UNDER THE OWNER'S RULE.
 *
 * «استرجاع الملغى — اعملو صفحات + فلاتر + بحث، والأهم شو القاعدة تبعو». The route
 * used to read the last five hundred lost orders, judge each in memory and cut at
 * five hundred before asking. What is held here is the door: what it asks for,
 * under whose rule, what it refuses, and what it sends back — and above all that
 * no choice in the address can widen what the person is allowed to see.
 */

const { db, requireContext, requirePermission, can, noteCustomersHandedOut } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    company: { findUnique: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  noteCustomersHandedOut: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));

import { GET } from './route';

const DAY = 86_400_000;
const user = { id: 'u-sup', name: 'مشرفة', role: 'CONFIRMATION_SUPERVISOR', status: 'ACTIVE' };
const get = (query = '') => GET(new Request(`http://localhost/api/confirmation/winback${query ? `?${query}` : ''}`));
const asked = () => db.order.findMany.mock.calls.at(-1)![0] as { where: Record<string, any>; skip: number; take: number; orderBy: unknown[] };

const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  orderNumber: 'ORD-1',
  confirmationStatus: 'REJECTED',
  rejectionReason: 'PRICE_TOO_HIGH',
  rejectionNote: null,
  shippedAt: null,
  sellingPrice: 100,
  discountAmount: 0,
  quantity: 1,
  currency: 'JOD',
  productNameSnapshot: 'قطرة',
  createdAt: new Date(Date.now() - 50 * DAY),
  customer: { fullName: 'عميل', phone: '0790000000' },
  replacedBy: null,
  replaces: null,
  ...over,
});

/** Stores a rule in the company's settings document, as the editor would have. */
const storeRule = (winback: unknown) => db.company.findUnique.mockResolvedValue({ settings: JSON.stringify({ winback, ai: { x: 1 } }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue(user);
  can.mockReturnValue(false);
  db.order.findMany.mockResolvedValue([]);
  db.order.count.mockResolvedValue(0);
  db.order.groupBy.mockResolvedValue([]);
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.company.findUnique.mockResolvedValue({ settings: null });
});

describe('what it asks for', () => {
  /**
   * REWRITTEN ON 28/10: «the lost words» became «the lost words OR a parcel that left and came back» —
   * the owner's «قبل الشحن وبعد», on by default. The switch off asks exactly what this asked before (next).
   */
  it('— with nothing chosen: this company, this store, the lost words or a return, the look-back, 25 from the start', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const w = asked().where;
    expect(w).toMatchObject({ companyId: 'c1', storeId: 's1' });
    expect(w.OR).toEqual([
      { confirmationStatus: { in: ['REJECTED', 'CANCELLED'] } },
      { shippingStatus: 'RETURNED', shippedAt: { not: null } },
    ]);
    expect(w.createdAt.gte.getTime()).toBeGreaterThan(Date.now() - 121 * DAY);
    expect(w.createdAt.gte.getTime()).toBeLessThan(Date.now() - 119 * DAY);
    expect(asked()).toMatchObject({ skip: 0, take: 25 });
    expect(asked().orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    // One view, the work: the view's clause alone is ANDed on.
    expect(w.AND).toHaveLength(1);
  });

  it('and with the owner’s switch off, it asks exactly what it asked before — the lost words, and no return', async () => {
    storeRule({ afterShipping: false });
    await get();
    const w = asked().where;
    expect(w).toMatchObject({ companyId: 'c1', storeId: 's1', confirmationStatus: { in: ['REJECTED', 'CANCELLED'] } });
    expect(w).not.toHaveProperty('OR');
    expect(JSON.stringify(w)).not.toContain('returnReceipt');
  });

  it('and only a supervisor reads it — the permission is asked by name, and a refusal is a 403 with nothing read', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission confirmation.supervise'));
    expect((await get()).status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('confirmation.supervise');
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.order.count).not.toHaveBeenCalled();
  });

  it('and every word chosen is one more thing that must hold, ANDed onto the scope — never in place of it', async () => {
    await get('view=skipped&reason=OTHER&product=%D9%82%D8%B7%D8%B1%D8%A9&period=30');
    expect(asked().where.AND).toHaveLength(4);
    expect(asked().where).toMatchObject({ companyId: 'c1', storeId: 's1' });
  });

  it('and the search asks every way an order is known — and the product', async () => {
    await get(`q=${encodeURIComponent('0790 123')}`);
    const or = (asked().where.AND[1] as { OR: Record<string, unknown>[] }).OR;
    expect(or.map((c) => Object.keys(c)[0])).toEqual(['orderNumber', 'merchantRef', 'trackingNumber', 'customer', 'customer', 'customer', 'productNameSnapshot']);
  });
});

describe('what it refuses', () => {
  it.each([
    ['view=everything', 'العرض غير معروف: everything'],
    ['reason=BOREDOM', 'سبب الإلغاء غير معروف: BOREDOM'],
    ['period=365', 'المدّة غير معروف: 365'],
    ['shipping=later', 'الشحن غير معروف: later'],
  ])('— %s: 400, in Arabic, and nothing was read', async (query, arabic) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect((await res.json()).errorAr).toBe(arabic);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
});

describe('the rule it reads', () => {
  /** REWRITTEN ON 28/10: the defaults carry the switch, on. */
  it('— with nothing stored, the defaults — and the response says so, with whether this person may change it', async () => {
    const body = await (await get()).json();
    expect(body.rule).toEqual({
      reasons: ['PRICE_TOO_HIGH', 'FOUND_CHEAPER_ELSEWHERE', 'CUSTOMER_CHANGED_MIND', 'NO_ANSWER_3_ATTEMPTS'],
      afterShipping: true,
      coolingDays: 14,
      lookbackDays: 120,
      maxDiscountShare: 0.25,
    });
    expect(body.canEditRule).toBe(false);
  });

  it('and a stored «off» is what the response says, and what the question asks', async () => {
    storeRule({ afterShipping: false, coolingDays: 20 });
    const body = await (await get()).json();
    expect(body.rule).toMatchObject({ afterShipping: false, coolingDays: 20 });
    expect(asked().where).not.toHaveProperty('OR');
  });

  it('and «can edit» is the settings permission, asked of the person — not the supervisor’s', async () => {
    // PR-4: the rule is edited with its own box (offers.rules), not with the sensitive-settings key.
    can.mockImplementation((_u: unknown, perm: string) => perm === 'offers.rules');
    expect((await (await get()).json()).canEditRule).toBe(true);
    expect(can).toHaveBeenCalledWith(user, 'offers.rules');
    can.mockImplementation((_u: unknown, perm: string) => perm === 'settings.manage');
    expect((await (await get()).json()).canEditRule, 'NEGATIVE: the old key no longer offers the editor').toBe(false);
  });

  it('and a stored rule is what is applied: a 30-day look-back moves the line the list reads from', async () => {
    storeRule({ lookbackDays: 45, coolingDays: 7, reasons: ['OTHER'], maxDiscountShare: 0.1 });
    const body = await (await get()).json();
    expect(body.rule).toMatchObject({ lookbackDays: 45, coolingDays: 7, reasons: ['OTHER'], maxDiscountShare: 0.1 });
    const since = asked().where.createdAt.gte.getTime();
    expect(since).toBeGreaterThan(Date.now() - 46 * DAY);
    expect(since).toBeLessThan(Date.now() - 44 * DAY);
  });

  it('and the cooling the QUERY draws is the rule’s own — thirty days moves the line the «ready» view is cut at', async () => {
    /** Every cutoff the question draws on a date, by its operator, found wherever it sits in the question. */
    const cutoffs = (node: unknown, op: string): Date[] => {
      if (node instanceof Date || node === null || typeof node !== 'object') return [];
      return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => (key === op && value instanceof Date ? [value] : cutoffs(value, op)));
    };
    storeRule({ coolingDays: 30 });
    await get();
    // The loss's line (`gt`, under a NOT) and — since 28/10 — the receipt's (`lte`): both at thirty days.
    const cut = [...cutoffs(asked().where.AND[0], 'gt'), ...cutoffs(asked().where.AND[0], 'lte')];
    expect(cut).toHaveLength(2);
    for (const c of cut) {
      expect(c.getTime()).toBeGreaterThan(Date.now() - 31 * DAY);
      expect(c.getTime()).toBeLessThan(Date.now() - 29 * DAY);
    }
  });

  it('and a broken settings document is the default, not a 500', async () => {
    db.company.findUnique.mockResolvedValue({ settings: '{not json' });
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).rule.coolingDays).toBe(14);
  });

  it('and the rows’ verdicts are taken under that rule: cooling for thirty days says thirty', async () => {
    storeRule({ coolingDays: 30 });
    db.order.findMany.mockResolvedValue([order()]);
    db.order.count.mockResolvedValue(1);
    db.orderStatusLog.findMany.mockResolvedValue([{ orderId: 'o1', createdAt: new Date(Date.now() - 20 * DAY) }]);
    const body = await (await get('view=cooling')).json();
    expect(body.rows[0].verdict).toMatchObject({ eligible: false, code: 'COOLING' });
    expect(body.rows[0].verdict.reason).toContain('30');
  });

  it('and an order the rule calls for carries the rule’s own ceiling', async () => {
    storeRule({ maxDiscountShare: 0.1 });
    db.order.findMany.mockResolvedValue([order({ sellingPrice: 200 })]);
    db.order.count.mockResolvedValue(1);
    db.orderStatusLog.findMany.mockResolvedValue([{ orderId: 'o1', createdAt: new Date(Date.now() - 40 * DAY) }]);
    const body = await (await get()).json();
    expect(body.rows[0].verdict).toMatchObject({ eligible: true, maxDiscount: 20 });
  });
});

describe('the page', () => {
  it('— page and size come from the address, the size capped at a hundred; words are the default', async () => {
    db.order.count.mockResolvedValue(500);
    await get('page=3&limit=10');
    expect(asked()).toMatchObject({ skip: 20, take: 10 });
    await get('page=2&limit=1000');
    expect(asked()).toMatchObject({ skip: 100, take: 100 });
    await get('page=abc&limit=xyz');
    expect(asked()).toMatchObject({ skip: 0, take: 25 });
  });

  it('and a page past the end is answered with the last, and the body says which', async () => {
    // The page's own count is asked first; the numbers beside the options are asked after it.
    db.order.count.mockResolvedValueOnce(60).mockResolvedValue(7);
    const body = await (await get('page=99999')).json();
    expect(body.pagination).toEqual({ total: 60, page: 3, limit: 25, totalPages: 3 });
    expect(asked().skip).toBe(50);
  });

  /** REWRITTEN ON 28/10: one more set of numbers, the two sides of «الشحن». */
  it('and the numbers beside the options come back with it, over the same scope', async () => {
    const body = await (await get()).json();
    expect(Object.keys(body.facts)).toEqual(['views', 'reasons', 'products', 'periods', 'shipping']);
    expect(Object.keys(body.facts.views)).toEqual(['ready', 'cooling', 'skipped']);
    expect(Object.keys(body.facts.shipping)).toEqual(['before', 'after']);
    for (const [arg] of db.order.count.mock.calls) expect((arg as { where: Record<string, unknown> }).where).toMatchObject({ companyId: 'c1', storeId: 's1' });
  });

  /** REWRITTEN ON 28/10: what was applied gained `shipping`. */
  it('and it says what was applied, so the screen can show what the list is', async () => {
    const body = await (await get('view=cooling&q=سارة')).json();
    expect(body.applied).toEqual({ view: 'cooling', reason: null, product: null, period: null, shipping: null, q: 'سارة' });
    const after = await (await get('shipping=after')).json();
    expect(after.applied.shipping).toBe('after');
    expect(asked().where.AND).toContainEqual({ shippedAt: { not: null } });
  });
});

/**
 * «قبل الشحن وبعد» — A PARCEL THAT CAME BACK, ON ITS ROW (28/10).
 *
 * As the courier feed and the desk leave one: CONFIRMED, no rejection reason, no loss in the log — RETURNED,
 * with the receipt's date. The row must say it is a return, in words, dated by the receipt, and be judged by it.
 */
describe('a parcel that came back, on its row', () => {
  const returned = (over: Record<string, unknown> = {}) =>
    order({
      id: 'r1',
      confirmationStatus: 'CONFIRMED',
      rejectionReason: null,
      shippedAt: new Date(Date.now() - 45 * DAY),
      shippingStatus: 'RETURNED',
      returnReason: 'CUSTOMER_REFUSED',
      deliveryFailureReason: null,
      returnReceipt: { inspectedAt: new Date(Date.now() - 20 * DAY) },
      ...over,
    });

  it('— asks for where the parcel is, why it came back and when the desk received it', async () => {
    await get();
    expect(db.order.findMany.mock.calls.at(-1)![0].select).toMatchObject({
      shippingStatus: true, returnReason: true, deliveryFailureReason: true,
      returnReceipt: { select: { inspectedAt: true } },
    });
  });

  it('— is named a return in words, dated by its receipt, and offered with the ceiling of its price', async () => {
    db.order.findMany.mockResolvedValue([returned({ sellingPrice: 40 })]);
    db.order.count.mockResolvedValue(1);
    const body = await (await get()).json();
    const r = body.rows[0];
    expect(r.returnLabel).toBe('مرتجع بعد الشحن — العميل رفض');
    expect(new Date(r.returnReceivedAt).getTime()).toBeLessThan(Date.now() - 19 * DAY);
    expect(r.verdict).toMatchObject({ eligible: true, maxDiscount: 10 });
    // Its cooling ran from the receipt: due fourteen days after it, not after a loss it never had.
    expect(new Date(r.verdict.dueAt).getTime() - new Date(r.returnReceivedAt).getTime()).toBe(14 * DAY);
  });

  it('and one received a few days ago is still cooling — from the receipt', async () => {
    db.order.findMany.mockResolvedValue([returned({ returnReceipt: { inspectedAt: new Date(Date.now() - 3 * DAY) } })]);
    db.order.count.mockResolvedValue(1);
    const body = await (await get('view=cooling')).json();
    expect(body.rows[0].verdict).toMatchObject({ eligible: false, code: 'COOLING' });
  });

  it('and a written-off parcel is named a return and nothing more — the prose of the write-off never leaves the server', async () => {
    const prose = 'أُغلق كخسارة — لم تُستلم البضاعة. ضاع عند المندوب';
    db.order.findMany.mockResolvedValue([returned({ returnReceipt: null, returnReason: prose })]);
    db.order.count.mockResolvedValue(1);
    const res = await get('view=skipped');
    const text = await res.clone().text();
    const body = await res.json();
    expect(body.rows[0].returnLabel).toBe('مرتجع بعد الشحن');
    expect(body.rows[0].verdict).toMatchObject({ eligible: false, code: 'RETURN_NOT_RECEIVED' });
    expect(body.rows[0]).not.toHaveProperty('returnReason');
    expect(text).not.toContain('ضاع عند المندوب');
  });

  it('and a lost order is not a return: no label, and the receipt it does not have is null', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    db.order.count.mockResolvedValue(1);
    db.orderStatusLog.findMany.mockResolvedValue([{ orderId: 'o1', createdAt: new Date(Date.now() - 40 * DAY) }]);
    const body = await (await get()).json();
    expect(body.rows[0]).toMatchObject({ returnLabel: null, returnReceivedAt: null, verdict: { eligible: true } });
  });

  it('and with the owner’s switch off, the same row is refused in his words', async () => {
    storeRule({ afterShipping: false });
    db.order.findMany.mockResolvedValue([returned({ confirmationStatus: 'REJECTED', rejectionReason: 'PRICE_TOO_HIGH' })]);
    db.order.count.mockResolvedValue(1);
    const body = await (await get('view=skipped')).json();
    expect(body.rows[0].verdict).toMatchObject({ eligible: false, code: 'AFTER_SHIPPING_OFF', reason: 'المرتجع بعد الشحن غير مشمول في القاعدة' });
  });
});

describe('the closing date and the tally', () => {
  it('— the closing dates are looked up for the PAGE’s orders only, by either lost word', async () => {
    db.order.findMany.mockResolvedValue([order({ id: 'a' }), order({ id: 'b' })]);
    db.order.count.mockResolvedValue(300);
    await get();
    expect(db.orderStatusLog.findMany).toHaveBeenCalledTimes(1);
    expect(db.orderStatusLog.findMany.mock.calls[0][0].where).toEqual({
      orderId: { in: ['a', 'b'] },
      statusType: 'CONFIRMATION',
      newValue: { in: ['REJECTED', 'CANCELLED'] },
    });
  });

  it('and an empty page looks nothing up', async () => {
    await get();
    expect(db.orderStatusLog.findMany).not.toHaveBeenCalled();
  });

  it('and the LAST loss is the closing date — an order rejected, re-opened and rejected again cools from the second time', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    db.order.count.mockResolvedValue(1);
    // Newest first, as the route asks for them.
    db.orderStatusLog.findMany.mockResolvedValue([
      { orderId: 'o1', createdAt: new Date(Date.now() - 3 * DAY) },
      { orderId: 'o1', createdAt: new Date(Date.now() - 90 * DAY) },
    ]);
    const body = await (await get('view=cooling')).json();
    expect(body.rows[0].verdict).toMatchObject({ eligible: false, code: 'COOLING' });
  });

  it('and the tally of customers handed out is the PAGE that was sent — not the whole list', async () => {
    db.order.findMany.mockResolvedValue([order({ id: 'a' }), order({ id: 'b' })]);
    db.order.count.mockResolvedValue(300);
    await get();
    expect(noteCustomersHandedOut).toHaveBeenCalledTimes(1);
    const call = noteCustomersHandedOut.mock.calls[0][0];
    expect(call.rows).toHaveLength(2);
    expect(call).toMatchObject({ companyId: 'c1', storeId: 's1', where: 'استعادة العملاء' });
  });
});
