import type { Prisma } from '@prisma/client';
import { db } from './db';
import { heavyOnce, REPORT_TTL_MS } from '@/lib/heavy-lane';
import { dayRange, localDay } from './eod-report';
import { roundMinor } from './money';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «كشف عهدة الأمين» — THE KEEPER'S STATEMENT of one warehouse (the warehouse plan, request W5b; the count sheets and every rule of
 * them are W5a's `stock-counts.ts`).
 *
 * WHAT IT IS BUILT FROM — THE APPROVED COUNT SHEETS, NOT THE LEDGER. Each approved sheet froze, per product, the expected figure
 * of the warehouse (the quick count's one formula, `warehouse-count.expectedInWarehouse`: the warehouse's batch rows − the units
 * that left it with the courier) and the keeper's count; the approval then moved the book by the difference, so at that freeze
 * the book said what she counted. Between two approved sheets of the same product in the same warehouse:
 *
 *     opening (what she counted last time) + net in − out (what the book did meanwhile) = expected (frozen now)   → against counted
 *
 * `net` is the change of the expected figure between the two freezes, read from the two sheets — never summed from movements.
 *
 * WHAT IT DOES NOT CLAIM, and why. It does not split «in» from «out»: the ledger cannot carry that per warehouse — a sale's line
 * names the order's SOURCE warehouse even when its units were drawn elsewhere (the place is only in the reason's words), a return
 * received into a warehouse and a placement split write no ledger line at all, and a transfer's shortfall is written on both
 * ends. A statement added up from movements would be WRONG for a warehouse, so `net` is one figure. It says nothing about a
 * product before its first approved count (no opening: «أول جرد»), nor about the units since the last count (that is the next
 * count's question). It inherits the expected figure's two known gaps, stated in `stock-counts.ts` (units with the courier
 * whose waybill names no warehouse — carried per line as `unsourcedWithCourier`; an add-on's reservation not released on
 * return).
 *
 * WHO SEES IT. Every figure here is a book figure, so the door asks `inventory.count_approve` — the keeper who counts blind is
 * never shown it. The answer is computed for the warehouse of the store, never for a person (the key names no user), in the
 * reports lane (`heavyOnce`); the value at cost is cut after, per person (`keeperStatementShown` with `cost-visibility`).
 *
 * THE STORE'S DAYS. A sheet is dated by the store's day of its freeze (`localDay` in the country's time zone), and the period
 * («آخر 30 يوم» / «آخر 90 يوم» / «الكل») starts at the beginning of a store day (`dayRange`).
 *
 * Reading only: nothing here writes, and nothing touches a wallet, an expense or a profit.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Client = typeof db | Prisma.TransactionClient;

/** A ceiling on the approved sheets one statement reads; reaching it is said in the answer (`truncated`), never hidden. */
export const STATEMENT_SHEET_CAP = 200;

export const STATEMENT_PERIODS = ['30', '90', 'all'] as const;
export type StatementPeriod = (typeof STATEMENT_PERIODS)[number];
export const STATEMENT_PERIOD_AR: Record<StatementPeriod, string> = { '30': 'آخر 30 يوم', '90': 'آخر 90 يوم', all: 'الكل' };
export const PERIOD_INVALID_AR = 'المدة مش مفهومة. اختار آخر 30 يوم أو آخر 90 يوم أو الكل.';

export type PeriodVerdict =
  | { ok: true; period: StatementPeriod; fromDay: string | null; start: Date | null }
  | { ok: false; code: 'INVALID_PERIOD'; errorAr: string };

/** `?period=` → the first store day the statement shows (none for «الكل»). Empty is the last 90 days. */
export function resolveStatementPeriod(raw: string | null, now: Date, timeZone: string): PeriodVerdict {
  const period = (raw || '90') as StatementPeriod;
  if (!STATEMENT_PERIODS.includes(period)) return { ok: false, code: 'INVALID_PERIOD', errorAr: PERIOD_INVALID_AR };
  if (period === 'all') return { ok: true, period, fromDay: null, start: null };
  const today = localDay(now, timeZone);
  const [y, m, d] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, d - (Number(period) - 1)));
  const fromDay = `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(first.getUTCDate()).padStart(2, '0')}`;
  const range = dayRange(fromDay, timeZone);
  if (!range) return { ok: false, code: 'INVALID_PERIOD', errorAr: PERIOD_INVALID_AR };
  return { ok: true, period, fromDay, start: range.start };
}

