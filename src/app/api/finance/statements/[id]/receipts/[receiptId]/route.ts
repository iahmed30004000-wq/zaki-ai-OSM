import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { receiptGap } from '@/lib/settlement';
import { receiptEditRefusal } from '@/lib/settlement-gates';

/**
 * DELETE /api/finance/statements/:id/receipts/:receiptId — take a wrong receipt back, until «اعتماد».
 *
 * A receipt recorded against the wrong wallet or with the wrong amount used to be fixed: the only way out was
 * to undo the whole statement. Until the statement is approved nothing has been written from a receipt (the
 * wallet moves at approval), so it can simply go, and the person adds the right one again.
 *
 * What stays true when it goes: the statement's status is worked out the way the receipt route works it out
 * (RECEIPTED while a receipt is there, IMPORTED when none is left), and the gap is recomputed from what is
 * left. NO WALLET MOVEMENT is written, ever. The proof file is NOT removed — it is evidence, and the audit
 * row names it — and the act is audited with everything the receipt held.
 *
 * Same permission as the receipt route, same refusal after approval, and the same conditional claim on the
 * statement (`approvedAt: null`) taken first inside the transaction, so a removal racing an approval is
 * refused instead of leaving an approval standing on a receipt that is gone.
 */
class StatementClosed extends Error {}
class NoSuchReceipt extends Error {}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; receiptId: string }> }
) {
  try {
    const { id, receiptId } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.upload');

    const receipt = await db.statementReceipt.findFirst({
      where: { id: receiptId, companyId, statementId: id, statement: { companyId, storeId } },
      select: {
        id: true, amount: true, currencyCode: true, exchangeRate: true, receivedAt: true, note: true,
        proofKey: true, proofName: true, proofHash: true,
        wallet: { select: { name: true } },
        statement: { select: { status: true, approvedAt: true } },
      },
    });
    if (!receipt) return NextResponse.json({ error: 'الإيصال غير موجود' }, { status: 404 });
    const closed = receiptEditRefusal(receipt.statement);
    if (closed) return NextResponse.json(closed, { status: 409 });

    let left: number;
    let status: string;
    try {
      ({ left, status } = await db.$transaction(async (tx) => {
        const open = await tx.courierStatement.updateMany({
          where: { id, companyId, storeId, approvedAt: null, status: { not: 'APPROVED' } },
          data: { updatedAt: new Date() },
        });
        if (open.count !== 1) throw new StatementClosed();

        const removed = await tx.statementReceipt.deleteMany({ where: { id: receiptId, companyId, statementId: id } });
        if (removed.count !== 1) throw new NoSuchReceipt();

        const remaining = await tx.statementReceipt.count({ where: { statementId: id } });
        const next = remaining > 0 ? 'RECEIPTED' : 'IMPORTED';
        await tx.courierStatement.update({ where: { id }, data: { status: next } });
        return { left: remaining, status: next };
      }));
    } catch (e) {
      if (e instanceof StatementClosed) return NextResponse.json(receiptEditRefusal({ status: 'APPROVED' }), { status: 409 });
      if (e instanceof NoSuchReceipt) return NextResponse.json({ error: 'الإيصال غير موجود' }, { status: 404 });
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_RECEIPT_REMOVED',
      entity: 'CourierStatement', entityId: id,
      previousData: {
        receiptId,
        wallet: receipt.wallet.name,
        amount: Number(receipt.amount),
        currencyCode: receipt.currencyCode,
        exchangeRate: receipt.exchangeRate == null ? null : Number(receipt.exchangeRate),
        receivedAt: receipt.receivedAt,
        note: receipt.note,
        proof: receipt.proofKey ? { key: receipt.proofKey, name: receipt.proofName, hash: receipt.proofHash } : null,
      },
      newData: { status, receiptsLeft: left },
    });

    return NextResponse.json({ ok: true, status, gap: await receiptGap(db, id, country.minorUnit) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
