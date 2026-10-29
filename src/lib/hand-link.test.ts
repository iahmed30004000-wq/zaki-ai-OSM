import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «اربطه بطلب» — A LINE NO ORDER OF OURS CARRIES, TIED TO ITS ORDER BY A PERSON.
 *
 * The fake database below answers the `where` clauses the link writes (equality, `in`, `not`, `OR`), so these are
 * not tests of call shapes alone: a row that merely disagreed reserves nothing, a row that matched does, and the
 * answer comes from the rows, not from a mock that was told what to say.
 */

vi.mock('./db', () => ({ db: {} }));

import {
  CANDIDATE_LIMIT,
  LinkRefused,
  MIN_QUERY,
  OTHER_COURIER_WARNING,
  OTHER_STORE_SENTENCE,
  NOT_SHIPPED_SENTENCE,
  candidatesHeader,
  findLinkCandidates,
  linkLineToOrder,
  rankCandidates,
} from './hand-link';
import { HAND_COLLECTED_NOTE, MANUAL_MATCH, SAME_FILE_NOTE } from './match-integrity';

type Row = Record<string, unknown>;

/** The few `where` shapes the link writes: equality, { in }, { not }, { equals }, and OR / AND lists. */
function fits(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some((w) => fits(row, w));
    if (key === 'AND') return (want as Row[]).every((w) => fits(row, w));
    const have = row[key];
    if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
      const w = want as Row;
      if ('in' in w) return (w.in as unknown[]).includes(have);
      if ('notIn' in w) return !(w.notIn as unknown[]).includes(have);
      if ('isNot' in w) return have != w.isNot;
      if ('not' in w) return have !== w.not;
      if ('equals' in w) return String(have).toLowerCase() === String(w.equals).toLowerCase();
      return true; // a nested relation filter or a text search: the fake does not narrow on it
    }
    return have === want;
  });
}

const JOD = 3;

function order(over: Row = {}): Row {
  const total = Number(over.totalAmount ?? 20);
  return {
    id: 'o1', companyId: 'c1', orderNumber: 'ORD-1', merchantRef: 'REF-1', storeId: 's1', deliveryProviderId: 'dp1',
    settlementStatus: 'PENDING', confirmationStatus: 'CONFIRMED', shippingStatus: 'DELIVERED',
    shippedAt: new Date('2026-10-20T00:00:00Z'), labelPrintedAt: null, createdAt: new Date('2026-10-18T00:00:00Z'),
    totalAmount: total, collectedAmount: null, deliveryFee: 0, priceIncludesDelivery: false,
    returnReceipt: null, addOns: [],
    items: [{ quantity: 1, freeQuantity: 0, unitPrice: total, discountShare: 0, lineTotal: total, deliveredQty: null }],
    customer: { id: 'cu1', fullName: 'سارة', phone: '0790000001' },
    ...over,
  };
}

interface World {
  statement: Row;
  matches: Row[];
  orders: Row[];
  requests: Row[];
  notes: Row[];
}

function makeWorld(over: Partial<World> = {}): World {
  return {
    statement: { id: 'st1', companyId: 'c1', storeId: 's1', status: 'MATCHED', approvedAt: null, reference: 'ST-1', deliveryProviderId: 'dp1' },
    matches: [
      { id: 'm1', companyId: 'c1', statementId: 'st1', statementLineId: 'l1', orderId: null, result: 'MISSING_IN_SYSTEM', matchedBy: null, resolution: null, statementAmount: 20,
        statementLine: { amount: 20, fee: null, status: null } },
    ],
    orders: [order()],
    requests: [],
    notes: [],
    ...over,
  };
}