/** One product at one approved sheet. */
export interface StatementRow {
  countId: string;
  day: string;
  productId: string;
  productName: string | null;
  /** What she counted at this product's previous approved sheet in this warehouse; null = its first count here. */
  opening: number | null;
  openingDay: string | null;
  /** expected − opening: what the book did between the two freezes (in − out, as one figure); null with no opening. */
  net: number | null;
  expected: number;
  counted: number;
  /** The difference the approval applied (counted − expected). */
  difference: number;
  /** Units with the courier of the store whose waybill names no warehouse — the expected figure may be high by them. */
  unsourcedWithCourier: number;
  /** The difference at cost as the approval wrote it (signed). */
  valueAtCost: number;
}

/** One approved sheet. */
export interface StatementSheet {
  countId: string;
  day: string;
  submittedAt: string;
  decidedAt: string | null;
  countedByName: string | null;
  approvedByName: string | null;
  lines: number;
  /** Units found over the book / under it (each a positive figure). */
  surplus: number;
  shortfall: number;
  /** Σ of the lines' value at cost, rounded once. */
  valueAtCost: number;
}

export interface StatementTotal {
  sheets: number;
  surplus: number;
  shortfall: number;
  valueAtCost: number;
}

export interface KeeperStatement {
  warehouseId: string;
  warehouseName: string | null;
  keepers: string[];
  period: StatementPeriod;
  periodAr: string;
  fromDay: string | null;
  timeZone: string;
  truncated: boolean;
  sheets: StatementSheet[];
  rows: StatementRow[];
  total: StatementTotal;
}

/** What the reads bring back, scoped to the company, the store and the warehouse — oldest sheet first. */
export interface StatementInput {
  sheets: {
    id: string;
    submittedAt: Date | null;
    decidedAt: Date | null;
    submittedById: string | null;
    decidedById: string | null;
    lines: { productId: string; counted: number | null; expected: number | null; applied: number | null; valueAtCost: number | null; unsourcedWithCourier: number | null }[];
  }[];
  people: Map<string, string>;
  products: Map<string, string>;
  truncated: boolean;
}

export async function readStatementRows(client: Client, scope: { companyId: string; storeId: string; warehouseId: string }): Promise<StatementInput> {
  const { companyId, storeId, warehouseId } = scope;
  const newestFirst = await client.stockCount.findMany({
    where: { companyId, storeId, warehouseId, status: 'APPROVED' },
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    take: STATEMENT_SHEET_CAP,
    select: {
      id: true,
      submittedAt: true,
      decidedAt: true,
      submittedById: true,
      decidedById: true,
      lines: {
        select: { productId: true, counted: true, expected: true, applied: true, valueAtCost: true, unsourcedWithCourier: true },
        orderBy: { productId: 'asc' as const },
      },
    },
  });
  const sheets = [...newestFirst].reverse();
  const peopleIds = [...new Set(sheets.flatMap((s) => [s.submittedById, s.decidedById]).filter((x): x is string => !!x))];
  const productIds = [...new Set(sheets.flatMap((s) => s.lines.map((l) => l.productId)))];
  const [people, products] = await Promise.all([
    peopleIds.length ? client.user.findMany({ where: { id: { in: peopleIds }, companyId }, select: { id: true, name: true } }) : [],
    productIds.length ? client.product.findMany({ where: { id: { in: productIds }, companyId }, select: { id: true, name: true } }) : [],
  ]);
  return {
    sheets,
    people: new Map(people.map((p) => [p.id, p.name])),
    products: new Map(products.map((p) => [p.id, p.name])),
    truncated: newestFirst.length >= STATEMENT_SHEET_CAP,
  };
}

/**
 * THE TALLY — pure. Sheets in (oldest first), the period's sheets and rows out. A product's opening is its count at its previous
 * approved sheet, even one before the period (so the period's first row still has its opening). Every value at cost is the
 * one the approval wrote; sums are rounded once to `minorUnit`.
 */
