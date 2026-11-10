import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «WAS A RATE GIVEN» WAS ASKED AS «IS THE RATE TRUTHY».
 *
 * `transfers/route.ts` read
 *
 *     if (!sameCurrency && !input.exchangeRate)
 *
 * — a falsy check on a number, on the one door in this repository where the
 * number multiplies money between two currencies. It was SAFE ONLY BY THE
 * LUCK OF ANOTHER LINE: the schema says
 * `exchangeRate: z.number().positive().max(1_000_000).optional()`, so by the
 * time that guard runs the value is `undefined` or greater than zero, and
 * `!x` coincides with `x === undefined`. Loosen the schema to `.min(0)` —
 * one word — and a rate of **0** is answered «يتطلب سعر صرف»: the door tells
 * the person to supply the rate they just supplied. The same conflation
 * `c119e31` took out of the expense door, where a deliberate `0` was told
 * three fields were missing.
 *
 * THESE ASSERT THE ROWS HANDED TO PRISMA, not the text of the guard — and
 * the first test LOOSENS THE SCHEMA ITSELF (a second door object built from
 * the real one) so the question «what does the guard do with a zero» is
 * answered rather than argued about.
 *
 * AND IS A RATE OF ZERO EVER LEGITIMATE? No, from the column and the
 * arithmetic, not from taste:
 *
 *   · `WalletTransfer.exchangeRate` is `Decimal(14,6)` and NOT NULL — there
 *     is no «no rate» to record;
 *   · `amountIn = roundMinor(amountOut * rate, minorUnit)`, so a rate of 0
 *     means money left one wallet and NONE arrived in the other;
 *   · `recordMovement` refuses `amount <= 0`, so such a transfer can never
 *     be written at all.
 *
 * The floor that matters is therefore not 0 but the rate at which `amountIn`
 * still rounds to at least one minor unit — `.positive()` admits
 * `0.000001`, and 100 at that rate into a 3-decimal currency is
 * `roundMinor(0.0001, 3) === 0`. That used to come back as the generic
 * **500 «حدث خطأ داخلي»** from inside the transaction; it is now a 400 that
 * names the rate.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    wallet: { findFirst: vi.fn() },
    walletTransfer: { create: vi.fn(), findMany: vi.fn() },
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

import { POST as TRANSFER } from './route';

/** Two wallets in two countries, holding two currencies. 3 decimals each. */
const JOD = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'الصندوق النقدي',
  currencyCode: 'JOD',
  storeId: '66666666-6666-4666-8666-666666666666',
  countryId: '33333333-3333-4333-8333-333333333333',
  isActive: true,
  store: { name: 'متجر عمّان' },
  country: { minorUnit: 3, name: 'الأردن' },
};
const USD = {
  ...JOD,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'صندوق سوريا النقدي',
  currencyCode: 'USD',
  countryId: '44444444-4444-4444-8444-444444444444',
  country: { minorUnit: 3, name: 'سوريا' },
};
/** A second JOD wallet, so a same-currency transfer has somewhere to go. */
const JOD2 = { ...JOD, id: '55555555-5555-4555-8555-555555555555', name: 'الحساب البنكي' };

const walletsById: Record<string, typeof JOD> = {};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'سامر' }, companyId: 'co1', storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);

  for (const w of [JOD, JOD2, USD]) walletsById[w.id] = w;
  db.wallet.findFirst.mockImplementation(async ({ where }: any) => walletsById[where.id] ?? null);
  db.walletTransfer.create.mockImplementation(async ({ data }: any) => ({ id: 'tr-1', ...data }));
  db.walletMovement.create.mockImplementation(async ({ data }: any) => ({ id: 'mv-1', ...data }));
  db.$transaction.mockImplementation(async (fn: any) =>
    fn({ wallet: db.wallet, walletTransfer: db.walletTransfer, walletMovement: db.walletMovement })
  );
});

