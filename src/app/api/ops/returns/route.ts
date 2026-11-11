import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { redactCustomerForWarehouse } from '@/lib/operations';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import {
  completionOf, doorUnits, expectedBackTotal, extraAction, needsExtraAction, settledLines,
} from '@/lib/partial-delivery';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { readLimit, readPage } from '@/lib/numeric-input';
import { readOrderPage } from '@/lib/paged-read';
import { PENDING_ORDER_BY, RECEIVED_ORDER_BY, daysWaitedOf, returnsFilters, sinceOf, viewScope } from '@/lib/returns-filters';
import { returnsFacts } from '@/lib/returns-list';
import { receiveReturn } from '@/lib/return-receipt';

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
      // The fee tick-box's own key (PR-8), so the screen draws no box the door would refuse.
      mayChargeFee: can(user, 'ops.return_fee'),
      // «استلام الكل»'s own key — granted to nobody; the owner's full access holds it. No key, no button.
      mayReceiveAll: can(user, 'ops.returns_receive_all'),
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

    /*
     * CHARGING THE COURIER A RETURN FEE IS ITS OWN BOX (`ops.return_fee`, PR-8).
     *
     * Receiving a return is the desk's job and stays on `ops.returns`; putting a fee on the courier is a money decision
     * that rode on it. The migration gave the box to everybody who held `ops.returns`, so nobody lost the checkbox. A
     * receiver without it can still receive the return — she just cannot tick the fee — so the refusal is on the fee and
     * nothing else is held back. Asked before the order is even read: nothing is written for a refused request.
     */
    if (input.chargeCourierFee && !can(user, 'ops.return_fee')) {
      return NextResponse.json(
        { error: 'احتساب أجرة الإرجاع على الشركة ليس من صلاحيّاتك — استلم المرتجع بدونه.', errorAr: 'احتساب أجرة الإرجاع على الشركة ليس من صلاحيّاتك — استلم المرتجع بدونه.', code: 'RETURN_FEE_FORBIDDEN' },
        { status: 403 }
      );
    }

    /*
     * THE RECEIPT ITSELF IS ONE FUNCTION (`receiveReturn`, lib/return-receipt.ts): the checks, the transaction — the
     * receipt, the shelf, the reservation, the order's state, the commission reversed, the note — and the audit row.
     * «استلام الكل» calls the same function per parcel, so the two doors cannot drift apart. A refusal comes back with the
     * exact body and status this door has always answered.
     */
    const result = await receiveReturn(
      { user, companyId, storeId, minorUnit: country.minorUnit },
      {
        orderId: input.orderId,
        receivedQty: input.receivedQty,
        damagedQty: input.damagedQty,
        chargeCourierFee: input.chargeCourierFee,
        note: input.note,
      }
    );
    if (!result.ok) return NextResponse.json(result.body, { status: result.status });
    const { receipt, missingQty, courierFeeAmount, completion } = result;
    return NextResponse.json({ receipt, missingQty, courierFeeAmount, completion }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
