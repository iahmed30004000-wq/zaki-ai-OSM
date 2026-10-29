import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { holdReservation } from '@/lib/shipment-hold';
import { releaseOrderLines, reserveOrderLines } from '@/lib/reservation';
import { hasEverShipped } from '@/lib/order-state';

/**
 * POST /api/ops/shipments/hold — keep an order out of today's shipment.
 *
 * The customer rings before the parcel joins a batch: "not this week, my
 * brother is travelling". The order is confirmed and correct; it simply
 * must not go out yet.
 *
 * The two alternatives were both wrong. Cancelling throws away a good sale
 * and releases stock somebody still wants. Leaving it alone means it goes
 * out on the next shipment anybody builds, because nothing on the screen
 * says otherwise.
 *
 * NOT the confirmation postpone. That one means "call them back on
 * Thursday" and belongs to the agent on the phone. This means "do not put
 * it in a van yet" and belongs to whoever builds the shipment. One column
 * doing both would make each one lie about the other.
 *
 * ── THE GOODS DO NOT STAY RESERVED ──
 *
 * They used to, and the owner ruled it out: «وما تحجز رصيد الا بعد ما اشيلو
 * من التأجيل وارجعو لانشاء شحنة». A postponement froze its units for its
 * whole length, so a hopeful date took stock off the shelf that a customer
 * ready to buy today could not be sold — decided by somebody who had not
 * spoken to the customer. Now the units go back on sale, and they are taken
 * again when the hold is lifted, against whatever is actually there.
 *
 * The one exception is a parcel already out of the warehouse: its units are
 * packed under this order's name and are not on any shelf. See
 * `lib/shipment-hold`, which owns that question.
 */

/**
 * UNTIL WHEN — and there is no longer an «omitted» case.
 *
 * A RELEASE carries no date, so the two shapes are separate rather than one
 * shape with everything optional: «lift this hold» and «hold this until
 * Thursday» are different requests, and a schema that accepts both with all
 * fields optional accepts neither properly.
 */
const schema = z.union([
  z.object({ orderId: z.string().uuid(), release: z.literal(true) }),
  z.object({
    orderId: z.string().uuid(),
    /**
   *
     * The date was optional, and a missing one stored the year 2999. That is
     * not an open-ended hold, it is a lost order: `shipHoldUntil` is read by
     * two files, the shipment list simply excludes anything held, and
     * nothing anywhere brings a held order back or says out loud that it is
     * waiting. A parcel held «for now» by somebody who then went on leave
     * was gone, with its stock still reserved against it.
     *
     * Every hold now ends on a day, and on that day the order reappears in
     * the shipment list by itself — `shipHoldUntil <= now` is already how
     * that list is filtered, so the date was always the mechanism. Nothing
     * ever asked for it.
     */
    until: z.string().datetime({ offset: true }).or(z.string().datetime()),
    reason: z.string().trim().max(300).optional(),
    release: z.literal(false).optional(),
  }),
]);

