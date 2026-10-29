import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINBACK_RULE,
  LOST_STATUSES,
  winbackVerdict,
  type WinbackRule,
  type WinbackSource,
} from './winback';
import { PERIODS, SHIPPING_KINDS, VIEWS, baseWhere, periodWhere, productWhere, reasonWhere, shippingWhere, viewWhere, type View } from './winback-filters';
import { PRODUCT_OPTIONS, readWinbackPage, winbackFacts } from './winback-list';

/**
 * THE LOST ORDERS' QUERIES, AGAINST A DATABASE THAT REALLY ANSWERS THEM.
 *
 * A fake that records what it was asked can only say «the scope was in the
 * question». This one holds rows and evaluates the `where` it is handed — the
 * same small evaluator as `winback-filters.test.ts`, which throws on anything it
 * does not know and answers an empty column the way the database does — so the
 * claims are about ANSWERS: that the numbers beside the options are the numbers
 * of rows that appear, that the three views add up to everything the rule reads,
 * and that a page is the right rows in the right order.
 */

const NOW = new Date('2026-10-21T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const RULE = DEFAULT_WINBACK_RULE;
const OFF: WinbackRule = { ...RULE, afterShipping: false };

type Any = Record<string, any>;
type Tri = boolean | null;
const all3 = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const any3 = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const not3 = (x: Tri): Tri => (x === null ? null : !x);

/** Three-valued, as the database answers: a comparison with an empty column is unknown, and only TRUE is a match. */
function evaluate(where: Any, row: Any): Tri {
  return all3(
    Object.entries(where).map(([key, cond]): Tri => {
      if (key === 'AND') return all3((cond as Any[]).map((w) => evaluate(w, row)));
      if (key === 'OR') return any3((cond as Any[]).map((w) => evaluate(w, row)));
      if (key === 'NOT') return not3(evaluate(cond as Any, row));
      const value = row[key];
      if (cond === null) return value === null;
      if (cond instanceof Date || typeof cond !== 'object') {
        if (value === null) return null;
        return cond instanceof Date ? value instanceof Date && value.getTime() === cond.getTime() : value === cond;
      }
      return all3(
        Object.entries(cond as Any).map(([op, arg]): Tri => {
          if (op === 'some') return (value as Any[]).some((child) => evaluate(arg as Any, child) === true);
          // A bare receipt in these fixtures is an ordinary one: a unit received, none damaged, none missing.
          if (op === 'is') return arg === null ? value === null : value !== null && evaluate(arg as Any, { receivedQty: 1, damagedQty: 0, missingQty: 0, ...value }) === true;
          if (op === 'isNot' && arg === null) return value !== null;
          if (op === 'not' && arg === null) return value !== null;
          if (op === 'isNot' || op === 'not') throw new Error(`the evaluator does not know «${op}» with a value`);
          if (value === null) return null;
          if (op === 'in') return (arg as unknown[]).includes(value);
          if (op === 'notIn') return !(arg as unknown[]).includes(value);
          if (typeof value === 'number') {
            if (op === 'gt') return value > (arg as number);
            throw new Error(`the evaluator compares numbers with «gt» only, not «${op}»`);
          }
          if (!(value instanceof Date)) throw new Error(`the evaluator compares dates only, not «${op}» on ${typeof value}`);
          const a = value.getTime();
          const b = (arg as Date).getTime();
          if (op === 'gt') return a > b;
          if (op === 'gte') return a >= b;
          if (op === 'lte') return a <= b;
          if (op === 'lt') return a < b;
          throw new Error(`the evaluator does not know «${op}»`);
        })
      );
    })
  );
}
const matches = (where: Any, row: Any): boolean => evaluate(where, row) === true;

interface Row {
  id: string;
  companyId: string;
  storeId: string;
  confirmationStatus: string;
  createdAt: Date;
  shippedAt: Date | null;
  shippingStatus: string;
  returnReceipt: { inspectedAt: Date; receivedQty?: number; damagedQty?: number; missingQty?: number } | null;
  replacedBy: { orderNumber: string } | null;
  replacesOrderId: string | null;
  rejectionReason: string | null;
  productNameSnapshot: string | null;
  statusLogs: { statusType: string; newValue: string | null; createdAt: Date }[];
}

let n = 0;
const row = (over: Partial<Row> & { closedDaysAgo?: number | null } = {}): Row => {
  const { closedDaysAgo = 30, ...rest } = over;
  const id = `o${String(++n).padStart(3, '0')}`;
  return {
    id,
    companyId: 'c1',
    storeId: 's1',
    confirmationStatus: 'REJECTED',
    createdAt: ago(40),
    shippedAt: null,
    shippingStatus: 'NOT_READY',
    returnReceipt: null,
    replacedBy: null,
    replacesOrderId: null,
    rejectionReason: 'PRICE_TOO_HIGH',
    productNameSnapshot: 'قطرة',
    statusLogs: closedDaysAgo === null ? [] : [{ statusType: 'CONFIRMATION', newValue: 'REJECTED', createdAt: ago(closedDaysAgo) }],
    ...rest,
  };
};

/** A parcel refused at the door, as the courier feed and the desk leave it: CONFIRMED, no reason, no loss logged. */
const back = (over: Partial<Row> & { closedDaysAgo?: number | null } = {}): Row =>
  row({
    confirmationStatus: 'CONFIRMED',
    rejectionReason: null,
    closedDaysAgo: null,
    createdAt: ago(70),
    shippedAt: ago(60),
    shippingStatus: 'RETURNED',
    returnReceipt: { inspectedAt: ago(30) },
    ...over,
  });

/** A database of these rows that answers `count`, `findMany` and `groupBy` by evaluating the `where` it is given. */
function dbOf(rows: Row[]) {
  const pick = (where: Any) => rows.filter((r) => matches(where ?? {}, r as unknown as Any));
  return {
    order: {
      count: async ({ where }: { where: Any }) => pick(where).length,
      findMany: async ({ where, orderBy, skip, take }: { where: Any; orderBy: Any[]; skip: number; take: number }) =>
        pick(where)
          .sort((a, b) => {
            for (const o of orderBy) {
              const [key, dir] = Object.entries(o)[0] as [keyof Row, 'asc' | 'desc'];
              const av = a[key] as Date | string;
              const bv = b[key] as Date | string;
              const c = av instanceof Date ? av.getTime() - (bv as Date).getTime() : String(av).localeCompare(String(bv));
              if (c !== 0) return dir === 'asc' ? c : -c;
            }
            return 0;
          })
          .slice(skip, skip + take),
      groupBy: async ({ by, where }: { by: (keyof Row)[]; where: Any }) => {
        const groups = new Map<unknown, number>();
        for (const r of pick(where)) groups.set(r[by[0]], (groups.get(r[by[0]]) ?? 0) + 1);
        return [...groups].map(([value, count]) => ({ [by[0]]: value, _count: { _all: count } }));
      },
    },
  } as unknown as Parameters<typeof readWinbackPage>[0];
}

const scope = { companyId: 'c1', storeId: 's1' };
const base = (rule: WinbackRule = RULE) => baseWhere(scope, rule, NOW);

/** A shop with every kind of lost order in it. */
function shop(): Row[] {
  const rows: Row[] = [];
  // The work: lost a month ago at a reason the rule calls for.
  for (let i = 0; i < 5; i++) rows.push(row({ rejectionReason: 'PRICE_TOO_HIGH', productNameSnapshot: 'قطرة', createdAt: ago(100 - i), closedDaysAgo: 30 + i }));
  for (let i = 0; i < 3; i++) rows.push(row({ rejectionReason: 'CUSTOMER_CHANGED_MIND', productNameSnapshot: 'كريم', createdAt: ago(60 - i), closedDaysAgo: 20 + i }));
  rows.push(row({ confirmationStatus: 'CANCELLED', rejectionReason: 'NO_ANSWER_3_ATTEMPTS', productNameSnapshot: 'قطرة', closedDaysAgo: 5 + 15 }));
  // Still cooling: lost a few days ago.
  rows.push(row({ closedDaysAgo: 3, productNameSnapshot: 'قطرة' }));
  rows.push(row({ closedDaysAgo: 10, productNameSnapshot: 'كريم', rejectionReason: 'FOUND_CHEAPER_ELSEWHERE' }));
  // Refused, each for its own reason.
  rows.push(row({ rejectionReason: 'DUPLICATE_ORDER' }));
  rows.push(row({ rejectionReason: 'OTHER' }));
  rows.push(row({ shippedAt: ago(35) }));
  rows.push(row({ replacedBy: { orderNumber: 'ORD-9' } }));
  rows.push(row({ replacesOrderId: 'x' }));
  rows.push(row({ closedDaysAgo: null }));
  // Outside what the rule reads at all.
  rows.push(row({ createdAt: ago(300) }));
  rows.push(row({ confirmationStatus: 'CONFIRMED' }));
  rows.push(row({ companyId: 'c2' }));
  rows.push(row({ storeId: 's2' }));
  return rows;
}

const total = (rows: Row[], view: View, rule: WinbackRule = RULE) =>
  rows.filter((r) => matches({ ...base(rule), AND: [viewWhere(view, rule, NOW)] }, r as unknown as Any)).length;

describe('the numbers beside the options are the rows that appear', () => {
  it('— each view says how many it holds, and those are the rows the list shows', async () => {
    const rows = shop();
    const facts = await winbackFacts(dbOf(rows), { base: base(), view: 'ready', rule: RULE, now: NOW });
    expect(facts.views).toEqual({ ready: 9, cooling: 2, skipped: 6 });
    for (const view of VIEWS) {
      const page = await readWinbackPage(dbOf(rows), { base: base(), viewClause: viewWhere(view, RULE, NOW), clauses: [], page: 1, limit: 100, select: {} });
      expect(page.total, view).toBe(facts.views[view]);
      expect(page.rows, view).toHaveLength(facts.views[view]);
    }
  });

  it('and the three views add up to everything the rule reads — nothing is in two, and nothing falls between', async () => {
    const rows = shop();
    const facts = await winbackFacts(dbOf(rows), { base: base(), view: 'ready', rule: RULE, now: NOW });
    const read = rows.filter((r) => matches(base(), r as unknown as Any)).length;
    expect(facts.views.ready + facts.views.cooling + facts.views.skipped).toBe(read);
    expect(read).toBe(17);
  });

  it('and orders of another company, another store, another status or too old are in no number', async () => {
    const rows = shop();
    const facts = await winbackFacts(dbOf(rows), { base: base(), view: 'skipped', rule: RULE, now: NOW });
    expect(facts.views.skipped).toBe(6);
    expect(rows.length).toBeGreaterThan(facts.views.ready + facts.views.cooling + facts.views.skipped);
  });

  it('and the reasons are those of the OPEN view, biggest first — the work holds only what the rule calls for', async () => {
    const rows = shop();
    const ready = await winbackFacts(dbOf(rows), { base: base(), view: 'ready', rule: RULE, now: NOW });
    expect(ready.reasons).toEqual([
      { reason: 'PRICE_TOO_HIGH', count: 5 },
      { reason: 'CUSTOMER_CHANGED_MIND', count: 3 },
      { reason: 'NO_ANSWER_3_ATTEMPTS', count: 1 },
    ]);
    // The refused view holds the other reasons — and one with none at all, which no dropdown can name.
    const skipped = await winbackFacts(dbOf(rows), { base: base(), view: 'skipped', rule: RULE, now: NOW });
    expect(skipped.reasons.map((g) => g.reason).sort()).toEqual(['DUPLICATE_ORDER', 'OTHER', 'PRICE_TOO_HIGH']);
    expect(skipped.reasons.reduce((s, g) => s + g.count, 0)).toBe(6);
  });

  it('and a reason the rule now calls for appears in the work with its count', async () => {
    const rows = shop();
    const rule = { ...RULE, reasons: [...RULE.reasons, 'OTHER'] };
    const ready = await winbackFacts(dbOf(rows), { base: base(rule), view: 'ready', rule, now: NOW });
    expect(ready.reasons.find((g) => g.reason === 'OTHER')).toEqual({ reason: 'OTHER', count: 1 });
    expect(ready.views.ready).toBe(10);
  });

  it('and the products are of the open view, biggest first, null names dropped', async () => {
    const rows = [...shop(), row({ productNameSnapshot: null })];
    const ready = await winbackFacts(dbOf(rows), { base: base(), view: 'ready', rule: RULE, now: NOW });
    expect(ready.products).toEqual([
      { name: 'قطرة', count: 6 },
      { name: 'كريم', count: 3 },
    ]);
  });

  it('and an order with no reason on record is counted in the refused view and in no reason’s number — no dropdown can name «nothing»', async () => {
    const rows = [...shop(), row({ rejectionReason: null })];
    const skipped = await winbackFacts(dbOf(rows), { base: base(), view: 'skipped', rule: RULE, now: NOW });
    expect(skipped.views.skipped).toBe(7);
    expect(skipped.reasons.some((g) => !g.reason)).toBe(false);
    expect(skipped.reasons.reduce((sum, g) => sum + g.count, 0)).toBe(6);
  });

  it('and equal counts keep a stable order — by the reason’s code and by the product’s name — whichever order the database returns the groups in', async () => {
    const some = (reason: string, product: string) => Array.from({ length: 2 }, () => row({ rejectionReason: reason, productNameSnapshot: product, closedDaysAgo: 30 }));
    const one = [...some('PRICE_TOO_HIGH', 'ب'), ...some('CUSTOMER_CHANGED_MIND', 'أ')];
    const other = [...some('CUSTOMER_CHANGED_MIND', 'أ'), ...some('PRICE_TOO_HIGH', 'ب')];
    for (const rows of [one, other]) {
      const f = await winbackFacts(dbOf(rows), { base: base(), view: 'ready', rule: RULE, now: NOW });
      expect(f.reasons.map((g) => g.reason)).toEqual(['CUSTOMER_CHANGED_MIND', 'PRICE_TOO_HIGH']);
      expect(f.products.map((g) => g.name)).toEqual(['أ', 'ب']);
    }
  });

  it('and only the first thirty products are offered — a shop with two hundred is not helped by a list of two hundred', async () => {
    const rows = Array.from({ length: 45 }, (_, i) => row({ productNameSnapshot: `منتج ${String(i).padStart(2, '0')}`, closedDaysAgo: 30 }));
    const ready = await winbackFacts(dbOf(rows), { base: base(), view: 'ready', rule: RULE, now: NOW });
    expect(ready.products).toHaveLength(PRODUCT_OPTIONS);
    expect(PRODUCT_OPTIONS).toBe(30);
  });

  it('and each period counts the open view’s orders cancelled within it — and the broader contains the narrower', async () => {
    const rows = shop();
    const f = await winbackFacts(dbOf(rows), { base: base(), view: 'ready', rule: RULE, now: NOW });
    // Closed 30..34, 20..22 and 20 days ago: none in the last week; five in the last 30 (the one closed exactly 30 days
    // ago is ON the line, and inside it); and all nine in 90.
    expect(f.periods['7']).toBe(0);
    expect(f.periods['30']).toBe(5);
    expect(f.periods['90']).toBe(9);
    expect(f.periods['7']).toBeLessThanOrEqual(f.periods['30']);
    expect(f.periods['30']).toBeLessThanOrEqual(f.periods['90']);
    expect(PERIODS).toHaveLength(3);
  });

  it('and with nothing else chosen, every option’s number is exactly the rows its choice brings', async () => {
    const rows = shop();
    const db = dbOf(rows);
    const f = await winbackFacts(db, { base: base(), view: 'ready', rule: RULE, now: NOW });
    const rowsFor = async (clause: Any) =>
      (await readWinbackPage(db, { base: base(), viewClause: viewWhere('ready', RULE, NOW), clauses: [clause], page: 1, limit: 100, select: {} })).total;
    for (const g of f.reasons) expect(await rowsFor(reasonWhere(g.reason)), g.reason).toBe(g.count);
    for (const g of f.products) expect(await rowsFor(productWhere(g.name)), g.name).toBe(g.count);
    for (const p of PERIODS) expect(await rowsFor(periodWhere(p, NOW, RULE)), p).toBe(f.periods[p]);
    for (const k of SHIPPING_KINDS) expect(await rowsFor(shippingWhere(k)), k).toBe(f.shipping[k]);
  });
});

/**
 * «قبل الشحن وبعد» — THE SAME SHOP, WITH PARCELS THAT CAME BACK IN IT (28/10).
 *
 * `shop()` above is left exactly as it was, and every number held over it still holds: the before-shipping
 * half did not move. These are the returns beside it — CONFIRMED, as a parcel refused at the door is, with
 * no reason and no loss in the log — each landing where the owner's ruling says it must.
 */
function returns(): Row[] {
  return [
    // The work: received three weeks and a month ago.
    back({ returnReceipt: { inspectedAt: ago(20) } }),
    back({ returnReceipt: { inspectedAt: ago(30) }, productNameSnapshot: 'كريم' }),
    // Still cooling: received three days ago.
    back({ returnReceipt: { inspectedAt: ago(3) } }),
    // Refused: nobody received it (at the desk, or written off), a duplicate, already offered.
    back({ returnReceipt: null }),
    back({ rejectionReason: 'DUPLICATE_ORDER' }),
    back({ replacedBy: { orderNumber: 'ORD-77' } }),
    // No lost order at all: on the road, delivered in part (its refused units counted in), delivered.
    back({ shippingStatus: 'FAILED_DELIVERY', returnReceipt: null }),
    back({ shippingStatus: 'PARTIALLY_DELIVERED' }),
    back({ shippingStatus: 'DELIVERED', returnReceipt: null }),
    // Too old: made before the look-back, received last month.
    back({ createdAt: ago(200) }),
  ];
}

describe('and with parcels that came back beside the lost ones', () => {
  it('— the views count the returns where the rule puts them, and the page shows exactly those rows', async () => {
    const rows = [...shop(), ...returns()];
    const facts = await winbackFacts(dbOf(rows), { base: base(), view: 'ready', rule: RULE, now: NOW });
    expect(facts.views).toEqual({ ready: 9 + 2, cooling: 2 + 1, skipped: 6 + 3 });
    for (const view of VIEWS) {
      const page = await readWinbackPage(dbOf(rows), { base: base(), viewClause: viewWhere(view, RULE, NOW), clauses: [], page: 1, limit: 100, select: {} });
      expect(page.total, view).toBe(facts.views[view]);
      expect(page.rows, view).toHaveLength(facts.views[view]);
    }
  });

  it('and the three views still add up to everything the rule reads — and the not-back and the too old are in no number', async () => {
    const rows = [...shop(), ...returns()];
    const facts = await winbackFacts(dbOf(rows), { base: base(), view: 'ready', rule: RULE, now: NOW });
    const read = rows.filter((r) => matches(base(), r as unknown as Any)).length;
    expect(facts.views.ready + facts.views.cooling + facts.views.skipped).toBe(read);
    expect(read).toBe(17 + 6);
  });

  it('and «الشحن» splits each view in two that add up to it — counted inside the open view', async () => {
    const rows = [...shop(), ...returns()];
    const expected: Record<View, { before: number; after: number }> = {
      ready: { before: 9, after: 2 },
      cooling: { before: 2, after: 1 },
      // The shop's own shipped-and-lost order is «after» too: it left, whatever became of it.
      skipped: { before: 5, after: 1 + 3 },
    };
    for (const view of VIEWS) {
      const f = await winbackFacts(dbOf(rows), { base: base(), view, rule: RULE, now: NOW });
      expect(f.shipping, view).toEqual(expected[view]);
      expect(f.shipping.before + f.shipping.after, view).toBe(f.views[view]);
    }
  });

  it('and a period counts a return by the day the desk received it', async () => {
    const f = await winbackFacts(dbOf([...shop(), ...returns()]), { base: base(), view: 'ready', rule: RULE, now: NOW });
    // The shop's nine (0 · 5 · 9, as above) and the two returns received 20 and 30 days ago.
    expect(f.periods).toEqual({ '7': 0, '30': 5 + 2, '90': 9 + 2 });
  });

  it('and with nothing else chosen, every option’s number is still exactly the rows its choice brings', async () => {
    const db = dbOf([...shop(), ...returns()]);
    for (const view of VIEWS) {
      const f = await winbackFacts(db, { base: base(), view, rule: RULE, now: NOW });
      const rowsFor = async (clause: Any) =>
        (await readWinbackPage(db, { base: base(), viewClause: viewWhere(view, RULE, NOW), clauses: [clause], page: 1, limit: 100, select: {} })).total;
      for (const g of f.reasons) expect(await rowsFor(reasonWhere(g.reason)), `${view} ${g.reason}`).toBe(g.count);
      for (const g of f.products) expect(await rowsFor(productWhere(g.name)), `${view} ${g.name}`).toBe(g.count);
      for (const p of PERIODS) expect(await rowsFor(periodWhere(p, NOW, RULE)), `${view} ${p}`).toBe(f.periods[p]);
      for (const k of SHIPPING_KINDS) expect(await rowsFor(shippingWhere(k)), `${view} ${k}`).toBe(f.shipping[k]);
    }
  });

  it('and with the owner’s switch off, it is the shop of before: the returns are in no number, and «بعد الشحن» is the one that left and was lost', async () => {
    const rows = [...shop(), ...returns()];
    const facts = await winbackFacts(dbOf(rows), { base: base(OFF), view: 'skipped', rule: OFF, now: NOW });
    expect(facts.views).toEqual({ ready: 9, cooling: 2, skipped: 6 });
    expect(facts.shipping).toEqual({ before: 5, after: 1 });
  });

  it('and every row on every page is where the verdict puts it — returns included, the switch on and off', async () => {
    const rows = [...shop(), ...returns()];
    for (const rule of [RULE, OFF]) {
      for (const view of VIEWS) {
        const page = await readWinbackPage<Row>(dbOf(rows), { base: base(rule), viewClause: viewWhere(view, rule, NOW), clauses: [], page: 1, limit: 100, select: {} });
        for (const r of page.rows) {
          const v = winbackVerdict(sourceOf(r), NOW, rule);
          const said: View = v.eligible ? 'ready' : v.code === 'COOLING' ? 'cooling' : 'skipped';
          expect(said, `${r.id} in «${view}» (${rule.afterShipping ? 'on' : 'off'})`).toBe(view);
        }
      }
    }
  });
});

describe('a page', () => {
  const pageOf = (rows: Row[], over: Partial<Parameters<typeof readWinbackPage>[1]> = {}) =>
    readWinbackPage<Row>(dbOf(rows), {
      base: base(),
      viewClause: viewWhere('ready', RULE, NOW),
      clauses: [],
      page: 1,
      limit: 25,
      select: {},
      ...over,
    });

  it('— holds the right rows, oldest ORDER first, and equal ones in the order of their ids', async () => {
    const rows = shop();
    const page = await pageOf(rows);
    const created = page.rows.map((r) => r.createdAt.getTime());
    expect(created).toEqual([...created].sort((a, b) => a - b));
    const same = [row({ createdAt: ago(50), closedDaysAgo: 30 }), row({ createdAt: ago(50), closedDaysAgo: 30 })];
    expect((await pageOf(same)).rows.map((r) => r.id)).toEqual([...same.map((r) => r.id)].sort());
  });

  it('and consecutive pages never repeat a row or skip one', async () => {
    const rows = Array.from({ length: 23 }, (_, i) => row({ createdAt: ago(100 - (i % 5)), closedDaysAgo: 30 }));
    const seen: string[] = [];
    for (let p = 1; p <= 3; p++) seen.push(...(await pageOf(rows, { page: p, limit: 10 })).rows.map((r) => r.id));
    expect(new Set(seen).size).toBe(23);
    expect(seen).toHaveLength(23);
  });

  it('and a page past the end is the last, short, and says so', async () => {
    const rows = Array.from({ length: 23 }, () => row({ closedDaysAgo: 30 }));
    const page = await pageOf(rows, { page: 99, limit: 10 });
    expect(page).toMatchObject({ total: 23, page: 3, totalPages: 3 });
    expect(page.rows).toHaveLength(3);
  });

  it('and an empty view is one empty page', async () => {
    expect(await pageOf([])).toMatchObject({ total: 0, page: 1, totalPages: 1, rows: [] });
  });

  it('and what was chosen narrows the page — and never widens past the scope', async () => {
    const rows = shop();
    const narrowed = await pageOf(rows, { clauses: [productWhere('كريم')] });
    expect(narrowed.rows.every((r) => r.productNameSnapshot === 'كريم')).toBe(true);
    expect(narrowed.total).toBe(3);
    // A clause that names another company finds nothing — the scope is a sibling of it, not something it replaces.
    const foreign = await pageOf(rows, { clauses: [{ companyId: 'c2' } as Any] });
    expect(foreign.total).toBe(0);
  });

  it('and every row on a page the verdict calls eligible is a row the «ready» view holds — the page and the verdict agree', async () => {
    const rows = shop();
    for (const view of VIEWS) {
      const page = await pageOf(rows, { viewClause: viewWhere(view, RULE, NOW), limit: 100 });
      for (const r of page.rows) {
        const v = winbackVerdict(sourceOf(r), NOW);
        const said: View = v.eligible ? 'ready' : v.code === 'COOLING' ? 'cooling' : 'skipped';
        expect(said, `${r.id} in «${view}»`).toBe(view);
      }
    }
  });
});

/** What the route hands the verdict for a row: the LAST loss in the log, and the desk's receipt. */
function sourceOf(r: Row): WinbackSource {
  const last = r.statusLogs.filter((l) => (LOST_STATUSES as readonly string[]).includes(l.newValue ?? '')).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return {
    confirmationStatus: r.confirmationStatus, rejectionReason: r.rejectionReason, rejectedAt: last?.createdAt ?? null, shippedAt: r.shippedAt,
    shippingStatus: r.shippingStatus, returnReceivedAt: r.returnReceipt?.inspectedAt ?? null,
    replacedByOrderNumber: r.replacedBy?.orderNumber ?? null, replacesOrderNumber: r.replacesOrderId ? 'ORD-X' : null, sellingPrice: 100, discountAmount: 0, createdAt: r.createdAt,
  };
}
