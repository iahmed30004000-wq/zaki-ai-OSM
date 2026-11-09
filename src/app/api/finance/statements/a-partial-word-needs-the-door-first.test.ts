import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A PARTIAL WORD NEEDS THE DOOR FIRST — the three doors that read the decision matrix, against ONE fake world.
 *
 * The company's line says «تم توصيلها بشكل جزئي» and our order is still on the road (it was never recorded as partial, so the
 * matcher measured the line against the WHOLE order and it came out a difference). «اعتُمد رقم الشركة» would settle that order
 * at their figure and the close would deliver it in full and take the whole ordered quantity off the shelf — the units that
 * physically came back would then be refused by the returns desk. The follow-up records «استلم جزءاً» first; then the same
 * line takes the answer.
 *
 * The REAL routes run here — the single answer, the bulk answer and the statement read that offers both — against one world
 * whose reads behave like a database's: a `select` returns ONLY the columns it asks for, a nested `select` projects the
 * relation, and a column the world does not hold is an error. A door that forgets to ask for the line's status therefore
 * does not see the word, and the tests below fail — a hand-written answer that ignores the select could not tell.
 *
 * The rule only ever REFUSES. «قيد المراجعة» is taken in every state; every other word, and a line with no word, behave as before.
 */

type Row = Record<string, unknown>;

const { db, world, requireContext, requirePermission, logAudit, receiptGap } = vi.hoisted(() => {
  const world = {
    statement: {} as Row,
    lines: new Map<string, Row>(),
    matches: [] as Row[],
    orders: new Map<string, Row>(),
    /** Other rows (other lines, other statements) that already hold an order. */
    holders: [] as Row[],
    notes: [] as Row[],
    writes: [] as Row[],
  };

  /** What Prisma does with `select`: only the asked columns come back; a nested `select` projects the relation. */
  const project = (row: Row | null | undefined, select: Row, what: string): Row | null => {
    if (!row) return null;
    const out: Row = {};
    for (const [key, want] of Object.entries(select)) {
      if (!(key in row)) throw new Error(`the fake world has no «${key}» on ${what}`);
      if (want === true) out[key] = row[key];
      else if (want && typeof want === 'object' && 'select' in want) {
        out[key] = project(row[key] as Row | null, (want as { select: Row }).select, `${what}.${key}`);
      } else throw new Error(`the fake does not know how to read «${key}» on ${what}`);
    }
    return out;
  };

  /** A match row with its relations laid beside it, read from the SAME world the facts query reads. */
  const full = (m: Row): Row => ({
    ...m,
    statement: world.statement,
    order: m.orderId ? world.orders.get(m.orderId as string) ?? null : null,
    statementLine: m.statementLineId ? world.lines.get(m.statementLineId as string) ?? null : null,
  });

  const only = (where: Row, known: string[], what: string) => {
    for (const key of Object.keys(where)) if (!known.includes(key)) throw new Error(`the fake does not know the condition «${key}» on ${what}`);
  };

  const db = {
    courierStatement: {
      findFirst: vi.fn(async (a: { where: Row; select?: Row; include?: Row }) => {
        only(a.where, ['id', 'companyId', 'storeId'], 'courierStatement');
        const w = a.where as { id: string; companyId: string; storeId: string };
        const s = world.statement;
        if (w.id !== s.id || w.companyId !== s.companyId || w.storeId !== s.storeId) return null;
        if (a.select) return project(s, a.select, 'courierStatement');
        // The statement read: the whole row, its lines and receipts (empty here), and the matches with the relations asked for.
        const inc = (a.include as { matches: { include: Record<string, { select: Row }> } }).matches.include;
        return {
          ...s,
          lines: [],
          receipts: [],
          matches: world.matches.map((m) => {
            const f = full(m);
            const out: Row = { ...m };
            for (const [key, spec] of Object.entries(inc)) out[key] = project(f[key] as Row | null, spec.select, `match.${key}`);
            return out;
          }),
        };
      }),
    },
    settlementMatch: {
      findFirst: vi.fn(async (a: { where: Row; select?: Row }) => {
        if (!a.select) throw new Error('settlementMatch.findFirst without a select: the fake world does not hand out whole rows');
        only(a.where, ['id', 'statementId', 'companyId', 'statement'], 'settlementMatch.findFirst');
        const w = a.where as { id: string; statementId: string; companyId: string; statement: { storeId: string } };
        const m = world.matches.find(
          (x) => x.id === w.id && x.statementId === w.statementId && x.companyId === w.companyId && world.statement.storeId === w.statement.storeId
        );
        return m ? project(full(m), a.select, 'settlementMatch') : null;
      }),
      findMany: vi.fn(async (a: { where: Row; select?: Row }) => {
        if (!a.select) throw new Error('settlementMatch.findMany without a select: the fake world does not hand out whole rows');
        // "Is another row holding the order?" — the question with an OR in it.
        if (a.where.OR) return world.holders.map((h) => project(h, a.select as Row, 'holder'));
        only(a.where, ['id', 'statementId', 'companyId'], 'settlementMatch.findMany');
        const w = a.where as { id: { in: string[] }; statementId: string; companyId: string };
        return world.matches
          .filter((m) => w.id.in.includes(m.id as string) && m.statementId === w.statementId && m.companyId === w.companyId)
          .map((m) => project(full(m), a.select as Row, 'settlementMatch'));
      }),
      updateMany: vi.fn(async (a: { where: Row; data: Row }) => {
        const w = a.where as { id: string; statement?: { matchingClosedAt: null } };
        const m = world.matches.find((x) => x.id === w.id);
        if (!m) return { count: 0 };
        // The write says "the matching is still open" again, and the world answers it the way a database does.
        if (w.statement && world.statement.matchingClosedAt !== null) return { count: 0 };
        Object.assign(m, a.data);
        world.writes.push({ id: m.id, ...a.data });
        return { count: 1 };
      }),
    },
    order: {
      findMany: vi.fn(async (a: { where: Row; select: Row }) => {
        only(a.where, ['id', 'companyId', 'storeId'], 'order.findMany');
        const w = a.where as { id: { in: string[] }; companyId: string; storeId: string };
        return [...world.orders.values()]
          .filter((o) => w.id.in.includes(o.id as string) && o.companyId === w.companyId && o.storeId === w.storeId)
          .map((o) => project(o, a.select, 'order'));
      }),
    },
    orderChangeRequest: { findMany: vi.fn(async () => []) },
    orderNote: { create: vi.fn(async (a: { data: Row }) => { world.notes.push(a.data); }) },
    orderActivity: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };

  return {
    db, world,
    requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn(),
    receiptGap: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({ apiErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }) }));
