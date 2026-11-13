import { describe, expect, it } from 'vitest';
import {
  MAX_HITS,
  MAX_QUERY,
  MIN_QUERY,
  NOT_MATCHED_YET_AR,
  RESULT_AR,
  TOO_SHORT_AR,
  cleanQuery,
  readQuery,
} from './statement-search-rules';
import { answerAr, orderClauses, searchAllStatements, statementState, type SearchDb } from './statement-search';

/**
 * «بحث بكل الكشوف» — THE LIBRARY, AGAINST A DATABASE THAT REALLY ANSWERS THE QUESTION.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (the rules the search must keep; the screen and the door have their own files)
 *
 *  · Every line of every statement of the store that mentions what was typed — by its own barcode or reference, or because
 *    the order the matching tied it to is the one searched for — comes back, newest statement first, with which statement
 *    wrote it, what the matching made of it, the answer, and the three stored figures. An order no statement names comes
 *    back as the row that says so. A statement that was imported and not yet matched still answers.
 *  · NOTHING of another store or another company, ever: not by a barcode both carry, not by an order number both carry, not
 *    through an order of another store that a row was tied to by mistake, not through the courier's name.
 *  · A customer's name or phone is searched only for who may read customers' numbers — in the order's clauses AND in the
 *    line's — and the company's whole row is never searched; the answer carries no name, no phone and no file hash.
 *  · At most 50 lines, with the true count of lines and of unnamed orders together.
 *  · It reads and writes nothing else: the fake below offers `count` and `findMany` and nothing that writes.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * A fake that records what it was asked can only say «the scope was in the question». This one holds statements, lines,
 * matching rows and orders, and EVALUATES the `where` it is handed — equality, `contains` with or without case, `is`,
 * `some`, `in`, `AND`, `OR` — so the claims are about ANSWERS. An operator the evaluator does not know throws.
 */

type Any = Record<string, any>;

function matches(where: Any, row: Any): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Any[]).every((w) => matches(w, row));
    if (key === 'OR') return (cond as Any[]).some((w) => matches(w, row));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date || typeof cond !== 'object') return value === cond;
    if ('contains' in cond) {
      if (typeof value !== 'string') return false;
      const insensitive = cond.mode === 'insensitive';
      return (insensitive ? value.toLowerCase() : value).includes(insensitive ? String(cond.contains).toLowerCase() : String(cond.contains));
    }
    if ('is' in cond) return cond.is === null ? value == null : value != null && matches(cond.is, value);
    if ('some' in cond) return Array.isArray(value) && value.some((v) => matches(cond.some, v));
    if ('in' in cond) return (cond.in as unknown[]).includes(value);
    // A to-one relation written as a nested question (`statement: { storeId }`).
    if (value !== null && typeof value === 'object') return matches(cond, value);
    throw new Error(`the evaluator does not know «${JSON.stringify(cond)}» for ${key}`);
  });
}

const sortKey = (row: Any, spec: Any): { value: unknown; dir: string } => {
  const [k, v] = Object.entries(spec)[0];
  return typeof v === 'string' ? { value: row[k] instanceof Date ? row[k].getTime() : row[k], dir: v } : sortKey(row[k], v as Any);
};
const sorted = (rows: Any[], orderBy: Any[]) =>
  [...rows].sort((a, b) => {
    for (const spec of orderBy) {
      const x = sortKey(a, spec);
      const y = sortKey(b, spec);
      if ((x.value as number) < (y.value as number)) return x.dir === 'asc' ? -1 : 1;
      if ((x.value as number) > (y.value as number)) return x.dir === 'asc' ? 1 : -1;
    }
    return 0;
  });

// ─────────────────────────────── the world ───────────────────────────────

const D = (iso: string) => new Date(iso);
let n = 0;

const stmt = (over: Any = {}): Any => ({
  id: `st${++n}`, companyId: 'c1', storeId: 's1', reference: `ST-${n}`, createdAt: D('2026-10-01T10:00:00Z'), status: 'MATCHED',
  approvedAt: null, matchingClosedAt: null, fileHash: `sha-${n}`, currencyCode: 'JOD', deliveryProviderId: 'p1', ...over,
});
const order = (id: string, over: Any = {}): Any => ({ id, companyId: 'c1', storeId: 's1', orderNumber: id.toUpperCase(), merchantRef: null, trackingNumber: null, customer: null, ...over });
const customer = (fullName: string, phone: string, rawPhone: string) => ({ fullName, phone, rawPhone });

