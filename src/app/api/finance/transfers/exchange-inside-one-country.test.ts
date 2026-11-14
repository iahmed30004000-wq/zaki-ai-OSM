import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * CHANGING ONE CURRENCY FOR ANOTHER INSIDE ONE COUNTRY, AND GIVING THE EXCHANGE AS THE AMOUNT THAT ARRIVED.
 *
 * The owner, 10/11: «لازم يكون في تحويل اموال من نفس البلد الواحد: افرض صرفت ليرة سوري لدولار والعكس … وخيار ثالث: كم المبلغ
 * النهائي المستلم — بدل ما أحط سعر الصرف بحط كم استلمت». Two things the door refused or could not say:
 *
 *   · a lira wallet and a dollar wallet of ONE Syrian store were REFUSED («محفظتان في بلد واحد بعملتين مختلفتين»), so
 *     «صرفت ليرة لدولار» could not be recorded at all;
 *   · the only way to say the exchange was `exchangeRate`, units of the destination per one of the source — and SYP→USD
 *     in that form is 0.0000769…, which the column keeps as 0.000077: a tenth of a percent, if anything multiplied it back.
 *
 * Every figure below is worked by hand in the comment beside it. These assert THE ROWS HANDED TO THE DATABASE, which is
 * the only thing that is money.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    wallet: { findFirst: vi.fn() },
    walletTransfer: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    walletMovement: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { GET, POST as TRANSFER } from './route';

const SYRIA = { minorUnit: 2, name: 'سوريا' };
const JORDAN = { minorUnit: 3, name: 'الأردن' };
const SY_ID = '33333333-3333-4333-8333-333333333333';
const JO_ID = '44444444-4444-4444-8444-444444444444';
const STORE_A = '66666666-6666-4666-8666-666666666666';
const STORE_B = '77777777-7777-4777-8777-777777777777';

/** A dollar drawer and a lira drawer in ONE Syrian store: the pair the door used to refuse. */
const USD = {
  id: '11111111-1111-4111-8111-111111111111', name: 'صندوق الدولار', currencyCode: 'USD',
  storeId: STORE_A, countryId: SY_ID, isActive: true, store: { name: 'متجر دمشق' }, country: SYRIA,
};
const SYP = { ...USD, id: '22222222-2222-4222-8222-222222222222', name: 'صندوق الليرة', currencyCode: 'SYP' };
/** A lira drawer of ANOTHER store of the same country: a move between two sets of books. */
const SYP_B = { ...SYP, id: '55555555-5555-4555-8555-555555555555', name: 'ليرة المتجر الثاني', storeId: STORE_B, store: { name: 'متجر حلب' } };
/** A dinar drawer in Jordan: three decimals, another country. */
const JOD = {
  id: '88888888-8888-4888-8888-888888888888', name: 'صندوق الأردن', currencyCode: 'JOD',
  storeId: STORE_A, countryId: JO_ID, isActive: true, store: { name: 'متجر عمّان' }, country: JORDAN,
};
/** A second dollar drawer, for a transfer of one currency. */
const USD2 = { ...USD, id: '99999999-9999-4999-8999-999999999999', name: 'حساب الدولار البنكي' };

type Wallet = typeof USD;
const wallets: Record<string, Wallet> = {};

/** What the code under test hands to a query, and to a write. */
type Query = { where: { id: string; companyId?: string; isActive?: boolean } };
type Write = { data: Record<string, unknown> };
type Row = Record<string, unknown>;