vi.mock('@/lib/settlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/settlement')>()),
  receiptGap: (...a: unknown[]) => receiptGap(...a),
}));
vi.mock('@/lib/wallets', async (orig) => ({ ...(await orig<typeof import('@/lib/wallets')>()), recordMovement: vi.fn() }));
vi.mock('@/lib/commission', async (orig) => ({ ...(await orig<typeof import('@/lib/commission')>()), markPayableForOrders: vi.fn() }));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: vi.fn() }));

import { GET } from './[id]/route';
import { POST as decide } from './[id]/matches/[matchId]/resolve/route';
import { POST as decideMany } from './[id]/decisions/route';
import { WHY } from '@/lib/settlement-decisions';

/* ───────────────────────────── the world ───────────────────────────── */

const THE_WORD = 'تم توصيلها بشكل جزئي';
const CLOSED = 'الكشف مغلق نهائياً — التصحيح بكشف تسوية';
const NO_LINE = Symbol('the match row has no statement line');

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TATWEEL = String.fromCharCode(0x0640);
const DAMMA = String.fromCharCode(0x064f);
const ALEF_MAKSURA = String.fromCharCode(0x0649);
/** The company's word as other files spell it — all folded to one reading by the phrase table. */
const SPELLINGS = [
  THE_WORD,
  `  ${THE_WORD}  `,
  'تم   توصيلها  بشكل جزئي',
  'تم توصيلها بشكل جزئ' + ALEF_MAKSURA,
  `تم توصيلها بشكل ج${DAMMA}زئي`,
  `تـ${TATWEEL}م توصيلها بشكل جزئي`,
];
const ON_THE_ROAD = ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY'];

interface Spec {
  /** The order's state as OUR door recorded it. */
  shipping: string;
  /** What the company's status cell says; `NO_LINE` is a match row that came from no line at all. */
  word: string | null | typeof NO_LINE;
  match?: Row;
  order?: Row;
}

