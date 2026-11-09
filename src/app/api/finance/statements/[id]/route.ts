import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { receiptGap, runMatching } from '@/lib/settlement';
import { isManualDraftHash, isManualHash, MANUAL_DRAFT_SENTENCE } from '@/lib/manual-statement-rules';
import { COURIER_OUTCOME_AR, readCourierWord } from '@/lib/couriers/words';
import { OUTCOME_LABEL_AR, orderOutcome } from '@/lib/order-outcome';
import { isNotMentioned } from '@/lib/settlement-difference';
import { NOT_MENTIONED_ACTIVITY } from '@/lib/not-mentioned';
import {
  MATCHING_ALREADY_CLOSED_SENTENCE, approvalRefusal, closedStatementRefusal, isApproved, undoImportRefusal,
} from '@/lib/settlement-gates';
import { EXCLUDED_RESULT, countOpenLines } from '@/lib/statement-open-lines';
import { recordMovement, reverseHandRows } from '@/lib/wallets';
import { zodMessage } from '@/lib/zod-message';
import { claimOf, decisionMatrix, loadDecisionFacts, wordGroupKey } from '@/lib/settlement-decisions';
import { removeProofFile } from '@/lib/settlement-proof';
import { SWAP_BLOCKS_UNDO_AR, swapTiedToLine } from '@/lib/superseded';
import { POSSIBLE_DOUBLE_SENTENCE, findPossibleDoubles, handWindowStart, type HandMovement } from '@/lib/possible-double';
import { ON_THE_COMPANY, type ShortfallCharge } from '@/lib/shortfall';
import {
  OrdersChanged, StatementStopped, closeRowsSelect, ordersChangedBody, settleStatement, tellShortfalls, type CloseResult,
} from '@/lib/statement-close';

/**
 * One statement.
 *
 *   GET   /api/finance/statements/:id     lines, receipts, gap, match queues
 *   PATCH /api/finance/statements/:id     { gapExplanation } | { approve: true }
 *
 * APPROVAL is the gate the whole contract hangs on: no fund movement exists before it. Approving with an unexplained
 * gap between what the courier claimed and what arrived is refused.
 *
 * «افصل المطابقة عن التحصيل… لما اعتمدو ينزل التحصيل تلقائي ولما يتطابق ما يكرر التحصيل» (the owner, 2/11). The
 * approval posts the MONEY — one IN per receipt — and no longer waits on a line still a question: the receipts are
 * cash that arrived, and no answer to a line changes them. The ORDERS (settled, delivered, commission payable) wait
 * for the lines: when none is open the approval closes the matching in the same transaction, as it always did;
 * otherwise «إغلاق المطابقة» (`./close`) does it once they are answered, and writes no money.
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
   * The person has seen the hand-entered rows and says they ARE the same money: the approval reverses them
   * itself, in the same transaction that writes the statement's own movement, so the wallet ends holding the
   * money once. Sent only by «اعكس اليدوي واعتمد». It takes the reversing door's own key as well.
   */
  reverseHandRowIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  /**
   * «من يتحمّل الفرق؟» — for each short line the door could not name, the approver's answer: an employee's id, or
   * `COMPANY` (the loss stays on the company). Keyed by the match row. Sent only after the approval has answered
   * SHORTFALL_UNNAMED with the lines; a line the door already named ignores it.
   */
  shortfallPeople: z.record(z.string().uuid(), z.union([z.string().uuid(), z.literal(ON_THE_COMPANY)])).optional(),
});

/**
 * A stop inside the approval transaction: the whole transaction rolls back and this is the answer. The same class
 * the close throws (`statement-close`), so one catch answers both halves of the act.
 */
