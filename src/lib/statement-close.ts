import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { consumeOrderStock } from './stock-consumption';
import { roundMinor } from './money';
import { explanationOf } from './decision-words';
import { markPayableForOrders } from './commission';
import { paidGross, stillAcceptableWhere, stillSettlableWhere } from './settlement-decisions';
import { proposeShortfalls, type ShortfallCharge } from './shortfall';
import { notify } from './notify';

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
      '. أعد المطابقة، أو غيّر بتّه إلى «قيد المراجعة»، ثم اعتمد.',
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
}

export interface CloseResult {
  deliveredCount: number;
  settledCount: number;
  acceptedCount: number;
  claimCount: number;
  shortfalls: ShortfallCharge[];
  shortfallsOnCompany: number;
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
  const accepted = matches.filter(
    (m) => m.result === 'MISMATCHED' && m.resolution === 'ACCEPTED_COURIER' && m.orderId && !matchedIds.has(m.orderId)
  );
  // The order of the rows is the order of the file; an order two rows name is settled once, by the first.
  const settling = [...matched, ...accepted].filter(
    (m, i, all) => all.findIndex((o) => o.orderId === m.orderId) === i
  );
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
   */
  const claimWheres: Array<{ ids: string[]; where: Prisma.OrderWhereInput }> = [];
  if (cleanIds.length > 0) claimWheres.push({ ids: cleanIds, where: stillSettlableWhere(companyId, cleanIds) });
  if (acceptedIds.length > 0) claimWheres.push({ ids: acceptedIds, where: stillAcceptableWhere(companyId, acceptedIds, zeroLineIds) });
  for (const claim of claimWheres) {
    const taken = await tx.order.updateMany({ where: claim.where, data: { settlementStatus: 'SETTLED' } });
    if (taken.count !== claim.ids.length) throw new OrdersChanged(claim.ids, claim.where);
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
  for (const m of claims) {
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
    claimCount: claims.length,
    shortfalls: shortfall.charges,
    shortfallsOnCompany: shortfall.onCompany.length,
  };
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
