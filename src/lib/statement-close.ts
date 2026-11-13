import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { consumeOrderStock } from './stock-consumption';
import { roundMinor } from './money';
import { explanationOf } from './decision-words';
import { markPayableForOrders } from './commission';
import { paidGross, stillAcceptableWhere, stillSettlableWhere } from './settlement-decisions';
import { EXCHANGE_APPLIED_ACTION, EXCHANGE_KIND, isExchange } from './settlement-difference';
import { proposeShortfalls, type ShortfallCharge } from './shortfall';
import { notify } from './notify';
import { earlyMessage } from './per-line-settlement-words';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * CLOSING THE MATCHING — WHAT SETTLES THE ORDERS, AND NOTHING THAT MOVES MONEY.
 *
 * «افصل المطابقة عن التحصيل… لما اعتمدو ينزل التحصيل تلقائي ولما يتطابق ما يكرر التحصيل» (the owner, 2/11).
 *
 * The approval posts the money: one wallet IN per receipt, in the statement route, behind its one-winner claim on
 * `approvedAt`. Everything a statement does to ORDERS is here, moved out of that route unchanged, and runs when its
 * matching closes — inside the approval's own transaction when no line is a question (exactly as before the split),
 * or later from «إغلاق المطابقة», behind its own one-winner claim on `matchingClosedAt`.
 *
 * THIS FILE NEVER WRITES A WALLET MOVEMENT. It does not import the wallet writer, and a test reads this file to hold
 * it to that: closing a matching after the money was posted can settle an order, never pay for it a second time.
 *
 * ── «تسوية السطور النظيفة عند الاعتماد» (the owner's switch, OFF by default; 9/11) ──
 *
 * «طلبات بتاخد أسبوع تفسير»: with the switch ON the CLEAN rows of a statement are settled earlier — at the approval, or by the press
 * «سوّي الطلبات النظيفة هلّق» — by `settleCleanLines`, which calls `settleStatement` below on the clean rows with `early` set. The body is
 * the close's own, written once; a settled row is marked `appliedAt`, and the close then leaves those rows (and their orders) alone,
 * so the end of a statement is the same whichever way it went (`the-same-statement-ends-the-same-either-way.test.ts` holds that).
 * It works in slices of a few orders and starts a new one only while the transaction's clock allows (`EARLY_STEP_BUDGET_MS`), so it
 * can never be what runs the approval out of its timeout — the rows it did not reach wait for the press and the close.
 */

/** The in-flight states a matched line promotes to «مُسلَّم» when the matching is closed. */
export const IN_FLIGHT_PROMOTED_BY_STATEMENT = ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY'] as const;

/** A stop inside the transaction: the whole transaction rolls back and this is the answer. */
export class StatementStopped extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.code ?? body.error ?? 'statement stopped'));
  }
}

/**
 * A claim that took fewer orders than it asked for: the close stops and the transaction is rolled back.
 *
 * It carries the claim's own filter and NOT the names. The names are read AFTER the rollback (see the routes): inside
 * the transaction the orders this very claim had already taken are SETTLED too, and a read there would name the
 * orders that were never the problem.
 */
export class OrdersChanged extends Error {
  constructor(readonly ids: string[], readonly where: Prisma.OrderWhereInput) {
    super('ORDERS_CHANGED');
  }
}

/** The answer when an order changed between the matching (or the decision) and the close. */
export function ordersChangedBody(names: string[]) {
  return {
    code: 'ORDERS_CHANGED',
    error:
      'تغيّر وضع طلب أو أكثر منذ المطابقة (سُوّي بباب آخر، أو عليه طلب إلغاء أو تأجيل، أو تغيّرت حالته)' +
      (names.length > 0 ? `: ${names.join('، ')}` : '') +
      '. أعد المطابقة، أو غيّر بتّه إلى «قيد المراجعة»، ثم اعتمد أو اضغط «إغلاق المطابقة».',
    orders: names,
  };
}

/**
 * The match rows the close reads, with what an earlier CLOSED statement already paid on a claim for the order
 * (settlement-decisions). Empty for nearly every order.
 */
export function closeRowsSelect(statementId: string) {
  return {
    id: true, orderId: true, result: true, resolution: true, resolutionNote: true, resolvedById: true,
    // «طلب تبديل» (the qualifier beside «اعتُمد رقم الشركة»): read here, so the close can leave nobody to carry what was never owed.
    resolutionKind: true,
    statementAmount: true, statementFee: true, expectedAmount: true, expectedFee: true,
    // Set only by the early step (per-line settlement): a row that has it was settled at the approval and is not settled again.
    appliedAt: true,
    order: {
      select: {
        orderNumber: true,
        settlementMatches: {
          where: { resolution: 'OURS_STANDS', statementId: { not: statementId }, statement: { matchingClosedAt: { not: null } } },
          select: { statementAmount: true, statementFee: true },
        },
      },
    },
  } satisfies Prisma.SettlementMatchSelect;
}

type Num = Prisma.Decimal | number | string | null;

