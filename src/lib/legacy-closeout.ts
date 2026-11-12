import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { statementNamingRefusal, type LinkedLine, type NamingLine } from './settlement-gates';
import {
  CHANGED_AR,
  LEGACY_AGES,
  LEGACY_CLOSE_ACTION,
  LEGACY_CLOSE_NOTE,
  LEGACY_MOST,
  NOTHING_TO_CLOSE_AR,
  type LegacyAge,
  type LegacyMeasure,
} from './legacy-closeout-words';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * «أقفل القديمة بلا باركود» — THE RULES, WRITTEN ONCE (the owner, 12/11):
 *
 *   «كل الطلبات الي بانتظار التحصيل وما الها بار كود سويها تم تحصيلها بدون ما تأثر على المالية لانهم هدول طلبات قديمة قبل قصة
 *   الباركود وقبل التسوية المالية».
 *
 * ── WHAT «SETTLED» MEANS HERE, AND THE ONE EXCEPTION ──
 *
 * Four readers take `SETTLED` as «the cash is in»: `collect` refuses a second collection, the matcher refuses a statement line,
 * the courier-custody report drops the order, and the commission becomes payable. Until now its only two writers put the money in
 * a wallet in the same transaction (the approval of a statement, «استلمت منه»), and `PATCH /api/orders/[id]/finance` refuses to
 * write it for exactly that reason. This is a THIRD writer, on purpose and by the owner's word: the money of these orders was
 * collected before the barcode and before the settlement existed, there is no statement that will ever name them (no barcode to
 * match on), and they sit in «بانتظار التحصيل» for ever.
 *
 * What it writes: `settlementStatus = SETTLED`, one line on the order's settlement log, one activity row (the MARK,
 * `LEGACY_CLOSE_ACTION`) and one audit line for the press. What it never writes: a wallet movement, `collectedAmount`, a
 * commission entry's status, stock, an app event. And the mark makes the one money reader that would otherwise move —
 * the commission payout — leave these orders out (`PROMOTABLE_BY_PAYOUT`), so the commission is exactly where it was.
 *
 * ── WHAT IT WILL NOT CLOSE ──
 *
 *   · an order that is not delivered, or already settled;
 *   · a settlement state that already carries money (`COLLECTED` — the courier holds it —, part-settled, refunded);
 *   · an order with a barcode (a statement can still name it);
 *   · an order a statement names, or that a person tied to a statement line by hand: the statement settles it with real money
 *     (the same rule «استلمت منه» asks: `statementNamingRefusal`);
 *   · an order newer than the cut the owner chose — an agent's cash may still be in his hand, and a manual company never
 *     carries a barcode however fresh the order is.
 */

/** Arrived, whole or in part: the two statuses `COLLECT` (parcel-tracking/priority.ts) and the tracking list's default read. */
export const LEGACY_DELIVERED = ['DELIVERED', 'PARTIALLY_DELIVERED'] as const;

/** A settlement state with NO money recorded against it: the only ones this door may move to `SETTLED`. */
export const NO_MONEY_SETTLEMENT = ['NOT_APPLICABLE', 'PENDING', 'PENDING_COLLECTION', 'UNSETTLED'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const PART = 1000;

export interface LegacyScope {
  companyId: string;
  storeId: string;
}

/** «بانتظار التحصيل» and no barcode. A blank barcode is no barcode: the screen draws both as «—». */
export const awaitingNoBarcodeWhere = (scope: LegacyScope): Prisma.OrderWhereInput => ({
  companyId: scope.companyId,
  storeId: scope.storeId,
  shippingStatus: { in: [...LEGACY_DELIVERED] },
  settlementStatus: { not: 'SETTLED' },
  OR: [{ trackingNumber: null }, { trackingNumber: '' }],
});

/** The press's own WHERE for the claim: the same question, with the money states named instead of «not SETTLED». */
export const stillCloseableWhere = (scope: LegacyScope, ids: string[]): Prisma.OrderWhereInput => ({
  ...awaitingNoBarcodeWhere(scope),
  id: { in: ids },
  settlementStatus: { in: [...NO_MONEY_SETTLEMENT] },
});

const LEGACY_ROW_SELECT = {
  id: true,
  orderNumber: true,
  merchantRef: true,
  trackingNumber: true,
  deliveryProviderId: true,
  settlementStatus: true,
  deliveredAt: true,
  shippedAt: true,
  createdAt: true,
  currency: true,
  totalAmount: true,
  deliveryProvider: { select: { name: true } },
} satisfies Prisma.OrderSelect;

export interface LegacyRow {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  trackingNumber: string | null;
  deliveryProviderId: string | null;
  settlementStatus: string;
  /** When it arrived — delivered, else shipped, else created. The age is counted from here. */
  at: Date;
  currency: string;
  /** The order's own value. A measure of the size of the press, never an amount that moves. */
  value: number;
  courier: string;
}

export interface LegacyRead {
  /** Every parcel that is awaiting collection and has no barcode. */
  rows: LegacyRow[];
  /** The ids a statement speaks for (read for the rows with no money recorded only). */
  named: Set<string>;
  /** More than `LEGACY_MOST` waiting: nothing is closed, a person looks. */
  tooMany: boolean;
}

const chunks = <T,>(all: T[], size = PART): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
};