interface World {
  statements: Any[];
  lines: Any[];
  matchRows: Any[];
  providers: Any[];
}

function line(w: World, s: Any, over: Any = {}): Any {
  const l = { id: `l${++n}`, statementId: s.id, barcode: null, merchantRef: null, receiverName: null, receiverPhone: null, rawRow: null, createdAt: D('2026-10-01T10:00:00Z'), statement: s, matches: [] as Any[], ...over };
  w.lines.push(l);
  return l;
}
function match(w: Any, s: Any, l: Any | null, o: Any | null, over: Any = {}): Any {
  const m = {
    id: `m${++n}`, companyId: s.companyId, statementId: s.id, statementLineId: l?.id ?? null, orderId: o?.id ?? null, result: 'MATCHED', resolution: null,
    expectedAmount: null, statementAmount: null, difference: null, createdAt: D('2026-10-01T10:00:00Z'), order: o, statement: s, ...over,
  };
  w.matchRows.push(m);
  l?.matches.push(m);
  return m;
}

/** A store with every kind of thing in it, and — beside it — everything that must never be read. */
function world() {
  const w: World = { statements: [], lines: [], matchRows: [], providers: [{ id: 'p1', companyId: 'c1', name: 'أمان' }, { id: 'p2', companyId: 'c1', name: 'بشائر' }, { id: 'px', companyId: 'c2', name: 'شركة غيرنا' }] };
  const o1 = order('o1', { orderNumber: 'ORD-1001', merchantRef: 'M-1001', trackingNumber: 'TRK-1001', customer: customer('سارة الأحمد', '933620102', '0933620102') });
  const o2 = order('o2', { orderNumber: 'ORD-1002', trackingNumber: 'TRK-1002', customer: customer('عمر خالد', '944111222', '0944111222') });
  const o3 = order('o3', { orderNumber: 'ORD-1003', customer: customer('ليلى', '955000333', '0955000333') });
  // Another store's order: the same number as ours, and a reference only it has.
  const ox = order('ox', { storeId: 's2', orderNumber: 'ORD-1001', merchantRef: 'M-OTHER-STORE', customer: customer('سارة الأحمد', '933620102', '0933620102') });

  const closed = stmt({ id: 'sA', reference: 'ST-NOV', createdAt: D('2026-11-01T10:00:00Z'), status: 'APPROVED', approvedAt: D('2026-11-02T10:00:00Z'), matchingClosedAt: D('2026-11-03T10:00:00Z'), deliveryProviderId: 'p1' });
  const matched = stmt({ id: 'sB', reference: 'ST-OCT', createdAt: D('2026-10-01T10:00:00Z'), status: 'MATCHED', deliveryProviderId: 'p2' });
  const fresh = stmt({ id: 'sC', reference: 'ST-SEP', createdAt: D('2026-09-01T10:00:00Z'), status: 'IMPORTED', deliveryProviderId: 'p1' });
  const draft = stmt({ id: 'sD', reference: 'ST-DRAFT', createdAt: D('2026-08-01T10:00:00Z'), status: 'IMPORTED', fileHash: 'manual:draft:abc', deliveryProviderId: 'p1' });
  const otherStore = stmt({ id: 'sX', storeId: 's2', reference: 'ST-OTHER-STORE', createdAt: D('2026-11-05T10:00:00Z') });
  // Another company's statement that even carries OUR store's id: the company is asked on its own, not through the store.
  const otherCompany = stmt({ id: 'sY', companyId: 'c2', storeId: 's1', reference: 'ST-OTHER-COMPANY', createdAt: D('2026-11-06T10:00:00Z'), deliveryProviderId: 'px' });
  w.statements.push(closed, matched, fresh, draft, otherStore, otherCompany);

  const l1 = line(w, closed, { barcode: 'BC-1001', merchantRef: 'M-1001', receiverName: 'سارة', receiverPhone: '+963 933 620 102' });
  match(w, closed, l1, o1, { result: 'MATCHED', expectedAmount: '20.000', statementAmount: '20.000', difference: '0.000' });
  const l2 = line(w, closed, { barcode: 'BC-1002', merchantRef: 'M-1002', receiverName: 'عمر', receiverPhone: '0944111222' });
  match(w, closed, l2, o2, { result: 'MISMATCHED', resolution: 'ACCEPTED_COURIER', expectedAmount: '25.000', statementAmount: '22.000', difference: '-3.000' });
  const l3 = line(w, matched, { barcode: 'BC-1001', receiverName: 'سارة' });
  match(w, matched, l3, o1, { result: 'MATCHED', expectedAmount: '20.000', statementAmount: '20.000', difference: '0.000' });
  const l4 = line(w, matched, { barcode: 'BC-9999' });
  match(w, matched, l4, null, { result: 'MISSING_IN_SYSTEM', statementAmount: '12.000' });
  line(w, fresh, { barcode: 'BC-3000' });
  line(w, draft, { barcode: 'BC-DRAFT' });
  // A line tied, by mistake, to an order of ANOTHER store.
  const lc = line(w, closed, { barcode: 'BC-CROSS' });
  match(w, closed, lc, ox, { result: 'MATCHED' });
  // The phone and the name only inside the company's whole row.
  line(w, closed, { barcode: 'BC-RAW', rawRow: 'مرجع,0955555555,سامر الراوي' });
  // What other stores and companies carry: the same barcode, the same order number.
  const lx = line(w, otherStore, { barcode: 'BC-1001', merchantRef: 'M-1001', receiverName: 'سارة' });
  match(w, otherStore, lx, o1, { result: 'MATCHED' });
  const lf = line(w, otherCompany, { barcode: 'BC-1001' });
  match(w, otherCompany, lf, null, { result: 'MISSING_IN_SYSTEM' });

  // Our orders that two statements did not name (the second is another store's statement: never read).
  match(w, closed, null, o3, { result: 'MISSING_IN_STATEMENT', expectedAmount: '15.000' });
  match(w, matched, null, o3, { result: 'MISSING_IN_STATEMENT', expectedAmount: '15.000' });
  match(w, otherStore, null, o3, { result: 'MISSING_IN_STATEMENT', expectedAmount: '15.000' });
  match(w, otherCompany, null, o3, { result: 'MISSING_IN_STATEMENT', expectedAmount: '15.000' });
  return w;
}

