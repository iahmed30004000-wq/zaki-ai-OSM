import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { runMatching } from '@/lib/settlement';
import { closedStatementRefusal, rematchRefusal } from '@/lib/settlement-gates';

/** The statement was approved between the read and the write: the matching never ran. */
class StatementClosed extends Error {}

/**
 * POST /api/finance/statements/:id/match — step 3 of settlement.
 *
 * Runs ON DEMAND and only after a receipt exists: matching what the courier
 * claims against what we expect is pointless before we know what arrived.
 * The key is the merchant reference, then the barcode — never the phone.
 *
 * AND NEVER AFTER APPROVAL. This route ended by writing `status = 'MATCHED'`
 * with no regard for where the statement already was, so re-running matching
 * on an APPROVED one rolled it back to MATCHED — after which every approval
 * gate passed again and a SECOND wallet movement was written for the same
 * receipt. Measured on the dev database: 1,889.48 USD posted twice, from a
 * button labelled «تشغيل المطابقة». The rule lives in lib/settlement-gates.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.review');

    const statement = await db.courierStatement.findFirst({
      where: { id, companyId, storeId },
      select: { id: true, status: true, approvedAt: true, reference: true, _count: { select: { receipts: true } } },
    });
    if (!statement) return NextResponse.json({ error: 'الكشف غير موجود' }, { status: 404 });

    // Matching rewrites the rows that decide which orders were settled and
    // whose commission became payable. After approval those are history.
    const closed = rematchRefusal(statement);
    if (closed) return NextResponse.json(closed, { status: 409 });

    if (statement._count.receipts === 0) {
      return NextResponse.json(
        { error: 'سجّل إيصال الاستلام أولاً — المطابقة تأتي بعده', code: 'RECEIPT_REQUIRED' },
        { status: 409 }
      );
    }

    let outcome: Awaited<ReturnType<typeof runMatching>>;
    try {
      outcome = await db.$transaction(
        async (tx) => {
          /*
           * THE STATEMENT IS TAKEN FIRST, AND ONLY WHILE IT IS OPEN.
           *
           * The check above is a read. This is the write that says it again: `approvedAt: null` is in the WHERE, so
           * an approval that landed after the read leaves count 0 and the matching never runs; one still in flight
           * waits on this row and finds the statement already matched. It also stops `status` from ever being
           * written back to MATCHED over an APPROVED statement — which is how the money was once posted twice.
           */
          const open = await tx.courierStatement.updateMany({
            where: { id, companyId, storeId, approvedAt: null, status: { not: 'APPROVED' } },
            data: { status: 'MATCHED' },
          });
          if (open.count !== 1) throw new StatementClosed();
          return runMatching(tx, { companyId, storeId, statementId: id, minorUnit: country.minorUnit });
        },
        { timeout: 30_000 }
      );
    } catch (e) {
      if (e instanceof StatementClosed) return NextResponse.json(closedStatementRefusal(), { status: 409 });
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_MATCHED',
      entity: 'CourierStatement', entityId: id,
      newData: { reference: statement.reference, ...outcome },
    });

    return NextResponse.json({ outcome });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