/** What the fake database committed — a transaction that throws leaves NOTHING here. */
let committed: Array<{ kind: 'transfer' | 'movement'; data: Row }> = [];
/** Make the n-th movement of a transaction fail (1 = the OUT, 2 = the IN). */
let failMovement: number | null = null;
/** Transfer ids that exist in ANOTHER company: the database holds them too, and refuses a second row with one. */
let foreignIds: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  committed = [];
  failMovement = null;
  foreignIds = [];
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'سامر' }, companyId: 'co1', storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);

  for (const w of [USD, SYP, SYP_B, JOD, USD2]) wallets[w.id] = w;
  // A stopped wallet is found only by a query that does not ask for active ones, as in the real database.
  db.wallet.findFirst.mockImplementation(async ({ where }: Query) => {
    const w = wallets[where.id];
    if (!w) return null;
    return where.isActive === true && !w.isActive ? null : w;
  });

  // A fake with a REAL commit: writes are buffered and kept only if the whole function returns.
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const pending: typeof committed = [];
    let movements = 0;
    const tx = {
      wallet: db.wallet,
      walletTransfer: {
        create: async ({ data }: Write) => {
          // The primary key: a second row with an id that exists — in any company — is a unique violation (P2002).
          const id = data.id as string | undefined;
          if (id && (foreignIds.includes(id) || committed.some((c) => c.kind === 'transfer' && c.data.id === id))) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
          }
          pending.push({ kind: 'transfer', data });
          return { id: data.id ?? 'tr-1', createdAt: new Date('2026-11-10T10:00:00Z'), ...data };
        },
      },
      walletMovement: {
        create: async ({ data }: Write) => {
          movements += 1;
          if (failMovement === movements) throw new Error('boom');
          pending.push({ kind: 'movement', data });
          return { id: `mv-${movements}`, ...data };
        },
      },
    };
    const result = await fn(tx);
    committed.push(...pending);
    return result;
  });

  // The rows a replay can find: only what was committed, scoped by company like the real query.
  db.walletTransfer.findFirst.mockImplementation(async ({ where }: Query) => {
    const hit = committed.find((c) => c.kind === 'transfer' && c.data.id === where.id && c.data.companyId === where.companyId);
    return hit ? { id: hit.data.id, createdAt: new Date('2026-11-10T10:00:00Z'), ...hit.data } : null;
  });
});