const hasNoMoney = (s: string) => (NO_MONEY_SETTLEMENT as readonly string[]).includes(s);

const STATEMENT_SELECT = { reference: true, status: true, approvedAt: true, deliveryProviderId: true } as const;

/**
 * THE ORDERS A STATEMENT SPEAKS FOR — the collect door's own rule (`statementNamingRefusal`), asked one order at a time.
 *
 * Lines are found by the order's reference (these orders have no barcode to be named by); the lines a person tied by hand are
 * found through the match row that holds the link. Read with whatever client the caller holds, so inside the press's
 * transaction it is the transaction's own read.
 */
export async function readNamed(tx: Tx, scope: LegacyScope, rows: LegacyRow[]): Promise<Set<string>> {
  const refs = rows.map((r) => r.merchantRef).filter((r): r is string => !!r);
  const lines: NamingLine[] = [];
  for (const part of chunks(refs)) {
    lines.push(
      ...(await tx.statementLine.findMany({
        where: { statement: { companyId: scope.companyId, storeId: scope.storeId }, merchantRef: { in: part } },
        select: {
          merchantRef: true,
          barcode: true,
          statement: { select: STATEMENT_SELECT },
          // A line the matching EXCLUDED carries no money for the order.
          matches: { select: { result: true } },
        },
      }))
    );
  }
  const links: LinkedLine[] = [];
  for (const part of chunks(rows.map((r) => r.id))) {
    links.push(
      ...(await tx.settlementMatch.findMany({
        where: { companyId: scope.companyId, orderId: { in: part }, statementLineId: { not: null } },
        select: { orderId: true, result: true, statement: { select: STATEMENT_SELECT } },
      }))
    );
  }
  const named = new Set<string>();
  if (lines.length === 0 && links.length === 0) return named;
  for (const r of rows) if (statementNamingRefusal([r], lines, links)) named.add(r.id);
  return named;
}

/** Everything the question needs, read once: the parcels, and which of them a statement speaks for. */
export async function readLegacy(tx: Tx, scope: LegacyScope): Promise<LegacyRead> {
  const found = await tx.order.findMany({
    where: awaitingNoBarcodeWhere(scope),
    orderBy: { id: 'asc' },
    take: LEGACY_MOST + 1,
    select: LEGACY_ROW_SELECT,
  });
  const tooMany = found.length > LEGACY_MOST;
  const rows: LegacyRow[] = found.slice(0, LEGACY_MOST).map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    merchantRef: o.merchantRef,
    trackingNumber: o.trackingNumber,
    deliveryProviderId: o.deliveryProviderId,
    settlementStatus: o.settlementStatus,
    at: o.deliveredAt ?? o.shippedAt ?? o.createdAt,
    currency: o.currency,
    value: Number(o.totalAmount),
    courier: o.deliveryProvider?.name ?? 'بلا شركة شحن',
  }));
  // A statement is only a question for the orders that could be closed at all.
  const named = tooMany ? new Set<string>() : await readNamed(tx, scope, rows.filter((r) => hasNoMoney(r.settlementStatus)));
  return { rows, named, tooMany };
}

/** What the screen saw, reduced to a short string the press sends back: the same orders, or the press is refused. */
export const fingerprintOf = (ids: string[]): string =>
  createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 24);

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface LegacyMeasured {
  measure: LegacyMeasure;
  /** The rows the press would close. */
  rows: LegacyRow[];
}

/**
 * THE QUESTION AND THE PRESS ASK THE SAME FUNCTION.
 *
 * `measure` is what the dialog draws and `rows` is what the press closes — one pass, so the number on the screen and the orders
 * claimed cannot be two answers.
 */
