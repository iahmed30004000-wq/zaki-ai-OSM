import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { reverseForOrder } from './commission';
import { LEGACY_DELIVERED, NO_MONEY_SETTLEMENT } from './legacy-closeout';
import { statementNamingRefusal, type LinkedLine, type NamingLine } from './settlement-gates';
import { SHIPPING_STATUS_AR } from './shipping-workflow';
import {
  DELIVERY_UNDO_ACTION,
  DOOR_MARK,
  OVERRIDE_MARK,
  SHIPPING_MARK,
  UNDO_CHANGED_AR,
  UNDO_LATE_COMMISSION_AR,
  UNDO_LATE_STATEMENT_AR,
  UNDO_LINE_AR,
  UNDO_NOTE_PREFIX,
  UNDO_NOT_FOUND_AR,
  UNDO_ORDERS_CHANGED_AR,
  UNDO_STAYS_AR,
  UNDO_WHY_AR,
  settlementWord,
  type UndoLine,
  type UndoMeasure,
  type UndoWhy,
} from './delivery-undo-words';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * «تراجع عن التسليم» — A DELIVERY RECORDED BY MISTAKE IS TAKEN BACK, FROM WHAT THE LEDGERS PROVE (13/11).
 *
 *   «هاد الطلب بالغلط حطيتو تم والشركة بتقول تم ارجاعها لازم يكون في زر تراجع مش محدود بمدة زمنية ويكون عليه صلاحية للمالك متاح» (the owner)
 *
 * The order goes back to the state it had BEFORE it was recorded delivered, so the company's word «تم إرجاعها» and the ordinary return
 * flow (the returns desk counts the goods back in) can take over. There is NO time window anywhere in this file: it refuses on facts.
 *
 * ── WHAT A DELIVERY RECORDING WROTE, AND WHAT THIS REVERSES ──
 *
 * Two doors record a delivery, and each leaves its own activity row in the same transaction as its writes — that row is the evidence:
 *
 *   DOOR            `recordPartialDelivery` (the «استلم» button, «استلم جزءاً», «استلم المحدد»): the status, `deliveredAt`, every line's
 *                   `deliveredQty`/`returnedQty`, the customer's `deliveredOrders` +1 and `totalPurchaseValue` + the door's expected
 *                   collection (which the activity's metadata keeps), the stock drawn down, a knock, a note. It never writes the settlement.
 *   SHIPPING ROUTE  `/api/orders/[id]/shipping` (the order's own status move): the status, `deliveredAt`, the legacy `status` and — for a
 *                   whole delivery only — `settlementStatus = COLLECTED` (the one writer of that word besides the combined-status PATCH),
 *                   the stock drawn down, a knock, the timeline line. It touches neither the lines nor the customer's counters.
 *
 * What it reverses: the status (back to the timeline's «before», else «مشحون»), `deliveredAt`, the legacy `status`, `COLLECTED`, the lines'
 * quantities, exactly the counters the DOOR added (never below zero), and the commission that is still only ACCRUED (a reversing entry,
 * through `reverseForOrder`; the original stays). History is only appended to.
 *
 * ── WHAT IT DELIBERATELY LEAVES ──
 *
 *   THE STOCK. A delivery draws the units down once, and the ledger's key for that (`consumeOrderStock`: a `SALE` line for the order) is
 *   permanent. Putting the units back here would (1) bring goods onto the shelf that nobody counted — the owner's 21/10 ruling is that a
 *   return enters stock only when the desk has received it and found it sound —, (2) leave the order in flight with no reservation, so
 *   the same units could be sold again, and (3) make a later REAL delivery consume nothing (its `SALE` already exists) and a later
 *   return skip the count (`RETURN` would already exist). Left alone, every future is right: delivered again → not drawn twice;
 *   returned → the desk restores exactly what it counts.
 *   NO MONEY: never a wallet movement, an amount, an app event. (The «انسلّم» event and the ad-platform conversion a manual delivery sent
 *   are not recalled — the measure says so.)
 *
 * ── WHAT IT REFUSES, WITH THE REASON IN WORDS (nothing is written) ──
 *
 * not delivered / already undone · settlement that carries money or is closed · a recorded collected amount · a courier statement that
 * names the order (reference, the courier's barcode, or a line a person tied by hand — `statementNamingRefusal`, the collect door's own
 * rule) · a counted return · a commission that is payable or paid · a delivery whose recording the ledgers cannot prove (the combined-status
 * override, an order with no record, a status moved after the record, a recording with no readable figure).
 *
 * ── THE SHAPE: MEASURE FIRST, THEN PRESS ──
 *
 * `measure` writes nothing and opens no transaction; `undoDelivery` runs inside the caller's transaction, re-reads, claims the order with a
 * CONDITION (still this delivery, still this version, still no money), reads the statements and the commission again AFTER the claim, and
 * only then writes. A short claim, or any refusal after it, throws and the transaction takes back everything.
 */

export interface UndoScope {
  companyId: string;
  storeId: string;
}

/** The states a parcel can have been in just before its delivery was recorded — the door's own list (`SETTLEABLE` in partial-delivery). */
export const BEFORE_DELIVERY = ['SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY'] as const;
/** Where an order goes back to when the ledgers do not say where it was: on the road, with the company. */
export const DEFAULT_BEFORE = 'SHIPPED';
/** What a delivery recorded through the order's own door writes onto the settlement, and what it is put back to. */
export const COLLECTED = 'COLLECTED';
export const BACK_TO_AWAITING = 'PENDING_COLLECTION';

const shippingWord = (s: string): string => (SHIPPING_STATUS_AR as Record<string, string>)[s] ?? s;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/* ───────────────────────────── the facts ───────────────────────────── */

export interface UndoOrder {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  trackingNumber: string | null;
  deliveryProviderId: string | null;
  customerId: string;
  currency: string;
  courier: string;
  shippingStatus: string;
  settlementStatus: string;
  /** The legacy combined status column. */
  status: string;
  version: number;
  /** A collected amount is written on the order (an old door, or a statement): money is recorded. */
  hasCollectedAmount: boolean;
  items: { id: string; productName: string; deliveredQty: number | null; returnedQty: number | null }[];
  hasReturnReceipt: boolean;
}

/** One of the order's activity rows that names a way a delivery gets recorded — or a delivery taken back. Newest first. */
export interface UndoMark {
  id: string;
  action: string;
  previousStatus: string | null;
  newStatus: string | null;
  metadata: string | null;
}

export interface UndoCommission {
  id: string;
  userId: string;
  status: string;
  payoutId: string | null;
  amount: number;
  currency: string;
  /** A reversing entry already points at it. */
  reversed: boolean;
}

export interface NamedBy {
  code: string;
  error: string;
}

export interface UndoFacts {
  order: UndoOrder;
  /** The order's recorder rows and undo rows, newest first. */
  marks: UndoMark[];
  /** The SHIPPING timeline lines, newest first. */
  shippingLog: { previousValue: string | null; newValue: string | null }[];
  commission: UndoCommission[];
  /** What the ledger says left the shelf for this order, and what came back. Said to the owner; never written. */
  shelf: { out: number; back: number };
  customer: { deliveredOrders: number; totalPurchaseValue: number } | null;
  /** A statement that speaks for this order (the collect door's own rule), or null. */
  named: NamedBy | null;
}

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  merchantRef: true,
  trackingNumber: true,
  deliveryProviderId: true,
  customerId: true,
  currency: true,
  shippingStatus: true,
  settlementStatus: true,
  status: true,
  version: true,
  collectedAmount: true,
  deliveryProvider: { select: { name: true } },
  items: { select: { id: true, productName: true, deliveredQty: true, returnedQty: true } },
  returnReceipt: { select: { id: true } },
} satisfies Prisma.OrderSelect;

const STATEMENT_SELECT = { reference: true, status: true, approvedAt: true, deliveryProviderId: true } as const;

/**
 * THE STATEMENTS THAT SPEAK FOR THIS ORDER — read exactly the way the collect door reads them (`collect/route.ts`): a line names an order by
 * our reference, or by the courier's barcode WITHIN THAT COURIER; a line a person tied by hand is found through the match row that holds the
 * link. The gate's own sentence is kept, so the owner reads the words he would have read from «استلمت منه».
 */
export async function readNaming(tx: Tx, scope: UndoScope, order: UndoOrder): Promise<NamedBy | null> {
  const refs = order.merchantRef ? [order.merchantRef] : [];
  const barcodes = order.trackingNumber ? [order.trackingNumber] : [];
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
            // A line the matching EXCLUDED («تم إرجاعها» at zero) carries no money for the order.
            matches: { select: { result: true } },
          },
        });
  const links: LinkedLine[] = await tx.settlementMatch.findMany({
    where: { companyId: scope.companyId, orderId: order.id, statementLineId: { not: null } },
    select: { orderId: true, result: true, statement: { select: STATEMENT_SELECT } },
  });
  if (lines.length === 0 && links.length === 0) return null;
  const why = statementNamingRefusal(
    [{ id: order.id, orderNumber: order.orderNumber, merchantRef: order.merchantRef, trackingNumber: order.trackingNumber, deliveryProviderId: order.deliveryProviderId }],
    lines,
    links
  );
  return why ? { code: why.code, error: why.error } : null;
}

