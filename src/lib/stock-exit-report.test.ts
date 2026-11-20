import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitMonthShown, isUncosted, resolveExitMonth, tallyExitMonth, type ExitMonthRows } from './stock-exit-report';

/**
 * THE MONTH'S EXITS, PURE PARTS (W6b) — the store's month, the tally, and what a person without the cost key reads.
 * The door and its reads are proved end to end in `src/app/api/inventory/exits/month/month-door.test.ts`.
 */

const TZ = 'Asia/Amman';

describe('the store’s month', () => {
  it('no month is this month of the STORE: 22:30 UTC on 31 October is already November in Amman', () => {
    const v = resolveExitMonth(null, new Date('2026-10-31T22:30:00.000Z'), TZ);
    expect(v).toMatchObject({ ok: true, month: '2026-11', current: true, next: null, prev: '2026-10' });
  });

  it('the month runs from the store’s midnight of the 1st to the next 1st', () => {
    const v = resolveExitMonth('2026-02', new Date('2026-11-20T10:00:00.000Z'), TZ);
    if (!v.ok) throw new Error('refused');
    expect(v.start.toISOString()).toBe('2026-01-31T21:00:00.000Z');
    expect(v.end.toISOString()).toBe('2026-02-28T21:00:00.000Z');
    expect(v).toMatchObject({ monthAr: 'شباط 2026', prev: '2026-01', next: '2026-03' });
  });

  it('December’s neighbour is the next year’s January, and January’s is the last December', () => {
    const now = new Date('2027-03-01T10:00:00.000Z');
    expect(resolveExitMonth('2026-12', now, TZ)).toMatchObject({ next: '2027-01', prev: '2026-11', monthAr: 'كانون الأول 2026' });
    expect(resolveExitMonth('2027-01', now, TZ)).toMatchObject({ prev: '2026-12', next: '2027-02' });
  });

  it('NEGATIVE: malformed and future months are refused with their codes', () => {
    const now = new Date('2026-11-20T10:00:00.000Z');
    for (const bad of ['2026-00', '2026-13', '26-11', '2026-11-01', 'x']) {
      expect(resolveExitMonth(bad, now, TZ), bad).toMatchObject({ ok: false, code: 'INVALID_MONTH' });
    }
    expect(resolveExitMonth('2026-12', now, TZ)).toMatchObject({ ok: false, code: 'MONTH_IN_FUTURE' });
  });
});

const rows = (lines: { reason: string; productId: string; quantity: number; valueAtCost: number | null }[]): ExitMonthRows => ({
  exits: lines.map((l, i) => ({
    id: `e${i}`,
    warehouseId: 'w1',
    reason: l.reason,
    note: null,
    requestedById: 'u1',
    decidedById: 'u2',
    decidedAt: new Date(`2026-11-0${(i % 9) + 1}T08:00:00.000Z`),
    lines: [{ productId: l.productId, quantity: l.quantity, valueAtCost: l.valueAtCost, product: { name: l.productId } }],
  })),
  people: new Map([
    ['u1', 'سارة'],
    ['u2', 'منى'],
  ]),
  places: new Map([['w1', 'مخزن الشمال']]),
  truncated: false,
});

describe('the tally', () => {
  it('sums per reason in the reasons’ own order, rounds each total ONCE to the minor unit', () => {
    const t = tallyExitMonth(
      rows([
        { reason: 'OTHER', productId: 'p1', quantity: 1, valueAtCost: 0.1 },
        { reason: 'DAMAGED', productId: 'p1', quantity: 2, valueAtCost: 0.1 },
        { reason: 'DAMAGED', productId: 'p2', quantity: 3, valueAtCost: 0.2 },
      ]),
      2
    );
    expect(t.reasons.map((r) => r.reason)).toEqual(['DAMAGED', 'OTHER']);
    // 0.1 + 0.2 is 0.30000000000000004 in floating point: the total is rounded, never left raw.
    expect(t.reasons[0]).toEqual({ reason: 'DAMAGED', reasonAr: 'تالف', quantity: 5, lines: 2, valueAtCost: 0.3, uncostedLines: 0 });
    expect(t.total).toEqual({ quantity: 6, lines: 3, valueAtCost: 0.4, uncostedLines: 0 });
    expect(t.exits).toBe(3);
    expect(t.lines[0]).toMatchObject({ requestedByName: 'سارة', decidedByName: 'منى', warehouseName: 'مخزن الشمال', reasonAr: 'أخرى' });
  });

  it('NEGATIVE: an uncosted line (zero or no figure) is «بلا كلفة» — counted apart, never summed in as a zero', () => {
    expect(isUncosted(null)).toBe(true);
    expect(isUncosted(0)).toBe(true);
    expect(isUncosted(0.001)).toBe(false);
    const t = tallyExitMonth(
      rows([
        { reason: 'EXPIRED', productId: 'p1', quantity: 2, valueAtCost: 5 },
        { reason: 'EXPIRED', productId: 'p2', quantity: 3, valueAtCost: 0 },
        { reason: 'EXPIRED', productId: 'p3', quantity: 4, valueAtCost: null },
      ]),
      3
    );
    expect(t.lines.map((l) => [l.valueAtCost, l.uncosted])).toEqual([
      [5, false],
      [null, true],
      [null, true],
    ]);
    expect(t.total).toEqual({ quantity: 9, lines: 3, valueAtCost: 5, uncostedLines: 2 });
  });

  it('a month with nothing is zeros and no reason rows', () => {
    const t = tallyExitMonth(rows([]), 2);
    expect(t).toEqual({ exits: 0, lines: [], reasons: [], total: { quantity: 0, lines: 0, valueAtCost: 0, uncostedLines: 0 }, truncated: false });
  });
});

describe('what a person reads', () => {
  const answer = {
    month: '2026-11',
    monthAr: 'تشرين الثاني 2026',
    current: true,
    prev: '2026-10',
    next: null,
    timeZone: TZ,
    ...tallyExitMonth(
      rows([
        { reason: 'EXPIRED', productId: 'p1', quantity: 2, valueAtCost: 5 },
        { reason: 'EXPIRED', productId: 'p2', quantity: 3, valueAtCost: null },
      ]),
      2
    ),
  };

  it('NEGATIVE: without the cost key every cost field is OMITTED — lines, reasons and the total', () => {
    const shown = exitMonthShown(answer, false);
    const text = JSON.stringify(shown);
    expect(text).not.toContain('valueAtCost');
    expect(text).not.toContain('uncosted');
    expect(shown.total).toEqual({ quantity: 5, lines: 2 });
    expect(shown.lines).toHaveLength(2);
    expect(shown.seesCost).toBe(false);
  });

  it('and the shared answer is never mutated by cutting it for one person', () => {
    const before = JSON.stringify(answer);
    exitMonthShown(answer, false);
    expect(JSON.stringify(answer)).toBe(before);
    expect(exitMonthShown(answer, true)).toMatchObject({ seesCost: true, total: { valueAtCost: 5, uncostedLines: 1 } });
  });
});

describe('the report writes nothing and touches no money', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/stock-exit-report.ts'), 'utf8');

  it('no wallet, expense, profit or settlement import', () => {
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.filter((i) => /wallet|expense|profit|financ|commission|settlement/i.test(i))).toEqual([]);
  });

  it('no write of any kind', () => {
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/);
  });
});