/** A hold longer than this is not a delayed shipment, it is a stopped order. */
export const MAX_HOLD_DAYS = 30;

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('ops.ship');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const data = parsed.data;
    const orderId = data.orderId;
    const release = 'release' in data && data.release === true;
    const until = release ? null : (data as { until: string }).until;
    const reason = release ? undefined : (data as { reason?: string }).reason;

    /**
     * THE DATE HAS TO BE A DATE, AND NOT A YEAR FROM NOW.
     *
     * The cap is no longer about frozen stock — the goods go back on sale
     * now. It is about the order: a shipment postponed for six months is not
     * a delayed shipment, it is an abandoned sale nobody is reading, and the
     * honest instrument for that is to stand it down and talk to the
     * customer again.
     */
    if (!release) {
      const due = new Date(until as string);
      const maxAt = Date.now() + MAX_HOLD_DAYS * 86_400_000;
      if (isNaN(due.getTime()) || due.getTime() < Date.now() - 60_000) {
        return NextResponse.json({ error: 'موعد الإفراج يجب أن يكون في المستقبل' }, { status: 400 });
      }
      if (due.getTime() > maxAt) {
        return NextResponse.json(
          {
            error:
              `التأجيل لا يتجاوز ${MAX_HOLD_DAYS} يوماً — أطولُ من ذلك ليس تأجيلَ شحنٍ بل طلبٌ متروك. ` +
              'لمدّةٍ أطول أعِده إلى المتابعة ليتكلّم أحدٌ مع الزبون من جديد.',
            code: 'HOLD_TOO_LONG',
          },
          { status: 400 }
        );
      }
    }

    const order = await db.order.findFirst({
      where: { id: orderId, companyId, storeId },
      select: {
        id: true,
        orderNumber: true,
        confirmationStatus: true,
        shippingStatus: true,
        shippingBatchId: true,
        shipHoldUntil: true,
        // The version the page was read at: lifting a hold writes it back as
        // a condition, so a stale screen cannot re-reserve an order that has
        // moved on since.
        version: true,
        // What `hasLeftWarehouse` reads: units already packed under this
        // order's name are not on a shelf anybody else can be sold from.
        shippedAt: true,
        labelPrintedAt: true,
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });

    // Once it is on a trolley the hold is the wrong instrument: the parcel
    // has to come off the batch first, and that is a different decision
    // with a different audit trail.
    if (!release && order.shippingBatchId) {
      return NextResponse.json(
        {
          error: 'الطلب دخل دفعة شحن — أخرجه من الدفعة أولاً، أو ألغِه إن كان الزبون تراجع.',
          code: 'ALREADY_BATCHED',
        },
        { status: 409 }
      );
    }

    /**
     * LIFTING A HOLD RESERVES THE GOODS AGAIN — SO ONLY FOR AN ORDER THAT CAN HOLD THEM.
     *
     * The release took the order's id and nothing else: an order cancelled
     * or rejected while it sat held got its units reserved by a click on a
     * stale «held» list, and a parcel already gone had stock reserved for
     * it a second time. The order must still be a confirmed one that has
     * not left; the write below also repeats the version.
     */
    if (release) {
      const reservable = order.confirmationStatus === 'CONFIRMED' && !hasEverShipped(order as never) && order.shippingStatus !== 'CANCELLED';
      if (!reservable) {
        return NextResponse.json(
          { error: 'الطلب ما عاد مؤكَّد أو انشحن — ما في شي يرجع ينحجز له. حدّث القائمة.', code: 'NOT_RESERVABLE' },
          { status: 409 }
        );
      }
    }

    /**
     * THE STOCK AND THE HOLD MOVE TOGETHER OR NOT AT ALL.
     *
     * One transaction, because the two halves contradict each other if only
     * one lands: an order marked postponed with its units still reserved is
     * the behaviour the owner removed, and units released with no hold
     * recorded is a sale whose goods somebody else can take while it still
     * sits in today's shipment list.
     */
    const reservation = holdReservation(order as never);
    const updated = await db.$transaction(async (tx) => {
      const row = await tx.order.update({
        where: { id: order.id, version: order.version },
        data: release
          ? { shipHoldUntil: null, shipHoldReason: null, version: { increment: 1 } }
          : {
              shipHoldUntil: new Date(until as string),
              shipHoldReason: reason?.trim() || null,
              version: { increment: 1 },
            },
        select: { id: true, orderNumber: true, shipHoldUntil: true, shipHoldReason: true },
      });
      if (release) {
        // Back in the shipment list, so its units are taken again — against
        // what is on the shelf NOW. A shortage is not hidden: the lines stay
        // short and `shipmentBlocks` refuses the shipment by name.
        await reserveOrderLines(tx, order.id, { allowNegativeStock: country.allowNegativeStock });
      } else if (reservation.releases) {
        await releaseOrderLines(tx, order.id);
      }
      return row;
    });

    await db.orderActivity.create({
      data: {
        companyId,
        orderId: order.id,
        userId: user.id,
        action: release ? 'SHIP_HOLD_RELEASED' : 'SHIP_HOLD_SET',
        metadata: JSON.stringify({
          until: until ?? null,
          reason: reason ?? null,
          // What happened to the goods, in the order's own timeline — so
          // «why is this stock free» has an answer months later.
          stock: release ? 'RESERVED_AGAIN' : reservation.releases ? 'RELEASED' : 'KEPT',
        }),
      },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: release ? 'SHIP_HOLD_RELEASED' : 'SHIP_HOLD_SET',
      entity: 'Order',
      entityId: order.id,
      previousData: { shipHoldUntil: order.shipHoldUntil },
      newData: { shipHoldUntil: updated.shipHoldUntil, reason: reason ?? null },
    });

    return NextResponse.json({
      order: updated,
      message: release
        ? `${order.orderNumber} عاد إلى قائمة الشحن، وحُجزت بضاعتُه من جديد.`
        : `${order.orderNumber} مؤجَّل حتى ${String(until).slice(0, 10)} — ويعود إلى قائمة الشحن يومَها وحده. ${reservation.why}.`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
