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
  OTHER_COURIER_NOT_EXACT_SENTENCE,
  isOurNumber,
  OTHER_STORE_SENTENCE,
  NOT_SHIPPED_SENTENCE,
  candidatesHeader,
  findLinkCandidates,
  linkLineToOrder,
  rankCandidates,
  findLinkCandidatesByLinePhone,
  inFlightHeader,
  NO_LINE_PHONE_SENTENCE,
  NO_IN_FLIGHT_SENTENCE,
  alreadyLinkedSentence,
  STALE_LINE_MOVED_SENTENCE,
  STALE_LINE_GONE_SENTENCE,
  JUST_LINKED_SENTENCE,
} from './hand-link';
import { HAND_COLLECTED_NOTE, MANUAL_MATCH, SAME_FILE_NOTE } from './match-integrity';

type Row = Record<string, any>;

const OPERATORS = ['in', 'notIn', 'not', 'equals', 'isNot', 'contains', 'lt', 'gt'];

/**
 * The `where` shapes the link writes, APPLIED: equality (null meaning absent), { in, notIn, not, equals, isNot,
 * contains, lt }, OR / AND lists, and a relation filter that recurses into the related row. A text search really
 * narrows (`contains` ignores case, as `typed()` asks), so a result is the database's answer to the query, not a
 * mock that was told the answer.
 */
function fits(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some((w) => fits(row, w));
    if (key === 'AND') return (want as Row[]).every((w) => fits(row, w));
    const have = row[key];
    if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
      const w = want as Row;
      if (!Object.keys(w).some((k) => OPERATORS.includes(k))) {
        // a relation filter: look inside the related row (a missing relation fits nothing)
        return have !== null && typeof have === 'object' ? fits(have as Row, w) : false;
      }
      if ('in' in w) return (w.in as unknown[]).includes(have);
      if ('notIn' in w) return !(w.notIn as unknown[]).includes(have);
      if ('isNot' in w) return (have ?? null) !== w.isNot;
      if ('not' in w) return (have ?? null) !== w.not;
      if ('equals' in w) return String(have ?? '').toLowerCase() === String(w.equals).toLowerCase();
      if ('contains' in w) return String(have ?? '').toLowerCase().includes(String(w.contains).toLowerCase());
      if ('lt' in w) return have < w.lt;
      return true;
    }
    return (have ?? null) === want;
  });
}

const JOD = 3;

