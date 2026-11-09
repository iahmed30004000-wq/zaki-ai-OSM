import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { BULK_DELIVER_MOST } from '@/lib/parcel-tracking/bulk-deliver';
import { deliverMany } from '@/lib/parcel-tracking/deliver-many';

/**
 * POST /api/ops/tracking/deliver-many — «استلم» for a page of parcels, ONLY for the ones the delivery company itself
 * calls «تم التوصيل».
 *
 * Body: `{ orderIds: string[] }` — one to fifty ids; a repeated id is judged once.
 * Answer: `{ results: [{ orderId, orderNumber, ok, reason? }], delivered, refused }` — one line per parcel, in the order
 * asked. A request that is well formed is ALWAYS answered 200, even when every parcel is refused: the refusals are the
 * answer, not an error of the request.
 *
 * The key is the single door's own (`ops.deliver`) — nobody gains a box by this door, and the follow-up list's sight
 * rules still decide which parcels a person ever sees. Everything else is decided PER PARCEL, on the server, at the
 * moment of the press (`lib/parcel-tracking/deliver-many.ts`): the company's newest word, the parcel's state, its
 * store. The screen's ticks are manners; this is the rule.
 *
 * It records what `POST /api/ops/tracking/deliver` records for `outcome: 'ALL'`, through the same function, and writes
 * no money: the amount comes from the company's statement.
 */
const schema = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(BULK_DELIVER_MOST),
});

export async function POST(req: Request) {
  try {
    // The store too: an id from another store of the same company is not found, exactly as at the single door.
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('ops.deliver');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const report = await deliverMany(db, {
      companyId,
      storeId,
      userId: user.id,
      minorUnit: country.minorUnit,
      orderIds: parsed.data.orderIds,
    });

    // ONE line for the press, listing the parcels it recorded; each recorded order also carries its own line on its
    // timeline (written by the shared function). A press that recorded nothing changed nothing, so it leaves no line.
    if (report.delivered > 0) {
      await logAudit({
        companyId, userId: user.id, action: 'BULK_DELIVERY_RECORDED',
        entity: 'Store', entityId: storeId,
        newData: {
          delivered: report.delivered,
          refused: report.refused,
          orderIds: report.results.filter((r) => r.ok).map((r) => r.orderId),
          refusedOrderIds: report.results.filter((r) => !r.ok).map((r) => r.orderId),
        },
      });
    }

    return NextResponse.json(report);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