/** The three tables the search reads, answering from `w`, and everything it was asked. */
function dbOf(w: World) {
  const asked: { table: string; method: string; where: Any }[] = [];
  const note = (table: string, method: string, where: Any) => asked.push({ table, method, where });
  const db = {
    statementLine: {
      count: async ({ where }: { where: Any }) => {
        note('statementLine', 'count', where);
        return w.lines.filter((r) => matches(where, r)).length;
      },
      findMany: async ({ where, orderBy, take }: { where: Any; orderBy: Any[]; take: number }) => {
        note('statementLine', 'findMany', where);
        return sorted(w.lines.filter((r) => matches(where, r)), orderBy).slice(0, take).map((r) => ({ ...r, matches: sorted(r.matches, [{ createdAt: 'desc' }]).slice(0, 1) }));
      },
    },
    settlementMatch: {
      count: async ({ where }: { where: Any }) => {
        note('settlementMatch', 'count', where);
        return w.matchRows.filter((r) => matches(where, r)).length;
      },
      findMany: async ({ where, orderBy, take }: { where: Any; orderBy: Any[]; take: number }) => {
        note('settlementMatch', 'findMany', where);
        return sorted(w.matchRows.filter((r) => matches(where, r)), orderBy).slice(0, take);
      },
    },
    deliveryProvider: {
      findMany: async ({ where }: { where: Any }) => {
        note('deliveryProvider', 'findMany', where);
        return w.providers.filter((p) => matches(where, p)).map(({ id, name }) => ({ id, name }));
      },
    },
  };
  return { asked, db: db as unknown as SearchDb };
}

