import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «تسليم المندوب» IS THE MANUAL STATEMENT — AT ITS OWN DOORS, WITH ITS OWN MONEY (F9, 23/11).
 *
 * The owner on the tracking dialog: «افرض استلمت دولار وليرة، ما في نظام التسوية زي الكشف، وما بقدر اعمل استلامات، وبحطلي
 * محافظ الأردن وأنا بسوريا؟» — «بدنا نصحح الموضوع زي الكشوفات للمناديب والشركات اللي بدون API».
 *
 * One statement in SYP, stateful across calls (its receipts, its stamp, the wallet movements), driven through the REAL
 * receipts door, the REAL list of open handovers and the REAL approval, with the REAL `receiptGap`:
 *
 *   · USD on day one and SYP on day two: «باقي» after each, and the approval writes TWO movements — one per receipt;
 *   · the same receipt id twice: one row and a replay; the approval pressed twice: still one movement per receipt;
 *   · a payment above the total: «زيادة», and the approval refused without a written explanation;
 *   · a wallet of another country (WALLET_OTHER_COUNTRY), another currency with no rate (EXCHANGE_RATE_REQUIRED), an inactive
 *     wallet and another store's (404): nothing written;
 *   · a hand entry of the same money stops the approval (POSSIBLE_DOUBLE) — and the handover's own movements are never
 *     counted as hand entries;
 *   · and nothing is written to a wallet before «اعتماد».
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const { db, S, recordMovement, runMatching, requireContext } = vi.hoisted(() => {
  const S = {
    statement: {} as Row,
    receipts: [] as Row[],
    wallets: [] as Row[],
    movements: [] as Row[],
    hand: [] as Row[],
    handWhere: [] as Row[],
    matches: [] as Row[],
  };
  const inStore = (w: Row, where: Row) => {
    if (where.isActive === true && !w.isActive) return false;
    if (where.companyId && w.companyId !== where.companyId) return false;
    if (where.OR) return where.OR.some((c: Row) => c.storeId === w.storeId);
    if ('storeId' in where) return w.storeId === where.storeId;
    return true;
  };
  const withIncludes = (args: Row) =>
    args?.include
      ? { ...S.statement, receipts: S.receipts.map((r) => ({ ...r })), matches: S.matches.map((m) => ({ ...m })) }
      : { ...S.statement, _count: { receipts: S.receipts.length } };
  const db = {
    courierStatement: {
      findFirst: vi.fn(async (args: Row) => {
        const w = args.where;
        if (w.id !== S.statement.id || w.companyId !== S.statement.companyId) return null;
        if (w.storeId && w.storeId !== S.statement.storeId) return null;
        return withIncludes(args);
      }),
      findUnique: vi.fn(async () => ({ ...S.statement })),
      findMany: vi.fn(async (args: Row) => {
        const w = args.where;
        const st = S.statement;
        if (w.storeId !== st.storeId || st.approvedAt || st.status === 'APPROVED') return [];
        if (w.id && w.id !== st.id) return [];
        if (!String(st.fileHash).startsWith('manual:') || String(st.fileHash).startsWith('manual:draft:')) return [];
        return [
          {
            ...st,
            _count: { lines: 1 },
            receipts: S.receipts.map((r) => ({ ...r, wallet: { name: S.wallets.find((x) => x.id === r.walletId)?.name } })),
          },
        ];
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const st = S.statement;
        if (where.approvedAt === null && st.approvedAt) return { count: 0 };
        if (where.status?.not === 'APPROVED' && st.status === 'APPROVED') return { count: 0 };
        if (where.matchingClosedAt === null && st.matchingClosedAt) return { count: 0 };
        Object.assign(st, data);
        return { count: 1 };
      }),
    },
    statementReceipt: {
      findFirst: vi.fn(async ({ where }: Row) => S.receipts.find((r) => r.id === where.id && r.statementId === where.statementId) ?? null),
      findMany: vi.fn(async ({ where }: Row) => S.receipts.filter((r) => r.statementId === where.statementId)),
      create: vi.fn(async ({ data }: Row) => {
        if (S.receipts.some((r) => r.id === data.id)) {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });
        }
        const row = { ...data };
        S.receipts.push(row);
        return row;
      }),
    },
    wallet: {
      findFirst: vi.fn(async ({ where }: Row) => {
        const w = S.wallets.find((x) => x.id === where.id);
        return w && inStore(w, where) ? { ...w, country: { name: w.countryName } } : null;
      }),
    },
    walletMovement: {
      findMany: vi.fn(async ({ where }: Row) => {
        S.handWhere.push(where);
        return S.hand.filter((m) => where.walletId.in.includes(m.walletId) && m.referenceType === where.referenceType);
      }),
    },
    deliveryProvider: { findMany: vi.fn(async () => [{ id: 'p1', name: 'أبو علي' }]) },
    user: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  /** The one writer of a wallet movement: refuses a second movement for the same receipt, as the unique index does. */
  const recordMovement = vi.fn(async (_tx: unknown, m: Row) => {
    if (m.statementReceiptId && S.movements.some((x) => x.statementReceiptId === m.statementReceiptId)) {
      throw new Error('unique statementReceiptId');
    }
    S.movements.push(m);
    return { id: `mv${S.movements.length}` };
  });
  return { db, S, recordMovement, runMatching: vi.fn(async () => ({})), requireContext: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(async () => ({})), can: () => true }));
