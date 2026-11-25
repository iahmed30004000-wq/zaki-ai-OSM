import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';
import { isOpenLine, isParkableLine, mayOnlyBeParked, parkableLineWhere } from '@/lib/statement-open-lines';

/**
 * «ركّن كل السطور بلا طلب» IS THE SINGLE DOOR'S «قيد المراجعة», WRITTEN ONCE FOR MANY LINES — never a copy of it.
 *
 * Read from the source on purpose: the defect would be a second writer of an answer (its own data shape, its own five-character
 * rule) that drifts from the single door, or a money word in a door whose label says «park».
 */
const door = () => stripComments(repoFile('src/app/api/finance/statements/[id]/park-unlinked/route.ts'));

const MONEY_WORDS = [
  'walletMovement', 'recordMovement', 'COURIER_SETTLEMENT', 'settlementStatus', 'collectedAmount', 'markPayableForOrders',
  'commission', 'expense', 'orderNote', 'tx.order.', 'inventory',
];

describe('the park door', () => {
  it('names no money, order, note, stock or commission word', () => {
    const src = door();
    expect(src.length).toBeGreaterThan(1000);
    for (const w of MONEY_WORDS) expect(src, w).not.toContain(w);
  });

  it('writes the answer with the single door’s writer and asks the single door’s rule — it keeps none of its own', () => {
    const src = door();
    expect(src).toMatch(/decisionData\(\{ resolution: PARKED, note, userId: user\.id \}\)/);
    expect(src).toMatch(/decisionKind\(\)/);
    expect(src).toMatch(/explanationOf\(s\) !== null, EXPLANATION_SENTENCE/);
    // no rule of its own for the length of a reason, and no field of the row named by hand
    expect(src).not.toMatch(/\.length\s*[<>]=?\s*\d/);
    expect(src).not.toMatch(/resolutionNote:|resolvedById:|resolvedAt:/);
    expect(src).not.toMatch(/'UNDER_REVIEW'/);
  });

  it('asks «مراجعة المطابقات», locks the statement before it reads the stamp, and says the one closed sentence', () => {
    const src = door();
    expect(src).toContain("requirePermission('settlement.review')");
    expect(src.indexOf('FOR UPDATE')).toBeLessThan(src.indexOf('isMatchingClosed(statement)'));
    expect(src).toContain('closedStatementRefusal()');
    // the write repeats it
    expect(src).toMatch(/matchingClosedAt: null/);
    expect(src).toMatch(/appliedAt: null/);
  });

  it('is all or none: the write must take every row it read', () => {
    expect(door()).toMatch(/written\.count !== rows\.length/);
  });
});

describe('which rows — one rule for the screen and the door', () => {
  const cases = [
    { result: 'MISSING_IN_SYSTEM', orderId: null, resolution: null },
    { result: 'MISSING_IN_SYSTEM', orderId: 'o1', resolution: null },
    { result: 'MISSING_IN_SYSTEM', orderId: null, resolution: 'UNDER_REVIEW' },
    { result: 'MISSING_IN_SYSTEM', orderId: null, resolution: 'OURS_STANDS' },
    { result: 'MISMATCHED', orderId: null, resolution: null },
    { result: 'MISMATCHED', orderId: 'o1', resolution: null },
    { result: 'MISSING_IN_STATEMENT', orderId: 'o1', resolution: null },
    { result: 'EXCLUDED', orderId: 'o1', resolution: null },
    { result: 'MATCHED', orderId: 'o1', resolution: null },
  ];

  it('the screen’s count takes exactly the first', () => {
    expect(cases.map(isParkableLine)).toEqual([true, false, false, false, false, false, false, false, false]);
  });

  it('it is the single door’s «may only be parked» AND «still a question»', () => {
    for (const c of cases) expect(isParkableLine(c)).toBe(mayOnlyBeParked(c) && isOpenLine(c));
  });

  it('the filter says the same three things', () => {
    expect(parkableLineWhere()).toEqual({ result: 'MISSING_IN_SYSTEM', orderId: null, resolution: null });
    const fits = (c: (typeof cases)[number]) =>
      Object.entries(parkableLineWhere()).every(([k, v]) => (c as Record<string, unknown>)[k] === v);
    expect(cases.map(fits)).toEqual(cases.map(isParkableLine));
  });
});
