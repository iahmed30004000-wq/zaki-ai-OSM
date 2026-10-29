import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { restoreOrderStock } from '@/lib/stock-consumption';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { redactCustomerForWarehouse } from '@/lib/operations';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { resolveDeliveryFee } from '@/lib/delivery-fees';
import { roundMinor } from '@/lib/money';
import { zodMessage } from '@/lib/zod-message';
import { reverseForOrder } from '@/lib/commission';
import {
  completionOf, doorUnits, expectedBackTotal, extraAction, needsExtraAction, settledLines,
} from '@/lib/partial-delivery';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { readLimit, readPage } from '@/lib/numeric-input';
import { readOrderPage } from '@/lib/paged-read';
import { PENDING_ORDER_BY, RECEIVED_ORDER_BY, daysWaitedOf, returnsFilters, sinceOf, viewScope } from '@/lib/returns-filters';
import { returnsFacts } from '@/lib/returns-list';
import { nothingCameBack, receiptNothingCameBackWhere } from '@/lib/written-off';

/**
 * Return receiving.
 *
 *   GET  /api/ops/returns?q=          returns announced but not yet received
 *   POST /api/ops/returns             record one physical receipt
 *
 * Nothing re-enters stock before the count-and-inspect acknowledgement: the
 * acknowledgement is required by the schema, and the stock movement is
 * written in the same transaction as the receipt. Missing units are computed
 * (expected - received - damaged), never typed by the receiver.
 *
 * THIS DESK SETTLES ONE HALF OF A PARTIAL DELIVERY — «مرة بيتمم للمستلم
 * ومرة للطلب الراجع». The other half is the money the customer paid at the
 * door, and it arrives with the courier's statement. Both endpoints report
 * `completion` so that nobody reads a half-settled order as a finished one:
 * the rule is `completionOf` in lib/partial-delivery.ts, and the screen reads
 * the same function.
 */

const receiveSchema = z.object({
  orderId: z.string().uuid(),
  receivedQty: z.number().int().min(0).max(10_000),
  damagedQty: z.number().int().min(0).max(10_000).default(0),
  /** Must be true: the receiver states they counted and inspected the goods. */
  countedAndInspected: z.literal(true, { message: 'يلزم إقرار العد والفحص قبل الاستلام' }),
  chargeCourierFee: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
});

