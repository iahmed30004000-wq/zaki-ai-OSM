import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { assertVoidable, type StateSource } from '@/lib/order-state';
import { releaseOrderLines } from '@/lib/reservation';
import { zodMessage } from '@/lib/zod-message';

/**
 * PATCH /api/confirmation/issues/:id — { action: 'correct' | 'void' }
 *
 * correct → the moderator fixed the data; the order goes back to the shared
 *           queue with its original created_at.
 * void    → owner only (orders.cancel), and refused for any order that ever
 *           reached shipping. VOID releases the reservation in the same
 *           transaction; it never deletes anything.
 */
const schema = z.object({
  action: z.enum(['correct', 'void']),
  note: z.string().trim().max(500).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.issues');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const issue = await db.orderIssue.findFirst({
      where: { id, companyId, order: { storeId } },
      include: { order: { select: { id: true, confirmationStatus: true, shippingStatus: true, shippedAt: true, labelPrintedAt: true } } },
    });
    if (!issue) return NextResponse.json({ error: 'الإشكال غير موجود' }, { status: 404 });
    if (issue.status !== 'OPEN') {
      return NextResponse.json({ error: 'تم إغلاق هذا الإشكال مسبقاً', code: 'ALREADY_CLOSED' }, { status: 409 });
    }

    if (parsed.data.action === 'void') {
      if (!can(user, 'orders.cancel')) {
        return NextResponse.json({ error: 'الإبطال متاح للمالك فقط' }, { status: 403 });
      }
      const voidable = assertVoidable(issue.order as StateSource);
      if (!voidable.allowed) {
        return NextResponse.json({ error: voidable.message, code: voidable.code }, { status: 409 });
      }
    }

    const result = await db.$transaction(async (tx) => {
      const updated = await tx.orderIssue.update({
        where: { id },
        data: {
          status: parsed.data.action === 'correct' ? 'CORRECTED' : 'VOIDED',
          resolvedById: user.id,
          resolvedAt: new Date(),
          note: parsed.data.note ?? issue.note,
        },
      });

      if (parsed.data.action === 'void') {
        // Financial/operational records are never deleted — the order is
        // voided, its reservation released in this same transaction.
        await releaseOrderLines(tx, issue.orderId);
        await tx.order.update({
          where: { id: issue.orderId },
          data: {
            confirmationStatus: 'CANCELLED',
            status: 'VOIDED',
            // NOT `FAKE_ORDER`: an entry issue is OUR mistake — a number
            // mistyped, a product mis-picked — and calling it fake accuses a
            // customer of something they did not do, in every report that
            // counts fake orders.
            rejectionReason: 'MODERATOR_DATA_ERROR',
            rejectionNote: parsed.data.note ?? 'إبطال بعد إشكال إدخال',
            version: { increment: 1 },
          },
        });
      }

      await tx.orderNote.create({
        data: {
          companyId,
          orderId: issue.orderId,
          authorId: user.id,
          kind: 'internal',
          body:
            parsed.data.action === 'correct'
              ? `تم تصحيح بيانات الإدخال وإعادة الطلب للطابور${parsed.data.note ? `: ${parsed.data.note}` : ''}`
              : `إبطال الطلب بعد إشكال إدخال${parsed.data.note ? `: ${parsed.data.note}` : ''}`,
        },
      });
      return updated;
    });

    await logAudit({
      companyId, userId: user.id,
      action: parsed.data.action === 'correct' ? 'ORDER_ISSUE_CORRECTED' : 'ORDER_VOIDED_AFTER_ISSUE',
      entity: 'Order', entityId: issue.orderId,
      newData: { issueId: id, note: parsed.data.note ?? null },
    });

    return NextResponse.json({ issue: result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