const ApprovalStopped = StatementStopped;

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
            // `collected` and `fee` too: the screen lays the row out under its own names (`readCourierRow`), display only.
            // The receiver's five cells too (name, phone, address, governorate, area): the screen names them instead of
            // dumping the row. A line imported before they were kept sends them as null.
            statementLine: {
              select: {
                merchantRef: true, barcode: true, amount: true, collected: true, fee: true, status: true, rawRow: true,
                receiverName: true, receiverPhone: true, receiverAddress: true, receiverCity: true, receiverArea: true,
              },
            },
          },
        },
      },
    });
    if (!statement) return NextResponse.json({ error: 'الكشف غير موجود' }, { status: 404 });

    const gap = await receiptGap(db, id, country.minorUnit);

    /*
     * WHAT EACH ROW SAYS ABOUT ITSELF, READ ONCE HERE SO THE SCREEN ONLY SHOWS IT.
     *
     * · `courierWord` — the company's status cell through the ONE phrase table (`couriers/words`), the same
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
          // A row takes an answer until the MATCHING is closed — the money may already be in the wallet.
          approvedAt: statement.matchingClosedAt,
          // The company's own word on the line, read by the matrix like at the two doors that answer.
          status: m.statementLine?.status ?? null,
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
      // The lines the company wrote at zero for a parcel it says came back or waits: not money, not a question.
      excluded: matches.filter((m) => m.result === EXCLUDED_RESULT),
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

    /*
     * TWO ACTS, TWO KEYS (perm-plan PR-9).
     *
     * Writing the explanation of a gap is the reviewer's (`settlement.review`). PRESSING «اعتماد» is the act that moves
     * the courier's money into a wallet, and it has a box of its own (`settlement.approve`) so the owner can let a
     * person match the lines without letting her approve. The body is read first only to learn which act this is; a body
     * that is not JSON, or that does not ask to approve, is the reviewer's door as it always was, and is judged below.
     * The migration 20261030150000_finance_split_keys gave the approval to every holder of `settlement.review`.
     */
    const raw: unknown = await req.json().catch(() => null);
    const wantsApproval = typeof raw === 'object' && raw !== null && (raw as { approve?: unknown }).approve === true;
    await requirePermission(wantsApproval ? 'settlement.approve' : 'settlement.review');

    const parsed = patchSchema.safeParse(raw);
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
      gap,
      explanation,
    });
    if (refusal) return NextResponse.json({ ...refusal, gap }, { status: 409 });

    const approvedAt = new Date();
    // The hand rows the person has just said are NOT the same money — kept for the audit row.
    let confirmedDoubles: string[] = [];
    // The hand rows the approval itself reversed, because the person said they are the same money as the receipts.
    let reversedDoubles: string[] = [];

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
        // The rows the close settles, with what an earlier closed statement already paid on a claim (statement-close).
        include: { receipts: true, matches: { select: closeRowsSelect(id) } },
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
      if (doubles.length > 0 && (parsed.data.reverseHandRowIds?.length ?? 0) > 0) {
        /*
         * «THEY ARE THE SAME MONEY» — REVERSED HERE, BY THE APPROVAL, IN THIS TRANSACTION.
         *
         * The person used to be sent to the wallet to press «قيد عكسي» and come back. Now the one press does both:
         * each hand row gets its reversing entry (the ledger is append-only: nothing is edited), then the statement's
         * own IN is written below. +hand −hand +statement leaves the wallet with the money once. The reversal is a
         * cash-box act, so it asks the cash-box key as well as the approval's; a failure of any reversal rolls the
         * approval back, stamp and all.
         */
        // The answer covers the rows the person SAW. A row that appeared since (or in the second round trip) is
        // shown to them first: the approval stops with the list again instead of reversing what nobody looked at.
        const shown = new Set(parsed.data.reverseHandRowIds);
        const unseen = doubles.filter((d) => !shown.has(d.id));
        if (unseen.length > 0) {
          throw new PossibleDouble(
            doubles.map((d) => {
              const wallet = handRows.find((m) => m.id === d.id)!.wallet;
              return { ...d, wallet: wallet.name, currencyCode: wallet.currencyCode };
            })
          );
        }
        // More hand rows than receipts: at least one of them is not this statement's money, and one press cannot
        // say which. The person reverses the extra one from the wallet, or keeps both with «اعتمد هيك».
        if (doubles.length > receipts.length) {
          throw new ApprovalStopped(409, {
            code: 'MORE_HAND_ROWS_THAN_RECEIPTS',
            error: 'عدد الحركات اليدوية المشابهة أكبر من عدد إيصالات الكشف، فواحدة منها على الأقل مصاري ثانية. اعكس الزائدة من شاشة المحافظ ثم اعتمد.',
          });
        }
        if (!can(user, 'finance.cashbox')) {
          throw new ApprovalStopped(403, {
            code: 'REVERSE_NEEDS_CASHBOX',
            error: 'عكس الحركة اليدوية يحتاج صلاحية الصندوق. اطلب ممن يملكها أن يعكسها، أو اعتمد هيك إن كانت مصاريَ أخرى.',
          });
        }
        try {
          await reverseHandRows(tx, {
            companyId,
            rows: doubles.map((d) => ({ id: d.id, walletId: d.walletId })),
            reason: `سُجِّلت بالكشف ${statement.reference} — نفس المبلغ`,
            createdById: user.id,
          });
        } catch {
          // Somebody reversed that row between the read above and this write: nothing is half done, the person presses again.
          throw new ApprovalStopped(409, {
            code: 'HAND_ROW_CHANGED',
            error: 'تغيّرت الحركة اليدوية قبل عكسها. أعد الضغط على «اعتماد» لترى الحالة الجديدة.',
          });
        }
        reversedDoubles = doubles.map((d) => d.id);
      } else if (doubles.length > 0 && !parsed.data.confirmPossibleDouble) {
        throw new PossibleDouble(
          doubles.map((d) => {
            const wallet = handRows.find((m) => m.id === d.id)!.wallet;
            return { ...d, wallet: wallet.name, currencyCode: wallet.currencyCode };
          })
        );
      }
      if (reversedDoubles.length === 0) confirmedDoubles = doubles.map((d) => d.id);

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
          // One movement per receipt, held by the database (`wallet_movements_statementReceiptId_key`).
          statementReceiptId: receipt.id,
          createdById: user.id,
        });
      }

      /**
       * THE MATCHING CLOSES WITH THE MONEY — WHEN NOTHING IS LEFT TO ANSWER.
       *
       * «افصل المطابقة عن التحصيل… لما اعتمدو ينزل التحصيل تلقائي ولما يتطابق ما يكرر التحصيل». The money above is
       * the receipts, and it never waits on a line. What the statement does to ORDERS (settled, delivered, commission
       * payable, shortfalls, claims — `statement-close`) waits for every line to be answered: when none is a question
       * it is done here, in this same transaction, exactly as the approval always did it; otherwise the matching
       * stays open and «إغلاق المطابقة» does it later — and writes no money, because only this branch does.
       *
       * Counted on the rows THIS transaction read, after the claim (and after a manual statement's re-match).
       */
      const openLines = countOpenLines(matches);
      let closed: CloseResult | null = null;
      if (openLines === 0) {
        // One winner, as for the money: a close already taken (it cannot be, before this approval) is not taken twice.
        const closing = await tx.courierStatement.updateMany({
          where: { id, companyId, matchingClosedAt: null },
          data: { matchingClosedAt: approvedAt, matchingClosedById: user.id },
        });
        if (closing.count !== 1) {
          throw new StatementStopped(409, { code: 'MATCHING_ALREADY_CLOSED', error: MATCHING_ALREADY_CLOSED_SENTENCE });
        }
        closed = await settleStatement(tx, {
          companyId, storeId, userId: user.id, minorUnit: country.minorUnit,
          statement: {
            id, reference: statement.reference, currencyCode: statement.currencyCode,
            createdAt: statement.createdAt, periodTo: statement.periodTo,
          },
          matches,
          shortfallPeople: parsed.data.shortfallPeople,
        });
      }

      return {
        row: closed ? { ...row, matchingClosedAt: approvedAt, matchingClosedById: user.id } : row,
        receiptCount: receipts.length,
        openLines,
        matchingClosed: closed !== null,
        deliveredCount: closed?.deliveredCount ?? 0,
        settledCount: closed?.settledCount ?? 0,
        acceptedCount: closed?.acceptedCount ?? 0,
        claimCount: closed?.claimCount ?? 0,
        shortfalls: closed?.shortfalls ?? [],
        shortfallsOnCompany: closed?.shortfallsOnCompany ?? 0,
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
        // Whether the matching closed with the money, and how many lines kept it open.
        matchingClosed: approved.matchingClosed, openLines: approved.openLines,
        // The «فرق تحصيل» the approval proposed (each a PROPOSED row waiting for a decision), and the lines the
        // approver left on the company.
        shortfalls: approved.shortfalls.map((c: ShortfallCharge) => ({ penaltyId: c.penaltyId, employeeId: c.userId, amount: c.amount, currency: c.currencyCode })),
        shortfallsOnCompany: approved.shortfallsOnCompany,
        // Said by the person, on the screen: the hand rows listed were NOT the same money. Written here so
        // the approval itself carries the answer.
        ...(confirmedDoubles.length > 0 ? { confirmedPossibleDouble: true, handRows: confirmedDoubles } : {}),
        // The hand rows the approval reversed itself: the person said they were this statement's money.
        ...(reversedDoubles.length > 0 ? { reversedHandRows: reversedDoubles } : {}),
      },
    });

    // Each employee hears of it once the approval is committed — never from a transaction that might roll back.
    tellShortfalls({ companyId, storeId, actorId: user.id, reference: statement.reference, charges: approved.shortfalls });

    return NextResponse.json({
      statement: approved.row,
      gap,
      // How many the statement itself closed, so the screen can say it
      // rather than leaving somebody to notice the tracking list shrank.
      deliveredByStatement: approved.deliveredCount,
      settledOrders: approved.settledCount,
      claimsOpened: approved.claimCount,
      // The money is in either way; the matching stays open while a line is a question («إغلاق المطابقة» after).
      matchingClosed: approved.matchingClosed,
      openLines: approved.openLines,
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