export interface CloseRow {
  id: string;
  orderId: string | null;
  result: string;
  resolution: string | null;
  /** `EXCHANGE` beside «اعتُمد رقم الشركة» is «طلب تبديل». Absent or null (an older row, any other answer): not an exchange. */
  resolutionKind?: string | null;
  resolutionNote: string | null;
  resolvedById: string | null;
  statementAmount: Num;
  statementFee: Num;
  expectedAmount: Num;
  expectedFee: Num;
  /** The moment the early step settled this row's order (per-line settlement). Absent or null: it did not. */
  appliedAt?: Date | string | null;
  order?: { orderNumber: string; settlementMatches?: { statementAmount: Num; statementFee: Num }[] } | null;
}

export interface CloseInput {
  companyId: string;
  storeId: string;
  /** The person closing — the approver when the approval closes it in the same act. */
  userId: string;
  minorUnit: number;
  statement: { id: string; reference: string; currencyCode: string; createdAt: Date; periodTo: Date | null };
  matches: CloseRow[];
  /** «من يتحمّل الفرق؟» — the person's answers for the short lines the door could not name. */
  shortfallPeople?: Record<string, string>;
  /**
   * THE EARLY STEP — «تسوية السطور النظيفة عند الاعتماد» (see `settleCleanLines` below). Set only by that function, with the clean
   * rows only: the claims are taken order by order and an order that cannot be claimed is left (not an error), and the rows that
   * were settled are marked applied in the same transaction. Absent: the close, exactly as it always was.
   */
  early?: { at: Date };
}

export interface CloseResult {
  deliveredCount: number;
  settledCount: number;
  acceptedCount: number;
  claimCount: number;
  shortfalls: ShortfallCharge[];
  shortfallsOnCompany: number;
  /** Orders this call did NOT settle because an earlier early step already had (their rows carry `appliedAt`). */
  settledEarlier: number;
  /** The early step only: orders whose claim took nothing (settled by another door, a cancel or a postponement asked for). */
  heldBack: string[];
}

/**
 * Settle what this statement settles. Called inside a transaction that already holds the statement (the approval's
 * claim, or the close's), with the rows that transaction read.
 */
