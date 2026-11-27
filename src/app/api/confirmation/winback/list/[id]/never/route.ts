import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';

/**
 * POST /api/confirmation/winback/list/[id]/never — «إلغاء نهائي» on «قايمة الاسترجاع» (the owner, 26/11): «الزبون ما بيرجع ينعرض
 * بالاسترجاع مرة تانية أبداً».
 *
 * Marks the order's CUSTOMER (`Customer.winbackNeverAt`), so no win-back view, hand-out or daily list reads him again
 * (`WINBACK_NOT_NEVER`). It does not end the order: the screen ends it right after through the confirmation door
 * («رفض» with the reason she picked), the one door every end goes through. Marked first on purpose: if the end is refused
 * (a colleague changed the order), the customer she closed for good stays closed, and she ends the order again.
 *
 * Who: the agent holding the order on her list, or a manager (`orders.assign` + `confirmation.winback`) — the same pair the
 * pieces switch admits. Only a win-back order (`winbackListAt`). Body: nothing. Idempotent: a second press keeps the first date.
 */
const refuse = (errorAr: string, code: string, status: number) => NextResponse.json({ error: errorAr, errorAr, code }, { status });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.work');
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown> | null;
    if (body && typeof body === 'object' && Object.keys(body).length > 0) return refuse('ما بدها شي بالطلب.', 'INVALID_BODY', 400);

    const order = await db.order.findFirst({
      where: { id, companyId, ...(storeId ? { storeId } : {}) },
      select: { id: true, orderNumber: true, customerId: true, claimedById: true, winbackListAt: true, winbackListUserId: true },
    });
    if (!order) return refuse('الطلب مش موجود.', 'NOT_FOUND', 404);
    if (!order.winbackListAt) return refuse('هاد مش طلب من قايمة الاسترجاع.', 'NOT_A_LIST_ORDER', 409);

    const holder = order.claimedById === user.id && order.winbackListUserId === user.id;
    const manager = can(user, 'orders.assign') && can(user, 'confirmation.winback');
    if (!holder && !manager) return refuse('بس صاحبة القايمة أو المدير بيلغي نهائي.', 'NOT_YOURS', 403);

    const now = new Date();
    const marked = await db.customer.updateMany({
      where: { id: order.customerId, companyId, winbackNeverAt: null },
      data: { winbackNeverAt: now, winbackNeverById: user.id },
    });
    if (marked.count === 1) {
      await db.orderActivity.create({
        data: { companyId, orderId: order.id, userId: user.id, action: 'WINBACK_NEVER', metadata: JSON.stringify({ customerId: order.customerId }) },
      });
      await logAudit({
        companyId,
        userId: user.id,
        action: 'WINBACK_CUSTOMER_NEVER',
        entity: 'Customer',
        entityId: order.customerId,
        previousData: { winbackNeverAt: null },
        newData: { winbackNeverAt: now, orderNumber: order.orderNumber },
      });
    }
    return NextResponse.json({ ok: true, already: marked.count === 0 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
