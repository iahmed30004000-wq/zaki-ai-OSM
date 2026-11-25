import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { PARKED, PARKED_AR } from '@/lib/settlement-difference';
import { closedStatementRefusal, isMatchingClosed } from '@/lib/settlement-gates';
import { parkableLineWhere } from '@/lib/statement-open-lines';
import { EXPLANATION_SENTENCE, explanationOf, decisionData, decisionKind } from '@/lib/settlement-decisions';

/**
 * POST /api/finance/statements/:id/park-unlinked — «ركّن كل السطور بلا طلب».
 *
 * A courier's file can carry hundreds of lines that no order of ours carries (parcels of the system used before this one,
 * another company's lines). Each may already be parked one by one at the single door (`…/matches/:matchId/resolve`,
 * «قيد المراجعة» with its reason); this is the same answer, written once for every such line of ONE statement.
 *
 * It is the single door's answer and nothing more:
 *
 *   · the rows: `MISSING_IN_SYSTEM`, no order, no answer yet (`parkableLineWhere`, the rule the screen counts with);
 *   · the explanation: the single door's rule (`explanationOf` — five characters, three of them real);
 *   · the row's data: the single door's writer (`decisionData` + `decisionKind`), so the row reads exactly as if each line
 *     had been parked by hand;
 *   · the statement must not be closed — the same sentence every door of it gives, read under the statement's row lock and
 *     repeated in the write (`statement: { matchingClosedAt: null }`).
 *
 * ALL OR NONE: the rows are read and then written in one transaction, and the write must take every row that was read. A row
 * that changed in between (tied to an order, answered by somebody else) refuses the whole press and nothing is parked.
 *
 * IT MOVES NO MONEY AND SETTLES NOTHING. A parked line no order carries has no order to write on, no wallet, no commission;
 * the approval simply stops waiting for it. A second press finds nothing to park and answers 0 — no write, no audit row.
 * One audit row per press that parked something, carrying the count.
 */
const schema = z.object({
  note: z.string().trim().max(500).refine((s) => explanationOf(s) !== null, EXPLANATION_SENTENCE),
});

/** A stop inside the transaction: it rolls back and this is the answer. */
class ParkRefused extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.code ?? 'refused'));
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('settlement.review');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error), code: 'EXPLANATION_REQUIRED' }, { status: 400 });
    }
    const note = parsed.data.note;

    const done = await db
      .$transaction(
        async (tx) => {
          // The statement's row is locked first, as at the single door: a close is either finished (and seen below) or waits.
          await tx.$queryRaw`SELECT "id" FROM "courier_statements" WHERE "id" = ${id} FOR UPDATE`;
          const statement = await tx.courierStatement.findFirst({
            where: { id, companyId, storeId },
            select: { reference: true, status: true, approvedAt: true, matchingClosedAt: true },
          });
          if (!statement) throw new ParkRefused(404, { error: 'الكشف غير موجود', code: 'NOT_FOUND' });
          if (isMatchingClosed(statement)) throw new ParkRefused(409, { ...closedStatementRefusal() });

          const scope = { statementId: id, companyId, ...parkableLineWhere(), appliedAt: null };
          const rows = await tx.settlementMatch.findMany({ where: scope, select: { id: true } });
          if (rows.length === 0) return { count: 0, reference: statement.reference };

          const written = await tx.settlementMatch.updateMany({
            where: { ...scope, id: { in: rows.map((r) => r.id) }, appliedAt: null, statement: { storeId, matchingClosedAt: null } },
            data: { ...decisionData({ resolution: PARKED, note, userId: user.id }), ...decisionKind() },
          });
          if (written.count !== rows.length) {
            throw new ParkRefused(409, { error: 'تغيّر سطر قبل لحظات — لم يُركَّن شيء. حدّث الصفحة وأعد المحاولة', code: 'CHANGED' });
          }
          return { count: rows.length, reference: statement.reference };
        },
        { timeout: 30_000 }
      )
      .catch((e: unknown) => {
        if (e instanceof ParkRefused) return e;
        throw e;
      });

    if (done instanceof ParkRefused) return NextResponse.json(done.body, { status: done.status });

    if (done.count > 0) {
      await logAudit({
        companyId,
        userId: user.id,
        action: 'SETTLEMENT_UNLINKED_LINES_PARKED',
        entity: 'CourierStatement',
        entityId: id,
        newData: { resolution: PARKED, explanation: note, rows: done.count, statement: done.reference },
      });
    }

    return NextResponse.json({
      parked: done.count,
      message:
        done.count > 0
          ? `${PARKED_AR} — ${done.count} سطراً بلا طلب. ما بتعلّق الاعتماد.`
          : 'ما في سطر بلا طلب ينتظر — ما تركّن شيء.',
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