export async function settleStatement(tx: Tx, p: CloseInput): Promise<CloseResult> {
  const { companyId, storeId, userId, statement, matches } = p;
  const minorUnit = p.minorUnit;

  /**
   * WHAT THIS CLOSE SETTLES — THE CLEAN ROWS, AND THE ROWS A PERSON ANSWERED «اعتُمد رقم الشركة».
   *
   * Two kinds of row, and no third:
   *
   *   · MATCHED — the courier's figure and ours agree, and nothing else forbids it;
   *   · MISMATCHED and decided ACCEPTED_COURIER, with an explanation, by a person — their figure stands.
   *
   * «رقمنا هو المعتمد» is NOT settled: that order stays PENDING_COLLECTION as a claim on the company, and a
   * later statement's line pays what remains (settlement-decisions). «قيد المراجعة» settles nothing either, nor does
   * an EXCLUDED line (the company wrote zero for a parcel it says came back or waits). An undecided MISMATCHED row
   * settles nothing, as it never did. Nothing else writes SETTLED from a statement, and nothing else writes the
   * amount below.
   */
  const matched = matches.filter((m) => m.result === 'MATCHED' && m.orderId);
  const matchedIds = new Set(matched.map((m) => m.orderId as string));
  /**
   * AN ORDER THE EARLY STEP ALREADY SETTLED IS DONE, AND ITS ROW WITH IT.
   *
   * With «تسوية السطور النظيفة عند الاعتماد» on, the approval settles the clean rows before the matching closes and marks each
   * one applied. This close then leaves them out: a second claim on a settled order would stop it on «تغيّر وضع طلب», and a second
   * promotion would count the stock and the customer out twice. They stay in `matchedIds` above on purpose — an order a clean row
   * holds is never ALSO settled by a decision on another line, exactly as when the clean row was settled here. With no applied row
   * (the switch never on, or a statement approved before it) this set is empty and nothing below changes.
   */
  const appliedIds = new Set(matched.filter((m) => m.appliedAt).map((m) => m.orderId as string));
  const accepted = p.early
    ? []
    : matches.filter(
        (m) => m.result === 'MISMATCHED' && m.resolution === 'ACCEPTED_COURIER' && m.orderId && !matchedIds.has(m.orderId)
      );
  // The order of the rows is the order of the file; an order two rows name is settled once, by the first.
  const settling = [...matched, ...accepted]
    .filter((m, i, all) => all.findIndex((o) => o.orderId === m.orderId) === i)
    .filter((m) => !appliedIds.has(m.orderId as string));
  const settledOrderIds = settling.map((m) => m.orderId as string);
  // An order two accepted rows name (an old statement, answered before the door refused it) is one order.
  const acceptedIds = [...new Set(accepted.filter((m) => settledOrderIds.includes(m.orderId as string)).map((m) => m.orderId as string))];
  // A decision carried out must carry a real reason: one answered before the rule existed, or written around it, stops
  // the close and is named — the person writes it again at the row.
  const unreasoned = settling.filter((m) => acceptedIds.includes(m.orderId as string) && !explanationOf(m.resolutionNote));
  if (unreasoned.length > 0) {
    throw new StatementStopped(409, {
      code: 'DECISION_WITHOUT_REASON',
      error: `بتٌّ بلا تفسير واضح: ${unreasoned.map((m) => m.order?.orderNumber ?? m.orderId).join('، ')}. اكتب التفسير من جديد في سطره ثم اعتمد.`,
      orders: unreasoned.map((m) => m.order?.orderNumber ?? m.orderId),
    });
  }
  const cleanIds = settledOrderIds.filter((oid) => !acceptedIds.includes(oid));
  // A line of zero against a parcel coming back is the only line an order in that state may be accepted at.
  const zeroLineIds = accepted.filter((m) => Number(m.statementAmount) === 0).map((m) => m.orderId as string);

  /**
   * THE ORDERS ARE LOOKED AT AGAIN, AS THE WRITE THAT SETTLES THEM.
   *
   * The rows were matched, and decided, some time before this press — long enough for a hand collection to
   * take the order, for another statement to be closed first (two statements that name one order, matched
   * in the other order, are both clean) or for a cancel to be asked for. The question «is it still ours to
   * settle by this line» is therefore the WHERE of the claim itself (`stillSettlableWhere`), not a read
   * before it: there is no gap for the answer to go stale in. A claim that takes fewer orders than were
   * asked for stops the whole close, rolls back what it wrote and names the orders.
   *
   * THE EARLY STEP ASKS THE SAME QUESTION WITH THE SAME FILTER (`stillSettlableWhere`), ONE ORDER AT A TIME, and an order that
   * fails it is not an error: it is left, untouched and unmarked, for the close — which will report it exactly as it always
   * did. One claim per order is what makes the answer exact (a count over several orders cannot say WHICH one was not taken),
   * and what keeps the approval's money out of it: nothing here throws for a changed order, so nothing here can roll the
   * approval back.
   */
  const heldBack: string[] = [];
  const claimWheres: Array<{ ids: string[]; where: Prisma.OrderWhereInput }> = [];
  if (p.early) {
    // One claim per order: the answer is exact (a count over several orders cannot say WHICH one was not taken).
    for (const oid of cleanIds) claimWheres.push({ ids: [oid], where: stillSettlableWhere(companyId, [oid]) });
  } else if (cleanIds.length > 0) claimWheres.push({ ids: cleanIds, where: stillSettlableWhere(companyId, cleanIds) });
  if (acceptedIds.length > 0) claimWheres.push({ ids: acceptedIds, where: stillAcceptableWhere(companyId, acceptedIds, zeroLineIds) });
  for (const claim of claimWheres) {
    const taken = await tx.order.updateMany({ where: claim.where, data: { settlementStatus: 'SETTLED' } });
    // The early step leaves an order it could not take, untouched and unmarked, for the close to report; the close itself stops.
    if (taken.count !== claim.ids.length && p.early) {
      heldBack.push(...claim.ids);
      continue;
    }
    if (taken.count !== claim.ids.length) throw new OrdersChanged(claim.ids, claim.where);
  }
  if (p.early) {
    // Everything below reads these two lists and must see only the orders this call really took — dropped IN PLACE.
    const held = new Set(heldBack);
    for (let i = settling.length - 1; i >= 0; i--) if (held.has(settling[i].orderId as string)) settling.splice(i, 1);
    for (let i = settledOrderIds.length - 1; i >= 0; i--) if (held.has(settledOrderIds[i])) settledOrderIds.splice(i, 1);
    // THE MARK IS WRITTEN WITH THE CLAIM, in the same transaction, and only for the orders this call really took. Every clean
    // row that names a taken order is marked (an order two lines name has two): the close skips by order, and by row.
    if (settledOrderIds.length > 0) {
      const marked = await tx.settlementMatch.updateMany({
        where: {
          statementId: statement.id, companyId, result: 'MATCHED', appliedAt: null, orderId: { in: settledOrderIds },
          statement: { matchingClosedAt: null },
        },
        data: { appliedAt: p.early.at },
      });
      // An order settled with no row to say so would be settled a second time at the close: that is a stop, not a shrug.
      if (marked.count < settledOrderIds.length) throw new Error('EARLY_MARK_SHORT');
    }
  }

  // Settled orders make their commission payable — not before.
  await markPayableForOrders(tx, companyId, settledOrderIds);

  /**
   * WHAT THE CUSTOMER PAID AT THE DOOR — THE GROSS, NOT THE NET.
   *
   * `Order.collectedAmount` is «what the customer actually paid at the door, and it INCLUDES the full delivery
   * fee». The line's `statementAmount` is the NET (what the courier hands over after keeping their fee), so the
   * gross is `statementAmount + statementFee` — measured on the live rows to equal `StatementLine.collected`
   * exactly. Writing the net made revenue (`SUM(collectedAmount)`, analytics.ts) one fee short per order.
   */
  const amountOf = new Map(
    settling.map((m) => [
      m.orderId as string,
      m.statementAmount == null ? null : Number(m.statementAmount) + Number(m.statementFee ?? 0),
    ])
  );
  /**
   * THE LAST PAYMENT ON A CLAIM CLOSES IT, AND THE ORDER'S AMOUNT IS EVERYTHING PAID.
   *
   * An order answered «رقمنا هو المعتمد» on an earlier closed statement was paid part of its price then (the gross
   * of that row) and is owed the rest. This statement's line pays that rest, so what the customer handed over at the
   * door is the earlier gross PLUS this line's NET. The fee is counted once, in the first payment's gross. An order
   * with no earlier claim row gets exactly the figure above, untouched.
   */
  const collectedOf = (orderId: string): number | null => {
    const base = amountOf.get(orderId);
    if (base == null) return null;
    const row = settling.find((m) => m.orderId === orderId);
    const earlier = paidGross(row?.order?.settlementMatches ?? [], minorUnit);
    return earlier > 0 ? roundMinor(Number(row?.statementAmount ?? 0) + earlier, minorUnit) : base;
  };

  /**
   * ── THE STATEMENT IS THE DELIVERY PROOF, AND THE ONLY SOURCE OF THE MONEY ──
   *
   * The courier has told us, in writing, that they delivered this parcel and collected this amount. The person at
   * the door knows WHAT HAPPENED — who took which line, what came back, why — and the date and status they recorded
   * are theirs and are left alone. They do not know WHAT MONEY ARRIVED, so the door does not write `collectedAmount`
   * at all, and the amount is written here for every settled order that has none yet, whatever its status. An
   * amount already on an order is never overwritten: a correction is made deliberately.
   *
   * A FAILED ATTEMPT IS STILL ON THE ROAD: a parcel the door marked failed, which the courier then delivered and PAID
   * FOR, is delivered here. RETURN_REQUESTED and RETURNED stay out on purpose: those are parcels coming back.
   */
  const inFlight = await tx.order.findMany({
    where: {
      id: { in: settledOrderIds },
      companyId,
      shippingStatus: { in: [...IN_FLIGHT_PROMOTED_BY_STATEMENT] },
    },
    select: { id: true, orderNumber: true, customerId: true },
  });
  // The period's end is when the courier says the money was in, and is closer to the truth than the moment somebody
  // uploaded a file.
  const deliveredAt = statement.periodTo ?? new Date();

  for (const order of inFlight) {
    const collected = collectedOf(order.id);
    await tx.order.update({
      where: { id: order.id },
      data: {
        shippingStatus: 'DELIVERED',
        deliveredAt,
        ...(collected != null ? { collectedAmount: collected } : {}),
        version: { increment: 1 },
      },
    });
    // Delivery is what takes the goods off the shelf for good. The helper refuses to do it twice, so an order
    // delivered by hand and then settled is not counted out of stock again.
    await consumeOrderStock(tx as never, { orderId: order.id, companyId, userId });
    // The customer's own record, for the same reason as the door: a counter only the manual path maintains is a
    // counter that describes the exceptions.
    await tx.customer.update({
      where: { id: order.customerId },
      data: {
        deliveredOrders: { increment: 1 },
        ...(collected != null ? { totalPurchaseValue: { increment: collected } } : {}),
      },
    });
    await tx.orderActivity.create({
      data: {
        companyId,
        orderId: order.id,
        userId,
        action: 'DELIVERED_BY_STATEMENT',
        newStatus: 'DELIVERED',
        metadata: JSON.stringify({ statement: statement.reference, collected: collected ?? null }),
      },
    });
  }

  /**
   * AND THE MONEY FOR THE ONES THE LOOP ABOVE DID NOT TOUCH: an order marked delivered by hand keeps its own status
   * and date, and is given its amount here. After the loop and excluding what the loop wrote, so no order is
   * updated twice and no version is bumped twice for one statement.
   */
  const promoted = new Set(inFlight.map((o) => o.id));
  const awaitingAmount = await tx.order.findMany({
    where: {
      id: { in: settledOrderIds.filter((oid) => !promoted.has(oid)) },
      companyId,
      collectedAmount: null,
    },
    select: { id: true },
  });
  for (const order of awaitingAmount) {
    const collected = collectedOf(order.id);
    if (collected == null) continue;
    await tx.order.update({
      where: { id: order.id },
      data: { collectedAmount: collected, version: { increment: 1 } },
    });
  }

  /**
   * THE SHORTFALL — WHO CARRIES WHAT THE COMPANY PAID LESS.
   *
   * A line answered «اعتُمد رقم الشركة» whose figure came in LOWER than ours is money the company will not send.
   * A PROPOSED «فرق تحصيل» is written here, in the close's own transaction and nowhere else (lib/shortfall). It moves
   * no money. A line the door cannot name stops the close until the person names someone or says «على الشركة».
   */
  const shortfall = await proposeShortfalls(
    tx,
    {
      companyId, storeId, approverId: userId,
      statement: { id: statement.id, reference: statement.reference, currencyCode: statement.currencyCode, importedAt: statement.createdAt },
      fallbackDeliveredAt: deliveredAt,
      minorUnit,
      naming: p.shortfallPeople,
    },
    settling
      .filter((m) => acceptedIds.includes(m.orderId as string))
      .map((m) => ({
        matchId: m.id,
        orderId: m.orderId as string,
        orderNumber: m.order?.orderNumber ?? (m.orderId as string),
        expectedAmount: m.expectedAmount,
        expectedFee: m.expectedFee,
        statementAmount: m.statementAmount,
        statementFee: m.statementFee,
        // An order that an earlier closed statement left as a claim: this line pays the rest of it.
        claimPayment: (m.order?.settlementMatches?.length ?? 0) > 0,
        explanation: explanationOf(m.resolutionNote),
        // «طلب تبديل»: a replacement or a missing piece sent to the customer has no price to collect — nobody carries what was never
        // owed, so the line is no candidate at all: no charge, no «على الشركة», and no question put to the approver (`proposeShortfalls`).
        exchange: isExchange(m),
      }))
  );
  if (shortfall.stop) {
    const body =
      shortfall.stop.code === 'SHORTFALL_UNNAMED'
        ? {
            code: 'SHORTFALL_UNNAMED',
            error:
              'سطور مقبولة برقم الشركة وهو أقل من رقمنا، ولا موظف مسجَّل لتسليمها: ' +
              shortfall.stop.lines.map((l) => l.orderNumber).join('، ') +
              '. سمِّ موظفاً لكل سطر أو اختر «على الشركة» ثم اعتمد.',
            lines: shortfall.stop.lines,
            candidates: shortfall.stop.candidates,
          }
        : {
            code: 'SHORTFALL_BAD_PERSON',
            error: 'اختيار غير مقبول: ' + shortfall.stop.lines.map((l) => `${l.orderNumber} — ${l.why}`).join('؛ '),
            lines: shortfall.stop.lines,
          };
    throw new StatementStopped(409, body);
  }

  /**
   * WHAT THE DECISIONS DID, WRITTEN ON THE ORDERS THEY DID IT TO — in the name of the person closing.
   *
   * A clean row needs no sentence of its own. A row a PERSON answered does: the order's timeline shows which figure
   * stood, why, and who said so — and an order left as a claim on the company shows the claim.
   */
  // `settling` holds one row per order, so an order answered twice gets one sentence.
  for (const m of settling) {
    if (!acceptedIds.includes(m.orderId as string)) continue;
    // «طلب تبديل» is the same settlement said under its own name: the money written above is the plain answer's, to the figure; only the
    // sentence on the timeline differs, so a reader does not take a replacement for a discount. Every other row is written as it always was.
    const exchange = isExchange(m);
    await tx.orderActivity.create({
      data: {
        companyId,
        orderId: m.orderId as string,
        userId,
        action: exchange ? EXCHANGE_APPLIED_ACTION : 'SETTLEMENT_DECISION_APPLIED',
        metadata: JSON.stringify({
          statement: statement.reference,
          decision: 'ACCEPTED_COURIER',
          ...(exchange ? { kind: EXCHANGE_KIND } : {}),
          explanation: m.resolutionNote ?? null,
          decidedBy: m.resolvedById ?? null,
          collected: collectedOf(m.orderId as string),
        }),
      },
    });
  }
  const claims = matches.filter((m) => m.result === 'MISMATCHED' && m.resolution === 'OURS_STANDS' && m.orderId);
  // A claim on the company is opened by the close, never by the early step (which is given the clean rows only).
  for (const m of p.early ? [] : claims) {
    await tx.orderActivity.create({
      data: {
        companyId,
        orderId: m.orderId as string,
        userId,
        action: 'SETTLEMENT_CLAIM_OPENED',
        metadata: JSON.stringify({
          statement: statement.reference,
          remaining: roundMinor(Number(m.expectedAmount ?? 0) - Number(m.statementAmount ?? 0), minorUnit),
          explanation: m.resolutionNote ?? null,
          decidedBy: m.resolvedById ?? null,
        }),
      },
    });
  }

  return {
    deliveredCount: inFlight.length,
    settledCount: settledOrderIds.length,
    acceptedCount: acceptedIds.length,
    claimCount: p.early ? 0 : claims.length,
    shortfalls: shortfall.charges,
    shortfallsOnCompany: shortfall.onCompany.length,
    settledEarlier: appliedIds.size,
    heldBack,
  };
}

