import { describe, expect, it } from 'vitest';
import {
  BULK_LIMIT,
  COMING_BACK,
  DECISIONS,
  DECISION_AR,
  DECISION_MATRIX,
  DELIVERED_STATES,
  IN_FLIGHT,
  MIN_EXPLANATION,
  claimOf,
  claimsFromRows,
  decisionData,
  decisionMatrix,
  decisionNoteBody,
  explanationOf,
  paidGross,
  stateGroup,
  stillAcceptableWhere,
  stillSettlableWhere,
  wordGroupKey,
  type DecisionFacts,
} from './settlement-decisions';
import { shortfall } from './settlement-difference';

/**
 * THE DECISION ON A DIFFERENCE — the matrix, the explanation, the claim and the filters.
 *
 * The matrix is the thing a person is told and the thing the door enforces; both read `decisionMatrix`, so it is
 * pinned here cell by cell, and the TABLE THAT IS PUBLISHED (in the guide and the pull request) is held to it.
 */

const facts = (over: Partial<DecisionFacts> = {}): DecisionFacts => ({
  hasOrder: true,
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING_COLLECTION',
  openRequests: [],
  claimedElsewhere: false,
  statementApproved: false,
  expectedAmount: 20,
  statementAmount: 18,
  minorUnit: 3,
  ...over,
});

const allowed = (f: DecisionFacts) => {
  const m = decisionMatrix(f);
  return DECISIONS.filter((d) => m[d].allowed);
};

describe('the explanation is five characters at least', () => {
  it('four is refused, five is taken, and spaces do not count', () => {
    expect(MIN_EXPLANATION).toBe(5);
    expect(explanationOf('خصم')).toBeNull();
    expect(explanationOf('خصمٌ ')).toBeNull(); // four letters and a space
    expect(explanationOf('     خصم     ')).toBeNull();
    expect(explanationOf('')).toBeNull();
    expect(explanationOf(null)).toBeNull();
    expect(explanationOf(undefined)).toBeNull();
    // Exactly five is enough — the edge is the point.
    expect(explanationOf('اتفقن')).toBe('اتفقن');
    expect(explanationOf('  اتفقن  ')).toBe('اتفقن');
    expect(explanationOf('خصمٌ ما')).toBe('خصمٌ ما');
    expect(explanationOf('  اتفقنا  ')).toBe('اتفقنا');
  });

  it('the bulk press has a ceiling, so one request is not a whole statement', () => {
    expect(BULK_LIMIT).toBeGreaterThanOrEqual(50);
    expect(BULK_LIMIT).toBeLessThanOrEqual(500);
  });
});

