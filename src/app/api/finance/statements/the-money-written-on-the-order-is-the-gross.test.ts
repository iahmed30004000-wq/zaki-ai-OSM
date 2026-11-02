import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * `Order.collectedAmount` IS WHAT THE CUSTOMER PAID, FEE INCLUDED.
 *
 * Measured on this database before a line was changed. Statement approval is
 * the column's ONLY writer, and it wrote `SettlementMatch.statementAmount` —
 * which `schema.prisma:2304` defines as «the NET: what the courier hands over
 * after keeping their fee». The column itself is documented one table over as
 * «what the customer actually paid at the door, and it INCLUDES the full
 * delivery fee».
 *
 * Documented gross, written net, and read by two places that each got a
 * different thing wrong:
 *
 *   `expectedAmountFor` does `collected − fee`, so every settled order's
 *   expectation came out one fee SHORT. Twelve live orders, 2.5 each.
 *
 *   Revenue is `SUM(collectedAmount)` for orders that have one PLUS
 *   `SUM(totalAmount)` for orders that do not. `totalAmount` is gross. So the
 *   two halves of one sum were measured in different units — twelve orders
 *   counted at 231.00 where the gross is 261.000. **Thirty dinars of revenue
 *   nobody spent**, and the same gap in every attribution figure.
 *
 * The arithmetic is asserted below rather than the source alone, because a
 * name is not a behaviour — and the source check that remains is pinned ABSENT
 * rather than merely unused, so the net cannot creep back.
 */

// The write moved, unchanged, out of the approval route into the close of the matching (2/11, «افصل المطابقة عن
// التحصيل»): the approval still runs it when no line is open, and «إغلاق المطابقة» runs it later otherwise.
const ROUTE = join(process.cwd(), 'src/lib/statement-close.ts');
const src = () => stripComments(readFileSync(ROUTE, 'utf8'));

/** The three live shapes, verbatim from the rows this was measured on. */
const LIVE = [
  { order: 'ORD-2026-0029', net: 11.5, fee: 2.5, gross: 14 },
  { order: 'ORD-2026-0030', net: 36, fee: 2.5, gross: 38.5 },
  { order: 'ORD-2026-0031', net: 22.5, fee: 2.5, gross: 25 },
];

/**
 * WHAT THE ROUTE COMPUTES — LIFTED OUT OF THE ROUTE, NOT RETYPED.
 *
 * The first draft of this file retyped the expression into a local helper,
 * and the mutation proved it hollow: putting the net back in the route left
 * every number below green, and only the source assertion at the bottom
 * fired. A test of a copy of the arithmetic is a test of the copy.
 *
 * So the literal right-hand side of `amountOf`'s mapping is read out of the
 * file's bytes and evaluated. What moves under a mutation is the route's own
 * expression, and the failure prints money rather than a missing string.
 */
function routeExpression(): string {
  const text = src();
  const at = text.indexOf('const amountOf = new Map(');
  if (at < 0) throw new Error('`amountOf` is gone from the approval route — rename, or the write moved');
  // The ternary that decides the figure, up to the end of its line.
  const line = text
    .slice(at)
    .split(/\r?\n/)
    .find((l) => l.includes('m.statementAmount == null'));
  if (!line) throw new Error('the figure is no longer decided by a `m.statementAmount == null` ternary');
  return line.replace(/^\s*/, '').replace(/,\s*$/, '');
}

const written = (m: { statementAmount: number | null; statementFee: number | null }) =>
  new Function('m', `return ${routeExpression()};`)(m) as number | null;

describe('the figure approval writes onto the order', () => {
  it('is the gross the customer paid, not the net the courier remits', () => {
    for (const row of LIVE) {
      expect(written({ statementAmount: row.net, statementFee: row.fee }), row.order).toBe(row.gross);
      // The number it used to write, named so a regression prints the gap.
      expect(written({ statementAmount: row.net, statementFee: row.fee }), row.order).not.toBe(row.net);
    }
  });

  it('and the gap it closes is exactly the delivery fee, every time', () => {
    for (const row of LIVE) {
      const gap = written({ statementAmount: row.net, statementFee: row.fee })! - row.net;
      expect(gap, row.order).toBe(row.fee);
    }
    // The twelve live orders, in one figure: 231.00 counted, 261.000 true.
    const before = LIVE.reduce((s, r) => s + r.net, 0);
    const after = LIVE.reduce((s, r) => s + r.gross, 0);
    expect(after - before).toBe(7.5);
  });

  it('survives a statement that reports no fee at all', () => {
    // A courier who keeps nothing states a net that IS the gross. `?? 0` is
    // live here: `statementFee` is nullable in the schema even though it is
    // null on none of the twelve live rows.
    expect(written({ statementAmount: 40, statementFee: null })).toBe(40);
  });

  it('and writes nothing at all when the courier stated nothing', () => {
    // Absent is not zero: an order the statement did not price must keep a
    // null column, which is what lets settlement tell it from a settled one.
    expect(written({ statementAmount: null, statementFee: 2.5 })).toBeNull();
  });

  it('reads the fee from the match, which is why the select must carry it', () => {
    /*
     * The gross is derivable from the match row alone, and that is not a
     * guess: on all twelve live rows `statementAmount + statementFee` equals
     * `StatementLine.collected` exactly, and `statementFee` is null on none.
     * A select that drops it would silently make every gross a net again.
     */
    // The select is the close's own (`closeRowsSelect`), and both doors that close read the rows through it.
    expect(src()).toMatch(/export function closeRowsSelect[\s\S]*?return \{[^}]*statementFee:\s*true/);
    for (const door of ['src/app/api/finance/statements/[id]/route.ts', 'src/app/api/finance/statements/[id]/close/route.ts']) {
      expect(stripComments(readFileSync(join(process.cwd(), door), 'utf8')), door).toMatch(/select:\s*closeRowsSelect\(id\)/);
    }
  });

  it('and the net is pinned ABSENT at the write, not merely unused', () => {
    // `Number(m.statementAmount)` alone is the defect. It may only appear as
    // one half of the sum.
    const text = src();
    expect(text).toContain('Number(m.statementAmount) + Number(m.statementFee ?? 0)');
    expect(text).not.toMatch(/collectedAmount:\s*Number\(m\.statementAmount\)\s*[,}]/);
  });
});
