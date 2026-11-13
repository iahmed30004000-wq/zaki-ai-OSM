import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «طلب تبديل» AT THE DOOR THAT RECORDS A DIFFERENCE'S ANSWER (the owner, 13/11).
 *
 *   «احيانا بيكون طلب تبديل او زبون وصلو الطلب ناقص فنبعثلو حبة فلازم يا تعمل خيار يعطيك انو طلب تبديل»
 *
 * It is `exchange: true` BESIDE `resolution: 'ACCEPTED_COURIER'` and nothing else. What the door must do, and what this file holds it to:
 *
 *   · THE KEY, THEN THE BODY — the same key as every other answer; any other combination is refused with an Arabic sentence BEFORE a read;
 *   · THE SAME ROWS — the exchange writes the plain answer's rows (the row, the note, the audit row) plus the qualifier, and its note says
 *     «طلب تبديل» where the plain one says «اعتُمد رقم الشركة»;
 *   · THE SAME VERDICT — over EVERY combination of the order's state it is allowed exactly where the plain answer is, with the same
 *     sentence where it is not (a settled order, a cancelled or not-yet-sent one, a cancel asked for, an order another row holds, a closed
 *     statement, a line no order carries, a row that is no difference) — and a refusal writes NOTHING;
 *   · TWO ANSWERS IN A ROW — exchange → «رقمنا» → exchange → plain: the qualifier follows the LAST answer (set by the exchange, cleared by
 *     every other), because every write carries it;
 *   · AN OLDER CLIENT sends no `exchange`: its answer is written with the qualifier CLEARED, never left as it was.
 *
 * The row is stateful here (the write is applied to it, under the WHERE the door sends), so a sequence is read from what is STORED.
 */

type Row = Record<string, unknown>;

const { db, requireContext, requirePermission, logAudit, state } = vi.hoisted(() => {
  const state = {
    /** The match row as the database holds it. */
    stored: {} as Record<string, unknown>,
    matchingClosedAt: null as Date | null,
    order: null as Record<string, unknown> | null,
    requests: [] as { orderId: string; intent: string }[],
    holders: [] as { orderId: string }[],
    /** Every write the door made, in order: the evidence of «nothing was written». */
    writes: [] as unknown[][],
  };
  const db = {
    settlementMatch: { findFirst: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    orderNote: { create: vi.fn() },
    courierStatement: { findFirst: vi.fn() },
    order: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { db, state, requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn() };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: String((e as Error).message) }), { status: (e as { status?: number }).status ?? 500 }),
}));

import { POST } from './route';
import { STATEMENT_CLOSED_SENTENCE } from '@/lib/settlement-gates';
import { WHY } from '@/lib/settlement-decisions';
import { EXCHANGE_AR, EXCHANGE_COMBINATION_SENTENCE, EXCHANGE_MEANING } from '@/lib/settlement-difference';

const ask = (body: Record<string, unknown>) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'st1', matchId: 'm1' }) });
const plain = (note = 'اتفقنا مع الزبون') => ask({ resolution: 'ACCEPTED_COURIER', note });
const exchange = (note = 'تبديل حبة ناقصة') => ask({ resolution: 'ACCEPTED_COURIER', exchange: true, note });