/**
 * READ IN PAGES, ONE VIEW AT A TIME, WITH WHAT THE CLERK CHOSE.
 *
 * «المرتجعات — صفحات + فلاتر + بحث». The pages were already here (#42); the choices were not.
 *
 *   ?view=pending|received       the parcels waiting to be counted in (default) · the ones that were
 *   ?status=<state>              RETURN_REQUESTED · RETURNED · FAILED_DELIVERY · PARTIALLY_DELIVERED   (pending only)
 *   ?courier=<id>|none           which delivery company carried it, or none
 *   ?age=fresh|few|week|old      how long since the courier last spoke of it                          (pending only)
 *   ?q=                          order number, reference, waybill, the customer's name — and phone, for whoever may read phones
 *   ?page= ?limit=               25 a page, 100 at most
 *
 * An unknown value is a 400 in Arabic, never a quiet «everything». The scope (company, store, the view) is spread at
 * the top of the question and what was chosen is ANDed onto it, so no choice can widen what the person is allowed to
 * see; the count and the rows are asked of that same `where`.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.returns');
    const maySeeContact = can(user, 'customers.view');

    const searchParams = new URL(req.url).searchParams;
    const now = new Date();

    const parsed = returnsFilters(searchParams, { now, maySeeContact });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorAr: parsed.errorAr }, { status: 400 });

    const scope = { companyId, storeId };
    // The scope stays at the TOP of the question — spread, never nested — and what was chosen is ANDed onto it.
    const where = { ...viewScope(parsed.view, scope), AND: parsed.clauses };
    const limit = readLimit(searchParams, 25, 100);
    const pending = parsed.view === 'pending';

    /*
     * Clamped to the last page that exists. Asking for page 9 of 3 is what a bookmark becomes after the queue is
     * worked down, and an empty screen reads as «there are no returns» — which is a lie about the three on page 3.
     */
    const [list, facts] = await Promise.all([
      readOrderPage<Record<string, any>>(db, {
        where,
        orderBy: pending ? PENDING_ORDER_BY : RECEIVED_ORDER_BY,
        page: readPage(searchParams),
        limit,
        select: {
          id: true, orderNumber: true, merchantRef: true, trackingNumber: true,
          shippingStatus: true, settlementStatus: true, returnReason: true, returnedAt: true,
          // The other three places a parcel's moment can live — read to say how long it has waited, not sent on.
          failedAt: true, deliveredAt: true, updatedAt: true,
          regionId: true, deliveryProviderId: true,
          customer: { select: { fullName: true, phone: true } },
          region: { select: { id: true, name: true } },
          deliveryProvider: { select: { id: true, name: true } },
          items: { select: { id: true, productName: true, quantity: true, freeQuantity: true, deliveredQty: true, productId: true } },
          // The record of the count — only the record view shows it.
          ...(pending
            ? {}
            : {
                returnReceipt: {
                  select: {
                    expectedQty: true, receivedQty: true, damagedQty: true, missingQty: true,
                    courierFeeCharged: true, inspectedById: true, inspectedAt: true, note: true,
                  },
                },
              }),
        },
      }),
      returnsFacts(db, { scope, view: parsed.view, now }),
    ]);
    const orders = list.rows;

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'قائمة المرتجعات', rows: orders });

    /** Who counted each parcel in — the names of the page's inspectors, in one read. */
    const inspectorIds = pending
      ? []
      : [...new Set(orders.map((o) => o.returnReceipt?.inspectedById as string | undefined).filter((id): id is string => !!id))];
    const inspectors = new Map(
      (inspectorIds.length > 0
        ? await db.user.findMany({ where: { id: { in: inspectorIds }, companyId }, select: { id: true, name: true } })
        : []
      ).map((u) => [u.id, u.name])
    );

    return NextResponse.json({
      count: orders.length,
      /*
       * The page, beside the rows. `count` is what is ON this page and
       * `pagination.total` is how many there are — two different facts
       * that a single number was being asked to carry.
       */
      pagination: { total: list.total, page: list.page, limit: list.limit, totalPages: list.totalPages },
      facts,
      applied: parsed.applied,
      // `items` is deliberately NOT spread out below: `lines` is the same
      // fact in the shape the desk needs, and shipping both invites the
      // screen to reach for the raw one again.
      orders: orders.map(({ items, returnReceipt, failedAt, deliveredAt, updatedAt, ...o }) => {
        const customer = redactCustomerForWarehouse(o.customer, maySeeContact);
        if (!pending) {
          // A record: what was counted, by whom and when. No lines, no extra action — nothing here can be received again.
          return {
            ...o,
            customer,
            receipt: returnReceipt
              ? { ...returnReceipt, inspectedBy: inspectors.get(returnReceipt.inspectedById) ?? null }
              : null,
          };
        }
        const units = doorUnits(items);
        // Every row in this list is a return that has NOT been received yet,
        // so the goods half is open by construction.
        const completion = completionOf({
          deliveredUnits: units.delivered,
          refusedUnits: units.refused,
          settlementStatus: o.settlementStatus,
          hasReturnReceipt: false,
        });
        return {
          ...o,
          customer,
          expectedQty: expectedBackTotal(items),
          /** Whole days since the courier last spoke of it — the number the age filter's piles are cut from. */
          daysWaited: daysWaitedOf(sinceOf({ returnedAt: o.returnedAt, failedAt, deliveredAt, updatedAt }), now),
          /**
           * WHICH PRODUCT, AND HOW MANY OF IT, IS COMING BACK.
           *
           * The clerk holds the parcel while reading this. The list used to
           * print every line at its full shipped quantity — «ماء الكمأ × 3»
           * for an order where the customer kept two — so the list and the
           * total in the next column said different things about the same
           * parcel, and the list was the one a person believes.
           */
          lines: settledLines(items),
          completion,
          /**
           * THE EXTRA ACTION, DECIDED HERE AND WORDED HERE.
           *
           * The dialog renders what this says rather than deciding for
           * itself, the same way the collect dialog adds up the server's
           * `expectedCollection` instead of re-deriving it. Two copies of one
           * rule is how the list and the total came to disagree in the first
           * place.
           */
          action: needsExtraAction(items) ? extraAction(completion, 'GOODS') : null,
        };
      }),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('ops.returns');

    const parsed = receiveSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;

    const order = await db.order.findFirst({
      where: { id: input.orderId, companyId, storeId },
      select: {
        id: true, orderNumber: true, shippingStatus: true, settlementStatus: true,
        regionId: true, deliveryProviderId: true,
        returnReceipt: { select: { id: true, receivedQty: true, damagedQty: true, missingQty: true, courierFeeCharged: true } },
        items: { select: { id: true, productId: true, productName: true, quantity: true, freeQuantity: true, deliveredQty: true } },
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });
    /*
     * A RECEIPT THAT SAYS NOTHING CAME BACK IS NOT THE END OF THE PARCEL.
     *
     * A write-off, and a zero count at this desk, both leave a receipt of received 0, damaged 0 and everything
     * missing. If the parcel turns up after all, this call COMPLETES that same receipt — one receipt per order —
     * instead of being refused as «already received». A second zero count, or any receipt that already holds
     * units, is still refused.
     */
    const completing = !!order.returnReceipt && nothingCameBack(order.returnReceipt) && input.receivedQty + input.damagedQty > 0;
    if (order.returnReceipt && !completing) {
      return NextResponse.json({ error: 'تم استلام هذا المرتجع مسبقاً', code: 'ALREADY_RECEIVED' }, { status: 409 });
    }
    /**
     * A DELIVERED ORDER WHOSE MONEY IS SETTLED HAS NOTHING COMING BACK.
     *
     * The returns list never offers one, but the door took any order id: a
     * call straight to the API rewrote a delivered, settled order as RETURNED
     * and reversed the commission it had earned — a sale undone by a typed
     * order number. If goods really did come back, that is a correction the
     * statement or the finance door makes, with its own record.
     */
    if (order.shippingStatus === 'DELIVERED' && order.settlementStatus === 'SETTLED') {
      return NextResponse.json(
        {
          error: 'هالطلب انسلّم وانسوّى حسابه — ما في مرتجع ليتسجّل عليه',
          errorAr: 'هالطلب انسلّم وانسوّى حسابه — ما في مرتجع ليتسجّل عليه',
          code: 'DELIVERED_AND_SETTLED',
        },
        { status: 409 }
      );
    }

    const expectedQty = expectedBackTotal(order.items);
    if (input.receivedQty + input.damagedQty > expectedQty) {
      return NextResponse.json(
        { error: `الكمية المستلمة أكبر من المشحونة (${expectedQty})`, code: 'OVER_RECEIVED' },
        { status: 400 }
      );
    }
    const missingQty = expectedQty - input.receivedQty - input.damagedQty;

    /**
     * THE HALF THIS RECEIPT CLOSES, AND THE ONE IT DOES NOT.
     *
     *   «واذا اتمم واحد فهو اتمم جزءي، ما بنغلق غير كامل»
     *
     * Computed from the facts as they will stand once the transaction below
     * lands: the goods half is settled by the receipt this request writes.
     * The money half is not this desk's to settle and is untouched here —
     * it closes when the courier's statement is reconciled.
     *
     * Pure, and computed before the write rather than read back after it, so
     * the sentence in the note and the sentence in the response are the same
     * sentence and cannot drift apart.
     */
    const units = doorUnits(order.items);
    const completion = completionOf({
      deliveredUnits: units.delivered,
      refusedUnits: units.refused,
      settlementStatus: order.settlementStatus,
      hasReturnReceipt: true,
    });

    // The courier's return fee comes from the fee table of this region and
    // courier — it is never typed in by the receiver.
    let courierFeeAmount = 0;
    if (input.chargeCourierFee && order.deliveryProviderId) {
      const fee = await resolveDeliveryFee(db, {
        deliveryProviderId: order.deliveryProviderId,
        regionId: order.regionId,
        minorUnit: country.minorUnit,
      });
      /**
       * A CONFIGURED ZERO IS A ZERO.
       *
       * This was `fee.returnFee || fee.fee`. By the time the value reaches
       * this line it is a plain `number` and nothing else: `ResolvedFee`
       * declares `returnFee: number`, `delivery_fees.returnFee` is NOT NULL
       * DEFAULT 0, and `resolveDeliveryFee` hands back
       * `roundMinor(Number(row.returnFee), minorUnit)`. So the ONLY falsy
       * value it can hold is a real, configured 0 — «we charge nothing to
       * carry goods back» — and `||` read that as «absent» and billed the
       * courier the whole OUTBOUND fee instead.
       *
       * Measured on the live database, 2026-10-02: 13 of 25 active fee rows
       * hold returnFee 0 with fee > 0, and 0 rows hold NULL. Every return on
       * those 13 charged 3–5 instead of 0; on a partial delivery the
       * collection door then refused the whole handover as OWED_TO_COURIER
       * (tracking/collect/route.ts) because 1.000 + 2.5 − 2.5 − 2.5 = −1.5.
       *
       * AND IT IS NOT `??` EITHER. A number is never nullish, so `??` here
       * would be a fallback that reads as live policy and can never fire —
       * the shape of guard this audit keeps catching. Absence is not a value
       * in this table, it is `source: 'NONE'`, and that case already returns
       * 0 for BOTH figures, so it charges nothing and always did.
       *
       * What a courier should be charged when NOBODY has set a return fee is
       * a policy question, and the table cannot express «nobody set it»
       * (the column defaults to 0 and the form posts 0). Reported to the
       * owner rather than decided here.
       */
      courierFeeAmount = roundMinor(fee.returnFee, country.minorUnit);
    }

    const receipt = await db.$transaction(async (tx) => {
      const counted = {
        expectedQty,
        receivedQty: input.receivedQty,
        damagedQty: input.damagedQty,
        missingQty,
        inspectedById: user.id,
        // Only sound units go back on the shelf.
        stockRestored: input.receivedQty > 0,
      };
      let created;
      if (completing) {
        /*
         * The same receipt, completed. The guard is in the question — «still says nothing came back» — so two
         * clerks pressing at once cannot both complete it: the second finds no such receipt and is refused.
         * A fee the first receipt already carried stays as it was; the fee is only taken when it had none.
         */
        const held = order.returnReceipt!;
        const done = await tx.returnReceipt.updateMany({
          where: { orderId: order.id, ...receiptNothingCameBackWhere() },
          data: {
            ...counted,
            inspectedAt: new Date(),
            ...(held.courierFeeCharged ? {} : { courierFeeCharged: input.chargeCourierFee, courierFeeAmount }),
            note: input.note ?? null,
          },
        });
        if (done.count !== 1) return null;
        created = await tx.returnReceipt.findUniqueOrThrow({ where: { orderId: order.id } });
      } else {
        created = await tx.returnReceipt.create({
          data: {
            companyId,
            orderId: order.id,
            ...counted,
            courierFeeCharged: input.chargeCourierFee,
            courierFeeAmount,
            note: input.note ?? null,
          },
        });
      }

      // Stock re-entry happens HERE, after the acknowledgement, never before.
      //
      // This used to write only a ledger line. Units live in batches, so a
      // line on its own moved nothing: the ledger read "5 returned" while
      // every batch held exactly what it held before, and the shipment
      // screen still reported the shortage. The goods now go back into a
      // batch of their own at the cost they left at.
      // The damaged units travel with the sound ones — not to be shelved,
      // but so their cost stays on this product instead of being written off
      // the business. See absorbDamaged.
      await restoreOrderStock(tx, {
        orderId: order.id,
        companyId,
        receivedQty: input.receivedQty,
        damagedQty: input.damagedQty,
        userId: user.id,
      });

      await tx.orderItem.updateMany({ where: { orderId: order.id, reservedQty: { gt: 0 } }, data: { reservedQty: 0 } });
      await tx.order.update({
        where: { id: order.id },
        // A PARTIAL delivery is not turned into a return by the refused
        // units coming back. It was partly delivered, and the customer paid
        // for what they kept: rewriting it to RETURNED would erase the
        // delivery, and `NOT_APPLICABLE` would drop money the courier is
        // still holding out of everything that chases it.
        // A receipt being COMPLETED leaves the order as the first one closed it: already RETURNED, with its moment.
        data:
          order.shippingStatus === 'PARTIALLY_DELIVERED' || completing
            ? { version: { increment: 1 } }
            : {
                shippingStatus: 'RETURNED',
                status: 'RETURNED',
                returnedAt: new Date(),
                settlementStatus: 'NOT_APPLICABLE',
                version: { increment: 1 },
              },
      });

      // A RETURNED ORDER GENERATES NO COMMISSION.
      //
      // It was delivered, so the ledger accrued on it; it then came back, so
      // that accrual has to come off. This used to be `moderatorCommission:
      // 0` on the row above — which zeroed the legacy column while the
      // LEDGER, the one the commission screen and the payout read, went on
      // holding the full amount. The month paid commission on goods that
      // are back on the shelf.
      //
      // Reversing writes a NEGATIVE entry rather than deleting the
      // original: the accrual and its reversal both stay visible, which is
      // what «لا حذف مالي» means and what lets somebody see that it
      // happened.
      await reverseForOrder(tx, {
        companyId,
        orderId: order.id,
        reason: `مرتجع مستلم: ${input.receivedQty} وصل، ${input.damagedQty} تالف`,
      });
      await tx.orderNote.create({
        data: {
          companyId,
          orderId: order.id,
          authorId: user.id,
          kind: 'return',
          body:
            (completing ? 'وصل الطرد بعد إغلاقه بلا استلام — ' : '') +
            `استلام مرتجع: وصل ${input.receivedQty}، تالف ${input.damagedQty}، ناقص ${missingQty}` +
            (input.chargeCourierFee ? ` — أجرة إرجاع ${courierFeeAmount}` : '') +
            (input.note ? ` — ${input.note}` : '') +
            // The note thread is where a person finds out the order is not
            // finished. Without this line the receipt reads as the end of
            // the order, and for a partial delivery it is half of it.
            (completion.complete ? '' : ` — ${completion.label}`),
        },
      });
      return created;
    });

    if (!receipt) {
      return NextResponse.json({ error: 'تم استلام هذا المرتجع مسبقاً', code: 'ALREADY_RECEIVED' }, { status: 409 });
    }

    await logAudit({
      companyId, userId: user.id, action: 'RETURN_RECEIVED',
      entity: 'Order', entityId: order.id,
      newData: {
        receiptId: receipt.id, expectedQty, received: input.receivedQty, damaged: input.damagedQty,
        missingQty, courierFeeAmount,
        // Whether this receipt finished the order or only half of it.
        completion: completion.degree, awaiting: completion.awaiting,
        // The parcel written off as lost turned up: this completed the receipt the write-off had closed.
        ...(completing ? { completesLossReceipt: true } : {}),
      },
    });

    return NextResponse.json({ receipt, missingQty, courierFeeAmount, completion }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