vi.mock('@/lib/settlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/settlement')>()),
  runMatching: (...a: unknown[]) => runMatching(...(a as [])),
}));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => recordMovement(...(a as [unknown, Row])),
}));
vi.mock('@/lib/per-line-settlement-switch', () => ({ perLineSettlementOn: async () => false }));
vi.mock('@/lib/statement-close', async (orig) => ({
  ...(await orig<typeof import('@/lib/statement-close')>()),
  // The close settles the ORDERS (statement-close's own tests); this file is about the money the approval writes.
  settleStatement: vi.fn(async () => ({
    deliveredCount: 0, settledCount: 1, acceptedCount: 0, claimCount: 0, shortfalls: [], shortfallsOnCompany: 0,
  })),
}));

import { POST as addReceipt } from './[id]/receipts/route';
import { PATCH as patchStatement } from './[id]/route';
import { GET as openHandovers } from './manual/route';
import { POST as collectByHand } from '../../ops/tracking/collect/route';
import { manualFileHash } from '@/lib/manual-statement-rules';

const ID = '88888888-8888-4888-8888-888888888888';
const W_SYP = '11111111-1111-4111-8111-111111111111';
const W_USD = '22222222-2222-4222-8222-222222222222';
const W_JO = '33333333-3333-4333-8333-333333333333';
const W_OFF = '44444444-4444-4444-8444-444444444444';
const W_S2 = '55555555-5555-4555-8555-555555555555';
const W_UNPLACED = '66666666-6666-4666-8666-666666666666';
const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const params = { params: Promise.resolve({ id: ID }) };
const send = (method: string, body: unknown) =>
  new Request('http://x/api', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const receipt = (body: Row) => addReceipt(send('POST', body), params);
const approve = (extra: Row = {}) => patchStatement(send('PATCH', { approve: true, ...extra }), params);
const list = async () => (await (await openHandovers(new Request(`http://x/api?id=${ID}`))).json()).handovers as Row[];

const wallet = (id: string, over: Row = {}) => ({
  id, companyId: 'c1', storeId: 's1', isActive: true, countryId: 'sy', countryName: 'سوريا', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  S.statement = {
    id: ID, companyId: 'c1', storeId: 's1', deliveryProviderId: 'p1', status: 'IMPORTED', approvedAt: null,
    matchingClosedAt: null, reference: 'تسليم أبو علي 2026-11-23', currencyCode: 'SYP', totalAmount: 1_300_000,
    gapExplanation: null, createdAt: new Date('2026-11-23T08:00:00Z'), periodTo: null,
    fileHash: manualFileHash({ companyId: 'c1', courierId: 'p1', reference: 'تسليم أبو علي 2026-11-23' }),
  };
  S.receipts = [];
  S.movements = [];
  S.hand = [];
  S.handWhere = [];
  S.matches = [{ id: 'm1', orderId: 'o1', result: 'MATCHED', resolution: null, statementAmount: 1_300_000, statementFee: 0 }];
  S.wallets = [
    wallet(W_SYP, { name: 'صندوق الليرة', currencyCode: 'SYP' }),
    wallet(W_USD, { name: 'صندوق الدولار', currencyCode: 'USD' }),
    wallet(W_JO, { name: 'صندوق عمّان', currencyCode: 'SYP', storeId: null, countryId: 'jo', countryName: 'الأردن' }),
    wallet(W_OFF, { name: 'صندوق موقوف', currencyCode: 'SYP', isActive: false }),
    wallet(W_S2, { name: 'صندوق متجر تاني', currencyCode: 'SYP', storeId: 's2' }),
    wallet(W_UNPLACED, { name: 'صندوق غير مخصص', currencyCode: 'SYP', storeId: null }),
  ];
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', countryId: 'sy',
    country: { id: 'sy', minorUnit: 2, currencyCode: 'SYP' },
  });
});

