import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addOrdersToDraft, assembleDraft, ManualRefused } from './manual-statement';
import { collectTotalRefusal } from './settlement-gates';
import { manualFileHash, MANUAL_DRAFT_PREFIX } from './manual-statement-rules';

/**
 * THE MANUAL STATEMENT'S DOOR, AGAINST A DATABASE THAT APPLIES THE FILTERS IT IS GIVEN.
 *
 * The fake below is a small in-memory world: orders, statements, lines, match rows and receipts. It answers the
 * `where` the code sends, so a refusal here is the code's own and not a mock that was told the answer.
 *
 * The orders are the JOD example of the design: a 20.000 order with a 2.500 delivery fee INSIDE the price, so the
 * courier is expected to hand over 17.500.
 */

interface Row {
  [k: string]: any;
}

const world = {
  orders: [] as Row[],
  statements: [] as Row[],
  lines: [] as Row[],
  matches: [] as Row[],
  receipts: [] as Row[],
  /** Called with the order read's count, so a test can change the world between the first read and the locked one. */
  onOrderRead: null as null | ((n: number) => void),
  orderReads: 0,
  seq: 0,
};

function ok(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some((w) => ok(row, w));
    // `receipts: { none: {} }` — the statement has no receipt.
    if (key === 'receipts') return world.receipts.every((r) => r.statementId !== row.id);
    if (key === 'statement') return ok(row.statement, want);
    const have = row[key];
    if (want === null) return have == null;
    if (want && typeof want === 'object') {
      if ('in' in want) return want.in.includes(have);
      if ('not' in want) return have !== want.not;
      if ('startsWith' in want) return typeof have === 'string' && have.startsWith(want.startsWith);
      return false;
    }
    return have === want;
  });
}

const statementView = (s: Row) => ({
  ...s,
  _count: { receipts: world.receipts.filter((r) => r.statementId === s.id).length },
  deliveryProvider: { name: s.courierName ?? 'الباشا' },
});

const tx = {
  $executeRaw: vi.fn(async () => 1),
  $queryRaw: vi.fn(async () => []),
  order: {
    findMany: vi.fn(async ({ where }: { where: Row }) => {
      world.orderReads += 1;
      world.onOrderRead?.(world.orderReads);
      return world.orders.filter((o) => ok(o, where)).map((o) => structuredClone(o));
    }),
  },
  courierStatement: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const found = world.statements.find((s) => ok(s, where));
      return found ? statementView(found) : null;
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `st-${++world.seq}`, approvedAt: null, status: 'IMPORTED', createdAt: new Date(), ...data };
      world.statements.push(row);
      return { id: row.id };
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      Object.assign(world.statements.find((s) => s.id === where.id)!, data);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = world.statements.filter((s) => ok(s, where));
      hit.forEach((s) => Object.assign(s, data));
      return { count: hit.length };
    }),
  },
  statementLine: {
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      world.lines
        .map((l) => ({ ...l, statement: world.statements.find((s) => s.id === l.statementId) }))
        .filter((l) => ok(l, where))
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      world.lines.push({ id: `ln-${++world.seq}`, ...data });
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      Object.assign(world.lines.find((l) => l.id === where.id)!, data);
    }),
  },
  settlementMatch: {
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      world.matches
        .map((m) => ({ ...m, statement: world.statements.find((s) => s.id === m.statementId) }))
        .filter((m) => where.orderId.in.includes(m.orderId) && (!where.statementId || m.statementId !== where.statementId.not))
    ),
  },
};

const scope = { companyId: 'c1', storeId: 's1', userId: 'u1', currencyCode: 'JOD', minorUnit: 3 };

/** A delivered 20.000 order with a 2.500 fee inside the price: expected net 17.500. */
const jod = (n: number, over: Row = {}): Row => ({
  id: `o${n}`,
  orderNumber: `JO-2026-000${n}`,
  merchantRef: `JO-2026-000${n}`,
  trackingNumber: null,
  currency: 'JOD',
  settlementStatus: 'PENDING_COLLECTION',
  deliveryProviderId: 'cA',
  deliveryProvider: { id: 'cA', name: 'الباشا' },
  companyId: 'c1',
  storeId: 's1',
  shippingStatus: 'DELIVERED',
  totalAmount: 20,
  collectedAmount: null,
  deliveryFee: 2.5,
  priceIncludesDelivery: true,
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, deliveredQty: null }],
  addOns: [],
  returnReceipt: null,
  ...over,
});

