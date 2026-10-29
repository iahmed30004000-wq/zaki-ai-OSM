import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { consumeOrderStock } from '@/lib/stock-consumption';
import { receiptGap } from '@/lib/settlement';
import { COURIER_OUTCOME_AR, readCourierWord } from '@/lib/courier-words';
import { OUTCOME_LABEL_AR, orderOutcome } from '@/lib/order-outcome';
import { isNotMentioned } from '@/lib/settlement-difference';
import { NOT_MENTIONED_ACTIVITY } from '@/lib/not-mentioned';
import { approvalRefusal, isApproved, undoImportRefusal } from '@/lib/settlement-gates';
import { recordMovement } from '@/lib/wallets';
import { markPayableForOrders } from '@/lib/commission';
import { zodMessage } from '@/lib/zod-message';
import { removeProofFile } from '@/lib/settlement-proof';
import { POSSIBLE_DOUBLE_SENTENCE, findPossibleDoubles, handWindowStart, type HandMovement } from '@/lib/possible-double';

/**
 * One statement.
 *
 *   GET   /api/finance/statements/:id     lines, receipts, gap, match queues
 *   PATCH /api/finance/statements/:id     { gapExplanation } | { approve: true }
 *
 * APPROVAL is the gate the whole contract hangs on: no fund movement exists
 * before it, and commission becomes payable only after it. Approving with an
 * unexplained gap between what the courier claimed and what arrived is
 * refused.
 */

const patchSchema = z.object({
  gapExplanation: z.string().trim().min(5).max(500).optional(),
  approve: z.boolean().optional(),
  /**
   * The person has seen the hand-entered rows that look like the same money and says they are not
   * (or has decided to keep both). Never sent by a screen on its own: only by «اعتمد هيك».
   */
  confirmPossibleDouble: z.boolean().optional(),
});

/** The in-flight states a matched line promotes to «مُسلَّم» when the statement is approved. */
const IN_FLIGHT_PROMOTED_BY_STATEMENT = ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY'] as const;

/** A stop inside the approval transaction: the whole transaction rolls back and this is the answer. */
class ApprovalStopped extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.code ?? body.error ?? 'approval stopped'));
  }
}