describe('دولار وليرة على يومين — one statement, two receipts, one approval', () => {
  it('day one in USD leaves «باقي», day two in SYP closes it, and only the approval writes — two movements', async () => {
    // Day one: 50 USD at 0.0001 USD per SYP = 500,000 SYP.
    const one = await receipt({ receiptId: R1, walletId: W_USD, amount: 50, exchangeRate: 0.0001 });
    expect(one.status).toBe(201);
    let [h] = await list();
    expect(h.standing).toEqual({ claimed: 1_300_000, received: 500_000, remaining: 800_000, over: 0 });
    expect(h.table).toEqual([{ currencyCode: 'USD', amount: 50, rates: [0.0001], equivalent: 500_000 }]);
    expect(S.movements).toHaveLength(0);

    // Day two: the rest in SYP.
    const two = await receipt({ receiptId: R2, walletId: W_SYP, amount: 800_000 });
    expect(two.status).toBe(201);
    [h] = await list();
    expect(h.standing).toEqual({ claimed: 1_300_000, received: 1_300_000, remaining: 0, over: 0 });
    expect(h.table.map((r: Row) => [r.currencyCode, r.amount, r.equivalent])).toEqual([
      ['SYP', 800_000, 800_000],
      ['USD', 50, 500_000],
    ]);
    expect(S.movements).toHaveLength(0);

    const res = await approve();
    expect(res.status).toBe(200);
    expect(S.movements.map((m) => [m.walletId, m.amount, m.statementReceiptId, m.direction, m.referenceType])).toEqual([
      [W_USD, 50, R1, 'IN', 'STATEMENT'],
      [W_SYP, 800_000, R2, 'IN', 'STATEMENT'],
    ]);
    // Approved: it is no longer an open handover.
    expect(await list()).toEqual([]);
  });

  it('the approval pressed twice writes ONE movement per receipt — the second press is ALREADY_APPROVED', async () => {
    await receipt({ receiptId: R1, walletId: W_SYP, amount: 1_300_000 });
    expect((await approve()).status).toBe(200);
    const again = await approve();
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('ALREADY_APPROVED');
    expect(S.movements).toHaveLength(1);
  });

  it('the same receipt id sent twice is ONE row, and the second answer is a replay', async () => {
    const first = await receipt({ receiptId: R1, walletId: W_SYP, amount: 600_000 });
    const second = await receipt({ receiptId: R1, walletId: W_SYP, amount: 600_000 });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).replay).toBe(true);
    expect(S.receipts).toHaveLength(1);
  });

  it('a genuine second payment with its own id is a second row', async () => {
    await receipt({ receiptId: R1, walletId: W_SYP, amount: 600_000 });
    await receipt({ receiptId: R2, walletId: W_SYP, amount: 600_000 });
    expect(S.receipts).toHaveLength(2);
    const [h] = await list();
    expect(h.standing.remaining).toBe(100_000);
  });
});