function order(over: Row = {}): Row {
  const total = Number(over.totalAmount ?? 20);
  return {
    id: 'o1', companyId: 'c1', orderNumber: 'ORD-1', merchantRef: 'REF-1', storeId: 's1', deliveryProviderId: 'dp1',
    settlementStatus: 'PENDING', confirmationStatus: 'CONFIRMED', shippingStatus: 'DELIVERED',
    shippedAt: new Date('2026-10-20T00:00:00Z'), labelPrintedAt: null, createdAt: new Date('2026-10-18T00:00:00Z'),
    trackingNumber: null,
    totalAmount: total, collectedAmount: null, deliveryFee: 0, priceIncludesDelivery: false,
    returnReceipt: null, addOns: [],
    items: [{ quantity: 1, freeQuantity: 0, unitPrice: total, discountShare: 0, lineTotal: total, deliveredQty: null }],
    // Stored the way the product stores a phone: the trunk zero dropped.
    customer: { id: 'cu1', fullName: 'سارة', phone: '790000001', rawPhone: '0790000001' },
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

const request = (over: Row = {}): Row => ({ companyId: 'c1', orderId: 'o1', intent: 'CANCEL', status: 'PENDING', appliedAt: null, ...over });

function makeWorld(over: Partial<World> = {}): World {
  return {
    statement: { id: 'st1', companyId: 'c1', storeId: 's1', status: 'MATCHED', approvedAt: null, matchingClosedAt: null, reference: 'ST-1', deliveryProviderId: 'dp1' },
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
  // A match row as the database sees it: with the statement it sits on, for a relation filter.
  const seen = (m: Row): Row => ({ ...m, statement: m.statementId === 'st1' ? w.statement : (m.statementRow as Row) ?? { reference: 'ST-2', approvedAt: null } });
  const tx = {
    counts,
    locks: [] as string[],
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => { tx.locks.push(strings.join('?')); return []; }),
    courierStatement: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => (fits(w.statement, where) ? w.statement : null)),
    },
    settlementMatch: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => w.matches.find((m) => fits(seen(m), where)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        w.matches.filter((m) => fits(seen(m), where)).map((m) => seen(m))
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        hit('match.updateMany');
        const rows = w.matches.filter((m) => fits(seen(m), where));
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        hit('match.deleteMany');
        const keep = w.matches.filter((m) => !fits(seen(m), where));
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
      findMany: vi.fn(async ({ where }: { where: Row }) => w.requests.filter((r) => fits(r, where))),
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
    w.requests = [request()];
    const r = await link(makeTx(w));
    expect(r.result).toBe('MISMATCHED');
    expect(r.difference).toBe(0);
    expect(r.note).toContain('عليه طلب إلغاء مفتوح');
  });

  it('a request approved and not yet carried out is open too — a postponement says so in its own words', async () => {
    w.requests = [request({ intent: 'POSTPONE', status: 'APPROVED', appliedAt: null })];
    const r = await link(makeTx(w));
    expect(r.result).toBe('MISMATCHED');
    expect(r.note).toContain('عليه طلب تأجيل مفتوح');
  });

  it('but a request already carried out, a rejected one and one of another order are not open: MATCHED', async () => {
    w.requests = [
      request({ status: 'APPROVED', appliedAt: new Date('2026-10-25T00:00:00Z') }),
      request({ status: 'REJECTED' }),
      request({ orderId: 'o-other' }),
      request({ intent: 'EDIT_ITEMS' }),
    ];
    const r = await link(makeTx(w));
    expect(r.result).toBe('MATCHED');
    expect(r.note).toBeNull();
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

  it('the money posted and the matching still open (2/11): the link is taken — it decides what the close will settle', async () => {
    w.statement.approvedAt = new Date();
    w.statement.status = 'APPROVED';
    w.matches[0].statementLine = { amount: 20, fee: null, status: null };
    const r = await link(makeTx(w));
    expect(r).toMatchObject({ result: 'MATCHED' });
    expect(w.matches[0]).toMatchObject({ orderId: 'o1', matchedBy: MANUAL_MATCH });
  });

  it('a statement whose matching is closed: linking decides what the close settled', async () => {
    w.statement.approvedAt = new Date();
    w.statement.matchingClosedAt = new Date();
    w.statement.status = 'APPROVED';
    const tx = makeTx(w);
    const e = await refusedWith(link(tx));
    expect(e.body.code).toBe('ALREADY_APPROVED');
    // The one sentence of a closed statement, and nothing was written.
    expect(e.body.error).toBe('الكشف مغلق نهائياً — التصحيح بكشف تسوية');
    expect(tx.counts['match.updateMany']).toBeUndefined();
    expect(tx.counts['match.deleteMany']).toBeUndefined();
    expect(tx.counts['note.create']).toBeUndefined();
  });

  it('a line that was PARKED («قيد المراجعة», the one answer a line with no order may have) comes out of the link unanswered', async () => {
    // Otherwise a difference would look answered the moment it was linked, and the approval would not wait for it.
    Object.assign(w.matches[0], { resolution: 'UNDER_REVIEW', resolutionNote: 'ليس لنا', resolvedById: 'u0', resolvedAt: new Date() });
    w.orders = [order({ totalAmount: 25 })];
    const tx = makeTx(w);
    const r = await link(tx);
    expect(r.result).toBe('MISMATCHED');
    expect(w.matches[0]).toMatchObject({ result: 'MISMATCHED', resolution: null, resolutionNote: null, resolvedById: null, resolvedAt: null });
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

  it('THE WRITE ITSELF refuses a row somebody linked after it was read: the stale read passes, the write does not', async () => {
    const tx = makeTx(w);
    const stale = { ...w.matches[0] };
    // Between the read and the write another person links the line…
    Object.assign(w.matches[0], { orderId: 'o9', result: 'MATCHED', matchedBy: MANUAL_MATCH });
    // …and this person's read, taken a moment earlier, still saw it open.
    tx.settlementMatch.findFirst.mockResolvedValueOnce(stale);
    const e = await refusedWith(link(tx));
    expect(e.body.code).toBe('NOT_LINKABLE');
    // Nothing of the other person's link was overwritten.
    expect(w.matches[0]).toMatchObject({ orderId: 'o9', matchedBy: MANUAL_MATCH });
    expect(tx.counts['note.create']).toBeUndefined();
  });

  it('and the write is asked as one the database can refuse: still MISSING_IN_SYSTEM, still no order, statement open', async () => {
    const tx = makeTx(w);
    await link(tx);
    expect(tx.settlementMatch.updateMany.mock.calls[0][0].where).toEqual({
      id: 'm1', statementId: 'st1', result: 'MISSING_IN_SYSTEM', orderId: null, statement: { matchingClosedAt: null },
    });
  });

  it('and so is the removal of the sweep row that follows it — an open statement in its own WHERE', async () => {
    const tx = makeTx(w);
    await link(tx);
    expect(tx.settlementMatch.deleteMany.mock.calls[0][0].where).toMatchObject({
      statementId: 'st1', result: 'MISSING_IN_STATEMENT', statement: { matchingClosedAt: null },
    });
  });
});

describe('an approval that lands while the link is being made', () => {
  it('the statement’s row is locked before it is read, and the order’s before the order is', async () => {
    const tx = makeTx(w);
    await link(tx);
    expect(tx.locks).toHaveLength(2);
    expect(tx.locks[0]).toContain('courier_statements');
    expect(tx.locks[0]).toContain('FOR UPDATE');
    expect(tx.locks[1]).toContain('"orders"');
    expect(tx.locks[1]).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.courierStatement.findFirst.mock.invocationCallOrder[0]);
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(tx.order.findFirst.mock.invocationCallOrder[0]);
  });

  // (Was: «الكشف انعتمد — حدّث». The lock gives every door of a statement one sentence — settlement-gates.)
  it('is refused by the write with the one sentence of a closed statement, though the statement looked open when it was read', async () => {
    const tx = makeTx(w);
    // The first read (the check) sees it open; the approval commits; the write finds it approved.
    const open = { ...w.statement };
    tx.courierStatement.findFirst.mockImplementationOnce(async () => open);
    // (2/11: the approval alone no longer closes the matching — the close does, and it is the close that lands here.)
    Object.assign(w.statement, { status: 'APPROVED', approvedAt: new Date('2026-10-29T10:00:00Z'), matchingClosedAt: new Date('2026-10-29T10:00:00Z') });

    const e = await refusedWith(link(tx));
    expect(e.body).toEqual({ error: 'الكشف مغلق نهائياً — التصحيح بكشف تسوية', code: 'ALREADY_APPROVED' });
    expect(w.matches[0]).toMatchObject({ result: 'MISSING_IN_SYSTEM', orderId: null });
    expect(tx.counts['note.create']).toBeUndefined();
    expect(tx.counts['match.deleteMany']).toBeUndefined();
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
    const e = await refusedWith(link(makeTx(w), { query: 'ORD-1' }));
    expect(e.body).toMatchObject({ code: 'OTHER_COURIER', error: OTHER_COURIER_WARNING });
    expect(w.matches[0].orderId).toBeNull();
  });

  it('and linked with the warning accepted, saying so', async () => {
    const r = await link(makeTx(w), { acceptOtherCourier: true, query: 'ORD-1' });
    expect(r.otherCourier).toBe(true);
    expect(w.matches[0]).toMatchObject({ orderId: 'o1', matchedBy: MANUAL_MATCH });
  });

  it('OUR number, exactly — the merchant reference too, in any case', async () => {
    expect((await link(makeTx(w), { acceptOtherCourier: true, query: ' ref-1 ' })).otherCourier).toBe(true);
  });

  it('but the warning cannot be clicked through for an order the search would not have offered', async () => {
    for (const query of ['0790000001', 'ORD', 'ORD-12', '', undefined]) {
      w = makeWorld();
      w.orders = [order({ deliveryProviderId: 'dp2' })];
      const tx = makeTx(w);
      const e = await refusedWith(link(tx, { acceptOtherCourier: true, query }));
      expect(e.body, String(query)).toMatchObject({ code: 'OTHER_COURIER_NOT_EXACT', error: OTHER_COURIER_NOT_EXACT_SENTENCE });
      expect(tx.counts['match.updateMany']).toBeUndefined();
      expect(w.matches[0].orderId).toBeNull();
    }
  });

  it('and an order of the statement’s own courier needs no number at all', async () => {
    w.orders = [order()];
    expect((await link(makeTx(w), { query: undefined })).otherCourier).toBe(false);
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
    const r = await search(makeTx(w), '0790000001');
    expect(r.candidates.map((c) => [c.orderNumber, c.distance])).toEqual([['B', 1], ['C', 7], ['A', 20]]);
    expect(r.candidates[0].expected).toBe(41);
  });

  it('a refused order sorts after the ones a person may pick, and says why', async () => {
    w.matches[0].statementAmount = 20;
    w.orders = [
      order({ id: 'a', orderNumber: 'A', totalAmount: 20, settlementStatus: 'SETTLED' }),
      order({ id: 'b', orderNumber: 'B', totalAmount: 99 }),
    ];
    const r = await search(makeTx(w), '0790000001');
    expect(r.candidates.map((c) => c.orderNumber)).toEqual(['B', 'A']);
    expect(r.candidates[1].blockedBy).toContain(HAND_COLLECTED_NOTE);
    expect(r.candidates[0].blockedBy).toEqual([]);
  });

  it('marks an order already matched in this statement and one not yet shipped', async () => {
    w.orders = [order({ id: 'a', orderNumber: 'A' }), order({ id: 'b', orderNumber: 'B', shippingStatus: 'PACKING', shippedAt: null })];
    w.matches.push({ id: 'm2', companyId: 'c1', statementId: 'st1', statementLineId: 'l2', orderId: 'a', result: 'MATCHED', matchedBy: 'BARCODE', resolution: null });
    const r = await search(makeTx(w), '0790000001');
    const by = Object.fromEntries(r.candidates.map((c) => [c.orderNumber, c.blockedBy]));
    expect(by.A).toEqual([SAME_FILE_NOTE]);
    expect(by.B).toEqual([NOT_SHIPPED_SENTENCE]);
  });

  it('returns at most a screenful', async () => {
    w.orders = Array.from({ length: 40 }, (_, i) => order({ id: `o${i}`, orderNumber: `N${String(i).padStart(2, '0')}` }));
    expect((await search(makeTx(w), '0790000001')).candidates).toHaveLength(CANDIDATE_LIMIT);
  });

  it('refuses a row that is not an unlinked «في الكشف وليس عندنا»', async () => {
    w.matches[0].result = 'MATCHED';
    expect((await refusedWith(search(makeTx(w), 'ORD-1'))).body.code).toBe('NOT_LINKABLE');
  });
});

describe('the search really narrows by what was typed', () => {
  const two = () => [
    order({ id: 'a', orderNumber: 'A-100', merchantRef: 'RA', customer: { id: 'c1', fullName: 'سارة خالد', phone: '790000001', rawPhone: '0790000001' } }),
    order({ id: 'b', orderNumber: 'B-200', merchantRef: 'RB', customer: { id: 'c2', fullName: 'ليلى حسن', phone: '795550002', rawPhone: '0795550002' } }),
  ];
  const ids = async (q: string) => (await search(makeTx(w), q)).candidates.map((c) => c.id);

  it('by the phone as the customer writes it (trunk zero) or as it is stored', async () => {
    w.orders = two();
    expect(await ids('0790000001')).toEqual(['a']);
    expect(await ids('790000001')).toEqual(['a']);
    expect(await ids('0795550002')).toEqual(['b']);
  });

  it('by a part of the name, in any case', async () => {
    w.orders = two();
    expect(await ids('ليلى')).toEqual(['b']);
    expect(await ids('خالد')).toEqual(['a']);
  });

  it('by our order number or the merchant reference, in any case', async () => {
    w.orders = two();
    expect(await ids('b-200')).toEqual(['b']);
    expect(await ids('RA-')).toEqual([]);
  });

  it('and something nobody has finds nothing, with the header saying so', async () => {
    w.orders = two();
    const r = await search(makeTx(w), '0000000');
    expect(r.candidates).toEqual([]);
    expect(r.header).toBe('لا طلبات لهذا البحث');
  });

  it('the header counts what the SEARCH found, not every order in scope', async () => {
    w.orders = two();
    const r = await search(makeTx(w), '0790000001');
    expect(r.counts.total).toBe(1);
  });

  it('isOurNumber: exact, trimmed, any case, never a part', () => {
    const o = { orderNumber: 'ORD-1', merchantRef: 'ref-1' };
    expect(isOurNumber(o, 'ord-1')).toBe(true);
    expect(isOurNumber(o, ' REF-1 ')).toBe(true);
    expect(isOurNumber(o, 'ORD')).toBe(false);
    expect(isOurNumber(o, '')).toBe(false);
    expect(isOurNumber(o, undefined)).toBe(false);
    expect(isOurNumber({ orderNumber: 'X', merchantRef: null }, '')).toBe(false);
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

describe('a line tied by hand is judged against a claim on the company, as the matcher judges it', () => {
  // An EARLIER, APPROVED statement answered this order «رقمنا هو المعتمد»: expected 20, the company paid 18.
  const claimRow = (over: Row = {}): Row => ({
    id: 'old', companyId: 'c1', statementId: 'st0', statementLineId: 'l0', orderId: 'o1', result: 'MISMATCHED',
    matchedBy: 'MERCHANT_REF', resolution: 'OURS_STANDS', expectedAmount: 20, statementAmount: 18, statementFee: 0,
    statementRow: { reference: 'ST-0', approvedAt: new Date('2026-10-20T00:00:00Z'), matchingClosedAt: new Date('2026-10-20T00:00:00Z') }, ...over,
  });

  it('a line that pays the 2.000 that remains is MATCHED against 2.000, not a difference of 18.000', async () => {
    w.matches.push(claimRow());
    w.matches[0].statementLine = { amount: 2, fee: null, status: null };
    const r = await link(makeTx(w));
    expect(r).toMatchObject({ result: 'MATCHED', expected: 2, stated: 2, difference: 0 });
  });

  it('a line that pays less is a difference of what is still missing', async () => {
    w.matches.push(claimRow());
    w.matches[0].statementLine = { amount: 1.5, fee: null, status: null };
    const r = await link(makeTx(w));
    expect(r).toMatchObject({ result: 'MISMATCHED', expected: 2, difference: -0.5 });
  });

  it('with no claim the very same line is judged against the whole order, as it always was', async () => {
    w.matches[0].statementLine = { amount: 2, fee: null, status: null };
    const r = await link(makeTx(w));
    expect(r).toMatchObject({ result: 'MISMATCHED', expected: 20, difference: -18 });
  });

  it('an order already SETTLED has no claim to pay: the claims are not even asked for', async () => {
    w.orders = [order({ settlementStatus: 'SETTLED' })];
    w.matches.push(claimRow());
    w.matches[0].statementLine = { amount: 2, fee: null, status: null };
    const tx = makeTx(w);
    const e = await refusedWith(link(tx));
    expect(e.body.code).toBe('ORDER_NOT_LINKABLE');
    expect(tx.settlementMatch.findMany.mock.calls.some((c) => (c[0] as { where: Row }).where.resolution === 'OURS_STANDS')).toBe(false);
  });
});

/*
 * «بهاتف السطر» — THE PHONE OF THE LINE ITSELF, THE ORDERS STILL ON THE ROAD.
 *
 * «بحث برقم الهاتف المرفق ياخد تلقائيا الرقم الهاتف لنفس الطلب ويظهرلك الطلبات الي قيد الشحن و انا اختار». The phone
 * comes off the line's own row (never the request), and only this store's, this courier's orders still in flight
 * are offered; a link from them is the same `linkLineToOrder`, judged by the matcher's own rule.
 */
describe('the search by the line’s own phone', () => {
  const syrian = (over: Row = {}) =>
    order({ customer: { id: 'cu9', fullName: 'رنا', phone: '933620102', rawPhone: '0933620102' }, shippingStatus: 'SHIPPED', ...over });
  const withRow = (rawRow: string | null, over: Row = {}) => {
    w.matches[0].statementLine = { amount: 20, fee: null, status: null, rawRow, merchantRef: null, barcode: 'BC-1', ...over };
  };
  const byPhone = (tx: ReturnType<typeof makeTx>, countryCode: string | null = 'SY') =>
    findLinkCandidatesByLinePhone(tx as never, { ...scope, countryCode });
  const ids = async () => (await byPhone(makeTx(w))).candidates.map((c) => c.id);

  it('reads the phone off the row and lists that customer’s orders in flight, saying which phone it used', async () => {
    withRow('BC-1 | رنا | +963 933 620 102 | 20000 | مؤجل');
    w.orders = [syrian({ id: 'a', orderNumber: 'A-1' }), syrian({ id: 'b', orderNumber: 'B-1', shippingStatus: 'OUT_FOR_DELIVERY' })];
    const r = await byPhone(makeTx(w));
    expect(r.phone).toEqual({ shown: '0933620102', country: 'SY' });
    expect(r.candidates.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(r.header).toBe(inFlightHeader(2));
    expect(r.counts).toEqual({ total: 2, closed: 0, open: 2 });
    expect(r.hint).toBeNull();
  });

  it('offers only orders still on the road: not delivered, not returned, not cancelled, not still in the warehouse', async () => {
    withRow('0933620102');
    w.orders = [
      syrian({ id: 'shipped', shippingStatus: 'SHIPPED' }),
      syrian({ id: 'out', shippingStatus: 'OUT_FOR_DELIVERY' }),
      syrian({ id: 'failed', shippingStatus: 'FAILED_DELIVERY' }),
      syrian({ id: 'delivered', shippingStatus: 'DELIVERED' }),
      syrian({ id: 'partial', shippingStatus: 'PARTIALLY_DELIVERED' }),
      syrian({ id: 'returned', shippingStatus: 'RETURNED' }),
      syrian({ id: 'cancelled', shippingStatus: 'CANCELLED' }),
      syrian({ id: 'packing', shippingStatus: 'PACKING', shippedAt: null }),
    ];
    expect((await ids()).sort()).toEqual(['failed', 'out', 'shipped']);
  });

  it('is scoped to the statement’s company, store and courier — another store’s or courier’s order of the same phone is not offered', async () => {
    withRow('0933620102');
    w.orders = [
      syrian({ id: 'mine' }),
      syrian({ id: 'otherStore', storeId: 's2' }),
      syrian({ id: 'otherCourier', deliveryProviderId: 'dp2' }),
      syrian({ id: 'otherCompany', companyId: 'c2' }),
    ];
    expect(await ids()).toEqual(['mine']);
    const tx = makeTx(w);
    await byPhone(tx);
    expect(tx.order.findMany.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', storeId: 's1', deliveryProviderId: 'dp1' });
  });

  it('another customer’s orders are not offered, however close the amount', async () => {
    withRow('0933620102');
    w.orders = [syrian({ id: 'mine' }), syrian({ id: 'stranger', customer: { id: 'cx', fullName: 'غريب', phone: '944111222', rawPhone: '0944111222' } })];
    expect(await ids()).toEqual(['mine']);
  });

  it('a row with no phone in it: no search at all, and the sentence says to search by hand', async () => {
    withRow('BC-1 | 20000 | مؤجل | 2026-10-28');
    w.orders = [syrian()];
    const tx = makeTx(w);
    const r = await byPhone(tx);
    expect(r).toMatchObject({ phone: null, candidates: [], hint: NO_LINE_PHONE_SENTENCE });
    expect(tx.order.findMany).not.toHaveBeenCalled();
    expect(tx.order.count).not.toHaveBeenCalled();
  });

  it('a line with no row stored is the same: no phone, nothing read', async () => {
    withRow(null);
    const tx = makeTx(w);
    expect((await byPhone(tx)).hint).toBe(NO_LINE_PHONE_SENTENCE);
    expect(tx.order.findMany).not.toHaveBeenCalled();
  });

  it('the barcode cell is never read as a phone, even when it has a mobile’s shape', async () => {
    withRow('0933620102 | 20000', { barcode: '0933620102' });
    w.orders = [syrian()];
    expect((await byPhone(makeTx(w))).phone).toBeNull();
  });

  it('a phone with nothing on the road says so, and still shows the phone it read', async () => {
    withRow('0933620102');
    w.orders = [syrian({ shippingStatus: 'DELIVERED' })];
    const r = await byPhone(makeTx(w));
    expect(r).toMatchObject({ phone: { shown: '0933620102' }, candidates: [], hint: NO_IN_FLIGHT_SENTENCE, header: inFlightHeader(0) });
  });

  it('a Jordanian line in a Syrian store finds a customer stored with its code (RV136) or without it', async () => {
    withRow('0791234567');
    w.orders = [
      syrian({ id: 'withCode', customer: { id: 'j1', fullName: 'ج', phone: '962791234567', rawPhone: '+962791234567' } }),
      syrian({ id: 'legacy', customer: { id: 'j2', fullName: 'ج', phone: '791234567', rawPhone: '0791234567' } }),
    ];
    expect((await ids()).sort()).toEqual(['legacy', 'withCode']);
  });

  it('an order the rules refuse is offered greyed, with its reason — the same builder as the text search', async () => {
    withRow('0933620102');
    w.orders = [syrian({ id: 'settled', settlementStatus: 'SETTLED' }), syrian({ id: 'ok', orderNumber: 'ORD-OK' })];
    const r = await byPhone(makeTx(w));
    expect(r.candidates.map((c) => c.id)).toEqual(['ok', 'settled']);
    expect(r.candidates[1].blockedBy).toContain(HAND_COLLECTED_NOTE);
  });

  it('refuses a line that is linked already or is not «في الكشف وليس عندنا», before reading any order', async () => {
    withRow('0933620102');
    w.matches[0].orderId = 'o1';
    const tx = makeTx(w);
    expect((await refusedWith(byPhone(tx))).body.code).toBe('NOT_LINKABLE');
    expect(tx.order.findMany).not.toHaveBeenCalled();
    w = makeWorld();
    withRow('0933620102');
    w.matches[0].result = 'MISMATCHED';
    expect((await refusedWith(byPhone(makeTx(w)))).body.code).toBe('NOT_LINKABLE');
  });

  it('a statement of another store is not found — the store is the session’s', async () => {
    withRow('0933620102');
    w.statement.storeId = 's2';
    expect((await refusedWith(byPhone(makeTx(w)))).body.code).toBe('NOT_FOUND');
  });

  it('then the link from it is the same door, judged by the matcher: same figures MATCHED, different ones MISMATCHED', async () => {
    withRow('0933620102');
    w.orders = [syrian({ id: 'o1' })];
    const [picked] = (await byPhone(makeTx(w))).candidates;
    const r = await link(makeTx(w), { orderId: picked.id });
    expect(r.result).toBe('MATCHED');

    w = makeWorld();
    withRow('0933620102', { amount: 15 });
    w.orders = [syrian({ id: 'o1' })];
    const r2 = await link(makeTx(w), { orderId: 'o1' });
    expect(r2).toMatchObject({ result: 'MISMATCHED', difference: -5 });
  });

  it('the header words for none, one and many', () => {
    expect(inFlightHeader(0)).toBe('لا طلبات قيد الشحن لهذا الرقم');
    expect(inFlightHeader(1)).toBe('لهذا الرقم طلب واحد قيد الشحن');
    expect(inFlightHeader(3)).toBe('لهذا الرقم 3 طلبات قيد الشحن');
  });
});

/*
 * «الربط ب طلب خليها امورها تمام» — EVERY REFUSAL OF A STALE PAGE SAYS WHAT HAPPENED AND THAT NOTHING WAS WRITTEN.
 */
describe('a link pressed on a page older than the line', () => {
  it('a line somebody already tied names the order it is tied to, and writes nothing', async () => {
    w.matches[0].orderId = 'o1';
    w.matches[0].result = 'MATCHED';
    const tx = makeTx(w);
    const e = await refusedWith(link(tx, { orderId: 'o1' }));
    expect(e.body).toEqual({ error: alreadyLinkedSentence('ORD-1'), code: 'NOT_LINKABLE' });
    expect(e.body.error).toContain('ORD-1');
    expect(tx.counts['match.updateMany']).toBeUndefined();
    expect(tx.counts['note.create']).toBeUndefined();
  });

  it('the order it is tied to is looked up in this company only', async () => {
    w.matches[0].orderId = 'oX';
    w.orders = [order(), order({ id: 'oX', companyId: 'c2', orderNumber: 'THEIRS-1' })];
    const e = await refusedWith(link(makeTx(w)));
    expect(e.body.error).toBe(alreadyLinkedSentence(null));
    expect(e.body.error).not.toContain('THEIRS-1');
  });

  it('a line the matching moved out of «في الكشف وليس عندنا» says the matching was run again', async () => {
    w.matches[0].result = 'MISMATCHED';
    const e = await refusedWith(link(makeTx(w)));
    expect(e.body).toEqual({ error: STALE_LINE_MOVED_SENTENCE, code: 'NOT_LINKABLE' });
  });

  it('a match row that is gone (the matching rebuilt its rows) says so, as a 404', async () => {
    w.matches = [];
    const e = await refusedWith(link(makeTx(w)));
    expect(e.status).toBe(404);
    expect(e.body).toEqual({ error: STALE_LINE_GONE_SENTENCE, code: 'NOT_FOUND' });
  });

  it('a double press: the second finds the line tied to the order the first chose', async () => {
    const tx = makeTx(w);
    await link(tx);
    const e = await refusedWith(link(tx));
    expect(e.body.error).toBe(alreadyLinkedSentence('ORD-1'));
    expect(w.notes).toHaveLength(1);
  });

  it('two at the same instant: the write that lost says it was linked a moment ago by somebody else', async () => {
    const tx = makeTx(w);
    tx.settlementMatch.updateMany.mockResolvedValueOnce({ count: 0 });
    const e = await refusedWith(link(tx));
    expect(e.body).toEqual({ error: JUST_LINKED_SENTENCE, code: 'NOT_LINKABLE' });
    expect(tx.counts['note.create']).toBeUndefined();
    expect(tx.counts['match.deleteMany']).toBeUndefined();
  });

  it('every one of these sentences tells the person to refresh', () => {
    for (const s of [alreadyLinkedSentence('X'), alreadyLinkedSentence(null), STALE_LINE_MOVED_SENTENCE, STALE_LINE_GONE_SENTENCE, JUST_LINKED_SENTENCE]) {
      expect(s).toContain('حدّث الصفحة');
    }
  });
});
