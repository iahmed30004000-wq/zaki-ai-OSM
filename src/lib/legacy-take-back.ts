import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { LEGACY_DELIVERED, NO_MONEY_SETTLEMENT } from './legacy-closeout';
import { LEGACY_CLOSE_ACTION, LEGACY_CLOSE_NOTE, PICKED_CLOSE_NOTE } from './legacy-closeout-words';
import { commissionMoved, readCommission, type UndoCommission } from './delivery-undo';
import { settlementWord } from './delivery-undo-words';
import { RESOLUTIONS } from './settlement-difference';
import { SHIPPING_STATUS_AR } from './shipping-workflow';
import {
  LEGACY_MARK_UNDONE,
  LEGACY_TAKE_BACK_ACTION,
  TAKE_BACK_CHANGED_AR,
  TAKE_BACK_LATE_MONEY_AR,
  TAKE_BACK_LINE_AR,
  TAKE_BACK_NOTE_PREFIX,
  TAKE_BACK_NOT_FOUND_AR,
  TAKE_BACK_ORDERS_CHANGED_AR,
  TAKE_BACK_STAYS_AR,
  TAKE_BACK_WHY_AR,
  type TakeBackLine,
  type TakeBackMeasure,
  type TakeBackWhy,
} from './legacy-take-back-words';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * «تراجع عن إقفال القديمة» — A NO-MONEY CLOSE TAKEN BACK, FROM WHAT THE LEDGERS PROVE (25/11).
 *
 *   «اعملها بالكود» (the owner, on four orders the close made «مسوّى» while the company's statement says they came back at zero)
 *
 * ── WHAT THE CLOSE WROTE, AND WHAT THIS REVERSES ──
 *
 * `legacy-closeout.markClosed` (both presses — the old ones, and the ones the owner ticks) wrote, in one transaction, on each order:
 * `settlementStatus = SETTLED`; one SETTLEMENT log line (before → SETTLED, with the close's own sentence); and the MARK, an activity
 * `LEGACY_CLOSE_ACTION` with `previousStatus` = the state it took. Never a wallet movement, `collectedAmount`, a commission entry's
 * status, stock, a customer counter, a shortfall or an event. So that is all there is to reverse:
 *
 *   · the settlement goes back to the state the mark recorded (and the log line agrees with it);
 *   · the mark is RENAMED to `LEGACY_MARK_UNDONE` — the owner's rollback script's own spelling — so the commission rule stops leaving
 *     the order out (`PROMOTABLE_BY_PAYOUT` reads the old name): a later REAL settlement makes its commission payable once;
 *   · one SETTLEMENT log line (SETTLED → before) and one activity `LEGACY_TAKE_BACK_ACTION` say so, with the reason; the door writes
 *     the one audit row.
 *
 * ── WHAT IT REFUSES, WITH THE REASON IN WORDS (nothing is written) ──
 *
 * not SETTLED · SETTLED but not by the close (no live mark, or the settlement log's newest line is not the close's) · a mark whose «before»
 * is not a no-money state · ANY money trace: `collectedAmount`, a wallet movement that names the order, a «استلمت منه» on it, a statement
 * row that settled it or answered it with money (`appliedAt`, «اعتُمد رقم الشركة», «رقمنا هو المعتمد», a clean match), a commission
 * payable or paid · the order changed since the measure.
 *
 * NOT refused because a statement NAMES the order: a line that says «تم إرجاعها» at zero (unanswered, parked, excluded) carries no money,
 * whether its statement is open or already closed — it is the reason to take the close back.
 *
 * ── THE SHAPE: MEASURE FIRST, THEN PRESS (as `delivery-undo`) ──
 *
 * `measureTakeBack` writes nothing; `takeBackLegacyClose` runs inside the caller's transaction, re-reads, checks the fingerprint of what
 * was measured, CLAIMS the order with a condition (still SETTLED, still this version, still no collected amount), reads every money trace
 * AGAIN after the claim, and only then writes. A short claim, or any refusal after it, throws and the transaction takes back everything.
 */

export interface TakeBackScope {
  companyId: string;
  storeId: string;
}

/* ───────────────────────────── the facts ───────────────────────────── */

export interface TakeBackOrder {
  id: string;
  orderNumber: string;
  courier: string;
  shippingStatus: string;
  settlementStatus: string;
  version: number;
  hasCollectedAmount: boolean;
}

/** One of the order's rows that names the close: the mark, the mark renamed, or a take-back. Newest first. */
export interface TakeBackMark {
  id: string;
  action: string;
  previousStatus: string | null;
  newStatus: string | null;
}

/** A settlement log line, newest first. */
export interface SettlementLogLine {
  id: string;
  previousValue: string | null;
  newValue: string | null;
  note: string | null;
}

/** A statement row that holds the order, read whole enough to know whether it carries money. */
export interface StatementRow {
  result: string;
  resolution: string | null;
  appliedAt: Date | string | null;
  reference: string;
}

/** Every trace of money the order could carry besides the close. */
export interface MoneyTraces {
  walletMovements: number;
  manualCollections: number;
  rows: StatementRow[];
  commission: UndoCommission[];
}

export interface TakeBackFacts {
  order: TakeBackOrder;
  marks: TakeBackMark[];
  settlementLog: SettlementLogLine[];
  money: MoneyTraces;
}

/** The two sentences the close writes on the settlement log — the old ones' press, and the owner's press on the orders he ticks. */
export const CLOSE_NOTES: readonly string[] = [LEGACY_CLOSE_NOTE, PICKED_CLOSE_NOTE];

/** The wallet movements that can name ONE order: «استلمت منه» names the first order of its handover, and an order-level line. */
export const ORDER_MOVEMENT_TYPES = ['MANUAL_COLLECTION', 'ORDER'] as const;
/** The activity «استلمت منه» leaves on EVERY order of its handover. */
export const MANUAL_COLLECTION_ACTION = 'MANUAL_COLLECTION';

/** Every money trace, read with whatever client the caller holds — so after the claim it is the transaction's own read. */
export async function readMoneyTraces(tx: Tx, scope: TakeBackScope, orderId: string): Promise<MoneyTraces> {
  const walletMovements = await tx.walletMovement.count({
    where: { companyId: scope.companyId, referenceType: { in: [...ORDER_MOVEMENT_TYPES] }, referenceId: orderId },
  });
  const manualCollections = await tx.orderActivity.count({
    where: { companyId: scope.companyId, orderId, action: MANUAL_COLLECTION_ACTION },
  });
  const rows = await tx.settlementMatch.findMany({
    where: { companyId: scope.companyId, orderId },
    select: { result: true, resolution: true, appliedAt: true, statement: { select: { reference: true } } },
  });
  const commission = await readCommission(tx, scope, orderId);
  return {
    walletMovements,
    manualCollections,
    rows: rows.map((r) => ({ result: r.result, resolution: r.resolution, appliedAt: r.appliedAt, reference: r.statement?.reference ?? '—' })),
    commission,
  };
}

/** Everything the question needs, read once. Null when the order is no order of this store. */
export async function readTakeBackFacts(tx: Tx, scope: TakeBackScope, orderId: string): Promise<TakeBackFacts | null> {
  const o = await tx.order.findFirst({
    where: { id: orderId, companyId: scope.companyId, storeId: scope.storeId },
    select: {
      id: true,
      orderNumber: true,
      shippingStatus: true,
      settlementStatus: true,
      version: true,
      collectedAmount: true,
      deliveryProvider: { select: { name: true } },
    },
  });
  if (!o) return null;
  const marks = await tx.orderActivity.findMany({
    where: { companyId: scope.companyId, orderId, action: { in: [LEGACY_CLOSE_ACTION, LEGACY_MARK_UNDONE, LEGACY_TAKE_BACK_ACTION] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, action: true, previousStatus: true, newStatus: true },
  });
  const settlementLog = await tx.orderStatusLog.findMany({
    where: { companyId: scope.companyId, orderId, statusType: 'SETTLEMENT' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, previousValue: true, newValue: true, note: true },
    take: 20,
  });
  return {
    order: {
      id: o.id,
      orderNumber: o.orderNumber,
      courier: o.deliveryProvider?.name ?? 'بلا شركة شحن',
      shippingStatus: o.shippingStatus,
      settlementStatus: o.settlementStatus,
      version: o.version,
      hasCollectedAmount: o.collectedAmount != null,
    },
    marks,
    settlementLog,
    money: await readMoneyTraces(tx, scope, orderId),
  };
}

/* ───────────────────────────── the judgement ───────────────────────────── */

export interface TakeBackPlan {
  /** The state the mark recorded the close took the order from — where it goes back to. */
  to: (typeof NO_MONEY_SETTLEMENT)[number];
  /** The live marks that are renamed (the newest first). */
  markIds: string[];
  /** The close's own settlement log line — the proof, and part of the fingerprint. */
  logId: string;
}

export type TakeBackJudged = { ok: false; code: TakeBackWhy; text: string } | { ok: true; plan: TakeBackPlan };

const refuse = (code: TakeBackWhy, text: string): TakeBackJudged => ({ ok: false, code, text });
const isNoMoney = (s: string | null): s is TakeBackPlan['to'] => !!s && (NO_MONEY_SETTLEMENT as readonly string[]).includes(s);

/** A statement row that carries the order's money: the approval settled it, a person answered it with a figure, or it matched clean. */
export const rowCarriesMoney = (r: Pick<StatementRow, 'result' | 'resolution' | 'appliedAt'>): boolean =>
  r.appliedAt != null || (r.resolution != null && (RESOLUTIONS as readonly string[]).includes(r.resolution)) || r.result === 'MATCHED';

/** The first money trace, in words — or null when there is none. Asked before the claim and again after it. */
export function moneyRefusal(order: Pick<TakeBackOrder, 'hasCollectedAmount'>, money: MoneyTraces): { code: TakeBackWhy; text: string } | null {
  if (order.hasCollectedAmount) return { code: 'MONEY_RECORDED', text: TAKE_BACK_WHY_AR.moneyAmount };
  if (money.walletMovements > 0) return { code: 'MONEY_RECORDED', text: TAKE_BACK_WHY_AR.wallet(money.walletMovements) };
  if (money.manualCollections > 0) return { code: 'MONEY_RECORDED', text: TAKE_BACK_WHY_AR.manualCollection };
  const row = money.rows.find(rowCarriesMoney);
  if (row) return { code: 'MONEY_RECORDED', text: TAKE_BACK_WHY_AR.statement(row.reference) };
  const moved = money.commission.filter(commissionMoved);
  if (moved.length > 0) return { code: 'COMMISSION_MOVED', text: TAKE_BACK_WHY_AR.commissionMoved(moved.length) };
  return null;
}

/**
 * THE QUESTION AND THE PRESS ASK THE SAME FUNCTION: the first refusal that applies, in words, or the plan — decided from the facts alone.
 */
export function judgeTakeBack(facts: TakeBackFacts): TakeBackJudged {
  const { order } = facts;
  const live = facts.marks.filter((m) => m.action === LEGACY_CLOSE_ACTION);

  if (order.settlementStatus !== 'SETTLED') {
    return facts.marks[0]?.action === LEGACY_TAKE_BACK_ACTION
      ? refuse('ALREADY_TAKEN_BACK', TAKE_BACK_WHY_AR.alreadyTakenBack(settlementWord(order.settlementStatus)))
      : refuse('NOT_SETTLED', TAKE_BACK_WHY_AR.notSettled(settlementWord(order.settlementStatus)));
  }

  // BY THE CLOSE. The newest row naming the close must be a live mark, and the newest settlement line must be the close's own.
  const mark = facts.marks[0];
  if (!mark || mark.action !== LEGACY_CLOSE_ACTION) return refuse('NOT_BY_LEGACY_CLOSE', TAKE_BACK_WHY_AR.notByLegacy);
  const log = facts.settlementLog[0];
  if (!log || log.newValue !== 'SETTLED' || !log.note || !CLOSE_NOTES.includes(log.note)) {
    return refuse('NOT_BY_LEGACY_CLOSE', live.length > 0 && log ? TAKE_BACK_WHY_AR.changedAfter : TAKE_BACK_WHY_AR.notByLegacy);
  }
  // WHERE IT GOES BACK TO: the state the mark recorded, a state with no money, and the log line says the same.
  if (!isNoMoney(mark.previousStatus) || log.previousValue !== mark.previousStatus) {
    return refuse('NOT_BY_LEGACY_CLOSE', TAKE_BACK_WHY_AR.unknownBefore);
  }

  // MONEY. Anything but the close that ever touched the order's money.
  const money = moneyRefusal(order, facts.money);
  if (money) return refuse(money.code, money.text);

  return { ok: true, plan: { to: mark.previousStatus, markIds: live.map((m) => m.id), logId: log.id } };
}

/** What the screen saw, reduced to a short string the press sends back: the same order in the same state with the same plan. */
export function fingerprintOf(order: Pick<TakeBackOrder, 'id' | 'version' | 'settlementStatus'>, plan: TakeBackPlan): string {
  const canon = { o: order.id, v: order.version, s: order.settlementStatus, t: plan.to, m: [...plan.markIds].sort(), l: plan.logId };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 24);
}

const shippingWord = (s: string): string => (SHIPPING_STATUS_AR as Record<string, string>)[s] ?? s;

/** WHAT THE DIALOG DRAWS: the refusal in words, or every line the press would write and every line it would leave. Pure. */
export function measureTakeBack(facts: TakeBackFacts): TakeBackMeasure {
  const { order } = facts;
  const judged = judgeTakeBack(facts);
  const base = { orderNumber: order.orderNumber, courier: order.courier, from: order.settlementStatus };
  if (!judged.ok) {
    return { ...base, allowed: false, refusal: { code: judged.code, text: judged.text }, fingerprint: null, to: null, lines: [], stays: [] };
  }
  const { plan } = judged;
  const lines: TakeBackLine[] = [
    { key: 'SETTLEMENT', text: TAKE_BACK_LINE_AR.settlement(settlementWord(order.settlementStatus), settlementWord(plan.to)) },
    { key: 'MARK', text: TAKE_BACK_LINE_AR.mark },
  ];
  // Only a delivered parcel has a delivery to take back next.
  if ((LEGACY_DELIVERED as readonly string[]).includes(order.shippingStatus)) lines.push({ key: 'NEXT', text: TAKE_BACK_LINE_AR.next });
  const stays: TakeBackLine[] = [
    { key: 'SHIPPING', text: TAKE_BACK_STAYS_AR.shipping(shippingWord(order.shippingStatus)) },
    { key: 'MONEY', text: TAKE_BACK_STAYS_AR.money },
    { key: 'STOCK', text: TAKE_BACK_STAYS_AR.stock },
    { key: 'COMMISSION', text: TAKE_BACK_STAYS_AR.commission },
    { key: 'HISTORY', text: TAKE_BACK_STAYS_AR.history },
  ];
  return { ...base, allowed: true, refusal: null, fingerprint: fingerprintOf(order, plan), to: plan.to, lines, stays };
}

/* ───────────────────────────── the press ───────────────────────────── */

/** A refusal found inside the transaction: it rolls back and this is the answer. */
export class TakeBackStopped extends Error {
  constructor(
    readonly status: number,
    readonly body: { code: string; error: string }
  ) {
    super(body.code);
  }
}

export interface TakeBackInput {
  scope: TakeBackScope;
  user: { id: string; role: string };
  orderId: string;
  /** Already trimmed, and at least `UNDO_REASON_MIN` long (the door checked). */
  reason: string;
  /** What the dialog saw. */
  fingerprint: string;
}

export interface TakeBackDone {
  plan: TakeBackPlan;
  orderNumber: string;
}

/** The claim's own WHERE: still SETTLED, still this version, still no collected amount — only this order of this store. */
export function claimWhere(scope: TakeBackScope, order: Pick<TakeBackOrder, 'id' | 'version'>): Prisma.OrderWhereInput {
  return {
    id: order.id,
    companyId: scope.companyId,
    storeId: scope.storeId,
    version: order.version,
    settlementStatus: 'SETTLED',
    collectedAmount: null,
  };
}

/**
 * THE PRESS. Runs inside the caller's transaction, and either writes everything or throws and writes nothing.
 *
 *  1. It reads again, here, and refuses unless the order and its plan are exactly what the dialog showed (the fingerprint).
 *  2. It CLAIMS the order with a condition: a collection, an edit, a statement or another press that got there first makes it short.
 *  3. It reads every money trace again, after the claim: one that landed while this waited is visible now, and nothing is written.
 *  4. Only then: the mark renamed, the settlement log line, the activity. No wallet, no amount, no commission, no stock, no counter.
 */
export async function takeBackLegacyClose(tx: Tx, input: TakeBackInput): Promise<TakeBackDone> {
  const { scope, user } = input;

  const facts = await readTakeBackFacts(tx, scope, input.orderId);
  if (!facts) throw new TakeBackStopped(404, { code: 'NOT_FOUND', error: TAKE_BACK_NOT_FOUND_AR });
  const judged = judgeTakeBack(facts);
  if (!judged.ok) throw new TakeBackStopped(409, { code: judged.code, error: judged.text });
  const { plan } = judged;
  const { order } = facts;
  if (fingerprintOf(order, plan) !== input.fingerprint) throw new TakeBackStopped(409, { code: 'CHANGED', error: TAKE_BACK_CHANGED_AR });

  const claimed = await tx.order.updateMany({
    where: claimWhere(scope, order),
    data: { settlementStatus: plan.to, version: { increment: 1 } },
  });
  if (claimed.count !== 1) throw new TakeBackStopped(409, { code: 'ORDERS_CHANGED', error: TAKE_BACK_ORDERS_CHANGED_AR });

  if (moneyRefusal({ hasCollectedAmount: false }, await readMoneyTraces(tx, scope, order.id))) {
    throw new TakeBackStopped(409, { code: 'LATE_MONEY', error: TAKE_BACK_LATE_MONEY_AR });
  }

  // The mark stops counting — renamed, never deleted — and only the marks this plan read: a second press finds none and is refused.
  const renamed = await tx.orderActivity.updateMany({
    where: { companyId: scope.companyId, orderId: order.id, id: { in: plan.markIds }, action: LEGACY_CLOSE_ACTION },
    data: { action: LEGACY_MARK_UNDONE },
  });
  if (renamed.count !== plan.markIds.length) throw new TakeBackStopped(409, { code: 'ORDERS_CHANGED', error: TAKE_BACK_ORDERS_CHANGED_AR });

  const note = `${TAKE_BACK_NOTE_PREFIX}: ${input.reason}`;
  await tx.orderStatusLog.create({
    data: {
      companyId: scope.companyId,
      orderId: order.id,
      statusType: 'SETTLEMENT',
      previousValue: 'SETTLED',
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
      action: LEGACY_TAKE_BACK_ACTION,
      previousStatus: 'SETTLED',
      newStatus: plan.to,
      metadata: JSON.stringify({ reason: input.reason, marks: plan.markIds, renamedTo: LEGACY_MARK_UNDONE, money: 'NONE', stock: 'KEPT' }),
    },
  });

  return { plan, orderNumber: order.orderNumber };
}