describe('the matrix — a decision against the state of the order', () => {
  it('a delivered order with a shortfall may take either figure, or be parked', () => {
    expect(allowed(facts())).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']);
    expect(allowed(facts({ shippingStatus: 'PARTIALLY_DELIVERED' }))).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']);
  });

  it('a parcel on the road may take THEIR figure (the statement is the proof of delivery) but nobody claims before it is delivered', () => {
    for (const shippingStatus of IN_FLIGHT) {
      const m = decisionMatrix(facts({ shippingStatus }));
      expect(m.ACCEPTED_COURIER.allowed, shippingStatus).toBe(true);
      expect(m.OURS_STANDS.allowed, shippingStatus).toBe(false);
      expect(m.OURS_STANDS.why).toContain('قبل التسليم');
      expect(m.UNDER_REVIEW.allowed, shippingStatus).toBe(true);
    }
  });

  it('…but only with money stated: a line of ZERO beside «مؤجلة» is the company saying it did NOT deliver', () => {
    for (const shippingStatus of IN_FLIGHT) {
      const m = decisionMatrix(facts({ shippingStatus, statementAmount: 0, expectedAmount: 20 }));
      expect(m.ACCEPTED_COURIER.allowed, shippingStatus).toBe(false);
      expect(m.ACCEPTED_COURIER.why).toContain('ليس دليل تسليم');
      expect(m.UNDER_REVIEW.allowed).toBe(true);
    }
    // A parcel our own door recorded as delivered may take a zero: accepting that loss is a person's explicit act.
    expect(decisionMatrix(facts({ shippingStatus: 'DELIVERED', statementAmount: 0 })).ACCEPTED_COURIER.allowed).toBe(true);
  });

  it('a parcel coming back takes their figure only as a LINE OF ZERO, and is never a claim', () => {
    for (const shippingStatus of COMING_BACK) {
      expect(allowed(facts({ shippingStatus, statementAmount: 0, expectedAmount: -1.5 })), shippingStatus).toEqual([
        'ACCEPTED_COURIER',
        'UNDER_REVIEW',
      ]);
      const withMoney = decisionMatrix(facts({ shippingStatus, statementAmount: 5, expectedAmount: 0 }));
      expect(withMoney.ACCEPTED_COURIER.allowed).toBe(false);
      expect(withMoney.ACCEPTED_COURIER.why).toContain('مرتجع');
      expect(withMoney.OURS_STANDS.allowed).toBe(false);
    }
  });

  it('an order that never left, or was cancelled, takes neither figure — only «قيد المراجعة»', () => {
    for (const shippingStatus of ['NOT_READY', 'PACKING', 'READY_FOR_SHIPPING', 'CANCELLED']) {
      expect(allowed(facts({ shippingStatus })), shippingStatus).toEqual(['UNDER_REVIEW']);
      expect(decisionMatrix(facts({ shippingStatus })).ACCEPTED_COURIER.why).toContain('لم يُسلَّم للشركة');
    }
  });

  it('an order that is already settled (by hand or by another statement) takes neither', () => {
    const m = decisionMatrix(facts({ settlementStatus: 'SETTLED' }));
    expect(DECISIONS.filter((d) => m[d].allowed)).toEqual(['UNDER_REVIEW']);
    expect(m.ACCEPTED_COURIER.why).toContain('مُسوّى أصلاً');
  });

  it('an open cancel or postponement stops both — the parcel may not be what the line describes', () => {
    for (const intent of ['CANCEL', 'POSTPONE']) {
      expect(allowed(facts({ openRequests: [intent] })), intent).toEqual(['UNDER_REVIEW']);
    }
    // A change request that is neither (an edit) does not.
    expect(allowed(facts({ openRequests: ['EDIT'] }))).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']);
  });

  it('an order another row already holds takes neither', () => {
    expect(allowed(facts({ claimedElsewhere: true }))).toEqual(['UNDER_REVIEW']);
  });

  it('a row with no order has nothing to answer, parked included', () => {
    expect(allowed(facts({ hasOrder: false }))).toEqual([]);
    expect(decisionMatrix(facts({ hasOrder: false })).UNDER_REVIEW.why).toContain('اربطه بطلب');
  });

  it('after the approval their figure can no longer be accepted — the correction is a settlement statement', () => {
    const m = decisionMatrix(facts({ statementApproved: true }));
    expect(m.ACCEPTED_COURIER.allowed).toBe(false);
    expect(m.ACCEPTED_COURIER.why).toContain('كشف تسوية');
    // …but the claim is a record, and parking is a record: both still stand.
    expect(m.OURS_STANDS.allowed).toBe(true);
    expect(m.UNDER_REVIEW.allowed).toBe(true);
  });

  it('«رقمنا» needs something to claim: not when the company paid the same, or MORE', () => {
    for (const statementAmount of [20, 23]) {
      const m = decisionMatrix(facts({ statementAmount }));
      expect(m.OURS_STANDS.allowed, String(statementAmount)).toBe(false);
      expect(m.OURS_STANDS.why).toContain('لا نقص');
      expect(m.ACCEPTED_COURIER.allowed).toBe(true);
    }
  });

  it('and the claim is measured to the fils in a three-place currency', () => {
    // 0.0004 short is nothing in dinars (rounds to 0.000); 0.0005 short is a fils.
    expect(decisionMatrix(facts({ expectedAmount: 20, statementAmount: 19.9996 })).OURS_STANDS.allowed).toBe(false);
    expect(decisionMatrix(facts({ expectedAmount: 20, statementAmount: 19.999 })).OURS_STANDS.allowed).toBe(true);
    expect(claimOf({ expectedAmount: 20, statementAmount: 18 }, 3)).toBe(2);
    expect(claimOf({ expectedAmount: 20.125, statementAmount: 18 }, 3)).toBe(2.125);
    expect(claimOf({ expectedAmount: 20.125, statementAmount: 18 }, 2)).toBe(2.13);
    expect(claimOf({ expectedAmount: null, statementAmount: 18 }, 3)).toBe(0);
  });

  it('the groups of the states are the ones the approval promotes and settles', () => {
    expect([...IN_FLIGHT]).toEqual(['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY']);
    expect([...DELIVERED_STATES]).toEqual(['DELIVERED', 'PARTIALLY_DELIVERED']);
    expect([...COMING_BACK]).toEqual(['RETURN_REQUESTED', 'RETURNED']);
    expect(stateGroup('SHIPPED')).toBe('IN_FLIGHT');
    expect(stateGroup('DELIVERED')).toBe('DELIVERED');
    expect(stateGroup('RETURNED')).toBe('COMING_BACK');
    expect(stateGroup('CANCELLED')).toBe('OTHER');
    expect(stateGroup(null)).toBe('OTHER');
  });
});

