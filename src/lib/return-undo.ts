import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { NO_MONEY_SETTLEMENT } from './legacy-closeout';
import { openRequestWhere } from './match-integrity';
import { SHIPPING_STATUS_AR } from './shipping-workflow';
import { BEFORE_DELIVERY, DEFAULT_BEFORE, readNaming } from './delivery-undo';
import { DELIVERY_UNDO_ACTION, DOOR_MARK, OVERRIDE_MARK, SHIPPING_MARK } from './delivery-undo-words';
import {
  RETURN_UNDO_ACTION,
  RETURN_UNDO_CHANGED_AR,
  RETURN_UNDO_LINE_AR,
  RETURN_UNDO_NOTE_PREFIX,
  RETURN_UNDO_NOT_FOUND_AR,
  RETURN_UNDO_ORDERS_CHANGED_AR,
  RETURN_UNDO_STAYS_AR,
  RETURN_UNDO_WHY_AR,
  type ReturnUndoLine,
  type ReturnUndoMeasure,
  type ReturnUndoWhy,
} from './return-undo-words';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * «تراجع عن المرتجع» — A RETURN RECORDED AT THE DOOR BY MISTAKE IS TAKEN BACK, FROM WHAT THE LEDGERS PROVE (25/11).
 *
 * The mirror of «تراجع عن التسليم» (`delivery-undo.ts`), and built the same way: MEASURE first (writes nothing), then PRESS with a
 * fingerprint of what was measured and ONE conditional claim. There is no time window anywhere in this file: it refuses on facts.
 *
 * ── WHAT «رجعت» WROTE (`recordPartialDelivery`, nothing taken), AND WHAT THIS PUTS BACK ──
 *
 *   the order       `shippingStatus = RETURNED`, `returnedAt`, `returnReason`, the version      → the state before (the timeline's, else
 *                                                                                                  «مشحون»), both columns cleared
 *   every line      `deliveredQty = 0`, `returnedQty = qty`                                       → both cleared («the door has not spoken»)
 *   the customer    `cancelledOrders + 1`                                                         → exactly that one taken back, never below 0
 *   the knock       a FAILED attempt                                                              → kept: it is history, and it names
 *                                                                                                  nobody for a shortfall (only a delivered
 *                                                                                                  attempt does — `shortfall.DOOR_RESULTS`)
 *   history         an activity `PARTIAL_DELIVERY_RECORDED` → RETURNED, maybe a note           → kept; one row of each kind is ADDED
 *   the stock       NOTHING (nothing taken consumes nothing)                                      → nothing. The statement's close (or «استلم»)
 *                                                                                                  consumes it once, later, through the
 *                                                                                                  ledger's own key.
 *
 * NO MONEY: never a wallet movement, an amount, a commission, an app event.
 *
 * ── WHAT IT REFUSES (nothing is written) ──
 *
 * not RETURNED (or already undone) · money recorded (an amount, or a settlement state that carries money or is closed) · a counted return
 * (a return receipt) · an open cancel/postpone request · a return the door did not record (no `PARTIAL_DELIVERY_RECORDED → RETURNED` row, or
 * another door's row) · a status that moved after the record · the order changed since the measure.
 *
 * It is NOT refused because a statement names the order: a statement that says «delivered, paid» is the very reason to undo.
 */

export interface ReturnUndoScope {
  companyId: string;
  storeId: string;
}

export const RETURNED = 'RETURNED';

const shippingWord = (s: string): string => (SHIPPING_STATUS_AR as Record<string, string>)[s] ?? s;
const hasNoMoney = (s: string) => (NO_MONEY_SETTLEMENT as readonly string[]).includes(s);

/* ───────────────────────────── the facts ───────────────────────────── */

export interface ReturnUndoOrder {
  id: string;
  orderNumber: string;
  merchantRef: string | null;
  trackingNumber: string | null;
  deliveryProviderId: string | null;
  customerId: string;
  courier: string;
  shippingStatus: string;
  settlementStatus: string;
  version: number;
  /** A collected amount is written on the order: money is recorded. */
  hasCollectedAmount: boolean;
  items: { id: string; productName: string; deliveredQty: number | null; returnedQty: number | null }[];
  hasReturnReceipt: boolean;
}

/** One of the order's activity rows that names a status move (or an undo). Newest first. `at` orders it against the timeline. */
export interface ReturnUndoMark {
  id: string;
  action: string;
  newStatus: string | null;
  at: Date;
}

export interface ReturnUndoFacts {
  order: ReturnUndoOrder;
  /** The order's status-move rows and undo rows, newest first. */
  marks: ReturnUndoMark[];
  /** The SHIPPING timeline lines, newest first. */
  shippingLog: { previousValue: string | null; newValue: string | null; at: Date }[];
  /** Cancel / postpone requests asked for and not carried out (the matcher's own reading, `openRequestWhere`). */
  openRequests: number;
  customer: { cancelledOrders: number } | null;
  /** A statement speaks for the order. Said, never a refusal. */
  named: boolean;
}

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  merchantRef: true,
  trackingNumber: true,
  deliveryProviderId: true,
  customerId: true,
  shippingStatus: true,
  settlementStatus: true,
  version: true,
  collectedAmount: true,
  deliveryProvider: { select: { name: true } },
  items: { select: { id: true, productName: true, deliveredQty: true, returnedQty: true } },
  returnReceipt: { select: { id: true } },
} satisfies Prisma.OrderSelect;

