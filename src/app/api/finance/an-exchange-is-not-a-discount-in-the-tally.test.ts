import { beforeEach, describe, expect, it, vi } from 'vitest';
import { differencesByPerson, isExchange, type PersonRow } from '@/lib/settlement-difference';

/**
 * «طلب تبديل» IS NOT A DISCOUNT SOMEBODY GAVE AWAY — SO IT IS OUT OF THE PER-PERSON TALLY, AND HAS ITS OWN NUMBER (the owner, 13/11).
 *
 * `GET /api/finance/settlement-differences` counts, per person who confirmed the order, how many differences there were, how many were
 * answered «اعتُمد رقم الشركة» and the money that was worth. An exchange is stored as that very answer plus a qualifier, so unless the
 * query knows it, every replacement the person ever sent would be counted as a discount they gave. The query leaves it out of
 * `differences`, `accepted` and `acceptedValue` (and with them `rate`), and counts it as `exchanges`.
 *
 * THE SQL IS READ, NOT TRUSTED. There is no database here, and the trap in this filter is silent: almost every row has NO kind (NULL),
 * and `NULL <> 'EXCHANGE'` is not true — a filter written that way would drop every plain row from the tally and nobody would see an
 * error. So the predicates are taken out of the very text the route sends and EVALUATED, in SQL's three-valued logic, over every
 * combination of the three columns — and each must agree with `isExchange`, the one rule the rest of the code uses.
 *
 * Also here: the statement read hands the qualifier to the screen (`resolutionKind`), and an older row without it reads as «not an exchange».
 */

/* ───────────────────────── a small SQL three-valued-logic evaluator, for the predicates this route sends ───────────────────────── */

type V = boolean | null; // SQL: TRUE / FALSE / NULL
type Cell = string | null;

function tokens(sql: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:('[^']*')|([A-Za-z_][A-Za-z0-9_]*\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))|([A-Za-z_][A-Za-z0-9_]*)|(<>|!=|=|\(|\)))/gy;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(sql)) !== null) {
    out.push(m[0].trim());
    last = re.lastIndex;
  }
  if (sql.slice(last).trim() !== '') throw new Error('the evaluator cannot read: ' + sql.slice(last, last + 40));
  return out;
}

/** Evaluates one boolean SQL expression over `row` ({alias.column: value}). Supports = <> AND OR NOT IS [NOT] TRUE IS [NOT] NULL IS DISTINCT FROM ( ). */
function evaluate(sql: string, row: Record<string, Cell>): V {
  const t = tokens(sql);
  let i = 0;
  const peek = () => t[i]?.toUpperCase();
  const eat = (w?: string) => {
    if (w && peek() !== w) throw new Error(`expected ${w}, got ${t[i]} in: ${sql}`);
    return t[i++];
  };
  const and3 = (a: V, b: V): V => (a === false || b === false ? false : a === null || b === null ? null : true);
  const or3 = (a: V, b: V): V => (a === true || b === true ? true : a === null || b === null ? null : false);

  const value = (): Cell | undefined => {
    const x = eat();
    if (x.startsWith("'")) return x.slice(1, -1);
    if (!(x in row)) throw new Error(`the row has no column ${x}`);
    return row[x];
  };
  const primary = (): V => {
    if (peek() === '(') {
      eat('(');
      const v = orExpr();
      eat(')');
      return v;
    }
    const left = value() as Cell;
    if (peek() === 'IS') {
      eat('IS');
      let negate = false;
      if (peek() === 'NOT') { eat('NOT'); negate = true; }
      if (peek() === 'NULL') { eat('NULL'); return negate ? left !== null : left === null; }
      if (peek() === 'DISTINCT') {
        eat('DISTINCT'); eat('FROM');
        const right = value() as Cell;
        const distinct = left !== right;
        return negate ? !distinct : distinct;
      }
      throw new Error('this evaluator reads IS NULL, IS DISTINCT FROM and (…) IS TRUE here');
    }
    const op = eat();
    const right = value() as Cell;
    if (left === null || right === null) return null;
    if (op === '=') return left === right;
    if (op === '<>' || op === '!=') return left !== right;
    throw new Error('operator ' + op);
  };
  /** `x IS [NOT] TRUE` after any primary (including a parenthesised one). */
  const withIs = (): V => {
    const v = primary();
    if (peek() === 'IS') {
      eat('IS');
      let negate = false;
      if (peek() === 'NOT') { eat('NOT'); negate = true; }
      eat('TRUE');
      return negate ? v !== true : v === true;
    }
    return v;
  };
  const notExpr = (): V => {
    if (peek() === 'NOT') { eat('NOT'); const v = notExpr(); return v === null ? null : !v; }
    return withIs();
  };
  const andExpr = (): V => {
    let v = notExpr();
    while (peek() === 'AND') { eat('AND'); v = and3(v, notExpr()); }
    return v;
  };
  const orExpr = (): V => {
    let v = andExpr();
    while (peek() === 'OR') { eat('OR'); v = or3(v, andExpr()); }
    return v;
  };
  const result = orExpr();
  if (i !== t.length) throw new Error('left over: ' + t.slice(i).join(' '));
  return result;
}

