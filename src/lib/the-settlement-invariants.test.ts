import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Section 7c runs one real parcel through the DOOR as well as the matcher,
 * so the two arithmetics are pinned to each other rather than described as
 * agreeing. That needs the door's writes mocked; nothing else in this file
 * touches the database.
 */
const { doorDb, consumeOrderStock } = vi.hoisted(() => ({
  consumeOrderStock: vi.fn(async (..._a: unknown[]) => ({ taken: 0, short: 0, alreadyDone: false })),
  doorDb: {
    order: { findFirst: vi.fn(), update: vi.fn() },
    orderItem: { update: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderNote: { create: vi.fn() },
    customer: { update: vi.fn() },
    deliveryAttempt: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'attempt-1', attemptNumber: 1 })),
    },
  },
}));
vi.mock('./db', () => ({ db: doorDb }));
vi.mock('./stock-consumption', () => ({ consumeOrderStock }));

import { repoFile, stripComments } from './guard-source';
import { recordPartialDelivery } from './partial-delivery';
import type { SettlementFacts } from './settlement';
import { doorMoney, expectedAmountFor, parseStatementRows, SWEEP_LIMIT } from './settlement';
import { approvalRefusal, rematchRefusal } from './settlement-gates';

beforeEach(() => {
  vi.clearAllMocks();
  doorDb.order.update.mockResolvedValue({});
  doorDb.orderItem.update.mockResolvedValue({});
  doorDb.orderActivity.create.mockResolvedValue({});
  doorDb.orderNote.create.mockResolvedValue({});
  doorDb.customer.update.mockResolvedValue({});
  doorDb.deliveryAttempt.findFirst.mockResolvedValue(null);
  doorDb.deliveryAttempt.create.mockResolvedValue({ id: 'attempt-1', attemptNumber: 1 });
});

/**
 * تشطيب ١ — STAGE 1: THE COMMITMENTS LEDGER, settlement and collection.
 *
 * «Statement : what the courier says it owes. File hash, no duplicate import.
 *  Receipt   : what actually arrived. MANY lines, each with its own wallet,
 *              currency and amount…
 *  Matching  : runs on demand AFTER the receipt. Single key: merchant
 *              reference, then courier barcode. NEVER phone.»
 *
 * Three sequential entities, and the sequence is the invariant. All of it
 * holds, with two refinements where the code is better than the wording —
 * and one half-built key, found here and fixed on 2026-10-02.
 */

