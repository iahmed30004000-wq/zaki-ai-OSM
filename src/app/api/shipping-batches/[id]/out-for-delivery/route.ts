import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { moveBatchOutForDelivery } from '@/lib/batch-out-for-delivery';

/**
 * POST /api/shipping-batches/:id/out-for-delivery — «خرج للتوصيل لكل الدفعة».
 *
 * Moves every parcel of the batch that is «مشحون» to «خرج للتوصيل», the way the order's own door does for one parcel
 * (`/api/orders/:id/shipping`, `transition`) — see `lib/batch-out-for-delivery.ts` for what is asked of each parcel and what is
 * written. A parcel of the batch that is not «مشحون» is counted and left alone; one that cannot move is named and the rest go.
 *
 * It moves the status of orders AND it is the batches screen's press, so it asks both keys, every time:
 *   · `ops.batches` — the batches screen's own key, as the batch's read and its export ask it;
 *   · `orders.change_status` — the key of the order's door, which this is a repetition of. The scope that key holds is asked
 *     again of EACH parcel inside the move (an order that is not hers is named, not moved).
 * The batch is read inside the session's company and store; the answer has no customer in it, only order numbers.
 *
 * Body: none. Answer: `{ success, total, moved, skipped, failed, failedOrders, failures }`.
 */
const NO_BATCHES = 'دفعات الشحن ليست من صلاحيّاتك.';
const NO_MOVE = 'تحريك حالة الشحن ليس من صلاحيّاتك — تحتاج «تغيير حالة الشحن». اطلبها من مدير النظام إن كانت من عملك.';
const NO_SUCH_BATCH = 'الدفعة غير موجودة. أعد تحميل القائمة.';
const EMPTY = 'الدفعة فاضية — ما في طرد يتحرّك.';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    if (!can(user, 'ops.batches')) return NextResponse.json({ error: NO_BATCHES, errorAr: NO_BATCHES }, { status: 403 });
    if (!can(user, 'orders.change_status')) return NextResponse.json({ error: NO_MOVE, errorAr: NO_MOVE }, { status: 403 });

    const batch = await db.shippingBatch.findFirst({
      where: { id, companyId, storeId },
      select: { id: true, batchNumber: true },
    });
    if (!batch) return NextResponse.json({ error: NO_SUCH_BATCH, errorAr: NO_SUCH_BATCH }, { status: 404 });

    const result = await moveBatchOutForDelivery({ user, companyId, storeId, batch });
    if (result.total === 0) {
      return NextResponse.json({ error: EMPTY, errorAr: EMPTY, code: 'EMPTY_BATCH' }, { status: 409 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
