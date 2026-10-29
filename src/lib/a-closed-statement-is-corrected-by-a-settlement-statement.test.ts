import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from './guard-source';

vi.mock('./db', () => ({ db: {} }));

import {
  STATEMENT_CLOSED_SENTENCE,
  approvalRefusal,
  closedStatementRefusal,
  editRefusal,
  openLinesSentence,
  rematchRefusal,
  receiptEditRefusal,
  undoImportRefusal,
} from './settlement-gates';
import { countOpenLines, isOpenLine, mayOnlyBeParked, openLineWhere } from './statement-open-lines';
import { claimsFromRows, decisionMatrix } from './settlement-decisions';
import { judgeLine } from './settlement';
import { SWAP_WHY } from './parcel-swap';

/**
 * THE LOCK — a statement, once approved, is closed for good, and the correction is a settlement statement.
 *
 * «ينغلق نهائيا… مش هيك الأفضل؟» — yes. Three things hold it, and each is tested here by what it DOES:
 *
 *   1. The gate waits for the lines that are a question, and for no others — and the counter beside each
 *      statement is the same rule, not a second copy of it.
 *   2. Every door that would change an approved statement answers with ONE sentence, from ONE function.
 *   3. Every door that writes a statement is KNOWN, and each carries the condition `approvedAt: null` in the
 *      write itself — not only in a read before it.
 */

const SRC = join(process.cwd(), 'src');
const rel = (p: string) => `/${relative(process.cwd(), p).split('\\').join('/')}`;
const code = (path: string) => stripComments(readFileSync(join(process.cwd(), path), 'utf8'));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/* ───────────────────────────── 1. what the gate counts ───────────────────────────── */

describe('the lines the approval waits for', () => {
  const rows: { name: string; row: { result: string; resolution?: string | null; orderId?: string | null }; open: boolean }[] = [
    { name: 'a difference nobody answered', row: { result: 'MISMATCHED', orderId: 'o1' }, open: true },
    { name: 'a difference answered «اعتُمد رقم الشركة»', row: { result: 'MISMATCHED', orderId: 'o1', resolution: 'ACCEPTED_COURIER' }, open: false },
    { name: 'a difference answered «رقمنا»', row: { result: 'MISMATCHED', orderId: 'o1', resolution: 'OURS_STANDS' }, open: false },
    { name: 'a difference answered «قيد المراجعة»', row: { result: 'MISMATCHED', orderId: 'o1', resolution: 'UNDER_REVIEW' }, open: false },
    { name: 'a line no order carries, nobody linked or parked', row: { result: 'MISSING_IN_SYSTEM', orderId: null }, open: true },
    { name: 'a line no order carries, parked with its reason', row: { result: 'MISSING_IN_SYSTEM', orderId: null, resolution: 'UNDER_REVIEW' }, open: false },
    { name: 'a line a person tied to an order and it matched', row: { result: 'MATCHED', orderId: 'o2' }, open: false },
    { name: 'a clean match', row: { result: 'MATCHED', orderId: 'o3' }, open: false },
    { name: 'a parcel no statement names (the sweep) — a list to chase on the ORDER, not a line of this statement', row: { result: 'MISSING_IN_STATEMENT', orderId: 'o4' }, open: false },
  ];

  it.each(rows)('$name → $open', ({ row, open }) => {
    expect(isOpenLine(row)).toBe(open);
  });

  it('counts only the open ones', () => {
    expect(countOpenLines(rows.map((r) => r.row))).toBe(rows.filter((r) => r.open).length);
    expect(countOpenLines([])).toBe(0);
  });

  it('the filter the list counts with says the same as the function the approval counts with — row by row', () => {
    // A tiny reading of the filter's own language (equality, null, OR): enough to hold it to `isOpenLine`.
    const reads = (w: Record<string, unknown>, row: Record<string, unknown>): boolean =>
      Object.entries(w).every(([k, v]) => {
        if (k === 'OR') return (v as Record<string, unknown>[]).some((alt) => reads(alt, row));
        return (row[k] ?? null) === v;
      });
    const where = openLineWhere() as Record<string, unknown>;
    for (const { row } of rows) {
      expect(reads(where, row), JSON.stringify(row)).toBe(isOpenLine(row));
    }
  });

  it('a line no order carries may be parked and nothing else; a line with an order may not be parked as one', () => {
    expect(mayOnlyBeParked({ result: 'MISSING_IN_SYSTEM', orderId: null })).toBe(true);
    expect(mayOnlyBeParked({ result: 'MISSING_IN_SYSTEM', orderId: 'o1' })).toBe(false);
    expect(mayOnlyBeParked({ result: 'MISMATCHED', orderId: 'o1' })).toBe(false);
    expect(mayOnlyBeParked({ result: 'MISSING_IN_STATEMENT', orderId: 'o1' })).toBe(false);
  });
});