describe('1 · the statement is what the courier CLAIMS, and it imports once', () => {
  it('the total is read from the file, and the hash is unique by constraint', () => {
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model CourierStatement {'));
    const body = m.slice(0, m.indexOf('\n}'));
    expect(body).toMatch(/totalAmount\s+Decimal\s+@db\.Decimal\(14, 3\)/);
    // A CONSTRAINT, not a lookup. A check-then-insert loses the race, and the
    // race here is two operators uploading the same file at once.
    expect(body).toMatch(/@@unique\(\[companyId, fileHash\]\)/);
  });

  it('and the import door hashes the bytes and refuses a repeat', () => {
    const route = stripComments(repoFile('src/app/api/finance/statements/route.ts'));
    expect(route).toMatch(/const hash = fileHash\(fileBytes\)/);
    expect(route).toMatch(/where: \{ companyId, fileHash: hash \}/);
  });

  it('and a line states the collected amount and the fee apart from the net', () => {
    // The net alone cannot say WHY it is short: a collection that came in
    // light and a fee higher than agreed look identical in one number.
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model StatementLine {'));
    const body = m.slice(0, m.indexOf('\n}'));
    for (const col of ['amount', 'collected', 'fee']) expect(body, col).toMatch(new RegExp(`\\n\\s*${col}\\s`));
  });

  /**
   * AND «WHAT THE COURIER CLAIMS» IS WHAT THE CELL SAYS, SIGN INCLUDED.
   *
   * This section said what a statement IS and what its columns are, and
   * nothing about how a figure gets out of a cell — and for as long as that
   * was so, the reader strip `/[^\d.-]/` threw the brackets off `(50)` and
   * called a fifty-unit DEDUCTION a fifty-unit CREDIT. Ten
   * `STATEMENT_IMPORTED` audit rows exist, so this is the one path in the
   * repository that has run on real money.
   *
   * The two statements below are the gap closed. The figures and the matcher
   * arithmetic are measured in `a-bracketed-negative-is-a-deduction.test.ts`.
   */
  it('and a bracketed figure is the NEGATIVE it is, not its own opposite', () => {
    const { rows, error } = parseStatementRows(
      ['المرجع', 'الصافي'],
      [['ORD-1', '9'], ['ORD-2', '(50)']]
    );
    expect(error).toBeUndefined();
    // THE FIGURE, not a label. Fifty we owe them.
    expect(rows.map((r) => r.amount)).toEqual([9, -50]);
    // And the strip that made that +50 is not in the file under any spelling.
    const src = stripComments(repoFile('src/lib/settlement.ts'));
    expect(src, 'الحشوُ عاد').not.toMatch(/replace\(\/\[\^\\d\.-\]\/g, ''\)/);
    expect(src, 'قارئٌ رابعَ عشرَ').toMatch(/readStatementFigure\(text\)/);
  });

  it('and an unreadable cell refuses the FILE by name — there is no fifth result', () => {
    const { rows, error } = parseStatementRows(
      ['المرجع', 'الصافي'],
      [['ORD-1', '9'], ['ORD-2', '3,500']]
    );
    // The row as the sheet numbers it, and the cell quoted back.
    expect(error).toContain('السطر 3');
    expect(error).toContain('«3,500»');
    // ALL OR NOTHING, and the reason is §6: `SettlementMatch.result` has
    // four words and not one of them means «we could not read this line».
    // Letting the readable line through would make `totalAmount` 9 instead
    // of the courier's own claim, and `receiptGap` would then demand a
    // written explanation for money nobody ever owed.
    expect(rows).toEqual([]);
    const schema = repoFile('prisma/schema.prisma');
    const match = schema.slice(schema.indexOf('model SettlementMatch {'));
    expect(match.slice(0, match.indexOf('\n}'))).not.toMatch(/UNREADABLE/);
  });
});

describe('2 · the receipt is what ARRIVED — many lines, each its own wallet', () => {
  it('and the wallet is a required relation, restricted on delete', () => {
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model StatementReceipt {'));
    const body = m.slice(0, m.indexOf('\n}'));
    expect(body).toMatch(/walletId\s+String\b/);
    expect(body).toMatch(/currencyCode\s+String\b/);
    expect(body).toMatch(/amount\s+Decimal/);
    // A wallet that money landed in cannot be deleted out from under it.
    expect(body).toMatch(/wallet\s+Wallet\s+@relation\(fields: \[walletId\], references: \[id\], onDelete: Restrict\)/);
  });

  it('and the rate is stored when the wallet currency differs', () => {
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model StatementReceipt {'));
    expect(m.slice(0, m.indexOf('\n}'))).toMatch(/exchangeRate\s+Decimal\?/);
  });
});

describe('3 · the gap between claimed and received needs a written reason', () => {
  const gap = (over: Partial<{ gap: number; needsExplanation: boolean; unconvertible: number }> = {}) => ({
    status: 'MATCHED',
    approvedAt: null,
    gap: { gap: 120, needsExplanation: true, unconvertible: 0, ...over },
    explanation: null,
  });

  it('and approval is refused while it is unexplained', () => {
    const r = approvalRefusal(gap() as never);
    expect(r).not.toBeNull();
    expect(r!.code).toBe('GAP_REQUIRES_EXPLANATION');
    // And the refusal names the figure, so the person writing the
    // explanation is not asked to go and find out what they are explaining.
    expect(r!.error).toMatch(/120/);
  });

  it('and allowed once somebody writes one', () => {
    expect(approvalRefusal({ ...gap(), explanation: 'الشركة حوّلت الباقي الأسبوع القادم' } as never)).toBeNull();
  });

  it('and a receipt nobody can convert blocks approval in its own right', () => {
    // Its amount is in neither «وصل فعلاً» nor the gap, so the gap it leaves
    // behind is a number about nothing. Counted apart and named, never
    // dropped silently into a total that then looks short.
    const r = approvalRefusal({ ...gap({ needsExplanation: false, unconvertible: 50 }) } as never);
    expect(r).not.toBeNull();
  });

  it('and the receipts are converted into the STATEMENT’s currency first', () => {
    const s = stripComments(repoFile('src/lib/settlement.ts'));
    expect(s).toMatch(/receiptsInStatementCurrency\(/);
    // Never a bare SUM across mixed currencies labelled with one of them.
    expect(s).not.toMatch(/_sum: \{ amount: true \}/);
  });
});

describe('4 · matching runs ON DEMAND, and only after a receipt', () => {
  it('the route refuses when no receipt exists yet', () => {
    const route = stripComments(repoFile('src/app/api/finance/statements/[id]/match/route.ts'));
    expect(route).toMatch(/_count: \{ select: \{ receipts: true \} \}/);
    expect(route).toMatch(/if \(statement\._count\.receipts === 0\)/);
  });

  it('and never re-runs over an approved statement', () => {
    const r = rematchRefusal({ status: 'APPROVED', approvedAt: new Date() });
    expect(r).not.toBeNull();
    expect(r!.code).toBe('ALREADY_APPROVED');
    // But a statement that is merely matched may be matched again: the
    // operator fixes a barcode and asks the question a second time.
    expect(rematchRefusal({ status: 'MATCHED', approvedAt: null })).toBeNull();
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 5 · «Single key: merchant reference, then courier barcode. NEVER phone.»
 *
 * The code reverses the ORDER, and writes its reason beside the decision: a
 * barcode is assigned by the courier, and the statement is the courier's own
 * file, written in the courier's own identifiers. The merchant reference is
 * the fallback for a courier who echoes ours back.
 *
 * Both halves of the rule that matter hold — one key at a time, never the
 * phone. The reversal is pinned here as the deliberate choice it is.
 *
 * AND THE BARCODE LOOKUP WAS UNSCOPED, fixed 2026-10-02. There is no unique
 * index on `trackingNumber`, and none could mean anything across couriers:
 * two companies issuing numeric sequences collide as a matter of course. A
 * statement from one courier could therefore attach a line to an order
 * shipped with another — and `findFirst` has no `orderBy`, so which one it
 * took was not even decided. The sweep in the same function already asked
 * the question correctly.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('5 · the key is one identifier at a time, and never the phone', () => {
  const src = stripComments(repoFile('src/lib/settlement.ts'));

  it('the barcode is tried first, and the merchant reference is the fallback', () => {
    expect(src).toMatch(/const byBarcode = line\.barcode/);
    expect(src).toMatch(/const matchedByBarcode = byBarcode !== null;/);
    // `??`, so the second lookup only happens when the first found nothing.
    expect(src).toMatch(/byBarcode \?\?\s*\(line\.merchantRef/);
  });

  it('and the match records WHICH key found it, not which the line carries', () => {
    expect(src).toMatch(/matchedBy: matchedByBarcode \? 'BARCODE' : 'MERCHANT_REF'/);
  });

  it('and the phone is never a key anywhere in matching', () => {
    const fn = src.slice(src.indexOf('export async function runMatching('));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).not.toMatch(/phone/i);
    // The reason is written down, because this is the rule somebody "helps"
    // by adding a phone fallback the first time a barcode is missing.
    expect(repoFile('src/lib/settlement.ts')).toMatch(/Never the phone/);
  });

  it('and the barcode lookup is scoped to the courier whose statement it is', () => {
    const fn = src.slice(src.indexOf('const byBarcode = line.barcode'));
    const where = fn.slice(0, fn.indexOf('select:'));
    expect(where).toMatch(/deliveryProviderId: statement\.deliveryProviderId/);
    expect(where).toMatch(/trackingNumber: line\.barcode/);
  });

  it('and the merchant-reference lookup is NOT scoped, on purpose', () => {
    // `@@unique([companyId, merchantRef])` makes it name one order whoever is
    // carrying the parcel. Scoping it would break the match for an order that
    // changed couriers after we sent it.
    const schema = repoFile('prisma/schema.prisma');
    const order = schema.slice(schema.indexOf('model Order {'));
    expect(order.slice(0, order.indexOf('\n}'))).toMatch(/@@unique\(\[companyId, merchantRef\]\)/);
    const fn = src.slice(src.indexOf('(line.merchantRef'));
    const where = fn.slice(0, fn.indexOf('select:'));
    expect(where).toMatch(/merchantRef: line\.merchantRef/);
    expect(where).not.toMatch(/deliveryProviderId/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 6 · «three queues: matched, mismatched, missing» — DELIVERED AS FOUR, and
 * the fourth is the point.
 *
 * «Missing» has two directions and they are different problems: a line the
 * courier listed that we have no order for (MISSING_IN_SYSTEM — our data, or
 * someone else's parcel) and an order we delivered that no statement mentions
 * (MISSING_IN_STATEMENT — the courier left it out, which is money). One queue
 * holding both would make the operator sort them by eye.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('6 · the queues, and the actions on them', () => {
  it('the four results are the schema’s own vocabulary', () => {
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model SettlementMatch {'));
    expect(m.slice(0, m.indexOf('\n}'))).toMatch(
      /result\s+String \/\/ MATCHED \| MISMATCHED \| MISSING_IN_STATEMENT \| MISSING_IN_SYSTEM/
    );
  });

  it('and a difference stays OPEN until somebody answers it', () => {
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model SettlementMatch {'));
    const body = m.slice(0, m.indexOf('\n}'));
    // Null resolution IS the open queue — not a separate flag that can
    // disagree with it.
    expect(body).toMatch(/resolution\s+String\?/);
    expect(body).toMatch(/ACCEPTED_COURIER \| OURS_STANDS/);
    expect(body).toMatch(/resolvedById\s+String\?/);
  });

  it('and the fee is compared in its own right, not folded into the net', () => {
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model SettlementMatch {'));
    const body = m.slice(0, m.indexOf('\n}'));
    for (const col of ['expectedFee', 'statementFee', 'feeDifference']) {
      expect(body, col).toMatch(new RegExp(`\\n\\s*${col}\\s`));
    }
    // And a returned parcel is charged no fee, so its fee is not compared.
    expect(stripComments(repoFile('src/lib/settlement.ts'))).toMatch(
      /const feeWrong = feeDifference !== null && feeDifference !== 0 && expected > 0;/
    );
  });

  it('and «missing» is asked of the WHOLE record, not of this statement', () => {
    // A courier issues overlapping statements. Flagging everything THIS one
    // did not match flags most of the shop — measured at 1,754 false rows
    // from a single 120-line statement.
    const src = stripComments(repoFile('src/lib/settlement.ts'));
    expect(src).toMatch(/statement: \{ companyId \},/);
    expect(src).toMatch(/OR: \[\{ barcode: \{ in: refs \} \}, \{ merchantRef: \{ in: refs \} \}\]/);
  });

  it('and the sweep’s cap is never silent', () => {
    // «none are missing» and «none of the first five thousand» read the same
    // and are not the same sentence.
    expect(SWEEP_LIMIT).toBe(5000);
    const src = stripComments(repoFile('src/lib/settlement.ts'));
    expect(src).toMatch(/if \(delivered\.length === SWEEP_LIMIT\) outcome\.sweepTruncated = true;/);
  });
});

/**
 * A fixture for the rule. Every field of `SettlementFacts` is required —
 * see section 7 — so a test about one of them names it and the rest stand
 * at their honest default: one line nobody counted.
 */
function facts(
  over: Partial<SettlementFacts> & { shippingStatus: string; totalAmount: number }
): SettlementFacts {
  return {
    collectedAmount: null,
    deliveryFee: 0,
    priceIncludesDelivery: false,
    items: [
      {
        quantity: 1, freeQuantity: 0, unitPrice: over.totalAmount,
        discountShare: 0, lineTotal: over.totalAmount, deliveredQty: null,
      },
    ],
    // No upsell unless a test says so — and a test about the upsell says so
    // in the one place the money can come from.
    addOns: [],
    returnReceipt: null,
    ...over,
  };
}

/** JOD. Three decimal places, and nothing here rounds to any other number. */
const JOD = 3;

describe('7 · a partial delivery is measured against what actually happened', () => {
  it('uses the collected amount when one was recorded', () => {
    const partial = expectedAmountFor(
      facts({
        shippingStatus: 'PARTIALLY_DELIVERED',
        totalAmount: 100,
        collectedAmount: 40,
        deliveryFee: 5,
      }),
      JOD
    );
    // 40 collected, less the 5 the courier keeps.
    expect(partial).toBe(35);
  });

  /**
   * ─────────────────────────────────────────────────────────────────────
   * THIS BLOCK USED TO PIN THE DEFECT. It said «but a REAL partial has no
   * collected amount, and falls back to the total», and it was right: the
   * rule was `(collectedAmount ?? totalAmount) − deliveryFee`, and nothing
   * writes `collectedAmount` on a partial delivery. `partial-delivery.ts`
   * leaves it null deliberately and correctly — «the money is the courier's
   * statement's to write» — so the `??` fell through to the whole order on
   * every partial in the database.
   *
   * Found by walking one real order through every door on 2026-10-02, which
   * is the one thing no unit test here could do. FIXED the same day: the
   * rule now reads `OrderItem.deliveredQty`, which is the fact the door
   * DOES record, and `partial-delivery.ts`'s own claim that settlement
   * «reads the delivered lines rather than the original total» became true
   * instead of aspirational.
   *
   * What follows is the measured order, as a guard that the fix HOLDS. A
   * ledger must not keep describing a defect that is gone.
   * ─────────────────────────────────────────────────────────────────────
   */
  describe('and the order this was measured on: 3 × 12, a 2.5 fee, two taken', () => {
    /** The COD the customer was quoted: 36 goods + the 2.5 fee. */
    const TOTAL = 38.5;
    const measured = (over: Partial<SettlementFacts> = {}): SettlementFacts => ({
      shippingStatus: 'PARTIALLY_DELIVERED',
      totalAmount: TOTAL,
      collectedAmount: null,
      deliveryFee: 2.5,
      priceIncludesDelivery: false,
      items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: 2 }],
      // No upsell on the order this was measured on. The one that HAS an
      // upsell is a block of its own, below.
      addOns: [],
      returnReceipt: null,
      ...over,
    });

    it('the courier owes 24 — the two units taken, and the fee is his', () => {
      // At the door: 24 goods + 2.5 fee = 26.5. He keeps the 2.5.
      expect(expectedAmountFor(measured(), JOD)).toBe(24);
    });

    it('and the old rule demanded 36 — twelve he never had', () => {
      const asItWas = Number(TOTAL) - 2.5;
      expect(asItWas).toBe(36);
      expect(expectedAmountFor(measured(), JOD)).not.toBe(asItWas);
      // The exact figure the collection screen used to ask the operator to
      // take off a rep, and the exact size of every false MISMATCHED.
      expect(asItWas - expectedAmountFor(measured(), JOD)).toBe(12);
    });

    it('and the courier’s RETURN fee comes out too, when one was charged', () => {
      // `ReturnReceipt.courierFeeAmount` was written by the returns desk and
      // read by nothing, while the courier deducted it in reality — so a
      // statement stated net of it read as short by exactly that fee.
      // 26.5 at the door, less the 2.5 delivery fee, less the 1.5 return fee.
      expect(
        expectedAmountFor(measured({ returnReceipt: { courierFeeAmount: 1.5 } }), JOD)
      ).toBe(22.5);
    });

    it('and the whole parcel taken is still its total less the fee', () => {
      const whole = measured({
        shippingStatus: 'DELIVERED',
        items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: 3 }],
      });
      // 36 goods + 2.5 at the door = the COD, and the fee is his: 36.
      expect(expectedAmountFor(whole, JOD)).toBe(TOTAL - 2.5);
      // AND THIS ASSERTION PROVES ALMOST NOTHING ON ITS OWN. `TOTAL` is
      // 38.5, which is exactly 36 + 2.5, so «total − fee» and «the lines
      // + the fee − the fee» are the same number here and the sentence is
      // true by construction. The block below is the one that can fail.
      expect(TOTAL - 2.5).toBe(36);
    });

    /*
     * ─────────────────────────────────────────────────────────────────────
     * AND A WHOLE DELIVERY WHOSE TOTAL IS **NOT** THE SUM OF ITS LINES.
     *
     * The guard above was the whole of the full-delivery case, and it was
     * vacuous: 38.5 − 2.5 and 36 + 2.5 − 2.5 are both 36, so reading the
     * total and reading the lines gave the same answer and nothing could
     * tell them apart. Five dinars of upsell money went through it without
     * a mark — measured on 2026-10-02, on a FULL delivery, after the
     * partial-delivery fix above.
     *
     *   `Order.totalAmount` is not the sum of the lines. The thank-you-page
     *   upsell increments it and writes an `OrderAddOn` row and ZERO
     *   `OrderItem` rows, so a figure rebuilt from the lines alone cannot
     *   contain it.
     *
     *     3 × 12 = 36 of lines, an upsell of 12, a 2.5 fee → total 50.5
     *     the customer pays 50.5, the courier keeps 2.5    → he owes 48
     *     the lines alone give 36 + 2.5 − 2.5              → 36
     *
     *   Twelve dinars written off in silence with `difference: 0`, the
     *   order marked SETTLED, and an honest statement of 48 reported
     *   MISMATCHED. The same defect, one door down, is
     *   `src/app/api/ops/shipment-cod-addons.test.ts:3-12`.
     *
     * So this fixture's total is INDEPENDENT of its lines, and every wrong
     * answer is a different number from the right one.
     * ─────────────────────────────────────────────────────────────────────
     */
    describe('and an UPSOLD parcel, whose total no sum of lines can reach', () => {
      /** 36 of lines, 12 of upsell, a 2.5 fee: the COD is 50.5. */
      const upsold = (over: Partial<SettlementFacts> = {}): SettlementFacts =>
        measured({
          shippingStatus: 'DELIVERED',
          totalAmount: 50.5,
          items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: 3 }],
          addOns: [{ quantity: 1, price: 12 }],
          ...over,
        });

      it('the courier owes 48 — the lines, the upsell, and the fee is his', () => {
        expect(expectedAmountFor(upsold(), JOD)).toBe(48);
      });

      it('and the order AS IT WAS MEASURED: a 5 upsell, 43.5 total, 41 owed', () => {
        // The figures from the measurement itself, kept beside a fixture
        // that can fail. 36 of lines, an upsell accepted at 5, a 2.5 fee.
        const over = { totalAmount: 43.5, addOns: [{ quantity: 1, price: 5 }] };
        expect(expectedAmountFor(upsold(over), JOD)).toBe(41);
        expect(expectedAmountFor(upsold({ ...over, addOns: [] }), JOD)).toBe(36);
        // The five dinars `collect/route.ts` recorded as a movement of 36
        // with `difference: 0`, then marked SETTLED, on no screen at all.
        expect(41 - 36).toBe(5);
      });

      it('and the lines alone say 36 — the twelve this guard exists to catch', () => {
        const linesOnly = expectedAmountFor(upsold({ addOns: [] }), JOD);
        expect(linesOnly).toBe(36);
        expect(expectedAmountFor(upsold(), JOD) - linesOnly).toBe(12);
      });

      it('and the right answer is not reachable from the lines, so this can fail', () => {
        // The shape this audit has caught seven times: a fixture whose
        // total happens to equal its lines proves nothing. Here the three
        // candidate answers are three different numbers.
        expect(Number(upsold().totalAmount) - 2.5).toBe(48);
        expect(36 + 2.5 - 2.5).toBe(36);
        expect(expectedAmountFor(upsold(), JOD)).not.toBe(36);
      });

      it('and a PARTIAL of it keeps the upsell — the upsell has no line to refuse', () => {
        // Two of three taken: 24 of lines, the whole 12 upsell, the whole
        // 2.5 fee at the door, and the courier keeps the fee.
        const partial = upsold({
          shippingStatus: 'PARTIALLY_DELIVERED',
          items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: 2 }],
        });
        expect(expectedAmountFor(partial, JOD)).toBe(36);
      });

      it('and nothing taken collects no upsell either — it goes back in the parcel', () => {
        // Asserted on the door's own reconstruction rather than through
        // the status, because RETURNED short-circuits at the top of the
        // rule and would answer 0 whatever this branch did.
        const door = doorMoney(
          upsold({
            items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: 0 }],
          }),
          JOD
        );
        expect(door.anythingTaken).toBe(false);
        expect(door.addOns).toBe(0);
        expect(door.collected).toBe(0);
      });

      it('and a door that never spoke reads the total, which carries the upsell', () => {
        // A courier feed wrote DELIVERED and counted no units. The total is
        // the only fact there is, and it is the RIGHT one here — the old
        // rule was never short on this branch.
        const feed = upsold({
          items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: null }],
        });
        expect(expectedAmountFor(feed, JOD)).toBe(48);
      });
    });

    /*
     * ─────────────────────────────────────────────────────────────────────
     * AND A LOST FILS, which the old rule did not have.
     *
     * `OrderItem.unitPrice`, `discountShare` and `lineTotal` are all
     * `Decimal(12,2)` (`prisma/schema.prisma:1898-1900`) while JOD has
     * minorUnit **3** (`prisma/seed.ts:435`), and `orders/route.ts:446`
     * writes `unitPrice = lineTotal / quantity`.
     *
     *   one line, 3 units, line total 10.000 → `unitPrice` stored 3.33
     *   3 × 3.33 = 9.990, and the customer paid 10.000
     *
     * Ten fils gone on every line that does not divide, and a false
     * MISMATCHED for exactly that. `lineTotal` — the figure `computeCod`
     * itself wrote — was sitting in the same row and was not selected.
     * Reading `totalAmount` at full precision, as the rule used to, did not
     * have this; reading the lines does unless it reads the right column.
     * ─────────────────────────────────────────────────────────────────────
     */
    describe('and a line that does not divide by its quantity', () => {
      /** 3 units for 10.000, a 2.5 fee: the COD is 12.5. */
      const indivisible = (deliveredQty: number): SettlementFacts =>
        measured({
          shippingStatus: deliveredQty === 3 ? 'DELIVERED' : 'PARTIALLY_DELIVERED',
          totalAmount: 12.5,
          items: [{ quantity: 3, freeQuantity: 0, unitPrice: 3.33, discountShare: 0, lineTotal: 10, deliveredQty }],
        });

      /** What multiplying the stored 2-place unit price back out gives. */
      const fromUnitPrice = (units: number) => Number((units * 3.33).toFixed(JOD));

      it('a whole delivery is 10.000, not the 9.990 the unit price would give', () => {
        expect(expectedAmountFor(indivisible(3), JOD)).toBe(10);
        expect(fromUnitPrice(3)).toBe(9.99);
        expect(expectedAmountFor(indivisible(3), JOD)).not.toBe(fromUnitPrice(3));
      });

      it('and two of the three are 6.667, not 6.660', () => {
        expect(expectedAmountFor(indivisible(2), JOD)).toBe(6.667);
        expect(fromUnitPrice(2)).toBe(6.66);
      });

      it('and the fils is exactly what the false MISMATCHED was worth', () => {
        // A courier who hands over the 10.000 he collected is reported
        // short by this much, for ever, on every indivisible line.
        expect(expectedAmountFor(indivisible(3), JOD) - fromUnitPrice(3)).toBeCloseTo(0.01, 5);
      });
    });

    it('and a statement figure, once it lands, still wins over the lines', () => {
      // The courier said 30 arrived. That is the fact to reconcile against,
      // whatever the door counted — the difference is the thing to explain.
      expect(expectedAmountFor(measured({ collectedAmount: 30 }), JOD)).toBe(27.5);
    });
  });

  it('THE rule survives: the delivery fee is charged in full on a partial', () => {
    // «The courier travelled to that door whether one line was taken or all
    // of them.» Prorating it would make every partial quietly cheaper.
    const oneOfThree = facts({
      shippingStatus: 'PARTIALLY_DELIVERED',
      totalAmount: 38.5,
      deliveryFee: 2.5,
      items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: 1 }],
    });
    // 12 goods + the WHOLE 2.5 at the door, and he keeps the 2.5.
    expect(expectedAmountFor(oneOfThree, JOD)).toBe(12);
  });

  it('and a fee already inside the price is not charged a second time', () => {
    const included = facts({
      shippingStatus: 'PARTIALLY_DELIVERED',
      totalAmount: 36,
      deliveryFee: 2.5,
      priceIncludesDelivery: true,
      items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: 2 }],
    });
    // 24 at the door, the 2.5 already inside it, and he keeps it: 21.5.
    expect(expectedAmountFor(included, JOD)).toBe(21.5);
  });

  it('and gift units are stock, never money', () => {
    const gift = facts({
      shippingStatus: 'PARTIALLY_DELIVERED',
      totalAmount: 24,
      deliveryFee: 0,
      // Two paid at 12 and one gift; the customer took all three.
      items: [{ quantity: 2, freeQuantity: 1, unitPrice: 12, discountShare: 0, lineTotal: 24, deliveredQty: 3 }],
    });
    expect(expectedAmountFor(gift, JOD)).toBe(24);
  });

  it('and the stored discount share is divided back out per unit', () => {
    // «Discount is allocated across lines proportionally and STORED per
    // line. Without this, partial returns refund the wrong amount.»
    const discounted = facts({
      shippingStatus: 'PARTIALLY_DELIVERED',
      totalAmount: 33,
      deliveryFee: 0,
      // 3 × 12 = 36 less a 3 share, so 11 a unit. Two taken: 22.
      items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 3, lineTotal: 33, deliveredQty: 2 }],
    });
    expect(expectedAmountFor(discounted, JOD)).toBe(22);
  });

  it('and it rounds by the order’s own minor unit, never a global rule', () => {
    // A third of a dinar a unit. JOD has three places; a currency with two
    // must not be given the dinar's answer.
    const thirds = facts({
      shippingStatus: 'PARTIALLY_DELIVERED',
      totalAmount: 1,
      deliveryFee: 0,
      items: [{ quantity: 3, freeQuantity: 0, unitPrice: 1 / 3, discountShare: 0, lineTotal: 1, deliveredQty: 2 }],
    });
    expect(expectedAmountFor(thirds, JOD)).toBe(0.667);
    expect(expectedAmountFor(thirds, 2)).toBe(0.67);
    expect(expectedAmountFor(thirds, 0)).toBe(1);
  });

  it('and nothing but the statement import writes that column', () => {
    const pd = repoFile('src/lib/partial-delivery.ts');
    expect(pd).toMatch(/NOT collectedAmount\. See the note at the top of this file/);
    const route = stripComments(repoFile('src/app/api/ops/tracking/deliver/route.ts'));
    // The door records it in the AUDIT LOG only — never on the order.
    const update = route.slice(route.indexOf('logAudit('));
    expect(update).toMatch(/collectedAmount: outcome\.collectedAmount/);
    // The statement's write moved, unchanged, into the close of the matching (2/11, «افصل المطابقة عن التحصيل»).
    expect(stripComments(repoFile('src/lib/statement-close.ts'))).toMatch(
      /data: \{ collectedAmount: collected, version: \{ increment: 1 \} \}/
    );
  });

  it('and falls back to the total only when the DOOR never spoke', () => {
    // A courier feed or a manual transition writes DELIVERED and counts no
    // units: `deliveredQty` is null on every line, and the order's own total
    // is the only fact there is. Reading the lines here would say zero.
    expect(
      expectedAmountFor(facts({ shippingStatus: 'DELIVERED', totalAmount: 100, deliveryFee: 5 }), JOD)
    ).toBe(95);
  });

  it('and a zero collection is honoured, not treated as absent', () => {
    // `collectedAmount: 0` is a fact: the customer took the parcel and paid
    // nothing. A falsy check here would bill the courier the whole total.
    expect(
      expectedAmountFor(
        facts({ shippingStatus: 'PARTIALLY_DELIVERED', totalAmount: 100, collectedAmount: 0 }),
        JOD
      )
    ).toBe(0);
  });

  it('and a returned parcel nobody was charged for expects nothing at all', () => {
    for (const shippingStatus of ['RETURNED', 'RETURN_REQUESTED']) {
      expect(
        expectedAmountFor(facts({ shippingStatus, totalAmount: 100, deliveryFee: 5 }), JOD),
        shippingStatus
      ).toBe(0);
      // Not negative zero, which a money column would carry as a lie. The
      // `-returnFee` below goes through `roundMinor`, and this is the
      // measurement that says it comes back out positive.
      expect(
        Object.is(expectedAmountFor(facts({ shippingStatus, totalAmount: 100 }), JOD), -0),
        shippingStatus
      ).toBe(false);
    }
  });

  it('but the return LEG still costs what the courier charged for it', () => {
    /*
     * MEASURED ON THIS DATABASE, which is what settled it. Of seven return
     * receipts, the only three carrying a non-zero fee — `ORD-2026-0033`,
     * `-0043`, `-0051` — are every one of them RETURNED, and this branch
     * returned a flat 0 before reading the column four lines below. So the
     * figure was written ONLY where it was never read, and 4.50 owed to the
     * courier had no trace in any expectation.
     *
     * The boundary made no sense either: `partial-delivery.ts` stamps
     * RETURNED when the customer kept nothing, so keeping one cheap unit of
     * three could already produce a negative while keeping none produced
     * exactly 0 — the same fee, two answers, either side of one keystroke.
     */
    for (const shippingStatus of ['RETURNED', 'RETURN_REQUESTED']) {
      expect(
        expectedAmountFor(
          facts({
            shippingStatus,
            totalAmount: 36,
            deliveryFee: 2.5,
            returnReceipt: { courierFeeAmount: 1.5 },
          }),
          JOD
        ),
        shippingStatus
      ).toBe(-1.5);
    }
  });

  it('and the outbound fee is NOT charged on top of it — the trip was not made', () => {
    // 2.5 to deliver was never earned: the parcel came back. Only the return
    // leg is owed, so the answer is -1.5 and never -4.
    const e = expectedAmountFor(
      facts({
        shippingStatus: 'RETURNED',
        totalAmount: 36,
        deliveryFee: 2.5,
        returnReceipt: { courierFeeAmount: 1.5 },
      }),
      JOD
    );
    expect(e).toBe(-1.5);
    expect(e).not.toBe(-4);
  });

  it('and a returned parcel the door never spoke for is still not billed its total', () => {
    /*
     * THE SHORT-CIRCUIT IS NOT CEREMONY, and this is why it stays. A courier
     * feed can set RETURNED and count nothing, leaving every `deliveredQty`
     * null — and the general path below falls back to `totalAmount` when the
     * door never spoke. Removing the branch to «let the arithmetic handle
     * it» would expect the whole 36 back from a parcel on our own shelf.
     */
    const e = expectedAmountFor(
      facts({
        shippingStatus: 'RETURNED',
        totalAmount: 36,
        deliveryFee: 2.5,
        returnReceipt: { courierFeeAmount: 1.5 },
        items: [
          { quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: null },
        ],
      }),
      JOD
    );
    expect(e).toBe(-1.5);
    expect(e).not.toBe(36);
  });

  it('and the partial is swept for too, or a courier could omit every one', () => {
    const src = stripComments(repoFile('src/lib/settlement.ts'));
    expect(src).toMatch(/shippingStatus: \{ in: \['DELIVERED', 'PARTIALLY_DELIVERED'\] \}/);
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * 7b · AND THE WRONG CALL CANNOT BE WRITTEN.
 *
 * The defect above was not an arithmetic slip. It was a SIGNATURE: the rule
 * accepted an order with no lines, every field after the first optional, so
 * three doors selected four columns each and all three got a plausible
 * wrong number. Fixing the arithmetic without fixing the signature leaves
 * the next door free to make the same mistake.
 * ───────────────────────────────────────────────────────────────────── */
describe('7b · the rule cannot be called without the facts it needs', () => {
  it('no field of SettlementFacts is optional — a door that forgot does not compile', () => {
    const src = repoFile('src/lib/settlement.ts');
    const iface = src.slice(src.indexOf('export interface SettlementFacts {'));
    const body = iface.slice(0, iface.indexOf('\n}'));
    for (const field of [
      'shippingStatus',
      'totalAmount',
      'collectedAmount',
      'deliveryFee',
      'priceIncludesDelivery',
      'items',
      // The upsell money. It was absent from the shape entirely, which is
      // why a whole delivery of an upsold order came out five dinars short
      // with nothing to compile against.
      'addOns',
      'returnReceipt',
    ]) {
      expect(body, field).toMatch(new RegExp(`\\n\\s*${field}:`));
      // `items?:` is how the old shape let every caller skip the lines.
      expect(body, `${field} must not be optional`).not.toMatch(new RegExp(`\\n\\s*${field}\\?:`));
    }
  });

  it('and an empty items array throws instead of guessing from the total', () => {
    // The one way left to get the old answer by accident: satisfy the
    // compiler with `items: []` without asking the database for them.
    expect(() =>
      expectedAmountFor(facts({ shippingStatus: 'DELIVERED', totalAmount: 100, items: [] }), JOD)
    ).toThrow(/no lines/);
  });

  it('and the minor unit is a parameter, so nothing rounds globally', () => {
    const src = stripComments(repoFile('src/lib/settlement.ts'));
    expect(src).toMatch(/export function expectedAmountFor\(order: SettlementFacts, minorUnit: number\): number/);
    // The matcher no longer rounds the rule's answer a second time.
    expect(src).not.toMatch(/roundMinor\(expectedAmountFor\(/);
  });

  it('and all three doors spread the ONE select, rather than listing columns', () => {
    // Listing them by hand is how `items` came to be missing from all three
    // at once. There is one select, and it is the shape of the facts.
    for (const file of [
      'src/lib/settlement.ts',
      'src/app/api/ops/tracking/route.ts',
      'src/app/api/ops/tracking/collect/route.ts',
    ]) {
      const src = stripComments(repoFile(file));
      expect(src, file).toMatch(/\.\.\.SETTLEMENT_ORDER_SELECT/);
    }
    // And the select really does carry the lines and the return receipt.
    const settlement = stripComments(repoFile('src/lib/settlement.ts'));
    const sel = settlement.slice(settlement.indexOf('export const SETTLEMENT_ORDER_SELECT'));
    const body = sel.slice(0, sel.indexOf('} as const'));
    expect(body).toMatch(/deliveredQty: true/);
    // `lineTotal` is the figure `computeCod` wrote. Without it the rule
    // multiplies a 2-place `unitPrice` back out and loses a fils a line.
    expect(body).toMatch(/lineTotal: true/);
    // And the upsell, which has no `OrderItem` row at all.
    expect(body).toMatch(/addOns: \{ select: \{ quantity: true, price: true \} \}/);
    expect(body).toMatch(/returnReceipt: \{ select: \{ courierFeeAmount: true \} \}/);
  });

  it('and every matcher call site passes the minor unit it was given', () => {
    const src = stripComments(repoFile('src/lib/settlement.ts'));
    const calls = (src.match(/(?<!function )expectedAmountFor\([^)]*\)/g) ?? []).filter(
      (c) => !c.includes('SettlementFacts')
    );
    // Two: the line match and the «they left it out» sweep.
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toMatch(/,\s*minorUnit\)$/);
  });

  it('and the two routes round by the COUNTRY’s minor unit, not by three', () => {
    for (const file of ['src/app/api/ops/tracking/route.ts', 'src/app/api/ops/tracking/collect/route.ts']) {
      const src = stripComments(repoFile(file));
      expect(src, file).toMatch(/expectedAmountFor\([^)]*country\.minorUnit\)/);
    }
  });

  it('and the tracking screen is sent the figure, not the lines to build it from', () => {
    // The rule needs every unit of every parcel. The screen prints one
    // number — so the lines feed the rule and stay off the wire.
    //
    // REPORTED, NOT FIXED: `addOns` joined the select on 2026-10-02 and is
    // NOT in this destructure, so two fields a row — `quantity`, `price` —
    // now reach the browser unread. That route is another agent's file this
    // hour; the edit is one identifier, `addOns: _addOns,`, and the pattern
    // below already accepts it.
    const src = stripComments(repoFile('src/app/api/ops/tracking/route.ts'));
    expect(src).toMatch(
      /const \{ items: _items, returnReceipt: _returnReceipt,(?: addOns: _addOns,)? \.\.\.o \} = order;/
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * 7c · THE DOOR'S FIGURE AND THE MATCHER'S ARE THE SAME ARITHMETIC.
 *
 * `partial-delivery.ts` computes what the customer handed over and RETURNS
 * it, for the screen to show as what we expect to be paid. `settlement.ts`
 * computes the same quantity from the stored lines, for the matcher. Two
 * computations of one fact, in two files, is how the first gap opened —
 * each file was right on its own.
 *
 * So the same parcel is run through BOTH and the two answers are compared.
 * If somebody changes one of them, this fails rather than a rep's wallet.
 * ───────────────────────────────────────────────────────────────────── */
describe('7c · the door and the matcher agree on what the customer paid', () => {
  /** 3 × 12 with a 2.5 fee — the order this was all measured on. */
  const doorOrder = {
    id: 'o1',
    orderNumber: 'JO-2026-0001',
    shippingStatus: 'OUT_FOR_DELIVERY',
    deliveryFee: 2.5,
    priceIncludesDelivery: false,
    customerId: 'cust1',
    deliveredAt: null,
    returnedAt: null,
    deliveryProviderId: 'dp1',
    settlementStatus: 'PENDING_COLLECTION',
    addOns: [],
    items: [{ id: 'i1', productId: 'p1', productName: 'كريم', quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36 }],
  };

  for (const taken of [0, 1, 2, 3]) {
    it(`${taken} of 3 taken: the door's collectedAmount is the matcher's door figure`, async () => {
      doorDb.order.findFirst.mockResolvedValue(doorOrder);

      const outcome = await recordPartialDelivery(doorDb as never, {
        companyId: 'c1', orderId: 'o1', lines: [{ itemId: 'i1', deliveredQty: taken }], minorUnit: JOD, userId: 'u1',
      });

      // The matcher reads the lines the door just wrote, and no statement
      // has spoken yet — so its expectation is the door's figure, net of
      // the fee the courier keeps.
      const written = doorDb.orderItem.update.mock.calls.at(-1)?.[0]?.data?.deliveredQty;
      expect(written).toBe(taken);

      const expected = expectedAmountFor(
        facts({
          shippingStatus: outcome.status,
          totalAmount: 38.5,
          deliveryFee: 2.5,
          items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: written }],
        }),
        JOD
      );

      // Nothing taken is a return, and a return expects nothing — which is
      // also what the door's own figure less the waived fee comes to.
      const net = outcome.status === 'RETURNED' ? 0 : outcome.collectedAmount - 2.5;
      expect(expected).toBe(net);
    });
  }

  /**
   * AND THE UPSELL, WHICH IS WHERE THE TWO CAME APART THE SECOND TIME.
   *
   * The door read the lines and the matcher read the lines, and they agreed
   * — on a figure that was missing the thank-you-page money, because
   * neither selected `OrderAddOn`. Two implementations agreeing is not the
   * same as one implementation: they are the same function now, and this
   * runs the upsold parcel through both ends anyway, because what the door
   * WRITES still has to be what the matcher READS.
   */
  for (const taken of [1, 2, 3]) {
    it(`${taken} of 3 taken with a 12 upsell: both doors carry the upsell`, async () => {
      doorDb.order.findFirst.mockResolvedValue({ ...doorOrder, addOns: [{ quantity: 1, price: 12 }] });

      const outcome = await recordPartialDelivery(doorDb as never, {
        companyId: 'c1', orderId: 'o1', lines: [{ itemId: 'i1', deliveredQty: taken }], minorUnit: JOD, userId: 'u1',
      });

      // 12 a unit for what was taken, plus the whole 12 upsell, plus the
      // whole 2.5 fee: the door's figure says so in two named parts.
      expect(outcome.deliveredValue).toBe(taken * 12);
      expect(outcome.addOnValue).toBe(12);
      expect(outcome.collectedAmount).toBe(taken * 12 + 12 + 2.5);

      const written = doorDb.orderItem.update.mock.calls.at(-1)?.[0]?.data?.deliveredQty;
      const expected = expectedAmountFor(
        facts({
          shippingStatus: outcome.status,
          totalAmount: 50.5,
          deliveryFee: 2.5,
          addOns: [{ quantity: 1, price: 12 }],
          items: [{ quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 36, deliveredQty: written }],
        }),
        JOD
      );
      expect(expected).toBe(outcome.collectedAmount - 2.5);
    });
  }
});
