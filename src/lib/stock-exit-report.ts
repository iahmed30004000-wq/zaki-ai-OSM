import type { Prisma } from '@prisma/client';
import { db } from './db';
import { heavyOnce, REPORT_TTL_MS } from '@/lib/heavy-lane';
import { dayRange, localDay } from './eod-report';
import { roundMinor } from './money';
import { EXIT_REASON_AR, EXIT_REASONS, type ExitReason } from './stock-exit-reasons';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE MONTH'S EXITS — what left the store's warehouses for good in one month of the store, why, who asked, who approved, and
 * what it cost (the warehouse plan, request W6b; the document and its rules are W6a's `stock-exits.ts`).
 *
 * WHAT IS COUNTED. Only APPROVED exits: a pending one has left nothing yet and a rejected one never will. An exit belongs to the
 * month of its APPROVAL (`decidedAt`) — the moment the units left the shelf and the ledger — in the STORE's days (`localDay` /
 * `dayRange` with the country's time zone): an approval at 23:30 of the store's last evening of the month is that month's.
 *
 * NOT SALES. An approved exit draws its units the way the refused-return losses do (`receiving.drawDownStock`), so it adds to the
 * product's «خرج» (`quantitySold`) on the balances screen. That figure is «what left», never «what was sold»: this report says so
 * in its own words, and nothing here is a sale, a revenue or a profit.
 *
 * THE VALUE AT COST. Each approved line keeps what its units cost (`valueAtCost`, W6a, rounded once to the store currency's
 * minor unit). A line with no cost — the batches it left from were never costed (a zero), or no figure at all — is UNCOSTED:
 * it is said «بلا كلفة» and counted apart, never summed in as a zero. The totals add the costed lines and round ONCE more to
 * the minor unit, here, where the currency is known: no figure is added up in the browser.
 *
 * WHO SEES IT. The answer is computed for the store, never for a person (the key names no user) and is shared through the
 * reports lane (`heavyOnce`). Who may read the value at cost is decided after, per person, by the door (`exitMonthShown` with
 * `cost-visibility.maySeeCost`): for anybody without `costs.view` every cost field is omitted — not zeroed.
 *
 * NO MONEY IS WRITTEN. This reads exits, their lines, product names, people's names and warehouse names; it writes nothing and
 * imports nothing from a wallet, an expense or a profit.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Client = typeof db | Prisma.TransactionClient;

export const MONTH_INVALID_AR = 'الشهر غير صالح.';
export const MONTH_IN_FUTURE_AR = 'هالشهر لسا ما إجا — اختار هالشهر أو شهر قبله.';

/** A ceiling on the exits one month reads; reaching it is said in the answer (`truncated`), never hidden. */
export const EXIT_MONTH_CAP = 5_000;

const MONTHS_AR = [
  'كانون الثاني',
  'شباط',
  'آذار',
  'نيسان',
  'أيار',
  'حزيران',
  'تموز',
  'آب',
  'أيلول',
  'تشرين الأول',
  'تشرين الثاني',
  'كانون الأول',
] as const;

const pad = (n: number) => String(n).padStart(2, '0');
const monthOf = (y: number, m: number) => {
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};

export type MonthVerdict =
  | { ok: true; month: string; monthAr: string; start: Date; end: Date; current: boolean; prev: string; next: string | null }
  | { ok: false; code: 'INVALID_MONTH' | 'MONTH_IN_FUTURE'; errorAr: string };

/** `?month=YYYY-MM` → the store's month: empty is this month; a malformed month and a month still to come are refused. */
export function resolveExitMonth(raw: string | null, now: Date, timeZone: string): MonthVerdict {
  const current = localDay(now, timeZone).slice(0, 7);
  const month = raw || current;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return { ok: false, code: 'INVALID_MONTH', errorAr: MONTH_INVALID_AR };
  if (month > current) return { ok: false, code: 'MONTH_IN_FUTURE', errorAr: MONTH_IN_FUTURE_AR };
  const [y, mo] = [Number(m[1]), Number(m[2])];
  const following = monthOf(y, mo + 1);
  const from = dayRange(`${month}-01`, timeZone);
  const to = dayRange(`${following}-01`, timeZone);
  if (!from || !to) return { ok: false, code: 'INVALID_MONTH', errorAr: MONTH_INVALID_AR };
  return {
    ok: true,
    month,
    monthAr: `${MONTHS_AR[mo - 1]} ${y}`,
    start: from.start,
    end: to.start,
    current: month === current,
    prev: monthOf(y, mo - 1),
    next: following <= current ? following : null,
  };
}

/** A line with no cost: never costed (a zero) or no figure at all. Said «بلا كلفة», never summed in as a zero. */
export const isUncosted = (valueAtCost: number | null | undefined) => valueAtCost == null || !(valueAtCost > 0);

export interface ExitMonthLine {
  exitId: string;
  decidedAt: string;
  warehouseName: string | null;
  reason: string;
  reasonAr: string;
  note: string | null;
  productId: string;
  productName: string | null;
  quantity: number;
  requestedByName: string | null;
  decidedByName: string | null;
  /** The line's value at cost, or null when it is uncosted. */
  valueAtCost: number | null;
  uncosted: boolean;
}

export interface ExitMonthSum {
  quantity: number;
  /** Lines counted. */
  lines: number;
  /** The costed lines' values, rounded once to the minor unit. */
  valueAtCost: number;
  /** Lines with no cost — not inside `valueAtCost`. */
  uncostedLines: number;
}

export interface ExitMonthAnswer {
  month: string;
  monthAr: string;
  current: boolean;
  prev: string;
  next: string | null;
  timeZone: string;
  truncated: boolean;
  /** Approved exits in the month. */
  exits: number;
  lines: ExitMonthLine[];
  /** One row per reason that has a line this month, in the reasons' own order. */
  reasons: (ExitMonthSum & { reason: string; reasonAr: string })[];
  total: ExitMonthSum;
}

/** What the reads bring back, already scoped to the company, the store and the month. */
export interface ExitMonthRows {
  exits: {
    id: string;
    warehouseId: string;
    reason: string;
    note: string | null;
    requestedById: string;
    decidedById: string | null;
    decidedAt: Date | null;
    lines: { productId: string; quantity: number; valueAtCost: number | null; product: { name: string } | null }[];
  }[];
  people: Map<string, string>;
  places: Map<string, string>;
  truncated: boolean;
}

/** The reads, scoped to the company, the store and the store's month. Approved exits only; names by id. */
export async function readExitMonthRows(client: Client, scope: { companyId: string; storeId: string; start: Date; end: Date }): Promise<ExitMonthRows> {
  const { companyId, storeId } = scope;
  const exits = await client.stockExit.findMany({
    where: { companyId, storeId, status: 'APPROVED', decidedAt: { gte: scope.start, lt: scope.end } },
    orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    take: EXIT_MONTH_CAP,
    select: {
      id: true,
      warehouseId: true,
      reason: true,
      note: true,
      requestedById: true,
      decidedById: true,
      decidedAt: true,
      lines: { select: { productId: true, quantity: true, valueAtCost: true, product: { select: { name: true } } }, orderBy: { productId: 'asc' } },
    },
  });
  const peopleIds = [...new Set(exits.flatMap((e) => [e.requestedById, e.decidedById]).filter((x): x is string => !!x))];
  const placeIds = [...new Set(exits.map((e) => e.warehouseId))];
  const [people, places] = await Promise.all([
    peopleIds.length ? client.user.findMany({ where: { id: { in: peopleIds }, companyId }, select: { id: true, name: true } }) : [],
    placeIds.length ? client.warehouse.findMany({ where: { id: { in: placeIds }, companyId }, select: { id: true, name: true } }) : [],
  ]);
  return {
    exits,
    people: new Map(people.map((p) => [p.id, p.name])),
    places: new Map(places.map((w) => [w.id, w.name])),
    truncated: exits.length >= EXIT_MONTH_CAP,
  };
}

const emptySum = (): { quantity: number; lines: number; raw: number; uncostedLines: number } => ({ quantity: 0, lines: 0, raw: 0, uncostedLines: 0 });

/** THE TALLY — pure. Rows in, the month's lines and sums out; every total rounded once to `minorUnit`. */
export function tallyExitMonth(rows: ExitMonthRows, minorUnit: number): Pick<ExitMonthAnswer, 'exits' | 'lines' | 'reasons' | 'total' | 'truncated'> {
  const lines: ExitMonthLine[] = [];
  const byReason = new Map<string, ReturnType<typeof emptySum>>();
  const total = emptySum();
  const add = (s: ReturnType<typeof emptySum>, quantity: number, value: number | null) => {
    s.quantity += quantity;
    s.lines += 1;
    if (value === null) s.uncostedLines += 1;
    else s.raw += value;
  };

  for (const e of rows.exits) {
    const reasonAr = EXIT_REASON_AR[e.reason as ExitReason] ?? e.reason;
    for (const l of e.lines) {
      const uncosted = isUncosted(l.valueAtCost);
      const value = uncosted ? null : (l.valueAtCost as number);
      lines.push({
        exitId: e.id,
        decidedAt: (e.decidedAt ?? new Date(0)).toISOString(),
        warehouseName: rows.places.get(e.warehouseId) ?? null,
        reason: e.reason,
        reasonAr,
        note: e.note,
        productId: l.productId,
        productName: l.product?.name ?? null,
        quantity: l.quantity,
        requestedByName: rows.people.get(e.requestedById) ?? null,
        decidedByName: e.decidedById ? rows.people.get(e.decidedById) ?? null : null,
        valueAtCost: value,
        uncosted,
      });
      if (!byReason.has(e.reason)) byReason.set(e.reason, emptySum());
      add(byReason.get(e.reason)!, l.quantity, value);
      add(total, l.quantity, value);
    }
  }

  const done = (s: ReturnType<typeof emptySum>): ExitMonthSum => ({
    quantity: s.quantity,
    lines: s.lines,
    valueAtCost: roundMinor(s.raw, minorUnit),
    uncostedLines: s.uncostedLines,
  });
  const known: readonly string[] = EXIT_REASONS;
  const order = (r: string) => (known.includes(r) ? known.indexOf(r) : known.length);
  return {
    exits: rows.exits.length,
    lines,
    reasons: [...byReason.entries()]
      .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
      .map(([reason, s]) => ({ reason, reasonAr: EXIT_REASON_AR[reason as ExitReason] ?? reason, ...done(s) })),
    total: done(total),
    truncated: rows.truncated,
  };
}

/**
 * The door's answer: one month of the store, computed once per (company, store, month, latest approval) in the reports lane and
 * shared by whoever asks in the next minute. The latest approval of the store is part of the question, so an approval pressed a
 * moment ago is in the very next answer instead of a minute later.
 */
export async function exitMonthAnswer(input: {
  companyId: string;
  storeId: string;
  timeZone: string;
  minorUnit: number;
  when: Extract<MonthVerdict, { ok: true }>;
}): Promise<ExitMonthAnswer> {
  const { companyId, storeId, timeZone, minorUnit, when } = input;
  const latest = await db.stockExit.findFirst({
    where: { companyId, storeId, status: 'APPROVED' },
    orderBy: { decidedAt: 'desc' },
    select: { id: true, decidedAt: true },
  });
  const stamp = latest ? `${latest.decidedAt?.getTime() ?? 0}:${latest.id}` : 'none';
  const key = ['stock-exits-month', companyId, storeId, when.month, stamp].join('|');
  return heavyOnce(key, REPORT_TTL_MS, async () => {
    const rows = await readExitMonthRows(db, { companyId, storeId, start: when.start, end: when.end });
    return {
      month: when.month,
      monthAr: when.monthAr,
      current: when.current,
      prev: when.prev,
      next: when.next,
      timeZone,
      ...tallyExitMonth(rows, minorUnit),
    };
  });
}

/**
 * What one person may read of the month: everything, or — without the cost key — everything but the value at cost. The cost
 * fields are OMITTED (not zeroed, not nulled) on every line, every reason and the total. Never mutates the shared answer.
 */
export function exitMonthShown(a: ExitMonthAnswer, seesCost: boolean) {
  if (seesCost) return { ...a, seesCost: true as const };
  const sum = ({ quantity, lines }: ExitMonthSum) => ({ quantity, lines });
  return {
    ...a,
    seesCost: false as const,
    lines: a.lines.map((l) => {
      const rest: Partial<ExitMonthLine> = { ...l };
      delete rest.valueAtCost;
      delete rest.uncosted;
      return rest as Omit<ExitMonthLine, 'valueAtCost' | 'uncosted'>;
    }),
    reasons: a.reasons.map((r) => ({ reason: r.reason, reasonAr: r.reasonAr, ...sum(r) })),
    total: sum(a.total),
  };
}