/** One statement of n rows, each a «فرق في المبلغ» (20 ours, 18 theirs) on its own order, with its own word. */
function scene(specs: Spec[]) {
  world.lines.clear();
  world.orders.clear();
  world.holders = [];
  world.notes = [];
  world.writes = [];
  world.matches = specs.map((s, i) => {
    const n = i + 1;
    const orderId = `o${n}`;
    world.orders.set(orderId, {
      id: orderId, companyId: 'c1', storeId: 's1', orderNumber: `ORD-${n}`, merchantRef: `M-${n}`, shippingStatus: s.shipping,
      settlementStatus: 'PENDING_COLLECTION', confirmationStatus: 'CONFIRMED', rejectionReason: null, returnReceipt: null, ...s.order,
    });
    let statementLineId: string | null = null;
    if (s.word !== NO_LINE) {
      statementLineId = `l${n}`;
      world.lines.set(statementLineId, {
        id: statementLineId, merchantRef: `M-${n}`, barcode: null, amount: 18, collected: 23, fee: 5, status: s.word, rawRow: null,
        receiverName: null, receiverPhone: null, receiverAddress: null, receiverCity: null, receiverArea: null,
      });
    }
    return {
      id: uid(n), statementId: 'st1', companyId: 'c1', orderId, statementLineId, result: 'MISMATCHED', matchedBy: 'MERCHANT_REF',
      resolution: null, resolutionNote: null, resolvedById: null, resolvedAt: null, appliedAt: null,
      expectedAmount: 20, statementAmount: 18, difference: -2, expectedFee: null, statementFee: null, feeDifference: null, note: null,
      createdAt: new Date('2026-11-05T10:00:00Z'), ...s.match,
    };
  });
}

const say = (n: number, resolution: string, note = 'اتفقنا مع الزبون') =>
  decide(new Request('http://x', { method: 'POST', body: JSON.stringify({ resolution, note }) }), {
    params: Promise.resolve({ id: 'st1', matchId: uid(n) }),
  });
const sayMany = (ns: number[], resolution: string, note = 'اتفقنا مع الزبون') =>
  decideMany(new Request('http://x', { method: 'POST', body: JSON.stringify({ matchIds: ns.map(uid), resolution, note }) }), {
    params: Promise.resolve({ id: 'st1' }),
  });
const read = async () => {
  const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'st1' }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { statement: { matches: Row[] } };
};
const verdictOf = (body: { statement: { matches: Row[] } }, n: number) =>
  body.statement.matches.find((m) => m.id === uid(n))!.decisions as Record<string, { allowed: boolean; why: string | null }>;

