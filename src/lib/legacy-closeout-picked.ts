import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { statementNamingRefusal, type LinkedLine, type NamingLine } from './settlement-gates';
import {
  LEGACY_DELIVERED,
  LEGACY_ROW_SELECT,
  LegacyStopped,
  NO_MONEY_SETTLEMENT,
  STATEMENT_SELECT,
  fingerprintOf,
  hasNoMoney,
  legacyRowOf,
  markClosed,
  type LegacyRow,
  type LegacyScope,
} from './legacy-closeout';
import {
  CHANGED_AR,
  PICKED_CHANGED_AR,
  PICKED_CLOSE_NOTE,
  PICKED_LATE_STATEMENT_AR,
  PICKED_MOST,
  PICKED_NOTHING_AR,
  PICKED_RECENT_DAYS,
  type PickedMeasure,
  type PickedWhy,
} from './legacy-closeout-words';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * «أقفل المحدّد بلا حركة مال» — THE PRESS ON THE ORDERS THE OWNER TICKED (13/11).
 *
 *   «اقدر اعمل هالحركة هاي لاي طلب حتى لو عليه باركود، بس بدي الزر هاد متاح للمالك فقط» (the owner)
 *
 * The old-ones press (`legacy-closeout.ts`) chooses its orders by a rule: awaiting collection, no barcode, older than a cut. This one
 * does not choose: the orders are the ones he ticked on the list. So it asks neither for «no barcode» nor for an age — a barcode or
 * not, an order of yesterday or of last year, it is his decision and the screen shows him what he is deciding. The age is still
 * COUNTED (`recent`), and said: an order of the last fortnight may still have its cash in the courier's hand, and a settled order
 * can no longer be collected by «استلمت منه».
 *
 * It keeps every other refusal of the old press, order by order, with the reason in words:
 *
 *   · not delivered (nothing was handed over, so nothing is owed) · already settled;
 *   · a settlement state that carries money (`COLLECTED` — the courier holds it —, part-settled, refunded): that money has a way in;
 *   · an order a statement speaks for, by our reference, by the courier's barcode within that courier, or by a line a person tied
 *     by hand. This is the one that matters for an order WITH a barcode: if the statement is not approved yet, its approval would
 *     find the order already settled and refuse as a whole; if it was approved, its money is in. Either way the statement settles it.
 *
 * What it writes is exactly what the old press writes — the settlement status → `SETTLED`, one line on the settlement log, the mark
 * (`LEGACY_CLOSE_ACTION`, so the commission never becomes payable) — through the same `markClosed`. Never a wallet movement, an amount,
 * a commission entry, stock or an app event.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The refusals the screen is sent line by line; the rest are counted (`leftTotal`). */
const LEFT_SHOWN = 30;

const PICKED_SELECT = { ...LEGACY_ROW_SELECT, shippingStatus: true } satisfies Prisma.OrderSelect;

export interface PickedRow extends LegacyRow {
  shippingStatus: string;
}

/** What a statement says about an order it speaks for: the collect door's own words, and its code. */
export interface NamedBy {
  code: string;
  error: string;
}

export interface PickedRead {
  /** The ticked orders that are this store's, in the order they were ticked. */
  rows: PickedRow[];
  /** How many different orders were ticked. */
  asked: number;
  /** The ticked ids that are no order of this store (a stale tick, another store's id). */
  missing: number;
  /** The orders a statement speaks for (read only for the orders that could be closed at all). */
  named: Map<string, NamedBy>;
}

const isDelivered = (s: string) => (LEGACY_DELIVERED as readonly string[]).includes(s);
const couldClose = (r: PickedRow) => isDelivered(r.shippingStatus) && hasNoMoney(r.settlementStatus);

/**
 * THE ORDERS A STATEMENT SPEAKS FOR, AND WHAT IT SAYS — read exactly the way the collect door reads it (`collect/route.ts`).
 *
 * A line names an order by our reference, or by the courier's barcode WITHIN THAT COURIER; a line a person tied to an order by hand
 * is found through the match row that holds the link. (The old press needs only the references — its orders have no barcode.) The
 * sentence is the gate's own, so the owner reads the words he would have read from «استلمت منه».
 */
