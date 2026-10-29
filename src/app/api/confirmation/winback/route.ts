import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { logAudit } from '@/lib/audit';
import { computeCod } from '@/lib/money';
import { orderRefFields } from '@/lib/order-ref';
import {
  maxWinbackDiscount, LOST_STATUSES, returnedAfterShipping, returnLabel, winbackVerdict, type WinbackSource,
} from '@/lib/winback';
import { winbackRule } from '@/lib/winback-rule';
import { baseWhere, winbackFilters } from '@/lib/winback-filters';
import { readWinbackPage, winbackFacts } from '@/lib/winback-list';
import { readLimit, readPage } from '@/lib/numeric-input';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { nothingCameBack } from '@/lib/written-off';

/**
 * GET  /api/confirmation/winback — the lost orders worth one more call.
 * POST /api/confirmation/winback — make the offer: a NEW order, with a discount.
 *
 * WHY A NEW ORDER AND NOT THE OLD ONE BACK.
 *
 * Reviving the rejected order would be the shorter code and the wrong
 * record. It was rejected — that is a fact with a date, a reason and a
 * person, and «أين نخسر الطلبات» counts it. Flipping its status back to NEW
 * erases the loss from every report that reads `confirmationStatus`, so the
 * month would show fewer rejections the harder we worked at winning them
 * back. And REJECTED is terminal in `CONFIRMATION_TRANSITIONS`, which this
 * door does not open for everybody in order to do one thing.
 *
 * So the loss stays a loss and the offer is a new attempt with its own
 * outcome — which also gives the whole idea a conversion rate. It is the
 * pattern the region transfer already uses: close the old leg, raise a
 * fresh order, link the two with `replacesOrderId`.
 *
 * AND ONCE IS ONCE, enforced by the database rather than by this file:
 * `replacesOrderId` is `@unique`, so a second offer on the same rejected
 * order cannot be written even by two people pressing at the same moment.
 *
 * AND A PARCEL THAT CAME BACK IS OFFERED THE SAME WAY (28/10). The owner asked
 * for the lost orders «قبل الشحن وبعد»: a return the desk received is read by
 * the same verdict, held to the same ceiling, and raised as the same new order
 * through the same door below — only its note names it a return instead of
 * printing a rejection code it does not have.
 */

const offerSchema = z.object({
  orderId: z.string().uuid(),
  discount: z.number().finite().min(0).max(1_000_000),
  note: z.string().trim().max(500).optional(),
});