/* ─────────────────── THE EARLY STEP — «تسوية السطور النظيفة عند الاعتماد» ─────────────────── */

/** Why an order was left for the close, in the words a person reads on the report. */
export const HELD_BACK_WHY = {
  settled: 'سُوِّي بباب آخر (تحصيل يدوي أو كشف ثاني)',
  openRequest: 'عليه طلب إلغاء أو تأجيل مفتوح',
  changed: 'تغيّرت حالته قبل لحظات',
} as const;

/** One clean row, and what became of its order. */
export interface EarlyRow {
  matchId: string;
  orderId: string;
  orderNumber: string;
  outcome: 'SETTLED' | 'HELD_BACK';
  /** Why the order was left for the close; null when it was settled. */
  why: string | null;
}

/**
 * THE MOST CLEAN ROWS ONE EARLY STEP TAKES IN ONE TRANSACTION — the second, total limit (the first is the clock, below).
 *
 * The early step does for each order what the close does — a claim, a delivery, the stock (a dozen queries), the customer, the
 * timeline. A statement of a thousand clean lines is far more than one transaction should carry, so the step takes the first rows of
 * the file up to this number and says how many are left (`remaining`); those are settled by the close as ever, or by the press
 * «سوّي الطلبات النظيفة هلّق», which takes the next of them in its own transaction. A real statement is a hundred or two lines.
 */