const scope = { companyId: 'c1', storeId: 's1' };
const search = (q: string, maySeeContact = false, w = world()) => {
  const { db, asked } = dbOf(w);
  return searchAllStatements(db, { scope, q, maySeeContact }).then((r) => ({ ...r, asked }));
};
const refs = (r: { hits: { statement: { reference: string } }[] }) => r.hits.map((h) => h.statement.reference);

// ─────────────────────────────── what was typed ───────────────────────────────

describe('what was typed, in the spelling the database keeps', () => {
  it('Arabic and Persian digits become Latin, invisible marks go, spaces collapse and the edges are trimmed', () => {
    expect(cleanQuery('  ORD-٢٠٢٦-١٢٣٤ ')).toBe('ORD-2026-1234');
    expect(cleanQuery('۰۹۳۳ ۶۲۰ ۱۰۲')).toBe('0933 620 102');
    expect(cleanQuery('‎+963‏ 933‪  620﻿ 102')).toBe('+963 933 620 102');
    expect(cleanQuery('a \n\t b')).toBe('a b');
  });

  it('three characters at least — fewer are refused in Arabic, nothing is searched', () => {
    expect(MIN_QUERY).toBe(3);
    for (const q of ['', ' ', 'ab', ' a ', '‎‏']) {
      expect(readQuery(new URLSearchParams({ q })), JSON.stringify(q)).toEqual({ ok: false, error: TOO_SHORT_AR });
    }
    expect(readQuery(new URLSearchParams({ q: 'abc' }))).toEqual({ ok: true, q: 'abc', scanned: false });
    expect(TOO_SHORT_AR).toContain('3 أحرف');
  });

  it('a whole barcode the camera read is searched at any length — and an empty scan is still nothing', () => {
    expect(readQuery(new URLSearchParams({ q: 'A1', scan: '1' }))).toEqual({ ok: true, q: 'A1', scanned: true });
    expect(readQuery(new URLSearchParams({ q: 'A', scan: '1' }))).toEqual({ ok: true, q: 'A', scanned: true });
    expect(readQuery(new URLSearchParams({ q: '  ', scan: '1' })).ok).toBe(false);
    expect(readQuery(new URLSearchParams({ scan: '1' })).ok).toBe(false);
    // Only the exact word «1» counts as a scan: nobody gets the waiver by sending anything else.
    for (const scan of ['0', 'true', 'yes', '']) expect(readQuery(new URLSearchParams({ q: 'A1', scan })).ok, scan).toBe(false);
  });

  it('a long paste is cut at a hundred characters, after cleaning', () => {
    const r = readQuery(new URLSearchParams({ q: `${'x'.repeat(150)}` }));
    expect(r.ok && r.q.length).toBe(MAX_QUERY);
    expect(MAX_QUERY).toBe(100);
  });
});

// ─────────────────────────────── the words ───────────────────────────────

describe('the state of a statement, by the same predicates the screens gate on', () => {
  const s = (over: Any = {}) => ({ status: 'MATCHED', fileHash: 'sha', approvedAt: null, matchingClosedAt: null, ...over });
  it('a draft first; then closed; then approved with the matching still open; then the step it has reached', () => {
    expect(statementState(s({ fileHash: 'manual:draft:x' }))).toEqual({ key: 'DRAFT', ar: 'مسوّدة' });
    expect(statementState(s({ status: 'APPROVED', approvedAt: D('2026-11-02'), matchingClosedAt: D('2026-11-03') }))).toEqual({ key: 'CLOSED', ar: 'مغلق' });
    expect(statementState(s({ status: 'APPROVED', approvedAt: D('2026-11-02') }))).toEqual({ key: 'APPROVED', ar: 'معتمد' });
    expect(statementState(s({ status: 'IMPORTED' }))).toEqual({ key: 'IMPORTED', ar: 'مستورد' });
    expect(statementState(s({ status: 'RECEIPTED' }))).toEqual({ key: 'RECEIPTED', ar: 'سُجِّل الاستلام' });
    expect(statementState(s({ status: 'MATCHED' }))).toEqual({ key: 'MATCHED', ar: 'مطابَق' });
  });

  it('a manual statement is not a draft once it has a reference — only the draft hash is', () => {
    expect(statementState(s({ fileHash: 'manual:abcdef', status: 'MATCHED' })).key).toBe('MATCHED');
  });

  it('a status it does not know is said as it is, never dropped', () => {
    expect(statementState(s({ status: 'SOMETHING_NEW' }))).toEqual({ key: 'SOMETHING_NEW', ar: 'SOMETHING_NEW' });
  });
});

