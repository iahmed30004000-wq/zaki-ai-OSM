import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «تم ارجاعها الي بالكشف… لا تحطها استبعدها… ممكن يكون الطلب مؤجل او مرتجع وفي اصلا عندي قسم للمرتجعات» (the owner, 2/11).
 *
 * A line the company wrote at ZERO, with a word that says the parcel was not delivered, against a parcel OUR side
 * agrees was not delivered, is not money and nobody's question: the matching writes it EXCLUDED. It holds nothing
 * back, the close never settles its order, and it does not speak for the order at the hand-collection door or in the
 * «not mentioned» sweep. Every other zero — and every line that carries money — is what it was.
 */

const { db } = vi.hoisted(() => ({
  db: {
    statementLine: { findMany: vi.fn() },
    courierStatement: { findFirst: vi.fn() },
    settlementMatch: { deleteMany: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    order: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { runMatching } from './settlement';
import { EXCLUDED_RESULT, NOT_DELIVERED_WORDS, isExcludedLine } from './statement-exclusion';
import { countOpenLines, isOpenLine, openLineWhere } from './statement-open-lines';
import { isMatchingClosed, lineCarriesNoMoney, statementNamingRefusal } from './settlement-gates';

/* ───────────────────────────── the rule ───────────────────────────── */

describe('when a line is not money', () => {
  const zero = (status: string, over: Record<string, unknown> = {}) => ({ amount: 0, collected: null, status, ...over });

  it.each([
    ['«تم ارجاعها» on a parcel still on the road', zero('تم ارجاعها'), 'OUT_FOR_DELIVERY'],
    ['«تم إرجاعها» (hamza) on a parcel the returns desk already closed', zero('تم إرجاعها'), 'RETURNED'],
    ['«مؤجلة» on a parcel whose attempt failed', zero('مؤجلة'), 'FAILED_DELIVERY'],
    ['«مؤجل» (masculine) on a shipped parcel', zero('مؤجل'), 'SHIPPED'],
    ['«ملغاة» on a parcel coming back', zero('ملغاة'), 'RETURN_REQUESTED'],
    ['«مسلمة الى المرسل» on a parcel coming back', zero('مسلمة الى المرسل'), 'RETURN_REQUESTED'],
    ['«قيد التوصيل» at zero on a parcel on the road', zero('قيد التوصيل'), 'OUT_FOR_DELIVERY'],
    ['«بالمركبة» at zero on a parcel on the road', zero('بالمركبة'), 'OUT_FOR_DELIVERY'],
    ['a collected cell that says 0', zero('تم ارجاعها', { collected: 0 }), 'SHIPPED'],
    ['a fee cell that says 0', zero('تم ارجاعها', { fee: 0 }), 'SHIPPED'],
  ])('%s → excluded', (_name, line, shippingStatus) => {
    expect(isExcludedLine(line, { shippingStatus })).toBe(true);
  });

  it('the words are exactly the four that say «not delivered»', () => {
    expect([...NOT_DELIVERED_WORDS].sort()).toEqual(['CANCELLED', 'IN_TRANSIT', 'POSTPONED', 'RETURNED']);
  });

  it.each([
    ['a negative net — the company CHARGED a return fee: money, a question', { amount: -5000, collected: 0, status: 'تم ارجاعها' }, 'OUT_FOR_DELIVERY'],
    ['money stated beside «مؤجلة»', { amount: 20000, status: 'مؤجلة' }, 'OUT_FOR_DELIVERY'],
    ['a collected figure beside a zero net', { amount: 0, collected: 3000, status: 'تم ارجاعها' }, 'OUT_FOR_DELIVERY'],
    // RV807: the net is zero but the company took a fee for the return — a charge, a question.
    ['RV807 — a deducted return fee beside a zero net and «تم ارجاعها»', { amount: 0, collected: null, fee: 5000, status: 'تم ارجاعها' }, 'OUT_FOR_DELIVERY'],
    ['RV807 — the same written 5,000 collected, 5,000 fee', { amount: 0, collected: 5000, fee: 5000, status: 'تم ارجاعها' }, 'RETURNED'],
    // RV808: a NEGATIVE collected figure is not «nothing collected».
    ['RV808 — a negative collected figure beside a zero net', { amount: 0, collected: -3000, status: 'تم ارجاعها' }, 'OUT_FOR_DELIVERY'],
    ['zero and «تم توصيلها» — delivered for nothing is a question', { amount: 0, status: 'تم توصيلها' }, 'OUT_FOR_DELIVERY'],
    ['zero and «تم توصيلها بشكل جزئي»', { amount: 0, status: 'تم توصيلها بشكل جزئي' }, 'OUT_FOR_DELIVERY'],
    ['zero and «مغلقة» (a known word that says nothing about the parcel)', { amount: 0, status: 'مغلقة' }, 'OUT_FOR_DELIVERY'],
    ['zero and an empty cell', { amount: 0, status: null }, 'OUT_FOR_DELIVERY'],
    ['zero and a word nobody knows', { amount: 0, status: 'حالة جديدة' }, 'OUT_FOR_DELIVERY'],
    ['zero «مؤجلة» while OUR door recorded it delivered — money to chase', { amount: 0, status: 'مؤجلة' }, 'DELIVERED'],
    ['zero «تم ارجاعها» while our door recorded a partial delivery', { amount: 0, status: 'تم ارجاعها' }, 'PARTIALLY_DELIVERED'],
    ['zero «تم ارجاعها» on a parcel that never left', { amount: 0, status: 'تم ارجاعها' }, 'PENDING'],
  ])('%s → NOT excluded', (_name, line, shippingStatus) => {
    expect(isExcludedLine(line, { shippingStatus })).toBe(false);
  });

  it('is no question and holds nothing back — by the same three readings the approval, the list and the close use', () => {
    const rows = [
      { result: EXCLUDED_RESULT, orderId: 'o4', resolution: null },
      { result: EXCLUDED_RESULT, orderId: 'o5', resolution: null },
      { result: 'MATCHED', orderId: 'o1', resolution: null },
    ];
    expect(rows.map(isOpenLine)).toEqual([false, false, false]);
    expect(countOpenLines(rows)).toBe(0);
    // The database filter names only the two kinds of question; an EXCLUDED row is neither.
    expect(JSON.stringify(openLineWhere())).not.toContain(EXCLUDED_RESULT);
  });
});

/* ───────────────────────────── the matching writes it ───────────────────────────── */

const scope = { companyId: 'c1', storeId: 's1', statementId: 'st1', minorUnit: 0 };
const order = (id: string, over: Record<string, unknown> = {}) => ({
  id, shippingStatus: 'OUT_FOR_DELIVERY', settlementStatus: 'PENDING_COLLECTION', totalAmount: 25000, priceIncludesDelivery: false,
  collectedAmount: null, deliveryFee: 5000, returnReceipt: null, addOns: [],
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 25000, discountShare: 0, lineTotal: 25000, deliveredQty: null }],
  trackingNumber: null, merchantRef: `REF-${id}`,
  ...over,
});
const line = (id: string, over: Record<string, unknown> = {}) => ({
  id, merchantRef: `REF-${id.replace('l', 'o')}`, barcode: null, amount: 0, collected: null, fee: null, status: null, ...over,
});
const created = () => db.settlementMatch.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  db.settlementMatch.create.mockResolvedValue({});
  db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.order.findMany.mockResolvedValue([]);
  db.courierStatement.findFirst.mockResolvedValue({
    id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-20T00:00:00Z'), fileHash: 'ab'.repeat(32),
  });
});

describe('the matching writes such a line EXCLUDED — before any verdict', () => {
  it('the worked example: three delivered lines MATCHED, the returned and the postponed EXCLUDED', async () => {
    db.statementLine.findMany.mockResolvedValueOnce([
      line('lA', { amount: 20000, collected: 25000, fee: 5000, status: 'تم توصيلها' }),
      line('lB', { amount: 25000, collected: 30000, fee: 5000, status: 'تم توصيلها' }),
      line('lC', { amount: 35000, collected: 40000, fee: 5000, status: 'تم توصيلها' }),
      line('lD', { status: 'تم ارجاعها' }),
      line('lE', { status: 'مؤجلة' }),
    ]).mockResolvedValue([]);
    const orders: Record<string, ReturnType<typeof order>> = {
      'REF-oA': order('oA'),
      'REF-oB': order('oB', { totalAmount: 30000, items: [{ quantity: 1, freeQuantity: 0, unitPrice: 30000, discountShare: 0, lineTotal: 30000, deliveredQty: null }], shippingStatus: 'DELIVERED' }),
      'REF-oC': order('oC', { totalAmount: 40000, items: [{ quantity: 1, freeQuantity: 0, unitPrice: 40000, discountShare: 0, lineTotal: 40000, deliveredQty: null }], shippingStatus: 'SHIPPED' }),
      'REF-oD': order('oD'),
      'REF-oE': order('oE', { shippingStatus: 'FAILED_DELIVERY' }),
    };
    db.order.findFirst.mockImplementation(async ({ where }: { where: { merchantRef?: string } }) => orders[where.merchantRef ?? ''] ?? null);

    const outcome = await runMatching(db as never, scope);

    expect(created().map((r) => [r.orderId, r.result])).toEqual([
      ['oA', 'MATCHED'], ['oB', 'MATCHED'], ['oC', 'MATCHED'], ['oD', EXCLUDED_RESULT], ['oE', EXCLUDED_RESULT],
    ]);
    expect(outcome).toMatchObject({ matched: 3, mismatched: 0, excluded: 2 });
    const d = created()[3];
    expect(d).toMatchObject({ statementLineId: 'lD', statementAmount: 0 });
    expect(d.note).toContain('«تم ارجاعها»');
    expect(d.note).toContain('قسم المرتجعات');
    // An excluded row carries no expectation: there is no money to compare.
    expect(d.expectedAmount).toBeUndefined();
  });

  it('the returns desk already closed it: EXCLUDED — not the MATCHED row that settled it over «NOT_APPLICABLE»', async () => {
    db.statementLine.findMany.mockResolvedValueOnce([line('lD', { status: 'تم ارجاعها', fee: 0 })]).mockResolvedValue([]);
    db.order.findFirst.mockResolvedValue(order('oD', { shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE' }));

    await runMatching(db as never, scope);

    expect(created()[0].result).toBe(EXCLUDED_RESULT);
  });

  it('NEGATIVE — a zero «مؤجلة» against a parcel OUR door delivered stays a question, with the zero named', async () => {
    db.statementLine.findMany.mockResolvedValueOnce([line('lE', { status: 'مؤجلة' })]).mockResolvedValue([]);
    db.order.findFirst.mockResolvedValue(order('oE', { shippingStatus: 'DELIVERED' }));

    await runMatching(db as never, scope);

    expect(created()[0].result).toBe('MISMATCHED');
  });

  it('NEGATIVE (RV807) — a zero net with a fee taken for the return stays a question, at the matching too', async () => {
    db.statementLine.findMany.mockResolvedValueOnce([line('lD', { amount: 0, fee: 5000, status: 'تم ارجاعها' })]).mockResolvedValue([]);
    db.order.findFirst.mockResolvedValue(order('oD'));

    await runMatching(db as never, scope);

    expect(created()[0].result).not.toBe(EXCLUDED_RESULT);
  });

  it('NEGATIVE — a returned line that carries a charge (net −5,000) stays a question', async () => {
    db.statementLine.findMany.mockResolvedValueOnce([line('lD', { amount: -5000, collected: 0, fee: 5000, status: 'تم ارجاعها' })]).mockResolvedValue([]);
    db.order.findFirst.mockResolvedValue(order('oD'));

    await runMatching(db as never, scope);

    expect(created()[0].result).toBe('MISMATCHED');
  });

  it('an excluded line claims nothing: a second line of the same file for the same parcel is judged on its own figures', async () => {
    db.statementLine.findMany
      .mockResolvedValueOnce([line('lE1', { merchantRef: 'REF-oE', status: 'مؤجلة' }), line('lE2', { merchantRef: 'REF-oE', amount: 20000, fee: 5000, status: 'تم توصيلها' })])
      .mockResolvedValue([]);
    db.order.findFirst.mockResolvedValue(order('oE'));

    await runMatching(db as never, scope);

    expect(created().map((r) => r.result)).toEqual([EXCLUDED_RESULT, 'MATCHED']);
    expect(created()[1].note).toBeNull();
  });
});

describe('the «not mentioned» sweep sees through an excluded line', () => {
  const sweepOrder = order('oE', { shippingStatus: 'DELIVERED', merchantRef: 'REF-oE', deliveredAt: new Date('2026-10-15T00:00:00Z') });

  beforeEach(() => {
    // The statement's own lines: none that name the parcel — it was postponed on ANOTHER statement and delivered since.
    db.statementLine.findMany.mockReset();
    db.order.findFirst.mockResolvedValue(null);
    db.order.findMany.mockResolvedValue([sweepOrder]);
  });

  it('a parcel whose only mention is a line the matching EXCLUDED is flagged MISSING_IN_STATEMENT', async () => {
    db.statementLine.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ barcode: null, merchantRef: 'REF-oE', matches: [{ result: EXCLUDED_RESULT }] }]);

    await runMatching(db as never, scope);

    expect(created()).toEqual([expect.objectContaining({ orderId: 'oE', result: 'MISSING_IN_STATEMENT' })]);
  });

  it('NEGATIVE — a line that carries its money (any row not EXCLUDED) is a mention, as before', async () => {
    db.statementLine.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ barcode: null, merchantRef: 'REF-oE', matches: [{ result: 'MATCHED' }] }]);

    await runMatching(db as never, scope);

    expect(created()).toEqual([]);
  });

  it('NEGATIVE — a line no run has matched yet is still a mention: what it will say is not known', async () => {
    db.statementLine.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ barcode: null, merchantRef: 'REF-oE', matches: [] }]);

    await runMatching(db as never, scope);

    expect(created()).toEqual([]);
  });
});