export const EARLY_STEP_CAP = 300;

/**
 * THE EARLY STEP HAS A CLOCK — the money reviewer's RV1830 on the first version of the step.
 *
 * The approval (and the press) is ONE database transaction with a hard timeout. When that runs out every later query of the
 * transaction throws — `ROLLBACK TO SAVEPOINT` included — so a savepoint cannot save it: the WHOLE approval, the money with it, is rolled
 * back and the owner gets a generic error. The cap alone was no protection: an order in flight costs 15 to 23 queries (measured on the
 * real code in a strict world: one, two, three item lines), so the 300 of the cap are 4.5 to 6.9 thousand queries — 5 to 14 seconds at one
 * or two milliseconds a query, and over the timeout from 4.3 to 6.6 milliseconds a query.
 *
 * So the step works in SLICES of `EARLY_STEP_SLICE` orders, each in a savepoint of its own, and STARTS a new slice only while less than
 * `EARLY_STEP_BUDGET_MS` of the transaction has passed — counted from the first line of the transaction (`startedAt`), so the money loop
 * and whatever came before the step are in the count. A slice that has started is never cut short: it is complete, or it is undone. The
 * worst case is therefore the budget + ONE slice + the commit; with 10 s + 25 orders of three item lines (584 queries measured) that stays
 * under the timeout up to about 34 ms a query whatever the alignment of the slices — against the 4 ms at which the step without a clock
 * broke (slices of equal cost live to about 50 ms in the strict world, where one slice alone fills the timeout). What the clock does not
 * reach, it leaves unmarked: the press (or the close) settles it exactly as it settles anything the step did not take.
 */
