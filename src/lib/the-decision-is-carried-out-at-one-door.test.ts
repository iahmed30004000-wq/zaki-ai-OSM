import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * A DECISION ON A DIFFERENCE HAS ONE DOOR WHERE IT BECOMES MONEY, AND IT IS THE APPROVAL.
 *
 * The doors that RECORD a decision (the single one and the bulk one) write the row and a note and settle nothing.
 * The library that knows the rules writes nothing at all. The approval carries the decisions out — and only the
 * two that settle (a clean row, and «اعتُمد رقم الشركة»), only after looking at every order again.
 *
 * Read from the source on purpose: a name is not a behaviour, but these are the exact words whose appearance in
 * the wrong file is the defect (the same money written from a second place).
 */

const approval = () => stripComments(repoFile('src/app/api/finance/statements/[id]/route.ts'));
const single = () => stripComments(repoFile('src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts'));
const bulk = () => stripComments(repoFile('src/app/api/finance/statements/[id]/decisions/route.ts'));
const rules = () => stripComments(repoFile('src/lib/settlement-decisions.ts'));

const MONEY_WORDS = ['walletMovement', 'recordMovement', 'COURIER_SETTLEMENT', 'settlementStatus', 'collectedAmount', 'markPayableForOrders'];

describe('the doors that record a decision settle nothing', () => {
  it.each([
    ['the single door', single],
    ['the bulk door', bulk],
  ])('%s names no money word', (_name, read) => {
    const src = read();
    expect(src.length).toBeGreaterThan(1500);
    for (const word of MONEY_WORDS) expect(src, `${word} في باب يسجّل البتّ`).not.toContain(word);
  });

  it('and both ask the settlement permission, and write the same internal note the same way', () => {
    for (const read of [single, bulk]) {
      const src = read();
      expect(src).toContain("requirePermission('settlement.review')");
      expect(src).toMatch(/tx\.orderNote\.create\(\{/);
      expect(src).toMatch(/kind: 'internal'/);
      expect(src).toMatch(/decisionNoteBody\(/);
      expect(src).toMatch(/decisionData\(/);
      expect(src).toMatch(/FOR UPDATE/);
    }
  });

  it('the library of rules writes no row at all — it reads, and returns', () => {
    const writes = [...rules().matchAll(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => m[0]);
    expect(writes).toEqual([]);
    for (const word of ['recordMovement', 'COURIER_SETTLEMENT']) expect(rules()).not.toContain(word);
  });
});

describe('the approval carries out exactly the two that settle', () => {
  it('settles the clean rows and the rows answered «اعتُمد رقم الشركة» — never «رقمنا», never «قيد المراجعة», never an undecided row', () => {
    const src = approval();
    expect(src).toMatch(/const matched = matches\.filter\(\(m\) => m\.result === 'MATCHED' && m\.orderId\);/);
    expect(src).toMatch(/m\.result === 'MISMATCHED' && m\.resolution === 'ACCEPTED_COURIER' && m\.orderId/);
    // «رقمنا» appears for the claim it leaves open and for the select that reads what was paid on one — never as a row to settle.
    const settlingAt = src.indexOf('const settling = ');
    const claimsAt = src.indexOf('const claims = matches.filter');
    expect(settlingAt).toBeGreaterThan(0);
    expect(src.slice(settlingAt, settlingAt + 400)).not.toContain('OURS_STANDS');
    expect(src.slice(settlingAt, settlingAt + 400)).not.toContain('UNDER_REVIEW');
    expect(claimsAt).toBeGreaterThan(settlingAt);
    expect(src).not.toContain("'UNDER_REVIEW'");
  });

  it('writes SETTLED in one place only, and only as the conditional claim built from the re-check', () => {
    const src = approval();
    expect([...src.matchAll(/settlementStatus: 'SETTLED'/g)]).toHaveLength(1);
    expect(src).toMatch(/where: claim\.where, data: \{ settlementStatus: 'SETTLED' \}/);
    expect(src).toMatch(/stillSettlableWhere\(companyId, cleanIds\)/);
    expect(src).toMatch(/stillAcceptableWhere\(companyId, acceptedIds, zeroLineIds\)/);
    // The claim must take every order it asked for, or the approval stops.
    expect(src).toMatch(/taken\.count !== claim\.ids\.length\) throw new OrdersChanged\(/);
  });

  it('the re-check comes BEFORE commission is made payable and before any order is changed or delivered', () => {
    const src = approval();
    const claim = src.indexOf("data: { settlementStatus: 'SETTLED' }");
    expect(claim).toBeGreaterThan(0);
    expect(claim).toBeLessThan(src.indexOf('await markPayableForOrders('));
    expect(claim).toBeLessThan(src.indexOf('const inFlight = await tx.order.findMany('));
    expect(claim).toBeLessThan(src.indexOf("action: 'DELIVERED_BY_STATEMENT'"));
  });

  it('and the amount written is the one place’s: the gross of the row, plus what an earlier claim row paid', () => {
    const src = approval();
    expect(src).toContain('const collectedOf = (orderId: string)');
    expect(src).toContain('paidGross(row?.order?.settlementMatches ?? [], country.minorUnit)');
    expect(src).not.toMatch(/collectedAmount: amountOf/);
  });

  it('the names of an order that stopped the approval are read AFTER the rollback, outside the transaction', () => {
    const src = approval();
    const caught = src.indexOf('if (e instanceof OrdersChanged)');
    expect(caught).toBeGreaterThan(src.indexOf('}, { timeout: 30_000 });'));
    expect(src.slice(caught, caught + 500)).toContain('await db.order.findMany(');
    expect(src.slice(caught, caught + 500)).toContain('NOT: e.where');
  });
});
