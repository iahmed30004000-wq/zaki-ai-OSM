import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { consumeOrderStock } from '@/lib/stock-consumption';
import { receiptGap, runMatching } from '@/lib/settlement';
import { isManualDraftHash, isManualHash, MANUAL_DRAFT_SENTENCE } from '@/lib/manual-statement-rules';
import { COURIER_OUTCOME_AR, readCourierWord } from '@/lib/courier-words';
import { OUTCOME_LABEL_AR, orderOutcome } from '@/lib/order-outcome';
import { isNotMentioned } from '@/lib/settlement-difference';
import { NOT_MENTIONED_ACTIVITY } from '@/lib/not-mentioned';
import { approvalRefusal, closedStatementRefusal, isApproved, undoImportRefusal } from '@/lib/settlement-gates';
import { countOpenLines } from '@/lib/statement-open-lines';
import { roundMinor } from '@/lib/money';
import { explanationOf } from '@/lib/decision-words';
import { recordMovement } from '@/lib/wallets';
import { markPayableForOrders } from '@/lib/commission';
import { zodMessage } from '@/lib/zod-message';
import {
  claimOf, decisionMatrix, loadDecisionFacts, paidGross, stillAcceptableWhere, stillSettlableWhere, wordGroupKey,
} from '@/lib/settlement-decisions';
import { removeProofFile } from '@/lib/settlement-proof';
import { SWAP_BLOCKS_UNDO_AR, swapTiedToLine } from '@/lib/superseded';
import { POSSIBLE_DOUBLE_SENTENCE, findPossibleDoubles, handWindowStart, type HandMovement } from '@/lib/possible-double';
import { ON_THE_COMPANY, proposeShortfalls, type ShortfallCharge } from '@/lib/shortfall';
import { notify } from '@/lib/notify';

/**
 * One statement.
 *
 *   GET   /api/finance/statements/:id     lines, receipts, gap, match queues
 *   PATCH /api/finance/statements/:id     { gapExplanation } | { approve: true }
 *
 * APPROVAL is the gate the whole contract hangs on: no fund movement exists
 * before it, and commission becomes payable only after it. Approving with an
 * unexplained gap between what the courier claimed and what arrived is
 * refused. So is approving while a line is still a question nobody answered (`statement-open-lines`): after the
 * approval the statement is closed for good, and the correction is a settlement statement.
 */

const patchSchema = z.object({
  gapExplanation: z.string().trim().min(5).max(500).optional(),
  approve: z.boolean().optional(),
  /**
   * The person has seen the hand-entered rows that look like the same money and says they are not
   * (or has decided to keep both). Never sent by a screen on its own: only by «اعتمد هيك».
   */
  confirmPossibleDouble: z.boolean().optional(),
  /**
   * «من يتحمّل الفرق؟» — for each short line the door could not name, the approver's answer: an employee's id, or
   * `COMPANY` (the loss stays on the company). Keyed by the match row. Sent only after the approval has answered
   * SHORTFALL_UNNAMED with the lines; a line the door already named ignores it.
   */
  shortfallPeople: z.record(z.string().uuid(), z.union([z.string().uuid(), z.literal(ON_THE_COMPANY)])).optional(),
});

/** The in-flight states a matched line promotes to «مُسلَّم» when the statement is approved. */
const IN_FLIGHT_PROMOTED_BY_STATEMENT = ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY'] as const;

/** A stop inside the approval transaction: the whole transaction rolls back and this is the answer. */
class ApprovalStopped extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.code ?? body.error ?? 'approval stopped'));
  }
}

/**
 * A claim that took fewer orders than it asked for: the approval stops and the transaction is rolled back.
 *
 * It carries the claim's own filter and NOT the names. The names are read AFTER the rollback (see the catch below):
 * inside the transaction the orders this very claim had already taken are SETTLED too, and a read there would
 * name the orders that were never the problem.
 */
class OrdersChanged extends Error {
  constructor(readonly ids: string[], readonly where: Prisma.OrderWhereInput) {
    super('ORDERS_CHANGED');
  }
}