export const EARLY_STEP_BUDGET_MS = 10_000;
/** Orders in one slice: the unit of work, of atomicity (one savepoint, its marks inside it) and of the clock's check. */
export const EARLY_STEP_SLICE = 25;

/**
 * HOW LONG ONE LOCK WAIT MAY LAST INSIDE A SLICE (the money reviewer's RV1834).
 *
 * The step takes row locks on orders, customers and stock batches. Another door holding the same rows (the bulk «استلم», a hand delivery,
 * the courier's hook, another statement) would make a query WAIT, and the wait is paid out of the transaction's 30 seconds. Inside a slice a
 * wait longer than this is an error of the slice — undone to its savepoint, absorbed, the rest left for the press — instead of an approval
 * that dies. It is set with `set_config(…, true)`, the parameterised form of `SET LOCAL`, AFTER the slice's savepoint and put back BEFORE its
 * release: a failed slice takes the setting down with it (Postgres undoes a setting made after a savepoint when it rolls back to it), a
 * released one has already been given back its value, so nothing of it reaches the rest of the transaction. And only when the lock
 * timeout is off ('0') to begin with: a limit somebody set on purpose is never loosened or replaced.
 */
export const EARLY_STEP_LOCK_WAIT = '3s';

export interface EarlyOutcome {
  /** There were clean rows waiting and the step went through them. */
  ran: boolean;
  /** Orders settled now, and of them the parcels the statement delivered. */
  settled: number;
  delivered: number;
  /** Orders left for the close — nothing was written for them. */
  heldBack: number;
  /** Clean rows not taken now: beyond `EARLY_STEP_CAP`, or not reached because the clock (or a failed slice) stopped the step. Still waiting. */
  remaining: number;
  /** The step met an error nobody expected: the slice it was in was undone to its savepoint and its rows (and those after it) wait for the close. */
  failed: boolean;
  /** The error's name only — never its message, which can carry a value. */
  failure: string | null;
  rows: EarlyRow[];
  /** Present (true) only when the step stopped because its share of the transaction's time was spent; the rows it did not reach wait. */
  stoppedForTime?: boolean;
}

/** The clock the early step reads — the transaction's start and `now`. Both are optional: a direct call times itself from its own start. */
export interface EarlyStepClock {
  /** `Date.now()` taken at the FIRST line of the transaction that carries the step. Absent: the moment the step itself began. */
  startedAt?: number;
  /** The clock; `Date.now` unless a test drives its own. */
  now?: () => number;
}

/** The rows the early step is for: clean (a figure on both sides agrees), with an order, and not settled early already. */
export function cleanPendingRows<T extends CloseRow>(matches: T[]): T[] {
  return matches.filter((m) => m.result === 'MATCHED' && !!m.orderId && !m.appliedAt);
}

/**
 * What the approval's answer and its audit row say of the early step: the counts, and the orders left for the close with the
 * reason — never the whole list of the settled ones, which can be a thousand.
 */
export function earlyAnswer(e: EarlyOutcome) {
  return {
    ran: e.ran,
    settled: e.settled,
    delivered: e.delivered,
    // One entry per ORDER (an order two lines name has two rows, and one reason).
    heldBack: e.rows
      .filter((r) => r.outcome === 'HELD_BACK')
      .filter((r, i, all) => all.findIndex((o) => o.orderId === r.orderId) === i)
      .map((r) => ({ orderNumber: r.orderNumber, why: r.why })),
    failed: e.failed,
    ...(e.remaining > 0 ? { remaining: e.remaining } : {}),
    ...(e.failed ? { failure: e.failure } : {}),
    // Said only when it happened: the step ran out of its share of the transaction's time, and the rest waits for the press.
    ...(e.stoppedForTime ? { stoppedForTime: true } : {}),
    // The one sentence the screen shows after the press (empty when there was nothing to say).
    message: earlyMessage(e),
  };
}