const rowOf = (over: Row = {}): Row => ({
  id: 'm1', statementId: 'st1', companyId: 'c1', result: 'MISMATCHED', resolution: null, resolutionKind: null, appliedAt: null, orderId: 'o1',
  expectedAmount: 20, statementAmount: 18, difference: -2,
  statement: { reference: 'ST-1' }, order: { orderNumber: 'ORD-1' }, statementLine: { status: null }, ...over,
});
const deliveredOrder = (over: Row = {}): Row => ({ id: 'o1', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', ...over });

const nothingWritten = () => {
  expect(db.settlementMatch.updateMany).not.toHaveBeenCalled();
  expect(db.orderNote.create).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
  expect(state.writes).toEqual([]);
};

beforeEach(() => {
  vi.clearAllMocks();
  state.stored = rowOf();
  state.matchingClosedAt = null;
  state.order = deliveredOrder();
  state.requests = [];
  state.holders = [];
  state.writes = [];
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
  requirePermission.mockResolvedValue({ id: 'u1' });
  db.settlementMatch.findFirst.mockImplementation(async () => ({ ...state.stored }));
  db.settlementMatch.findMany.mockImplementation(async () => state.holders);
  // The write is applied to the stored row under the WHERE the door sent — the way the database answers it.
  db.settlementMatch.updateMany.mockImplementation(async (a: { where: Row; data: Row }) => {
    const w = a.where as { appliedAt?: null; statement?: { matchingClosedAt: null } };
    if (w.appliedAt === null && state.stored.appliedAt != null) return { count: 0 };
    if (w.statement && w.statement.matchingClosedAt === null && state.matchingClosedAt !== null) return { count: 0 };
    Object.assign(state.stored, a.data);
    state.writes.push(['settlementMatch.updateMany', a]);
    return { count: 1 };
  });
  db.orderNote.create.mockImplementation(async (a: unknown) => { state.writes.push(['orderNote.create', a]); });
  logAudit.mockImplementation(async (a: unknown) => { state.writes.push(['audit', a]); });
  db.courierStatement.findFirst.mockImplementation(async () => ({ status: 'MATCHED', approvedAt: null, matchingClosedAt: state.matchingClosedAt }));
  db.order.findMany.mockImplementation(async () => (state.order ? [state.order] : []));
  db.orderChangeRequest.findMany.mockImplementation(async () => state.requests);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('the key first, then the body — and every refusal of the body is an Arabic sentence that writes nothing', () => {
  it('asks the same key as every other answer, before reading anything', async () => {
    await exchange();
    expect(requirePermission).toHaveBeenCalledWith('settlement.review');
    expect(requirePermission.mock.invocationCallOrder[0]).toBeLessThan(db.settlementMatch.findFirst.mock.invocationCallOrder[0]);
  });

  it('a person without the key is refused and nothing is read, locked or written', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('ليس لديك صلاحية'), { status: 403 }));
    const res = await exchange();
    expect(res.status).toBe(403);
    expect(db.settlementMatch.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('«طلب تبديل» beside «رقمنا هو المعتمد» is refused with its sentence — before a read, and nothing is written', async () => {
    const res = await ask({ resolution: 'OURS_STANDS', exchange: true, note: 'تبديل حبة ناقصة' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: EXCHANGE_COMBINATION_SENTENCE, code: 'EXCHANGE_NEEDS_THE_COURIER_FIGURE' });
    expect(db.settlementMatch.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('…and beside «قيد المراجعة» too', async () => {
    const res = await ask({ resolution: 'UNDER_REVIEW', exchange: true, note: 'ننتظر الشركة' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('EXCHANGE_NEEDS_THE_COURIER_FIGURE');
    expect(db.settlementMatch.findFirst).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('the sentence of that refusal is Arabic, and so are the words of the answer', () => {
    for (const text of [EXCHANGE_COMBINATION_SENTENCE, EXCHANGE_AR, EXCHANGE_MEANING]) expect(text, text).not.toMatch(/[A-Za-z]/);
  });

  it('a flag that is not a true/false is refused — «true» as a word, 1, null — and nothing is written', async () => {
    for (const exchangeValue of ['true', 'yes', 1, 0, null, {}, []]) {
      const res = await ask({ resolution: 'ACCEPTED_COURIER', exchange: exchangeValue, note: 'تبديل حبة ناقصة' });
      expect(res.status, JSON.stringify(exchangeValue)).toBe(400);
    }
    expect(db.settlementMatch.findFirst).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('there is no fourth resolution WORD: «EXCHANGE» is not an answer, so the stored answers stay the old three', async () => {
    for (const resolution of ['EXCHANGE', 'طلب تبديل', 'exchange']) {
      expect((await ask({ resolution, note: 'تبديل حبة ناقصة' })).status, resolution).toBe(400);
      expect((await ask({ resolution, exchange: true, note: 'تبديل حبة ناقصة' })).status, resolution).toBe(400);
    }
    nothingWritten();
  });

  it('the explanation is the same rule — four characters, dots and stretch marks are refused, nothing is written', async () => {
    for (const note of ['خصم', '    خصم    ', '', '.....', 'ـــــ', '​​​​​']) {
      expect((await ask({ resolution: 'ACCEPTED_COURIER', exchange: true, note })).status, JSON.stringify(note)).toBe(400);
    }
    expect((await ask({ resolution: 'ACCEPTED_COURIER', exchange: true })).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    nothingWritten();
    // …and exactly five real letters pass.
    expect((await exchange('تبديل!')).status).toBe(200);
  });

  it('`exchange: false` is the plain answer: the qualifier is written CLEARED', async () => {
    const res = await ask({ resolution: 'OURS_STANDS', exchange: false, note: 'نطالب بالفرق' });
    expect(res.status).toBe(200);
    expect(db.settlementMatch.updateMany.mock.calls[0][0].data).toMatchObject({ resolution: 'OURS_STANDS', resolutionKind: null });
  });
});

describe('what it writes — the plain answer’s rows, the qualifier, and its own words', () => {
  it('writes the courier’s figure, the person, the time, and the qualifier — in ONE write that still says «the matching is open»', async () => {
    const res = await exchange(' تبديل حبة ناقصة ');
    expect(res.status).toBe(200);
    expect(db.settlementMatch.updateMany).toHaveBeenCalledTimes(1);
    const call = db.settlementMatch.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({
      resolution: 'ACCEPTED_COURIER',
      resolutionNote: 'تبديل حبة ناقصة',
      resolvedById: 'u1',
      resolvedAt: expect.any(Date),
      resolutionKind: 'EXCHANGE',
    });
    expect(call.where).toMatchObject({ id: 'm1', statementId: 'st1', companyId: 'c1', appliedAt: null, statement: { matchingClosedAt: null } });
    expect(state.stored).toMatchObject({ resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE' });
  });

  it('the answer sends the qualifier back, so the screen draws the chip from what was saved', async () => {
    const body = await (await exchange()).json();
    expect(body.match).toMatchObject({ id: 'm1', resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE' });
    expect(body.message).toContain(EXCHANGE_AR);
    expect(body.message).toContain('ORD-1');
    expect(body.message).not.toContain('اعتُمد رقم الشركة');
    expect(body.gap).toBe(2);
  });

  it('the order’s internal note says «طلب تبديل» — never «اعتُمد رقم الشركة», which would read as a discount somebody gave', async () => {
    await exchange('تبديل حبة ناقصة');
    expect(db.orderNote.create).toHaveBeenCalledTimes(1);
    const note = db.orderNote.create.mock.calls[0][0].data;
    expect(note).toMatchObject({ companyId: 'c1', orderId: 'o1', authorId: 'u1', kind: 'internal' });
    expect(note.body).toBe('مطابقة كشف ST-1: طلب تبديل — الفرق 2. تبديل حبة ناقصة');
    expect(note.body).not.toContain('اعتُمد رقم الشركة');
  });

  it('the audit row is the SAME action as the plain answer’s, and names the exchange', async () => {
    await exchange('تبديل حبة ناقصة');
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      companyId: 'c1', userId: 'u1', action: 'SETTLEMENT_DIFFERENCE_RESOLVED', entity: 'SettlementMatch', entityId: 'm1',
      previousData: { resolution: null },
      newData: { resolution: 'ACCEPTED_COURIER', kind: 'EXCHANGE', answer: EXCHANGE_AR, explanation: 'تبديل حبة ناقصة', orderNumber: 'ORD-1', statement: 'ST-1', gap: 2 },
    });
  });

  it('a plain answer’s audit row and note carry no trace of the exchange — they are what they always were', async () => {
    await plain('اتفقنا مع الزبون');
    expect(logAudit.mock.calls[0][0].newData).toEqual({
      resolution: 'ACCEPTED_COURIER', explanation: 'اتفقنا مع الزبون', orderNumber: 'ORD-1', statement: 'ST-1', gap: 2,
    });
    expect(db.orderNote.create.mock.calls[0][0].data.body).toBe('مطابقة كشف ST-1: اعتُمد رقم الشركة — الفرق 2. اتفقنا مع الزبون');
  });

  it('DIFFERENTIAL: the exchange and the plain answer make the same writes — same where, same row data but for the qualifier, same note place, same audit action', async () => {
    const run = async (call: () => Promise<Response>) => {
      state.stored = rowOf();
      state.writes = [];
      vi.clearAllMocks();
      const res = await call();
      return { status: res.status, writes: structuredClone(state.writes), calls: { lock: db.$queryRaw.mock.calls.length, tx: db.$transaction.mock.calls.length } };
    };
    // Same explanation, so the only differences left are the ones the exchange is FOR.
    const a = await run(() => plain('تبديل حبة ناقصة'));
    const b = await run(() => exchange('تبديل حبة ناقصة'));
    expect(b.status).toBe(a.status);
    expect(b.calls).toEqual(a.calls);
    expect(b.writes.map((w) => w[0])).toEqual(a.writes.map((w) => w[0]));

    const strip = (w: unknown[][]) => w.map(([kind, arg]) => {
      const x = JSON.parse(JSON.stringify(arg)) as Row;
      if (kind === 'settlementMatch.updateMany') {
        const data = x.data as Row;
        delete data.resolvedAt;
        expect(data.resolutionKind === 'EXCHANGE' || data.resolutionKind === null).toBe(true);
        delete data.resolutionKind;
      }
      if (kind === 'orderNote.create') delete (x.data as Row).body;
      if (kind === 'audit') {
        const nd = x.newData as Row;
        delete nd.kind;
        delete nd.answer;
      }
      return [kind, x];
    });
    expect(strip(b.writes)).toEqual(strip(a.writes));
  });
});

describe('allowed exactly where «اعتُمد رقم الشركة» is — one verdict, one sentence, and a refusal writes nothing', () => {
  const ORDER_STATES = ['PACKING', 'CANCELLED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNED'];
  const AMOUNTS: [number, number, number][] = [[20, 18, -2], [20, 0, -20], [20, 23, 3]];

  it('over every combination of the order’s state the exchange and the plain answer get the SAME status and the SAME body', async () => {
    const outcomes = new Map<string, number>();
    let compared = 0;
    for (const shipping of ORDER_STATES) {
      for (const settlement of ['PENDING_COLLECTION', 'SETTLED']) {
        for (const requests of [[], ['CANCEL'], ['POSTPONE']]) {
          for (const held of [false, true]) {
            for (const [expectedAmount, statementAmount, difference] of AMOUNTS) {
              for (const closed of [false, true]) {
                for (const word of [null, 'تم توصيلها بشكل جزئي']) {
                  const tag = JSON.stringify({ shipping, settlement, requests, held, statementAmount, closed, word });
                  const seed = () => {
                    state.stored = rowOf({ expectedAmount, statementAmount, difference, statementLine: { status: word } });
                    state.order = deliveredOrder({ shippingStatus: shipping, settlementStatus: settlement });
                    state.requests = requests.map((intent) => ({ orderId: 'o1', intent }));
                    state.holders = held ? [{ orderId: 'o1' }] : [];
                    state.matchingClosedAt = closed ? new Date('2026-11-03T00:00:00Z') : null;
                    state.writes = [];
                  };
                  seed();
                  const p = await plain();
                  const pBody = await p.json();
                  const pWrites = state.writes.length;
                  seed();
                  const e = await exchange();
                  const eBody = await e.json();

                  expect(e.status, tag).toBe(p.status);
                  if (p.status === 200) {
                    // Allowed in both: each wrote exactly one row, one note and one audit row.
                    expect(state.writes.length, tag).toBe(pWrites);
                    outcomes.set('allowed', (outcomes.get('allowed') ?? 0) + 1);
                  } else {
                    // Refused in both, with the same code and the very same sentence — and the exchange wrote nothing.
                    expect(eBody, tag).toEqual(pBody);
                    expect(state.writes, tag).toEqual([]);
                    outcomes.set(String(pBody.error), (outcomes.get(String(pBody.error)) ?? 0) + 1);
                  }
                  compared += 1;
                }
              }
            }
          }
        }
      }
    }
    // The grid is not vacuous: it has allowed cells and every kind of refusal the matrix has for this answer.
    expect(compared).toBe(ORDER_STATES.length * 2 * 3 * 2 * AMOUNTS.length * 2 * 2);
    expect(outcomes.get('allowed') ?? 0).toBeGreaterThan(15);
    for (const sentence of [WHY.notSent, WHY.settled, WHY.openRequest, WHY.heldElsewhere, WHY.amountOnReturn, WHY.zeroOnTheRoad, WHY.partialFirst, STATEMENT_CLOSED_SENTENCE]) {
      expect(outcomes.get(sentence) ?? 0, sentence).toBeGreaterThan(0);
    }
  }, 60_000);

  it('an order already settled (by hand or by another statement): refused with the matrix’s own sentence, nothing written', async () => {
    state.order = deliveredOrder({ settlementStatus: 'SETTLED' });
    const res = await exchange();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: WHY.settled, code: 'DECISION_NOT_ALLOWED', resolution: 'ACCEPTED_COURIER' });
    nothingWritten();
  });

  it('a cancelled or not-yet-sent order: refused — a figure is accepted only for a parcel the money is about', async () => {
    for (const shippingStatus of ['CANCELLED', 'PACKING']) {
      state.order = deliveredOrder({ shippingStatus });
      const res = await exchange();
      expect(res.status, shippingStatus).toBe(409);
      expect((await res.json()).error, shippingStatus).toBe(WHY.notSent);
    }
    nothingWritten();
  });

  it('a line no order carries: refused (nothing to settle), and so is the line that only ever had one side', async () => {
    state.stored = rowOf({ orderId: null, order: null });
    state.order = null;
    let res = await exchange();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(WHY.noOrder);

    // A parcel nobody’s statement names, and a line with no order at all (MISSING_*): one figure, nothing to choose — same refusal as the plain answer.
    for (const result of ['MISSING_IN_STATEMENT', 'MISSING_IN_SYSTEM']) {
      state.stored = rowOf({ result, orderId: null, order: null, statementAmount: null, expectedAmount: null, difference: null });
      res = await exchange();
      expect(res.status, result).toBe(409);
      expect((await res.json()).code, result).toBe('NOT_A_DIFFERENCE');
    }
    nothingWritten();
  });

  it('a clean line has nothing to answer, whatever it is called', async () => {
    state.stored = rowOf({ result: 'MATCHED', expectedAmount: 20, statementAmount: 20, difference: 0 });
    const res = await exchange();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_A_DIFFERENCE');
    nothingWritten();
  });

  it('a closed statement takes no answer, an exchange included — the one sentence, and the lock was taken first', async () => {
    state.matchingClosedAt = new Date('2026-11-03T00:00:00Z');
    const res = await exchange();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ALREADY_APPROVED', error: STATEMENT_CLOSED_SENTENCE });
    expect(String(db.$queryRaw.mock.calls[0][0].join(''))).toContain('FOR UPDATE');
    nothingWritten();
  });

  it('a row the approval already settled («تسوية السطور النظيفة») takes no answer', async () => {
    state.stored = rowOf({ appliedAt: new Date('2026-11-02T00:00:00Z') });
    const res = await exchange();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ROW_APPLIED');
    nothingWritten();
  });

  it('the row of another statement, store or company is not found, and nothing is written', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(null);
    const res = await exchange();
    expect(res.status).toBe(404);
    nothingWritten();
  });

  it('a close that landed between the read and the write loses the race: «CHANGED», no note, no audit row', async () => {
    // The statement read as open; the write’s own WHERE finds it closed.
    db.settlementMatch.updateMany.mockResolvedValue({ count: 0 });
    const res = await exchange();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGED');
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('it moves no money and settles nothing: the door never touches an order or a wallet', async () => {
    await exchange();
    expect(Object.keys(db).sort()).toEqual(['$queryRaw', '$transaction', 'courierStatement', 'order', 'orderChangeRequest', 'orderNote', 'settlementMatch']);
    // The order is only READ (the matrix), never written.
    expect(db.order.findMany).toHaveBeenCalled();
  });
});

describe('two answers in a row — the qualifier follows the LAST answer', () => {
  it('exchange → «رقمنا» → exchange → their figure plain: set, cleared, set, cleared — read from what is STORED', async () => {
    const seen: unknown[] = [];
    const said = async (call: Promise<Response>) => {
      expect((await call).status).toBe(200);
      seen.push([state.stored.resolution, state.stored.resolutionKind]);
    };
    await said(exchange('تبديل حبة ناقصة'));
    await said(ask({ resolution: 'OURS_STANDS', note: 'نطالب بالفرق' }));
    await said(exchange('تبديل حبة ناقصة'));
    await said(plain('خصم أعطاه الموظف'));
    expect(seen).toEqual([
      ['ACCEPTED_COURIER', 'EXCHANGE'],
      ['OURS_STANDS', null],
      ['ACCEPTED_COURIER', 'EXCHANGE'],
      ['ACCEPTED_COURIER', null],
    ]);
  });

  it('«قيد المراجعة» over an exchange clears it too — a parked line is not an exchange', async () => {
    await exchange();
    expect(state.stored.resolutionKind).toBe('EXCHANGE');
    expect((await ask({ resolution: 'UNDER_REVIEW', note: 'ننتظر الشركة' })).status).toBe(200);
    expect(state.stored).toMatchObject({ resolution: 'UNDER_REVIEW', resolutionKind: null });
  });

  it('each answer leaves its own note on the order — the history reads «طلب تبديل» then «رقمنا», append-only', async () => {
    await exchange('تبديل حبة ناقصة');
    await ask({ resolution: 'OURS_STANDS', note: 'نطالب بالفرق' });
    expect(db.orderNote.create.mock.calls.map((c) => c[0].data.body)).toEqual([
      'مطابقة كشف ST-1: طلب تبديل — الفرق 2. تبديل حبة ناقصة',
      'مطابقة كشف ST-1: رقمنا هو المعتمد — الفرق 2. نطالب بالفرق',
    ]);
    expect(logAudit).toHaveBeenCalledTimes(2);
  });
});

describe('an older client', () => {
  it('sends no `exchange`: its answer is exactly the body it always was, and the qualifier is written CLEARED — never left as it was', async () => {
    // The row was an exchange (answered from a newer screen); the older screen answers it «اعتُمد رقم الشركة».
    state.stored = rowOf({ resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE' });
    const res = await ask({ resolution: 'ACCEPTED_COURIER', note: 'اتفقنا مع الزبون' });
    expect(res.status).toBe(200);
    const data = db.settlementMatch.updateMany.mock.calls[0][0].data;
    expect(Object.prototype.hasOwnProperty.call(data, 'resolutionKind')).toBe(true);
    expect(data.resolutionKind).toBeNull();
    expect(state.stored.resolutionKind).toBeNull();
    // …and its note is the plain answer’s.
    expect(db.orderNote.create.mock.calls[0][0].data.body).toContain('اعتُمد رقم الشركة');
  });

  it('and a row read from an older server (no qualifier at all) is simply «not an exchange»', async () => {
    delete state.stored.resolutionKind;
    expect((await plain()).status).toBe(200);
    expect(state.stored.resolutionKind).toBeNull();
  });
});
