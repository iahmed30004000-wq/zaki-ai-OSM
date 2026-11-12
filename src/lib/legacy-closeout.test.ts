import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';
import {
  LEGACY_DELIVERED,
  NO_MONEY_SETTLEMENT,
  awaitingNoBarcodeWhere,
  fingerprintOf,
  measureLegacy,
  readNamed,
  stillCloseableWhere,
  type LegacyRead,
  type LegacyRow,
} from './legacy-closeout';
import { LEGACY_AGES, LEGACY_CLOSE_ACTION, LEGACY_CLOSE_NOTE, LEGACY_MOST, readLegacyAge } from './legacy-closeout-words';
import { SETTLEMENT_WITH_MONEY } from './written-off';
import { canCollect } from './parcel-tracking/priority';
import { describeAction } from './audit-view';

/**
 * «أقفل القديمة بلا باركود» (12/11) — THE RULES, WITHOUT A DATABASE.
 *
 * What the press would close, what it would leave and why, and the promise the owner made it for: «بدون ما تأثر على المالية».
 * The door's own cases (gates, refusals, what is written) are in `close-legacy.test.ts` beside the route.
 */

const NOW = new Date('2026-11-12T20:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

let seq = 0;
const row = (over: Partial<LegacyRow> = {}): LegacyRow => {
  seq += 1;
  return {
    id: `o${seq}`,
    orderNumber: `SY-${seq}`,
    merchantRef: `SY-${seq}`,
    trackingNumber: null,
    deliveryProviderId: 'p1',
    settlementStatus: 'PENDING',
    at: daysAgo(40),
    currency: 'USD',
    value: 20,
    courier: 'الباشا',
    ...over,
  };
};
const read = (rows: LegacyRow[], named: string[] = [], tooMany = false): LegacyRead => ({ rows, named: new Set(named), tooMany });

describe('what the press would close', () => {
  it('only what is old enough, and each age says how many it would close', () => {
    const rows = [row({ at: daysAgo(40) }), row({ at: daysAgo(20) }), row({ at: daysAgo(10) }), row({ at: daysAgo(5) }), row({ at: daysAgo(2) })];
    const { measure, rows: closing } = measureLegacy(read(rows), 14, NOW);

    expect(closing.map((r) => r.id)).toEqual([rows[0].id, rows[1].id]);
    expect(measure.closeable.count).toBe(2);
    expect(measure.options).toEqual([
      { age: 1, count: 5 },
      { age: 3, count: 4 },
      { age: 7, count: 3 },
      { age: 14, count: 2 },
      { age: 30, count: 1 },
    ]);
    // What the cut leaves is said, not lost.
    expect(measure.left).toEqual({ tooRecent: 3, moneyRecorded: 0, onAStatement: 0 });
  });

  it('an order exactly as old as the cut is NOT old enough — the cut is «older than»', () => {
    const exactly = row({ at: daysAgo(14) });
    const older = row({ at: new Date(daysAgo(14).getTime() - 1) });
    const { rows } = measureLegacy(read([exactly, older]), 14, NOW);
    expect(rows.map((r) => r.id)).toEqual([older.id]);
  });

  it('every age is one of the five, and only those', () => {
    expect([...LEGACY_AGES]).toEqual([1, 3, 7, 14, 30]);
    expect(readLegacyAge('14')).toBe(14);
    expect(readLegacyAge(7)).toBe(7);
    for (const bad of ['0', '2', '15', '-1', '', ' ', 'x', null, undefined, NaN, 14.5, '14.5']) expect(readLegacyAge(bad as never), String(bad)).toBeNull();
  });

  it('says whose they are (biggest first), the oldest and newest day, and their value per currency', () => {
    const rows = [
      row({ courier: 'الو دليفيري', at: daysAgo(50), value: 10 }),
      row({ courier: 'الباشا', at: daysAgo(30), value: 20 }),
      row({ courier: 'الباشا', at: daysAgo(20), value: 30.5 }),
      row({ courier: 'الباشا', at: daysAgo(25), value: 5, currency: 'SYP' }),
    ];
    const { measure } = measureLegacy(read(rows), 14, NOW);

    expect(measure.closeable.byCourier).toEqual([
      { name: 'الباشا', count: 3 },
      { name: 'الو دليفيري', count: 1 },
    ]);
    expect(measure.closeable.value).toEqual([
      { currency: 'SYP', amount: 5 },
      { currency: 'USD', amount: 60.5 },
    ]);
    expect(measure.closeable.oldestAt).toBe(daysAgo(50).toISOString());
    expect(measure.closeable.newestAt).toBe(daysAgo(20).toISOString());
  });

  it('a parcel with no courier named is still counted, under its own name', () => {
    const { measure } = measureLegacy(read([row({ courier: 'بلا شركة شحن', deliveryProviderId: null })]), 14, NOW);
    expect(measure.closeable.byCourier).toEqual([{ name: 'بلا شركة شحن', count: 1 }]);
  });
});

describe('what it leaves alone', () => {
  it('a settlement state that already carries money is never closed, and is counted apart', () => {
    const money = ['COLLECTED', 'PARTIALLY_SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED'].map((s) => row({ settlementStatus: s }));
    const plain = row({ settlementStatus: 'NOT_APPLICABLE' });
    const { measure, rows } = measureLegacy(read([...money, plain]), 14, NOW);

    expect(rows.map((r) => r.id)).toEqual([plain.id]);
    expect(measure.left.moneyRecorded).toBe(4);
  });

  it('the four states it may close are exactly the ones with no money recorded', () => {
    expect([...NO_MONEY_SETTLEMENT]).toEqual(['NOT_APPLICABLE', 'PENDING', 'PENDING_COLLECTION', 'UNSETTLED']);
    for (const s of NO_MONEY_SETTLEMENT) expect(SETTLEMENT_WITH_MONEY as readonly string[], s).not.toContain(s);
    for (const s of NO_MONEY_SETTLEMENT) expect(s).not.toBe('SETTLED');
  });

  it('an order a statement speaks for is left to the statement', () => {
    const named = row();
    const free = row();
    const { measure, rows } = measureLegacy(read([named, free], [named.id]), 14, NOW);

    expect(rows.map((r) => r.id)).toEqual([free.id]);
    expect(measure.left.onAStatement).toBe(1);
  });

  it('more than the most one press may hold closes NOTHING and says so — and every age reads zero', () => {
    const { measure, rows } = measureLegacy(read([row(), row()], [], true), 14, NOW);
    expect(rows).toEqual([]);
    expect(measure.tooMany).toBe(true);
    expect(measure.closeable.count).toBe(0);
    expect(measure.options.every((o) => o.count === 0)).toBe(true);
    expect(LEGACY_MOST).toBe(20_000);
  });

  it('nothing waiting is an empty answer, not an error', () => {
    const { measure, rows } = measureLegacy(read([]), 14, NOW);
    expect(rows).toEqual([]);
    expect(measure.closeable).toMatchObject({ count: 0, oldestAt: null, newestAt: null, byCourier: [], value: [] });
  });
});

describe('the fingerprint is what the screen saw', () => {
  it('the same orders give the same one, in any order — and another set gives another', () => {
    expect(fingerprintOf(['a', 'b', 'c'])).toBe(fingerprintOf(['c', 'a', 'b']));
    expect(fingerprintOf(['a', 'b'])).not.toBe(fingerprintOf(['a', 'b', 'c']));
    expect(fingerprintOf(['a', 'b'])).not.toBe(fingerprintOf(['a', 'x']));
    expect(fingerprintOf(['a'])).toMatch(/^[0-9a-f]{24}$/);
  });

  it('a new order that qualifies, or one that stops qualifying, changes what the press would close', () => {
    const a = row({ at: daysAgo(40) });
    const b = row({ at: daysAgo(30) });
    const before = measureLegacy(read([a, b]), 14, NOW).measure.closeable.fingerprint;
    const withNew = measureLegacy(read([a, b, row({ at: daysAgo(35) })]), 14, NOW).measure.closeable.fingerprint;
    const withoutOne = measureLegacy(read([a]), 14, NOW).measure.closeable.fingerprint;
    expect(withNew).not.toBe(before);
    expect(withoutOne).not.toBe(before);
    // And the same read again is the same answer.
    expect(measureLegacy(read([a, b]), 14, NOW).measure.closeable.fingerprint).toBe(before);
  });
});

describe('the questions it asks the database', () => {
  const scope = { companyId: 'c1', storeId: 's1' };

  it('«بانتظار التحصيل» is the tracking list’s own: delivered or partly, not settled — and no barcode means null OR blank', () => {
    expect(awaitingNoBarcodeWhere(scope)).toEqual({
      companyId: 'c1',
      storeId: 's1',
      shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] },
      settlementStatus: { not: 'SETTLED' },
      OR: [{ trackingNumber: null }, { trackingNumber: '' }],
    });
  });

  it('the claim names the states with no money instead of «not SETTLED», keeps the barcode and the store in it, and takes only these ids', () => {
    const where = stillCloseableWhere(scope, ['a', 'b']);
    expect(where).toEqual({
      companyId: 'c1',
      storeId: 's1',
      shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] },
      settlementStatus: { in: ['NOT_APPLICABLE', 'PENDING', 'PENDING_COLLECTION', 'UNSETTLED'] },
      OR: [{ trackingNumber: null }, { trackingNumber: '' }],
      id: { in: ['a', 'b'] },
    });
  });

  it('the delivered statuses are exactly the ones «بانتظار التحصيل» (COLLECT) accepts — one meaning, not a copy that drifts', () => {
    const every = ['NOT_READY', 'READY_FOR_SHIPPING', 'PACKING', 'READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'];
    for (const s of every) {
      const collect = canCollect({ shippingStatus: s, settlementStatus: 'PENDING', daysInTransit: 0, late: false });
      expect((LEGACY_DELIVERED as readonly string[]).includes(s), s).toBe(collect);
    }
  });
});