/**
 * SETTLE THE CLEAN LINES NOW — and leave every line that is still a question, and its order, for the close.
 *
 * «طلبات بتاخد أسبوع تفسير» (the owner, 9/11): one line that needs a week of explanation held every order of the statement,
 * although the money had arrived at the approval and never waited on a line. This settles the CLEAN rows — `MATCHED`, with an
 * order, not applied yet — and nothing else: a figure accepted from the company, a claim kept, a line parked or excluded all wait
 * for the close, because they carry the shortfall naming and the explanations that can stop a close.
 *
 * ── IT IS THE CLOSE'S OWN BODY, NOT A SECOND COPY ──
 *
 * It calls `settleStatement` on the clean rows with `early` set. The claim, the promotion to «مُسلَّم», the stock, the customer's
 * counters, the commission and the timeline are the lines above, written once. The two differences are exactly two: a claim
 * that takes nothing is left instead of stopping, and a settled row is marked `appliedAt` in the same transaction.
 *
 * ── IT CAN NEVER STOP THE APPROVAL ──
 *
 * Every slice runs inside a SAVEPOINT of its own. A changed order is not an error (above). Anything else — a deadlock, a stock write
 * that the database refuses, a lock that was waited for too long, a bug — undoes THAT SLICE to its savepoint and is reported (`failed`):
 * the slices before it stay applied (each is complete, and its marks were written inside it, in the same breath as its settlements), the
 * slices after it are not started, and the rows of all of them stay unmarked for the press and the close, which settle them as they
 * settle anything the step did not take. The approval goes on with its money, which was written BEFORE this runs.
 *
 * And it can never SPEND the approval: it starts a slice only while the transaction's clock (`EARLY_STEP_BUDGET_MS`, counted from
 * `startedAt`) says there is time, and says so on the outcome (`stoppedForTime`) when it stopped for that. See `EARLY_STEP_BUDGET_MS`.
 *
 * The caller holds the statement (the approval's claim, or the lock of the on-demand door) and passes the rows it read INSIDE
 * that transaction, so no door can change a row between the read and the write.
 */