const nothingWritten = () => {
  expect(world.writes).toEqual([]);
  expect(world.notes).toEqual([]);
  expect(logAudit).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  world.statement = {
    id: 'st1', companyId: 'c1', storeId: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt: null, matchingClosedAt: null,
    fileHash: 'ab'.repeat(32), gapExplanation: null, currencyCode: 'JOD', periodTo: null,
  };
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  requirePermission.mockResolvedValue({ id: 'u1' });
  receiptGap.mockResolvedValue({ claimed: 0, received: 0, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
  scene([{ shipping: 'SHIPPED', word: THE_WORD }]);
});

/* ───────────────────────────── the single answer ───────────────────────────── */

describe('the single answer: a parcel on the road that the company calls partial cannot be answered «اعتُمد رقم الشركة»', () => {
  it('is refused with the sentence that says what to do first — and nothing is written, noted or audited', async () => {
    const res = await say(1, 'ACCEPTED_COURIER');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: WHY.partialFirst, code: 'DECISION_NOT_ALLOWED', resolution: 'ACCEPTED_COURIER' });
    nothingWritten();
  });

  it('the door asked for the line’s status itself — the word is not guessed from anything else', async () => {
    await say(1, 'ACCEPTED_COURIER');
    expect(db.settlementMatch.findFirst.mock.calls[0][0].select).toMatchObject({ statementLine: { select: { status: true } } });
  });

  it.each(ON_THE_ROAD)('%s: refused', async (shipping) => {
    scene([{ shipping, word: THE_WORD }]);
    const res = await say(1, 'ACCEPTED_COURIER');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(WHY.partialFirst);
    nothingWritten();
  });

  it('every spelling the normaliser folds is the same word', async () => {
    for (const word of SPELLINGS) {
      scene([{ shipping: 'SHIPPED', word }]);
      const res = await say(1, 'ACCEPTED_COURIER');
      expect(res.status, JSON.stringify(word)).toBe(409);
      expect((await res.json()).error, JSON.stringify(word)).toBe(WHY.partialFirst);
    }
    nothingWritten();
  });

  it('«رقمنا» is refused as it always was — a claim before delivery — and «قيد المراجعة» is taken', async () => {
    const claim = await say(1, 'OURS_STANDS');
    expect(claim.status).toBe(409);
    expect((await claim.json()).error).toContain('قبل التسليم');
    nothingWritten();

    const parked = await say(1, 'UNDER_REVIEW', 'ننتظر تسجيل الاستلام الجزئي');
    expect(parked.status).toBe(200);
    expect(world.writes).toHaveLength(1);
    expect(world.writes[0]).toMatchObject({ resolution: 'UNDER_REVIEW', resolvedById: 'u1' });
    expect(world.notes).toHaveLength(1);
  });

  it('after the follow-up records «استلم جزءاً» (the order is PARTIALLY_DELIVERED) the SAME line takes their figure', async () => {
    expect((await say(1, 'ACCEPTED_COURIER')).status).toBe(409);
    world.orders.get('o1')!.shippingStatus = 'PARTIALLY_DELIVERED';
    const res = await say(1, 'ACCEPTED_COURIER');
    expect(res.status).toBe(200);
    expect(world.writes).toHaveLength(1);
    expect(world.writes[0]).toMatchObject({ resolution: 'ACCEPTED_COURIER' });
  });

  it('an order recorded delivered in full is NOT touched by the word — a product decision, not made here', async () => {
    scene([{ shipping: 'DELIVERED', word: THE_WORD }]);
    expect((await say(1, 'ACCEPTED_COURIER')).status).toBe(200);
    scene([{ shipping: 'PARTIALLY_DELIVERED', word: THE_WORD }]);
    expect((await say(1, 'ACCEPTED_COURIER')).status).toBe(200);
    expect((await say(1, 'OURS_STANDS')).status).toBe(200);
  });

  it('any other word, a half-word, a blank cell and a row with no line at all behave exactly as before on the road', async () => {
    const others: Spec['word'][] = ['تم توصيلها', 'تم التوصيل', 'مؤجلة', 'تم ارجاعها', 'قيد التوصيل', 'كلمة غريبة', 'جزئي', '', '   ', null, NO_LINE];
    for (const word of others) {
      scene([{ shipping: 'SHIPPED', word }]);
      const res = await say(1, 'ACCEPTED_COURIER');
      expect(res.status, typeof word === 'symbol' ? 'no line' : JSON.stringify(word)).toBe(200);
    }
  });

  it('a line of ZERO with the word keeps the sentence it always had (a zero line is no proof of delivery)', async () => {
    scene([{ shipping: 'SHIPPED', word: THE_WORD, match: { statementAmount: 0, difference: -20 } }]);
    const res = await say(1, 'ACCEPTED_COURIER');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(WHY.zeroOnTheRoad);
  });

  it('what already stopped the order keeps its own sentence: settled, held by another row', async () => {
    scene([{ shipping: 'SHIPPED', word: THE_WORD, order: { settlementStatus: 'SETTLED' } }]);
    expect((await (await say(1, 'ACCEPTED_COURIER')).json()).error).toBe(WHY.settled);
    scene([{ shipping: 'SHIPPED', word: THE_WORD }]);
    world.holders = [{ orderId: 'o1' }];
    expect((await (await say(1, 'ACCEPTED_COURIER')).json()).error).toBe(WHY.heldElsewhere);
  });

  it('a closed statement says its own sentence first — for their figure and for the parking alike', async () => {
    world.statement.matchingClosedAt = new Date('2026-11-06T00:00:00Z');
    for (const resolution of ['ACCEPTED_COURIER', 'UNDER_REVIEW']) {
      const res = await say(1, resolution);
      expect(res.status, resolution).toBe(409);
      expect(await res.json(), resolution).toEqual({ code: 'ALREADY_APPROVED', error: CLOSED });
    }
    nothingWritten();
  });

  it('a line no order carries is only ever parked — the word does not change that', async () => {
    scene([{ shipping: 'SHIPPED', word: THE_WORD, match: { result: 'MISSING_IN_SYSTEM', orderId: null, expectedAmount: null, difference: null } }]);
    expect((await say(1, 'UNDER_REVIEW', 'ليس طرداً لنا')).status).toBe(200);
    expect((await say(1, 'ACCEPTED_COURIER')).status).toBe(409);
  });
});