/** A transaction client over the world. Every write is recorded, so a test can say what was NOT written. */
function makeTx(w: World) {
  const counts: Record<string, number> = {};
  const hit = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  const tx = {
    counts,
    courierStatement: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => (fits(w.statement, where) ? w.statement : null)),
    },
    settlementMatch: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => w.matches.find((m) => fits(m, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        w.matches
          .filter((m) => fits(m, where))
          .map((m) => ({
            ...m,
            statement: m.statementId === 'st1' ? w.statement : (m.statementRow as Row) ?? { reference: 'ST-2', approvedAt: null },
          }))
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        hit('match.updateMany');
        const rows = w.matches.filter((m) => fits(m, where));
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        hit('match.deleteMany');
        const keep = w.matches.filter((m) => !fits(m, where));
        const n = w.matches.length - keep.length;
        w.matches.splice(0, w.matches.length, ...keep);
        return { count: n };
      }),
    },
    order: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => w.orders.find((o) => fits(o, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Row }) => w.orders.filter((o) => fits(o, where))),
      count: vi.fn(async ({ where }: { where: Row }) => w.orders.filter((o) => fits(o, where)).length),
    },
    orderChangeRequest: {
      findMany: vi.fn(async ({ where }: { where: Row }) => w.requests.filter((r) => fits(r, { orderId: where.orderId }))),
    },
    orderNote: { create: vi.fn(async ({ data }: { data: Row }) => { hit('note.create'); w.notes.push(data); return data; }) },
  };
  return tx;
}

const scope = { companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'm1', minorUnit: JOD };
const link = (tx: ReturnType<typeof makeTx>, over: Row = {}) =>
  linkLineToOrder(tx as never, { ...scope, orderId: 'o1', userId: 'u1', acceptOtherCourier: false, ...over });
const search = (tx: ReturnType<typeof makeTx>, query: string) => findLinkCandidates(tx as never, { ...scope, query });

async function refusedWith(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LinkRefused);
    return e as LinkRefused;
  }
  throw new Error('expected the link to be refused');
}

let w: World;
beforeEach(() => {
  w = makeWorld();
});

describe('a successful link writes the matcher’s own verdict onto the line’s row', () => {
  it('MATCHED when the figures agree and nothing else forbids it', async () => {
    const tx = makeTx(w);
    const r = await link(tx);
    expect(r).toMatchObject({ result: 'MATCHED', orderNumber: 'ORD-1', difference: 0, otherCourier: false });
    expect(w.matches[0]).toMatchObject({
      orderId: 'o1', result: 'MATCHED', matchedBy: MANUAL_MATCH, expectedAmount: 20, statementAmount: 20, difference: 0, note: null,
    });
    // One row for the line, not two: the line has one answer.
    expect(w.matches).toHaveLength(1);
  });

  it('MISMATCHED with the difference when the figures disagree', async () => {
    w.matches[0].statementLine = { amount: 18.5, fee: null, status: null };
    const r = await link(makeTx(w));
    expect(r).toMatchObject({ result: 'MISMATCHED', expected: 20, stated: 18.5, difference: -1.5 });
    expect(w.matches[0]).toMatchObject({ result: 'MISMATCHED', matchedBy: MANUAL_MATCH, difference: -1.5 });
    // Nobody decided it: it is a difference waiting for «رقمنا / رقمهم», like an automatic one.
    expect(w.matches[0].resolution).toBeNull();
  });

  it('MISMATCHED with the fee named when only the delivery fee differs', async () => {
    w.orders = [order({ totalAmount: 20, deliveryFee: 2.5, collectedAmount: 20 })];
    w.matches[0].statementLine = { amount: 17.5, fee: 3, status: null };
    const r = await link(makeTx(w));
    expect(r.result).toBe('MISMATCHED');
    expect(r.note).toContain('أجرة التوصيل 3 بدل 2.5');
    expect(w.matches[0]).toMatchObject({ expectedFee: 2.5, statementFee: 3, feeDifference: 0.5 });
  });

  it('three decimals for a dinar: 17.505 is 17.505, not 17.51', async () => {
    w.orders = [order({ totalAmount: 20, deliveryFee: 2.495, collectedAmount: 20 })];
    w.matches[0].statementLine = { amount: 17.505, fee: 2.495, status: null };
    const r = await link(makeTx(w));
    expect(r).toMatchObject({ result: 'MATCHED', expected: 17.505, stated: 17.505, difference: 0 });
    expect(w.matches[0]).toMatchObject({ expectedAmount: 17.505, statementAmount: 17.505, expectedFee: 2.495, statementFee: 2.495 });
  });

  it('an open cancel request makes it MISMATCHED with the reason, even when the figures agree', async () => {
    w.requests = [{ orderId: 'o1', intent: 'CANCEL' }];
    const r = await link(makeTx(w));
    expect(r.result).toBe('MISMATCHED');
    expect(r.difference).toBe(0);
    expect(r.note).toContain('عليه طلب إلغاء مفتوح');
  });

  it('removes the order’s «لم يذكره أي كشف» row of this statement, and leaves other statements’ rows', async () => {
    w.matches.push(
      { id: 'mx1', companyId: 'c1', statementId: 'st1', statementLineId: null, orderId: 'o1', result: 'MISSING_IN_STATEMENT', matchedBy: null, resolution: null },
      { id: 'mx2', companyId: 'c1', statementId: 'st9', statementLineId: null, orderId: 'o1', result: 'MISSING_IN_STATEMENT', matchedBy: null, resolution: null }
    );
    await link(makeTx(w));
    expect(w.matches.map((m) => m.id).sort()).toEqual(['m1', 'mx2']);
  });

  it('leaves a note on the order saying who tied it to which statement', async () => {
    await link(makeTx(w));
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]).toMatchObject({ orderId: 'o1', authorId: 'u1', kind: 'internal' });
    expect(String(w.notes[0].body)).toContain('ST-1');
  });

  it('moves no money: no order is updated and no wallet is touched', async () => {
    const tx = makeTx(w) as unknown as Record<string, unknown>;
    await link(tx as never);
    expect(Object.keys(tx.order as object).sort()).toEqual(['count', 'findFirst', 'findMany']);
    expect(Object.keys(tx)).not.toContain('walletMovement');
  });
});

