import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { verifyLabelBatch } from '@/lib/labels';
import { COURIER_KIND_SELECT, printRefusal } from '@/lib/waybill';
import { logAudit } from '@/lib/audit';

/**
 * POST /api/ops/labels/printed  { t, orderIds }
 *
 * The print page reports what it actually sent to the printer, and only
 * those orders are stamped labelPrintedAt — the moment a label becomes the
 * address the driver holds, the order is sealed and a cancellation becomes
 * a return.
 *
 * The page may only report orders its own token names: an id that is not
 * in the token (or, for a batch token, not in that batch) is ignored, so
 * this cannot seal an order somebody merely knows the id of. Orders that
 * may not be printed are ignored too.
 *
 * The FIRST print is the commitment. A reprint — a torn label, a second
 * copy — does not move the timestamp.
 */
const schema = z.object({
  t: z.string().min(10).max(20_000),
  orderIds: z.array(z.string().uuid()).min(1).max(1000),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.labels');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'طلب غير صالح' }, { status: 400 });

    const batch = await verifyLabelBatch(parsed.data.t);
    if (!batch) return NextResponse.json({ error: 'رابط الطباعة غير صالح أو منتهٍ' }, { status: 400 });
    if (!storeId || batch.storeId !== storeId) {
      return NextResponse.json({ error: 'رابط الطباعة يخص متجراً آخر' }, { status: 403 });
    }

    // Only what this token names.
    const named = batch.batchId ? null : new Set(batch.orderIds);
    const asked = parsed.data.orderIds.filter((id) => (named ? named.has(id) : true));
    if (asked.length === 0) return NextResponse.json({ stamped: 0 });

    const orders = await db.order.findMany({
      where: {
        id: { in: asked },
        companyId,
        storeId,
        ...(batch.batchId ? { shippingBatchId: batch.batchId } : {}),
      },
      select: {
        id: true, confirmationStatus: true, shippingStatus: true, deliveryProviderId: true,
        trackingNumber: true, deliveryProvider: { select: COURIER_KIND_SELECT },
      },
    });
    const printable = orders.filter((o) => !printRefusal(o)).map((o) => o.id);
    if (printable.length === 0) return NextResponse.json({ stamped: 0 });

    const { count } = await db.order.updateMany({
      where: { id: { in: printable }, companyId, storeId, labelPrintedAt: null },
      data: { labelPrintedAt: new Date() },
    });

    /**
     * A WAYBILL IS CUSTOMER DATA ON PAPER.
     *
     * Every sheet carries a name, a phone and an address, and paper walks
     * out of a building more easily than a database does. The order itself
     * already remembers WHEN it was printed; it has never remembered by
     * whom, so "two hundred labels were printed on Friday night" was a fact
     * with nobody attached to it.
     *
     * One row, with the count and the person. Not the orders, not the
     * names - the audit trail must not become the second copy.
     */
    await logAudit({
      companyId,
      userId: user.id,
      action: 'LABELS_PRINTED',
      entity: 'Order',
      entityId: batch.batchId ?? `labels:${count}`,
      newData: { printed: count, asked: asked.length, batchId: batch.batchId ?? null, withContact: true },
    });

    return NextResponse.json({ stamped: count });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