/** The activity rows that move a status, or take one back — the evidence of who wrote the RETURNED the order carries. */
export const STATUS_MARKS = [DOOR_MARK, SHIPPING_MARK, OVERRIDE_MARK, DELIVERY_UNDO_ACTION, RETURN_UNDO_ACTION] as const;

/** EVERYTHING THE QUESTION NEEDS, READ ONCE (the measure with the module's client, the press with the transaction's). Null: not this store's. */
export async function readReturnUndoFacts(tx: Tx, scope: ReturnUndoScope, orderId: string): Promise<ReturnUndoFacts | null> {
  const o = await tx.order.findFirst({ where: { id: orderId, companyId: scope.companyId, storeId: scope.storeId }, select: ORDER_SELECT });
  if (!o) return null;
  const order: ReturnUndoOrder = {
    id: o.id,
    orderNumber: o.orderNumber,
    merchantRef: o.merchantRef,
    trackingNumber: o.trackingNumber,
    deliveryProviderId: o.deliveryProviderId,
    customerId: o.customerId,
    courier: o.deliveryProvider?.name ?? 'بلا شركة شحن',
    shippingStatus: o.shippingStatus,
    settlementStatus: o.settlementStatus,
    version: o.version,
    hasCollectedAmount: o.collectedAmount != null,
    items: o.items.map((i) => ({ id: i.id, productName: i.productName, deliveredQty: i.deliveredQty, returnedQty: i.returnedQty })),
    hasReturnReceipt: o.returnReceipt != null,
  };

  const marks = await tx.orderActivity.findMany({
    where: { companyId: scope.companyId, orderId, action: { in: [...STATUS_MARKS] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, action: true, newStatus: true, createdAt: true },
  });
  const shippingLog = await tx.orderStatusLog.findMany({
    where: { companyId: scope.companyId, orderId, statusType: 'SHIPPING' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { previousValue: true, newValue: true, createdAt: true },
    take: 50,
  });
  const requests = await tx.orderChangeRequest.findMany({
    where: { companyId: scope.companyId, orderId, ...openRequestWhere() },
    select: { id: true },
  });
  const c = await tx.customer.findFirst({ where: { id: o.customerId, companyId: scope.companyId }, select: { cancelledOrders: true } });
  const named = await readNaming(tx, scope, {
    ...order,
    currency: '',
    status: '',
  });

  return {
    order,
    marks: marks.map((m) => ({ id: m.id, action: m.action, newStatus: m.newStatus, at: m.createdAt })),
    shippingLog: shippingLog.map((l) => ({ previousValue: l.previousValue, newValue: l.newValue, at: l.createdAt })),
    openRequests: requests.length,
    customer: c ? { cancelledOrders: c.cancelledOrders } : null,
    named: named !== null,
  };
}

/* ───────────────────────────── the judgement ───────────────────────────── */

export interface ReturnUndoPlan {
  /** The door's own row that recorded the return — the fingerprint holds the press to exactly this one. */
  markId: string;
  to: (typeof BEFORE_DELIVERY)[number];
  /** The timeline did not say where it was before: it goes back to the default. */
  toDefaulted: boolean;
  /** The settlement state read — the claim holds the order to exactly this one. */
  settlementFrom: string;
  /** The lines whose door-written quantities go back to «the door has not spoken». */
  items: { id: string; productName: string; deliveredQty: number | null; returnedQty: number | null }[];
}

export type ReturnJudged = { ok: false; code: ReturnUndoWhy; text: string } | { ok: true; plan: ReturnUndoPlan };

const refuse = (code: ReturnUndoWhy, text: string): ReturnJudged => ({ ok: false, code, text });

type Recording = { ok: true; mark: ReturnUndoMark } | { ok: false; code: ReturnUndoWhy; text: string };

/**
 * WHO WROTE THE «RETURNED» THE ORDER CARRIES — from the newest row that moves a status.
 *
 * It must be the door's own row (`PARTIAL_DELIVERY_RECORDED` → RETURNED). An undo on top (of a delivery or of a return) means what made it
 * RETURNED again left no row; another door's RETURNED row means the door did not write it; a newer row to any other status means the
 * status moved after the record. And a SHIPPING timeline line written after the door's row is a move the activity did not name.
 */
export function recordingOf(facts: Pick<ReturnUndoFacts, 'marks' | 'shippingLog'>): Recording {
  for (const m of facts.marks) {
    if (m.action === RETURN_UNDO_ACTION || m.action === DELIVERY_UNDO_ACTION) {
      return { ok: false, code: 'NOT_BY_THE_DOOR', text: RETURN_UNDO_WHY_AR.notByTheDoor };
    }
    if (m.newStatus == null) continue;
    if (m.action === DOOR_MARK && m.newStatus === RETURNED) {
      if (facts.shippingLog.some((l) => l.at > m.at)) return { ok: false, code: 'CHANGED_AFTER', text: RETURN_UNDO_WHY_AR.changedAfter };
      return { ok: true, mark: m };
    }
    if (m.newStatus === RETURNED) return { ok: false, code: 'NOT_BY_THE_DOOR', text: RETURN_UNDO_WHY_AR.notByTheDoor };
    // A newer row to another status: something moved it after — unless an older door row is not there at all.
    const doorBelow = facts.marks.some((x) => x.action === DOOR_MARK && x.newStatus === RETURNED);
    return doorBelow
      ? { ok: false, code: 'CHANGED_AFTER', text: RETURN_UNDO_WHY_AR.changedAfter }
      : { ok: false, code: 'NOT_BY_THE_DOOR', text: RETURN_UNDO_WHY_AR.notByTheDoor };
  }
  return { ok: false, code: 'NOT_BY_THE_DOOR', text: RETURN_UNDO_WHY_AR.notByTheDoor };
}

/** Where it goes back to: the newest timeline line at or before the door's row, when it says a state a parcel can be in at the door. */
export function beforeOf(mark: Pick<ReturnUndoMark, 'at'>, shippingLog: ReturnUndoFacts['shippingLog']): { to: ReturnUndoPlan['to']; defaulted: boolean } {
  const line = shippingLog.find((l) => !(l.at > mark.at));
  const before = line?.newValue;
  if (before && (BEFORE_DELIVERY as readonly string[]).includes(before)) return { to: before as ReturnUndoPlan['to'], defaulted: false };
  return { to: DEFAULT_BEFORE, defaulted: true };
}

/** THE QUESTION AND THE PRESS ASK THE SAME FUNCTION: the first refusal that applies, in words, or the plan. */
export function judgeReturnUndo(facts: ReturnUndoFacts): ReturnJudged {
  const { order } = facts;

  if (order.shippingStatus !== RETURNED) {
    return facts.marks[0]?.action === RETURN_UNDO_ACTION
      ? refuse('ALREADY_UNDONE', RETURN_UNDO_WHY_AR.alreadyUndone(shippingWord(order.shippingStatus)))
      : refuse('NOT_RETURNED', RETURN_UNDO_WHY_AR.notReturned(shippingWord(order.shippingStatus)));
  }

  // MONEY. A collected amount written, or a settlement state that carries money or is closed.
  if (order.hasCollectedAmount) return refuse('MONEY_RECORDED', RETURN_UNDO_WHY_AR.moneyAmount);
  if (!hasNoMoney(order.settlementStatus)) return refuse('MONEY_RECORDED', RETURN_UNDO_WHY_AR.moneyState(order.settlementStatus));

  // A COUNTED RETURN. The goods are back on the shelf.
  if (order.hasReturnReceipt) return refuse('RETURN_COUNTED', RETURN_UNDO_WHY_AR.returnCounted);

  // AN OPEN CANCEL OR POSTPONEMENT. Settle it first: the parcel may not be what the undo would say.
  if (facts.openRequests > 0) return refuse('OPEN_REQUEST', RETURN_UNDO_WHY_AR.openRequest);

  // THE RECORDING. Without proof that the door wrote it, nothing is put back.
  const rec = recordingOf(facts);
  if (!rec.ok) return refuse(rec.code, rec.text);

  const before = beforeOf(rec.mark, facts.shippingLog);
  return {
    ok: true,
    plan: {
      markId: rec.mark.id,
      to: before.to,
      toDefaulted: before.defaulted,
      settlementFrom: order.settlementStatus,
      items: order.items.filter((i) => i.deliveredQty !== null || i.returnedQty !== null),
    },
  };
}

/** What the screen saw, reduced to a short string the press sends back: the same order in the same state with the same plan, or refused. */
export function fingerprintOf(order: Pick<ReturnUndoOrder, 'id' | 'version'>, plan: ReturnUndoPlan): string {
  const byKey = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));
  const canon = {
    o: order.id,
    v: order.version,
    k: plan.markId,
    t: plan.to,
    s: plan.settlementFrom,
    i: plan.items.map((i) => [i.id, i.deliveredQty, i.returnedQty]).sort(byKey),
  };
  return createHash('sha256').update(JSON.stringify(['RETURN_UNDO', canon])).digest('hex').slice(0, 24);
}