/* ───────────────────────── the world ───────────────────────── */

const { db, requireContext, requirePermission, receiptGap, state } = vi.hoisted(() => {
  const state = { sql: [] as string[][], matches: [] as Record<string, unknown>[] };
  const db = {
    $queryRaw: vi.fn(),
    user: { findMany: vi.fn() },
    courierStatement: { findFirst: vi.fn() },
    settlementMatch: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn() },
  };
  return { db, state, requireContext: vi.fn(), requirePermission: vi.fn(), receiptGap: vi.fn() };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/api-error', () => ({ apiErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }) }));
vi.mock('@/lib/settlement', async (orig) => ({ ...(await orig<typeof import('@/lib/settlement')>()), receiptGap: (...a: unknown[]) => receiptGap(...a) }));

import { GET as tally } from './settlement-differences/route';
import { GET as readStatement } from './statements/[id]/route';

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } });
  requirePermission.mockResolvedValue({});
});

/* ───────────────────────── the pure half ───────────────────────── */

describe('the pure half: `differencesByPerson` carries the exchanges apart from every discount number', () => {
  const rows: PersonRow[] = [
    { personId: 'sara', settledOrders: 120, differences: 14, accepted: 12, acceptedValue: 37.5, exchanges: 3 },
    { personId: 'omar', settledOrders: 60, differences: 2, accepted: 0, acceptedValue: 0 },
  ];

  it('says how many exchanges each person had, and a caller that says nothing has none', () => {
    const out = differencesByPerson(rows);
    expect(out.find((p) => p.personId === 'sara')!.exchanges).toBe(3);
    expect(out.find((p) => p.personId === 'omar')!.exchanges).toBe(0);
  });

  it('and they change NONE of the discount numbers: the same rows without the field give the same differences, accepted, open, value and rate', () => {
    const withIt = differencesByPerson(rows);
    const without = differencesByPerson(rows.map(({ exchanges: _e, ...r }) => r));
    for (const [a, b] of withIt.map((p, i) => [p, without[i]] as const)) {
      expect({ ...a, exchanges: undefined }).toEqual({ ...b, exchanges: undefined });
    }
    const sara = withIt.find((p) => p.personId === 'sara')!;
    expect(sara.differences).toBe(14);
    expect(sara.accepted).toBe(12);
    expect(sara.open).toBe(2);
    expect(sara.acceptedValue).toBe(37.5);
    expect(sara.rate).toBeCloseTo(0.12, 2);
  });

  it('and a person with only exchanges has no differences, no accepted value and no rate against them', () => {
    const [p] = differencesByPerson([{ personId: 'x', settledOrders: 40, differences: 0, accepted: 0, acceptedValue: 0, exchanges: 5 }]);
    expect(p).toMatchObject({ differences: 0, accepted: 0, open: 0, acceptedValue: 0, rate: 0, exchanges: 5 });
  });
});

/* ───────────────────────── the query ───────────────────────── */

/** The database hands counts back as BigInt; the project targets ES2017, where a BigInt LITERAL (`30n`) does not compile. */
const big = (n: number) => BigInt(n);

const askTally = async (rows: Record<string, unknown>[] = []) => {
  db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    state.sql.push([...strings]);
    return rows;
  });
  db.user.findMany.mockResolvedValue([{ id: 'p1', name: 'سارة', role: 'CONFIRMATION_AGENT' }]);
  const res = await tally();
  return { res, sql: state.sql[state.sql.length - 1].join('?') };
};