describe('the answer a person gave, in the words the matching screen shows it with', () => {
  it('the two figures, «قيد المراجعة», a word it does not know — and nothing', () => {
    expect(answerAr('ACCEPTED_COURIER')).toBe('اعتُمد رقم الشركة');
    expect(answerAr('OURS_STANDS')).toBe('رقمنا هو المعتمد');
    expect(answerAr('UNDER_REVIEW')).toBe('قيد المراجعة');
    expect(answerAr('A_NEW_ANSWER')).toBe('A_NEW_ANSWER');
    expect(answerAr(null)).toBeNull();
    expect(answerAr(undefined)).toBeNull();
    expect(answerAr('')).toBeNull();
  });
});

// ─────────────────────────────── the search ───────────────────────────────

describe('a barcode, a reference, an order number — found in every statement of the store', () => {
  it('a barcode two statements carry: both lines, the NEWEST statement first, each with its own statement and its own figures', async () => {
    const r = await search('BC-1001');
    expect(refs(r)).toEqual(['ST-NOV', 'ST-OCT']);
    expect(r.total).toBe(2);
    expect(r.limit).toBe(MAX_HITS);
    const [nov, oct] = r.hits;
    expect(nov).toMatchObject({
      queue: 'MATCHED', resultAr: 'مطابق', answerAr: null, barcode: 'BC-1001', merchantRef: 'M-1001',
      order: { id: 'o1', orderNumber: 'ORD-1001' }, expected: 20, stated: 20, difference: 0,
      statement: { id: 'sA', reference: 'ST-NOV', company: 'أمان', at: '2026-11-01T10:00:00.000Z', state: 'CLOSED', stateAr: 'مغلق', currencyCode: 'JOD' },
    });
    expect(oct.statement).toMatchObject({ id: 'sB', reference: 'ST-OCT', company: 'بشائر', state: 'MATCHED', stateAr: 'مطابَق' });
  });

  it('what the matching made of a line is said in the group’s own words, with the answer and the three figures', async () => {
    const [hit] = (await search('BC-1002')).hits;
    expect(hit).toMatchObject({ queue: 'MISMATCHED', resultAr: RESULT_AR.MISMATCHED, answerAr: 'اعتُمد رقم الشركة', expected: 25, stated: 22, difference: -3 });
    const [missing] = (await search('BC-9999')).hits;
    expect(missing).toMatchObject({ queue: 'MISSING_IN_SYSTEM', resultAr: RESULT_AR.MISSING_IN_SYSTEM, order: null, expected: null, stated: 12, difference: null });
  });

  it('the case of what was typed does not matter, and a part of a barcode is enough', async () => {
    expect(refs(await search('bc-1001'))).toEqual(['ST-NOV', 'ST-OCT']);
    expect(refs(await search('1001'))).toEqual(['ST-NOV', 'ST-OCT']);
  });

  it('the company’s own reference finds the line it wrote', async () => {
    const r = await search('M-1002');
    expect(r.hits.map((h) => h.barcode)).toEqual(['BC-1002']);
  });

  it('OUR order number finds the lines the matching tied to that order — in every statement', async () => {
    const r = await search('ORD-1001');
    expect(refs(r)).toEqual(['ST-NOV', 'ST-OCT']);
    expect(r.hits.every((h) => h.order?.orderNumber === 'ORD-1001')).toBe(true);
  });

  it('the courier’s waybill on the order finds the line tied to it, though the line carries another reference', async () => {
    expect((await search('TRK-1002')).hits.map((h) => h.barcode)).toEqual(['BC-1002']);
  });

  it('an order that statements did not name is found as the row that says so — one per statement, never the other store’s', async () => {
    const r = await search('ORD-1003');
    expect(refs(r)).toEqual(['ST-NOV', 'ST-OCT']);
    expect(r.total).toBe(2);
    for (const h of r.hits) {
      expect(h).toMatchObject({ queue: 'MISSING_IN_STATEMENT', resultAr: RESULT_AR.MISSING_IN_STATEMENT, order: { orderNumber: 'ORD-1003' }, barcode: null, merchantRef: null, expected: 15 });
    }
  });

  it('a statement that was imported and the matching not yet run still answers — and says there is no group for the line yet', async () => {
    const [hit] = (await search('BC-3000')).hits;
    expect(hit).toMatchObject({ matchId: null, queue: null, resultAr: NOT_MATCHED_YET_AR, answerAr: null, order: null, expected: null, stated: null, difference: null });
    expect(hit.statement).toMatchObject({ reference: 'ST-SEP', state: 'IMPORTED', stateAr: 'مستورد' });
  });

  it('a draft is found and called a draft', async () => {
    const [hit] = (await search('BC-DRAFT')).hits;
    expect(hit.statement).toMatchObject({ reference: 'ST-DRAFT', state: 'DRAFT', stateAr: 'مسوّدة' });
  });

  it('nothing found is an empty answer with a zero — never an error', async () => {
    expect(await search('NOT-ANYWHERE')).toMatchObject({ hits: [], total: 0 });
  });
});