/* ───────────────────────────── the measure ───────────────────────────── */

/** WHAT THE DIALOG DRAWS: the refusal in words, or every line the press would write and every line it would leave. Pure. */
export function measureReturnUndo(facts: ReturnUndoFacts): ReturnUndoMeasure {
  const { order } = facts;
  const judged = judgeReturnUndo(facts);
  const base = { orderNumber: order.orderNumber, courier: order.courier, from: order.shippingStatus };
  if (!judged.ok) {
    return { ...base, allowed: false, refusal: { code: judged.code, text: judged.text }, fingerprint: null, to: null, lines: [], stays: [] };
  }
  const { plan } = judged;

  const lines: ReturnUndoLine[] = [{ key: 'STATUS', text: RETURN_UNDO_LINE_AR.status(shippingWord(RETURNED), shippingWord(plan.to), plan.toDefaulted) }];
  if (plan.items.length > 0) lines.push({ key: 'ITEMS', text: RETURN_UNDO_LINE_AR.items(plan.items.length) });
  const refused = facts.customer?.cancelledOrders ?? 0;
  lines.push({ key: 'CUSTOMER', text: RETURN_UNDO_LINE_AR.customer(Math.max(0, refused - 1), refused) });

  const stays: ReturnUndoLine[] = [
    { key: 'STOCK', text: RETURN_UNDO_STAYS_AR.stock },
    { key: 'MONEY', text: RETURN_UNDO_STAYS_AR.money },
    { key: 'HISTORY', text: RETURN_UNDO_STAYS_AR.history },
  ];
  if (facts.named) stays.push({ key: 'STATEMENT', text: RETURN_UNDO_STAYS_AR.statement });

  return { ...base, allowed: true, refusal: null, fingerprint: fingerprintOf(order, plan), to: plan.to, lines, stays };
}