/** Hand entries that look like the same money as a receipt — shown to the person before anything is written. */
class PossibleDouble extends Error {
  constructor(readonly rows: (HandMovement & { wallet: string; currencyCode: string })[]) {
    super('POSSIBLE_DOUBLE');
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.view');

    const statement = await db.courierStatement.findFirst({
      where: { id, companyId, storeId },
      include: {
        lines: { orderBy: { createdAt: 'asc' }, take: 1000 },
        receipts: { include: { wallet: { select: { id: true, name: true, currencyCode: true } } } },
        matches: {
          include: {
            order: {
              select: {
                id: true, orderNumber: true, merchantRef: true, shippingStatus: true,
                // What the order's own outcome word is read from (order-outcome.ts): never stored, always read.
                confirmationStatus: true, settlementStatus: true, rejectionReason: true,
                returnReceipt: { select: { courierFeeCharged: true, receivedQty: true, damagedQty: true, missingQty: true } },
              },
            },
            // The status word and the whole row as the company wrote it: its own reason, in its own words.
            statementLine: { select: { merchantRef: true, barcode: true, amount: true, status: true, rawRow: true } },
          },
        },
      },
    });
    if (!statement) return NextResponse.json({ error: 'الكشف غير موجود' }, { status: 404 });

    const gap = await receiptGap(db, id, country.minorUnit);

    /*
     * WHAT EACH ROW SAYS ABOUT ITSELF, READ ONCE HERE SO THE SCREEN ONLY SHOWS IT.
     *
     * · `courierWord` — the company's status cell through the ONE phrase table (`courier-words`), the same
     *   reading the import and the matching use. Null when the cell is empty.
     * · `orderOutcome` — the order's own outcome word (`order-outcome`), for the group of parcels no
     *   statement names: «تم التسليم — بانتظار التحصيل», «مغلق», … never a second vocabulary.
     * · `followUp` — the last thing a person recorded on that order about it being unmentioned.
     */
    const missingOrderIds = statement.matches.filter((m) => isNotMentioned(m) && m.orderId).map((m) => m.orderId as string);
    const followUps = new Map<string, { action: string; at: Date }>();
    if (missingOrderIds.length > 0) {
      const acts = await db.orderActivity.findMany({
        where: {
          companyId,
          orderId: { in: missingOrderIds },
          action: { in: Object.values(NOT_MENTIONED_ACTIVITY) },
        },
        orderBy: { createdAt: 'desc' },
        select: { orderId: true, action: true, createdAt: true },
      });
      for (const a of acts) if (!followUps.has(a.orderId)) followUps.set(a.orderId, { action: a.action, at: a.createdAt });
    }
    const matches = statement.matches.map((m) => {
      const reading = readCourierWord(m.statementLine?.status);
      let outcome: { key: string; label: string } | null = null;
      if (m.order) {
        const key = orderOutcome({
          confirmationStatus: m.order.confirmationStatus,
          shippingStatus: m.order.shippingStatus,
          settlementStatus: m.order.settlementStatus,
          rejectionReason: m.order.rejectionReason,
          returnReceipt: m.order.returnReceipt,
        });
        outcome = { key, label: OUTCOME_LABEL_AR[key] };
      }
      return {
        ...m,
        courierWord: reading ? { ...reading, label: COURIER_OUTCOME_AR[reading.outcome] } : null,
        orderOutcome: outcome,
        followUp: m.orderId ? followUps.get(m.orderId) ?? null : null,
      };
    });
    const queues = {
      matched: matches.filter((m) => m.result === 'MATCHED'),
      mismatched: matches.filter((m) => m.result === 'MISMATCHED'),
      missing: matches.filter((m) => m.result.startsWith('MISSING')),
    };

    return NextResponse.json({ statement: { ...statement, matches }, gap, queues });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.review');

    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const statement = await db.courierStatement.findFirst({
      where: { id, companyId, storeId },
      // `statementFee` joins them because the money written onto the order is
      // the GROSS the customer paid — the net plus the fee the courier kept.
      include: {
        receipts: true,
        matches: { select: { orderId: true, result: true, statementAmount: true, statementFee: true } },
      },
    });
    if (!statement) return NextResponse.json({ error: 'الكشف غير موجود' }, { status: 404 });
    // Read from the stamp of the act, not from `status`: a re-match used to
    // write MATCHED over APPROVED, and this gate then let the money through
    // a second time. See lib/settlement-gates.
    if (isApproved(statement)) {
      return NextResponse.json({ error: 'الكشف معتمد مسبقاً', code: 'ALREADY_APPROVED' }, { status: 409 });
    }

    if (parsed.data.gapExplanation && !parsed.data.approve) {
      const updated = await db.courierStatement.update({
        where: { id },
        data: { gapExplanation: parsed.data.gapExplanation },
      });
      await logAudit({
        companyId, userId: user.id, action: 'STATEMENT_GAP_EXPLAINED',
        entity: 'CourierStatement', entityId: id, newData: { explanation: parsed.data.gapExplanation },
      });
      return NextResponse.json({ statement: updated });
    }

    if (!parsed.data.approve) return NextResponse.json({ error: 'لا يوجد إجراء' }, { status: 400 });

    // ── Approval gates ──
    // One rule, in lib/settlement-gates, read here and by the screen that
    // greys the button out — so the sentence on the disabled button is the
    // sentence the server would have answered with.
    const gap = await receiptGap(db, id, country.minorUnit);
    const explanation = parsed.data.gapExplanation ?? statement.gapExplanation;
    const refusal = approvalRefusal({
      status: statement.status,
      approvedAt: statement.approvedAt,
      receipts: statement.receipts.length,
      matches: statement.matches.length,
      gap,
      explanation,
    });
    if (refusal) return NextResponse.json({ ...refusal, gap }, { status: 409 });

    const approvedAt = new Date();
    // The hand rows the person has just said are NOT the same money — kept for the audit row.
    let confirmedDoubles: string[] = [];

    let approved;
    try {
      approved = await db.$transaction(async (tx) => {
      /**
       * ONE APPROVAL, HOWEVER MANY PRESSES.
       *
       * `isApproved` above is read OUTSIDE this transaction, so two presses (or one retry) in flight both pass
       * it. The stamp is therefore taken here as a conditional write — only a row that is still unapproved is
       * claimed — and exactly one claim can win: the second waits on the row, re-reads it as approved, finds
       * count 0 and rolls the whole transaction back before a single movement is written.
       *
       * The claim comes FIRST, and what the money is built from is read AFTER it: a receipt racing this
       * approval either landed before the claim (and is read here) or is refused by its own conditional write.
       */
      const claimed = await tx.courierStatement.updateMany({
        where: { id, companyId, approvedAt: null, status: { not: 'APPROVED' } },
        data: {
          status: 'APPROVED',
          approvedById: user.id,
          approvedAt,
          gapExplanation: explanation ?? null,
        },
      });
      if (claimed.count !== 1) {
        throw new ApprovalStopped(409, { error: 'الكشف معتمد مسبقاً', code: 'ALREADY_APPROVED' });
      }

      const inside = await tx.courierStatement.findFirst({
        where: { id, companyId, storeId },
        include: {
          receipts: true,
          matches: { select: { orderId: true, result: true, statementAmount: true, statementFee: true } },
        },
      });
      if (!inside) throw new ApprovalStopped(404, { error: 'الكشف غير موجود' });
      const { receipts, matches, ...row } = inside;

      // The gates once more, on what this transaction itself read: a receipt deleted a moment ago must not
      // leave an approval standing on a receipt that is no longer there.
      const gapInside = await receiptGap(tx, id, country.minorUnit);
      const refusedInside = approvalRefusal({
        status: statement.status,
        approvedAt: null,
        receipts: receipts.length,
        matches: matches.length,
        gap: gapInside,
        explanation,
      });
      if (refusedInside) throw new ApprovalStopped(409, { ...refusedInside, gap: gapInside });

      /**
       * A HAND ENTRY OF THE SAME MONEY.
       *
       * The wallet below gets one IN per receipt. If a person already typed that collection in by hand, it is
       * about to be there twice — so the approval stops, shows the rows, and goes on only when the request
       * carries `confirmPossibleDouble`. Hand-entered = no reference (the statement, a hand collection, a
       * transfer, a payout and a payslip all carry one); a reversed row, and a reversal, never count.
       */
      const handRows = await tx.walletMovement.findMany({
        where: {
          companyId,
          walletId: { in: [...new Set(receipts.map((r) => r.walletId))] },
          direction: 'IN',
          referenceType: null,
          reversalOfId: null,
          reversedBy: null,
          createdAt: { gte: handWindowStart(approvedAt) },
        },
        select: {
          id: true, walletId: true, amount: true, party: true, note: true, createdAt: true, createdById: true,
          wallet: { select: { name: true, currencyCode: true, country: { select: { minorUnit: true } } } },
        },
      });
      const doubles = findPossibleDoubles(
        receipts.map((r) => ({ walletId: r.walletId, amount: Number(r.amount) })),
        handRows.map((m) => ({
          id: m.id, walletId: m.walletId, amount: Number(m.amount), minorUnit: m.wallet.country.minorUnit,
          party: m.party, note: m.note, createdAt: m.createdAt, createdById: m.createdById,
        })),
        approvedAt
      );
      if (doubles.length > 0 && !parsed.data.confirmPossibleDouble) {
        throw new PossibleDouble(
          doubles.map((d) => {
            const wallet = handRows.find((m) => m.id === d.id)!.wallet;
            return { ...d, wallet: wallet.name, currencyCode: wallet.currencyCode };
          })
        );
      }
      confirmedDoubles = doubles.map((d) => d.id);

      // The money moves HERE and nowhere earlier: one wallet movement per
      // receipt, each carrying the wallet it actually landed in.
      for (const receipt of receipts) {
        await recordMovement(tx, {
          companyId,
          walletId: receipt.walletId,
          direction: 'IN',
          amount: Number(receipt.amount),
          party: `تحصيل شركة الشحن — ${statement.reference}`,
          category: 'COURIER_SETTLEMENT',
          note: `اعتماد كشف ${statement.reference}`,
          referenceType: 'STATEMENT',
          referenceId: statement.id,
          createdById: user.id,
        });
      }

      // Settled orders make their commission payable — not before.
      const matched = matches.filter((m) => m.result === 'MATCHED' && m.orderId);
      const settledOrderIds = matched.map((m) => m.orderId as string);
      await markPayableForOrders(tx, companyId, settledOrderIds);
      if (settledOrderIds.length > 0) {
        await tx.order.updateMany({
          where: { id: { in: settledOrderIds }, companyId },
          data: { settlementStatus: 'SETTLED' },
        });
      }

      /**
       * WHAT THE CUSTOMER PAID AT THE DOOR — THE GROSS, NOT THE NET.
       *
       * This wrote `statementAmount`, which `schema.prisma:2304` defines as
       * «the NET: what the courier hands over after keeping their fee». And
       * `Order.collectedAmount` is documented one table over as «what the
       * customer actually paid at the door, and it INCLUDES the full delivery
       * fee». So the column was documented gross and written net, by its only
       * writer, and two readers then had it wrong in two different ways:
       *
       *   `expectedAmountFor` does `collected − fee`, so a settled order's
       *   expectation came out one fee SHORT of the truth — measured on this
       *   database at 2.5 on each of twelve orders.
       *
       *   And revenue is `SUM(collectedAmount)` for orders that have one PLUS
       *   `SUM(totalAmount)` for orders that do not (`analytics.ts:257-263`,
       *   `attribution-performance.ts:113-122`). `totalAmount` is gross, so
       *   the two halves of one sum were measured in different units: twelve
       *   orders at 231.00 where the gross is 261.000. **Thirty dinars of
       *   revenue that nobody spent.**
       *
       * The gross is `statementAmount + statementFee`, and it is not a guess:
       * on all twelve live rows it equals `StatementLine.collected` exactly,
       * and `statementFee` is null on none of them.
       */
      const amountOf = new Map(
        matched.map((m) => [
          m.orderId as string,
          m.statementAmount == null ? null : Number(m.statementAmount) + Number(m.statementFee ?? 0),
        ])
      );

      /**
       * ── THE STATEMENT IS THE DELIVERY PROOF, AND THE ONLY SOURCE OF THE MONEY ──
       *
       * The courier has told us, in writing, that they delivered this parcel
       * and collected this amount. Reading that and then asking somebody to
       * tick "delivered" by hand is the same fact entered twice — and every
       * order nobody got round to ticking sat in the tracking list forever,
       * long after the money had arrived.
       *
       * WHAT CHANGED, AND WHY. This file used to say that an order already
       * marked delivered «keeps its own date and amount, because whoever
       * stood there and recorded it knew more than a spreadsheet does». Half
       * of that is true and half of it was a hole.
       *
       * The true half: the person at the door knows WHAT HAPPENED — who took
       * which line, what came back, why. No statement carries that, and the
       * date and status they recorded are still theirs and are left alone.
       *
       * The hole: they do not know WHAT MONEY ARRIVED. A follow-up agent is
       * repeating what a courier said on the phone. And because only in-flight
       * orders were touched here, the figure she typed was never once compared
       * with the courier's own — recording a delivery did not anticipate the
       * reconciliation, it removed the order from it.
       *
       * So the door no longer writes `collectedAmount` at all, and the amount
       * is written here for EVERY matched order that has none yet, whatever
       * its status. An amount already on an order is never overwritten: a
       * correction is a correction, made deliberately, not a side effect of
       * re-importing a file.
       */

      /*
       * A FAILED ATTEMPT IS STILL ON THE ROAD.
       *
       * FAILED_DELIVERY was missing from this list, so a parcel the door had marked failed — the customer was out,
       * the courier came back the next day — and which the courier then delivered and PAID FOR, was settled and
       * paid commission but stayed «فشل التوصيل» for ever: never delivered, never counted out of stock, never
       * in the customer's record. A line that matched at the amount actually collected is the proof it arrived.
       * RETURN_REQUESTED and RETURNED stay out on purpose: those are parcels coming back, and a statement line
       * at zero is what they should read.
       */
      const inFlight = await tx.order.findMany({
        where: {
          id: { in: settledOrderIds },
          companyId,
          shippingStatus: { in: [...IN_FLIGHT_PROMOTED_BY_STATEMENT] },
        },
        select: { id: true, orderNumber: true, customerId: true },
      });
      // The period's end is when the courier says the money was in, and is
      // closer to the truth than the moment somebody uploaded a file.
      const deliveredAt = statement.periodTo ?? new Date();

      for (const order of inFlight) {
        const collected = amountOf.get(order.id);
        await tx.order.update({
          where: { id: order.id },
          data: {
            shippingStatus: 'DELIVERED',
            deliveredAt,
            ...(collected != null ? { collectedAmount: collected } : {}),
            version: { increment: 1 },
          },
        });
        // Delivery is what takes the goods off the shelf for good. The
        // helper refuses to do it twice, so an order delivered by hand and
        // then settled is not counted out of stock again.
        await consumeOrderStock(tx as never, {
          orderId: order.id,
          companyId,
          allowNegativeStock: true,
          userId: user.id,
        });
        /**
         * The customer's own record, for the same reason as the door: this
         * is how an order completes when nobody ticked anything by hand,
         * and a counter only the manual path maintains is a counter that
         * describes the exceptions.
         */
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
            userId: user.id,
            action: 'DELIVERED_BY_STATEMENT',
            newStatus: 'DELIVERED',
            metadata: JSON.stringify({
              statement: statement.reference,
              collected: collected ?? null,
            }),
          },
        });
      }

      /**
       * AND THE MONEY FOR THE ONES THE LOOP ABOVE DID NOT TOUCH.
       *
       * An order marked delivered by hand keeps its own status and date —
       * the person at the door knew what happened — but it was never given
       * an amount by anybody, because the door no longer writes one and this
       * sweep used to skip it. Its `collectedAmount` stayed null for ever.
       *
       * After the loop and excluding what the loop wrote, so no order is
       * updated twice and no version is bumped twice for one statement.
       * An amount already present is never overwritten: a correction is made
       * deliberately, not as a side effect of re-importing a file.
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
        const collected = amountOf.get(order.id);
        if (collected == null) continue;
        await tx.order.update({
          where: { id: order.id },
          data: { collectedAmount: collected, version: { increment: 1 } },
        });
      }

      return { row, deliveredCount: inFlight.length, receiptCount: receipts.length };
      }, { timeout: 30_000 });
    } catch (e) {
      if (e instanceof ApprovalStopped) return NextResponse.json(e.body, { status: e.status });
      if (e instanceof PossibleDouble) {
        const actorIds = [...new Set(e.rows.map((r) => r.createdById))];
        const actors = await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
        const nameOf = new Map(actors.map((a) => [a.id, a.name]));
        return NextResponse.json(
          {
            code: 'POSSIBLE_DOUBLE',
            error: POSSIBLE_DOUBLE_SENTENCE,
            rows: e.rows.map((r) => ({
              id: r.id, wallet: r.wallet, currencyCode: r.currencyCode, date: r.createdAt, amount: r.amount,
              party: r.party, note: r.note, by: nameOf.get(r.createdById) ?? null,
            })),
          },
          { status: 409 }
        );
      }
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_APPROVED',
      entity: 'CourierStatement', entityId: id,
      newData: {
        gap: gap.gap, explanation: explanation ?? null, receipts: approved.receiptCount,
        // Said by the person, on the screen: the hand rows listed were NOT the same money. Written here so
        // the approval itself carries the answer.
        ...(confirmedDoubles.length > 0 ? { confirmedPossibleDouble: true, handRows: confirmedDoubles } : {}),
      },
    });

    return NextResponse.json({
      statement: approved.row,
      gap,
      // How many the statement itself closed, so the screen can say it
      // rather than leaving somebody to notice the tracking list shrank.
      deliveredByStatement: approved.deliveredCount,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * DELETE /api/finance/statements/:id — take back a wrong import, at any step until it is approved.
 *
 * Before approval nothing financial exists: the lines, the receipts (and their proof files) and the match
 * rows are all derived, and no wallet movement, order change or payable commission has been written from
 * them. So the statement goes with all of it, and the file can be imported again. After approval the money
 * moved and this refuses (`undoImportRefusal`) — a correction is then a reversing entry.
 *
 * The act is kept: the audit log is append-only and records which file, how many lines, the total, and each
 * receipt that went with it (amount, currency, wallet, proof name), and by whom.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    // Whoever may import a statement may take the import back.
    await requirePermission('settlement.upload');

    const statement = await db.courierStatement.findFirst({
      where: { id, companyId, storeId },
      select: {
        id: true, reference: true, fileName: true, status: true, approvedAt: true,
        totalAmount: true, currencyCode: true, deliveryProviderId: true,
        _count: { select: { lines: true, receipts: true, matches: true } },
        receipts: {
          select: { amount: true, currencyCode: true, proofKey: true, proofName: true, wallet: { select: { name: true } } },
        },
      },
    });
    if (!statement) return NextResponse.json({ error: 'الكشف غير موجود' }, { status: 404 });

    const refusal = undoImportRefusal({ status: statement.status, approvedAt: statement.approvedAt });
    if (refusal) return NextResponse.json(refusal, { status: 409 });

    // The guard is repeated in the delete itself, so an approval that lands a moment after the check above
    // still stops it: nothing is removed unless the row is STILL unapproved. Lines, receipts and matches
    // follow the statement (onDelete: Cascade).
    const removed = await db.$transaction(async (tx) => {
      const live = await tx.courierStatement.deleteMany({
        where: { id, companyId, storeId, approvedAt: null, status: { not: 'APPROVED' } },
      });
      return live.count;
    });
    if (removed === 0) {
      return NextResponse.json(
        { code: 'ALREADY_APPROVED', error: 'اعتُمد الكشف للتو — لم يعد يُلغى. أيّ تصحيح الآن يكون بقيد عكسي.' },
        { status: 409 }
      );
    }

    // The proof files of the receipts that went with it. After the rows are gone, and best effort.
    await Promise.all(statement.receipts.filter((r) => r.proofKey).map((r) => removeProofFile(r.proofKey as string)));

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_IMPORT_UNDONE',
      entity: 'CourierStatement', entityId: id,
      previousData: {
        reference: statement.reference, fileName: statement.fileName, status: statement.status,
        lines: statement._count.lines, matches: statement._count.matches, total: Number(statement.totalAmount),
        currencyCode: statement.currencyCode, deliveryProviderId: statement.deliveryProviderId,
        receipts: statement.receipts.map((r) => ({
          amount: Number(r.amount), currencyCode: r.currencyCode, wallet: r.wallet.name, proof: r.proofName ?? null,
        })),
      },
    });

    return NextResponse.json({
      ok: true, reference: statement.reference, lines: statement._count.lines, receipts: statement._count.receipts,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