const post = (body: unknown) =>
  TRANSFER(
    new Request('http://localhost/api/finance/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const NOTE = 'صرف دولار';
const transferRows = () => committed.filter((c) => c.kind === 'transfer').map((c) => c.data);
const movementRows = () => committed.filter((c) => c.kind === 'movement').map((c) => c.data);
const amounts = () => movementRows().map((m) => m.amount);

describe('one country, one store, two currencies — an exchange, no longer a refusal', () => {
  it('1 — 100 USD into the lira drawer at 13,000 ليرة لكل دولار: 1,300,000 SYP, kind EXCHANGE', async () => {
    // The screen sends the amount that arrives: 100 × 13,000 = 1,300,000.
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, note: NOTE, expectKind: 'EXCHANGE' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.reading).toMatchObject({ kind: 'EXCHANGE', label: 'صرف داخل البلد', needsRate: true });

    expect(transferRows()).toEqual([
      expect.objectContaining({
        fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, exchangeRate: 13_000, kind: 'EXCHANGE',
      }),
    ]);
    expect(amounts()).toEqual([100, 1_300_000]);
    const [out, inn] = movementRows();
    expect([out.direction, out.walletId, out.category]).toEqual(['OUT', USD.id, 'TRANSFER_OUT']);
    expect([inn.direction, inn.walletId, inn.category]).toEqual(['IN', SYP.id, 'TRANSFER_IN']);
    // the arriving movement says what was exchanged for what, in the figures a person reads
    expect(inn.note).toContain('صُرِف 100.00 USD إلى 1,300,000.00 SYP');
  });

  it('…and the very same deal as the rate the door has always taken gives the same rows', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, exchangeRate: 13_000, note: NOTE });
    expect(res.status).toBe(201);
    expect(transferRows()[0]).toMatchObject({ amountOut: 100, amountIn: 1_300_000, exchangeRate: 13_000, kind: 'EXCHANGE' });
    expect(amounts()).toEqual([100, 1_300_000]);
    // the legacy line on the arriving movement is unchanged
    expect(movementRows()[1].note).toBe(`${NOTE} (سعر الصرف 13000)`);
  });

  it('2 — and back: 1,300,000 SYP into the dollar drawer arrives as exactly 100 USD, with nothing multiplied from a six-decimal rate', async () => {
    // The screen worked 1,300,000 ÷ 13,000 = 100 and sent that. The stored rate is only the reading of the two:
    // 100 ÷ 1,300,000 = 0.0000769230… → 0.000077.
    const res = await post({ fromWalletId: SYP.id, toWalletId: USD.id, amountOut: 1_300_000, amountIn: 100, note: NOTE, expectKind: 'EXCHANGE' });
    expect(res.status).toBe(201);
    expect(transferRows()[0]).toMatchObject({ amountOut: 1_300_000, amountIn: 100, exchangeRate: 0.000077, kind: 'EXCHANGE' });
    expect(amounts()).toEqual([1_300_000, 100]);
  });

  it('THE TRAP: handed the stored rate instead, the same lira would arrive as 100.1 dollars — which is why the amount is the record', async () => {
    // 1,300,000 × 0.000077 = 100.1. Nothing in the new path ever does this multiplication.
    const res = await post({ fromWalletId: SYP.id, toWalletId: USD.id, amountOut: 1_300_000, exchangeRate: 0.000077, note: NOTE });
    expect(res.status).toBe(201);
    expect(amounts()).toEqual([1_300_000, 100.1]);
  });

  it('3 — 1,250,000 SYP for 100 USD (typed as 0.00008 دولار لكل ليرة, worked by the screen): the row keeps 100 and reads 0.00008', async () => {
    // 1,250,000 × 0.00008 = 100 exactly; 100 ÷ 1,250,000 = 0.00008.
    const res = await post({ fromWalletId: SYP.id, toWalletId: USD.id, amountOut: 1_250_000, amountIn: 100, note: NOTE });
    expect(res.status).toBe(201);
    expect(transferRows()[0]).toMatchObject({ amountOut: 1_250_000, amountIn: 100, exchangeRate: 0.00008 });
  });

  it('4 — 100 USD out and 1,290,000 SYP received: the amount stored is exactly what was typed, and the rate reads 12,900', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_290_000, note: NOTE });
    expect(res.status).toBe(201);
    expect(transferRows()[0]).toMatchObject({ amountOut: 100, amountIn: 1_290_000, exchangeRate: 12_900 });
    expect(amounts()).toEqual([100, 1_290_000]);
  });

  it('5 — 100 JOD (Jordan) at 18,000 ليرة لكل دينار: 1,800,000 SYP, BETWEEN_COUNTRIES, the legacy payload unchanged', async () => {
    const res = await post({ fromWalletId: JOD.id, toWalletId: SYP.id, amountOut: 100, exchangeRate: 18_000, note: 'تحويل لسوريا' });
    expect(res.status).toBe(201);
    expect(transferRows()[0]).toMatchObject({ amountOut: 100, amountIn: 1_800_000, exchangeRate: 18_000, kind: 'BETWEEN_COUNTRIES' });
    expect(amounts()).toEqual([100, 1_800_000]);
    // …and as an arriving amount, the same deal
    committed = [];
    const via = await post({ fromWalletId: JOD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_800_000, note: 'تحويل لسوريا' });
    expect(via.status).toBe(201);
    expect(transferRows()[0]).toMatchObject({ amountOut: 100, amountIn: 1_800_000, exchangeRate: 18_000, kind: 'BETWEEN_COUNTRIES' });
  });

  it('two stores of one country in two currencies is BETWEEN_STORES and takes the exchange too', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP_B.id, amountOut: 100, amountIn: 1_300_000, note: NOTE, expectKind: 'BETWEEN_STORES' });
    expect(res.status).toBe(201);
    expect(transferRows()[0]).toMatchObject({ kind: 'BETWEEN_STORES', amountIn: 1_300_000 });
  });
});