/* ───────────────────────────── the press ───────────────────────────── */

/** A refusal found inside the transaction: it rolls back and this is the answer. */
export class ReturnUndoStopped extends Error {
  constructor(
    readonly status: number,
    readonly body: { code: string; error: string }
  ) {
    super(body.code);
  }
}

export interface ReturnUndoInput {
  scope: ReturnUndoScope;
  user: { id: string; role: string };
  orderId: string;
  /** Already trimmed, and within `UNDO_REASON_MIN`..`UNDO_REASON_MAX` (the door checked). */
  reason: string;
  /** What the dialog saw. */
  fingerprint: string;
}

export interface ReturnUndoDone {
  plan: ReturnUndoPlan;
  orderNumber: string;
}

/** The claim's own WHERE: still RETURNED, this version, this settlement state, no money, no counted return, no open request. */
export function claimWhere(scope: ReturnUndoScope, order: Pick<ReturnUndoOrder, 'id' | 'version'>, plan: ReturnUndoPlan): Prisma.OrderWhereInput {
  return {
    id: order.id,
    companyId: scope.companyId,
    storeId: scope.storeId,
    version: order.version,
    shippingStatus: RETURNED,
    settlementStatus: plan.settlementFrom,
    collectedAmount: null,
    returnReceipt: null,
    changeRequests: { none: openRequestWhere() },
  };
}

