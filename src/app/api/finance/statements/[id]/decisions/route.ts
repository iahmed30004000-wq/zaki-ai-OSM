import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { isDifference, shortfall } from '@/lib/settlement-difference';
import { closedStatementRefusal, isApproved } from '@/lib/settlement-gates';
import {
  BULK_LIMIT,
  DECISIONS,
  DECISION_AR,
  EXPLANATION_SENTENCE,
  WHY,
  explanationOf,
  decisionData,
  decisionMatrix,
  decisionNoteBody,
  loadDecisionFacts,
  wordGroupKey,
  type Decision,
} from '@/lib/settlement-decisions';

/**
 * POST /api/finance/statements/:id/decisions — ONE ANSWER FOR A GROUP OF LINES THAT SAY THE SAME THING.
 *
 * «بتّ جماعي لمجموعة أسطر بنفس كلمة الشركة.» A statement of a hundred lines can carry thirty that the company
 * marks «مؤجلة» with a zero against them; answering thirty rows one by one with the same sentence is how an
 * explanation turns into a habit. Here one person writes it once, for the lines that share the company's word.
 *
 * It is the single door's rule, applied to every row and written ALL OR NONE:
 *
 *   · every row is a difference in money of THIS statement;
 *   · every row carries the same courier word (settlement-decisions `wordGroupKey`) — a different word is a
 *     different question, and answering it with the same sentence is refused;
 *   · every row is allowed the answer by the matrix, for its own order as it is now;
 *   · the explanation is the single door's: five characters at least, copied to each order's internal notes.
 *
 * One row refused refuses the whole press and names the row and the sentence, so nothing is half-decided.
 * Like the single door it moves no money and settles nothing: the approval carries the answers out — and, like
 * the single door, it answers a closed statement with the one sentence of a closed statement.
 */
const schema = z.object({
  matchIds: z.array(z.string().uuid()).min(1).max(BULK_LIMIT),
  resolution: z.enum(DECISIONS),
  note: z.string().trim().max(500).refine((s) => explanationOf(s) !== null, EXPLANATION_SENTENCE),
});

