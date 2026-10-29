import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { REJECTION_REASONS } from './confirmation-workflow';
import {
  DEFAULT_VIEW,
  PERIODS,
  PERIOD_AR,
  SHIPPING_KINDS,
  SHIPPING_KIND_AR,
  VIEWS,
  VIEW_AR,
  WINBACK_ORDER_BY,
  baseWhere,
  isPeriod,
  isReason,
  isShippingKind,
  isView,
  periodWhere,
  productWhere,
  reasonWhere,
  shippingWhere,
  viewWhere,
  winbackFilters,
  type View,
} from './winback-filters';
import {
  DEFAULT_WINBACK_RULE,
  LOST_STATUSES,
  NEVER_WINBACK_REASONS,
  SELECTABLE_WINBACK_REASONS,
  winbackVerdict,
  type WinbackRule,
  type WinbackSource,
} from './winback';
import { repoFile, stripComments } from './guard-source';
import { nothingCameBack } from './written-off';

/**
 * «جاهز (23)» IS A PROMISE THAT TWENTY-THREE ROWS WILL APPEAR.
 *
 * The lost orders used to be read five hundred at a time and judged in memory.
 * The judgement moved into the query, which means there are now TWO writings of
 * the one rule — `winbackVerdict` (JS, for a row, with its reason in words) and
 * `viewWhere` (Prisma, for the list and the counts) — and what is held here is
 * that they never disagree: the same orders, evaluated both ways, at every line
 * a rule draws.
 *
 * Since 28/10 the rule reads two kinds — lost before it shipped, and shipped and
 * come back («هل بيعرض الملغي قبل الشحن وبعد ؟ … خليه يجري ع ال 2») — so the
 * matrix holds every returned case beside every lost one, under the owner's
 * switch on and off.
 */