/** The answer when an order changed between the matching (or the decision) and the approval. */
function ordersChangedBody(names: string[]) {
  return {
    code: 'ORDERS_CHANGED',
    error:
      'تغيّر وضع طلب أو أكثر منذ المطابقة (سُوّي بباب آخر، أو عليه طلب إلغاء أو تأجيل، أو تغيّرت حالته)' +
      (names.length > 0 ? `: ${names.join('، ')}` : '') +
      '. أعد المطابقة، أو غيّر بتّه إلى «قيد المراجعة»، ثم اعتمد.',
    orders: names,
  };
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
    const minor = country.minorUnit;

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
    /*
     * WHAT MAY BE SAID ABOUT EACH DIFFERENCE, READ ONCE HERE SO THE SCREEN ONLY OFFERS IT.
     *
     * The matrix of settlement-decisions, asked of every «فرق في المبلغ» row with the order's state of NOW: the
     * button greyed out on the screen carries the sentence the door would answer with, and the bulk decision is
     * offered per courier word (`wordGroup`).
     */
    const facts = await loadDecisionFacts(db, {
      companyId,
      storeId,
      minorUnit: minor,
      rows: statement.matches
        .filter((m) => m.result === 'MISMATCHED')
        .map((m) => ({
          id: m.id,
          orderId: m.orderId,
          expectedAmount: m.expectedAmount == null ? null : Number(m.expectedAmount),
          statementAmount: m.statementAmount == null ? null : Number(m.statementAmount),
          approvedAt: statement.approvedAt,
        })),
    });
    const matches = statement.matches.map((m) => {
      const reading = readCourierWord(m.statementLine?.status);
      const f = facts.get(m.id);
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
        // Only a difference in money has a decision to take.
        decisions: f ? decisionMatrix(f) : null,
        wordGroup: f ? wordGroupKey(m.statementLine?.status) : null,
        // What the company still owes if our figure stands — shown on the row that says so.
        claim: m.resolution === 'OURS_STANDS' ? claimOf({ expectedAmount: m.expectedAmount == null ? null : Number(m.expectedAmount), statementAmount: m.statementAmount == null ? null : Number(m.statementAmount) }, minor) : null,
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
        matches: { select: { orderId: true, result: true, resolution: true, statementAmount: true, statementFee: true } },
      },
    });
    if (!statement) return NextResponse.json({ error: 'الكشف غير موجود' }, { status: 404 });
    // Read from the stamp of the act, not from `status`: a re-match used to
    // write MATCHED over APPROVED, and this gate then let the money through
    // a second time. See lib/settlement-gates.
    if (isApproved(statement)) {
      // Pressing «اعتماد» again is the approval's own answer; writing an explanation onto a closed statement is an
      // edit, and a closed statement answers every edit with the one sentence (settlement-gates).
      return parsed.data.approve
        ? NextResponse.json({ error: 'الكشف معتمد مسبقاً', code: 'ALREADY_APPROVED' }, { status: 409 })
        : NextResponse.json(closedStatementRefusal(), { status: 409 });
    }
    // An open manual draft has no reference yet and its total is still moving: it is gathered first.
    if (isManualDraftHash(statement.fileHash)) {
      return NextResponse.json({ error: MANUAL_DRAFT_SENTENCE, code: 'MANUAL_DRAFT' }, { status: 409 });
    }

    if (parsed.data.gapExplanation && !parsed.data.approve) {
      // Written ONLY while the statement is still open: the check above was a read, this is the write that says it again.
      const written = await db.courierStatement.updateMany({
        where: { id, companyId, storeId, approvedAt: null, status: { not: 'APPROVED' } },
        data: { gapExplanation: parsed.data.gapExplanation },
      });
      if (written.count !== 1) return NextResponse.json(closedStatementRefusal(), { status: 409 });
      const updated = { ...statement, gapExplanation: parsed.data.gapExplanation };
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
      openLines: countOpenLines(statement.matches),
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

      /**
       * A STATEMENT A PERSON GATHERED BY HAND IS MATCHED AGAIN HERE, INSIDE THE APPROVAL.
       *
       * A file statement is matched by a press and the rows it wrote are what the approval settles. A manual one is
       * gathered from orders that were delivered by us, not stated by a courier, and the days between the person
       * pressing «مطابقة» and «اعتماد» are exactly when one of its orders is collected by hand, settled by
       * another statement or has a cancel asked for. So the matching is re-run in THIS transaction, after the
       * claim above holds the statement and before the rows are read: the orders settled are the ones that are
       * clean at the moment of approval. Answers a person already gave are kept by the matcher itself.
       */
      if (isManualHash(statement.fileHash)) {
        await runMatching(tx, { companyId, storeId, statementId: id, minorUnit: country.minorUnit });
      }

      const inside = await tx.courierStatement.findFirst({
        where: { id, companyId, storeId },
        include: {
          receipts: true,
          matches: {
            select: {
              id: true, orderId: true, result: true, resolution: true, resolutionNote: true, resolvedById: true,
              statementAmount: true, statementFee: true, expectedAmount: true, expectedFee: true,
              // What the company already paid on a claim for this order: the part of its gross that an EARLIER approved
              // statement settled (settlement-decisions). Empty for nearly every order.
              order: {
                select: {
                  orderNumber: true,
                  settlementMatches: {
                    where: { resolution: 'OURS_STANDS', statementId: { not: id }, statement: { approvedAt: { not: null } } },
                    select: { statementAmount: true, statementFee: true },
                  },
                },
              },
            },
          },
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
        // Counted on the rows THIS transaction read, after the claim (and after a manual statement's re-match): the
        // rows nobody can change any more, because the statement is held.
        openLines: countOpenLines(matches),
        gap: gapInside,
        explanation,
      });
      if (refusedInside) {
        // A manual statement was matched again inside this transaction, and the refusal rolls that back: the person
        // has not seen what the re-run found, so the sentence says where to look.
        const rematched = refusedInside.code === 'OPEN_LINES' && isManualHash(statement.fileHash);
        throw new ApprovalStopped(409, {
          ...refusedInside,
          ...(rematched ? { error: `${refusedInside.error}. الاعتماد أعاد مطابقة هذا الكشف اليدوي فوجد ما تغيّر — اضغط «مطابقة» لتراه` } : {}),
          gap: gapInside,
        });
      }

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

      /**
       * WHAT THIS APPROVAL SETTLES — THE CLEAN ROWS, AND THE ROWS A PERSON ANSWERED «اعتُمد رقم الشركة».
       *
       * Two kinds of row, and no third:
       *
       *   · MATCHED — the courier's figure and ours agree, and nothing else forbids it;
       *   · MISMATCHED and decided ACCEPTED_COURIER, with an explanation, by a person — their figure stands.
       *
       * «رقمنا هو المعتمد» is NOT settled: that order stays PENDING_COLLECTION as a claim on the company, and a
       * later statement's line pays what remains (settlement-decisions). «قيد المراجعة» settles nothing either.
       * An undecided MISMATCHED row settles nothing, as it never did. Nothing else writes SETTLED from a
       * statement, and nothing else writes the amount below.
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
      // the approval and is named — the person writes it again at the row.
      const unreasoned = settling.filter((m) => acceptedIds.includes(m.orderId as string) && !explanationOf(m.resolutionNote));
      if (unreasoned.length > 0) {
        throw new ApprovalStopped(409, {
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
       * take the order, for another statement to be approved first (two statements that name one order, matched
       * in the other order, are both clean) or for a cancel to be asked for. The question «is it still ours to
       * settle by this line» is therefore the WHERE of the claim itself (`stillSettlableWhere`), not a read
       * before it: there is no gap for the answer to go stale in. A claim that takes fewer orders than were
       * asked for stops the whole approval, rolls back the wallet movements above it and names the orders.
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
        settling.map((m) => [
          m.orderId as string,
          m.statementAmount == null ? null : Number(m.statementAmount) + Number(m.statementFee ?? 0),
        ])
      );
      /**
       * THE LAST PAYMENT ON A CLAIM CLOSES IT, AND THE ORDER'S AMOUNT IS EVERYTHING PAID.
       *
       * An order answered «رقمنا هو المعتمد» on an earlier approved statement was paid part of its price then
       * (the gross of that row) and is owed the rest. This statement's line pays that rest, so what the customer
       * handed over at the door — what `collectedAmount` records — is the earlier gross PLUS this line's NET.
       * The fee is counted once, in the first payment's gross: a closing line that carries a fee of its own (a manual
       * statement states the order's fee on every line) must not add it a second time. An order with no earlier
       * claim row gets exactly the figure above, untouched.
       */
      const collectedOf = (orderId: string): number | null => {
        const base = amountOf.get(orderId);
        if (base == null) return null;
        const row = settling.find((m) => m.orderId === orderId);
        const earlier = paidGross(row?.order?.settlementMatches ?? [], country.minorUnit);
        return earlier > 0 ? roundMinor(Number(row?.statementAmount ?? 0) + earlier, country.minorUnit) : base;
      };

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
       * A line answered «اعتُمد رقم الشركة» whose figure came in LOWER than ours is money the company will not
       * send. Whoever followed the parcel carries it unless the owner or the accountant accepts the explanation, so
       * a PROPOSED «فرق تحصيل» is written here, in the approval's own transaction and nowhere else (lib/shortfall).
       * It moves no money: a deduction is a person's decision, or payday's default (lib/payroll). A line the door
       * cannot name stops the approval until the approver names a person or says «على الشركة»; the whole
       * transaction — the wallet movements, the settled orders — rolls back with it.
       */
      const shortfall = await proposeShortfalls(
        tx,
        {
          companyId, storeId, approverId: user.id,
          statement: { id, reference: statement.reference, currencyCode: statement.currencyCode, importedAt: statement.createdAt },
          fallbackDeliveredAt: deliveredAt,
          minorUnit: country.minorUnit,
          naming: parsed.data.shortfallPeople,
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
            // An order that an earlier approved statement left as a claim: this line pays the rest of it.
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
        throw new ApprovalStopped(409, body);
      }

      /**
       * WHAT THE DECISIONS DID, WRITTEN ON THE ORDERS THEY DID IT TO — in the name of the person approving.
       *
       * A clean row needs no sentence of its own (the delivery above and the audit row below say it). A row a
       * PERSON answered does: the order's timeline shows which figure stood, why, and who said so — and an
       * order left as a claim on the company shows the claim, so the next person who opens it knows it is waiting
       * for a settlement statement and not forgotten.
       */
      // `settling` holds one row per order, so an order answered twice gets one sentence.
      for (const m of settling) {
        if (!acceptedIds.includes(m.orderId as string)) continue;
        await tx.orderActivity.create({
          data: {
            companyId,
            orderId: m.orderId as string,
            userId: user.id,
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
            userId: user.id,
            action: 'SETTLEMENT_CLAIM_OPENED',
            metadata: JSON.stringify({
              statement: statement.reference,
              remaining: roundMinor(Number(m.expectedAmount ?? 0) - Number(m.statementAmount ?? 0), country.minorUnit),
              explanation: m.resolutionNote ?? null,
              decidedBy: m.resolvedById ?? null,
            }),
          },
        });
      }

      return {
        row,
        deliveredCount: inFlight.length,
        receiptCount: receipts.length,
        settledCount: settledOrderIds.length,
        acceptedCount: acceptedIds.length,
        claimCount: claims.length,
        shortfalls: shortfall.charges,
        shortfallsOnCompany: shortfall.onCompany.length,
      };
      }, { timeout: 30_000 });
    } catch (e) {
      if (e instanceof ApprovalStopped) return NextResponse.json(e.body, { status: e.status });
      if (e instanceof OrdersChanged) {
        // The transaction is gone, so what is read now is what is true: the orders that failed the claim's filter.
        const changed = await db.order.findMany({
          where: { id: { in: e.ids }, companyId, storeId, NOT: e.where },
          select: { orderNumber: true },
        });
        return NextResponse.json(ordersChangedBody((Array.isArray(changed) ? changed : []).map((o) => o.orderNumber)), { status: 409 });
      }
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
        // What the approval settled: the clean rows plus the answered ones, and the claims it left open.
        settled: approved.settledCount, acceptedByDecision: approved.acceptedCount, claimsOpened: approved.claimCount,
        // The «فرق تحصيل» the approval proposed (each a PROPOSED row waiting for a decision), and the lines the
        // approver left on the company.
        shortfalls: approved.shortfalls.map((c: ShortfallCharge) => ({ penaltyId: c.penaltyId, employeeId: c.userId, amount: c.amount, currency: c.currencyCode })),
        shortfallsOnCompany: approved.shortfallsOnCompany,
        // Said by the person, on the screen: the hand rows listed were NOT the same money. Written here so
        // the approval itself carries the answer.
        ...(confirmedDoubles.length > 0 ? { confirmedPossibleDouble: true, handRows: confirmedDoubles } : {}),
      },
    });

    // Each employee hears of it once the approval is committed — never from a transaction that might roll back.
    for (const c of approved.shortfalls) {
      notify({
        companyId,
        storeId,
        audience: { userIds: [c.userId] },
        actorId: user.id,
        title: 'فرق تحصيل عليك — بانتظار القرار',
        message: `طلب ${c.orderNumber} · كشف ${statement.reference}: دفعت الشركة أقل من المتوقَّع بمقدار ${c.amount} ${c.currencyCode}. إن كان عندك تفسير فاحكِ مع المحاسب أو المالك.`,
        type: 'SYSTEM_ALERT',
        link: '/control/penalties',
      });
    }

    return NextResponse.json({
      statement: approved.row,
      gap,
      // How many the statement itself closed, so the screen can say it
      // rather than leaving somebody to notice the tracking list shrank.
      deliveredByStatement: approved.deliveredCount,
      settledOrders: approved.settledCount,
      claimsOpened: approved.claimCount,
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
 * moved and this refuses (`undoImportRefusal`) with the one sentence a closed statement gives: the correction is
 * then a settlement statement.
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
        // A parcel swap on one of its lines: the one act that writes an order before approval (see lib/superseded).
        matches: { where: swapTiedToLine, select: { id: true }, take: 1 },
        receipts: {
          select: { amount: true, currencyCode: true, proofKey: true, proofName: true, wallet: { select: { name: true } } },
        },
      },
    });
    if (!statement) return NextResponse.json({ error: 'الكشف غير موجود' }, { status: 404 });

    const refusal = undoImportRefusal({ status: statement.status, approvedAt: statement.approvedAt });
    if (refusal) return NextResponse.json(refusal, { status: 409 });
    // A swap recorded on a line wrote an order and drew stock already: the import is no longer "untouched".
    if ((statement.matches ?? []).length > 0) {
      return NextResponse.json({ code: 'SWAP_ON_STATEMENT', error: SWAP_BLOCKS_UNDO_AR }, { status: 409 });
    }

    // The guard is repeated in the delete itself, so an approval that lands a moment after the check above
    // still stops it: nothing is removed unless the row is STILL unapproved. Lines, receipts and matches
    // follow the statement (onDelete: Cascade).
    //
    // AND THE STATEMENT'S ROW IS LOCKED FIRST, the way a parcel swap locks it, and only THEN read. A swap takes the
    // lock and never edits the row, so a delete that had already begun would finish on its old picture of the
    // swap rows (a subquery in a delete's own filter is not looked at again once the lock is granted) and throw
    // the file away from under the sale. Locking before the read puts the two in a line: whichever comes second
    // reads what the first left.
    const removed = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "courier_statements" WHERE "id" = ${id} FOR UPDATE`;
      const swapped = await tx.courierStatement.findFirst({
        where: { id, companyId, storeId },
        select: { matches: { where: swapTiedToLine, select: { id: true }, take: 1 } },
      });
      if ((swapped?.matches ?? []).length > 0) return 'SWAPPED' as const;
      const live = await tx.courierStatement.deleteMany({
        where: { id, companyId, storeId, approvedAt: null, status: { not: 'APPROVED' } },
      });
      return live.count;
    });
    if (removed === 'SWAPPED') {
      return NextResponse.json({ code: 'SWAP_ON_STATEMENT', error: SWAP_BLOCKS_UNDO_AR }, { status: 409 });
    }
    if (removed === 0) {
      return NextResponse.json(
        closedStatementRefusal(),
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