describe('«a statement speaks for it» — read the way the collect door reads it', () => {
  const scope = { companyId: 'c1', storeId: 's1' };
  const statement = (approved = false) => ({ reference: 'ST-1', status: approved ? 'APPROVED' : 'DRAFT', approvedAt: approved ? new Date() : null, deliveryProviderId: 'p1' });

  const tx = (lines: unknown[], links: unknown[]) => ({
    statementLine: { findMany: vi.fn(async (_a: { where: unknown }) => lines) },
    settlementMatch: { findMany: vi.fn(async (_a: { where: unknown }) => links) },
  });

  it('a line carrying the order’s reference names it; another reference does not', async () => {
    const a = row({ merchantRef: 'SY-100' });
    const b = row({ merchantRef: 'SY-200' });
    const t = tx([{ merchantRef: 'SY-100', barcode: null, statement: statement(), matches: [] }], []);
    const named = await readNamed(t as never, scope, [a, b]);
    expect([...named]).toEqual([a.id]);
  });

  it('a line the matching EXCLUDED carries no money for the order, so it does not name it', async () => {
    const a = row({ merchantRef: 'SY-100' });
    const t = tx([{ merchantRef: 'SY-100', barcode: null, statement: statement(), matches: [{ result: 'EXCLUDED' }] }], []);
    expect([...(await readNamed(t as never, scope, [a]))]).toEqual([]);
  });

  it('a line a person tied to the order by hand names it, whatever reference it carries', async () => {
    const a = row({ merchantRef: null });
    const t = tx([], [{ orderId: a.id, result: 'MATCHED', statement: statement() }]);
    expect([...(await readNamed(t as never, scope, [a]))]).toEqual([a.id]);
  });

  it('asks only for this store’s statements, and only for the references these orders carry', async () => {
    const t = tx([], []);
    await readNamed(t as never, scope, [row({ merchantRef: 'SY-1' }), row({ merchantRef: null })]);
    expect(t.statementLine.findMany).toHaveBeenCalledTimes(1);
    expect(t.statementLine.findMany.mock.calls[0][0].where).toEqual({ statement: { companyId: 'c1', storeId: 's1' }, merchantRef: { in: ['SY-1'] } });
    expect(t.settlementMatch.findMany.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', statementLineId: { not: null } });
  });

  it('no orders, no questions', async () => {
    const t = tx([], []);
    expect([...(await readNamed(t as never, scope, []))]).toEqual([]);
    expect(t.statementLine.findMany).not.toHaveBeenCalled();
  });
});

describe('«بدون ما تأثر على المالية» — the press has no way to reach the money', () => {
  const root = process.cwd();
  const sources = {
    'src/lib/legacy-closeout.ts': stripComments(readFileSync(join(root, 'src/lib/legacy-closeout.ts'), 'utf8')),
    'src/lib/legacy-closeout-words.ts': stripComments(readFileSync(join(root, 'src/lib/legacy-closeout-words.ts'), 'utf8')),
    'src/app/api/ops/tracking/close-legacy/route.ts': stripComments(readFileSync(join(root, 'src/app/api/ops/tracking/close-legacy/route.ts'), 'utf8')),
  };

  // Everything that moves money, makes commission payable, writes the courier's figure, moves stock or tells another system.
  const FORBIDDEN = [
    'walletMovement',
    'recordMovement',
    'reverseMovement',
    'markPayableForOrders',
    'promoteSettledToPayable',
    'commissionEntry',
    'accrueForOrder',
    'collectedAmount',
    'financialTransaction',
    'consumeOrderStock',
    'restoreOrderStock',
    'emitAppEvent',
    '$executeRaw',
    '$queryRaw',
  ];

  for (const [file, src] of Object.entries(sources)) {
    it(`${file} names none of them`, () => {
      const found = FORBIDDEN.filter((w) => src.includes(w));
      expect(found, 'بابٌ يلمس المال').toEqual([]);
    });
  }

  it('the only order column it writes is the settlement status, and only to SETTLED', () => {
    const src = sources['src/lib/legacy-closeout.ts'];
    const writes = [...src.matchAll(/tx\.order\.(update|updateMany|create|createMany|delete|deleteMany|upsert)\(/g)].map((m) => m[1]);
    expect(writes).toEqual(['updateMany']);
    expect(src).toMatch(/data: \{ settlementStatus: 'SETTLED' \}/);
  });

  it('the mark the commission rule reads is the very one the press writes', () => {
    expect(LEGACY_CLOSE_ACTION).toBe('LEGACY_CLOSED_NO_MONEY');
    expect(sources['src/lib/legacy-closeout.ts']).toContain('action: LEGACY_CLOSE_ACTION');
  });

  it('the press reads the statements again AFTER the claim — the second read sits below the claim loop in the source', () => {
    const src = sources['src/lib/legacy-closeout.ts'];
    const claim = src.indexOf('tx.order.updateMany(');
    const late = src.indexOf('const late = await readNamed(');
    expect(claim).toBeGreaterThan(-1);
    expect(late, 'the re-read is gone').toBeGreaterThan(claim);
    // ...and the log and the mark are written only after it.
    expect(src.indexOf('tx.orderStatusLog.createMany(')).toBeGreaterThan(late);
    expect(src.indexOf('tx.orderActivity.createMany(')).toBeGreaterThan(late);
  });
});

describe('the commission readers use the ONE definition of «payable now» — none restates it', () => {
  const root = process.cwd();
  it.each(['src/app/api/finance/commission/route.ts', 'src/lib/commission-payout.ts'])(
    '%s reads PROMOTABLE_BY_PAYOUT and never spells «settlementStatus: SETTLED» itself (a restated copy would forget the mark)',
    (file) => {
      const src = stripComments(readFileSync(join(root, file), 'utf8'));
      expect(src).toContain('PROMOTABLE_BY_PAYOUT');
      expect(src).not.toMatch(/settlementStatus:\s*'SETTLED'/);
    }
  );
});

describe('every word the owner can see for the press is Arabic', () => {
  const root = process.cwd();
  const arabicOnly = (s: string) => /[؀-ۿ]/.test(s) && !/[A-Za-z]/.test(s);

  it('the audit screen names the press in Arabic, not by its code', () => {
    const said = describeAction(LEGACY_CLOSE_ACTION, 'Store');
    expect(said).not.toBe(LEGACY_CLOSE_ACTION);
    expect(arabicOnly(said), said).toBe(true);
  });

  it('the order timeline names the mark in Arabic — otherwise every closed order shows an English line', () => {
    const src = readFileSync(join(root, 'src/lib/order-timeline.ts'), 'utf8');
    const word = /LEGACY_CLOSED_NO_MONEY: '([^']+)'/.exec(src)?.[1];
    expect(word, 'ACTIVITY_AR has no word for the mark').toBeTruthy();
    expect(arabicOnly(word as string), word).toBe(true);
  });

  it('the sentence on every settlement-log line is Arabic', () => {
    expect(arabicOnly(LEGACY_CLOSE_NOTE)).toBe(true);
  });
});