export async function readNamedBy(tx: Tx, scope: LegacyScope, rows: LegacyRow[]): Promise<Map<string, NamedBy>> {
  const named = new Map<string, NamedBy>();
  if (rows.length === 0) return named;
  const refs = rows.map((r) => r.merchantRef).filter((r): r is string => !!r);
  const barcodes = rows.map((r) => r.trackingNumber).filter((b): b is string => !!b);
  const lines: NamingLine[] =
    refs.length + barcodes.length === 0
      ? []
      : await tx.statementLine.findMany({
          where: {
            statement: { companyId: scope.companyId, storeId: scope.storeId },
            OR: [...(refs.length ? [{ merchantRef: { in: refs } }] : []), ...(barcodes.length ? [{ barcode: { in: barcodes } }] : [])],
          },
          select: {
            merchantRef: true,
            barcode: true,
            statement: { select: STATEMENT_SELECT },
            // A line the matching EXCLUDED carries no money for the order.
            matches: { select: { result: true } },
          },
        });
  const links: LinkedLine[] = await tx.settlementMatch.findMany({
    where: { companyId: scope.companyId, orderId: { in: rows.map((r) => r.id) }, statementLineId: { not: null } },
    select: { orderId: true, result: true, statement: { select: STATEMENT_SELECT } },
  });
  if (lines.length === 0 && links.length === 0) return named;
  for (const r of rows) {
    const why = statementNamingRefusal([r], lines, links);
    if (why) named.set(r.id, { code: why.code, error: why.error });
  }
  return named;
}

/** Everything the question needs, read once: the ticked orders, and which of them a statement speaks for. */
export async function readPicked(tx: Tx, scope: LegacyScope, ids: string[]): Promise<PickedRead> {
  const asked = [...new Set(ids)];
  if (asked.length > PICKED_MOST) {
    throw new LegacyStopped(400, { code: 'TOO_MANY', error: `أكثر من ${PICKED_MOST} طلب بضغطة وحدة — حدّد أقل.` });
  }
  const found = await tx.order.findMany({
    where: { companyId: scope.companyId, storeId: scope.storeId, id: { in: asked } },
    select: PICKED_SELECT,
  });
  // The list is drawn in the order the screen read it; the refusals follow the order he ticked.
  const rank = new Map(asked.map((id, i) => [id, i] as const));
  const rows: PickedRow[] = found
    .map((o) => ({ ...legacyRowOf(o), shippingStatus: o.shippingStatus }))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  const named = await readNamedBy(tx, scope, rows.filter(couldClose));
  return { rows, asked: asked.length, missing: asked.length - rows.length, named };
}

/** The claim's own WHERE: still delivered, still a state with no money recorded, still this store's — and only these ids. */
export const stillClosablePickedWhere = (scope: LegacyScope, ids: string[]): Prisma.OrderWhereInput => ({
  companyId: scope.companyId,
  storeId: scope.storeId,
  id: { in: ids },
  shippingStatus: { in: [...LEGACY_DELIVERED] },
  settlementStatus: { in: [...NO_MONEY_SETTLEMENT] },
});