/** What the claim writes on the order: the state before, the two columns «رجعت» wrote cleared, the next version. Nothing else. */
export function claimData(plan: ReturnUndoPlan): Prisma.OrderUpdateManyMutationInput {
  return {
    shippingStatus: plan.to,
    returnedAt: null,
    returnReason: null,
    version: { increment: 1 },
  };
}

/**
 * THE PRESS. Runs inside the caller's transaction, and either writes everything or throws and writes nothing.
 *
 *  1. It reads again, here, and refuses unless the order and its plan are exactly what the dialog showed (the fingerprint).
 *  2. It CLAIMS the order with a condition (still RETURNED, this version, no money, no receipt, no open request): another press, a count at
 *     the returns desk, an edit or a request that got there first makes the claim short, and the whole thing rolls back.
 *  3. Only then the writes: the lines, the customer's one counter, the timeline line, the activity and the note.
 *     No wallet, no amount, no stock, no commission, no event.
 */
export async function undoReturn(tx: Tx, input: ReturnUndoInput): Promise<ReturnUndoDone> {
  const { scope, user } = input;

  const facts = await readReturnUndoFacts(tx, scope, input.orderId);
  if (!facts) throw new ReturnUndoStopped(404, { code: 'NOT_FOUND', error: RETURN_UNDO_NOT_FOUND_AR });
  const judged = judgeReturnUndo(facts);
  if (!judged.ok) throw new ReturnUndoStopped(409, { code: judged.code, error: judged.text });
  const { plan } = judged;
  const { order } = facts;
  if (fingerprintOf(order, plan) !== input.fingerprint) {
    throw new ReturnUndoStopped(409, { code: 'CHANGED', error: RETURN_UNDO_CHANGED_AR });
  }

  const claimed = await tx.order.updateMany({ where: claimWhere(scope, order, plan), data: claimData(plan) });
  if (claimed.count !== 1) throw new ReturnUndoStopped(409, { code: 'ORDERS_CHANGED', error: RETURN_UNDO_ORDERS_CHANGED_AR });

  const note = `${RETURN_UNDO_NOTE_PREFIX}: ${input.reason}`;

  if (plan.items.length > 0) {
    await tx.orderItem.updateMany({
      where: { orderId: order.id, id: { in: plan.items.map((i) => i.id) } },
      data: { deliveredQty: null, returnedQty: null },
    });
  }

  // Exactly the one «رجعت» added, taken off, and never below zero: the clamp is a guarded write of its own, so two undos on one customer
  // at the same moment cannot leave a negative counter whatever either of them read.
  await tx.customer.update({ where: { id: order.customerId }, data: { cancelledOrders: { decrement: 1 } } });
  await tx.customer.updateMany({ where: { id: order.customerId, cancelledOrders: { lt: 0 } }, data: { cancelledOrders: 0 } });

  await tx.orderStatusLog.create({
    data: {
      companyId: scope.companyId,
      orderId: order.id,
      statusType: 'SHIPPING',
      previousValue: RETURNED,
      newValue: plan.to,
      changedById: user.id,
      changedByRole: user.role,
      note,
    },
  });
  await tx.orderActivity.create({
    data: {
      companyId: scope.companyId,
      orderId: order.id,
      userId: user.id,
      action: RETURN_UNDO_ACTION,
      previousStatus: RETURNED,
      newStatus: plan.to,
      metadata: JSON.stringify({
        reason: input.reason,
        undoes: plan.markId,
        defaulted: plan.toDefaulted,
        items: plan.items.length,
        customer: { refused: -1 },
        stock: 'NONE',
      }),
    },
  });
  await tx.orderNote.create({
    data: { companyId: scope.companyId, orderId: order.id, authorId: user.id, kind: 'internal', body: note },
  });

  return { plan, orderNumber: order.orderNumber };
}
