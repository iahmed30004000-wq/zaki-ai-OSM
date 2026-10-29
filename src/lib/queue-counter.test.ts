import { describe, expect, it, vi } from 'vitest';
import { duePostponedWhere, readyToPullWhere, waitingCount, postponedNotDueCount } from './confirmation-queue';
import { repoFile, stripComments } from './guard-source';

/**
 * THE COUNTER COUNTS WHAT THE BUTTON CAN ACTUALLY HAND OVER.
 *
 * A postponed order whose day has not come is waiting, and must not be
 * given to anybody — the customer asked to be rung on Thursday. The picker
 * always honoured that; the counter did not. So a pool holding nothing but
 * far-off promises showed «٣ طلبات بانتظار التأكيد» above a live button
 * that answered «لا توجد طلبات» every single press.
 *
 * That is the shape of the report: «بعدين ببطل أقدر أسحب أي طلب جديد» —
 * a number that promises work, and a button that never yields any.
 */

const SCOPE = { companyId: 'c1', storeId: 's1' };
const NOW = new Date('2026-09-28T09:00:00Z');

describe('the two predicates', () => {
  it('take a postponed order only once its day is near', () => {
    const w = duePostponedWhere(SCOPE, NOW) as Record<string, unknown>;
    expect(w.confirmationStatus).toBe('POSTPONED');
    expect(w.claimedById).toBeNull();
    const or = w.OR as { postponedUntil?: { lte: Date }; nextFollowUpAt?: { lte: Date } }[];
    const lead = or[0].postponedUntil!.lte;
    // The window opens ahead of the date, never behind it.
    expect(lead.getTime()).toBeGreaterThan(NOW.getTime());
    // Both dates are honoured: «تأجيل» writes one or the other — and the follow-up date counts only for an order with
    // NO postponement date (RV79): the screen shows `postponedUntil ?? nextFollowUpAt`, and the counter must agree.
    expect(or[1].nextFollowUpAt).toBeTruthy();
    expect((or[1] as { postponedUntil?: unknown }).postponedUntil, 'تاريخ المتابعة يسبق تاريخ التأجيل').toBeNull();
  });

  it('and everything else regardless of a date', () => {
    const w = readyToPullWhere(SCOPE) as Record<string, unknown>;
    expect(w.confirmationStatus).toEqual({ not: 'POSTPONED' });
    expect(w.shippingStatus).toBe('NOT_READY');
    expect(w.claimedById).toBeNull();
  });
});

describe('the waiting number', () => {
  it('is the sum of exactly those two, and nothing else', async () => {
    const seen: unknown[] = [];
    const tx = {
      order: {
        count: vi.fn(async ({ where }: { where: unknown }) => {
          seen.push(where);
          return 1;
        }),
      },
    } as never;

    await waitingCount(tx, SCOPE, NOW);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(duePostponedWhere(SCOPE, NOW));
    expect(seen[1]).toEqual(readyToPullWhere(SCOPE));
  });

  it('and the far-off promises are counted apart, not folded in', async () => {
    let asked: Record<string, unknown> = {};
    const tx = {
      order: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          asked = where;
          return 3;
        }),
      },
    } as never;

    expect(await postponedNotDueCount(tx, SCOPE, NOW)).toBe(3);
    expect(asked.confirmationStatus).toBe('POSTPONED');
    /**
     * THE COMPLEMENT OF «DUE», UNDER THE SCREEN'S OWN READING OF «WHEN» (RV79).
     *
     * Was: both dates beyond the window (`asked.AND`, two clauses) — the complement of «either date reached», which the
     * due predicate used to be. The due predicate now reads `postponedUntil ?? nextFollowUpAt`, as the postponed list
     * prints it: the postponement date decides when there is one, the follow-up date only when there is not. So this one
     * is its complement the same way, or an order would be counted twice (ready and waiting) or in neither.
     */
    const or = asked.OR as unknown[];
    expect(or).toHaveLength(2);
    const clauses = JSON.stringify(or);
    expect(clauses, 'العدُّ يشمل ما حان موعده').toContain('"gt"');
    expect(clauses, 'العدُّ يعدّ ما هو جاهزٌ للسحب').not.toContain('"lte"');
    expect(asked.AND, 'الشرطان القديمان (كلا التاريخين) عادا').toBeUndefined();
  });
});