/** Why this ticked order is left alone, in words — or null when it may be closed. The first refusal that applies is the one said. */
function whyLeft(r: PickedRow, named: Map<string, NamedBy>): { why: PickedWhy; text: string } | null {
  if (!isDelivered(r.shippingStatus)) return { why: 'NOT_DELIVERED', text: `${r.orderNumber} — مش مسلَّم بعد.` };
  if (r.settlementStatus === 'SETTLED') return { why: 'ALREADY_SETTLED', text: `${r.orderNumber} — مسوّى من قبل.` };
  if (!hasNoMoney(r.settlementStatus)) {
    return { why: 'MONEY_RECORDED', text: `${r.orderNumber} — تسويته بحالة فيها مصاري (محصَّل عند الشركة أو جزئي أو مرتجع).` };
  }
  const by = named.get(r.id);
  if (by) return { why: 'ON_A_STATEMENT', text: by.error };
  return null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface PickedMeasured {
  measure: PickedMeasure;
  /** The rows the press would close. */
  rows: PickedRow[];
}

/**
 * THE QUESTION AND THE PRESS ASK THE SAME FUNCTION.
 *
 * `measure` is what the dialog draws and `rows` is what the press closes — one pass, so the number on the screen and the orders
 * claimed cannot be two answers.
 */
export function measurePicked(read: PickedRead, now: Date): PickedMeasured {
  const rows: PickedRow[] = [];
  const left: PickedMeasure['left'] = [];
  let leftTotal = 0;
  if (read.missing > 0) {
    leftTotal += read.missing;
    left.push({ orderNumber: null, why: 'NOT_FOUND', text: `${read.missing} طلب محدَّد ما انلقى بهالمتجر — حدّث الصفحة.` });
  }
  for (const r of read.rows) {
    const why = whyLeft(r, read.named);
    if (!why) {
      rows.push(r);
      continue;
    }
    leftTotal += 1;
    if (left.length < LEFT_SHOWN) left.push({ orderNumber: r.orderNumber, ...why });
  }

  const byCourier = new Map<string, number>();
  const value = new Map<string, number>();
  const recentFrom = now.getTime() - PICKED_RECENT_DAYS * DAY_MS;
  let withBarcode = 0;
  let recent = 0;
  for (const r of rows) {
    byCourier.set(r.courier, (byCourier.get(r.courier) ?? 0) + 1);
    value.set(r.currency, (value.get(r.currency) ?? 0) + r.value);
    // A blank barcode is no barcode (the screen draws both as «—»).
    if (r.trackingNumber) withBarcode += 1;
    if (r.at.getTime() >= recentFrom) recent += 1;
  }
  const times = rows.map((r) => r.at.getTime());

  const measure: PickedMeasure = {
    asked: read.asked,
    closeable: {
      count: rows.length,
      fingerprint: fingerprintOf(rows.map((r) => r.id)),
      oldestAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
      newestAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      byCourier: [...byCourier]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar')),
      value: [...value].map(([currency, amount]) => ({ currency, amount: round3(amount) })).sort((a, b) => a.currency.localeCompare(b.currency)),
      withBarcode,
      recent,
    },
    recentDays: PICKED_RECENT_DAYS,
    left,
    leftTotal,
  };
  return { measure, rows };
}

export interface ClosePickedInput {
  scope: LegacyScope;
  user: { id: string; role: string };
  /** The orders he ticked. */
  ids: string[];
  /** What the dialog saw. */
  fingerprint: string;
  count: number;
  now?: Date;
}

/**
 * THE PRESS. Runs inside the caller's transaction, and either writes everything or throws and writes nothing.
 *
 *  1. It reads again, here, and refuses unless the orders it would close are exactly the ones the screen showed.
 *  2. It CLAIMS them with a condition (still delivered, still a state with no money): a collection or a statement approval that took
 *     one of them a moment ago makes the count short, and the whole thing rolls back.
 *  3. It reads the statements again, after the claim, as the collect door does: a statement uploaded while this waited for the rows
 *     is visible now, and then nothing is closed.
 *  4. Only then the log, the mark. No wallet, no amount, no commission, no stock.
 */
export async function closePicked(tx: Tx, input: ClosePickedInput): Promise<PickedMeasured> {
  const { scope, user } = input;
  const now = input.now ?? new Date();

  const read = await readPicked(tx, scope, input.ids);
  const measured = measurePicked(read, now);
  const { rows } = measured;
  if (rows.length === 0) {
    throw new LegacyStopped(409, { code: 'NOTHING_TO_CLOSE', error: PICKED_NOTHING_AR });
  }
  if (measured.measure.closeable.fingerprint !== input.fingerprint || rows.length !== input.count) {
    throw new LegacyStopped(409, { code: 'CHANGED', error: CHANGED_AR });
  }

  const ids = rows.map((r) => r.id);
  const claimed = await tx.order.updateMany({ where: stillClosablePickedWhere(scope, ids), data: { settlementStatus: 'SETTLED' } });
  if (claimed.count !== ids.length) {
    throw new LegacyStopped(409, { code: 'ORDERS_CHANGED', error: PICKED_CHANGED_AR });
  }

  const late = await readNamedBy(tx, scope, rows);
  if (late.size > 0) {
    throw new LegacyStopped(409, {
      code: 'ON_A_STATEMENT',
      error: PICKED_LATE_STATEMENT_AR,
      orders: rows.filter((r) => late.has(r.id)).map((r) => r.orderNumber),
    });
  }

  await markClosed(tx, { scope, user, rows, note: PICKED_CLOSE_NOTE, metadata: { picked: true, note: PICKED_CLOSE_NOTE } });
  return measured;
}