/* ───────────────────────────── the hand-collection door ───────────────────────────── */

describe('an excluded line does not speak for the order at «استلمت منه»', () => {
  const o = { id: 'oE', orderNumber: 'ORD-E', merchantRef: 'REF-oE', trackingNumber: null, deliveryProviderId: 'dp1' };
  const approved = { reference: 'ST-1', status: 'APPROVED', approvedAt: new Date('2026-10-20T00:00:00Z'), deliveryProviderId: 'dp1' };

  it('NEGATIVE — a line with one EXCLUDED row and one that is not still carries money: it speaks', () => {
    const line = { merchantRef: 'REF-oE', barcode: null, statement: approved, matches: [{ result: EXCLUDED_RESULT }, { result: 'MATCHED' }] };
    expect(lineCarriesNoMoney(line)).toBe(false);
    expect(statementNamingRefusal([o], [line])?.code).toBe('IN_APPROVED_STATEMENT');
  });

  it('a line whose rows are all EXCLUDED carries no money for it — the door may take the cash', () => {
    const lines = [{ merchantRef: 'REF-oE', barcode: null, statement: approved, matches: [{ result: EXCLUDED_RESULT }] }];
    const links = [{ orderId: 'oE', statement: approved, result: EXCLUDED_RESULT }];
    expect(lineCarriesNoMoney(lines[0])).toBe(true);
    expect(statementNamingRefusal([o], lines, links)).toBeNull();
  });

  it('NEGATIVE — the same line MATCHED is the statement\'s money: refused, by name', () => {
    const lines = [{ merchantRef: 'REF-oE', barcode: null, statement: approved, matches: [{ result: 'MATCHED' }] }];
    expect(statementNamingRefusal([o], lines)?.code).toBe('IN_APPROVED_STATEMENT');
    expect(statementNamingRefusal([o], [], [{ orderId: 'oE', statement: approved, result: 'MISMATCHED' }])?.code).toBe('IN_APPROVED_STATEMENT');
  });

  it('NEGATIVE — a line not matched yet still speaks for it (no rows: what it will say is not known)', () => {
    const lines = [{ merchantRef: 'REF-oE', barcode: null, statement: { ...approved, approvedAt: null, status: 'IMPORTED' }, matches: [] }];
    expect(statementNamingRefusal([o], lines)?.code).toBe('ON_UNAPPROVED_STATEMENT');
    // …and a read that did not ask for the rows is read as before: it speaks.
    expect(statementNamingRefusal([o], [{ merchantRef: 'REF-oE', barcode: null, statement: approved }])?.code).toBe('IN_APPROVED_STATEMENT');
  });
});

/* ───────────────────────────── the stamps ───────────────────────────── */

describe('the close is its own stamp — and a caller that never read it is answered the old way', () => {
  const at = new Date('2026-11-02T00:00:00Z');
  it('the money in, the matching open', () => {
    expect(isMatchingClosed({ status: 'APPROVED', approvedAt: at, matchingClosedAt: null })).toBe(false);
  });
  it('the matching closed', () => {
    expect(isMatchingClosed({ status: 'APPROVED', approvedAt: at, matchingClosedAt: at })).toBe(true);
  });
  it('NEGATIVE — a read that did not select the close, of an approved statement, is read as closed (the safe side)', () => {
    expect(isMatchingClosed({ status: 'APPROVED', approvedAt: at })).toBe(true);
    expect(isMatchingClosed({ status: 'MATCHED', approvedAt: null })).toBe(false);
  });
});