describe('the decimals of each currency are honoured on both sides', () => {
  it('JOD (three decimals) into USD (two): 33.333 JOD as 46.95 USD — a figure the dollar can hold', async () => {
    const res = await post({ fromWalletId: JOD.id, toWalletId: USD.id, amountOut: 33.333, amountIn: 46.95, note: 'صرف' });
    expect(res.status).toBe(201);
    expect(amounts()).toEqual([33.333, 46.95]);
  });

  it('an arriving amount with more decimals than the destination counts in is refused, never rounded', async () => {
    // The dollar counts in cents: 46.953 is not a figure a dollar drawer can hold.
    const res = await post({ fromWalletId: JOD.id, toWalletId: USD.id, amountOut: 33.333, amountIn: 46.953, note: 'صرف' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('AMOUNT_IN_DECIMALS');
    expect(body.error).toContain('خانتين عشريتين');
    expect(committed).toEqual([]);
  });

  it('what leaves, with more decimals than the SOURCE counts in, is refused too — a dollar drawer has no third decimal', async () => {
    for (const extra of [{ exchangeRate: 13_000 }, { amountIn: 1_300_000 }]) {
      const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100.005, note: NOTE, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect((await res.json()).code).toBe('AMOUNT_OUT_DECIMALS');
    }
    expect(committed).toEqual([]);
  });

  it('a dinar drawer does have three: 10.123 JOD goes out as 10.123', async () => {
    const res = await post({ fromWalletId: JOD.id, toWalletId: SYP.id, amountOut: 10.123, exchangeRate: 18_000, note: 'صرف' });
    expect(res.status).toBe(201);
    // 10.123 × 18,000 = 182,214 exactly.
    expect(amounts()).toEqual([10.123, 182_214]);
  });

  it('DROPPING THE DESTINATION ROUNDING would be seen: 7 USD at 13,000.555 is 91,003.885 → 91,003.89, to the lira’s two decimals', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 7, exchangeRate: 13_000.555, note: NOTE });
    expect(res.status).toBe(201);
    expect(transferRows()[0].amountIn).toBe(91_003.89);
    expect(amounts()).toEqual([7, 91_003.89]);
  });

  it('tiny and huge: one cent of a dollar is 130 lira, and a million dollars is 13,000,000,000', async () => {
    expect((await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 0.01, amountIn: 130, note: NOTE })).status).toBe(201);
    expect((await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 1_000_000, amountIn: 13_000_000_000, note: NOTE })).status).toBe(201);
    expect(amounts()).toEqual([0.01, 130, 1_000_000, 13_000_000_000]);
  });
});

describe('exactly one way of giving the exchange, and only when the currency changes', () => {
  it('both a rate and an amount: refused in Arabic, nothing written', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, exchangeRate: 13_000, amountIn: 1_300_000, note: NOTE });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('RATE_AND_AMOUNT_BOTH');
    expect(body.error).toMatch(/[؀-ۿ]/);
    expect(committed).toEqual([]);
  });

  it('neither: the same code as always, and the sentence now names both ways', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, note: NOTE });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EXCHANGE_RATE_REQUIRED');
    expect(body.error).toContain('سعر صرف');
    expect(body.error).toContain('المبلغ المستلم');
    expect(committed).toEqual([]);
  });

  it('one currency: no rate and no amount may come with it', async () => {
    for (const extra of [{ amountIn: 100 }, { exchangeRate: 1 }]) {
      const res = await post({ fromWalletId: USD.id, toWalletId: USD2.id, amountOut: 100, note: 'إيداع', ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect((await res.json()).code).toBe('RATE_NOT_ALLOWED');
    }
    expect(committed).toEqual([]);
    // and without them it is a plain move: the same amount, a rate of 1
    const ok = await post({ fromWalletId: USD.id, toWalletId: USD2.id, amountOut: 100, note: 'إيداع' });
    expect(ok.status).toBe(201);
    expect(transferRows()[0]).toMatchObject({ amountIn: 100, exchangeRate: 1, kind: 'INTERNAL' });
  });

  it.each([
    ['a rate of zero', { exchangeRate: 0 }],
    ['a negative rate', { exchangeRate: -13_000 }],
    ['a rate of a thousand million', { exchangeRate: 1e9 }],
    ['a rate that is not a number', { exchangeRate: 'abc' }],
  ])('%s is refused by the schema', async (_why, extra) => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, note: NOTE, ...extra });
    expect(res.status).toBe(400);
    expect(committed).toEqual([]);
  });

  it.each([
    ['zero', 0],
    ['a negative figure', -1_300_000],
  ])('an arriving amount of %s is refused by name', async (_why, amountIn) => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn, note: NOTE });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('AMOUNT_IN_INVALID');
    expect(committed).toEqual([]);
  });

  it('…and one that is not a number at all (NaN travels as null) is refused', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: Number.NaN, note: NOTE });
    expect(res.status).toBe(400);
    expect(committed).toEqual([]);
  });

  it('an arriving amount the books cannot hold is a 400, not the generic internal error', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1e11, note: NOTE });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('AMOUNT_IN_TOO_BIG');
    expect(body.error).not.toBe('حدث خطأ داخلي');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('a rate whose product the books cannot hold is a 400 too — it used to come back as the column overflowing', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 1_000_000_000, exchangeRate: 1_000_000, note: NOTE });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('AMOUNT_IN_TOO_BIG');
  });

  it('two amounts whose rate the column cannot keep are refused: a pair nobody meant', async () => {
    // 0.01 dollars for a million lira is a rate of 100,000,000 — eight digits before the point is all the column has.
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 0.01, amountIn: 1_000_000, note: NOTE });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('RATE_OUT_OF_RANGE');
    expect(committed).toEqual([]);
  });
});

