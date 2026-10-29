import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { isDifference, MISSING_RESULTS, PARKED, shortfall } from '@/lib/settlement-difference';
import { closedStatementRefusal, isApproved } from '@/lib/settlement-gates';
import { mayOnlyBeParked } from '@/lib/statement-open-lines';
import {
  DECISIONS,
  DECISION_AR,
  EXPLANATION_SENTENCE,
  explanationOf,
  decisionData,
  decisionMatrix,
  decisionNoteBody,
  loadDecisionFacts,
  type Decision,
} from '@/lib/settlement-decisions';

/**
 * POST /api/finance/statements/:id/matches/:matchId/resolve
 *
 * «ممكن عادي صار خصم، بس يعتمد رقم الشركة. وإذا غير معتمد أنا رح أتواصل مع
 * الشركة وخط اعتماد رقمنا. بس بضل الطلب معلّم.»
 *
 * Three answers to one question, and the order keeps saying it was asked.
 *
 * ── THE ANSWER NEEDS AN EXPLANATION ──
 *
 * Five characters at least, written by the person who decides: «اعتُمد رقم الشركة» with nothing beside it is a
 * dinar given away with no one able to say why, and «رقمنا» with nothing beside it is a claim on a company
 * that nobody can defend. It is stored on the row (resolutionNote) and copied to the order's internal notes.
 *
 * ── WHAT MAY BE SAID DEPENDS ON THE ORDER ──
 *
 * The matrix of settlement-decisions, asked of the order as it is NOW. A figure is accepted or claimed only
 * for a parcel the money is about; where no door takes either, «قيد المراجعة» is the honest answer. The
 * sentence of a refusal is the one the screen shows on the greyed-out button.
 *
 * ── IT MOVES NO MONEY, AND SETTLES NOTHING ──
 *
 * Deliberately. A resolution records WHAT was decided and WHY; the effect — the order settled at their figure,
 * or left as a claim on the company — is carried out by the APPROVAL, inside its own transaction, after every
 * order is looked at again. Writing a wallet movement or a settlement from here would be a second money path
 * into settlement — the thing this codebase refuses above all others — from a button whose label says
 * «record the reason». So an answer is taken only BEFORE the approval, whichever answer it is: the statement's
 * row is locked here, and an approval that has started either finished first (and the answer is refused with
 * the one sentence of a closed statement) or waits for this to commit (and reads it). The write repeats it
 * (`approvedAt: null` in its WHERE).
 *
 * This reverses what stood here: «رقمنا» and «قيد المراجعة» were still taken after the approval because they
 * move no money. But «قيد المراجعة» over a row answered «رقمنا» took the claim off the company in silence, and
 * «رقمنا» after the fact opened a claim no approval had looked at. A closed statement is corrected by a
 * settlement statement and by nothing else.
 *
 * ── A LINE NO ORDER CARRIES HAS ONE ANSWER ──
 *
 * «قيد المراجعة», with the reason written: the line is not ours (another company's, a misspelled reference).
 * Without it the approval — which waits for every line that is a question — would wait for ever on a line no
 * order will carry. Tying the line to an order stays the other way out (the link door).
 *
 * ── AND IT WRITES BACK TO THE ORDER ──
 *
 * The answer is usually already in the order's internal notes: an agent
 * agreed a discount on the phone and wrote it there, where finance never
 * looks. So the decision goes back the same way, to the same place, and the
 * person who reads the order sees that finance accepted it — or did not.
 */
const schema = z.object({
  resolution: z.enum(DECISIONS),
  note: z.string().trim().max(500).refine((s) => explanationOf(s) !== null, EXPLANATION_SENTENCE),
});

