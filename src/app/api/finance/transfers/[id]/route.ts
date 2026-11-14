import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { reverseTransfer, TransferReversalRefused } from '@/lib/wallets';
import { zodMessage } from '@/lib/zod-message';

/**
 * Reverse a transfer — «قيد عكسي» on the transfers screen (14/11).
 *
 *   PATCH /api/finance/transfers/:id      { reason }
 *
 * The owner's words: «القيد العكسي ما بيسمع بالتحويلات هاد خطأ عظيم» and «هل لازم أعمل قيد عكسي بالمكانين». A transfer is two
 * movements written in one transaction so that no wallet is left with half of it, and its correction is ONE act too: both
 * legs get their opposite entry, in one transaction, with one reason (`reverseTransfer`, which is `reverseMovement` carrying
 * the rest of the transfer with it). A transfer one leg of which was reversed by hand before gets the leg that is left —
 * which is how the half-made reversal of before is finished — and one reversed whole is refused.
 *
 * THE KEY IS THE ONE THAT WRITES A TRANSFER (`finance.cashbox`, as POST on the collection) AND THE ONE THAT REVERSES A
 * MOVEMENT (PATCH on a wallet's movements): the person who may move the money may take it back, and nobody else. Like the
 * transfer itself it is the company's, not a store's — the two ends of a transfer can be in two stores, and a reversal that
 * could only reach one of them would be the half-reversal again.
 */
const reverseSchema = z.object({
  reason: z.string().trim().min(5, 'سبب القيد العكسي إلزامي').max(300),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireContext();
    await requirePermission('finance.cashbox');

    if (!z.string().uuid().safeParse(id).success) {
      return NextResponse.json({ error: 'التحويل غير موجود' }, { status: 404 });
    }

    const parsed = reverseSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    try {
      const done = await db.$transaction((tx) =>
        reverseTransfer(tx, { companyId, transferId: id, reason: parsed.data.reason, createdById: user.id })
      );

      await logAudit({
        companyId, userId: user.id, action: 'WALLET_TRANSFER_REVERSED',
        entity: 'WalletTransfer', entityId: id,
        newData: {
          reason: parsed.data.reason,
          reversals: done.reversals.map((r) => r.id),
          // How many legs had been reversed by hand before this press (0 = a whole transfer was reversed now).
          alreadyReversed: done.alreadyReversed,
        },
      });

      return NextResponse.json({ transferId: id, reversals: done.reversals, alreadyReversed: done.alreadyReversed }, { status: 201 });
    } catch (e) {
      if (e instanceof TransferReversalRefused) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 409 });
      }
      // Two presses at once: the database holds «one reversal per movement» (a unique column), and the loser lands here
      // with the whole transaction rolled back — nothing was written twice.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json({ error: 'اتعكس هالتحويل للتو — حدّث الصفحة', code: 'ALREADY_REVERSED' }, { status: 409 });
      }
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