/* ───────────────────────────── the bulk answer ───────────────────────────── */

describe('the bulk answer: the whole press is refused, naming the lines, and nothing is saved', () => {
  it('three parcels on the road, three lines of the company’s word (spelled three ways): all three named, nothing saved', async () => {
    scene([
      { shipping: 'SHIPPED', word: SPELLINGS[0] },
      { shipping: 'OUT_FOR_DELIVERY', word: SPELLINGS[3] },
      { shipping: 'FAILED_DELIVERY', word: SPELLINGS[5] },
    ]);
    const res = await sayMany([1, 2, 3], 'ACCEPTED_COURIER');
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('DECISION_NOT_ALLOWED');
    expect(body.refused).toEqual([
      { matchId: uid(1), order: 'ORD-1', why: WHY.partialFirst },
      { matchId: uid(2), order: 'ORD-2', why: WHY.partialFirst },
      { matchId: uid(3), order: 'ORD-3', why: WHY.partialFirst },
    ]);
    // Same shape as every other refusal of this door: the count, «nothing saved», the first line and its sentence.
    expect(body.error).toBe(`لا يصحّ هذا البتّ على 3 سطراً — لم يُحفظ شيء. ORD-1: ${WHY.partialFirst}`);
    nothingWritten();
  });

  it('one recorded partial among two on the road: only the two on the road are named, and the press is still refused whole', async () => {
    scene([
      { shipping: 'SHIPPED', word: THE_WORD },
      { shipping: 'PARTIALLY_DELIVERED', word: THE_WORD },
      { shipping: 'READY_FOR_PICKUP', word: THE_WORD },
    ]);
    const res = await sayMany([1, 2, 3], 'ACCEPTED_COURIER');
    expect(res.status).toBe(409);
    expect((await res.json()).refused).toEqual([
      { matchId: uid(1), order: 'ORD-1', why: WHY.partialFirst },
      { matchId: uid(3), order: 'ORD-3', why: WHY.partialFirst },
    ]);
    nothingWritten();
  });

  it('a refusal for another reason beside it keeps its own sentence', async () => {
    scene([
      { shipping: 'SHIPPED', word: THE_WORD },
      { shipping: 'SHIPPED', word: THE_WORD, order: { settlementStatus: 'SETTLED' } },
    ]);
    const body = await (await sayMany([1, 2], 'ACCEPTED_COURIER')).json();
    expect(body.refused).toEqual([
      { matchId: uid(1), order: 'ORD-1', why: WHY.partialFirst },
      { matchId: uid(2), order: 'ORD-2', why: WHY.settled },
    ]);
  });

  it('once the follow-up has recorded all three as partial, the same press goes through', async () => {
    scene([{ shipping: 'SHIPPED', word: THE_WORD }, { shipping: 'SHIPPED', word: THE_WORD }, { shipping: 'SHIPPED', word: THE_WORD }]);
    expect((await sayMany([1, 2, 3], 'ACCEPTED_COURIER')).status).toBe(409);
    for (const o of world.orders.values()) o.shippingStatus = 'PARTIALLY_DELIVERED';
    const res = await sayMany([1, 2, 3], 'ACCEPTED_COURIER');
    expect(res.status).toBe(200);
    expect(world.writes).toHaveLength(3);
    expect(world.notes).toHaveLength(3);
  });

  it('«قيد المراجعة» for the same group is taken', async () => {
    scene([{ shipping: 'SHIPPED', word: THE_WORD }, { shipping: 'OUT_FOR_DELIVERY', word: THE_WORD }]);
    const res = await sayMany([1, 2], 'UNDER_REVIEW', 'ننتظر تسجيل الاستلام الجزئي');
    expect(res.status).toBe(200);
    expect(world.writes).toHaveLength(2);
  });

  it('lines with another word on the road are not touched: the same press with «تم توصيلها» goes through', async () => {
    scene([{ shipping: 'SHIPPED', word: 'تم توصيلها' }, { shipping: 'SHIPPED', word: 'تم توصيلها' }]);
    expect((await sayMany([1, 2], 'ACCEPTED_COURIER')).status).toBe(200);
  });

  it('a group of mixed words is refused for the mix, before the matrix is asked — as it was', async () => {
    scene([{ shipping: 'SHIPPED', word: THE_WORD }, { shipping: 'SHIPPED', word: 'تم توصيلها' }]);
    const res = await sayMany([1, 2], 'ACCEPTED_COURIER');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MIXED_WORDS');
    nothingWritten();
  });

  it('the press asked for the line’s status of every row', async () => {
    await sayMany([1], 'UNDER_REVIEW', 'ننتظر تسجيل الاستلام الجزئي');
    expect(db.settlementMatch.findMany.mock.calls[0][0].select).toMatchObject({ statementLine: { select: { status: true } } });
  });

  it('a closed statement says its own sentence first', async () => {
    world.statement.matchingClosedAt = new Date('2026-11-06T00:00:00Z');
    const res = await sayMany([1], 'ACCEPTED_COURIER');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ALREADY_APPROVED', error: CLOSED });
    nothingWritten();
  });
});

