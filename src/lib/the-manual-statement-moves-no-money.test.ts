import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { collectTotalRefusal, statementNamingRefusal } from './settlement-gates';
import { isManualHash, MANUAL_PREFIX } from './manual-statement-rules';

/**
 * THE MANUAL STATEMENT HAS NO DOOR OF ITS OWN TO MONEY.
 *
 * Courier money becomes ours at exactly two doors (`money-moves-at-two-doors`): the approval of a statement and
 * «استلمت منه». The manual statement is a way to FILL the first, not a third. So the two presses and the lib behind
 * them write lines and a draft's total — and no wallet movement, no settled order, no payable commission. Pinned by
 * reading the sources, because a test of what the code does cannot show what it was never allowed to do.
 */

const code = (rel: string) => stripComments(repoFile(rel));

const MANUAL_FILES = [
  'src/lib/manual-statement.ts',
  'src/lib/manual-statement-rules.ts',
  'src/lib/statement-naming.ts',
  'src/app/api/finance/statements/manual/route.ts',
  'src/app/api/finance/statements/[id]/assemble/route.ts',
];

describe('the two presses write lines, never money', () => {
  it.each(MANUAL_FILES)('%s touches no wallet, settles no order and pays no commission', (file) => {
    const src = code(file);
    expect(src.length).toBeGreaterThan(300);
    expect(src).not.toMatch(/walletMovement|recordMovement|COURIER_SETTLEMENT|reverseMovement/);
    expect(src).not.toMatch(/settlementStatus:\s*'SETTLED'/);
    expect(src).not.toMatch(/markPayableForOrders|commissionEntry|orderActivity\.create/);
    // The only orders it reads are read: it never updates one.
    expect(src).not.toMatch(/tx\.order\.(update|updateMany|create|delete)\(/);
  });

  it('and the only rows it writes are the statement and its lines', () => {
    const src = code('src/lib/manual-statement.ts');
    const writes = [...src.matchAll(/tx\.(\w+)\.(create|update|updateMany|createMany|delete|deleteMany|upsert)\(/g)].map((m) => m[1]);
    expect([...new Set(writes)].sort()).toEqual(['courierStatement', 'statementLine']);
  });

  it('and the approval remains the one place a manual statement’s money is written', () => {
    const approval = code('src/app/api/finance/statements/[id]/route.ts');
    expect(approval).toMatch(/category: 'COURIER_SETTLEMENT'/);
    for (const file of MANUAL_FILES) expect(code(file)).not.toContain("category: 'COURIER_SETTLEMENT'");
  });
});

describe('«استلمت منه» and the manual statement share their words', () => {
  it('the collection door takes the «nothing to take in» sentences from the one function, and keeps no copy of them', () => {
    const collect = code('src/app/api/ops/tracking/collect/route.ts');
    expect(collect).toMatch(/collectTotalRefusal\(\{/);
    expect(collect).not.toContain('لا يوجد مبلغ لقبضه');
    expect(code('src/lib/manual-statement.ts')).toMatch(/collectTotalRefusal\(\{/);
  });

  it('a negative total names the debt to the fils; zero says nothing is left to hand over', () => {
    const owed = collectTotalRefusal({ expected: -1.25, owed: 1.25, currency: 'JOD', count: 2 });
    expect(owed).toMatchObject({ code: 'OWED_TO_COURIER', expected: -1.25, currency: 'JOD' });
    expect(owed!.error).toContain('1.25 JOD');
    expect(owed!.error).toContain('عن 2 طلب');
    const zero = collectTotalRefusal({ expected: 0, owed: 0, currency: 'JOD', count: 3 });
    expect(zero).toMatchObject({ code: 'NOTHING_TO_COLLECT' });
    expect(zero!.error).toContain('عن 3 طلب');
    expect(collectTotalRefusal({ expected: 0.001, owed: 0, currency: 'JOD', count: 1 })).toBeNull();
  });
});

describe('an order in a manual statement cannot also be collected by hand', () => {
  const order = { id: 'o1', orderNumber: 'JO-2026-0001', merchantRef: 'JO-2026-0001', trackingNumber: null, deliveryProviderId: 'cA' };
  const draftLine = (over: Record<string, unknown> = {}) => ({
    merchantRef: 'JO-2026-0001',
    barcode: null,
    statement: { reference: 'مسوّدة كشف يدوي', status: 'IMPORTED', approvedAt: null, deliveryProviderId: 'cA', ...over },
  });

  it('on the open draft: «استلمت منه» is refused, naming the order and saying its money is written at approval', () => {
    const r = statementNamingRefusal([order], [draftLine()]);
    expect(r?.code).toBe('ON_UNAPPROVED_STATEMENT');
    expect(r?.orders).toEqual(['JO-2026-0001']);
    expect(r?.error).toContain('JO-2026-0001');
  });

  it('on an approved manual statement: refused, and the sentence names the statement that took the money', () => {
    const r = statementNamingRefusal([order], [draftLine({ reference: 'كشف الأحد', status: 'APPROVED', approvedAt: new Date() })]);
    expect(r?.code).toBe('IN_APPROVED_STATEMENT');
    expect(r?.error).toContain('كشف الأحد');
  });
});

describe('what makes a statement manual is its hash and nothing else', () => {
  it('no sha-256 of a file can start with the prefix', () => {
    expect(MANUAL_PREFIX).toBe('manual:');
    expect(isManualHash('0123456789abcdef'.repeat(4))).toBe(false);
  });

  it('the import door can only write a hex digest, so it can never make a statement look manual', () => {
    const route = code('src/app/api/finance/statements/route.ts');
    expect(route).toMatch(/const hash = fileHash\(fileBytes\)/);
    expect(route).not.toMatch(/fileHash: ['`]manual/);
  });
});