describe('NEVER another store’s, never another company’s', () => {
  it('a barcode that another store and another company carry too: only this store’s lines come back', async () => {
    const r = await search('BC-1001');
    expect(refs(r)).not.toContain('ST-OTHER-STORE');
    expect(refs(r)).not.toContain('ST-OTHER-COMPANY');
    expect(r.total).toBe(2);
  });

  it('the same for the company’s own reference — it finds the line that wrote it and the line tied to the order that carries it, and no other store’s', async () => {
    const r = await search('M-1001');
    expect(refs(r)).toEqual(['ST-NOV', 'ST-OCT']);
    expect(refs(r)).not.toContain('ST-OTHER-STORE');
  });

  it('a line tied, by mistake, to an order of ANOTHER store is not reached through that order', async () => {
    // `M-OTHER-STORE` is a reference only the other store's order has; the line BC-CROSS is tied to it.
    expect(await search('M-OTHER-STORE')).toMatchObject({ hits: [], total: 0 });
    // …while the line itself is still found by its own barcode.
    expect((await search('BC-CROSS')).hits).toHaveLength(1);
  });

  it('the courier is named only from the person’s own company — a statement that points at another company’s courier names nobody', async () => {
    const w = world();
    w.statements.find((s) => s.id === 'sA')!.deliveryProviderId = 'px';
    const r = await search('BC-1002', false, w);
    expect(r.hits[0].statement.company).toBeNull();
    expect(r.hits[0].statement.reference).toBe('ST-NOV');
  });

  it('every question the search asks carries the company and the store — the line, the matching row, the order beneath each', async () => {
    const r = await search('ORD-1001', true);
    const walk = (where: Any, found: Any[] = []): Any[] => {
      if (!where || typeof where !== 'object') return found;
      if ('companyId' in where || 'storeId' in where) found.push(where);
      for (const v of Object.values(where)) if (v && typeof v === 'object') walk(v as Any, found);
      return found;
    };
    for (const q of r.asked.filter((a) => a.table !== 'deliveryProvider')) {
      const scoped = walk(q.where);
      const companies = new Set(scoped.map((s) => s.companyId).filter(Boolean));
      const stores = new Set(scoped.map((s) => s.storeId).filter(Boolean));
      expect([...companies], `${q.table}.${q.method}`).toEqual(['c1']);
      expect([...stores], `${q.table}.${q.method}`).toEqual(['s1']);
    }
    // …and the three sub-questions of the order side each carry both themselves.
    const tied = r.asked.find((a) => a.table === 'statementLine' && a.method === 'count')!.where.OR.find((c: Any) => 'matches' in c).matches.some.order.is;
    expect(tied).toMatchObject({ companyId: 'c1', storeId: 's1' });
    const orphan = r.asked.find((a) => a.table === 'settlementMatch' && a.method === 'count')!.where;
    expect(orphan).toMatchObject({ companyId: 'c1', statementLineId: null, statement: { companyId: 'c1', storeId: 's1' }, order: { is: { companyId: 'c1', storeId: 's1' } } });
    expect(r.asked.find((a) => a.table === 'deliveryProvider')!.where).toMatchObject({ companyId: 'c1' });
  });
});