class BulkRefused extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.code ?? 'refused'));
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.review');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const resolution = parsed.data.resolution as Decision;
    const note = parsed.data.note;
    const ids = [...new Set(parsed.data.matchIds)];

    const done = await db.$transaction(async (tx) => {
      // The statement's row is locked first, as in the single door: an approval is either finished (and seen
      // below) or waits for this to commit.
      await tx.$queryRaw`SELECT "id" FROM "courier_statements" WHERE "id" = ${id} FOR UPDATE`;
      const statement = await tx.courierStatement.findFirst({
        where: { id, companyId, storeId },
        select: { reference: true, status: true, approvedAt: true },
      });
      if (!statement) throw new BulkRefused(404, { error: 'الكشف غير موجود', code: 'NOT_FOUND' });
      // A closed statement takes no answer, one or many: the same sentence every door of it gives.
      if (isApproved(statement)) throw new BulkRefused(409, { ...closedStatementRefusal() });

      const rows = await tx.settlementMatch.findMany({
        where: { id: { in: ids }, statementId: id, companyId },
        select: {
          id: true, result: true, orderId: true, expectedAmount: true, statementAmount: true, difference: true,
          statementLine: { select: { status: true } },
          order: { select: { orderNumber: true } },
        },
      });
      if (rows.length !== ids.length) {
        throw new BulkRefused(404, { error: 'بعض الأسطر ليست من هذا الكشف', code: 'NOT_FOUND' });
      }
      if (rows.some((r) => !isDifference(r))) {
        throw new BulkRefused(409, { error: 'البتّ الجماعي لأسطر «فرق في المبلغ» وحدها', code: 'NOT_A_DIFFERENCE' });
      }
      const words = new Set(rows.map((r) => wordGroupKey(r.statementLine?.status)));
      if (words.size > 1) {
        throw new BulkRefused(409, {
          error: 'الأسطر بكلمات شركة مختلفة — البتّ الجماعي لأسطر بكلمة واحدة فقط',
          code: 'MIXED_WORDS',
        });
      }

      const facts = await loadDecisionFacts(tx, {
        companyId,
        storeId,
        minorUnit: country.minorUnit,
        rows: rows.map((r) => ({
          id: r.id,
          orderId: r.orderId,
          expectedAmount: r.expectedAmount === null ? null : Number(r.expectedAmount),
          statementAmount: r.statementAmount === null ? null : Number(r.statementAmount),
          approvedAt: statement.approvedAt,
        })),
      });
      /*
       * TWO CHOSEN LINES FOR ONE ORDER (the company’s file names a parcel twice): the first holds it, the second is
       * refused with the sentence the single door gives — «محجوز بسطر آخر». The single door does this by reading the
       * first row’s answer; here nothing is written yet, so the press itself keeps the list. Only «اعتُمد رقم
       * الشركة» holds an order; the other two sayings hold nothing, as at the single door.
       */
      const held = new Set<string>();
      const refused = ids.flatMap((rowId) => {
        const r = rows.find((x) => x.id === rowId)!;
        const verdict = decisionMatrix(facts.get(r.id)!)[resolution];
        if (verdict.allowed && resolution === 'ACCEPTED_COURIER' && r.orderId) {
          if (held.has(r.orderId)) return [{ matchId: r.id, order: r.order?.orderNumber ?? null, why: WHY.heldElsewhere }];
          held.add(r.orderId);
        }
        return verdict.allowed ? [] : [{ matchId: r.id, order: r.order?.orderNumber ?? null, why: verdict.why }];
      });
      if (refused.length > 0) {
        throw new BulkRefused(409, {
          error: `لا يصحّ هذا البتّ على ${refused.length} سطراً — لم يُحفظ شيء. ${refused[0].order ?? ''}: ${refused[0].why}`,
          code: 'DECISION_NOT_ALLOWED',
          refused,
        });
      }

      const at = new Date();
      for (const r of rows) {
        // Each write says it again: an open statement, and the row still the row that was read. One that fails
        // rolls back the whole press — nothing is half-decided.
        const written = await tx.settlementMatch.updateMany({
          where: { id: r.id, statementId: id, companyId, result: r.result, statement: { approvedAt: null } },
          data: decisionData({ resolution, note, userId: user.id, at }),
        });
        if (written.count !== 1) {
          throw new BulkRefused(409, { error: 'تغيّر سطر قبل لحظات — حدّث الصفحة وأعد المحاولة', code: 'CHANGED' });
        }
        if (r.orderId) {
          const gap = shortfall(
            {
              expectedAmount: r.expectedAmount === null ? null : Number(r.expectedAmount),
              statementAmount: r.statementAmount === null ? null : Number(r.statementAmount),
              difference: r.difference === null ? null : Number(r.difference),
            },
            country.minorUnit
          );
          await tx.orderNote.create({
            data: {
              companyId,
              orderId: r.orderId,
              authorId: user.id,
              kind: 'internal',
              body: decisionNoteBody({ statement: statement.reference, resolution, gap, note }),
            },
          });
        }
      }
      return { count: rows.length, reference: statement.reference };
    }, { timeout: 30_000 }).catch((e: unknown) => {
      if (e instanceof BulkRefused) return e;
      throw e;
    });

    if (done instanceof BulkRefused) return NextResponse.json(done.body, { status: done.status });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'SETTLEMENT_DIFFERENCES_RESOLVED_BULK',
      entity: 'CourierStatement',
      entityId: id,
      newData: { resolution, explanation: note, rows: done.count, statement: done.reference },
    });

    return NextResponse.json({ count: done.count, message: `${DECISION_AR[resolution]} — ${done.count} سطراً` });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