/*
 * 23/11, the owner: some companies pay through «شام كاش» (a digital wallet), not cash. A line's wallet is ANY active wallet of
 * the orders' country and of that line's currency — nothing assumes cash — and one handover mixes the two.
 */
describe('«شام كاش» beside cash — one handover, two kinds of wallet', () => {
  const W_SHAM = '77777777-7777-4777-8777-777777777777';
  const W_SHAM_JO = '99999999-9999-4999-8999-999999999999';

  it('a Shamcash line (with its transaction number) and a cash line are both recorded, and the approval writes two movements, each into its own wallet', async () => {
    S.wallets.push(wallet(W_SHAM, { name: 'شام كاش دولار', currencyCode: 'USD' }));
    const sham = await receipt({ receiptId: R1, walletId: W_SHAM, amount: 50, exchangeRate: 0.0001, note: 'SC-20261123-4471' });
    const cash = await receipt({ receiptId: R2, walletId: W_SYP, amount: 800_000 });
    expect([sham.status, cash.status]).toEqual([201, 201]);
    expect(S.receipts.map((r) => [r.walletId, r.note])).toEqual([[W_SHAM, 'SC-20261123-4471'], [W_SYP, null]]);
    expect((await list())[0].standing.remaining).toBe(0);

    expect((await approve()).status).toBe(200);
    expect(S.movements.map((m) => [m.walletId, m.amount, m.statementReceiptId])).toEqual([
      [W_SHAM, 50, R1],
      [W_SYP, 800_000, R2],
    ]);
  });

  it('NEGATIVE: a Shamcash wallet of another country is WALLET_OTHER_COUNTRY, and nothing is written', async () => {
    S.wallets.push(wallet(W_SHAM_JO, { name: 'شام كاش الأردن', currencyCode: 'SYP', storeId: null, countryId: 'jo', countryName: 'الأردن' }));
    const res = await receipt({ receiptId: R1, walletId: W_SHAM_JO, amount: 100, note: 'SC-1' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('WALLET_OTHER_COUNTRY');
    expect(S.receipts).toHaveLength(0);
  });
});

describe('the open handovers read (review, 23/11)', () => {
  it('computes «باقي» at the country’s real minor unit, not at 0', async () => {
    requireContext.mockResolvedValue({
      user: { id: 'u1' }, companyId: 'c1', storeId: 's1', countryId: 'sy',
      country: { id: 'sy', minorUnit: 3, currencyCode: 'SYP' },
    });
    S.statement.totalAmount = 10.5;
    await receipt({ receiptId: R1, walletId: W_SYP, amount: 10.25 });
    const [h] = await list();
    // At 0 decimals this would read 11 claimed, 10 received, 1 left.
    expect(h.standing).toEqual({ claimed: 10.5, received: 10.25, remaining: 0.25, over: 0 });
  });

  it('NEGATIVE: never lists an approved statement — it asks for unapproved ones only', async () => {
    await list();
    const where = db.courierStatement.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ approvedAt: null, status: { not: 'APPROVED' }, storeId: 's1', companyId: 'c1' });
    S.statement.approvedAt = new Date();
    S.statement.status = 'APPROVED';
    expect(await list()).toEqual([]);
  });
});

