import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keeperStatementShown, resolveStatementPeriod, tallyStatement, type StatementInput } from './keeper-statement';

/**
 * «كشف عهدة الأمين» (W5b) — the pure parts: the period in the store's days, the tally of approved sheets, the cut for a
 * person without the cost key, and what the module may import. The door test (`counts/statement/statement-door.test.ts`)
 * runs the same through the real doors.
 */

const line = (productId: string, counted: number | null, expected: number | null, applied: number | null, valueAtCost: number | null = 0) => ({
  productId,
  counted,
  expected,
  applied,
  valueAtCost,
  unsourcedWithCourier: 0,
});
const sheet = (id: string, at: string, lines: StatementInput['sheets'][number]['lines']) => ({
  id,
  submittedAt: new Date(at),
  decidedAt: new Date(at),
  submittedById: 'k',
  decidedById: 'a',
  lines,
});
const input = (sheets: StatementInput['sheets']): StatementInput => ({
  sheets,
  people: new Map([
    ['k', 'الأمين'],
    ['a', 'المعتمد'],
  ]),
  products: new Map([
    ['p1', 'أ'],
    ['p2', 'ب'],
  ]),
  truncated: false,
});
const TZ = 'Asia/Amman';

describe('the period is the store’s days', () => {
  it('«آخر 30 يوم» starts at the store’s midnight 29 days before the store’s today — not the server’s', () => {
    // 22:30 UTC on the 20th is already the 21st in Amman (UTC+3).
    const v = resolveStatementPeriod('30', new Date('2026-11-20T22:30:00Z'), TZ);
    expect(v).toMatchObject({ ok: true, period: '30', fromDay: '2026-10-23' });
    if (v.ok) expect(v.start?.toISOString()).toBe('2026-10-22T21:00:00.000Z');
  });

  it('empty is the last 90 days; «الكل» has no start', () => {
    expect(resolveStatementPeriod(null, new Date('2026-11-21T10:00:00Z'), TZ)).toMatchObject({ ok: true, period: '90', fromDay: '2026-08-24' });
    expect(resolveStatementPeriod('all', new Date(), TZ)).toEqual({ ok: true, period: 'all', fromDay: null, start: null });
  });

  it('NEGATIVE: anything else is refused in Arabic with a stable code', () => {
    for (const raw of ['7', '2026-11', 'ALL', '30 ']) {
      const v = resolveStatementPeriod(raw, new Date(), TZ);
      expect(v.ok, raw).toBe(false);
      if (!v.ok) {
        expect(v.code).toBe('INVALID_PERIOD');
        expect(v.errorAr).toMatch(/[؀-ۿ]/);
      }
    }
  });
});

describe('the tally', () => {
  const three = input([
    sheet('k1', '2026-10-01T09:00:00Z', [line('p1', 41, 37, 4, 10), line('p2', 5, 5, 0)]),
    // p2 is not on the second sheet: its opening on the third comes from the first.
    sheet('k2', '2026-10-15T09:00:00Z', [line('p1', 50, 51, -1, -2.5)]),
    sheet('k3', '2026-11-01T09:00:00Z', [line('p1', 48, 48, 0), line('p2', 3, 4, -1, -1.005)]),
  ]);

  it('opening = the product’s count at its previous approved sheet; net = expected − opening; the first count has neither', () => {
    const t = tallyStatement(three, { timeZone: TZ, minorUnit: 2, start: null });
    expect(t.rows.map((r) => [r.countId, r.productId, r.opening, r.openingDay, r.net, r.expected, r.counted, r.difference])).toEqual([
      ['k3', 'p1', 50, '2026-10-15', -2, 48, 48, 0],
      ['k3', 'p2', 5, '2026-10-01', -1, 4, 3, -1],
      ['k2', 'p1', 41, '2026-10-01', 10, 51, 50, -1],
      ['k1', 'p1', null, null, null, 37, 41, 4],
      ['k1', 'p2', null, null, null, 5, 5, 0],
    ]);
  });

  it('a period still reads the openings from before it', () => {
    const t = tallyStatement(three, { timeZone: TZ, minorUnit: 2, start: new Date('2026-10-20T00:00:00Z') });
    expect(t.sheets.map((s) => s.countId)).toEqual(['k3']);
    expect(t.rows.map((r) => [r.productId, r.opening])).toEqual([
      ['p1', 50],
      ['p2', 5],
    ]);
    expect(t.total).toEqual({ sheets: 1, surplus: 0, shortfall: 1, valueAtCost: -1.01 });
  });

  it('sums: surplus and shortfall as positive units; the value rounded ONCE to the minor unit', () => {
    const t = tallyStatement(three, { timeZone: TZ, minorUnit: 2, start: null });
    expect(t.sheets.map((s) => [s.countId, s.lines, s.surplus, s.shortfall, s.valueAtCost, s.countedByName, s.approvedByName])).toEqual([
      ['k3', 2, 0, 1, -1.01, 'الأمين', 'المعتمد'],
      ['k2', 1, 0, 1, -2.5, 'الأمين', 'المعتمد'],
      ['k1', 2, 4, 0, 10, 'الأمين', 'المعتمد'],
    ]);
    // 10 − 2.5 − 1.005 = 6.495 → 6.5: the raw values summed, then rounded once to two decimals.
    expect(t.total).toMatchObject({ sheets: 3, surplus: 4, shortfall: 2 });
    expect(t.total.valueAtCost).toBeCloseTo(6.5, 2);
  });

  it('NEGATIVE: a line never counted or never frozen is not a row and does not become an opening', () => {
    const t = tallyStatement(
      input([sheet('k1', '2026-10-01T09:00:00Z', [line('p1', null, null, null)]), sheet('k2', '2026-10-02T09:00:00Z', [line('p1', 7, 7, 0)])]),
      { timeZone: TZ, minorUnit: 2, start: null }
    );
    expect(t.rows.map((r) => [r.countId, r.opening])).toEqual([['k2', null]]);
    expect(t.sheets.find((s) => s.countId === 'k1')?.lines).toBe(0);
  });

  it('the store’s day of the freeze, not the server’s', () => {
    const t = tallyStatement(input([sheet('k1', '2026-10-01T22:30:00Z', [line('p1', 1, 1, 0)])]), { timeZone: TZ, minorUnit: 2, start: null });
    expect(t.sheets[0].day).toBe('2026-10-02');
  });
});

describe('the cut for a person without the cost key', () => {
  it('omits every value at cost — not zeroed — and never touches the shared answer', () => {
    const t = tallyStatement(
      input([sheet('k1', '2026-10-01T09:00:00Z', [line('p1', 41, 37, 4, 10)])]),
      { timeZone: TZ, minorUnit: 2, start: null }
    );
    const a = { warehouseId: 'wA', warehouseName: 'أ', keepers: [], period: 'all' as const, periodAr: 'الكل', fromDay: null, timeZone: TZ, ...t };
    const cut = keeperStatementShown(a, false);
    expect(JSON.stringify(cut)).not.toMatch(/valueAtCost/);
    expect(cut.seesCost).toBe(false);
    expect(a.rows[0].valueAtCost).toBe(10);
    expect(keeperStatementShown(a, true).total).toMatchObject({ valueAtCost: 10 });
  });
});

describe('what the module may touch', () => {
  it('reads only: no write, and nothing from a wallet, an expense or a profit', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/keeper-statement.ts'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const i of imports) expect(i, i).not.toMatch(/wallet|expense|profit|finance/i);
    expect(src).not.toMatch(/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/);
    expect(src).not.toMatch(/\$executeRaw|\$queryRaw/);
  });
});