const add = (items: { orderId: string; amount?: number }[], over: Row = {}) =>
  addOrdersToDraft(tx as never, { ...scope, ...over, items });

async function refusal(run: () => Promise<unknown>): Promise<ManualRefused> {
  try {
    await run();
  } catch (e) {
    if (e instanceof ManualRefused) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.clearAllMocks();
  world.orders = [jod(1), jod(2), jod(3)];
  world.statements = [];
  world.lines = [];
  world.matches = [];
  world.receipts = [];
  world.onOrderRead = null;
  world.orderReads = 0;
  world.seq = 0;
});

describe('press 1 — the first press makes the draft and puts the orders in it', () => {
  it('one draft with the manual-draft hash, one line per order, carrying the order’s reference and nothing else to find it by', async () => {
    const r = await add([{ orderId: 'o1' }, { orderId: 'o2' }]);

    expect(r).toMatchObject({ created: true, added: 2, updated: 0, lines: 2, courier: 'الباشا', currencyCode: 'JOD' });
    expect(world.statements).toHaveLength(1);
    expect(world.statements[0].fileHash.startsWith(MANUAL_DRAFT_PREFIX)).toBe(true);
    expect(world.statements[0]).toMatchObject({ deliveryProviderId: 'cA', companyId: 'c1', storeId: 's1', approvedAt: null });
    expect(world.lines.map((l) => [l.merchantRef, l.barcode])).toEqual([
      ['JO-2026-0001', null],
      ['JO-2026-0002', null],
    ]);
  });

  it('a line’s amount is what we expect the courier to hand over — NET of his fee — and it states the fee, so the gross can be written', async () => {
    await add([{ orderId: 'o1' }]);
    // 20.000 inside which the 2.500 fee sits: 17.500 to hand over.
    expect(world.lines[0]).toMatchObject({ amount: 17.5, fee: 2.5, collected: 20 });
    expect(world.statements[0].totalAmount).toBe(17.5);
  });

  it('a short handover is recorded on THAT order only', async () => {
    const r = await add([{ orderId: 'o1' }, { orderId: 'o2', amount: 15.5 }]);
    expect(world.lines.map((l) => l.amount)).toEqual([17.5, 15.5]);
    expect(world.lines[1].collected).toBe(18);
    expect(r.total).toBe(33);
  });

  it('in a currency of three decimals every figure is rounded to the fils', async () => {
    const r = await add([
      { orderId: 'o1', amount: 12.3456 },
      { orderId: 'o2', amount: 0.0004 },
      { orderId: 'o3', amount: 17.5005 },
    ]);
    expect(world.lines.map((l) => l.amount)).toEqual([12.346, 0, 17.501]);
    // 12.346 + 0 + 17.501, summed once and rounded once.
    expect(r.total).toBe(29.847);
    expect(world.statements[0].totalAmount).toBe(29.847);
  });

  it('and in a currency of two decimals by the same rule', async () => {
    world.orders = [jod(1, { currency: 'USD', deliveryFee: 2.5 })];
    await add([{ orderId: 'o1', amount: 10.005 }], { currencyCode: 'USD', minorUnit: 2 });
    expect(world.lines[0].amount).toBe(10.01);
  });

  it('writes no money anywhere: no order is settled and no wallet is touched', async () => {
    await add([{ orderId: 'o1' }]);
    expect(Object.keys(tx.order)).toEqual(['findMany']);
    expect(Object.keys(tx)).not.toContain('walletMovement');
    expect(world.orders[0].settlementStatus).toBe('PENDING_COLLECTION');
  });
});

describe('two presses in a row — the second changes nothing it should not', () => {
  it('the same orders again make no second draft and no second line', async () => {
    await add([{ orderId: 'o1' }, { orderId: 'o2' }]);
    const again = await add([{ orderId: 'o1' }, { orderId: 'o2' }]);

    expect(again).toMatchObject({ created: false, added: 0, updated: 2, lines: 2 });
    expect(world.statements).toHaveLength(1);
    expect(world.lines).toHaveLength(2);
  });

  it('a figure a person typed is not reset by a second press that typed nothing', async () => {
    await add([{ orderId: 'o1', amount: 15.5 }]);
    await add([{ orderId: 'o1' }]);
    expect(world.lines[0].amount).toBe(15.5);
    expect(world.statements[0].totalAmount).toBe(15.5);
  });

  it('a new figure for an order already in the draft replaces the old one', async () => {
    await add([{ orderId: 'o1', amount: 15.5 }]);
    const again = await add([{ orderId: 'o1', amount: 16 }]);
    expect(again).toMatchObject({ added: 0, updated: 1, lines: 1, total: 16 });
    expect(world.lines).toHaveLength(1);
  });

  it('a third order joins the SAME draft', async () => {
    await add([{ orderId: 'o1' }]);
    const r = await add([{ orderId: 'o2' }, { orderId: 'o3' }]);
    expect(r).toMatchObject({ created: false, added: 2, lines: 3, total: 52.5 });
    expect(world.statements).toHaveLength(1);
  });

  it('the same order twice in ONE press is one order, and the last figure wins', async () => {
    const r = await add([{ orderId: 'o1', amount: 10 }, { orderId: 'o1', amount: 12 }]);
    expect(r).toMatchObject({ added: 1, lines: 1, total: 12 });
  });
});

