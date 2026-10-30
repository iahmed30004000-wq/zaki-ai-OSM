import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { TRACKING_ACK_ACTION, type TrackingAlertKind } from '@/lib/parcel-tracking/alert';

/**
 * POST /api/ops/tracking/acknowledge — «رأيتُ هذا».
 *
 * The tracking row turns red when its order was cancelled while the parcel
 * is still moving, and orange when an approved change was written onto it.
 * A colour anybody can dismiss teaches people to dismiss it, so this is not
 * a dismissal: it records WHO saw it and WHEN, on the order, beside
 * everything else that happened to it.
 *
 * IT MOVES NOTHING. No status, no money, no stock — which is why it needs
 * `ops.track` and nothing more. Deciding what to DO about a cancelled
 * parcel is the transfer and write-off doors, and they have their own
 * guards.
 */

const schema = z.object({
  orderId: z.string().uuid(),
  /** Recorded so the log says what was seen, not merely that something was. */
  kind: z.enum(['CANCELLED', 'CHANGED']),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.track');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    // Scoped like every other read of an order: another store's row is not
    // found rather than forbidden.
    const order = await db.order.findFirst({
      where: { id: parsed.data.orderId, companyId, storeId },
      select: { id: true, orderNumber: true },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });

    const kind = parsed.data.kind as TrackingAlertKind;
    await db.orderActivity.create({
      data: {
        companyId,
        orderId: order.id,
        userId: user.id,
        action: TRACKING_ACK_ACTION,
        metadata: JSON.stringify({ kind, at: new Date().toISOString(), by: user.name ?? null }),
      },
    });

    return NextResponse.json({ ok: true, orderNumber: order.orderNumber });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