export async function settleCleanLines(
  tx: Tx,
  p: Omit<CloseInput, 'matches' | 'shortfallPeople' | 'early'> & EarlyStepClock & { matches: CloseRow[]; at?: Date }
): Promise<EarlyOutcome> {
  const waiting = cleanPendingRows(p.matches);
  if (waiting.length === 0) return { ran: false, settled: 0, delivered: 0, heldBack: 0, remaining: 0, failed: false, failure: null, rows: [] };
  const clean = waiting.slice(0, EARLY_STEP_CAP);

  // THE CLOCK. A time that cannot be read, or a start that is not a time, says the time is up: it never lets the step run unwatched.
  const clock = p.now ?? Date.now;
  const startedAt = p.startedAt ?? clock();
  const spent = (): number => {
    const t = clock();
    return Number.isFinite(t) && Number.isFinite(startedAt) ? t - startedAt : Number.POSITIVE_INFINITY;
  };

  // The orders of the clean rows in the order of the file. A slice is the next EARLY_STEP_SLICE of them with EVERY row that names them,
  // so an order two lines name travels whole — a later slice never meets a row of an order an earlier slice already settled.
  const orderIds = [...new Set(clean.map((m) => m.orderId as string))];
  const at = p.at ?? new Date();
  const input = { companyId: p.companyId, storeId: p.storeId, userId: p.userId, minorUnit: p.minorUnit, statement: p.statement };

  let settled = 0;
  let delivered = 0;
  /** The orders of the slices that went through, and of them those the claim could not take (with the reason). */
  const reached = new Set<string>();
  const heldBack = new Map<string, string>();
  let failed = false;
  let failure: string | null = null;
  let stoppedForTime = false;
  let limitLockWait: boolean | undefined;

  for (let from = 0; from < orderIds.length; from += EARLY_STEP_SLICE) {
    // The ONE place the clock decides: before a slice starts, never inside it.
    if (!(spent() < EARLY_STEP_BUDGET_MS)) {
      stoppedForTime = true;
      break;
    }
    const these = new Set(orderIds.slice(from, from + EARLY_STEP_SLICE));
    const rows = clean.filter((m) => these.has(m.orderId as string));

    await tx.$executeRaw`SAVEPOINT per_line_settlement`;
    try {
      // (Asked once, inside the first savepoint: a failure of the question is a failure of the slice, like any other.)
      if (limitLockWait === undefined) limitLockWait = await lockTimeoutIsOff(tx);
      if (limitLockWait) await setLockTimeout(tx, EARLY_STEP_LOCK_WAIT);

      const result = await settleStatement(tx, { ...input, matches: rows, early: { at } });

      // Why each left order was left: asked of the orders as they are NOW, after the claims, which only ever touched the others.
      const why = new Map<string, string>();
      if (result.heldBack.length > 0) {
        // (The statement's own store: an order of another store is not one this statement can be about.)
        const left = await tx.order.findMany({
          where: { id: { in: result.heldBack }, companyId: p.companyId, storeId: p.storeId },
          select: { id: true, settlementStatus: true },
        });
        for (const o of Array.isArray(left) ? left : []) {
          why.set(o.id, o.settlementStatus === 'SETTLED' ? HELD_BACK_WHY.settled : HELD_BACK_WHY.openRequest);
        }
      }

      // Given back BEFORE the release: a setting made inside a savepoint outlives its release, so it is put right while it is still inside.
      if (limitLockWait) await setLockTimeout(tx, LOCK_TIMEOUT_OFF);
      await tx.$executeRaw`RELEASE SAVEPOINT per_line_settlement`;

      // Counted only now that the savepoint is released: a slice that did not get here is undone, and counts for nothing.
      settled += result.settledCount;
      delivered += result.deliveredCount;
      for (const id of these) reached.add(id);
      for (const id of result.heldBack) heldBack.set(id, why.get(id) ?? HELD_BACK_WHY.changed);
    } catch (e) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT per_line_settlement`;
      // The name and the database's own code only: a message can carry a value, and a log is no place for a customer's.
      failure = e instanceof Error ? e.name : 'Error';
      console.error('[per-line-settlement] a slice of the early step was undone; its rows and the ones after it wait for the close:', failure, (e as { code?: unknown } | null)?.code ?? '');
      failed = true;
      break;
    }
  }

  // The per-row report, in the order of the file: the rows of the slices that went through (a row that was not reached is not on it).
  const rows: EarlyRow[] = clean
    .filter((m) => reached.has(m.orderId as string))
    .map((m) => ({
      matchId: m.id,
      orderId: m.orderId as string,
      orderNumber: m.order?.orderNumber ?? (m.orderId as string),
      outcome: heldBack.has(m.orderId as string) ? 'HELD_BACK' : 'SETTLED',
      why: heldBack.get(m.orderId as string) ?? null,
    }));
  return {
    ran: true, settled, delivered, heldBack: heldBack.size,
    // Beyond the cap, plus the rows of the slices that were not reached (the clock stopped the step, or a slice failed).
    remaining: waiting.length - rows.length,
    failed, failure, rows,
    ...(stoppedForTime ? { stoppedForTime: true } : {}),
  };
}

/** The database's lock timeout as it stands when it is OFF: a wait for a lock has no end. */
const LOCK_TIMEOUT_OFF = '0';

/** Is the lock timeout off for this transaction? Anything else — a limit somebody set on purpose, or no answer — is left exactly as it is. */
async function lockTimeoutIsOff(tx: Tx): Promise<boolean> {
  const answer = await tx.$queryRaw<{ value?: unknown }[]>`SELECT current_setting('lock_timeout') AS "value"`;
  return Array.isArray(answer) && answer[0]?.value === LOCK_TIMEOUT_OFF;
}

/** `SET LOCAL lock_timeout`, in its parameterised form (a `SET` cannot take a parameter; this function can): gone with the transaction. */
async function setLockTimeout(tx: Tx, value: string): Promise<void> {
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${value}, true)`;
}

/** Each employee hears of a «فرق تحصيل» once the close is committed — never from a transaction that might roll back. */
export function tellShortfalls(p: { companyId: string; storeId: string; actorId: string; reference: string; charges: ShortfallCharge[] }) {
  for (const c of p.charges) {
    notify({
      companyId: p.companyId,
      storeId: p.storeId,
      audience: { userIds: [c.userId] },
      actorId: p.actorId,
      title: 'فرق تحصيل عليك — بانتظار القرار',
      message: `طلب ${c.orderNumber} · كشف ${p.reference}: دفعت الشركة أقل من المتوقَّع بمقدار ${c.amount} ${c.currencyCode}. إن كان عندك تفسير فاحكِ مع المحاسب أو المالك.`,
      type: 'SYSTEM_ALERT',
      link: '/control/penalties',
    });
  }
}

/**
 * WAS THIS STATEMENT APPROVED BEFORE THE SPLIT — by the old code, which settled its orders in the same act?
 *
 * The migration marks every such statement closed. One approved by the old container while the Redeploy was swapping
 * in the new one is the only kind it can miss, and it is recognisable without asking anybody: the new approval writes
 * the receipt on every movement it posts (`statementReceiptId`), the old one never did. So a statement whose money
 * was posted by movements that name no receipt had its matching closed with it, and «إغلاق المطابقة» only stamps it —
 * its orders are already settled, and settling them again would stop on «تغيّر وضع طلب».
 */
export async function approvedBeforeTheSplit(tx: Tx, p: { companyId: string; statementId: string }): Promise<boolean> {
  const base = { companyId: p.companyId, referenceType: 'STATEMENT', referenceId: p.statementId, reversalOfId: null };
  const [withReceipt, withoutReceipt] = await Promise.all([
    tx.walletMovement.count({ where: { ...base, statementReceiptId: { not: null } } }),
    tx.walletMovement.count({ where: { ...base, statementReceiptId: null } }),
  ]);
  return withReceipt === 0 && withoutReceipt > 0;
}