describe('a zero line has no rule of its own — it is one of the two kinds above, or it is nobody’s question', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    id: 'o1',
    shippingStatus: 'DELIVERED',
    settlementStatus: 'PENDING_COLLECTION',
    totalAmount: 20,
    priceIncludesDelivery: false,
    collectedAmount: null,
    deliveryFee: 0,
    returnReceipt: null,
    addOns: [],
    items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, deliveredQty: null }],
    ...over,
  });
  const verdict = (o: ReturnType<typeof order>, amount: number) =>
    judgeLine({
      order: o as never,
      line: { amount },
      minorUnit: 3,
      integrity: { claimedByAnotherLine: false, otherStatements: [], openRequests: [] },
    });

  it('a line of 0 against a parcel we delivered is a MISMATCHED row — open until a person answers it', () => {
    const v = verdict(order(), 0);
    expect(v.result).toBe('MISMATCHED');
    expect(isOpenLine({ result: v.result, orderId: 'o1' })).toBe(true);
  });

  it('a line of 0 that names no order is a MISSING_IN_SYSTEM row — open until it is tied or parked', () => {
    expect(isOpenLine({ result: 'MISSING_IN_SYSTEM', orderId: null })).toBe(true);
  });

  it('a line of 0 against a parcel that came back is MATCHED — it asks nothing, and does not hold the approval', () => {
    const v = verdict(order({ shippingStatus: 'RETURNED' }), 0);
    expect(v.result).toBe('MATCHED');
    expect(isOpenLine({ result: v.result, orderId: 'o1' })).toBe(false);
  });
});

/* ───────────────────────────── 2. the gate, and the counter that follows it ───────────────────────────── */