/** A stop inside the transaction: it rolls back and this is the answer. */
class DecisionRefused extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.code ?? 'refused'));
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  try {
    const { id, matchId } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.review');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const resolution = parsed.data.resolution as Decision;
    const note = parsed.data.note;

    const match = await db.settlementMatch.findFirst({
      where: { id: matchId, statementId: id, companyId, statement: { storeId } },
      select: {
        id: true,
        result: true,
        resolution: true,
        orderId: true,
        expectedAmount: true,
        statementAmount: true,
        difference: true,
        statement: { select: { reference: true } },
        order: { select: { orderNumber: true } },
      },
    });
    if (!match) return NextResponse.json({ error: 'سطر المطابقة غير موجود' }, { status: 404 });

    // A clean match has nothing to answer. Recording a reason on one would
    // put it in the count of differences and in somebody's statistics.
    const parkedLine = mayOnlyBeParked(match) && resolution === PARKED;
    if (!isDifference(match)) {
      /*
       * A parcel one side does not have has ONE figure, so there is nothing to choose between: «رقمنا /
       * رقمهم» is offered only on «فرق في المبلغ». It is answered on the order («طلبات لم يذكرها أي كشف»)
       * or by linking the line to an order, and it is never counted as a difference in money.
       *
       * The one thing a line no order carries may be told is «قيد المراجعة», with its reason: it goes on below.
       */
      const missing = (MISSING_RESULTS as readonly string[]).includes(match.result);
      if (!parkedLine) {
        return NextResponse.json(
          {
            error: missing
              ? 'هذا السطر طرف واحد فقط — لا رقمين يُختار بينهما. «رقمنا / رقمهم» لسطر «فرق في المبلغ» وحده'
              : 'هذا السطر مطابق — لا فرق فيه يُبتّ',
            code: 'NOT_A_DIFFERENCE',
          },
          { status: 409 }
        );
      }
    }

    const gap = shortfall(
      {
        expectedAmount: match.expectedAmount === null ? null : Number(match.expectedAmount),
        statementAmount: match.statementAmount === null ? null : Number(match.statementAmount),
        difference: match.difference === null ? null : Number(match.difference),
      },
      country.minorUnit
    );

    let updated;
    try {
      updated = await db.$transaction(async (tx) => {
        // The statement's row is locked before anything is read: an approval cannot slip in between the check
        // that it is open and the write — it finished first (and is seen below) or waits for this to commit.
        await tx.$queryRaw`SELECT "id" FROM "courier_statements" WHERE "id" = ${id} FOR UPDATE`;
        const statement = await tx.courierStatement.findFirst({
          where: { id, companyId, storeId },
          select: { status: true, approvedAt: true },
        });
        if (!statement) throw new DecisionRefused(404, { error: 'الكشف غير موجود', code: 'NOT_FOUND' });
        // A closed statement takes no answer — the same sentence every door of it gives.
        if (isApproved(statement)) throw new DecisionRefused(409, { ...closedStatementRefusal() });

        // What may be said, asked of the order as it is at this moment. (A line no order carries has no order to ask.)
        if (!parkedLine) {
          const facts = await loadDecisionFacts(tx, {
            companyId,
            storeId,
            minorUnit: country.minorUnit,
            rows: [
              {
                id: match.id,
                orderId: match.orderId,
                expectedAmount: match.expectedAmount === null ? null : Number(match.expectedAmount),
                statementAmount: match.statementAmount === null ? null : Number(match.statementAmount),
                approvedAt: statement.approvedAt,
              },
            ],
          });
          const verdict = decisionMatrix(facts.get(match.id)!)[resolution];
          if (!verdict.allowed) {
            throw new DecisionRefused(409, { error: verdict.why, code: 'DECISION_NOT_ALLOWED', resolution });
          }
        }

        /*
         * THE WRITE SAYS IT AGAIN: an open statement, and the row still the row that was read. The statement's
         * row is locked above, so this cannot lose to an approval — but the guard is on the write itself and not
         * only on the reads before it, so no later edit of this door can drop it without a test failing.
         */
        const data = decisionData({ resolution, note, userId: user.id });
        const written = await tx.settlementMatch.updateMany({
          where: {
            id: match.id, statementId: id, companyId,
            result: match.result, orderId: match.orderId,
            statement: { approvedAt: null },
          },
          data,
        });
        if (written.count !== 1) {
          throw new DecisionRefused(409, { error: 'تغيّر السطر قبل لحظات — حدّث الصفحة وأعد المحاولة', code: 'CHANGED' });
        }
        const row = { id: match.id, resolution: data.resolution, resolutionNote: data.resolutionNote, resolvedAt: data.resolvedAt };

        if (match.orderId) {
          await tx.orderNote.create({
            data: {
              companyId,
              orderId: match.orderId,
              authorId: user.id,
              kind: 'internal',
              body: decisionNoteBody({ statement: match.statement.reference, resolution, gap, note }),
            },
          });
        }
        return row;
      });
    } catch (e) {
      if (e instanceof DecisionRefused) return NextResponse.json(e.body, { status: e.status });
      throw e;
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: 'SETTLEMENT_DIFFERENCE_RESOLVED',
      entity: 'SettlementMatch',
      entityId: match.id,
      previousData: { resolution: match.resolution },
      newData: {
        resolution,
        explanation: note,
        orderNumber: match.order?.orderNumber ?? null,
        statement: match.statement.reference,
        gap,
      },
    });

    return NextResponse.json({
      match: updated,
      gap,
      message: match.order?.orderNumber
        ? `${DECISION_AR[resolution]} — ${match.order.orderNumber}. يبقى الطلب معلَّماً.`
        : `${DECISION_AR[resolution]} — السطر ليس لنا ولا يعلّق الاعتماد.`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