describe('what the screen believed it was doing is checked against what the wallets are', () => {
  it('EXCHANGE is a kind the door accepts', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, note: NOTE, expectKind: 'EXCHANGE' });
    expect(res.status).toBe(201);
  });

  it.each(['INTERNAL', 'BETWEEN_STORES', 'BETWEEN_COUNTRIES'])('%s for an exchange is a 409 that names what it is', async (expectKind) => {
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, note: NOTE, expectKind });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'KIND_CHANGED', kind: 'EXCHANGE' });
    expect(body.error).toContain('صرف داخل البلد');
    expect(committed).toEqual([]);
  });

  it('an exchange believed to be one is a 409 when the wallets turn out to be one currency', async () => {
    const res = await post({ fromWalletId: USD.id, toWalletId: USD2.id, amountOut: 100, note: 'إيداع', expectKind: 'EXCHANGE' });
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe('INTERNAL');
  });

  it('a wallet to itself is still refused, and so is a wallet that is gone', async () => {
    const same = await post({ fromWalletId: USD.id, toWalletId: USD.id, amountOut: 100, note: NOTE });
    expect(same.status).toBe(400);
    delete wallets[SYP.id];
    const gone = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, note: NOTE });
    expect(gone.status).toBe(404);
    expect(committed).toEqual([]);
  });

  it('a stopped wallet is not found: the query asks for active ones only', async () => {
    await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, note: NOTE });
    for (const call of db.wallet.findFirst.mock.calls) {
      expect(call[0].where).toMatchObject({ companyId: 'co1', isActive: true });
    }
  });
});

describe('the two movements and the transfer row are one transaction', () => {
  it('written once, through the transaction client, in the order row → OUT → IN', async () => {
    await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, note: NOTE });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(committed.map((c) => c.kind)).toEqual(['transfer', 'movement', 'movement']);
    // nothing went around the transaction
    expect(db.walletTransfer.create).not.toHaveBeenCalled();
    expect(db.walletMovement.create).not.toHaveBeenCalled();
    // both movements point at the transfer they belong to
    expect(new Set(movementRows().map((m) => m.referenceId))).toEqual(new Set(['tr-1']));
    expect(new Set(movementRows().map((m) => m.referenceType))).toEqual(new Set(['TRANSFER']));
  });

  it('a failure on the arriving side rolls the whole transfer back: no row, no leaving movement, no audit line, and not a 201', async () => {
    failMovement = 2;
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, note: NOTE });
    expect(res.status).toBe(500);
    expect(committed).toEqual([]);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and so does a failure on the leaving side', async () => {
    failMovement = 1;
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, note: NOTE });
    expect(res.status).toBe(500);
    expect(committed).toEqual([]);
  });

  it('the audit line says how the exchange was given: a rate, the amount that arrived, or nothing', async () => {
    await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, exchangeRate: 13_000, note: NOTE });
    await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_290_000, note: NOTE });
    await post({ fromWalletId: USD.id, toWalletId: USD2.id, amountOut: 100, note: NOTE });
    const lines = logAudit.mock.calls.map((c) => c[0] as { newData: { entered: string } });
    expect(lines.map((l) => l.newData.entered)).toEqual(['RATE', 'AMOUNT_IN', 'NONE']);
    expect(lines[1]).toMatchObject({
      action: 'WALLET_TRANSFER', entity: 'WalletTransfer',
      newData: { kind: 'EXCHANGE', amountOut: 100, amountIn: 1_290_000, rate: 12_900 },
    });
  });

  it('whoever may not move money moves none', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission finance.cashbox'));
    const res = await post({ fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, note: NOTE });
    expect(res.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('finance.cashbox');
    expect(committed).toEqual([]);
  });
});