/**
 * RV79 — THE TWO COUNTS PARTITION THE POSTPONED ORDERS, ROW BY ROW.
 *
 * A tiny reader of the clause shapes these two predicates use (`{ field: { lte|gt: Date } }`, `{ field: null }`, `{ OR }`),
 * run over every combination of the two dates. For each: it is due exactly when the screen's date
 * (`postponedUntil ?? nextFollowUpAt`) is inside the window, it is NOT-due exactly when it is not, and never both.
 * The old pair counted a row with a far postponement date and a near follow-up date as due — the screen showed it far.
 */
describe('RV79 — due and waiting-on-a-date are one question asked from both sides', () => {
  const lead = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
  const NEAR = new Date(NOW.getTime() + 60 * 60 * 1000);
  const FAR = new Date(NOW.getTime() + 20 * 24 * 60 * 60 * 1000);
  type Row = { postponedUntil: Date | null; nextFollowUpAt: Date | null };

  function holds(clause: unknown, row: Row): boolean {
    const c = clause as Record<string, unknown>;
    return Object.entries(c).every(([key, want]) => {
      if (key === 'OR') return (want as unknown[]).some((sub) => holds(sub, row));
      const value = row[key as keyof Row];
      if (want === null) return value === null;
      const w = want as { lte?: Date; gt?: Date };
      if (value === null) return false;
      if (w.lte) return value.getTime() <= w.lte.getTime();
      if (w.gt) return value.getTime() > w.gt.getTime();
      throw new Error('a clause this reader does not know: ' + key);
    });
  }

  const counted = async () => {
    let asked: Record<string, unknown> = {};
    await postponedNotDueCount({ order: { count: async ({ where }: { where: Record<string, unknown> }) => { asked = where; return 0; } } } as never, SCOPE, NOW);
    return asked;
  };

  const DATES: (Date | null)[] = [null, NEAR, FAR];
  const rows: Row[] = DATES.flatMap((postponedUntil) => DATES.map((nextFollowUpAt) => ({ postponedUntil, nextFollowUpAt })));

  it.each(rows.map((r, i) => [i, r] as const))('row %i: due ⇔ the screen\'s date is inside the window; never both', async (_i, row) => {
    const due = holds({ OR: (duePostponedWhere(SCOPE, NOW) as { OR: unknown[] }).OR }, row);
    const waiting = holds({ OR: (await counted()).OR }, row);
    const shown = row.postponedUntil ?? row.nextFollowUpAt;
    expect(due, JSON.stringify(row)).toBe(shown !== null && shown.getTime() <= lead.getTime());
    expect(due && waiting, 'العدّاد يعدّه مرّتين').toBe(false);
    // Nothing falls between them either: a dated order is exactly one of the two.
    if (shown !== null) expect(due || waiting).toBe(true);
  });

  it('وطلبٌ بتأجيلٍ بعيد ومتابعةٍ قريبة غير مستحَقّ — الشاشة تعرضه بالبعيد', () => {
    expect(holds({ OR: (duePostponedWhere(SCOPE, NOW) as { OR: unknown[] }).OR }, { postponedUntil: FAR, nextFollowUpAt: NEAR })).toBe(false);
  });
});

describe('the picker and the counter', () => {
  it('draw from the same two predicates', () => {
    const src = stripComments(repoFile('src/lib/confirmation-queue.ts'));
    const at = src.indexOf('export async function pickNextCandidate');
    const body = src.slice(at, src.indexOf('\nexport', at + 10));
    expect(body).toContain('duePostponedWhere(scope, now)');
    expect(body).toContain('readyToPullWhere(scope)');
    // No third opinion about what is takeable.
    expect(body, 'المنتقي يكتب شرطَه بنفسه').not.toMatch(/claimedById: null/);
  });

  it('and the screen says which number is which', () => {
    const src = stripComments(repoFile('src/components/confirmation/PullPanel.tsx'));
    expect(src).toContain('طلب جاهز للسحب الآن');
    // The RENDER, not merely the field's declaration: a block switched off
    // still leaves the name in the interface above it.
    expect(src, 'الرقمُ المؤجَّل لا يُعرَض').toMatch(/!!data\.waitingOnADate && \(/);
    expect(src).toContain('مؤجَّلة حتى موعدها');
  });
});