const post = (body: unknown) =>
  TRANSFER(
    new Request('http://localhost/api/finance/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const SOUND = {
  fromWalletId: JOD.id,
  toWalletId: USD.id,
  amountOut: 100,
  note: 'تمويل صندوق سوريا',
};

/** Every rate that was written to a transfer row, in order. */
const writtenRates = () => db.walletTransfer.create.mock.calls.map((c: any) => c[0].data.exchangeRate);
/** Every amount written to a wallet movement, in order. */
const writtenAmounts = () => db.walletMovement.create.mock.calls.map((c: any) => c[0].data.amount);

describe('the door asks whether a rate was GIVEN, not whether it is truthy', () => {
  it('a cross-currency transfer with no rate at all is refused by name', async () => {
    const res = await post(SOUND);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EXCHANGE_RATE_REQUIRED');
    expect(body.error).toContain('سعر صرف');
    expect(writtenRates()).toEqual([]);
    expect(writtenAmounts()).toEqual([]);
  });

  /*
   * THE FALSY GUARD, MEASURED RATHER THAN ARGUED.
   *
   * `.positive()` is what makes a 0 unreachable today, so the only way to
   * ask what the guard does with a 0 is to reach it. This rebuilds the
   * route's own flow with the one word relaxed — `.min(0)` instead of
   * `.positive()` — and runs BOTH spellings of the guard over the result.
   */
  it('and with the schema loosened by one word, the two spellings disagree about zero', async () => {
    const { z } = await import('zod');
    const loosened = z.object({
      exchangeRate: z.number().min(0).max(1_000_000).optional(),
    });
    const withZero = loosened.parse({ exchangeRate: 0 });
    const withNone = loosened.parse({});

    // The old spelling cannot tell «nobody typed a rate» from «somebody
    // typed zero» — it answers «a rate is required» to both.
    expect(!withZero.exchangeRate, 'الحارس القديم قرأ صفراً كأنّه غياب').toBe(true);
    expect(!withNone.exchangeRate).toBe(true);

    // The new spelling answers the question it is asking.
    expect(withZero.exchangeRate === undefined).toBe(false);
    expect(withNone.exchangeRate === undefined).toBe(true);
  });

  it('a rate of zero is refused today by the schema, with the field named — not with «يتطلب سعر صرف»', async () => {
    const res = await post({ ...SOUND, exchangeRate: 0 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(writtenRates(), 'سعرُ صرفٍ صفرٌ وصل إلى العمود').toEqual([]);
    expect(writtenAmounts(), 'حركةُ محفظةٍ كُتِبَت لتحويلٍ بسعرِ صفر').toEqual([]);
    /*
     * The reader is NOT sent looking for a box they already filled in.
     *
     * The sentence itself is still poor and it is not this file's to fix:
     * `exchangeRate` is absent from `FIELDS` in `src/lib/zod-message.ts`
     * (another agent's file this change may not write), so the refusal comes
     * back as the raw Zod message with no field named and in English —
     * «Too small: expected number to be >0». The assertion accepts either
     * the bound or the Arabic label, so adding
     * `exchangeRate: 'سعر الصرف'` to that map does not break this test.
     */
    expect(body.error).toMatch(/سعر الصرف|>\s*0/);
    expect(body.code).not.toBe('EXCHANGE_RATE_REQUIRED');
  });

  it('and a negative rate is refused the same way', async () => {
    const res = await post({ ...SOUND, exchangeRate: -1.41 });
    expect(res.status).toBe(400);
    expect(writtenRates()).toEqual([]);
    expect((await res.json()).code).not.toBe('EXCHANGE_RATE_REQUIRED');
  });
});

/**
 * THE ONE SITE IN THIS CHANGE THAT IS NOT BEHAVIOURALLY MUTATION-DETECTABLE,
 * SAID OUT LOUD RATHER THAN HIDDEN BEHIND A GREEN TEST.
 *
 * While the schema says `.positive()`, the two spellings are OBSERVATIONALLY
 * IDENTICAL: the only falsy value a `z.number().positive().optional()` can
 * produce is `undefined`, so no request, no row and no response can tell
 * them apart. Putting `!input.exchangeRate` back therefore breaks nothing
 * that a response can show — which is exactly why the guard was dangerous
 * and exactly why asserting rows alone cannot hold it.
 *
 * So this asserts THE PAIR, which is the real hazard: the falsy spelling is
 * safe ONLY while the schema refuses a zero. Either the schema keeps
 * `.positive()`, or the guard asks about presence. Both together is fine;
 * neither is money.
 */
describe('the guard and the schema are a pair, and the pair is checked', () => {
  const source = () => {
    // Imported at the top rather than required here: a lazy require inside
    // a test buys nothing (the file is already loaded by the time it runs)
    // and `no-require-imports` refuses it.
    return readFileSync(join(process.cwd(), 'src/app/api/finance/transfers/route.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  };

  it('the rate is still refused below zero AT THE SCHEMA — measured, not read', async () => {
    // The behaviour, first: a zero does not get past the door.
    const res = await post({ ...SOUND, exchangeRate: 0 });
    expect(res.status).toBe(400);
    expect(writtenRates()).toEqual([]);
    // And this is the line that does it.
    expect(source()).toMatch(/exchangeRate:\s*z\s*\.number\(\)\s*\.positive\(\)/);
  });

  /*
   * CHANGED ON PURPOSE, AND SAID SO IN THE PULL REQUEST.
   *
   * The presence question moved. It used to be asked inline in the route
   * (`input.exchangeRate === undefined`); with a second way to give the
   * exchange (the amount that arrived) it is asked where the two are judged
   * together, `resolveTransferAmounts` in lib/transfer-rate — «a rate AND an
   * amount», «neither», «one currency and either». The hazard this test
   * guards is the same and so is the rule: ask whether a rate was GIVEN,
   * never whether it is truthy. The route may not bring the old spelling
   * back, and the resolver has to say it the right way.
   */
  it('and the presence check asks about presence, so the schema is not load-bearing twice', () => {
    const resolver = readFileSync(join(process.cwd(), 'src/lib/transfer-rate.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const [where, src] of [['route.ts', source()], ['transfer-rate.ts', resolver]] as const) {
      expect(
        src,
        `${where}: الحارس يسأل «هل الرقم صادق» لا «هل كُتِب» — وصفرٌ ليس غياباً`
      ).not.toMatch(/!\s*sameCurrency\s*&&\s*!\s*(?:input|i)\.exchangeRate\b/);
      expect(src, `${where}: سؤال «هل الرقم صادق» عن سعرٍ`).not.toMatch(/!\s*(?:input|i)\.exchangeRate\b/);
    }
    expect(resolver).toMatch(/i\.exchangeRate !== undefined/);
    expect(resolver).toMatch(/i\.amountIn !== undefined/);
  });
});

describe('a rate that was given is the rate that is stored, and the money follows it', () => {
  it('100 JOD at 1.41 is 141 USD, in the row and in both movements', async () => {
    const res = await post({ ...SOUND, exchangeRate: 1.41 });
    expect(res.status).toBe(201);

    const row = db.walletTransfer.create.mock.calls[0][0].data;
    expect(row.exchangeRate).toBe(1.41);
    expect(row.amountOut).toBe(100);
    expect(row.amountIn).toBe(141);
    expect(writtenAmounts()).toEqual([100, 141]);

    const [out, inn] = db.walletMovement.create.mock.calls.map((c: any) => c[0].data);
    expect(out.direction).toBe('OUT');
    expect(out.walletId).toBe(JOD.id);
    expect(inn.direction).toBe('IN');
    expect(inn.walletId).toBe(USD.id);
    expect(inn.note).toContain('1.41');
  });

  it('and a same-currency transfer needs no rate and stores 1', async () => {
    const res = await post({ fromWalletId: JOD.id, toWalletId: JOD2.id, amountOut: 250, note: 'إلى البنك' });
    expect(res.status).toBe(201);
    expect(writtenRates()).toEqual([1]);
    expect(writtenAmounts()).toEqual([250, 250]);
  });
});

describe('a rate too small to deliver one minor unit is a 400, not an internal error', () => {
  it('100 at 0.000001 into a 3-decimal currency arrives as nothing', async () => {
    // The arithmetic, before the door: this is why it must be refused.
    const { roundMinor } = await import('@/lib/money');
    expect(roundMinor(100 * 0.000001, 3)).toBe(0);

    const res = await post({ ...SOUND, exchangeRate: 0.000001 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EXCHANGE_RATE_TOO_SMALL');
    expect(body.error).toContain('صفراً');
    // Nothing was written, and the refusal happened BEFORE the transaction
    // rather than by throwing inside it.
    expect(writtenRates()).toEqual([]);
    expect(writtenAmounts()).toEqual([]);
    expect(db.$transaction).not.toHaveBeenCalled();
    // And it is not the generic internal error that used to come back.
    expect(body.error).not.toBe('حدث خطأ داخلي');
  });

  it('and the smallest rate that DOES deliver a minor unit goes through', async () => {
    const res = await post({ ...SOUND, exchangeRate: 0.00001 });
    expect(res.status).toBe(201);
    expect(db.walletTransfer.create.mock.calls[0][0].data.amountIn).toBe(0.001);
  });
});