describe('a customer’s name and phone — searched only for who may read customers’ numbers', () => {
  it('WITH the key: the customer’s name finds the line, through the order — and the receiver’s name on the line finds it too', async () => {
    const byOrderName = await search('الأحمد', true);
    expect(refs(byOrderName)).toEqual(['ST-NOV', 'ST-OCT']);
    const byLineName = await search('سارة', true);
    expect(refs(byLineName)).toEqual(['ST-NOV', 'ST-OCT']);
  });

  it('WITHOUT the key: the same words find nothing at all — not the order’s name, not the line’s', async () => {
    expect(await search('الأحمد', false)).toMatchObject({ hits: [], total: 0 });
    expect(await search('سارة', false)).toMatchObject({ hits: [], total: 0 });
  });

  it('WITH the key: a phone is found however it is typed — as stored, as written on the line, with the plus and the spaces', async () => {
    for (const phone of ['0933620102', '+963 933 620 102', '933620102']) {
      const r = await search(phone, true);
      expect(refs(r), phone).toEqual(['ST-NOV', 'ST-OCT']);
    }
  });

  it('WITHOUT the key: a phone finds nothing — in any spelling — so the box cannot be used to ask whose number it is', async () => {
    for (const phone of ['0933620102', '+963 933 620 102', '933620102', '0944111222']) {
      expect(await search(phone, false), phone).toMatchObject({ hits: [], total: 0 });
    }
  });

  it('the receiver on a line no order carries: found by name and by phone WITH the key, by neither WITHOUT it', async () => {
    const w = world();
    const s = w.statements.find((x) => x.id === 'sB')!;
    line(w, s, { barcode: 'BC-LONE', receiverName: 'منى الحلبي', receiverPhone: '0966111222' });
    for (const q of ['منى', '0966111222', '966111222']) {
      expect((await search(q, true, w)).hits.map((h) => h.barcode), q).toEqual(['BC-LONE']);
      expect(await search(q, false, w), q).toMatchObject({ hits: [], total: 0 });
    }
    expect((await search('BC-LONE', false, w)).hits).toHaveLength(1);
  });

  it('WITHOUT the key the order’s own clauses are still there — number, reference, waybill — and nothing that reads the customer', () => {
    const without = orderClauses('abc', false);
    expect(without.length).toBeGreaterThanOrEqual(3);
    expect(without.every((c) => !('customer' in c))).toBe(true);
    const withKey = orderClauses('abc', true);
    expect(withKey.filter((c) => 'customer' in c).length).toBeGreaterThanOrEqual(2);
    expect(withKey.length).toBeGreaterThan(without.length);
  });

  it('the company’s whole row is never searched — a phone and a name only inside it find nothing, with the key or without', async () => {
    for (const may of [true, false]) {
      expect(await search('0955555555', may), String(may)).toMatchObject({ hits: [], total: 0 });
      expect(await search('الراوي', may), String(may)).toMatchObject({ hits: [], total: 0 });
    }
    expect((await search('BC-RAW', true)).hits).toHaveLength(1);
  });

  it('the answer carries no customer’s name, no phone, no row and no file hash — whoever asks', async () => {
    for (const may of [true, false]) {
      // `asked` is the fake's own record of the questions (they name the columns); only the ANSWER is what leaves the server.
      const answer: Any = { ...(await search('ORD-1001', may)) };
      delete answer.asked;
      const body = JSON.stringify(answer);
      for (const secret of ['سارة', 'الأحمد', '0933620102', '933620102', 'sha-', 'manual:', 'rawRow', 'receiver', 'fileHash', 'fullName']) {
        expect(body.includes(secret), `${secret} (${may})`).toBe(false);
      }
    }
  });
});