describe('what a link refuses', () => {
  it('an order of another store, even in the same company', async () => {
    w.orders = [order({ storeId: 's2' })];
    const tx = makeTx(w);
    const e = await refusedWith(link(tx));
    expect(e.body).toMatchObject({ code: 'OTHER_STORE', error: OTHER_STORE_SENTENCE });
    expect(tx.counts['match.updateMany']).toBeUndefined();
  });

  it('an order of another company is not even found', async () => {
    w.orders = [order({ companyId: 'c2' })];
    const e = await refusedWith(link(makeTx(w)));
    expect(e.body.code).toBe('ORDER_NOT_FOUND');
  });

  it('a SETTLED order that nobody’s statement paid: collected by hand', async () => {
    w.orders = [order({ settlementStatus: 'SETTLED' })];
    const tx = makeTx(w);
    const e = await refusedWith(link(tx));
    expect(e.body.code).toBe('ORDER_NOT_LINKABLE');
    expect(e.body.reasons).toContain(HAND_COLLECTED_NOTE);
    expect(tx.counts['match.updateMany']).toBeUndefined();
    expect(w.matches[0]).toMatchObject({ result: 'MISSING_IN_SYSTEM', orderId: null });
  });

  it('an order a line of THIS statement already holds', async () => {
    w.matches.push({ id: 'm2', companyId: 'c1', statementId: 'st1', statementLineId: 'l2', orderId: 'o1', result: 'MATCHED', matchedBy: 'MERCHANT_REF', resolution: null });
    const e = await refusedWith(link(makeTx(w)));
    expect(e.body.reasons).toEqual([SAME_FILE_NOTE]);
  });

  it('an order another statement holds, naming that statement', async () => {
    w.matches.push({
      id: 'm3', companyId: 'c1', statementId: 'st2', statementLineId: 'l9', orderId: 'o1', result: 'MATCHED', matchedBy: 'BARCODE', resolution: null,
      statementRow: { reference: 'ST-2', approvedAt: null },
    });
    const e = await refusedWith(link(makeTx(w)));
    expect(e.body.code).toBe('ORDER_NOT_LINKABLE');
    expect(e.body.error).toContain('ST-2');
  });

  it('an order whose money another APPROVED statement already moved', async () => {
    w.orders = [order({ settlementStatus: 'SETTLED' })];
    w.matches.push({
      id: 'm3', companyId: 'c1', statementId: 'st2', statementLineId: 'l9', orderId: 'o1', result: 'MATCHED', matchedBy: 'BARCODE', resolution: null,
      statementRow: { reference: 'ST-2', approvedAt: new Date() },
    });
    const e = await refusedWith(link(makeTx(w)));
    expect(e.body.reasons?.some((r) => r.includes('ST-2'))).toBe(true);
    // It was paid through a statement, so the sentence is not «collected by hand».
    expect(e.body.reasons).not.toContain(HAND_COLLECTED_NOTE);
  });

  it('an approved statement: linking decides what approval settles', async () => {
    w.statement.approvedAt = new Date();
    w.statement.status = 'APPROVED';
    const e = await refusedWith(link(makeTx(w)));
    expect(e.body.code).toBe('ALREADY_APPROVED');
  });

  it('a row that is not an unlinked «في الكشف وليس عندنا»', async () => {
    w.matches[0].result = 'MATCHED';
    expect((await refusedWith(link(makeTx(w)))).body.code).toBe('NOT_LINKABLE');
    w = makeWorld();
    w.matches[0].orderId = 'o5';
    expect((await refusedWith(link(makeTx(w)))).body.code).toBe('NOT_LINKABLE');
  });

  it('an order that never left the warehouse', async () => {
    w.orders = [order({ shippingStatus: 'PACKING', shippedAt: null })];
    const e = await refusedWith(link(makeTx(w)));
    expect(e.body).toMatchObject({ code: 'NOT_SHIPPED', error: NOT_SHIPPED_SENTENCE });
  });

  it('two people pressing at once: the second finds the row already linked and writes nothing', async () => {
    const tx = makeTx(w);
    const first = await link(tx);
    expect(first.result).toBe('MATCHED');
    const e = await refusedWith(link(tx));
    expect(e.body.code).toBe('NOT_LINKABLE');
  });

  it('a conditional write that finds the row gone is refused, not ignored', async () => {
    const tx = makeTx(w);
    tx.settlementMatch.updateMany.mockResolvedValueOnce({ count: 0 });
    const e = await refusedWith(link(tx));
    expect(e.body.code).toBe('NOT_LINKABLE');
    expect(tx.counts['note.create']).toBeUndefined();
  });
});