describe('a payment above the total — «زيادة», and no approval without a reason', () => {
  it('says «زيادة» and refuses the approval until a reason is written; nothing is written meanwhile', async () => {
    await receipt({ receiptId: R1, walletId: W_SYP, amount: 1_400_000 });
    const [h] = await list();
    expect(h.standing).toMatchObject({ remaining: 0, over: 100_000 });

    const refused = await approve();
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('GAP_REQUIRES_EXPLANATION');
    expect(S.movements).toHaveLength(0);

    const explained = await approve({ gapExplanation: 'زيادة رجعناها للمندوب نقداً' });
    expect(explained.status).toBe(200);
    expect(S.movements).toHaveLength(1);
  });

  it('a part still owed is the same gap: refused without a reason', async () => {
    await receipt({ receiptId: R1, walletId: W_SYP, amount: 1_000_000 });
    const refused = await approve();
    expect((await refused.json()).code).toBe('GAP_REQUIRES_EXPLANATION');
    expect(S.movements).toHaveLength(0);
  });
});

describe('the wallet a payment lands in', () => {
  it('NEGATIVE: another country’s wallet — even an unplaced one — is WALLET_OTHER_COUNTRY, named, and nothing is written', async () => {
    const res = await receipt({ receiptId: R1, walletId: W_JO, amount: 100 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('WALLET_OTHER_COUNTRY');
    expect(body.error).toContain('الأردن');
    expect(body.error).toContain('صندوق عمّان');
    expect(S.receipts).toHaveLength(0);
    expect(db.courierStatement.updateMany).not.toHaveBeenCalled();
  });

  it('an unplaced wallet of THIS country is taken', async () => {
    const res = await receipt({ receiptId: R1, walletId: W_UNPLACED, amount: 100 });
    expect(res.status).toBe(201);
  });

  it('NEGATIVE: another currency with no rate is EXCHANGE_RATE_REQUIRED, and nothing is written', async () => {
    const res = await receipt({ receiptId: R1, walletId: W_USD, amount: 50 });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('EXCHANGE_RATE_REQUIRED');
    expect(S.receipts).toHaveLength(0);
  });

  it.each([
    ['an inactive wallet', W_OFF],
    ['another store’s wallet', W_S2],
  ])('NEGATIVE: %s is a 404 and nothing is written', async (_name, id) => {
    const res = await receipt({ receiptId: R1, walletId: id, amount: 100 });
    expect(res.status).toBe(404);
    expect(S.receipts).toHaveLength(0);
  });
});

describe('the same money entered by hand', () => {
  it('a hand entry of the same amount in the same wallet stops the approval: POSSIBLE_DOUBLE, nothing written', async () => {
    await receipt({ receiptId: R1, walletId: W_SYP, amount: 1_300_000 });
    S.hand = [
      { id: 'h1', walletId: W_SYP, amount: 1_300_000, referenceType: null, party: 'أبو علي', note: 'استلمت', createdAt: new Date(), createdById: 'u9', wallet: { name: 'صندوق الليرة', currencyCode: 'SYP', country: { minorUnit: 2 } } },
    ];
    const res = await approve();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('POSSIBLE_DOUBLE');
    expect(S.movements).toHaveLength(0);
  });

  it('the handover’s own movements are never counted as hand entries: the approval asks only for rows with no reference', async () => {
    await receipt({ receiptId: R1, walletId: W_SYP, amount: 1_300_000 });
    S.hand = [
      { id: 'st1', walletId: W_SYP, amount: 1_300_000, referenceType: 'STATEMENT', party: '', note: '', createdAt: new Date(), createdById: 'u1', wallet: { name: 'صندوق الليرة', currencyCode: 'SYP', country: { minorUnit: 2 } } },
    ];
    expect((await approve()).status).toBe(200);
    expect(S.handWhere[0].referenceType).toBeNull();
  });
});

describe('the old hand door, marked', () => {
  const collect = (orderIds: string[], walletId: string) =>
    collectByHand(send('POST', { orderIds, walletId, note: 'استلمت منه' }));
  const ORDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('NEGATIVE: another country’s wallet is WALLET_OTHER_COUNTRY there too, before any order is read', async () => {
    (db as Row).order = { findMany: vi.fn() };
    const res = await collect([ORDER], W_JO);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('WALLET_OTHER_COUNTRY');
    expect((db as Row).order.findMany).not.toHaveBeenCalled();
  });
});
