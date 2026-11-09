import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { consumeOrderStock } from './stock-consumption';
import { roundMinor } from './money';
import { explanationOf } from './decision-words';
import { markPayableForOrders } from './commission';
import { paidGross, stillAcceptableWhere, stillSettlableWhere } from './settlement-decisions';
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
    await tx.orderActivity.create({
      data: {
        companyId,
        orderId: m.orderId as string,
        userId,
        action: 'SETTLEMENT_DECISION_APPLIED',
        metadata: JSON.stringify({
          statement: statement.reference,
          decision: 'ACCEPTED_COURIER',
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
 * THE MOST CLEAN ROWS ONE EARLY STEP TAKES IN ONE TRANSACTION.
 *
 * The approval is one transaction with a 30-second budget, and the early step does for each order what the close does — a claim, a
 * delivery, the stock (a dozen queries), the customer, the timeline. A statement of a thousand clean lines would spend that budget
 * and the transaction would time out, taking the MONEY with it: exactly what the brief forbids. So the step takes the first rows of
 * the file up to this number and says how many are left (`remaining`); those are settled by the close as ever, or by the press
 * «سوّي الطلبات النظيفة هلّق», which takes the next of them in its own transaction. A real statement is a hundred or two lines.
 */
export const EARLY_STEP_CAP = 300;

export interface EarlyOutcome {
  /** There were clean rows waiting and the step went through them. */
  ran: boolean;
  /** Orders settled now, and of them the parcels the statement delivered. */
  settled: number;
  delivered: number;
  /** Orders left for the close — nothing was written for them. */
  heldBack: number;
  /** Clean rows beyond `EARLY_STEP_CAP`: not looked at, still waiting. */
  remaining: number;
  /** The step met an error nobody expected: it was undone to the last write and every row waits for the close. */
  failed: boolean;
  /** The error's name only — never its message, which can carry a value. */
  failure: string | null;
  rows: EarlyRow[];
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
 * It runs inside a SAVEPOINT. A changed order is not an error (above). Anything else — a deadlock, a stock write that the
 * database refuses, a bug — is undone to the savepoint and reported (`failed`): the rows stay unmarked, the approval goes on
 * with its money, and the close settles them later as it always would. The approval's money is written BEFORE this runs.
 *
 * The caller holds the statement (the approval's claim, or the lock of the on-demand door) and passes the rows it read INSIDE
 * that transaction, so no door can change a row between the read and the write.
 */
export async function settleCleanLines(
  tx: Tx,
  p: Omit<CloseInput, 'matches' | 'shortfallPeople' | 'early'> & { matches: CloseRow[]; at?: Date }
): Promise<EarlyOutcome> {
  const waiting = cleanPendingRows(p.matches);
  if (waiting.length === 0) return { ran: false, settled: 0, delivered: 0, heldBack: 0, remaining: 0, failed: false, failure: null, rows: [] };
  const clean = waiting.slice(0, EARLY_STEP_CAP);
  const remaining = waiting.length - clean.length;

  await tx.$executeRaw`SAVEPOINT per_line_settlement`;
  try {
    const result = await settleStatement(tx, { ...p, matches: clean, early: { at: p.at ?? new Date() } });

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
    const left = new Set(result.heldBack);
    const rows: EarlyRow[] = clean.map((m) => ({
      matchId: m.id,
      orderId: m.orderId as string,
      orderNumber: m.order?.orderNumber ?? (m.orderId as string),
      outcome: left.has(m.orderId as string) ? 'HELD_BACK' : 'SETTLED',
      why: left.has(m.orderId as string) ? why.get(m.orderId as string) ?? HELD_BACK_WHY.changed : null,
    }));

    await tx.$executeRaw`RELEASE SAVEPOINT per_line_settlement`;
    return { ran: true, settled: result.settledCount, delivered: result.deliveredCount, heldBack: result.heldBack.length, remaining, failed: false, failure: null, rows };
  } catch (e) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT per_line_settlement`;
    // The name and the database's own code only: a message can carry a value, and a log is no place for a customer's.
    const name = e instanceof Error ? e.name : 'Error';
    console.error('[per-line-settlement] the early step was undone; its rows wait for the close:', name, (e as { code?: unknown } | null)?.code ?? '');
    return { ran: true, settled: 0, delivered: 0, heldBack: 0, remaining: waiting.length, failed: true, failure: name, rows: [] };
  }
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