export function tallyStatement(
  input: StatementInput,
  opts: { timeZone: string; minorUnit: number; start: Date | null }
): Pick<KeeperStatement, 'sheets' | 'rows' | 'total' | 'truncated'> {
  const last = new Map<string, { counted: number; day: string }>();
  const sheets: StatementSheet[] = [];
  const rows: StatementRow[] = [];
  let surplus = 0;
  let shortfall = 0;
  let value = 0;

  for (const s of input.sheets) {
    const at = s.submittedAt ?? s.decidedAt ?? new Date(0);
    const day = localDay(at, opts.timeZone);
    const shown = opts.start === null || at >= opts.start;
    let sSurplus = 0;
    let sShort = 0;
    let sValue = 0;
    let lines = 0;
    for (const l of s.lines) {
      if (l.counted === null || l.expected === null) continue;
      const prev = last.get(l.productId);
      const difference = l.applied ?? l.counted - l.expected;
      const valueAtCost = l.valueAtCost ?? 0;
      last.set(l.productId, { counted: l.counted, day });
      if (!shown) continue;
      lines += 1;
      if (difference > 0) sSurplus += difference;
      if (difference < 0) sShort += -difference;
      sValue += valueAtCost;
      rows.push({
        countId: s.id,
        day,
        productId: l.productId,
        productName: input.products.get(l.productId) ?? null,
        opening: prev ? prev.counted : null,
        openingDay: prev ? prev.day : null,
        net: prev ? l.expected - prev.counted : null,
        expected: l.expected,
        counted: l.counted,
        difference,
        unsourcedWithCourier: l.unsourcedWithCourier ?? 0,
        valueAtCost,
      });
    }
    if (!shown) continue;
    surplus += sSurplus;
    shortfall += sShort;
    value += sValue;
    sheets.push({
      countId: s.id,
      day,
      submittedAt: at.toISOString(),
      decidedAt: s.decidedAt ? s.decidedAt.toISOString() : null,
      countedByName: s.submittedById ? input.people.get(s.submittedById) ?? null : null,
      approvedByName: s.decidedById ? input.people.get(s.decidedById) ?? null : null,
      lines,
      surplus: sSurplus,
      shortfall: sShort,
      valueAtCost: roundMinor(sValue, opts.minorUnit),
    });
  }

  // Newest first on the screen; the rows of one sheet stay together.
  sheets.reverse();
  const order = new Map(sheets.map((s, i) => [s.countId, i]));
  rows.sort((a, b) => (order.get(a.countId) ?? 0) - (order.get(b.countId) ?? 0));
  return {
    sheets,
    rows,
    total: { sheets: sheets.length, surplus, shortfall, valueAtCost: roundMinor(value, opts.minorUnit) },
    truncated: input.truncated,
  };
}

/**
 * The door's answer: one warehouse of the store over one period, computed once per (company, store, warehouse, period's first
 * day, latest approval of that warehouse) in the reports lane — an approval pressed a moment ago is in the very next answer.
 */
export async function keeperStatementAnswer(input: {
  companyId: string;
  storeId: string;
  warehouse: { id: string; name: string };
  timeZone: string;
  minorUnit: number;
  when: Extract<PeriodVerdict, { ok: true }>;
}): Promise<KeeperStatement> {
  const { companyId, storeId, warehouse, timeZone, minorUnit, when } = input;
  const warehouseId = warehouse.id;
  const latest = await db.stockCount.findFirst({
    where: { companyId, storeId, warehouseId, status: 'APPROVED' },
    orderBy: { decidedAt: 'desc' },
    select: { id: true, decidedAt: true },
  });
  const stamp = latest ? `${latest.decidedAt?.getTime() ?? 0}:${latest.id}` : 'none';
  const key = ['keeper-statement', companyId, storeId, warehouseId, when.period, when.fromDay ?? 'all', stamp].join('|');
  return heavyOnce(key, REPORT_TTL_MS, async () => {
    const [rows, keepers] = await Promise.all([
      readStatementRows(db, { companyId, storeId, warehouseId }),
      db.userWarehouseAccess.findMany({ where: { warehouseId }, select: { userId: true } }),
    ]);
    const keeperIds = keepers.map((k) => k.userId);
    const keeperNames = keeperIds.length
      ? await db.user.findMany({ where: { id: { in: keeperIds }, companyId }, select: { name: true }, orderBy: { name: 'asc' } })
      : [];
    return {
      warehouseId,
      warehouseName: warehouse.name,
      keepers: keeperNames.map((k) => k.name),
      period: when.period,
      periodAr: STATEMENT_PERIOD_AR[when.period],
      fromDay: when.fromDay,
      timeZone,
      ...tallyStatement(rows, { timeZone, minorUnit, start: when.start }),
    };
  });
}

/**
 * What one person may read: everything, or — without the cost key — everything but the value at cost, OMITTED (not zeroed) on
 * every row, every sheet and the total. Never mutates the shared answer.
 */
export function keeperStatementShown(a: KeeperStatement, seesCost: boolean) {
  if (seesCost) return { ...a, seesCost: true as const };
  const drop = <T extends { valueAtCost: number }>(x: T): Omit<T, 'valueAtCost'> => {
    const rest: Partial<T> = { ...x };
    delete rest.valueAtCost;
    return rest as Omit<T, 'valueAtCost'>;
  };
  return { ...a, seesCost: false as const, sheets: a.sheets.map(drop), rows: a.rows.map(drop), total: drop(a.total) };
}