describe('at most fifty, and the true count beside them', () => {
  /** Three statements of different dates, twenty lines each — sixty lines that all say «MANY». */
  function crowd() {
    const w = world();
    const dates = ['2026-12-03T10:00:00Z', '2026-12-02T10:00:00Z', '2026-12-01T10:00:00Z'];
    dates.forEach((at, i) => {
      const s = stmt({ id: `crowd${i}`, reference: `ST-CROWD-${i}`, createdAt: D(at) });
      w.statements.push(s);
      for (let k = 0; k < 20; k++) line(w, s, { barcode: `MANY-${i}-${String(k).padStart(2, '0')}`, createdAt: D(`2026-12-01T10:${String(k).padStart(2, '0')}:00Z`) });
    });
    return w;
  }

  it('sixty lines: fifty come back, the count says sixty, and they are the NEWEST fifty in a stable order', async () => {
    const r = await search('MANY-', false, crowd());
    expect(r.hits).toHaveLength(50);
    expect(r.total).toBe(60);
    expect(r.limit).toBe(50);
    const order = r.hits.map((h) => `${h.statement.reference}:${h.barcode}`);
    expect(order.slice(0, 20).every((x) => x.startsWith('ST-CROWD-0:'))).toBe(true);
    expect(order.slice(20, 40).every((x) => x.startsWith('ST-CROWD-1:'))).toBe(true);
    expect(order.slice(40).every((x) => x.startsWith('ST-CROWD-2:'))).toBe(true);
    expect(order.slice(40)).toHaveLength(10);
    // Within a statement, in the order the lines were written.
    expect(order.slice(0, 3)).toEqual(['ST-CROWD-0:MANY-0-00', 'ST-CROWD-0:MANY-0-01', 'ST-CROWD-0:MANY-0-02']);
    // Asking again gives the same fifty.
    expect((await search('MANY-', false, crowd())).hits.map((h) => `${h.statement.reference}:${h.barcode}`)).toEqual(order);
  });

  it('exactly fifty is not «cut»: the count and the list agree', async () => {
    const w = world();
    const s = stmt({ id: 'fifty', reference: 'ST-FIFTY', createdAt: D('2026-12-05T10:00:00Z') });
    w.statements.push(s);
    for (let k = 0; k < 50; k++) line(w, s, { barcode: `FIFTY-${k}` });
    const r = await search('FIFTY-', false, w);
    expect(r.hits).toHaveLength(50);
    expect(r.total).toBe(50);
  });

  it('the count is lines AND unnamed orders together — not the lines alone, not the page', async () => {
    const w = crowd();
    // A word that lines carry and an order of ours no statement named, both.
    const s = w.statements.find((x) => x.id === 'sA')!;
    const o = order('oMany', { orderNumber: 'MANY-ORDER' });
    for (let k = 0; k < 5; k++) match(w, s, null, o, { result: 'MISSING_IN_STATEMENT' });
    const r = await search('MANY-', false, w);
    expect(r.total).toBe(65);
    expect(r.hits).toHaveLength(50);
  });

  it('lines and unnamed orders are interleaved by the statement’s date: a newer statement’s row comes before an older one’s whichever kind it is', async () => {
    const w = world();
    const a = stmt({ id: 'newer', reference: 'ST-NEWER', createdAt: D('2026-12-09T10:00:00Z') });
    const b = stmt({ id: 'older', reference: 'ST-OLDER', createdAt: D('2026-12-08T10:00:00Z') });
    w.statements.push(a, b);
    const o = order('oBoth', { orderNumber: 'BOTH-1' });
    line(w, b, { barcode: 'BOTH-1' });
    match(w, a, null, o, { result: 'MISSING_IN_STATEMENT' });
    const r = await search('BOTH-1', false, w);
    expect(refs(r)).toEqual(['ST-NEWER', 'ST-OLDER']);
    expect(r.hits.map((h) => h.queue)).toEqual(['MISSING_IN_STATEMENT', null]);
  });
});

describe('it only reads', () => {
  it('asks the three tables with `count` and `findMany`, and nothing else is on offer', async () => {
    const r = await search('ORD-1001', true);
    const methods = new Set(r.asked.map((a) => a.method));
    expect([...methods].sort()).toEqual(['count', 'findMany']);
  });

  it('reads the courier’s names in one question for the whole page, not one per line', async () => {
    const r = await search('BC-1001');
    expect(r.asked.filter((a) => a.table === 'deliveryProvider')).toHaveLength(1);
  });
});