describe('the matrix that is PUBLISHED is the matrix that is enforced', () => {
  const yes = (cell: string) => cell.startsWith('نعم');

  const probe: Record<string, DecisionFacts> = {
    'في الطريق': facts({ shippingStatus: 'SHIPPED' }),
    'مسلَّم': facts(),
    'راجع': facts({ shippingStatus: 'RETURN_REQUESTED', statementAmount: 0, expectedAmount: -1.5 }),
    'لم يُشحن أو مُلغى': facts({ shippingStatus: 'CANCELLED' }),
    'مُسوّى أصلاً': facts({ settlementStatus: 'SETTLED' }),
    'عليه طلب إلغاء أو تأجيل مفتوح': facts({ openRequests: ['CANCEL'] }),
    'محجوز بسطر آخر': facts({ claimedElsewhere: true }),
    'الكشف معتمد': facts({ statementApproved: true }),
  };

  it('has a row for every state it probes, and no other', () => {
    expect(DECISION_MATRIX.map((r) => r.state).sort()).toEqual(Object.keys(probe).sort());
  });

  it.each(DECISION_MATRIX.map((r) => [r.state, r] as const))('%s', (state, row) => {
    const m = decisionMatrix(probe[state]);
    expect(m.ACCEPTED_COURIER.allowed, 'اعتُمد رقم الشركة').toBe(yes(row.accepted));
    expect(m.OURS_STANDS.allowed, 'رقمنا هو المعتمد').toBe(yes(row.ours));
    expect(m.UNDER_REVIEW.allowed, 'قيد المراجعة').toBe(yes(row.parked));
  });
});

describe('the words', () => {
  it('each saying has its Arabic name, and «قيد المراجعة» is the third', () => {
    expect(DECISIONS).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']);
    expect(DECISION_AR.ACCEPTED_COURIER).toBe('اعتُمد رقم الشركة');
    expect(DECISION_AR.OURS_STANDS).toBe('رقمنا هو المعتمد');
    expect(DECISION_AR.UNDER_REVIEW).toBe('قيد المراجعة');
  });

  it('the note on the order says which figure stood, the difference, and the explanation', () => {
    const body = decisionNoteBody({ statement: 'ST-1', resolution: 'ACCEPTED_COURIER', gap: 2, note: 'خصم متفق عليه' });
    expect(body).toBe('مطابقة كشف ST-1: اعتُمد رقم الشركة — الفرق 2. خصم متفق عليه');
    expect(decisionNoteBody({ statement: 'ST-1', resolution: 'UNDER_REVIEW', gap: null, note: 'ننتظر' })).toBe(
      'مطابقة كشف ST-1: قيد المراجعة. ننتظر'
    );
  });

  it('the data written on the row carries the person and the time', () => {
    const at = new Date('2026-10-29T10:00:00Z');
    expect(decisionData({ resolution: 'OURS_STANDS', note: 'نطالب بالفرق', userId: 'u1', at })).toEqual({
      resolution: 'OURS_STANDS', resolutionNote: 'نطالب بالفرق', resolvedById: 'u1', resolvedAt: at,
    });
  });
});

describe('lines with the same courier word are one group', () => {
  it('«مؤجل» and «مؤجلة» are one reading, so one group; a blank cell is its own', () => {
    expect(wordGroupKey('مؤجل')).toBe(wordGroupKey('مؤجلة'));
    expect(wordGroupKey('مؤجل')).not.toBe(wordGroupKey('تم توصيلها'));
    expect(wordGroupKey('')).toBe('NONE');
    expect(wordGroupKey(null)).toBe('NONE');
  });

  it('a word nobody has met groups by its own spelling, so two unknown words are never decided together', () => {
    expect(wordGroupKey('كلمة غريبة')).toBe(wordGroupKey('  كلمة   غريبة '));
    expect(wordGroupKey('كلمة غريبة')).not.toBe(wordGroupKey('كلمة أخرى'));
    expect(wordGroupKey('كلمة غريبة')).not.toBe(wordGroupKey('مؤجل'));
  });
});