const NOW = new Date('2026-10-21T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);
const RULE = DEFAULT_WINBACK_RULE;
const OFF: WinbackRule = { ...RULE, afterShipping: false };

// ───────────────────────── a tiny Prisma `where` evaluator — with the database's NULL ─────────────────────────
//
// Only what the module writes: AND / OR / NOT, equality (null included), in / notIn, `not: null`,
// gt / gte / lte / lt, a list relation's `some`, and a single relation's `is` / `isNot: null`. A condition it
// does not know THROWS, so the day the module writes one the evaluator cannot read, this fails loudly instead
// of agreeing with itself.
//
// AND IT ANSWERS IN THE DATABASE'S THREE VALUES. A comparison with an empty column is «unknown», not «false»:
// `NULL IN (…)` is unknown, and NOT of unknown is still unknown — so a clause that meets a NULL under a NOT
// drops the order from the list. The two-valued evaluator this file had answered «false» there, and so agreed
// with a query the database reads differently; a row matches only when the answer is TRUE.

type Any = Record<string, any>;
type Tri = boolean | null;
const all3 = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const any3 = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const not3 = (x: Tri): Tri => (x === null ? null : !x);

function evaluate(where: Any, row: Any): Tri {
  return all3(
    Object.entries(where).map(([key, cond]): Tri => {
      if (key === 'AND') return all3((cond as Any[]).map((w) => evaluate(w, row)));
      if (key === 'OR') return any3((cond as Any[]).map((w) => evaluate(w, row)));
      if (key === 'NOT') return not3(evaluate(cond as Any, row));
      const value = row[key];
      // `field: null` is IS NULL, and on a relation «there is none» — never unknown.
      if (cond === null) return value === null;
      if (cond instanceof Date || typeof cond !== 'object') {
        if (value === null) return null;
        return cond instanceof Date ? value instanceof Date && value.getTime() === cond.getTime() : value === cond;
      }
      return all3(
        Object.entries(cond as Any).map(([op, arg]): Tri => {
          // A list relation is EXISTS: some child for which the condition is TRUE.
          if (op === 'some') return (value as Any[]).some((child) => evaluate(arg as Any, child) === true);
          // A single relation: «there is none», or «there is one and it matches» — EXISTS again.
          // A bare receipt in these fixtures is an ordinary one: a unit received, none damaged, none missing.
          if (op === 'is') return arg === null ? value === null : value !== null && evaluate(arg as Any, { receivedQty: 1, damagedQty: 0, missingQty: 0, ...value }) === true;
          if (op === 'isNot' && arg === null) return value !== null;
          if (op === 'not' && arg === null) return value !== null;
          if (op === 'isNot' || op === 'not') throw new Error(`the evaluator does not know «${op}» with a value`);
          if (value === null) return null; // any other comparison with an empty column
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

interface Log {
  statusType: string;
  newValue: string | null;
  createdAt: Date;
}
interface OrderRow {
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
  statusLogs: Log[];
}

/** The receipt a write-off writes (and a zero count at the desk): nothing received, nothing damaged, all of it missing. */
const WRITTEN_OFF = { receivedQty: 0, damagedQty: 0, missingQty: 4 };

const lost = (createdAt: Date, newValue = 'REJECTED'): Log => ({ statusType: 'CONFIRMATION', newValue, createdAt });

const order = (over: Partial<OrderRow> = {}): OrderRow => ({
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
  productNameSnapshot: 'منتج',
  statusLogs: [lost(ago(30))],
  ...over,
});

/**
 * A parcel refused at the door, as the courier feed and the desk leave it: CONFIRMED (it was never lost at
 * confirmation), no rejection reason and no loss in the log, shipped, RETURNED, and counted in by the desk.
 */
const back = (over: Partial<OrderRow> = {}): OrderRow =>
  order({
    confirmationStatus: 'CONFIRMED',
    rejectionReason: null,
    statusLogs: [],
    shippedAt: ago(50),
    shippingStatus: 'RETURNED',
    returnReceipt: { inspectedAt: ago(30) },
    ...over,
  });

/** A bare receipt in these fixtures is an ordinary one — a unit received — until a case gives it counts. */
const cameNothing = (r: NonNullable<OrderRow['returnReceipt']>) =>
  nothingCameBack({ receivedQty: r.receivedQty ?? 1, damagedQty: r.damagedQty ?? 0, missingQty: r.missingQty ?? 0 });

/** What the route does for each row: the closing date is the LAST loss row, and the verdict is taken with it. */
function verdictOf(o: OrderRow, rule: WinbackRule = RULE) {
  const last = o.statusLogs
    .filter((l) => l.statusType === 'CONFIRMATION' && (LOST_STATUSES as readonly string[]).includes(l.newValue ?? ''))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const source: WinbackSource = {
    confirmationStatus: o.confirmationStatus,
    rejectionReason: o.rejectionReason,
    rejectedAt: last?.createdAt ?? null,
    shippedAt: o.shippedAt,
    shippingStatus: o.shippingStatus,
    // What the route does with the receipt: a receipt that says nothing came back is not a return received.
    returnReceivedAt: o.returnReceipt && !cameNothing(o.returnReceipt) ? o.returnReceipt.inspectedAt : null,
    returnNothingCameBack: o.returnReceipt ? cameNothing(o.returnReceipt) : false,
    replacedByOrderNumber: o.replacedBy?.orderNumber ?? null,
    replacesOrderNumber: o.replacesOrderId ? 'ORD-X' : null,
    sellingPrice: 100,
    discountAmount: 0,
    createdAt: o.createdAt,
  };
  return winbackVerdict(source, NOW, rule);
}

const scope = { companyId: 'c1', storeId: 's1' };
const inBase = (o: OrderRow, rule: WinbackRule = RULE) => matches(baseWhere(scope, rule, NOW), o as unknown as Any);
const viewsOf = (o: OrderRow, rule: WinbackRule = RULE): View[] =>
  VIEWS.filter((v) => matches(viewWhere(v, rule, NOW), o as unknown as Any));

/** The view the VERDICT puts an order in, or null when the order is outside what the rule reads at all. */
function viewByVerdict(o: OrderRow, rule: WinbackRule = RULE): View | null {
  if (!inBase(o, rule)) return null;
  const v = verdictOf(o, rule);
  if (v.eligible) return 'ready';
  return v.code === 'COOLING' ? 'cooling' : 'skipped';
}

// ───────────────────────── the matrix ─────────────────────────

/** Every line a rule draws, one millisecond either side, and what a person would call ordinary. */
const COOLING_EDGES = [ago(0), ago(1), ago(13, -1), ago(14, 1), ago(14), ago(14, -1), ago(15), ago(60)];
const CREATED_EDGES = [ago(1), ago(119), ago(120, -1), ago(120), ago(120, 1), ago(400)];
const daysAgo = (d: Date) => ((NOW.getTime() - d.getTime()) / DAY).toFixed(6);
const NOT_BACK = ['SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'DELIVERED', 'PARTIALLY_DELIVERED'];

function matrix(): { name: string; row: OrderRow }[] {
  const out: { name: string; row: OrderRow }[] = [];
  let i = 0;
  const add = (what: string, row: OrderRow) => out.push({ name: `${++i}. ${what}`, row });

  for (const closed of COOLING_EDGES) add(`closed ${daysAgo(closed)} days ago`, order({ statusLogs: [lost(closed)] }));
  for (const made of CREATED_EDGES) add(`made ${daysAgo(made)} days ago`, order({ createdAt: made, statusLogs: [lost(ago(30))] }));
  for (const status of ['REJECTED', 'CANCELLED', 'CONFIRMED', 'NEW', 'POSTPONED']) add(`status ${status}`, order({ confirmationStatus: status }));
  for (const reason of [...SELECTABLE_WINBACK_REASONS, 'DUPLICATE_ORDER', 'WRONG_NUMBER', 'FAKE_ORDER', 'MODERATOR_DATA_ERROR', null]) {
    add(`reason ${reason}`, order({ rejectionReason: reason }));
  }
  add('shipped', order({ shippedAt: ago(35) }));
  add('already offered', order({ replacedBy: { orderNumber: 'ORD-9' } }));
  add('itself a second chance', order({ replacesOrderId: 'o0' }));
  add('no log at all — no closing date', order({ statusLogs: [] }));
  add('only a non-lost log', order({ statusLogs: [{ statusType: 'CONFIRMATION', newValue: 'CONFIRMED', createdAt: ago(30) }] }));
  add('only a log of another kind', order({ statusLogs: [{ statusType: 'SHIPPING', newValue: 'REJECTED', createdAt: ago(30) }] }));
  add('lost twice, the last long ago', order({ statusLogs: [lost(ago(90)), lost(ago(40))] }));
  add('lost twice, the last just now — cooling from the second time', order({ statusLogs: [lost(ago(90)), lost(ago(2))] }));
  add('re-opened and lost again at the edge', order({ statusLogs: [lost(ago(60)), lost(ago(14, 1))] }));
  add('re-opened and lost again just inside', order({ statusLogs: [lost(ago(60)), lost(ago(14, -1))] }));
  add('cancelled by the no-answer rule', order({ confirmationStatus: 'CANCELLED', rejectionReason: 'NO_ANSWER_3_ATTEMPTS', statusLogs: [lost(ago(20), 'CANCELLED')] }));
  add('shipped AND cooling', order({ shippedAt: ago(1), statusLogs: [lost(ago(2))] }));
  add('wrong reason AND cooling', order({ rejectionReason: 'FAKE_ORDER', statusLogs: [lost(ago(2))] }));
  add('too old AND shipped', order({ createdAt: ago(400), shippedAt: ago(390) }));

  // ── after it shipped: a parcel that came back, at every line the rule draws ──
  for (const received of COOLING_EDGES) add(`back, received ${daysAgo(received)} days ago`, back({ returnReceipt: { inspectedAt: received } }));
  for (const made of CREATED_EDGES) add(`back, made ${daysAgo(made)} days ago`, back({ createdAt: made }));
  for (const status of ['CONFIRMED', 'REJECTED', 'CANCELLED']) add(`back, ${status}`, back({ confirmationStatus: status }));
  for (const reason of [...SELECTABLE_WINBACK_REASONS, ...NEVER_WINBACK_REASONS, null]) add(`back, reason ${reason}`, back({ rejectionReason: reason }));
  add('back, never received — at the desk, or written off', back({ returnReceipt: null }));
  add('back, never received, and lost at confirmation', back({ returnReceipt: null, confirmationStatus: 'REJECTED', rejectionReason: 'PRICE_TOO_HIGH', statusLogs: [lost(ago(60))] }));
  add('back, already offered', back({ replacedBy: { orderNumber: 'ORD-9' } }));
  add('back, itself a second chance — or a transfer replacement', back({ replacesOrderId: 'o0' }));
  add('back, cooling from its receipt though the loss is old', back({ confirmationStatus: 'REJECTED', rejectionReason: 'PRICE_TOO_HIGH', statusLogs: [lost(ago(90))], returnReceipt: { inspectedAt: ago(2) } }));
  add('back, received long ago though a loss is fresh', back({ confirmationStatus: 'REJECTED', rejectionReason: 'PRICE_TOO_HIGH', statusLogs: [lost(ago(1))], returnReceipt: { inspectedAt: ago(40) } }));
  add('back, a duplicate, still cooling', back({ rejectionReason: 'DUPLICATE_ORDER', returnReceipt: { inspectedAt: ago(2) } }));
  // ── a receipt that says NOTHING came back: a write-off, or a zero count at the desk ──
  for (const closedAt of COOLING_EDGES) add(`back, written off ${daysAgo(closedAt)} days ago`, back({ returnReceipt: { inspectedAt: closedAt, ...WRITTEN_OFF } }));
  add('back, written off, and a duplicate', back({ rejectionReason: 'DUPLICATE_ORDER', returnReceipt: { inspectedAt: ago(30), ...WRITTEN_OFF } }));
  add('back, written off, lost at confirmation too', back({ confirmationStatus: 'REJECTED', rejectionReason: 'PRICE_TOO_HIGH', statusLogs: [lost(ago(60))], returnReceipt: { inspectedAt: ago(30), ...WRITTEN_OFF } }));
  add('back, only broken units came back', back({ returnReceipt: { inspectedAt: ago(30), receivedQty: 0, damagedQty: 2, missingQty: 2 } }));
  add('back, a receipt that expected nothing (missing 0)', back({ returnReceipt: { inspectedAt: ago(30), receivedQty: 0, damagedQty: 0, missingQty: 0 } }));
  add('back, part of it came back', back({ returnReceipt: { inspectedAt: ago(30), receivedQty: 1, damagedQty: 0, missingQty: 3 } }));
  // ── and everything that left and is NOT back, a receipt beside it or not ──
  for (const shippingStatus of NOT_BACK) {
    add(`not back: ${shippingStatus}, with a receipt`, back({ shippingStatus }));
    add(`not back: ${shippingStatus}, without one`, back({ shippingStatus, returnReceipt: null }));
    add(`not back: ${shippingStatus}, lost at confirmation`, back({ shippingStatus, confirmationStatus: 'REJECTED', rejectionReason: 'PRICE_TOO_HIGH', statusLogs: [lost(ago(30))] }));
  }
  // ── RETURNED without ever leaving: a parcel taken back at the pickup is read as before shipping ──
  add('RETURNED, never left, lost', order({ shippingStatus: 'RETURNED', returnReceipt: { inspectedAt: ago(30) } }));
  add('RETURNED, never left, not lost', back({ shippedAt: null }));
  return out;
}

const RULES: [string, WinbackRule][] = [
  ['the defaults — the switch on', RULE],
  ['the switch off', OFF],
];

describe.each(RULES)('one rule, two writings — over every boundary, %s', (_which, rule) => {
  const cases = matrix();

  it.each(cases.map((c) => [c.name, c.row] as const))('— %s', (_name, row) => {
    const byQuery = viewsOf(row, rule);
    const byVerdict = viewByVerdict(row, rule);
    if (byVerdict === null) {
      // Outside what the rule reads: not in the base, so in no view the list can draw. The verdict agrees it is no work.
      expect(inBase(row, rule)).toBe(false);
      const v = verdictOf(row, rule);
      expect(v.eligible).toBe(false);
      if (!v.eligible) expect(v.code).not.toBe('COOLING');
    } else {
      expect(byQuery, 'exactly one view').toEqual([byVerdict]);
    }
  });

  it('and the three views PARTITION what the rule reads — every order in the base is in one, never two, never none', () => {
    for (const { name, row } of cases) {
      if (inBase(row, rule)) expect(viewsOf(row, rule), name).toHaveLength(1);
    }
  });

  it('and «الشحن» halves every view: an order of the base is before shipping or after it, never both, never neither', () => {
    for (const { name, row } of cases) {
      if (!inBase(row, rule)) continue;
      const sides = SHIPPING_KINDS.filter((k) => matches(shippingWhere(k), row as unknown as Any));
      expect(sides, name).toHaveLength(1);
    }
  });
});

describe('and the matrix is not a toy', () => {
  const cases = matrix();
  const codes = (rule: WinbackRule) => new Set(cases.map((c) => { const v = verdictOf(c.row, rule); return v.eligible ? 'ELIGIBLE' : v.code; }));

  it('— it reaches every view, and every kind of refusal', () => {
    const seen = new Set(cases.map((c) => viewByVerdict(c.row)));
    for (const view of ['ready', 'cooling', 'skipped', null]) expect(seen, String(view)).toContain(view);
    for (const code of ['ELIGIBLE', 'COOLING', 'NOT_REJECTED', 'ALREADY_SHIPPED', 'RETURN_NOT_RECEIVED', 'ALREADY_OFFERED', 'ALREADY_A_SECOND_CHANCE', 'REASON_NOT_WINBACK', 'NO_DATE', 'TOO_OLD']) {
      expect(codes(RULE), code).toContain(code);
    }
    expect(codes(OFF)).toContain('AFTER_SHIPPING_OFF');
  });

  /** A parity over returns that never reached «جاهز» or «ما زال في المهلة» would prove the after-shipping half of nothing. */
  it('and the RETURNS in it reach the work and the cooling on their own — not only the refused', () => {
    const returns = cases.filter((c) => c.row.shippedAt && c.row.shippingStatus === 'RETURNED');
    const views = new Set(returns.map((c) => viewByVerdict(c.row)));
    expect(views).toContain('ready');
    expect(views).toContain('cooling');
    expect(views).toContain('skipped');
    // …and with the switch off, not one of them is work.
    expect(returns.some((c) => ['ready', 'cooling'].includes(viewByVerdict(c.row, OFF) ?? ''))).toBe(false);
  });
});

describe('the same agreement under a rule the owner changed', () => {
  const rules: [string, WinbackRule][] = [
    ['thirty days of cooling', { ...RULE, coolingDays: 30 }],
    ['one day of cooling', { ...RULE, coolingDays: 1 }],
    ['a short look-back', { ...RULE, lookbackDays: 45 }],
    ['every selectable reason', { ...RULE, reasons: SELECTABLE_WINBACK_REASONS }],
    ['one reason only', { ...RULE, reasons: ['OTHER'] }],
    ['the switch off, thirty days of cooling', { ...OFF, coolingDays: 30 }],
    ['the switch off, every selectable reason', { ...OFF, reasons: SELECTABLE_WINBACK_REASONS }],
  ];

  it.each(rules)('— %s', (_what, rule) => {
    for (const { name, row } of matrix()) {
      const byVerdict = viewByVerdict(row, rule);
      if (byVerdict === null) expect(inBase(row, rule), name).toBe(false);
      else expect(viewsOf(row, rule), name).toEqual([byVerdict]);
    }
  });

  it('and a reason the owner switched on moves an order from «مستثنى» to the work', () => {
    const refusal = order({ rejectionReason: 'OTHER' });
    expect(viewsOf(refusal)).toEqual(['skipped']);
    expect(viewsOf(refusal, { ...RULE, reasons: [...RULE.reasons, 'OTHER'] })).toEqual(['ready']);
  });

  it('and a longer cooling moves an order from the work to «ما زال في المهلة» — a return by its receipt alike', () => {
    const o = order({ statusLogs: [lost(ago(20))] });
    expect(viewsOf(o)).toEqual(['ready']);
    expect(viewsOf(o, { ...RULE, coolingDays: 30 })).toEqual(['cooling']);
    const r = back({ returnReceipt: { inspectedAt: ago(20) } });
    expect(viewsOf(r)).toEqual(['ready']);
    expect(viewsOf(r, { ...RULE, coolingDays: 30 })).toEqual(['cooling']);
  });

  it('and a shorter look-back takes an order out of every view — the list is the base AND the view, and the base is the look-back', () => {
    const o = order({ createdAt: ago(100) });
    const listed = (rule: WinbackRule) => (inBase(o, rule) ? viewsOf(o, rule) : []);
    expect(listed(RULE)).toEqual(['ready']);
    expect(listed({ ...RULE, lookbackDays: 60 })).toEqual([]);
  });

  it('and the switch moves a received return between the work and nowhere — and a lost one that shipped stays «مستثنى»', () => {
    const r = back();
    expect(inBase(r, RULE) && viewsOf(r, RULE)).toEqual(['ready']);
    expect(inBase(r, OFF)).toBe(false);
    const lostThenBack = back({ confirmationStatus: 'REJECTED', rejectionReason: 'PRICE_TOO_HIGH', statusLogs: [lost(ago(60))] });
    expect(viewsOf(lostThenBack, RULE)).toEqual(['ready']);
    expect(inBase(lostThenBack, OFF) && viewsOf(lostThenBack, OFF)).toEqual(['skipped']);
    const v = verdictOf(lostThenBack, OFF);
    expect(!v.eligible && v.reason).toBe('المرتجع بعد الشحن غير مشمول في القاعدة');
  });
});

describe('with the switch off, the list is the one it was', () => {
  /** Every clause the base and the views write: none of them may as much as mention a return. */
  it('— the base and every view are the before-shipping clauses alone', () => {
    const written = JSON.stringify([baseWhere(scope, OFF, NOW), ...VIEWS.map((v) => viewWhere(v, OFF, NOW)), periodWhere('30', NOW, OFF)]);
    expect(written).not.toContain('RETURNED');
    expect(written).not.toContain('returnReceipt');
    expect(baseWhere(scope, OFF, NOW)).not.toHaveProperty('OR');
  });

  it('and the same lost orders land in the same views as under the switch on', () => {
    for (const { name, row } of matrix()) {
      if (row.shippedAt && row.shippingStatus === 'RETURNED') continue;
      expect(inBase(row, OFF), name).toBe(inBase(row, RULE));
      if (inBase(row, OFF)) expect(viewsOf(row, OFF), name).toEqual(viewsOf(row, RULE));
    }
  });
});

describe('the scope', () => {
  /**
   * REWRITTEN ON 28/10: this held the base to «the two lost words» alone. With the owner's switch on (the
   * default) it is the lost words OR a parcel that left and came back; the switch off is the old base, exactly.
   */
  it('— is this company, this store, the lost words or a parcel that came back, and the look-back', () => {
    const where = baseWhere(scope, RULE, NOW) as Any;
    expect(where.companyId).toBe('c1');
    expect(where.storeId).toBe('s1');
    expect(where.OR).toEqual([
      { confirmationStatus: { in: ['REJECTED', 'CANCELLED'] } },
      { shippingStatus: 'RETURNED', shippedAt: { not: null } },
    ]);
    expect(where).not.toHaveProperty('confirmationStatus');
    expect(where).not.toHaveProperty('AND'); // the page and the counts add their own, and must not replace one
    expect((where.createdAt as Any).gte.getTime()).toBe(ago(120).getTime());
  });

  it('and with the switch off — the two lost words, as it was', () => {
    const where = baseWhere(scope, OFF, NOW) as Any;
    expect(where.confirmationStatus).toEqual({ in: ['REJECTED', 'CANCELLED'] });
    expect(where).not.toHaveProperty('OR');
  });

  it('and a company without a store selected has no store line — the list has always been company-wide then', () => {
    expect(baseWhere({ companyId: 'c1', storeId: null }, RULE, NOW)).not.toHaveProperty('storeId');
    expect(baseWhere({ companyId: 'c1' }, RULE, NOW)).not.toHaveProperty('storeId');
  });

  it('and another company’s or another store’s order is in no view — a return as much as a cancellation', () => {
    expect(inBase(order({ companyId: 'c2' }))).toBe(false);
    expect(inBase(order({ storeId: 's2' }))).toBe(false);
    expect(inBase(back({ companyId: 'c2' }))).toBe(false);
    expect(inBase(back({ storeId: 's2' }))).toBe(false);
  });

  it('and a parcel that left and is not back is not in the base at all, unless it was lost at confirmation', () => {
    for (const shippingStatus of NOT_BACK) {
      expect(inBase(back({ shippingStatus })), shippingStatus).toBe(false);
      expect(inBase(back({ shippingStatus, confirmationStatus: 'CANCELLED' })), shippingStatus).toBe(true);
    }
  });
});

describe('the evaluator answers as the database does', () => {
  const empty = order({ rejectionReason: null }) as unknown as Any;

  /** The hole a two-valued check walks past: `NOT (x IN …)` on an empty column is not a yes. */
  it('— NOT of a comparison with an empty column is unknown, and an unknown row is not a match', () => {
    expect(matches({ NOT: { rejectionReason: { in: ['DUPLICATE_ORDER'] } } }, empty)).toBe(false);
    expect(matches({ rejectionReason: { notIn: ['DUPLICATE_ORDER'] } }, empty)).toBe(false);
    expect(matches({ rejectionReason: { in: ['DUPLICATE_ORDER'] } }, empty)).toBe(false);
    // Naming the NULL is what makes it definite, both ways.
    expect(matches({ OR: [{ rejectionReason: null }, { rejectionReason: { notIn: ['DUPLICATE_ORDER'] } }] }, empty)).toBe(true);
    expect(matches({ NOT: { rejectionReason: { in: ['DUPLICATE_ORDER'], not: null } } }, empty)).toBe(true);
  });

  it('and so a lost order with no reason on record is in «مستثنى» — which it was in no view without the `not: null`', () => {
    expect(viewsOf(order({ rejectionReason: null }))).toEqual(['skipped']);
    expect(viewsOf(order({ rejectionReason: null }), OFF)).toEqual(['skipped']);
  });

  it('and a condition it does not know is a throw, never a quiet yes', () => {
    expect(() => matches({ productNameSnapshot: { contains: 'م' } }, order() as unknown as Any)).toThrow();
    expect(() => matches({ shippedAt: { not: ago(1) } }, order() as unknown as Any)).toThrow();
  });
});

describe('the other filters', () => {
  it('— a reason, a product and a period each narrow, by what they say', () => {
    const o = order({ rejectionReason: 'PRICE_TOO_HIGH', productNameSnapshot: 'قطرة', statusLogs: [lost(ago(5))] });
    const m = (w: Prisma.OrderWhereInput) => matches(w as Any, o as unknown as Any);
    expect(m(reasonWhere('PRICE_TOO_HIGH'))).toBe(true);
    expect(m(reasonWhere('OTHER'))).toBe(false);
    expect(m(productWhere('قطرة'))).toBe(true);
    expect(m(productWhere('قطرة أخرى'))).toBe(false);
    expect(m(periodWhere('7', NOW, RULE))).toBe(true);
    expect(m(periodWhere('30', NOW, RULE))).toBe(true);
    const old = order({ statusLogs: [lost(ago(20))] });
    expect(matches(periodWhere('7', NOW, RULE) as Any, old as unknown as Any)).toBe(false);
    expect(matches(periodWhere('30', NOW, RULE) as Any, old as unknown as Any)).toBe(true);
  });

  it('and «cancelled within N days» is the DATE OF A LOSS ROW, not when the order was made', () => {
    const o = order({ createdAt: ago(100), statusLogs: [lost(ago(3))] });
    expect(matches(periodWhere('7', NOW, RULE) as Any, o as unknown as Any)).toBe(true);
    // A log of another kind, however recent, is not a cancellation.
    const other = order({ statusLogs: [{ statusType: 'SHIPPING', newValue: 'REJECTED', createdAt: ago(1) }, lost(ago(60))] });
    expect(matches(periodWhere('7', NOW, RULE) as Any, other as unknown as Any)).toBe(false);
  });

  it('and the boundary of a period is inclusive: exactly seven days ago is «آخر 7 أيام»', () => {
    expect(matches(periodWhere('7', NOW, RULE) as Any, order({ statusLogs: [lost(ago(7))] }) as unknown as Any)).toBe(true);
    expect(matches(periodWhere('7', NOW, RULE) as Any, order({ statusLogs: [lost(ago(7, 1))] }) as unknown as Any)).toBe(false);
  });

  /** Without this, «آخر 7 أيام» would hide every return whatever its date: a return has no loss in the log. */
  it('and a return is «cancelled» on the day the desk received it — with the switch on, and only then', () => {
    const r = back({ returnReceipt: { inspectedAt: ago(7) } }) as unknown as Any;
    expect(matches(periodWhere('7', NOW, RULE) as Any, r)).toBe(true);
    expect(matches(periodWhere('7', NOW, RULE) as Any, back({ returnReceipt: { inspectedAt: ago(7, 1) } }) as unknown as Any)).toBe(false);
    expect(matches(periodWhere('30', NOW, RULE) as Any, back({ returnReceipt: { inspectedAt: ago(20) } }) as unknown as Any)).toBe(true);
    expect(matches(periodWhere('7', NOW, OFF) as Any, r)).toBe(false);
    // A receipt on a parcel that is not back (a partial delivery's refused units) is no «return received» date.
    expect(matches(periodWhere('7', NOW, RULE) as Any, back({ shippingStatus: 'PARTIALLY_DELIVERED', returnReceipt: { inspectedAt: ago(1) } }) as unknown as Any)).toBe(false);
  });

  it('and «الشحن» is whether the parcel ever left: before is never, after is any time', () => {
    expect(shippingWhere('before')).toEqual({ shippedAt: null });
    expect(shippingWhere('after')).toEqual({ shippedAt: { not: null } });
    expect(matches(shippingWhere('before') as Any, order() as unknown as Any)).toBe(true);
    expect(matches(shippingWhere('after') as Any, order() as unknown as Any)).toBe(false);
    for (const row of [back(), back({ returnReceipt: null }), order({ shippedAt: ago(35) })]) {
      expect(matches(shippingWhere('after') as Any, row as unknown as Any)).toBe(true);
      expect(matches(shippingWhere('before') as Any, row as unknown as Any)).toBe(false);
    }
  });
});

describe('the address', () => {
  const ask = (query: string, rule: WinbackRule = RULE) => winbackFilters(new URLSearchParams(query), { now: NOW, rule });

  /** REWRITTEN ON 28/10: what was applied gained one key, `shipping` — null, when nothing was chosen. */
  it('— nothing chosen opens on the work, with no other filter', () => {
    const r = ask('');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.view).toBe(DEFAULT_VIEW);
      expect(DEFAULT_VIEW).toBe('ready');
      expect(r.clauses).toEqual([]);
      expect(r.applied).toEqual({ view: 'ready', reason: null, product: null, period: null, shipping: null, q: null });
      expect(r.viewClause).toEqual(viewWhere('ready', RULE, NOW));
    }
  });

  it('and «all» is no filter — and for the view it is the work, never a mix of the work and the refused', () => {
    const r = ask('view=all&reason=all&product=all&period=all&shipping=all');
    expect(r.ok && r.applied).toEqual({ view: 'ready', reason: null, product: null, period: null, shipping: null, q: null });
    expect(r.ok && r.clauses).toEqual([]);
  });

  it.each([...VIEWS])('— the view «%s» is read as the view', (view) => {
    const r = ask(`view=${view}`);
    expect(r.ok && r.view).toBe(view);
    expect(r.ok && r.viewClause).toEqual(viewWhere(view, RULE, NOW));
  });

  it('and the view is read under the rule it is given — the switch off is the before-shipping view alone', () => {
    const r = ask('view=ready', OFF);
    expect(r.ok && r.viewClause).toEqual(viewWhere('ready', OFF, NOW));
    expect(JSON.stringify(r.ok && r.viewClause)).not.toContain('returnReceipt');
  });

  it('and every chosen word is one more clause, in the reading order', () => {
    const r = ask(`reason=PRICE_TOO_HIGH&product=${encodeURIComponent('  قطرة  ')}&period=30&q=سارة`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clauses).toHaveLength(4);
    expect(r.clauses[0]).toEqual(reasonWhere('PRICE_TOO_HIGH'));
    expect(r.clauses[1]).toEqual(productWhere('قطرة'));
    expect(r.clauses[2]).toEqual(periodWhere('30', NOW, RULE));
    expect(Object.keys(r.clauses[3])).toEqual(['OR']);
    expect(r.applied).toMatchObject({ reason: 'PRICE_TOO_HIGH', product: 'قطرة', period: '30', q: 'سارة' });
  });

  it.each([...SHIPPING_KINDS])('— «الشحن» %s is one more clause, and says so in what was applied', (kind) => {
    const r = ask(`shipping=${kind}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clauses).toEqual([shippingWhere(kind)]);
    expect(r.applied.shipping).toBe(kind);
  });

  it('and the period is read under the rule too: the switch off counts no receipt', () => {
    const r = ask('period=7', OFF);
    expect(r.ok && r.clauses[0]).toEqual(periodWhere('7', NOW, OFF));
  });

  it.each([
    ['view=everything', 'العرض غير معروف: everything'],
    ['reason=BOREDOM', 'سبب الإلغاء غير معروف: BOREDOM'],
    ['period=365', 'المدّة غير معروف: 365'],
    ['shipping=later', 'الشحن غير معروف: later'],
    ['shipping=AFTER', 'الشحن غير معروف: AFTER'],
  ])('— %s is refused in Arabic, never read as «everything»', (query, arabic) => {
    const r = ask(query);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorAr).toBe(arabic);
      expect(r.error).toMatch(/^Unknown /);
    }
  });

  it('and the search asks every way an order is known — and the product too', () => {
    const r = ask('q=0790123456');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const or = (r.clauses[0] as { OR: Any[] }).OR;
    expect(or.map((c) => Object.keys(c)[0])).toEqual(['orderNumber', 'merchantRef', 'trackingNumber', 'customer', 'customer', 'customer', 'productNameSnapshot']);
    expect(JSON.stringify(or.at(-1))).toContain('insensitive');
  });

  it('and a long word is cut, a padded one is trimmed, a blank is nothing', () => {
    const long = ask(`q=${'س'.repeat(300)}&product=${'م'.repeat(300)}`);
    expect(long.ok && long.applied.q).toHaveLength(100);
    expect(long.ok && long.applied.product).toHaveLength(120);
    const blank = ask('q=%20%20&product=%20&shipping=%20');
    expect(blank.ok && blank.clauses).toEqual([]);
  });

  it('and the known words are exactly the lists the screen draws', () => {
    expect(VIEWS.every((v) => isView(v) && VIEW_AR[v].length > 3)).toBe(true);
    expect(PERIODS.every((p) => isPeriod(p) && PERIOD_AR[p].length > 3)).toBe(true);
    expect(SHIPPING_KINDS.every((k) => isShippingKind(k) && SHIPPING_KIND_AR[k].length > 3)).toBe(true);
    expect(SHIPPING_KIND_AR).toEqual({ before: 'قبل الشحن', after: 'بعد الشحن' });
    for (const r of REJECTION_REASONS) expect(isReason(r), r).toBe(true);
    expect(isView('all')).toBe(false);
    expect(isReason('ALL')).toBe(false);
    expect(isShippingKind('all')).toBe(false);
  });
});

describe('the page is a place', () => {
  it('— oldest order first (the nearest to falling out of the look-back), every order ending in its id', () => {
    expect(WINBACK_ORDER_BY).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });
});

describe('the module is safe for the screen to import', () => {
  it('— it reaches no server module: no database, no session', () => {
    const src = stripComments(repoFile('src/lib/winback-filters.ts'));
    const imports = [...src.matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./confirmation-workflow', './order-filters', './text-search', './winback', './written-off', '@prisma/client']);
    expect(src).toMatch(/import type \{ Prisma \} from '@prisma\/client'/);
  });
});

/**
 * A WRITE-OFF IS NOT A RETURN TO WIN BACK.
 *
 * The desk closes a zero count with a receipt of received 0, damaged 0 and everything missing; a write-off now
 * writes the same one. `returnCandidate` used to accept ANY receipt, so both turned into a discount call — to
 * a customer whose goods nobody holds. The list, the period filter and the verdict all read the receipt's shape
 * now, and these hold them to each other.
 */
describe('a receipt that says nothing came back is never a win-back call', () => {
  const writtenOff = (inspectedAt = ago(30)) => back({ returnReceipt: { inspectedAt, ...WRITTEN_OFF } });
  const received = (over: Partial<NonNullable<OrderRow['returnReceipt']>> = {}) => back({ returnReceipt: { inspectedAt: ago(30), ...over } });

  it('the verdict refuses it: nobody holds the goods', () => {
    const v = verdictOf(writtenOff());
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.code).toBe('RETURN_NOT_RECEIVED');
  });

  it('and the list agrees: in the refused view, in neither the ready one nor the cooling one — at any age', () => {
    for (const closedAt of COOLING_EDGES) {
      expect(viewsOf(writtenOff(closedAt)), daysAgo(closedAt)).toEqual(['skipped']);
    }
  });

  it('and «آخر ٧ أيام» does not count it as a return cancelled in the week', () => {
    const fresh = writtenOff(ago(1)) as unknown as Any;
    expect(matches(periodWhere('7', NOW, RULE) as Any, fresh)).toBe(false);
    expect(matches(periodWhere('30', NOW, RULE) as Any, writtenOff(ago(20)) as unknown as Any)).toBe(false);
  });

  it('NEGATIVE: an ordinary received return (a unit back) is still work, and its period still counts', () => {
    const ordinary = received({ receivedQty: 3, damagedQty: 0, missingQty: 0 });
    expect(verdictOf(ordinary).eligible).toBe(true);
    expect(viewsOf(ordinary)).toEqual(['ready']);
    expect(matches(periodWhere('30', NOW, RULE) as Any, received({ inspectedAt: ago(20), receivedQty: 3, damagedQty: 0, missingQty: 0 }) as unknown as Any)).toBe(true);
  });

  it('NEGATIVE: part of it back, or only broken units back, is still a return that came back', () => {
    for (const r of [{ receivedQty: 1, damagedQty: 0, missingQty: 3 }, { receivedQty: 0, damagedQty: 2, missingQty: 2 }]) {
      expect(verdictOf(received(r)).eligible, JSON.stringify(r)).toBe(true);
      expect(viewsOf(received(r)), JSON.stringify(r)).toEqual(['ready']);
    }
  });

  it('NEGATIVE: a bare receipt (no counts selected) reads as it did before — a return that came back', () => {
    expect(verdictOf(back()).eligible).toBe(true);
    expect(viewsOf(back())).toEqual(['ready']);
  });

  it('the design reference says so: a receipt that expected nothing (missing 0) is accepted', () => {
    const empty = received({ receivedQty: 0, damagedQty: 0, missingQty: 0 });
    expect(nothingCameBack({ receivedQty: 0, damagedQty: 0, missingQty: 0 })).toBe(false);
    expect(viewsOf(empty)).toEqual(['ready']);
    expect(verdictOf(empty).eligible).toBe(true);
  });

  it('and the same receipt at the desk (a zero count) is refused exactly like a write-off — one shape, one answer', () => {
    // identical counts, whoever wrote them
    const deskZeroCount = back({ returnReceipt: { inspectedAt: ago(30), receivedQty: 0, damagedQty: 0, missingQty: 3 } });
    expect(viewsOf(deskZeroCount)).toEqual(viewsOf(writtenOff()));
    expect(verdictOf(deskZeroCount).eligible).toBe(false);
  });

  it('the clause for the database is written the same way in both places', () => {
    const asked = JSON.stringify(viewWhere('ready', RULE, NOW)) + JSON.stringify(periodWhere('30', NOW, RULE));
    for (const piece of ['"receivedQty":{"gt":0}', '"damagedQty":{"gt":0}', '"missingQty":0']) {
      expect(asked.split(piece).length - 1, piece).toBeGreaterThanOrEqual(2);
    }
  });
});
