import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { authorises } from '@/lib/change-request-apply';
import { holdFromTrolley } from '@/lib/order-cancel';
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
  /**
   * AN APPROVED «أجّل الطلب» REQUEST, CARRIED OUT.
   *
   * The id and nothing else: the date and the reason come from what was
   * approved, on the server. A postponement is a HOLD — the order stays
   * confirmed and goes out on its day — not an un-confirmation: the customer
   * already said yes, and wants a later day, not a second call.
   */
  z.object({ orderId: z.string().uuid(), changeRequestId: z.string().uuid() }),
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

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const data = parsed.data;
    const orderId = data.orderId;
    const release = 'release' in data && data.release === true;
    const changeRequestId = 'changeRequestId' in data ? data.changeRequestId : undefined;
    let until: string | null = release || changeRequestId ? null : (data as { until: string }).until;
    let reason: string | undefined = release || changeRequestId ? undefined : (data as { reason?: string }).reason;

    /**
     * WHO MAY: the packing table, or a decision that says so.
     *
     * The approved request does not widen `ops.ship`, it stands beside it, and
     * it is read from the database rather than believed — the same rule the
     * stand-down door states for the same reason.
     */
    let viaRequest: { id: string } | null = null;
    if (changeRequestId) {
      const request = await db.orderChangeRequest.findFirst({
        where: { id: changeRequestId, companyId },
        select: { id: true, orderId: true, status: true, appliedAt: true, intent: true, reason: true, postponeUntil: true },
      });
      if (!request) return NextResponse.json({ error: 'طلب التعديل غير موجود' }, { status: 404 });
      const verdict = authorises(request, 'POSTPONE', orderId);
      if (!verdict.ok) {
        return NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status });
      }
      if (!can(user, 'control.change_requests') && !can(user, 'ops.ship')) {
        return NextResponse.json({ error: 'لا تملك صلاحية تنفيذ هذا القرار' }, { status: 403 });
      }
      if (!request.postponeUntil) {
        return NextResponse.json({ error: 'طلب التأجيل بلا موعد', code: 'NO_DATE' }, { status: 409 });
      }
      until = request.postponeUntil.toISOString();
      reason = request.reason;
      viaRequest = { id: request.id };
    } else {
      await requirePermission('ops.ship');
    }

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

    /**
     * ON A TROLLEY: THE HOLD TAKES IT OFF, AND KEEPS THE GOODS AND THE LABEL.
     *
     * This used to refuse («أخرجه من الدفعة أولاً») — and there was no door
     * that did. Until «إغلاق الشحنة — سُلّمت للشركة» the parcel is still ours
     * (M6), so the hold is the way to say «not this trolley». The box is not
     * opened: no attestation and no stock moves. A parcel the company already
     * has a barcode for is cancelled THERE first — postponing an API parcel is
     * cancelling it now and sending it again later.
     */
    if (!release && order.shippingBatchId) {
      const held = await holdFromTrolley({
        orderId: order.id,
        companyId,
        storeId,
        by: { id: user.id, name: user.name, role: user.role },
        until: new Date(until as string),
        reason: reason?.trim() || null,
        viaRequest,
      });
      if (!held.ok) {
        return NextResponse.json({ error: held.error, errorAr: held.error, code: held.code }, { status: held.status });
      }
      await db.orderActivity.create({
        data: {
          companyId,
          orderId: order.id,
          userId: user.id,
          action: 'SHIP_HOLD_SET',
          metadata: JSON.stringify({ until, reason: reason ?? null, stock: 'KEPT', fromTrolley: true }),
        },
      });
      await logAudit({
        companyId,
        userId: user.id,
        action: 'SHIP_HOLD_SET',
        entity: 'Order',
        entityId: order.id,
        previousData: { shipHoldUntil: order.shipHoldUntil },
        newData: { shipHoldUntil: until, reason: reason ?? null, fromTrolley: true },
      });
      return NextResponse.json({
        order: { id: order.id, orderNumber: held.orderNumber, shipHoldUntil: until, shipHoldReason: reason ?? null },
        message:
          `${held.orderNumber} خرج من الدفعة ومؤجَّل حتى ${String(until).slice(0, 10)} — بضاعته وبوليصته محفوظتان.` +
          `${held.courierCancelled ? ' وألغينا الطرد عند الشركة، وبينرسل من جديد بيومه.' : ''}`,
      });
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
          ? {
              // A PACKED parcel (still READY_FOR_PICKUP, off its trolley) is found again by the shipment list
              // through its hold date, so releasing it moves the date to now instead of erasing it.
              shipHoldUntil: order.shippingStatus === 'READY_FOR_PICKUP' && !order.shippingBatchId ? new Date() : null,
              shipHoldReason: null,
              version: { increment: 1 },
            }
          : {
              shipHoldUntil: new Date(until as string),
              shipHoldReason: reason?.trim() || null,
              version: { increment: 1 },
            },
        select: { id: true, orderNumber: true, shipHoldUntil: true, shipHoldReason: true },
      });
      if (viaRequest) {
        // ONCE: `appliedAt: null` makes a second, concurrent carry-out a no-op.
        await tx.orderChangeRequest.updateMany({
          where: { id: viaRequest.id, appliedAt: null },
          data: { appliedAt: new Date(), appliedById: user.id },
        });
      }
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