/* ───────────────────────────── the statement read ───────────────────────────── */

describe('the statement read: the screen is told, row by row, what may be said and why not', () => {
  it('a parcel on the road with the word: their figure is greyed with the sentence, the parking is open', async () => {
    const d = verdictOf(await read(), 1);
    expect(d.ACCEPTED_COURIER).toEqual({ allowed: false, why: WHY.partialFirst });
    expect(d.OURS_STANDS.allowed).toBe(false);
    expect(d.UNDER_REVIEW).toEqual({ allowed: true, why: null });
  });

  it('the first refusal in the screen’s own order (their figure, ours, the parking) is the new sentence — the one that says what to do', async () => {
    const d = verdictOf(await read(), 1);
    const first = ['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW'].map((k) => d[k]).find((v) => !v.allowed);
    expect(first?.why).toBe(WHY.partialFirst);
  });

  it('four rows, four stories: only the road beside the word is greyed', async () => {
    scene([
      { shipping: 'SHIPPED', word: THE_WORD },
      { shipping: 'SHIPPED', word: 'تم توصيلها' },
      { shipping: 'PARTIALLY_DELIVERED', word: THE_WORD },
      { shipping: 'SHIPPED', word: null },
    ]);
    const body = await read();
    expect([1, 2, 3, 4].map((n) => verdictOf(body, n).ACCEPTED_COURIER.allowed)).toEqual([false, true, true, true]);
    // The reading itself is what the screen already showed beside the row.
    const word = (n: number) => (body.statement.matches.find((m) => m.id === uid(n))!.courierWord as { outcome: string } | null)?.outcome ?? null;
    expect([1, 2, 3, 4].map(word)).toEqual(['PARTIAL', 'DELIVERED', 'PARTIAL', null]);
  });

  it('the follow-up records «استلم جزءاً» and the very next read offers the answer again', async () => {
    expect(verdictOf(await read(), 1).ACCEPTED_COURIER.allowed).toBe(false);
    world.orders.get('o1')!.shippingStatus = 'PARTIALLY_DELIVERED';
    expect(verdictOf(await read(), 1).ACCEPTED_COURIER).toEqual({ allowed: true, why: null });
  });

  it('a spelling the normaliser folds is greyed the same; a half-word is not', async () => {
    scene([
      { shipping: 'SHIPPED', word: SPELLINGS[5] },
      { shipping: 'SHIPPED', word: 'جزئي' },
    ]);
    const body = await read();
    expect(verdictOf(body, 1).ACCEPTED_COURIER.why).toBe(WHY.partialFirst);
    expect(verdictOf(body, 2).ACCEPTED_COURIER.allowed).toBe(true);
  });

  it('a clean row has no decision to take — the word on a MATCHED row offers nothing', async () => {
    scene([{ shipping: 'SHIPPED', word: THE_WORD, match: { result: 'MATCHED', expectedAmount: 18, difference: 0 } }]);
    expect(((await read()).statement.matches[0] as Row).decisions).toBeNull();
  });

  it('a closed matching greys every saying with the closed sentence — the word does not get a sentence of its own there', async () => {
    world.statement.matchingClosedAt = new Date('2026-11-06T00:00:00Z');
    const d = verdictOf(await read(), 1);
    for (const k of ['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']) expect(d[k], k).toEqual({ allowed: false, why: CLOSED });
  });
});