/**
 * READ IN PAGES, ONE VIEW AT A TIME, UNDER THE OWNER'S RULE.
 *
 * «استرجاع الملغى — اعملو صفحات + فلاتر + بحث، والأهم شو القاعدة تبعو لاني ممكن
 * اعدلها». The list used to read the last five hundred lost orders, ask «is this
 * one eligible?» of each in memory, and cut at five hundred BEFORE asking — so a
 * month with six hundred lost orders silently lost the oldest hundred. Now the
 * question is in the query (`winback-filters.ts`), the answer is counted, and
 * what is left is read in pages of 25.
 *
 *   ?view=ready|cooling|skipped   the work (default) · the ones still cooling · the refused
 *   ?reason=<code>                why it was cancelled
 *   ?product=<name>               which product
 *   ?period=7|30|90               cancelled — or the return received — within the last N days
 *   ?shipping=before|after        lost before it shipped · shipped (and came back, for the work)
 *   ?q=                           order number, reference, name, phone, product
 *   ?page= ?limit=                25 a page, 100 at most
 *
 * An unknown value is a 400 in Arabic, never a quiet «everything». The RULE is
 * the company's own (`Company.settings.winback`, edited in `./rule`), read here
 * and in the offer below — so the two can never apply different rules to one
 * order — and it is sent along, with whether this person may change it.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.supervise');

    const now = new Date();
    const params = new URL(req.url).searchParams;
    const rule = await winbackRule(companyId);

    const parsed = winbackFilters(params, { now, rule });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorAr: parsed.errorAr }, { status: 400 });

    const base = baseWhere({ companyId, storeId }, rule, now);
    const [page, facts] = await Promise.all([
      readWinbackPage<Record<string, any>>(db, {
        base,
        viewClause: parsed.viewClause,
        clauses: parsed.clauses,
        page: readPage(params),
        limit: readLimit(params, 25, 100),
        select: {
          id: true, orderNumber: true, confirmationStatus: true, rejectionReason: true,
          rejectionNote: true, shippedAt: true, sellingPrice: true, discountAmount: true,
          quantity: true, currency: true, productNameSnapshot: true, createdAt: true,
          // Whether a parcel that left came back, why, and when the desk received it.
          shippingStatus: true, returnReason: true, deliveryFailureReason: true,
          returnReceipt: { select: { inspectedAt: true, receivedQty: true, damagedQty: true, missingQty: true } },
          customer: { select: { fullName: true, phone: true } },
          replacedBy: { select: { orderNumber: true } },
          // Whether this order is itself somebody's second chance.
          replaces: { select: { orderNumber: true } },
        },
      }),
      winbackFacts(db, { base, view: parsed.view, rule, now }),
    ]);
    const orders = page.rows;

    /**
     * WHEN IT WAS ACTUALLY CLOSED.
     *
     * The order carries no rejection timestamp — `confirmedAt` exists and
     * nothing matching it does. `updatedAt` is not it either: any later edit
     * moves it, so a note added yesterday would reset a customer's cooling
     * period to yesterday and hide them for another fortnight.
     *
     * The status log holds the real moment, and the LAST one is the one
     * that counts: an order rejected, re-opened and rejected again cools
     * from the second time.
     *
     * AND BOTH WORDS FOR IT, not just the first one — REJECTED and CANCELLED
     * (`LOST_STATUSES`). The lookup asked for REJECTED alone once, and every
     * cancelled order arrived with no closing date and the verdict said
     * «لا تاريخَ لإلغائه» about an order whose cancellation is stamped in the log.
     *
     * Read for THIS PAGE's orders only — the page is 25 and so is the lookup.
     * (The filters, which must reason about every order, do it inside the query.)
     */
    const logs = orders.length
      ? await db.orderStatusLog.findMany({
          where: {
            orderId: { in: orders.map((o) => o.id) },
            statusType: 'CONFIRMATION',
            newValue: { in: [...LOST_STATUSES] },
          },
          orderBy: { createdAt: 'desc' },
          select: { orderId: true, createdAt: true },
        })
      : [];
    const rejectedAt = new Map<string, Date>();
    for (const l of logs) if (!rejectedAt.has(l.orderId)) rejectedAt.set(l.orderId, l.createdAt);

    const rows = orders.map((o) => {
      const source: WinbackSource = {
        confirmationStatus: o.confirmationStatus,
        rejectionReason: o.rejectionReason,
        rejectedAt: rejectedAt.get(o.id) ?? null,
        shippedAt: o.shippedAt,
        shippingStatus: o.shippingStatus,
        returnReceivedAt: o.returnReceipt && !nothingCameBack(o.returnReceipt) ? o.returnReceipt.inspectedAt : null,
        returnNothingCameBack: o.returnReceipt ? nothingCameBack(o.returnReceipt) : false,
        replacedByOrderNumber: o.replacedBy?.orderNumber ?? null,
        replacesOrderNumber: o.replaces?.orderNumber ?? null,
        sellingPrice: Number(o.sellingPrice ?? 0),
        discountAmount: Number(o.discountAmount ?? 0),
        createdAt: o.createdAt,
      };
      // The row says in words WHICH rule put it in this view — a supervisor reading
      // «مكرَّر — البضاعة عنده أصلاً» learns the rule instead of wondering where an order went.
      const verdict = winbackVerdict(source, now, rule);
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        customer: o.customer,
        product: o.productNameSnapshot,
        quantity: o.quantity,
        sellingPrice: Number(o.sellingPrice ?? 0),
        discountAmount: Number(o.discountAmount ?? 0),
        currency: o.currency,
        rejectionReason: o.rejectionReason,
        rejectionNote: o.rejectionNote,
        rejectedAt: rejectedAt.get(o.id) ?? null,
        // A parcel that came back is named a return, in words — never the courier's code, never the prose a
        // write-off or a transfer typed into `returnReason` (which is why that column is not sent at all).
        returnLabel: returnedAfterShipping(source) ? returnLabel(o) : null,
        returnReceivedAt: o.returnReceipt && !nothingCameBack(o.returnReceipt) ? o.returnReceipt.inspectedAt : null,
        verdict,
      };
    });

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut. Only the page that was sent.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'استعادة العملاء', rows: orders });

    return NextResponse.json({
      rows,
      pagination: { total: page.total, page: page.page, limit: page.limit, totalPages: page.totalPages },
      facts,
      rule,
      // The screen offers «عدّل القاعدة» to somebody who can change it; the route that changes it asks again.
      canEditRule: can(user, 'offers.rules'),
      // And «اعرضه من جديد» is the offer's own box (PR-7): seeing the list is not enough to press it.
      canOffer: can(user, 'confirmation.winback'),
      applied: parsed.applied,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    // The offer is its OWN box (`confirmation.winback`, PR-7), given to whoever supervised the list before. Reading the
    // list keeps `confirmation.supervise`.
    await requirePermission('confirmation.winback');

    const parsed = offerSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { orderId, discount, note } = parsed.data;

    // The rule the list drew by — read again here, because the offer is where it is enforced.
    const rule = await winbackRule(companyId);

    const order = await db.order.findFirst({
      where: { id: orderId, companyId, ...(storeId ? { storeId } : {}) },
      include: {
        replacedBy: { select: { orderNumber: true } },
        replaces: { select: { orderNumber: true } },
        // A parcel that came back is offered only once the desk has received it — and cools from that day.
        returnReceipt: { select: { inspectedAt: true, receivedQty: true, damagedQty: true, missingQty: true } },
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });

    const lastRejection = await db.orderStatusLog.findFirst({
      where: { orderId, statusType: 'CONFIRMATION', newValue: { in: [...LOST_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    // The same verdict the list drew, re-taken here. A row that was eligible
    // when the screen loaded may not be when the button is pressed.
    const source: WinbackSource = {
      confirmationStatus: order.confirmationStatus,
      rejectionReason: order.rejectionReason,
      rejectedAt: lastRejection?.createdAt ?? null,
      shippedAt: order.shippedAt,
      shippingStatus: order.shippingStatus,
      returnReceivedAt: order.returnReceipt && !nothingCameBack(order.returnReceipt) ? order.returnReceipt.inspectedAt : null,
      returnNothingCameBack: order.returnReceipt ? nothingCameBack(order.returnReceipt) : false,
      replacedByOrderNumber: order.replacedBy?.orderNumber ?? null,
      replacesOrderNumber: order.replaces?.orderNumber ?? null,
      sellingPrice: Number(order.sellingPrice ?? 0),
      discountAmount: Number(order.discountAmount ?? 0),
      createdAt: order.createdAt,
    };
    const verdict = winbackVerdict(source, new Date(), rule);
    if (!verdict.eligible) {
      return NextResponse.json({ error: verdict.reason, code: verdict.code }, { status: 409 });
    }
    // What the new order's note says it is winning back: the rejection code it always printed, or — for a parcel
    // that came back, which has no rejection code and printed «(null)» — the return, in words.
    const lostAs = returnedAfterShipping(source) ? returnLabel(order) : order.rejectionReason;

    const ceiling = maxWinbackDiscount(
      {
        sellingPrice: Number(order.sellingPrice ?? 0),
        discountAmount: Number(order.discountAmount ?? 0),
      },
      rule.maxDiscountShare
    );
    if (discount > ceiling) {
      return NextResponse.json(
        {
          error: `أقصى خصمٍ على هذا الطلب ${ceiling} — والمحسوم عليه سابقاً داخلٌ في الحساب`,
          code: 'DISCOUNT_TOO_LARGE',
          maxDiscount: ceiling,
        },
        { status: 400 }
      );
    }

    /**
     * THE GOODS — READ OFF THE ORDER WE ARE TRYING TO WIN BACK.
     *
     * This route created an Order and no `OrderItem` at all: the only one of
     * the six order doors that did not. `assertReadyToShip` refuses a lineless
     * order by name («الطلب بلا أسطر — لا يمكن تجهيزه»), `reserveOrderLines`
     * finds nothing to hold, and the preparation screen has no row to pick —
     * so every win-back offer ever accepted was an order that could never
     * ship. The customer we deliberately went back to win is recorded as
     * having ordered and then receives nothing.
     *
     * WHERE THE LINES COME FROM, and there is no guessing in it. A win-back
     * is this order again at a lower price: the row written below already
     * copies `productId`, `quantity`, `freeQuantity`, `offerId` and the two
     * product snapshots from it. The lines are the same goods, so they are
     * the ORIGINAL ORDER'S OWN `OrderItem` rows — which is exactly what
     * `createReplacement` does for the transfer and the reorder, the two
     * other doors that raise a fresh order against `replacesOrderId`.
     *
     * `unitPrice` IS PER UNIT and is taken as it stands. Measured on this
     * database: ORD-2026-0056 is 2 × 12.50 with `sellingPrice` 25 and
     * `lineTotal` 25 — so `sellingPrice` is the order's SUBTOTAL, not a unit
     * price, and the computation below used to hand it to `computeCod` as a
     * unit price AND multiply it by the quantity again. ORD-2026-0052 (3 ×
     * 12, subtotal 36) would have been won back at 108. That is the same
     * mistake the orders PATCH records fixing — «multiplying a price that is
     * already the line's total by the quantity again» — and it was invisible
     * here because a one-unit order gives the right answer.
     *
     * AN ORDER WITH NO LINES OF ITS OWN still has to be winnable: the single
     * product columns are that order's own record of what was bought, and
     * `OrderLinesCard` already shows them as one line when `items` is empty.
     * The unit price is the subtotal divided ONCE, the same rule every other
     * door applies to a figure that is a total for its quantity.
     */
    const sourceLines = await db.orderItem.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
      select: {
        productId: true, productName: true, quantity: true, freeQuantity: true, unitPrice: true,
      },
    });
    const quantity = order.quantity ?? 1;
    const lines = sourceLines.length
      ? sourceLines.map((l) => ({
          productId: l.productId,
          productName: l.productName,
          quantity: l.quantity,
          freeQuantity: l.freeQuantity,
          unitPrice: Number(l.unitPrice),
        }))
      : [
          {
            productId: order.productId,
            productName: order.productNameSnapshot ?? '',
            quantity,
            freeQuantity: order.freeQuantity ?? 0,
            unitPrice: quantity > 0 ? Number(order.sellingPrice ?? 0) / quantity : Number(order.sellingPrice ?? 0),
          },
        ];
    const carried = Number(order.discountAmount ?? 0);
    // The discount is the WHOLE of it, not a second helping on top of what
    // came off before — the ceiling above already subtracted the old one.
    const totalDiscount = carried + discount;
    /*
     * THROUGH THE ONE DOOR, NOT A FORMULA OF ITS OWN.
     *
     * This was `Math.max(0, unit * quantity - totalDiscount)` — the COD
     * computed a second time, by hand, in a route nobody thinks of as a
     * money route. Three things it got wrong and `computeCod` does not:
     * it rounded nowhere, so a Jordanian order carried a float; it ignored
     * `priceIncludesDelivery`, which the row below faithfully copies and
     * which decides whether a fee is inside the price or on top of it; and
     * it clamped a negative to zero instead of clamping the DISCOUNT to the
     * subtotal, which is where the clamp belongs.
     *
     * «If the same figure is computed in two different places in the code,
     * that is a defect even when the two agree today.»
     */
    const money = computeCod({
      lines: lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice })),
      discount: totalDiscount,
      deliveryFee: 0,
      priceIncludesDelivery: order.priceIncludesDelivery ?? false,
      minorUnit: country.minorUnit,
    });
    const totalAmount = money.cod;

    /**
     * THE ORDER NUMBER RETRIES HERE TOO, which it could not before.
     *
     * The attempt was the literal `0`, and nothing caught a P2002 — so two
     * orders created in the same second raced for one number and the loser
     * handed a raw Prisma conflict to whoever pressed «اعرض استرجاعاً».
     * `nextOrderNumber` takes an attempt precisely so the retry asks for
     * the NEXT number instead of the same one again, and a constant 0 asks
     * for the same one forever.
     *
     * Four of the six order doors already looped this way; this was the
     * fifth, found by the walk in `an-order-and-its-lines-are-one-write`
     * rather than by reading — a guard that counted ARGUMENTS was happy
     * with `0`, which is the lesson: an argument is not an attempt.
     */
    const now = new Date();
    const created = await db.$transaction(async (tx) => {
      let fresh: { id: string; orderNumber: string } | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const refs = await orderRefFields(tx, companyId, country.orderPrefix, attempt, now);
          fresh = await tx.order.create({
        data: {
          companyId,
          countryId: order.countryId,
          storeId: order.storeId,
          regionId: order.regionId,
          ...refs,
          replacesOrderId: order.id,
          customerId: order.customerId,
          productId: order.productId,
          offerId: order.offerId,
          quantity,
          freeQuantity: order.freeQuantity,
          // The subtotal of the lines written below, so the row and its own
          // lines can never disagree — the same column the orders PATCH and
          // `createReplacement` write from `money.subtotal`.
          sellingPrice: money.subtotal,
          discountAmount: totalDiscount,
          shippingCost: 0,
          totalAmount,
          currency: order.currency,
          priceIncludesDelivery: order.priceIncludesDelivery,
          productNameSnapshot: order.productNameSnapshot,
          productImageSnapshot: order.productImageSnapshot,
          moderatorId: order.moderatorId,
          estimatedCostOfGoods: order.estimatedCostOfGoods,
          // Straight into the pool, held by nobody: whoever is free calls it,
          // and it is an ordinary new order from there on. No second queue.
          status: 'NEW',
          confirmationStatus: 'NEW',
          shippingStatus: 'NOT_READY',
          settlementStatus: 'NOT_APPLICABLE',
          source: order.source,
          customerNotes: order.customerNotes,
          internalNotes: `محاولةُ استرجاع لـ${order.orderNumber} (${lostAs}) بخصم ${discount}${note ? ` — ${note}` : ''}`,
          version: 1,
        },
        select: { id: true, orderNumber: true },
          });
          break;
        } catch (e: unknown) {
          if ((e as { code?: string })?.code === 'P2002' && attempt < 4) continue;
          throw e;
        }
      }
      if (!fresh) throw new Error('Failed to generate a unique order number');

      /**
       * AND ITS LINES, IN THE SAME TRANSACTION AS THE ORDER.
       *
       * Inside the transaction because an order that exists without its
       * lines is precisely the defect this closes — a half-written order
       * must not survive a failure here.
       *
       * The shares and the line totals are `computeCod`'s own allocation, as
       * `POST /api/orders` and `createPublicOrder` write them: a partial
       * return refunds the wrong amount when a line carries a share it
       * worked out for itself.
       *
       * NOTHING IS RESERVED HERE, and that is the rule rather than an
       * omission. This order enters at NEW, and stock is held when it is
       * CONFIRMED — `reserveOrderLines` in `PATCH /api/orders/[id]/
       * confirmation`. The replacement path reserves at creation because it
       * is born CONFIRMED with a customer already waiting on a parcel; a
       * win-back offer nobody has accepted yet must not hold goods.
       */
      await tx.orderItem.createMany({
        data: lines.map((l, i) => ({
          companyId,
          orderId: fresh.id,
          productId: l.productId,
          productName: l.productName,
          quantity: l.quantity,
          freeQuantity: l.freeQuantity,
          unitPrice: l.unitPrice,
          discountShare: money.discountShares[i] ?? 0,
          lineTotal: money.lineTotals[i] ?? 0,
          addedById: user.id,
          addedStage: 'INTAKE',
        })),
      });

      return fresh;
    });

    await db.orderNote.create({
      data: {
        companyId,
        orderId: order.id,
        authorId: user.id,
        kind: 'internal',
        body: `عُرض استرجاعٌ بخصم ${discount} — الطلب الجديد ${created.orderNumber}`,
      },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'WINBACK_OFFERED',
      entity: 'Order',
      entityId: order.id,
      previousData: { rejectionReason: order.rejectionReason },
      newData: { newOrderId: created.id, newOrderNumber: created.orderNumber, discount, by: user.name },
    });

    return NextResponse.json({ success: true, order: created });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
