import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { approvalRefusal, statementNamingRefusal } from './settlement-gates';
import { differencesByPerson } from './settlement-difference';

/**
 * A ROW THAT NAMES A PARCEL ONE SIDE LACKS (MISSING_IN_STATEMENT, MISSING_IN_SYSTEM) IS NOT COUNTED AGAINST ANYTHING.
 *
 * Not by the approval gate, not by the lock after it, not by the refusal of a hand collection, not by the
 * per-person tally. It is a list of things to chase or to link — answered on the order — and counting it
 * would stop a statement that is right from being approved, or refuse «استلمت منه» for a parcel no statement
 * named, or mark a person down for a discount nobody gave.
 *
 * Each place that could count it is held here: by behaviour where there is any to run, by source where the
 * rule lives in a query.
 */

const code = (path: string) => stripComments(repoFile(path));

describe('the approval gate', () => {
  const ready = {
    status: 'MATCHED', approvedAt: null, receipts: 1, matches: 4,
    gap: { gap: 0, needsExplanation: false, unconvertible: 0 }, explanation: null,
  };

  it('is the same with any number of missing rows among the matches — it reads a count, not their words', () => {
    // `matches` is how many rows matching produced: only «has matching run». It never asks what they say.
    expect(approvalRefusal(ready)).toBeNull();
    expect(approvalRefusal({ ...ready, matches: 400 })).toBeNull();
  });

  it('and the gate’s source never names a missing result', () => {
    const src = code('src/lib/settlement-gates.ts');
    expect(src.length).toBeGreaterThan(1000);
    expect(src).not.toMatch(/MISSING_IN_STATEMENT|MISSING_IN_SYSTEM/);
  });
});

describe('the refusal of a hand collection', () => {
  it('reads statement LINES only, so an order no statement named is never refused', () => {
    const orders = [{ orderNumber: 'ORD-1', merchantRef: 'REF-1', trackingNumber: 'BC-1', deliveryProviderId: 'dp1' }];
    // The statements in the record name other parcels; this one is on none of them.
    const lines = [{ merchantRef: 'REF-2', barcode: 'BC-2', statement: { reference: 'ST-1', status: 'APPROVED', approvedAt: new Date(), deliveryProviderId: 'dp1' } }];
    expect(statementNamingRefusal(orders, lines)).toBeNull();
  });

  it('and the collect door never reads the match rows at all', () => {
    const src = code('src/app/api/ops/tracking/collect/route.ts');
    expect(src.length).toBeGreaterThan(2000);
    expect(src).not.toContain('settlementMatch');
    expect(src).not.toMatch(/MISSING_IN_STATEMENT|MISSING_IN_SYSTEM/);
  });
});

describe('the approval door', () => {
  it('settles only the clean rows — a missing row settles nothing and pays no commission', () => {
    const src = code('src/app/api/finance/statements/[id]/route.ts');
    expect(src).toMatch(/matches\.filter\(\(m\) => m\.result === 'MATCHED' && m\.orderId\)/);
    // The only place the approval route names a missing result is the read that SHOWS it.
    expect(src).not.toMatch(/result === 'MISSING|result: 'MISSING/);
  });
});

describe('the per-person tally', () => {
  const src = code('src/app/api/finance/settlement-differences/route.ts');

  it('counts a difference only where the figures disagree', () => {
    expect(src).toContain(`m.result = 'MISMATCHED'`);
    expect(src).not.toContain(`m.result <> 'MATCHED'`);
  });

  it('and counts an order as having reached a statement only when a line of one named it', () => {
    expect(src).toContain(`m.result IN ('MATCHED', 'MISMATCHED')`);
  });

  it('so a person whose only rows are unmentioned parcels shows no difference and no settled order', () => {
    // The SQL above leaves such rows out, so the rows reaching `differencesByPerson` carry no trace of them.
    const [p] = differencesByPerson([{ personId: 'p1', settledOrders: 0, differences: 0, accepted: 0, acceptedValue: 0 }]);
    expect(p).toMatchObject({ differences: 0, open: 0, rate: null, settledOrders: 0 });
  });
});

describe('the door that answers a difference', () => {
  it('only takes a row where there are two figures', () => {
    const src = code('src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts');
    expect(src).toMatch(/if \(!isDifference\(match\)\)/);
  });
});