describe('a retry, or a second press, does not move the money twice', () => {
  const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const body = { transferId: ATTEMPT, fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000, note: NOTE };
  /** The sentence of the conflict: the id is taken by another deal. */
  const TAKEN = 'هالتحويل انسجّل من قبل بصفقة تانية — حدّث الصفحة وراجع قبل ما تعيد';

  it('the attempt’s id is the row’s own id, so the database enforces it', async () => {
    const res = await post(body);
    expect(res.status).toBe(201);
    expect(transferRows()[0].id).toBe(ATTEMPT);
  });

  it('the same attempt sent again finds its row and writes nothing', async () => {
    expect((await post(body)).status).toBe(201);
    const again = await post(body);
    expect(again.status).toBe(200);
    const said = await again.json();
    expect(said.replay).toBe(true);
    // the row comes back as numbers, not as the strings a decimal column would print
    expect(said.transfer).toMatchObject({ id: ATTEMPT, amountOut: 100, amountIn: 1_300_000, exchangeRate: 13_000 });
    // one transfer, one pair of movements, one transaction, one audit line
    expect(transferRows()).toHaveLength(1);
    expect(movementRows()).toHaveLength(2);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it('a retry still succeeds when a wallet has been stopped since: the transfer happened', async () => {
    await post(body);
    wallets[SYP.id] = { ...SYP, isActive: false };
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(transferRows()).toHaveLength(1);
  });

  it('…and so does one that gave a RATE, whose arriving amount is worked out from wallets that are now stopped', async () => {
    const byRate = { transferId: ATTEMPT, fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, exchangeRate: 13_000, note: NOTE };
    expect((await post(byRate)).status).toBe(201);
    wallets[SYP.id] = { ...SYP, isActive: false };
    wallets[USD.id] = { ...USD, isActive: false };
    const again = await post(byRate);
    expect(again.status).toBe(200);
    expect((await again.json()).replay).toBe(true);
    expect(transferRows()).toHaveLength(1);
  });

  it('two presses at the same moment: the database saw the second, and it is told the transfer exists', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
    // the first check saw nothing, the write lost the race, and the winner's row — the same deal — is there when it is read again
    db.walletTransfer.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: ATTEMPT, createdAt: new Date('2026-11-10T10:00:00Z'), fromWalletId: USD.id, toWalletId: SYP.id,
        amountOut: '100', amountIn: '1300000', exchangeRate: '13000', kind: 'EXCHANGE',
      });
    db.$transaction.mockRejectedValueOnce(conflict);
    const res = await post(body);
    expect(res.status).toBe(200);
    const said = await res.json();
    expect(said.replay).toBe(true);
    expect(said.transfer).toMatchObject({ amountOut: 100, amountIn: 1_300_000, exchangeRate: 13_000 });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('another company’s id is not even looked at: the replay query is scoped to this company', async () => {
    await post(body);
    expect(db.walletTransfer.findFirst.mock.calls[0][0]).toEqual({ where: { id: ATTEMPT, companyId: 'co1' } });
  });

  it('a caller with no id is as before: no replay query, no id in the row, two presses are two transfers', async () => {
    const plain = { fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, exchangeRate: 13_000, note: NOTE };
    await post(plain);
    await post(plain);
    expect(db.walletTransfer.findFirst).not.toHaveBeenCalled();
    expect(transferRows()).toHaveLength(2);
    for (const row of transferRows()) expect('id' in row).toBe(false);
  });

  it('an id that is not an id is refused', async () => {
    const res = await post({ ...body, transferId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(committed).toEqual([]);
  });

  it('any other database error is not swallowed into a success', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('boom', { code: 'P2034', clientVersion: 'test' });
    db.$transaction.mockRejectedValueOnce(conflict);
    const res = await post(body);
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
  });

  /*
   * THE SAME ID WITH ANOTHER DEAL IS NOT A RETRY.
   *
   * The money reviewer's scenario, which was answered 200 with `replay: true` and the OLD deal while the new one was
   * lost behind a «تم»: 100 USD → 1,300,000 SYP is written, but the answer takes 15 seconds and is lost; the person
   * changes the amount (or the wallet) and presses again with the same id. A replay is a success to repeat only for
   * the deal that was recorded — wallets and both amounts — and anything else under the id is a 409, with nothing
   * written and the first transfer left exactly as it was.
   */
  describe('the same id carrying ANOTHER deal is a conflict, and the first deal is left as it was', () => {
    const exactlyTheFirstDeal = () => {
      expect(transferRows()).toHaveLength(1);
      expect(transferRows()[0]).toMatchObject({ id: ATTEMPT, fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, amountIn: 1_300_000 });
      expect(movementRows().map((m) => m.amount)).toEqual([100, 1_300_000]);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(logAudit).toHaveBeenCalledTimes(1);
    };
    const refused = async (res: Response) => {
      expect(res.status).toBe(409);
      const said = await res.json();
      expect(said).toEqual({ error: TAKEN, code: 'TRANSFER_EXISTS' });
      exactlyTheFirstDeal();
    };

    it('the reviewer’s case: 100 USD recorded, then 200 under the same id — a 409, not «replay» of the 100', async () => {
      expect((await post(body)).status).toBe(201);
      await refused(await post({ ...body, amountOut: 200, amountIn: 2_600_000 }));
    });

    it('another destination wallet', async () => {
      await post(body);
      await refused(await post({ ...body, toWalletId: SYP_B.id }));
    });

    it('another source wallet, the direction turned round', async () => {
      await post(body);
      await refused(await post({ ...body, fromWalletId: SYP.id, toWalletId: USD.id, amountOut: 1_300_000, amountIn: 100 }));
    });

    it('the same wallets and amount going out, another amount arriving', async () => {
      await post(body);
      await refused(await post({ ...body, amountIn: 1_290_000 }));
    });

    it('the same wallets and amount arriving, another amount going out', async () => {
      await post(body);
      await refused(await post({ ...body, amountOut: 101 }));
    });

    it('a different RATE for the same wallets: the arriving amount it would give is compared, and it differs', async () => {
      const byRate = { transferId: ATTEMPT, fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, exchangeRate: 13_000, note: NOTE };
      expect((await post(byRate)).status).toBe(201);
      await refused(await post({ ...byRate, exchangeRate: 13_500 }));
    });

    it('a rate that gives the same arriving amount is the same deal — and so is the amount it gave, typed', async () => {
      const byRate = { transferId: ATTEMPT, fromWalletId: USD.id, toWalletId: SYP.id, amountOut: 100, exchangeRate: 13_000, note: NOTE };
      expect((await post(byRate)).status).toBe(201);
      for (const same of [byRate, { ...byRate, exchangeRate: undefined, amountIn: 1_300_000 }]) {
        const again = await post(same);
        expect(again.status).toBe(200);
        expect((await again.json()).replay).toBe(true);
      }
      expect(transferRows()).toHaveLength(1);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    it('one currency: the same amount is the same deal, another amount is not', async () => {
      const plain = { transferId: ATTEMPT, fromWalletId: USD.id, toWalletId: USD2.id, amountOut: 100, note: 'إيداع' };
      expect((await post(plain)).status).toBe(201);
      expect((await post(plain)).status).toBe(200);
      const other = await post({ ...plain, amountOut: 150 });
      expect(other.status).toBe(409);
      expect((await other.json()).code).toBe('TRANSFER_EXISTS');
      expect(transferRows()).toHaveLength(1);
      expect(transferRows()[0]).toMatchObject({ amountOut: 100, amountIn: 100 });
    });

    it('the NOTE is words, not money: a retry that mends it is the same transfer, and answers with the one recorded', async () => {
      await post(body);
      const again = await post({ ...body, note: 'صرف دولار — بعد التصحيح' });
      expect(again.status).toBe(200);
      const said = await again.json();
      expect(said.replay).toBe(true);
      expect(said.transfer.note).toBe(NOTE);
      exactlyTheFirstDeal();
    });

    it('the loser of a race with ANOTHER deal under the same id is refused, and is not answered with the winner’s row', async () => {
      const conflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      db.walletTransfer.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: ATTEMPT, createdAt: new Date('2026-11-10T10:00:00Z'), fromWalletId: USD.id, toWalletId: SYP.id,
          amountOut: '200', amountIn: '2600000', exchangeRate: '13000', kind: 'EXCHANGE',
        });
      db.$transaction.mockRejectedValueOnce(conflict);
      const res = await post(body);
      expect(res.status).toBe(409);
      const said = await res.json();
      expect(said).toEqual({ error: TAKEN, code: 'TRANSFER_EXISTS' });
      expect('transfer' in said).toBe(false);
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('…and so is the winner that went to ANOTHER pair of wallets', async () => {
      const conflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      db.walletTransfer.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: ATTEMPT, fromWalletId: USD.id, toWalletId: SYP_B.id, amountOut: '100', amountIn: '1300000', exchangeRate: '13000', kind: 'BETWEEN_STORES',
        });
      db.$transaction.mockRejectedValueOnce(conflict);
      const res = await post(body);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('TRANSFER_EXISTS');
    });
  });

  describe('an id that exists in ANOTHER company is a conflict, and nothing of it is said', () => {
    it('refused with the same sentence as any other conflict — no row, no amount, no wallet, no company', async () => {
      foreignIds = [ATTEMPT];
      const res = await post(body);
      expect(res.status).toBe(409);
      const said = await res.json();
      // exactly the two keys of every conflict: nothing that belongs to the row that holds the id
      expect(said).toEqual({ error: TAKEN, code: 'TRANSFER_EXISTS' });
      expect(JSON.stringify(said)).not.toMatch(/co2|other|1300000|replay|transfer"/);
      // nothing was written, nothing was audited
      expect(committed).toEqual([]);
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('both lookups for the id are scoped to THIS company, so the other company’s row is never read', async () => {
      foreignIds = [ATTEMPT];
      await post(body);
      const lookups = db.walletTransfer.findFirst.mock.calls.map((c: unknown[]) => c[0]);
      expect(lookups).toHaveLength(2);
      for (const q of lookups) expect(q).toEqual({ where: { id: ATTEMPT, companyId: 'co1' } });
    });

    it('and the other company is told the same about THIS company’s id', async () => {
      expect((await post(body)).status).toBe(201);
      requireContext.mockResolvedValue({ user: { id: 'u9', name: 'غريب' }, companyId: 'co2', storeId: 's9' });
      // (this fake's wallets answer to any company: what is asked here is only what the id check says about the row)
      const res = await post(body);
      expect([404, 409]).toContain(res.status);
      const said = await res.json();
      expect(JSON.stringify(said)).not.toMatch(/1300000|replay|"transfer"/);
      expect(transferRows()).toHaveLength(1);
    });
  });
});

describe('the list reads an exchange as what it was', () => {
  it('the kind is the one RECORDED, in words, and the amounts come out as numbers', async () => {
    db.walletTransfer.findMany.mockResolvedValue([
      {
        id: 't1', companyId: 'co1', fromWalletId: USD.id, toWalletId: SYP.id, kind: 'EXCHANGE',
        amountOut: '100', amountIn: '1300000', exchangeRate: '13000', note: NOTE, createdById: 'u1', createdAt: new Date('2026-11-10T10:00:00Z'),
      },
    ]);
    db.wallet = { ...db.wallet, findMany: vi.fn().mockResolvedValue([
      { id: USD.id, name: USD.name, currencyCode: 'USD', store: { name: 'متجر دمشق' } },
      { id: SYP.id, name: SYP.name, currencyCode: 'SYP', store: { name: 'متجر دمشق' } },
    ]) } as unknown as typeof db.wallet;
    // The list also reads which of the transfers were reversed (their legs): none here.
    db.walletMovement = { ...db.walletMovement, findMany: vi.fn().mockResolvedValue([]) } as unknown as typeof db.walletMovement;
    const res = await GET();
    expect(res.status).toBe(200);
    const { transfers } = await res.json();
    expect(transfers[0]).toMatchObject({ kindLabel: 'صرف داخل البلد', amountOut: 100, amountIn: 1_300_000, exchangeRate: 13_000 });
  });
});