describe('the claim on the company', () => {
  const at = (day: number) => ({ approvedAt: new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`) });

  it('is what the first statement left unpaid, and what it has paid so far', () => {
    const claims = claimsFromRows([{ orderId: 'o1', expectedAmount: 20, statementAmount: 18, statementFee: 0, statement: at(20) }], 3);
    expect(claims.get('o1')).toEqual({ remaining: 2, paidGross: 18 });
  });

  it('the LATEST approved answer wins — a part-payment answered «رقمنا» again leaves a smaller claim', () => {
    const claims = claimsFromRows(
      [
        { orderId: 'o1', expectedAmount: 20, statementAmount: 18, statement: at(20) },
        { orderId: 'o1', expectedAmount: 2, statementAmount: 1.5, statement: at(25) },
      ],
      3
    );
    expect(claims.get('o1')).toEqual({ remaining: 0.5, paidGross: 19.5 });
  });

  it('a claim that was paid in full (or over) is no claim', () => {
    expect(claimsFromRows([{ orderId: 'o1', expectedAmount: 2, statementAmount: 2, statement: at(20) }], 3).size).toBe(0);
    expect(claimsFromRows([{ orderId: 'o1', expectedAmount: 2, statementAmount: 3, statement: at(20) }], 3).size).toBe(0);
  });

  it('a row with no figure on one side says nothing', () => {
    expect(claimsFromRows([{ orderId: 'o1', expectedAmount: null, statementAmount: 3, statement: at(20) }], 3).size).toBe(0);
    expect(claimsFromRows([{ orderId: null, expectedAmount: 20, statementAmount: 3, statement: at(20) }], 3).size).toBe(0);
  });

  it('what was paid counts the fee the courier kept, to the fils', () => {
    expect(paidGross([{ statementAmount: 15.5, statementFee: 2.5 }], 3)).toBe(18);
    expect(paidGross([{ statementAmount: 17.125, statementFee: null }, { statementAmount: 2.875 }], 3)).toBe(20);
    expect(paidGross([], 3)).toBe(0);
  });
});

describe('the conditions the approval re-checks are the WHERE of the write itself', () => {
  it('a clean row: not settled by anyone meanwhile, and no cancel or postponement asked for', () => {
    const w = stillSettlableWhere('c1', ['o1', 'o2']);
    expect(w).toMatchObject({ id: { in: ['o1', 'o2'] }, companyId: 'c1', settlementStatus: { not: 'SETTLED' } });
    expect(JSON.stringify(w.changeRequests)).toContain('CANCEL');
    expect(JSON.stringify(w.changeRequests)).toContain('POSTPONE');
    expect(w).not.toHaveProperty('OR');
  });

  it('an answered row: the same, and a state the matrix allows — a return only as a line of zero', () => {
    const w = stillAcceptableWhere('c1', ['o1', 'o2'], ['o2']) as unknown as { OR: { id?: unknown; shippingStatus: { in: string[] } }[] };
    expect(w.OR).toHaveLength(3);
    expect(w.OR[0].shippingStatus.in).toEqual([...DELIVERED_STATES]);
    // A parcel on the road comes in only with money stated: the zero line (o2) is not among the ids.
    expect(w.OR[1]).toEqual({ id: { in: ['o1'] }, shippingStatus: { in: [...IN_FLIGHT] } });
    expect(w.OR[2]).toEqual({ id: { in: ['o2'] }, shippingStatus: { in: ['RETURN_REQUESTED', 'RETURNED'] } });
    // No zero line → no way in for a parcel coming back; nothing but zero lines → no way in for one on the road.
    expect((stillAcceptableWhere('c1', ['o1'], []) as unknown as { OR: unknown[] }).OR).toHaveLength(2);
    expect((stillAcceptableWhere('c1', ['o2'], ['o2']) as unknown as { OR: unknown[] }).OR).toHaveLength(2);
  });
});

describe('RV306 — the difference is rounded by the currency, not by two places', () => {
  it('a dinar keeps its three places in the answer of the door', () => {
    expect(shortfall({ expectedAmount: 20.125, statementAmount: 18, difference: -2.125 }, 3)).toBe(2.125);
    expect(shortfall({ expectedAmount: 20.125, statementAmount: 18, difference: null }, 3)).toBe(2.125);
    // Two places is still the default for a currency that has two.
    expect(shortfall({ expectedAmount: 20.125, statementAmount: 18, difference: -2.125 })).toBe(2.13);
    expect(shortfall({ expectedAmount: 20, statementAmount: 18, difference: -2 }, 3)).toBe(2);
  });
});
