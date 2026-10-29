import { describe, expect, it } from 'vitest';
import { expensesOf } from './expense-scope';

/**
 * WHICH EXPENSES A STORE'S PROFIT SUBTRACTS — the one definition, evaluated.
 *
 * The three readers (the profit screen, the analytics profit line, the analytics vitals count) all ask this. It
 * is evaluated here against rows rather than compared with a literal, so a rule that drifts is a wrong total.
 */

type Row = { id: string; companyId: string; storeId: string | null; amount: number; voidedAt: Date | null };

const ROWS: Row[] = [
  { id: 'e1', companyId: 'c1', storeId: 's1', amount: 100, voidedAt: null },
  { id: 'e2', companyId: 'c1', storeId: 's2', amount: 70, voidedAt: null },
  { id: 'e3', companyId: 'c1', storeId: null, amount: 40, voidedAt: null },
  { id: 'e4', companyId: 'c1', storeId: 's1', amount: 25, voidedAt: new Date('2026-10-14') },
  { id: 'x1', companyId: 'c2', storeId: null, amount: 9999, voidedAt: null },
];

function pick(where: ReturnType<typeof expensesOf>): string[] {
  const w = where as Record<string, unknown>;
  const hit = (row: Row) =>
    row.companyId === w.companyId &&
    (!('OR' in w) || (w.OR as { storeId: string | null }[]).some((o) => o.storeId === row.storeId)) &&
    (!('voidedAt' in w) || row.voidedAt === w.voidedAt);
  return ROWS.filter(hit).map((r) => r.id);
}

describe('expensesOf', () => {
  it('a store gets its own and the ones from before stores, and nothing of another store or company', () => {
    expect(pick(expensesOf('c1', 's1'))).toEqual(['e1', 'e3']);
    expect(pick(expensesOf('c1', 's2'))).toEqual(['e2', 'e3']);
  });

  it('NEGATIVE: a store that has recorded nothing sees only the old ones — never another store’s', () => {
    expect(pick(expensesOf('c1', 's-new'))).toEqual(['e3']);
  });

  it('with no store (a company-wide report) every live expense of the company counts', () => {
    expect(pick(expensesOf('c1', null))).toEqual(['e1', 'e2', 'e3']);
    expect(pick(expensesOf('c1', undefined))).toEqual(['e1', 'e2', 'e3']);
  });

  it('a cancelled expense costs nothing, anywhere', () => {
    for (const store of ['s1', 's2', null]) expect(pick(expensesOf('c1', store))).not.toContain('e4');
  });

  it('the list asks for the cancelled ones too — and only the list', () => {
    expect(pick(expensesOf('c1', 's1', { withCancelled: true }))).toEqual(['e1', 'e3', 'e4']);
    expect('voidedAt' in expensesOf('c1', 's1', { withCancelled: true })).toBe(false);
    expect(expensesOf('c1', 's1')).toMatchObject({ voidedAt: null });
  });

  it('the company is always in the question', () => {
    expect(expensesOf('c1', 's1').companyId).toBe('c1');
    expect(expensesOf('c1', null).companyId).toBe('c1');
    expect(expensesOf('c1', 's1', { withCancelled: true }).companyId).toBe('c1');
  });
});