export function measureLegacy(read: LegacyRead, age: LegacyAge, now: Date): LegacyMeasured {
  const clean = read.rows.filter((r) => hasNoMoney(r.settlementStatus));
  const moneyRecorded = read.rows.length - clean.length;
  const open = clean.filter((r) => !read.named.has(r.id));
  const onAStatement = clean.length - open.length;

  const cutoff = new Date(now.getTime() - age * DAY_MS);
  const rows = read.tooMany ? [] : open.filter((r) => r.at.getTime() < cutoff.getTime());

  const byCourier = new Map<string, number>();
  const value = new Map<string, number>();
  for (const r of rows) {
    byCourier.set(r.courier, (byCourier.get(r.courier) ?? 0) + 1);
    value.set(r.currency, (value.get(r.currency) ?? 0) + r.value);
  }
  const times = rows.map((r) => r.at.getTime());

  const measure: LegacyMeasure = {
    age,
    cutoff: cutoff.toISOString(),
    tooMany: read.tooMany,
    closeable: {
      count: rows.length,
      fingerprint: fingerprintOf(rows.map((r) => r.id)),
      oldestAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
      newestAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      byCourier: [...byCourier]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar')),
      value: [...value].map(([currency, amount]) => ({ currency, amount: round3(amount) })).sort((a, b) => a.currency.localeCompare(b.currency)),
    },
    options: LEGACY_AGES.map((a) => {
      const limit = now.getTime() - a * DAY_MS;
      return { age: a, count: read.tooMany ? 0 : open.filter((r) => r.at.getTime() < limit).length };
    }),
    left: { tooRecent: open.length - rows.length, moneyRecorded, onAStatement },
  };
  return { measure, rows };
}

/** A refusal found inside the transaction: it rolls back and this is the answer. */
export class LegacyStopped extends Error {
  constructor(readonly status: number, readonly body: { code: string; error: string; orders?: string[] }) {
    super(body.code);
  }
}

export interface CloseLegacyInput {
  scope: LegacyScope;
  user: { id: string; role: string };
  age: LegacyAge;
  /** What the dialog saw. */
  fingerprint: string;
  count: number;
  now?: Date;
}

/**
 * THE PRESS. Runs inside the caller's transaction, and either writes everything or throws and writes nothing.
 *
 *  1. It reads again, here, and refuses unless the orders it would close are exactly the ones the screen showed.
 *  2. It CLAIMS them with a condition (still awaiting, no barcode, still a state with no money): a press, a collection or a
 *     statement approval that took one of them a moment ago makes the count short, and the whole thing rolls back.
 *  3. It reads the statements again, after the claim, as the collect door does: a statement uploaded while this waited for the rows
 *     is visible now, and then nothing is closed.
 *  4. Only then the log, the mark. No wallet, no amount, no commission, no stock.
 */
export async function closeLegacy(tx: Tx, input: CloseLegacyInput): Promise<LegacyMeasured> {
  const { scope, user, age } = input;
  const now = input.now ?? new Date();

  const read = await readLegacy(tx, scope);
  if (read.tooMany) {
    throw new LegacyStopped(409, {
      code: 'TOO_MANY',
      error: `أكثر من ${LEGACY_MOST} طلب بانتظار التحصيل وبلا باركود — هالضغطة مش لهالحجم.`,
    });
  }
  const measured = measureLegacy(read, age, now);
  const { rows } = measured;
  if (rows.length === 0) {
    throw new LegacyStopped(409, { code: 'NOTHING_TO_CLOSE', error: NOTHING_TO_CLOSE_AR });
  }
  if (measured.measure.closeable.fingerprint !== input.fingerprint || rows.length !== input.count) {
    throw new LegacyStopped(409, { code: 'CHANGED', error: CHANGED_AR });
  }

  const ids = rows.map((r) => r.id);
  for (const part of chunks(ids)) {
    const claimed = await tx.order.updateMany({
      where: stillCloseableWhere(scope, part),
      data: { settlementStatus: 'SETTLED' },
    });
    if (claimed.count !== part.length) {
      throw new LegacyStopped(409, {
        code: 'ORDERS_CHANGED',
        error: 'تغيّر وضع طلب أو أكثر وقت القفل (انحصّل أو انربط بكشف أو انشحن باركوده). ما انقفل شي — افتح النافذة من جديد.',
      });
    }
  }

  const late = await readNamed(tx, scope, rows);
  if (late.size > 0) {
    throw new LegacyStopped(409, {
      code: 'ON_A_STATEMENT',
      error: 'كشف ذكر طلباً منها وقت القفل — الكشف هو اللي بيسوّيه. ما انقفل شي.',
      orders: rows.filter((r) => late.has(r.id)).map((r) => r.orderNumber),
    });
  }

  for (const part of chunks(rows)) {
    await tx.orderStatusLog.createMany({
      data: part.map((r) => ({
        companyId: scope.companyId,
        orderId: r.id,
        statusType: 'SETTLEMENT',
        previousValue: r.settlementStatus,
        newValue: 'SETTLED',
        changedById: user.id,
        changedByRole: user.role,
        note: LEGACY_CLOSE_NOTE,
      })),
    });
    await tx.orderActivity.createMany({
      data: part.map((r) => ({
        companyId: scope.companyId,
        orderId: r.id,
        userId: user.id,
        action: LEGACY_CLOSE_ACTION,
        previousStatus: r.settlementStatus,
        newStatus: 'SETTLED',
        metadata: JSON.stringify({ age, note: LEGACY_CLOSE_NOTE }),
      })),
    });
  }
  return measured;
}