describe('adding stops at the first receipt', () => {
  it('a draft that already took a receipt takes no order, and nothing is written', async () => {
    await add([{ orderId: 'o1' }]);
    world.receipts.push({ id: 'r1', statementId: world.statements[0].id });

    const e = await refusal(() => add([{ orderId: 'o2' }]));

    expect(e.status).toBe(409);
    expect(e.body.code).toBe('HAS_RECEIPT');
    expect(world.lines).toHaveLength(1);
    expect(world.statements[0].totalAmount).toBe(17.5);
  });

  it('and once gathered, an order is added to a NEW draft, not to the gathered statement', async () => {
    await add([{ orderId: 'o1' }]);
    await assembleDraft(tx as never, { ...scope, statementId: world.statements[0].id, reference: 'كشف الأحد', periodFrom: null, periodTo: null });

    const r = await add([{ orderId: 'o2' }]);

    expect(r.created).toBe(true);
    expect(world.statements).toHaveLength(2);
    expect(world.lines.filter((l) => l.statementId === world.statements[0].id)).toHaveLength(1);
  });
});

describe('who may enter', () => {
  it('an order with no courier is refused by name and nothing is made', async () => {
    world.orders = [jod(1), jod(2, { deliveryProviderId: null, deliveryProvider: null })];
    const e = await refusal(() => add([{ orderId: 'o1' }, { orderId: 'o2' }]));
    expect(e.body.code).toBe('NO_COURIER');
    expect(e.body.error).toContain('JO-2026-0002');
    expect(world.statements).toHaveLength(0);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('two couriers in one press are refused', async () => {
    world.orders = [jod(1), jod(2, { deliveryProviderId: 'cB', deliveryProvider: { id: 'cB', name: 'أمان' } })];
    const e = await refusal(() => add([{ orderId: 'o1' }, { orderId: 'o2' }]));
    expect(e.body.code).toBe('MIXED_COURIERS');
    expect(world.statements).toHaveLength(0);
  });

  it('an order of another store, or none at all, is «not found» — the read is scoped to this store', async () => {
    world.orders = [jod(1), jod(2, { storeId: 's2' })];
    const e = await refusal(() => add([{ orderId: 'o1' }, { orderId: 'o2' }]));
    expect(e.status).toBe(404);
    expect(e.body.code).toBe('ORDERS_NOT_FOUND');
  });

  it('an order not delivered, and one already settled', async () => {
    world.orders = [jod(1, { shippingStatus: 'SHIPPED' })];
    expect((await refusal(() => add([{ orderId: 'o1' }]))).body.code).toBe('NOT_DELIVERED');
    world.orders = [jod(1, { settlementStatus: 'SETTLED' })];
    expect((await refusal(() => add([{ orderId: 'o1' }]))).body.code).toBe('ALREADY_SETTLED');
  });

  it('an order a collection settled between the first read and the lock is refused — the state is read again under the lock', async () => {
    world.onOrderRead = (n) => {
      if (n === 2) world.orders[0].settlementStatus = 'SETTLED';
    };
    const e = await refusal(() => add([{ orderId: 'o1' }]));
    expect(e.body.code).toBe('ALREADY_SETTLED');
    expect(world.statements).toHaveLength(0);
    expect(world.lines).toHaveLength(0);
  });

  it('the courier lock is taken before the draft is looked for, and the order rows are locked before they are judged', async () => {
    await add([{ orderId: 'o1' }]);
    const lock = tx.$executeRaw.mock.invocationCallOrder[0];
    const rows = tx.$queryRaw.mock.invocationCallOrder[0];
    const draftLookup = tx.courierStatement.findFirst.mock.invocationCallOrder[0];
    const secondRead = tx.order.findMany.mock.invocationCallOrder[1];
    expect(lock).toBeLessThan(rows);
    expect(rows).toBeLessThan(secondRead);
    expect(lock).toBeLessThan(draftLookup);
    expect(String(tx.$executeRaw.mock.calls[0])).toContain('pg_advisory_xact_lock');
  });

  it('a lock taken on the root client would be dropped at once, so the root client is refused', async () => {
    await expect(
      addOrdersToDraft({ ...tx, $transaction: vi.fn() } as never, { ...scope, items: [{ orderId: 'o1' }] })
    ).rejects.toThrow(/معاملة/);
  });
});

describe('an order another statement already names is paid by it', () => {
  const realStatement = (over: Row = {}) => ({
    id: 'real-1', companyId: 'c1', storeId: 's1', deliveryProviderId: 'cA', reference: 'ST-2026-09',
    status: 'MATCHED', approvedAt: null, courierName: 'الباشا', fileHash: 'ab'.repeat(32), ...over,
  });

  it('on a statement not yet approved: refused, and the sentence says its money is written at approval', async () => {
    world.statements = [realStatement()];
    world.lines = [{ id: 'l1', statementId: 'real-1', merchantRef: 'JO-2026-0001', barcode: null, amount: 17.5 }];
    const e = await refusal(() => add([{ orderId: 'o1' }, { orderId: 'o2' }]));
    expect(e.body.code).toBe('ON_UNAPPROVED_STATEMENT');
    expect(e.body.error).toContain('JO-2026-0001');
    expect(e.body.error).not.toContain('JO-2026-0002');
  });

  it('on an approved one: refused, and the sentence says the money came in with it', async () => {
    world.statements = [realStatement({ status: 'APPROVED', approvedAt: new Date() })];
    world.lines = [{ id: 'l1', statementId: 'real-1', merchantRef: 'JO-2026-0001', barcode: null, amount: 17.5 }];
    const e = await refusal(() => add([{ orderId: 'o1' }]));
    expect(e.body.code).toBe('IN_APPROVED_STATEMENT');
    expect(e.body.error).toContain('ST-2026-09');
  });

  it('on a line a person tied to it by hand: refused even though that line carries none of its references', async () => {
    world.statements = [realStatement()];
    world.matches = [{ orderId: 'o1', statementId: 'real-1', statementLineId: 'l9' }];
    const e = await refusal(() => add([{ orderId: 'o1' }]));
    expect(e.body.code).toBe('ON_UNAPPROVED_STATEMENT');
  });

  it('on another manual statement of the same courier (gathered, not approved): refused the same way', async () => {
    await add([{ orderId: 'o1' }]);
    const first = world.statements[0];
    await assembleDraft(tx as never, { ...scope, statementId: first.id, reference: 'الأحد', periodFrom: null, periodTo: null });
    const e = await refusal(() => add([{ orderId: 'o1' }, { orderId: 'o2' }]));
    expect(e.body.code).toBe('ON_UNAPPROVED_STATEMENT');
    expect(e.body.error).toContain('JO-2026-0001');
  });

  it('the draft’s OWN lines are not a reason to refuse an order a second time', async () => {
    await add([{ orderId: 'o1' }]);
    await expect(add([{ orderId: 'o1' }])).resolves.toMatchObject({ updated: 1 });
  });
});

describe('press 2 — gathering', () => {
  const draftWith = async (orders: { orderId: string; amount?: number }[] = [{ orderId: 'o1' }, { orderId: 'o2' }]) => {
    await add(orders);
    return world.statements[world.statements.length - 1];
  };
  const gather = (statementId: string, reference: string, over: Row = {}) =>
    assembleDraft(tx as never, { ...scope, statementId, reference, periodFrom: null, periodTo: null, ...over });

  it('the draft becomes a statement: the reference, the period, the total, and a hash made of company + courier + reference', async () => {
    const draft = await draftWith();
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-07T23:59:59Z');

    const r = await gather(draft.id, '  كشف الأحد ', { periodFrom: from, periodTo: to });

    expect(r).toMatchObject({ reference: 'كشف الأحد', courier: 'الباشا', lines: 2, total: 35, currencyCode: 'JOD' });
    expect(draft).toMatchObject({
      reference: 'كشف الأحد',
      periodFrom: from,
      periodTo: to,
      totalAmount: 35,
      fileHash: manualFileHash({ companyId: 'c1', courierId: 'cA', reference: 'كشف الأحد' }),
    });
  });

  it('the write is conditional on the same draft with no receipt — the claim itself says what the reads said', async () => {
    const draft = await draftWith();
    const hashBefore = draft.fileHash;
    await gather(draft.id, 'الأحد');
    const where = tx.courierStatement.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: draft.id, approvedAt: null, fileHash: hashBefore, receipts: { none: {} } });
  });

  it('a claim that lost (count 0) is refused in words and writes nothing', async () => {
    const draft = await draftWith();
    tx.courierStatement.updateMany.mockResolvedValueOnce({ count: 0 });
    const e = await refusal(() => gather(draft.id, 'الأحد'));
    expect(e.body.code).toBe('CHANGED');
  });

  it('the same reference for ANOTHER courier is no conflict', async () => {
    const a = await draftWith();
    await gather(a.id, 'كشف الأحد');

    world.orders = [jod(7, { deliveryProviderId: 'cB', deliveryProvider: { id: 'cB', name: 'أمان' } })];
    await add([{ orderId: 'o7' }]);
    const b = world.statements[world.statements.length - 1];
    b.courierName = 'أمان';
    await expect(gather(b.id, 'كشف الأحد')).resolves.toMatchObject({ reference: 'كشف الأحد' });
    expect(a.fileHash).not.toBe(b.fileHash);
  });

  it('the same reference twice for the SAME courier is refused, naming the reference', async () => {
    const a = await draftWith();
    await gather(a.id, 'كشف الأحد');
    world.orders = [jod(4), jod(5)];
    const b = await draftWith([{ orderId: 'o4' }]);
    const e = await refusal(() => gather(b.id, ' كشف الأحد '));
    expect(e.status).toBe(409);
    expect(e.body.code).toBe('DUPLICATE_REFERENCE');
    expect(e.body.error).toContain('كشف الأحد');
    expect(b.fileHash.startsWith(MANUAL_DRAFT_PREFIX)).toBe(true);
  });

  it('refuses a statement that is not a draft: a file’s, one already gathered, one approved, one with a receipt', async () => {
    const draft = await draftWith();
    world.statements.push({
      id: 'file-1', companyId: 'c1', storeId: 's1', deliveryProviderId: 'cA', status: 'MATCHED', approvedAt: null,
      currencyCode: 'JOD', fileHash: 'cd'.repeat(32),
    });
    expect((await refusal(() => gather('file-1', 'X1'))).body.code).toBe('NOT_MANUAL');

    expect((await refusal(() => gather('nope', 'X1'))).status).toBe(404);

    world.receipts.push({ id: 'r1', statementId: draft.id });
    expect((await refusal(() => gather(draft.id, 'X1'))).body.code).toBe('HAS_RECEIPT');
    world.receipts = [];

    draft.approvedAt = new Date();
    expect((await refusal(() => gather(draft.id, 'X1'))).body.code).toBe('ALREADY_APPROVED');
    draft.approvedAt = null;

    await gather(draft.id, 'X1');
    expect((await refusal(() => gather(draft.id, 'X2'))).body.code).toBe('ALREADY_ASSEMBLED');
  });

  it('a total of zero is refused with «استلمت منه»’s own sentence', async () => {
    const draft = await draftWith([{ orderId: 'o1', amount: 0 }]);
    const e = await refusal(() => gather(draft.id, 'X1'));
    expect(e.body).toMatchObject({
      code: 'NOTHING_TO_COLLECT',
      error: collectTotalRefusal({ expected: 0, owed: 0, currency: 'JOD', count: 1 })!.error,
    });
    expect(e.body.error).toContain('لا يوجد مبلغ لقبضه');
    expect(draft.fileHash.startsWith(MANUAL_DRAFT_PREFIX)).toBe(true);
  });

  it('a total below zero says the company owes the courier — and how much, to the fils', async () => {
    const draft = await draftWith([{ orderId: 'o1', amount: -1.5 }, { orderId: 'o2', amount: 0.25 }]);
    const e = await refusal(() => gather(draft.id, 'X1'));
    expect(e.body.code).toBe('OWED_TO_COURIER');
    expect(e.body.error).toContain('1.25 JOD');
  });

  it('but a negative line inside a positive total is fine: a statement nets, as a settlement does', async () => {
    const draft = await draftWith([{ orderId: 'o1', amount: -1.5 }, { orderId: 'o2', amount: 17.5 }]);
    await expect(gather(draft.id, 'X1')).resolves.toMatchObject({ total: 16 });
  });
});