describe('only a row that took the order reserves it', () => {
  it('a line that merely disagreed on another statement reserves nothing: the order can still be linked here', async () => {
    w.matches.push({
      id: 'm4', companyId: 'c1', statementId: 'st2', statementLineId: 'l9', orderId: 'o1', result: 'MISMATCHED', matchedBy: 'BARCODE', resolution: null,
      statementRow: { reference: 'ST-2', approvedAt: null },
    });
    expect((await link(makeTx(w))).result).toBe('MATCHED');
  });

  it('but one decided «اعتُمد رقم الشركة» does', async () => {
    w.matches.push({
      id: 'm4', companyId: 'c1', statementId: 'st2', statementLineId: 'l9', orderId: 'o1', result: 'MISMATCHED', matchedBy: 'BARCODE', resolution: 'ACCEPTED_COURIER',
      statementRow: { reference: 'ST-2', approvedAt: null },
    });
    const e = await refusedWith(link(makeTx(w)));
    expect(e.body.error).toContain('ST-2');
  });

  it('and a line of this statement that merely disagreed reserves nothing either', async () => {
    w.matches.push({ id: 'm5', companyId: 'c1', statementId: 'st1', statementLineId: 'l2', orderId: 'o1', result: 'MISMATCHED', matchedBy: 'MERCHANT_REF', resolution: null });
    expect((await link(makeTx(w))).result).toBe('MATCHED');
  });
});