describe('the route', () => {
  it('reports each person’s exchanges as their own number, and the unattributed ones stay as they were', async () => {
    const { res } = await askTally([
      { personId: 'p1', settledOrders: big(30), differences: big(2), accepted: big(1), acceptedValue: 2, exchanges: big(4) },
      { personId: null, settledOrders: big(5), differences: big(1), accepted: big(0), acceptedValue: 0, exchanges: big(2) },
    ]);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.people).toHaveLength(1);
    expect(body.people[0]).toMatchObject({ personId: 'p1', name: 'سارة', differences: 2, accepted: 1, acceptedValue: 2, exchanges: 4, settledOrders: 30 });
    expect(body.unattributed).toEqual({ settledOrders: 5, differences: 1 });
  });

  it('an older shape of row (no `exchanges`) is read as none', async () => {
    const { res } = await askTally([{ personId: 'p1', settledOrders: big(30), differences: big(2), accepted: big(1), acceptedValue: 2 }]);
    expect((await res.json()).people[0].exchanges).toBe(0);
  });

  it('is still the settlement reviewer’s: the key is asked first', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('ليس لديك صلاحية'), { status: 403 }));
    await askTally();
    expect(requirePermission).toHaveBeenCalledWith('settlement.review');
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('THE SQL, read as the database reads it — NULL-safe, and the same rule as `isExchange`', () => {
  /** The text between `FILTER (` … `)` of the aggregate that ends `AS "<alias>"`, whitespace folded. */
  const filterOf = (sql: string, alias: string) => {
    // (Tempered: the text may not run through another FILTER on its way to the alias, or a neighbour's predicate would be read as this one's.)
    const m = new RegExp(`COUNT\\(\\*\\) FILTER \\(\\s*WHERE((?:(?!FILTER)[\\s\\S])*?)\\)\\s+AS "${alias}"`).exec(sql);
    expect(m, `no aggregate for ${alias}`).not.toBeNull();
    return m![1].replace(/\s+/g, ' ').trim();
  };
  const caseOf = (sql: string) => {
    const m = /CASE WHEN([\s\S]*?)THEN/.exec(sql);
    expect(m).not.toBeNull();
    return m![1].replace(/\s+/g, ' ').trim();
  };

  /** Every combination of the three columns the predicates read. */
  const ROWS: Record<string, Cell>[] = [];
  for (const result of ['MATCHED', 'MISMATCHED']) {
    for (const resolution of [null, 'ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']) {
      for (const kind of [null, 'EXCHANGE', 'SOMETHING_ELSE']) ROWS.push({ 'm.result': result, 'm.resolution': resolution, 'm."resolutionKind"': kind });
    }
  }
  const as = (r: Record<string, Cell>) => ({ result: r['m.result'], resolution: r['m.resolution'], resolutionKind: r['m."resolutionKind"'] });

  it('the grid is real: 2 results × 4 answers × 3 kinds, with NULLs in it', () => {
    expect(ROWS).toHaveLength(24);
    expect(ROWS.some((r) => r['m."resolutionKind"'] === null && r['m.resolution'] === 'ACCEPTED_COURIER')).toBe(true);
  });

  it('`differences` counts every MISMATCHED row that is not an exchange — a row with NO kind included', async () => {
    const { sql } = await askTally();
    const where = filterOf(sql, 'differences');
    for (const r of ROWS) {
      const want = r['m.result'] === 'MISMATCHED' && !isExchange(as(r));
      expect(evaluate(where, r) === true, JSON.stringify(r)).toBe(want);
    }
  });

  it('`accepted` counts every row answered «اعتُمد رقم الشركة» that is not an exchange', async () => {
    const { sql } = await askTally();
    const where = filterOf(sql, 'accepted');
    for (const r of ROWS) {
      const want = r['m.resolution'] === 'ACCEPTED_COURIER' && !isExchange(as(r));
      expect(evaluate(where, r) === true, JSON.stringify(r)).toBe(want);
    }
  });

  it('`acceptedValue` sums the money of the same rows — an exchange adds nothing to it', async () => {
    const { sql } = await askTally();
    const when = caseOf(sql);
    for (const r of ROWS) {
      const want = r['m.resolution'] === 'ACCEPTED_COURIER' && !isExchange(as(r));
      expect(evaluate(when, r) === true, JSON.stringify(r)).toBe(want);
    }
  });

  it('`exchanges` counts exactly the exchanges — the courier’s figure with the kind, and no row with any other answer', async () => {
    const { sql } = await askTally();
    const where = filterOf(sql, 'exchanges');
    for (const r of ROWS) expect(evaluate(where, r) === true, JSON.stringify(r)).toBe(isExchange(as(r)));
    expect(ROWS.filter((r) => evaluate(where, r) === true)).toHaveLength(2); // both results carry the same answer; the SQL's WHERE keeps MATCHED and MISMATCHED alike
  });

  it('and the evaluator itself is honest: the filter everyone writes first (`<>`) DROPS every row with no kind — which is what this file exists to catch', () => {
    const naive = `m.result = 'MISMATCHED' AND m."resolutionKind" <> 'EXCHANGE'`;
    const plainRow = { 'm.result': 'MISMATCHED', 'm.resolution': 'ACCEPTED_COURIER', 'm."resolutionKind"': null as Cell };
    expect(evaluate(naive, plainRow)).toBeNull();
    expect(evaluate(`m.result = 'MISMATCHED' AND m."resolutionKind" IS DISTINCT FROM 'EXCHANGE'`, plainRow)).toBe(true);
  });

  it('no bare comparison with the word EXCHANGE exists anywhere in the query — only inside the one `(…) IS TRUE` form', async () => {
    const { sql } = await askTally();
    const folded = sql.replace(/\s+/g, ' ');
    const FORM = `(m.resolution = 'ACCEPTED_COURIER' AND m."resolutionKind" = 'EXCHANGE') IS TRUE`;
    expect(folded.split(FORM).length - 1, 'one per aggregate: 3 negated, 1 counted').toBe(4);
    expect(folded.split(FORM).join('').includes("'EXCHANGE'"), 'a bare comparison with EXCHANGE').toBe(false);
    expect(folded).not.toMatch(/<>\s*'EXCHANGE'|!=\s*'EXCHANGE'|NOT IN \('EXCHANGE'/);
  });

  it('what it does NOT change: the denominator counts every order that reached a statement, the WHERE keeps only MATCHED and MISMATCHED rows of this store', async () => {
    const { sql } = await askTally();
    const folded = sql.replace(/\s+/g, ' ');
    expect(folded).toContain('COUNT(DISTINCT o.id) AS "settledOrders"');
    expect(folded).toContain(`m.result IN ('MATCHED', 'MISMATCHED')`);
    expect(folded).toMatch(/WHERE m\."companyId" = \? AND o\."storeId" = \?/);
    // …and the three discount numbers keep the old words they were built from.
    expect(folded).toContain(`m.result = 'MISMATCHED'`);
    expect(folded).toContain(`COALESCE(m."expectedAmount", 0) - COALESCE(m."statementAmount", 0)`);
  });
});

/* ───────────────────────── the statement read ───────────────────────── */

describe('the matching list carries the qualifier to the screen', () => {
  const line = { merchantRef: 'M', barcode: null, amount: 18, collected: 23, fee: 5, status: 'تم توصيلها', rawRow: null, receiverName: null, receiverPhone: null, receiverAddress: null, receiverCity: null, receiverArea: null };
  const match = (id: string, over: Record<string, unknown>) => ({
    id, statementId: 'st1', companyId: 'c1', orderId: `o-${id}`, result: 'MISMATCHED', matchedBy: 'MERCHANT_REF', expectedAmount: 20, statementAmount: 18, difference: -2,
    expectedFee: null, statementFee: null, feeDifference: null, note: null, resolution: null, resolutionNote: null, appliedAt: null,
    order: { id: `o-${id}`, orderNumber: `ORD-${id}`, merchantRef: 'M', shippingStatus: 'DELIVERED', confirmationStatus: 'CONFIRMED', settlementStatus: 'PENDING_COLLECTION', rejectionReason: null, returnReceipt: null },
    statementLine: line, ...over,
  });

  const read = async (matches: Record<string, unknown>[]) => {
    db.courierStatement.findFirst.mockResolvedValue({
      id: 'st1', companyId: 'c1', storeId: 's1', status: 'MATCHED', approvedAt: null, matchingClosedAt: null, lines: [], receipts: [], matches,
    });
    db.settlementMatch.findMany.mockResolvedValue([]);
    db.order.findMany.mockImplementation(async () => matches.map((m) => ({ id: (m as { orderId: string }).orderId, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION' })));
    db.orderChangeRequest.findMany.mockResolvedValue([]);
    db.orderActivity.findMany.mockResolvedValue([]);
    receiptGap.mockResolvedValue({ claimed: 0, received: 0, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
    const res = await readStatement(new Request('http://x'), { params: Promise.resolve({ id: 'st1' }) });
    expect(res.status).toBe(200);
    return (await res.json()) as { statement: { matches: Record<string, any>[] }; queues: { mismatched: Record<string, any>[] } };
  };

  it('an exchange row says so; a plain one says null; a row from before the column existed (no field at all) says null too', async () => {
    const body = await read([
      match('a', { resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE', resolutionNote: 'تبديل حبة ناقصة' }),
      match('b', { resolution: 'ACCEPTED_COURIER', resolutionKind: null, resolutionNote: 'خصم أعطاه الموظف' }),
      match('c', { resolution: 'ACCEPTED_COURIER', resolutionNote: 'سطر قبل الإضافة' }),
    ]);
    const by = (id: string) => body.statement.matches.find((m) => m.id === id)!;
    expect(by('a').resolutionKind).toBe('EXCHANGE');
    expect(by('b').resolutionKind).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(by('c'), 'resolutionKind')).toBe(true);
    expect(by('c').resolutionKind).toBeNull();
  });

  it('the queue the screen draws from carries it too, with the matrix beside it — and the answer is still the courier’s figure', async () => {
    const body = await read([match('a', { resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE', resolutionNote: 'تبديل حبة ناقصة' })]);
    const row = body.queues.mismatched[0];
    expect(row).toMatchObject({ id: 'a', resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE' });
    expect(row.decisions).toBeTruthy();
    // The matrix has NO fourth cell: the exchange reads the courier-figure cell.
    expect(Object.keys(row.decisions).sort()).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']);
  });
});