describe('the approval gate', () => {
  const ready = {
    status: 'MATCHED', approvedAt: null, receipts: 1, matches: 4,
    gap: { gap: 0, needsExplanation: false, unconvertible: 0 }, explanation: null,
  };

  it('refuses while any line is a question, and says how many', () => {
    const r = approvalRefusal({ ...ready, openLines: 3 });
    expect(r).toEqual({ code: 'OPEN_LINES', error: openLinesSentence(3) });
    expect(r?.error).toContain('3');
    expect(r?.error).toContain('يُغلق نهائياً');
  });

  it('passes when none is — and an old caller that passes no count reads it as none', () => {
    expect(approvalRefusal({ ...ready, openLines: 0 })).toBeNull();
    expect(approvalRefusal(ready)).toBeNull();
  });

  it('comes AFTER the older gates: no receipt, no rate, no explanation, no matching say their own sentence first', () => {
    expect(approvalRefusal({ ...ready, receipts: 0, openLines: 2 })?.code).toBe('NO_RECEIPTS');
    expect(approvalRefusal({ ...ready, matches: 0, openLines: 2 })?.code).toBe('MATCHING_REQUIRED');
    expect(approvalRefusal({ ...ready, gap: { gap: 4, needsExplanation: true, unconvertible: 0 }, openLines: 2 })?.code).toBe(
      'GAP_REQUIRES_EXPLANATION'
    );
  });

  it('the counter and the gate are one number: whatever the counter shows is what the button refuses with', () => {
    const matches = rows();
    const n = countOpenLines(matches);
    expect(n).toBe(2);
    expect(approvalRefusal({ ...ready, matches: matches.length, openLines: n })?.error).toBe(openLinesSentence(2));

    // …and answering one of them lowers both by one.
    const answered = matches.map((m, i) => (i === 0 ? { ...m, resolution: 'UNDER_REVIEW' } : m));
    expect(countOpenLines(answered)).toBe(1);
    expect(approvalRefusal({ ...ready, matches: answered.length, openLines: countOpenLines(answered) })?.error).toBe(openLinesSentence(1));
  });

  function rows() {
    return [
      { result: 'MISMATCHED', orderId: 'o1', resolution: null },
      { result: 'MISSING_IN_SYSTEM', orderId: null, resolution: null },
      { result: 'MATCHED', orderId: 'o2', resolution: null },
      { result: 'MISSING_IN_STATEMENT', orderId: 'o3', resolution: null },
    ];
  }

  it('the list counts with the same function, and both screens hand that count to the same gate', () => {
    expect(code('src/app/api/finance/statements/route.ts')).toContain('...openLineWhere()');
    expect(code('src/components/screens/finance/CollectionScreen.tsx')).toContain('openLines: s.counts.openLines');
    // The route counts at BOTH places it asks the gate: the read before, and the rows its own transaction read after the claim.
    const route = code('src/app/api/finance/statements/[id]/route.ts');
    expect(route.match(/openLines: countOpenLines\(/g)).toHaveLength(2);
    expect(route).toContain('countOpenLines(statement.matches)');
    expect(route).toContain('countOpenLines(matches)');
  });

  it('the matching screen’s chips count by the same function', () => {
    expect(code('src/components/screens/finance/MatchingScreen.tsx')).toContain('countOpenLines(rows)');
  });
});

/* ───────────────────────────── 3. one sentence ───────────────────────────── */

describe('one sentence, from one function', () => {
  const approved = { status: 'APPROVED', approvedAt: new Date('2026-10-28T00:00:00Z') };

  it('the sentence is what the owner said', () => {
    expect(STATEMENT_CLOSED_SENTENCE).toBe('الكشف مغلق نهائياً — التصحيح بكشف تسوية');
    expect(closedStatementRefusal()).toEqual({ code: 'ALREADY_APPROVED', error: STATEMENT_CLOSED_SENTENCE });
  });

  it('rematch, undo, receipt edit and the generic edit door all answer with it — by the stamp or by the status', () => {
    for (const s of [approved, { status: 'MATCHED', approvedAt: '2026-10-28T00:00:00Z' }, { status: 'APPROVED' }]) {
      for (const door of [editRefusal, rematchRefusal, undoImportRefusal, receiptEditRefusal]) {
        expect(door(s)).toEqual(closedStatementRefusal());
      }
    }
  });

  it('and none of them refuses a statement that is still open', () => {
    for (const door of [editRefusal, rematchRefusal, undoImportRefusal, receiptEditRefusal]) {
      expect(door({ status: 'MATCHED', approvedAt: null })).toBeNull();
    }
  });

  it('a decision on a closed statement is refused for every saying, whatever the order is', () => {
    const f = { hasOrder: true, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', openRequests: [], claimedElsewhere: false, statementApproved: true, expectedAmount: 20, statementAmount: 18, minorUnit: 3 };
    for (const v of Object.values(decisionMatrix(f))) {
      expect(v).toEqual({ allowed: false, why: STATEMENT_CLOSED_SENTENCE });
    }
  });

  it('the parcel swap says it from the same constant', () => {
    expect(SWAP_WHY.approved).toBe(STATEMENT_CLOSED_SENTENCE);
  });

  it('no door of the statement keeps a sentence of its own for it (the old ones are gone)', () => {
    const doors = [
      'src/lib/settlement-gates.ts',
      'src/lib/hand-link.ts',
      'src/lib/parcel-swap.ts',
      'src/lib/manual-statement.ts',
      'src/app/api/finance/statements/[id]/route.ts',
      'src/app/api/finance/statements/[id]/match/route.ts',
      'src/app/api/finance/statements/[id]/decisions/route.ts',
      'src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts',
    ];
    for (const d of doors) {
      const src = code(d);
      expect(src, d).not.toContain('بقيد عكسي');
      expect(src, d).not.toContain('الكشف معتمد —');
      expect(src, d).not.toContain('الكشف انعتمد');
    }
  });
});

/* ───────────────────────────── 4. every door that writes a statement is known ───────────────────────────── */

/** The text of every call of `…<what>.<verb>(…)` in a source, parentheses balanced, strings skipped. */
function calls(src: string, re: RegExp): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  for (const m of src.matchAll(re)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let quote: string | null = null;
    let end = open;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    out.push({ text: src.slice(open, end + 1), at: m.index ?? 0 });
  }
  return out;
}

const WRITE = /\b(settlementMatch|courierStatement|statementReceipt|statementLine)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/g;
const EDIT = /\b(settlementMatch|courierStatement|statementReceipt|statementLine)\.(update|updateMany|delete|deleteMany|upsert)\(/g;
const CLAIM = /\bcourierStatement\.updateMany\(/g;

/**
 * EVERY FILE THAT WRITES A STATEMENT, ROW OR LINE, AND HOW IT KEEPS AN APPROVED ONE OUT.
 *
 *   own     every edit carries `approvedAt: null` in its OWN call (the write says it, not a read before it).
 *   claim   the edits are inside a transaction that begins with a `courierStatement.updateMany` carrying
 *           `approvedAt: null` — taken first, so it holds the row, and every write after it is the claim's.
 *   claim-last   the same claim, taken after the draft’s lines: a statement that is not open fails it and the whole
 *           transaction rolls back (a draft is never approved — the approval refuses it).
 *   creates only NEW statements and lines; there is nothing approved to edit.
 *   engine  the matching: it is called only from a door that has taken the claim above (tested below).
 */
const WRITERS: Record<string, { how: 'own' | 'claim' | 'claim-last' | 'creates' | 'engine'; why: string }> = {
  '/src/app/api/finance/statements/route.ts': { how: 'creates', why: 'the import: a new statement and its lines' },
  '/src/app/api/finance/statements/[id]/route.ts': { how: 'own', why: 'the explanation, the approval itself (its claim), the removal of an import' },
  '/src/app/api/finance/statements/[id]/match/route.ts': { how: 'own', why: 're-running the matching: the status write comes first and carries the condition' },
  '/src/app/api/finance/statements/[id]/decisions/route.ts': { how: 'own', why: 'the bulk answer' },
  '/src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts': { how: 'own', why: 'the answer on one line' },
  '/src/app/api/finance/statements/[id]/receipts/route.ts': { how: 'claim', why: 'a new receipt' },
  '/src/app/api/finance/statements/[id]/receipts/[receiptId]/route.ts': { how: 'claim', why: 'removing a receipt' },
  '/src/app/api/finance/statements/[id]/receipts/[receiptId]/proof/route.ts': { how: 'claim', why: 'replacing the paper behind a receipt' },
  '/src/lib/hand-link.ts': { how: 'own', why: 'tying a line to an order by hand' },
  '/src/lib/parcel-swap.ts': { how: 'own', why: '«كان من طرد طلب آخر»' },
  '/src/lib/manual-statement.ts': { how: 'claim-last', why: 'the manual statement: press 1 writes the draft’s lines, press 2 gathers it (its own claim)' },
  '/src/lib/settlement.ts': { how: 'engine', why: 'runMatching: rewrites the machine’s rows; called under a claim' },
};

describe('every door that writes a statement is known — and a new one is a decision, not a diff', () => {
  const found = filesUnder(SRC)
    .filter((p) => new RegExp(WRITE.source).test(stripComments(readFileSync(p, 'utf8'))))
    .map(rel)
    .sort();

  it('finds them at all (a sweep over nothing passes everything inside it)', () => {
    expect(found.length).toBeGreaterThanOrEqual(10);
  });

  it('and they are exactly the known ones', () => {
    expect(found).toEqual(Object.keys(WRITERS).sort());
  });

  const doorsOf = (how: string) => Object.entries(WRITERS).filter(([, w]) => w.how === how).map(([f]) => f);

  it.each(doorsOf('own'))('%s — every edit says approvedAt: null in its own call', (file) => {
    const src = code(file.slice(1));
    const edits = calls(src, new RegExp(EDIT.source, 'g'));
    expect(edits.length, 'the file edits something').toBeGreaterThan(0);
    for (const e of edits) {
      expect(e.text, `${file}: ${e.text.slice(0, 120)}`).toMatch(/approvedAt: null/);
    }
  });

  it.each(doorsOf('claim'))('%s — the claim is taken before the first edit, and a lost claim stops it', (file) => {
    const src = code(file.slice(1));
    const claims = calls(src, new RegExp(CLAIM.source, 'g'));
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0].text).toMatch(/approvedAt: null/);
    const firstEdit = calls(src, new RegExp(WRITE.source.replace('courierStatement|', ''), 'g'))[0];
    expect(firstEdit, 'the file edits something besides the claim').toBeTruthy();
    expect(claims[0].at).toBeLessThan(firstEdit.at);
    expect(src).toMatch(/\.count !== 1|count === 0|count !== 1/);
  });

  it('the manual statement: the claim after the draft’s lines carries approvedAt: null and refuses with the closed sentence', () => {
    const src = code('src/lib/manual-statement.ts');
    const claims = calls(src, new RegExp(CLAIM.source, 'g'));
    expect(claims).toHaveLength(2);
    for (const c of claims) expect(c.text).toMatch(/approvedAt: null/);
    expect(src).toContain('closedStatementRefusal()');
  });

  it('the engine is only called under a claim: the match route takes it first, the approval takes it first', () => {
    const match = code('src/app/api/finance/statements/[id]/match/route.ts');
    expect(match.indexOf('courierStatement.updateMany')).toBeGreaterThan(-1);
    expect(match.indexOf('courierStatement.updateMany')).toBeLessThan(match.indexOf('runMatching('));
    const approval = code('src/app/api/finance/statements/[id]/route.ts');
    expect(approval.indexOf('tx.courierStatement.updateMany')).toBeLessThan(approval.indexOf('await runMatching('));
    // No other file calls it.
    const callers = filesUnder(SRC)
      .filter((p) => /\brunMatching\(/.test(stripComments(readFileSync(p, 'utf8'))))
      .map(rel)
      .filter((f) => f !== '/src/lib/settlement.ts');
    expect(callers.sort()).toEqual([
      '/src/app/api/finance/statements/[id]/match/route.ts',
      '/src/app/api/finance/statements/[id]/route.ts',
    ]);
  });

  it('the doors that read the stamp first say the closed sentence from the one function', () => {
    for (const f of [
      'src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts',
      'src/app/api/finance/statements/[id]/decisions/route.ts',
    ]) {
      const src = code(f);
      expect(src, f).toContain('closedStatementRefusal()');
      expect(src, f).toMatch(/isApproved\(statement\)/);
      // …and the lock comes before the stamp is read.
      expect(src.indexOf('FOR UPDATE'), f).toBeLessThan(src.indexOf('isApproved(statement)'));
    }
  });
});

/* ───────────────────────────── 5. the correction goes through the approval door ───────────────────────────── */

describe('the correction of a closed statement is a settlement statement — through the same approval door', () => {
  it('a claim left open by the closed statement is paid by a line of the later one, which is clean and asks nothing', () => {
    // The closed statement’s answer: an order of 20.000, the company paid 18.000, «رقمنا». The claim: 2.000.
    const claims = claimsFromRows(
      [{ orderId: 'o1', expectedAmount: 20, statementAmount: 18, statementFee: 0, statement: { approvedAt: new Date('2026-10-20T00:00:00Z') } }],
      3
    );
    const remaining = claims.get('o1')!.remaining;
    expect(remaining).toBe(2);

    const v = judgeLine({
      order: {
        id: 'o1', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', totalAmount: 20, priceIncludesDelivery: false,
        collectedAmount: null, deliveryFee: 0, returnReceipt: null, addOns: [],
        items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, deliveredQty: null }],
      } as never,
      line: { amount: 2 },
      minorUnit: 3,
      integrity: { claimedByAnotherLine: false, otherStatements: [], openRequests: [] },
      openClaim: remaining,
    });
    expect(v.result).toBe('MATCHED');

    // The settlement statement has no open line, so the approval door lets it through…
    const rowsOfIt = [{ result: v.result, orderId: 'o1', resolution: null }];
    expect(
      approvalRefusal({
        status: 'MATCHED', approvedAt: null, receipts: 1, matches: rowsOfIt.length,
        openLines: countOpenLines(rowsOfIt), gap: { gap: 0, needsExplanation: false, unconvertible: 0 }, explanation: null,
      })
    ).toBeNull();

    // …while the closed one answers every edit with the one sentence.
    expect(editRefusal({ status: 'APPROVED', approvedAt: new Date('2026-10-20T00:00:00Z') })?.error).toBe(STATEMENT_CLOSED_SENTENCE);
  });

  it('and the screen says where the road is: the sentence on the card, the banner and the greyed buttons', () => {
    for (const f of [
      'src/components/screens/finance/CollectionScreen.tsx',
      'src/components/screens/finance/MatchingScreen.tsx',
      'src/components/screens/finance/DifferenceActions.tsx',
    ]) {
      expect(code(f), f).toContain('STATEMENT_CLOSED_SENTENCE');
    }
  });
});
