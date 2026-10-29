import { describe, expect, it } from 'vitest';
import {
  DIFFERENCE_RESULTS,
  differencesByPerson,
  isDifference,
  isNotMentioned,
  isOpen,
  MIN_SETTLED_ORDERS,
  MISSING_RESULTS,
  RESOLUTIONS,
  RESOLUTION_AR,
  RESOLUTION_MEANING,
  shortfall,
} from './settlement-difference';

/**
 * «بس بضل الطلب معلّم» — and the two answers are not the same answer.
 *
 * Accepting the courier's figure settles the money at what arrived.
 * Insisting on ours does not settle it at all: the parcel waits for their
 * correction. A rule that treated them as one would quietly book every
 * disputed dinar as received.
 */

const m = (over: Partial<Parameters<typeof isOpen>[0]> = {}) => ({
  result: 'MISMATCHED',
  resolution: null,
  ...over,
});

describe('which rows are a question at all', () => {
  it('a clean match asks nothing', () => {
    expect(isDifference({ result: 'MATCHED' })).toBe(false);
    expect(isOpen(m({ result: 'MATCHED' }))).toBe(false);
  });

  /*
   * REWRITTEN (كلمات الشركة والأصفار). It said «a mismatch, a parcel they left out, and one we do not have
   * are all questions» and pinned all three as differences. Only the first is a difference in MONEY: the
   * other two have ONE figure each, so «رقمنا / رقمهم» has nothing to choose between, and counting them
   * put a parcel nobody had paid for in the per-person tally as a discount somebody gave. They are lists of
   * things to chase or to link, answered on the order (see not-mentioned.test.ts).
   */
  it('only a mismatch is a difference in money — a parcel one side lacks is not', () => {
    expect(isDifference({ result: 'MISMATCHED' })).toBe(true);
    for (const result of ['MISSING_IN_STATEMENT', 'MISSING_IN_SYSTEM']) {
      expect(isDifference({ result }), result).toBe(false);
      expect(isOpen({ result, resolution: null }), `${result} is never an open question at approval`).toBe(false);
    }
  });

  it('and the two missing kinds are named apart, so a gate cannot count them by accident', () => {
    expect(DIFFERENCE_RESULTS).toEqual(['MISMATCHED']);
    expect([...MISSING_RESULTS]).toEqual(['MISSING_IN_STATEMENT', 'MISSING_IN_SYSTEM']);
    expect(isNotMentioned({ result: 'MISSING_IN_STATEMENT' })).toBe(true);
    expect(isNotMentioned({ result: 'MISSING_IN_SYSTEM' })).toBe(false);
    expect(isNotMentioned({ result: 'MISMATCHED' })).toBe(false);
  });

  it('the count of what is still undecided leaves the missing rows out', () => {
    const rows = [
      { result: 'MATCHED', resolution: null },
      { result: 'MISMATCHED', resolution: null },
      { result: 'MISMATCHED', resolution: 'OURS_STANDS' },
      { result: 'MISSING_IN_STATEMENT', resolution: null },
      { result: 'MISSING_IN_STATEMENT', resolution: null },
      { result: 'MISSING_IN_SYSTEM', resolution: null },
    ];
    expect(rows.filter(isOpen)).toHaveLength(1);
  });

  it('and a question stops being open once it is answered, not before', () => {
    expect(isOpen(m())).toBe(true);
    for (const resolution of RESOLUTIONS) {
      expect(isOpen(m({ resolution })), resolution).toBe(false);
    }
  });

  it('both answers are named, and both say what they do to the money', () => {
    for (const r of RESOLUTIONS) {
      expect(RESOLUTION_AR[r]).toBeTruthy();
      expect(RESOLUTION_MEANING[r].length).toBeGreaterThan(30);
      // Neither may be read as «this never happened»: the order stays marked.
      expect(RESOLUTION_MEANING[r]).toContain('معلَّماً');
    }
  });
});

describe('shortfall — signed the way a shop reads it', () => {
  /**
   * The row stores `statement − expected`. A screen that printed that raw
   * would show a parcel the courier paid two short as «-2», which reads as
   * «we owe them two».
   */
  it('is positive when the courier kept money back', () => {
    expect(shortfall({ expectedAmount: 20, statementAmount: 18, difference: -2 })).toBe(2);
  });

  it('and negative when they handed over more than expected', () => {
    expect(shortfall({ expectedAmount: 20, statementAmount: 23, difference: 3 })).toBe(-3);
  });

  it('falls back to the two amounts when the difference was never stored', () => {
    expect(shortfall({ expectedAmount: 20, statementAmount: 17, difference: null })).toBe(3);
  });

  it('and says nothing rather than zero when a side is missing', () => {
    // A parcel on no statement has no «their figure». Zero would read as
    // «they agreed exactly», which is the opposite of what happened.
    expect(shortfall({ expectedAmount: 17, statementAmount: null, difference: null })).toBeNull();
  });
});

describe('counting the differences against the person who handled the order', () => {
  const rows = [
    { personId: 'sara', settledOrders: 120, differences: 14, accepted: 12, acceptedValue: 37.5 },
    { personId: 'omar', settledOrders: 60, differences: 2, accepted: 0, acceptedValue: 0 },
    { personId: 'new', settledOrders: 3, differences: 1, accepted: 1, acceptedValue: 2 },
  ];

  it('states a rate for whoever has enough orders behind it', () => {
    const [top] = differencesByPerson(rows);
    expect(top.personId).toBe('sara');
    expect(top.rate).toBeCloseTo(0.12, 2);
    expect(top.open).toBe(2);
    expect(top.why).toContain('120');
  });

  /**
   * AND WITHHOLDS IT FOR SOMEBODY WITH THREE ORDERS.
   *
   * One difference out of three is 33%, and it is 33% of nothing. The
   * counts are still shown — they are facts — and the row says why there is
   * no share beside them.
   */
  it('and withholds it below the floor, with the reason in words', () => {
    const fresh = differencesByPerson(rows).find((p) => p.personId === 'new')!;
    expect(fresh.rate).toBeNull();
    expect(fresh.differences).toBe(1);
    expect(fresh.why).toContain(String(MIN_SETTLED_ORDERS));
  });

  it('ranks by the money given away, because that is what the owner is reading for', () => {
    const order = differencesByPerson(rows).map((p) => p.personId);
    expect(order[0]).toBe('sara');
    expect(order.indexOf('omar')).toBeGreaterThan(order.indexOf('new'));
  });

  it('never reports more answered than there were questions', () => {
    const [p] = differencesByPerson([
      { personId: 'x', settledOrders: 50, differences: 2, accepted: 5, acceptedValue: 1 },
    ]);
    expect(p.open).toBe(0);
  });
});