describe('the courier of the order', () => {
  beforeEach(() => {
    w.orders = [order({ deliveryProviderId: 'dp2' })];
  });

  it('another courier’s order is refused until the person has read the warning', async () => {
    const e = await refusedWith(link(makeTx(w)));
    expect(e.body).toMatchObject({ code: 'OTHER_COURIER', error: OTHER_COURIER_WARNING });
    expect(w.matches[0].orderId).toBeNull();
  });

  it('and linked with the warning accepted, saying so', async () => {
    const r = await link(makeTx(w), { acceptOtherCourier: true });
    expect(r.otherCourier).toBe(true);
    expect(w.matches[0]).toMatchObject({ orderId: 'o1', matchedBy: MANUAL_MATCH });
  });
});

describe('the search', () => {
  it('says how many characters it needs, and reads nothing before that', async () => {
    const tx = makeTx(w);
    const r = await search(tx, 'ab');
    expect(r.hint).toContain(String(MIN_QUERY));
    expect(r.candidates).toEqual([]);
    expect(tx.order.findMany).not.toHaveBeenCalled();
    expect(tx.order.count).not.toHaveBeenCalled();
  });

  it('opens with «لهذا الرقم 4 طلبات: 1 مغلق، 3 مفتوحة», counted with the one closed rule', async () => {
    w.orders = [
      order({ id: 'a', orderNumber: 'A', settlementStatus: 'SETTLED' }),
      order({ id: 'b', orderNumber: 'B' }),
      order({ id: 'c', orderNumber: 'C', shippingStatus: 'SHIPPED' }),
      order({ id: 'd', orderNumber: 'D', shippingStatus: 'OUT_FOR_DELIVERY' }),
    ];
    const tx = makeTx(w);
    const r = await search(tx, '0790000001');
    expect(r.counts).toEqual({ total: 4, closed: 1, open: 3 });
    expect(r.header).toBe('لهذا الرقم 4 طلبات: 1 مغلق، 3 مفتوحة');
    // The closed count is the database's, asked with `whereClosed` — not a count of the rows on the page.
    const closedAsk = tx.order.count.mock.calls[1][0].where as { AND: Row[] };
    expect(JSON.stringify(closedAsk.AND[1])).toContain('"settlementStatus":"SETTLED"');
  });

  it('the header words for none and for one', () => {
    expect(candidatesHeader(0, 0)).toBe('لا طلبات لهذا البحث');
    expect(candidatesHeader(1, 1)).toBe('لهذا الرقم طلب واحد: مغلق');
    expect(candidatesHeader(1, 0)).toBe('لهذا الرقم طلب واحد: مفتوح');
    expect(candidatesHeader(3, 0)).toBe('لهذا الرقم 3 طلبات: 0 مغلق، 3 مفتوحة');
  });

  it('is scoped to the statement’s store and courier — the request cannot widen it', async () => {
    const tx = makeTx(w);
    await search(tx, '0790000001');
    const where = tx.order.findMany.mock.calls[0][0].where as { OR: Row[] };
    const main = where.OR[0];
    expect(main).toMatchObject({ companyId: 'c1', storeId: 's1', deliveryProviderId: 'dp1' });
    // The search is a typed one (case ignored), on the phone among the rest.
    expect(JSON.stringify(main.OR)).toContain('"mode":"insensitive"');
    expect(JSON.stringify(main.OR)).toContain('"phone"');
    // The only widening is OUR number, exact, and still inside the store.
    expect(where.OR[1]).toMatchObject({ companyId: 'c1', storeId: 's1' });
    expect(JSON.stringify(where.OR[1])).toContain('"equals":"0790000001"');
    expect(where.OR[1]).not.toHaveProperty('deliveryProviderId');
  });

  it('never offers an order of another store', async () => {
    w.orders = [order({ id: 'x', orderNumber: 'X', storeId: 's2' }), order({ id: 'y', orderNumber: 'Y' })];
    const r = await search(makeTx(w), 'REF-1');
    expect(r.candidates.map((c) => c.id)).toEqual(['y']);
  });

  it('offers another courier’s order when it is OUR number, flagged, and not by anything looser', async () => {
    w.orders = [order({ id: 'z', orderNumber: 'ORD-77', deliveryProviderId: 'dp2' })];
    const byNumber = await search(makeTx(w), 'ORD-77');
    expect(byNumber.candidates).toHaveLength(1);
    expect(byNumber.candidates[0]).toMatchObject({ id: 'z', otherCourier: true });
    expect(byNumber.otherCourierWarning).toBe(OTHER_COURIER_WARNING);
    // By a phone fragment the other courier’s order is not reached.
    const byPhone = await search(makeTx(w), '0790000');
    expect(byPhone.candidates).toEqual([]);
  });

  it('sorts by how near the expected amount is to the line, the nearest first', async () => {
    w.matches[0].statementAmount = 40;
    w.orders = [
      order({ id: 'a', orderNumber: 'A', totalAmount: 20 }),
      order({ id: 'b', orderNumber: 'B', totalAmount: 41 }),
      order({ id: 'c', orderNumber: 'C', totalAmount: 33 }),
    ];
    const r = await search(makeTx(w), 'ORD');
    expect(r.candidates.map((c) => [c.orderNumber, c.distance])).toEqual([['B', 1], ['C', 7], ['A', 20]]);
    expect(r.candidates[0].expected).toBe(41);
  });

  it('a refused order sorts after the ones a person may pick, and says why', async () => {
    w.matches[0].statementAmount = 20;
    w.orders = [
      order({ id: 'a', orderNumber: 'A', totalAmount: 20, settlementStatus: 'SETTLED' }),
      order({ id: 'b', orderNumber: 'B', totalAmount: 99 }),
    ];
    const r = await search(makeTx(w), 'ORD');
    expect(r.candidates.map((c) => c.orderNumber)).toEqual(['B', 'A']);
    expect(r.candidates[1].blockedBy).toContain(HAND_COLLECTED_NOTE);
    expect(r.candidates[0].blockedBy).toEqual([]);
  });

  it('marks an order already matched in this statement and one not yet shipped', async () => {
    w.orders = [order({ id: 'a', orderNumber: 'A' }), order({ id: 'b', orderNumber: 'B', shippingStatus: 'PACKING', shippedAt: null })];
    w.matches.push({ id: 'm2', companyId: 'c1', statementId: 'st1', statementLineId: 'l2', orderId: 'a', result: 'MATCHED', matchedBy: 'BARCODE', resolution: null });
    const r = await search(makeTx(w), 'ORD');
    const by = Object.fromEntries(r.candidates.map((c) => [c.orderNumber, c.blockedBy]));
    expect(by.A).toEqual([SAME_FILE_NOTE]);
    expect(by.B).toEqual([NOT_SHIPPED_SENTENCE]);
  });

  it('returns at most a screenful', async () => {
    w.orders = Array.from({ length: 40 }, (_, i) => order({ id: `o${i}`, orderNumber: `N${String(i).padStart(2, '0')}` }));
    expect((await search(makeTx(w), 'ORD')).candidates).toHaveLength(CANDIDATE_LIMIT);
  });

  it('refuses a row that is not an unlinked «في الكشف وليس عندنا»', async () => {
    w.matches[0].result = 'MATCHED';
    expect((await refusedWith(search(makeTx(w), 'ORD-1'))).body.code).toBe('NOT_LINKABLE');
  });
});

describe('ranking', () => {
  it('puts a pickable order first, then the nearest, then the number', () => {
    const rows = [
      { orderNumber: 'C', distance: null, linkable: true },
      { orderNumber: 'B', distance: 2, linkable: true },
      { orderNumber: 'A', distance: 2, linkable: true },
      { orderNumber: 'Z', distance: 0, linkable: false },
    ];
    expect(rankCandidates(rows).map((r) => r.orderNumber)).toEqual(['A', 'B', 'C', 'Z']);
  });
});