/** The commission of the order as the ledger holds it — read with whatever client the caller holds, so after the claim it is the transaction's own read. */
export async function readCommission(tx: Tx, scope: UndoScope, orderId: string): Promise<UndoCommission[]> {
  const rows = await tx.commissionEntry.findMany({
    where: { companyId: scope.companyId, orderId },
    select: {
      id: true,
      userId: true,
      status: true,
      payoutId: true,
      amount: true,
      currencyCode: true,
      reversedBy: { select: { id: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    status: r.status,
    payoutId: r.payoutId,
    amount: Number(r.amount),
    currency: r.currencyCode,
    reversed: r.reversedBy != null,
  }));
}

/**
 * EVERYTHING THE QUESTION NEEDS, READ ONCE (the measure reads it with the module's client, the press with the transaction's).
 * Null when the order is no order of this store.
 */
export async function readUndoFacts(tx: Tx, scope: UndoScope, orderId: string): Promise<UndoFacts | null> {
  const o = await tx.order.findFirst({ where: { id: orderId, companyId: scope.companyId, storeId: scope.storeId }, select: ORDER_SELECT });
  if (!o) return null;
  const order: UndoOrder = {
    id: o.id,
    orderNumber: o.orderNumber,
    merchantRef: o.merchantRef,
    trackingNumber: o.trackingNumber,
    deliveryProviderId: o.deliveryProviderId,
    customerId: o.customerId,
    currency: o.currency,
    courier: o.deliveryProvider?.name ?? 'بلا شركة شحن',
    shippingStatus: o.shippingStatus,
    settlementStatus: o.settlementStatus,
    status: o.status,
    version: o.version,
    hasCollectedAmount: o.collectedAmount != null,
    items: o.items.map((i) => ({ id: i.id, productName: i.productName, deliveredQty: i.deliveredQty, returnedQty: i.returnedQty })),
    hasReturnReceipt: o.returnReceipt != null,
  };

  const marks = await tx.orderActivity.findMany({
    where: { companyId: scope.companyId, orderId, action: { in: [DOOR_MARK, SHIPPING_MARK, OVERRIDE_MARK, DELIVERY_UNDO_ACTION] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, action: true, previousStatus: true, newStatus: true, metadata: true },
  });
  const shippingLog = await tx.orderStatusLog.findMany({
    where: { companyId: scope.companyId, orderId, statusType: 'SHIPPING' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { previousValue: true, newValue: true },
    take: 50,
  });
  const commission = await readCommission(tx, scope, orderId);
  const moves = await tx.inventoryMovement.findMany({
    where: { companyId: scope.companyId, referenceId: orderId, type: { in: ['SALE', 'RETURN'] } },
    select: { type: true, quantity: true },
  });
  const shelf = { out: 0, back: 0 };
  for (const m of moves) {
    if (m.type === 'SALE') shelf.out += Math.max(0, -m.quantity);
    else shelf.back += Math.max(0, m.quantity);
  }
  const c = await tx.customer.findFirst({
    where: { id: o.customerId, companyId: scope.companyId },
    select: { deliveredOrders: true, totalPurchaseValue: true },
  });
  const named = await readNaming(tx, scope, order);

  return {
    order,
    marks,
    shippingLog,
    commission,
    shelf,
    customer: c ? { deliveredOrders: c.deliveredOrders, totalPurchaseValue: Number(c.totalPurchaseValue) } : null,
    named,
  };
}

/* ───────────────────────────── the judgement ───────────────────────────── */

export interface UndoPlan {
  /** Which door recorded the delivery — what decides what was written, and so what is reversed. */
  path: 'DOOR' | 'SHIPPING_ROUTE';
  from: 'DELIVERED' | 'PARTIALLY_DELIVERED';
  to: (typeof BEFORE_DELIVERY)[number];
  /** The timeline did not say where it was before: it goes back to the default. */
  toDefaulted: boolean;
  /** The settlement state read — the claim holds the order to exactly this one. */
  settlementFrom: string;
  /** `COLLECTED` (written by the delivery itself) goes back to «awaiting collection». */
  settlement: { to: typeof BACK_TO_AWAITING } | null;
  /** The legacy combined status read `DELIVERED` (a delivery through the order's own door writes it): it goes back to `SHIPPED`. */
  legacyStatus: boolean;
  /** The lines whose door-written quantities go back to «the door has not spoken». */
  items: { id: string; productName: string; deliveredQty: number | null; returnedQty: number | null }[];
  /** What the DOOR added to the customer, to be taken off: one delivered order and the expected collection it carried. */
  customer: { value: number } | null;
  /** The commission still only ACCRUED, to be voided by a reversing entry. */
  commission: { id: string; userId: string; amount: number; currency: string }[];
  shelf: { out: number; back: number };
}

export type Judged = { ok: false; code: UndoWhy; text: string } | { ok: true; plan: UndoPlan };

const refuse = (code: UndoWhy, text: string): Judged => ({ ok: false, code, text });

const isDelivered = (s: string) => (LEGACY_DELIVERED as readonly string[]).includes(s);
const hasNoMoney = (s: string) => (NO_MONEY_SETTLEMENT as readonly string[]).includes(s);

const liveEntry = (e: UndoCommission) => !e.reversed && (e.status === 'ACCRUED' || e.status === 'PAYABLE' || e.status === 'PAID');
/** Money moved: the entry is payable, paid, or already attached to a payout. */
export const commissionMoved = (e: UndoCommission) => liveEntry(e) && (e.status !== 'ACCRUED' || e.payoutId !== null);
/** Only an entry that is still ACCRUED and attached to no payout can be voided — the other two kinds are a refusal, never a write. */
export const commissionVoidable = (e: UndoCommission) => liveEntry(e) && !commissionMoved(e);

/** The door's expected collection, as the door wrote it in the activity's metadata — or null when it is not a readable figure. */
export function figureOf(metadata: string | null): number | null {
  if (!metadata) return null;
  try {
    const v = (JSON.parse(metadata) as { expectedCollection?: unknown } | null)?.expectedCollection;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

type Recording = { ok: true; path: UndoPlan['path']; mark: UndoMark } | { ok: false; text: string };

/**
 * WHICH DOOR RECORDED THE DELIVERY THE ORDER NOW CARRIES — from the newest row that names one.
 *
 * Newest first: a delivery recorded again after an earlier undo is judged by its own row. The row must say the very status the order has
 * now; if the status moved after it (a statement's sweep, a swap), or the newest row is an undo, or there is no row at all, or the row is
 * the combined-status override, the ledgers do not prove what the recording wrote and the order is left alone.
 */
export function recordingOf(order: Pick<UndoOrder, 'shippingStatus'>, marks: UndoMark[]): Recording {
  for (const m of marks) {
    if (m.action === DELIVERY_UNDO_ACTION) return { ok: false, text: UNDO_WHY_AR.noRecord };
    if (m.newStatus == null || !isDelivered(m.newStatus)) continue;
    if (m.newStatus !== order.shippingStatus) return { ok: false, text: UNDO_WHY_AR.changedAfter };
    if (m.action === DOOR_MARK) return { ok: true, path: 'DOOR', mark: m };
    if (m.action === SHIPPING_MARK) return { ok: true, path: 'SHIPPING_ROUTE', mark: m };
    if (m.action === OVERRIDE_MARK) return { ok: false, text: UNDO_WHY_AR.override };
  }
  return { ok: false, text: UNDO_WHY_AR.noRecord };
}

/** Where it goes back to: the timeline's «before» when the door that recorded it kept one and it is a state a parcel can be in, else the default. */
export function beforeOf(
  path: UndoPlan['path'],
  mark: Pick<UndoMark, 'previousStatus'>,
  shippingStatus: string,
  shippingLog: UndoFacts['shippingLog']
): { to: UndoPlan['to']; defaulted: boolean } {
  if (path === 'SHIPPING_ROUTE') {
    const line = shippingLog.find((l) => l.newValue === shippingStatus);
    const before = line?.previousValue ?? mark.previousStatus;
    if (before && (BEFORE_DELIVERY as readonly string[]).includes(before)) return { to: before as UndoPlan['to'], defaulted: false };
  }
  return { to: DEFAULT_BEFORE, defaulted: true };
}

/**
 * THE QUESTION AND THE PRESS ASK THE SAME FUNCTION.
 *
 * It returns the first refusal that applies, in words, or the plan — everything the press would write, decided from the facts alone. The
 * dialog draws `measureUndo(facts)` (which calls this) and the press calls this again inside its transaction, so the list on the screen and
 * the writes cannot be two answers.
 */
export function judgeUndo(facts: UndoFacts): Judged {
  const { order } = facts;

  if (!isDelivered(order.shippingStatus)) {
    return facts.marks[0]?.action === DELIVERY_UNDO_ACTION
      ? refuse('ALREADY_UNDONE', UNDO_WHY_AR.alreadyUndone(shippingWord(order.shippingStatus)))
      : refuse('NOT_DELIVERED', UNDO_WHY_AR.notDelivered(shippingWord(order.shippingStatus)));
  }

  // MONEY. A collected amount written, or a settlement state that carries money or is closed. `COLLECTED` is no money: it is the word a
  // delivery through the order's own door writes (decided below, once the door is known).
  const collectedWord = order.settlementStatus === COLLECTED;
  if (order.hasCollectedAmount) return refuse('MONEY_RECORDED', UNDO_WHY_AR.moneyAmount);
  if (!hasNoMoney(order.settlementStatus) && !collectedWord) return refuse('MONEY_RECORDED', UNDO_WHY_AR.moneyState(order.settlementStatus));

  // A STATEMENT. Any statement that names the order, draft or approved: it owns the order's money from there.
  if (facts.named) return refuse('ON_A_STATEMENT', facts.named.error);

  // A COUNTED RETURN. The goods side already happened.
  if (order.hasReturnReceipt) return refuse('RETURN_COUNTED', UNDO_WHY_AR.returnCounted);

  // COMMISSION THAT MOVED. Payable, paid, or inside a payout: the money left the ledger's hands.
  const moved = facts.commission.filter(commissionMoved);
  if (moved.length > 0) return refuse('COMMISSION_MOVED', UNDO_WHY_AR.commissionMoved(moved.length));

  // THE RECORDING. Without proof of which door wrote the delivery, nothing is reversed.
  const rec = recordingOf(order, facts.marks);
  if (!rec.ok) return refuse('PATH_UNKNOWN', rec.text);
  if (collectedWord && !(rec.path === 'SHIPPING_ROUTE' && order.shippingStatus === 'DELIVERED')) {
    return refuse('PATH_UNKNOWN', UNDO_WHY_AR.collectedUnexplained);
  }
  let customer: UndoPlan['customer'] = null;
  if (rec.path === 'DOOR') {
    const value = figureOf(rec.mark.metadata);
    if (value === null) return refuse('PATH_UNKNOWN', UNDO_WHY_AR.noFigure);
    customer = { value };
  }

  const before = beforeOf(rec.path, rec.mark, order.shippingStatus, facts.shippingLog);
  const plan: UndoPlan = {
    path: rec.path,
    from: order.shippingStatus as UndoPlan['from'],
    to: before.to,
    toDefaulted: before.defaulted,
    settlementFrom: order.settlementStatus,
    settlement: collectedWord ? { to: BACK_TO_AWAITING } : null,
    legacyStatus: order.status === 'DELIVERED',
    items: order.items.filter((i) => i.deliveredQty !== null || i.returnedQty !== null),
    customer,
    commission: facts.commission.filter(commissionVoidable).map((e) => ({ id: e.id, userId: e.userId, amount: e.amount, currency: e.currency })),
    shelf: facts.shelf,
  };
  return { ok: true, plan };
}

/** What the screen saw, reduced to a short string the press sends back: the same order in the same state with the same plan, or the press is refused. */
export function fingerprintOf(order: Pick<UndoOrder, 'id' | 'version'>, plan: UndoPlan): string {
  const byKey = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));
  const canon = {
    o: order.id,
    v: order.version,
    p: plan.path,
    f: plan.from,
    t: plan.to,
    s: [plan.settlementFrom, plan.settlement?.to ?? null],
    l: plan.legacyStatus,
    i: plan.items.map((i) => [i.id, i.deliveredQty, i.returnedQty]).sort(byKey),
    c: plan.customer ? plan.customer.value : null,
    m: plan.commission.map((e) => e.id).sort(),
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 24);
}

/* ───────────────────────────── the measure ───────────────────────────── */

/**
 * WHAT THE DIALOG DRAWS: the refusal in words, or every line the press would write and every line it would leave. Pure — the same `facts`
 * the press reads, the same `judgeUndo`.
 */
export function measureUndo(facts: UndoFacts): UndoMeasure {
  const { order } = facts;
  const judged = judgeUndo(facts);
  const base = { orderNumber: order.orderNumber, courier: order.courier, from: order.shippingStatus };
  if (!judged.ok) {
    return { ...base, allowed: false, refusal: { code: judged.code, text: judged.text }, fingerprint: null, to: null, lines: [], stays: [] };
  }
  const { plan } = judged;

  const lines: UndoLine[] = [{ key: 'STATUS', text: UNDO_LINE_AR.status(shippingWord(plan.from), shippingWord(plan.to), plan.toDefaulted) }];
  if (plan.items.length > 0) lines.push({ key: 'ITEMS', text: UNDO_LINE_AR.items(plan.items.length) });
  if (plan.settlement) {
    lines.push({ key: 'SETTLEMENT', text: UNDO_LINE_AR.settlement(settlementWord(plan.settlementFrom), settlementWord(plan.settlement.to)) });
  }
  if (plan.customer) {
    const before = facts.customer?.deliveredOrders ?? 0;
    lines.push({
      key: 'CUSTOMER',
      text: UNDO_LINE_AR.customer(Math.max(0, before - 1), before),
      amount: { value: round3(plan.customer.value), currency: order.currency },
    });
  }
  if (plan.commission.length > 0) lines.push({ key: 'COMMISSION', text: UNDO_LINE_AR.commission(plan.commission.length) });

  const stays: UndoLine[] = [
    { key: 'STOCK', text: UNDO_STAYS_AR.stock(plan.shelf.out, plan.shelf.back) },
    { key: 'MONEY', text: UNDO_STAYS_AR.money },
    { key: 'HISTORY', text: UNDO_STAYS_AR.history },
  ];
  if (plan.commission.length === 0) stays.push({ key: 'COMMISSION', text: UNDO_STAYS_AR.noCommission });
  if (plan.path === 'SHIPPING_ROUTE') stays.push({ key: 'EVENTS', text: UNDO_STAYS_AR.events });

  return { ...base, allowed: true, refusal: null, fingerprint: fingerprintOf(order, plan), to: plan.to, lines, stays };
}

/* ───────────────────────────── the press ───────────────────────────── */

/** A refusal found inside the transaction: it rolls back and this is the answer. */
export class UndoStopped extends Error {
  constructor(
    readonly status: number,
    readonly body: { code: string; error: string }
  ) {
    super(body.code);
  }
}

export interface UndoInput {
  scope: UndoScope;
  user: { id: string; role: string };
  orderId: string;
  /** Already trimmed, and at least `UNDO_REASON_MIN` long (the door checked). */
  reason: string;
  /** What the dialog saw. */
  fingerprint: string;
}

export interface UndoDone {
  plan: UndoPlan;
  /** The reversing commission entries written. */
  voided: number;
  orderNumber: string;
}

/** The claim's own WHERE: still this delivery, still this version, still the state the plan was made from, and still no money — only this order. */
export function claimWhere(scope: UndoScope, order: UndoOrder, plan: UndoPlan): Prisma.OrderWhereInput {
  return {
    id: order.id,
    companyId: scope.companyId,
    storeId: scope.storeId,
    version: order.version,
    shippingStatus: plan.from,
    settlementStatus: plan.settlementFrom,
    collectedAmount: null,
    returnReceipt: null,
  };
}

/** What the claim writes on the order: the status and its date, the version, and the two columns the delivery itself wrote. */
export function claimData(plan: UndoPlan): Prisma.OrderUpdateManyMutationInput {
  return {
    shippingStatus: plan.to,
    deliveredAt: null,
    version: { increment: 1 },
    ...(plan.legacyStatus ? { status: 'SHIPPED' } : {}),
    ...(plan.settlement ? { settlementStatus: plan.settlement.to } : {}),
  };
}

/**
 * THE PRESS. Runs inside the caller's transaction, and either writes everything or throws and writes nothing.
 *
 *  1. It reads again, here, and refuses unless the order and its plan are exactly what the dialog showed (the fingerprint).
 *  2. It CLAIMS the order with a condition (still this delivery, this version, no money): another press, a collection, an edit or an
 *     approval that got there first makes the claim short, and the whole thing rolls back.
 *  3. It reads the statements and the commission again, after the claim, as the collect door does: a statement uploaded — or a commission
 *     made payable — while this waited for the row is visible now, and then nothing is undone.
 *  4. Only then the writes: the lines, the customer's counters, the reversing commission entries, the two timeline lines, the activity and
 *     the note. No wallet, no amount, no stock, no event.
 */
export async function undoDelivery(tx: Tx, input: UndoInput): Promise<UndoDone> {
  const { scope, user } = input;

  const facts = await readUndoFacts(tx, scope, input.orderId);
  if (!facts) throw new UndoStopped(404, { code: 'NOT_FOUND', error: UNDO_NOT_FOUND_AR });
  const judged = judgeUndo(facts);
  if (!judged.ok) throw new UndoStopped(409, { code: judged.code, error: judged.text });
  const { plan } = judged;
  const { order } = facts;
  if (fingerprintOf(order, plan) !== input.fingerprint) {
    throw new UndoStopped(409, { code: 'CHANGED', error: UNDO_CHANGED_AR });
  }

  const claimed = await tx.order.updateMany({ where: claimWhere(scope, order, plan), data: claimData(plan) });
  if (claimed.count !== 1) throw new UndoStopped(409, { code: 'ORDERS_CHANGED', error: UNDO_ORDERS_CHANGED_AR });

  const late = await readNaming(tx, scope, order);
  if (late) throw new UndoStopped(409, { code: 'ON_A_STATEMENT', error: UNDO_LATE_STATEMENT_AR });
  const entries = await readCommission(tx, scope, order.id);
  if (entries.some(commissionMoved)) throw new UndoStopped(409, { code: 'COMMISSION_MOVED', error: UNDO_LATE_COMMISSION_AR });

  const note = `${UNDO_NOTE_PREFIX}: ${input.reason}`;

  if (plan.items.length > 0) {
    await tx.orderItem.updateMany({
      where: { orderId: order.id, id: { in: plan.items.map((i) => i.id) } },
      data: { deliveredQty: null, returnedQty: null },
    });
  }

  if (plan.customer) {
    // Exactly what the door added, taken off, and never below zero: the clamp is a guarded write of its own, so two undos on one
    // customer at the same moment cannot leave a negative counter whatever either of them read.
    await tx.customer.update({
      where: { id: order.customerId },
      data: { deliveredOrders: { decrement: 1 }, totalPurchaseValue: { decrement: plan.customer.value } },
    });
    await tx.customer.updateMany({ where: { id: order.customerId, deliveredOrders: { lt: 0 } }, data: { deliveredOrders: 0 } });
    await tx.customer.updateMany({ where: { id: order.customerId, totalPurchaseValue: { lt: 0 } }, data: { totalPurchaseValue: 0 } });
  }

  // The commission that is still only ACCRUED is voided by a reversing entry — the original stays, and nothing is paid or promoted.
  const voidable = entries.filter(commissionVoidable);
  const voided = voidable.length > 0 ? await reverseForOrder(tx, { companyId: scope.companyId, orderId: order.id, reason: note }) : 0;

  await tx.orderStatusLog.create({
    data: {
      companyId: scope.companyId,
      orderId: order.id,
      statusType: 'SHIPPING',
      previousValue: plan.from,
      newValue: plan.to,
      changedById: user.id,
      changedByRole: user.role,
      note,
    },
  });
  if (plan.settlement) {
    await tx.orderStatusLog.create({
      data: {
        companyId: scope.companyId,
        orderId: order.id,
        statusType: 'SETTLEMENT',
        previousValue: plan.settlementFrom,
        newValue: plan.settlement.to,
        changedById: user.id,
        changedByRole: user.role,
        note,
      },
    });
  }
  await tx.orderActivity.create({
    data: {
      companyId: scope.companyId,
      orderId: order.id,
      userId: user.id,
      action: DELIVERY_UNDO_ACTION,
      previousStatus: plan.from,
      newStatus: plan.to,
      metadata: JSON.stringify({
        reason: input.reason,
        path: plan.path,
        defaulted: plan.toDefaulted,
        items: plan.items.length,
        settlement: plan.settlement ? { from: plan.settlementFrom, to: plan.settlement.to } : null,
        customer: plan.customer ? { delivered: -1, value: -plan.customer.value } : null,
        commissionVoided: voided,
        stock: 'KEPT',
      }),
    },
  });
  await tx.orderNote.create({
    data: { companyId: scope.companyId, orderId: order.id, authorId: user.id, kind: 'internal', body: note },
  });

  return { plan, voided, orderNumber: order.orderNumber };
}
