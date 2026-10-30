import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { PartialDeliveryRefused, recordPartialDelivery } from '@/lib/partial-delivery';
import { doorMoney } from '@/lib/settlement';
import { zodMessage } from '@/lib/zod-message';

/**
 * POST /api/ops/tracking/deliver — settle a parcel at the door.
 *
 * One endpoint for all three outcomes, because they are the same event seen
 * from different line counts: everything taken is DELIVERED, some taken is
 * PARTIALLY_DELIVERED, nothing taken is RETURNED. Splitting them into three
 * endpoints would invite three different fee rules.
 *
 * The refused units are REPORTED, not restocked. Stock re-entry is
 * count-and-inspect on /ops/returns, done when the parcel is physically
 * back — not when the courier says it is coming.
 */

/**
 * THE TWO COMMON OUTCOMES ARE A WORD, NOT A LINE LIST.
 *
 * Almost every parcel is «all of it» or «none of it». Making the screen
 * send a full line list for those means the client has to KNOW the lines
 * — a fetch before the click, and a chance to send the wrong set — to say
 * something the server can read off the order itself.
 *
 * `outcome` is that word. `lines` stays for the partial case, which is
 * the only one that genuinely needs counting. One endpoint still, and one
 * fee rule: `outcome` is expanded into lines here, three lines below, and
 * everything after it is the path it always was.
 */
const schema = z.union([
  z.object({
    orderId: z.string().uuid(),
    outcome: z.enum(['ALL', 'NONE']),
    note: z.string().trim().max(300).optional(),
  }),
  z.object({
    orderId: z.string().uuid(),
    lines: z
      .array(z.object({ itemId: z.string().uuid(), deliveredQty: z.number().int().min(0).max(10_000) }))
      .min(1)
      .max(100),
    note: z.string().trim().max(300).optional(),
    /**
     * ASK WHAT THIS WOULD COLLECT, AND WRITE NOTHING.
     *
     * `DeliverDialog` showed the money a courier is about to be told to
     * collect, and it worked the figure out ITSELF — a second copy of the
     * door's rule, carried on `the-frontend-invariants.test.ts`'s DIVERGED
     * list. The two disagreed, measured:
     *
     *   an order with a thank-you-page upsell   door 29.5   screen 24.5
     *   the same, one of two units refused      door 18.5   screen 13.5
     *   Syrian pounds, whole units              door 21     screen 21.333…
     *
     * The upsell has no LINE, so the screen's loop over lines could never
     * see it, and nothing in the browser rounded by the store's currency.
     * The courier was told a figure five dinars short of what the door
     * would actually record.
     *
     * The contract forbids computing a COD in a browser at all, so the
     * answer is not a corrected copy — it is this: the same door, reading
     * the same order, running the SAME `doorMoney`, and returning the
     * figures for the screen to print.
     */
    preview: z.literal(true).optional(),
  }),
]);

export async function POST(req: Request) {
  try {
    // The store too: the order was found by company alone, so an id from
    // another store of the same company could be delivered from this one.
    const { user, companyId, storeId, country } = await requireContext();
    // Recording what happened at the customer's door is its own box (PR-8). The migration gave it to every holder of
    // `ops.track`, the key it rode on, so nobody lost it and nobody gained it. Listing the parcels stays `ops.track`.
    await requirePermission('ops.deliver');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    /**
     * A word becomes the line list, read from the order rather than taken
     * from the request: «all of it» means every unit this order actually
     * has, not every unit a client thought it had.
     */
    const asked = parsed.data;
    let lines: { itemId: string; deliveredQty: number }[];
    if ('outcome' in asked) {
      const items = await db.orderItem.findMany({
        where: { orderId: asked.orderId, order: { companyId, storeId } },
        select: { id: true, quantity: true, freeQuantity: true },
      });
      if (items.length === 0) {
        return NextResponse.json({ error: 'لا بنود لهذا الطلب' }, { status: 404 });
      }
      lines = items.map((i) => ({
        itemId: i.id,
        deliveredQty: asked.outcome === 'ALL' ? i.quantity + i.freeQuantity : 0,
      }));
    } else {
      lines = asked.lines;
    }

    /*
     * THE PREVIEW ANSWERS AND STOPS. No transaction, no stock, no audit —
     * the person has not pressed anything yet. It is deliberately AFTER the
     * permission check and the `outcome` expansion, so what it prices is
     * exactly what a submit would price.
     */
    if ('preview' in asked && asked.preview) {
      const order = await db.order.findFirst({
        where: { id: asked.orderId, companyId, storeId },
        select: {
          priceIncludesDelivery: true,
          deliveryFee: true,
          addOns: { select: { quantity: true, price: true } },
          items: {
            select: { id: true, quantity: true, freeQuantity: true, unitPrice: true, discountShare: true, lineTotal: true },
          },
        },
      });
      if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });

      const asKept = new Map(lines.map((l) => [l.itemId, l.deliveredQty]));
      const money = doorMoney(
        {
          items: order.items.map((i) => ({ ...i, deliveredQty: asKept.get(i.id) ?? 0 })),
          addOns: order.addOns,
          priceIncludesDelivery: order.priceIncludesDelivery,
          deliveryFee: order.deliveryFee,
        },
        country.minorUnit
      );
      return NextResponse.json({
        preview: {
          goods: money.goods,
          addOns: money.addOns,
          fee: money.fee,
          collected: money.collected,
          anythingTaken: money.anythingTaken,
        },
      });
    }

    try {
      const outcome = await db.$transaction((tx) =>
        recordPartialDelivery(tx, {
          companyId,
          storeId,
          orderId: parsed.data.orderId,
          lines,
          minorUnit: country.minorUnit,
          userId: user.id,
          note: parsed.data.note ?? null,
        })
      );

      await logAudit({
        companyId, userId: user.id, action: 'PARTIAL_DELIVERY_RECORDED',
        entity: 'Order', entityId: parsed.data.orderId,
        newData: {
          status: outcome.status,
          collectedAmount: outcome.collectedAmount,
          deliveryFee: outcome.deliveryFee,
          linesDelivered: outcome.linesDelivered,
          linesReturned: outcome.linesReturned,
          // Which of the two settlements this door visit left open.
          completion: outcome.completion.degree,
          awaiting: outcome.completion.awaiting,
        },
      });

      return NextResponse.json({
        ...outcome,
        message:
          outcome.status === 'DELIVERED'
            ? `سُلِّم كاملاً — المتوقَّع ${outcome.collectedAmount} ${country.currencyCode}، بانتظار التحصيل`
            : outcome.status === 'RETURNED'
              ? 'لم يُستلم شيء — الطلب مرتجع'
              : // A PARTIAL DELIVERY SAYS SO OUT LOUD.
                //
                // «واذا اتمم واحد فهو اتمم جزءي، ما بنغلق غير كامل» — the
                // person at this screen has just finished their part and
                // would otherwise read the toast as the end of the order.
                // Naming the half that is still open is how the rule
                // reaches them at the moment it starts applying.
                `تسليم جزئي — المتوقَّع ${outcome.collectedAmount} ${country.currencyCode} بأجرة توصيل كاملة ${outcome.deliveryFee}. ` +
                `${outcome.refusedUnits} قطعة راجعة — ${outcome.completion.label}`,
      });
    } catch (e) {
      if (e instanceof PartialDeliveryRefused) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
      }
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
