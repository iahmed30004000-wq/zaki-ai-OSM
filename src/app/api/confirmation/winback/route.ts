import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { logAudit } from '@/lib/audit';
import type { Prisma } from '@prisma/client';
import { computeCod, roundMinor } from '@/lib/money';
import { orderRefFields } from '@/lib/order-ref';
import {
  maxWinbackDiscount, LOST_STATUSES, returnedAfterShipping, returnLabel, winbackVerdict, type WinbackSource,
} from '@/lib/winback';
import { winbackRule } from '@/lib/winback-rule';
import { cadenceSince } from '@/lib/no-answer-cadence-switch';
import { PERIODS, baseWhere, isReason, periodWhere, reasonWhere, viewWhere, winbackFilters } from '@/lib/winback-filters';
import { customerWinbackVerdicts } from '@/lib/winback-customer';
import { readWinbackPrices, winbackUnitCost, type Pieces } from '@/lib/winback-prices';
import {
  BULK_MAX, BULK_SCAN, SKIP_AR, bulkAgents, customersWithALiveOrder, planBulk, readCandidates, type SkipCode,
} from '@/lib/winback-bulk';
import { handToList, offeredBeforeWhere } from '@/lib/winback-private-list';
import { readWinbackPage, winbackFacts } from '@/lib/winback-list';
import { readLimit, readPage } from '@/lib/numeric-input';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { nothingCameBack } from '@/lib/written-off';
import { costWhenEveryLineHasAFigure, fixedCostsOf } from '@/lib/product-fixed-cost';

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
    // The plan's switch rides beside the rule (one cached read, off on any failure): the screen words the rule's «no answer» tick by it (the planner 15/11, answer 6).
    const [rule, planSince] = await Promise.all([winbackRule(companyId), cadenceSince(db, companyId)]);

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
          customer: { select: { id: true, fullName: true, phone: true } },
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
    // The customer's own rule (two cancellations, `winback-customer.ts`), for THIS PAGE's customers: a row the offer would refuse says so.
    const customerIds = orders.map((o) => o.customer?.id).filter((id): id is string => typeof id === 'string');
    const customers = customerIds.length ? await customerWinbackVerdicts(db, { companyId, storeId }, customerIds) : new Map();

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
      const orderVerdict = winbackVerdict(source, now, rule);
      const who = o.customer?.id ? customers.get(o.customer.id) : undefined;
      const verdict = orderVerdict.eligible && who && !who.eligible ? { eligible: false as const, code: who.code, reason: who.reason } : orderVerdict;
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
      // Present ONLY with the plan on, so the switch-off payload keeps the keys it always had: the screen reads `cadenceOn === true` and nothing else.
      ...(planSince ? { cadenceOn: true } : {}),
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
    const ctx = await requireContext();
    // The offer is its OWN box (`confirmation.winback`, PR-7), given to whoever supervised the list before. Reading the
    // list keeps `confirmation.supervise`.
    await requirePermission('confirmation.winback');

    const body: unknown = await req.json().catch(() => null);
    // «وزّع على الموظفات» (the bulk run) is this same door with an `action`: it makes every order through `offerOne` below — the one creator.
    if (isBulkBody(body)) return await bulk(ctx, body);

    const parsed = offerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const done = await offerOne(ctx, parsed.data);
    return NextResponse.json(done.body, { status: done.status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

type Ctx = Awaited<ReturnType<typeof requireContext>>;
type Offered = { ok: true; status: 200; body: { success: true; order: { id: string; orderNumber: string } } } | { ok: false; status: number; body: Record<string, unknown> };

/**
 * ONE OFFER — the win-back creator. The single press («اعرضه من جديد») hands it the discount a person typed; the bulk run hands it
 * `priced`: the owner's win-back price for this order (`winback-prices.ts`), computed by the server. With `priced` the discount is
 * whatever brings the new order's TOTAL to that price, delivery included (`priceIncludesDelivery` on the new order, so nothing is added
 * on top at the shipment), and it is the one discount the rule's ceiling does not stop — the owner set it per product. Everything else
 * — the verdict, the lines, the money through `computeCod`, the cost, the number, the note, the audit — is the same code for both.
 */
async function offerOne(
  { user, companyId, storeId, country }: Ctx,
  input: { orderId: string; discount: number; note?: string; priced?: { price: number; pieces: Pieces } }
): Promise<Offered> {
  const { orderId, note, priced } = input;
  let discount = input.discount;
  {
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
    if (!order) return { ok: false, status: 404, body: { error: 'الطلب غير موجود' } };

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
      return { ok: false, status: 409, body: { error: verdict.reason, code: verdict.code } };
    }
    /*
     * AND THE CUSTOMER, NOT ONLY THE ORDER (the owner's amendment): a customer who cancelled two orders or more is not rung again,
     * unless he later placed an order himself and it was delivered (`winback-customer.ts`). Asked here, so the single press and the
     * bulk run refuse alike.
     */
    const customer = (await customerWinbackVerdicts(db, { companyId, storeId }, [order.customerId])).get(order.customerId);
    if (customer && !customer.eligible) {
      return { ok: false, status: 409, body: { error: customer.reason, errorAr: customer.reason, code: customer.code } };
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
    // The owner's per-product win-back price (`priced`, computed by the server) is the one discount the ceiling does not stop.
    if (!priced && discount > ceiling) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `أقصى خصمٍ على هذا الطلب ${ceiling} — والمحسوم عليه سابقاً داخلٌ في الحساب`,
          code: 'DISCOUNT_TOO_LARGE',
          maxDiscount: ceiling,
        },
      };
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
    // The win-back price is the order's TOTAL with the delivery inside it: the new order says so, so the shipment adds nothing on top.
    const includesDelivery = priced ? true : (order.priceIncludesDelivery ?? false);
    /*
     * THE OWNER'S TWO OPTIONS (his ruling 25/11, «1 modified») — ORDER CREATION CHANGES HERE ON HIS WORD, for the bulk run only.
     *
     * A priced offer is not the cancelled order's goods at a discount any more: it is ONE line of the same product, at 1 or 3 pieces
     * (three in all, no gift), whose total is the configured price — whatever quantity the cancelled order had. The unit price is the
     * total shared over the pieces; the money still goes through `computeCod` below, with no discount. A typed offer (the single
     * press) is exactly what it was: the copied lines and the discount on them.
     */
    if (priced && new Set(lines.map((l) => l.productId)).size !== 1) {
      return { ok: false, status: 409, body: { error: 'الطلب فيه أكتر من منتج', errorAr: 'الطلب فيه أكتر من منتج', code: 'MIXED_PRODUCTS' } };
    }
    const goods = priced
      ? [{ productId: lines[0].productId, productName: lines[0].productName, quantity: priced.pieces, freeQuantity: 0, unitPrice: priced.price / priced.pieces }]
      : lines;
    if (priced) discount = 0;
    // The discount is the WHOLE of it, not a second helping on top of what
    // came off before — the ceiling above already subtracted the old one.
    // A priced offer carries none: its price IS its total.
    const totalDiscount = priced ? 0 : carried + discount;
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
      lines: goods.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice })),
      discount: totalDiscount,
      deliveryFee: 0,
      priceIncludesDelivery: includesDelivery,
      minorUnit: country.minorUnit,
    });
    const totalAmount = money.cod;
    // The bulk run's promise, held where the money is made: the new order's total IS the owner's price, to the minor unit.
    if (priced && totalAmount !== roundMinor(priced.price, country.minorUnit)) {
      return { ok: false, status: 409, body: { error: 'تعذّر الوصول لسعر الاسترجاع على هالطلب', errorAr: 'تعذّر الوصول لسعر الاسترجاع على هالطلب', code: 'PRICE_MISMATCH' } };
    }

    /*
     * WHAT THE GOODS COST — THE OWNER'S FIGURES WHEN EVERY LINE HAS ONE, ELSE THE CANCELLED ORDER'S COST (3/11: «صلّحهن»).
     *
     * A win-back is the cancelled order again, and it used to carry that order's cost as it stood — so a fixed cost an admin set
     * after the original was written was ignored until the parcel was delivered (RV575). Now, when EVERY line has a figure, the
     * cost is Σ figure × units (the gift included) — what any door writes today. Otherwise the copied cost stays exactly as it
     * was: a mixed order's cost already holds the figure's money (the doors write it since Stage 2), and sharing it out by units
     * would move money between lines (the money review of #175, B1). Cost only — the price, the total and the lines above are
     * computed before this and do not read it.
     */
    const figures = await fixedCostsOf(db, companyId, [...new Set(lines.map((l) => l.productId))]);
    // A priced offer is NEW goods (1 or 3 pieces, not the cancelled order's): costed for ITS OWN pieces (`winbackUnitCost`) — the owner's
    // fixed figure per piece, else the cancelled order's own cost over its own pieces — × the new pieces. A typed offer keeps the copy rule.
    const estimatedCostOfGoods = priced
      ? roundMinor(
          winbackUnitCost(figures.get(goods[0].productId), Number(order.estimatedCostOfGoods ?? 0), lines.reduce((n, l) => n + l.quantity + (l.freeQuantity ?? 0), 0)).unit * priced.pieces,
          country.minorUnit
        )
      : costWhenEveryLineHasAFigure(
          lines.map((l) => ({ productId: l.productId, units: l.quantity + (l.freeQuantity ?? 0) })),
          figures,
          country.minorUnit
        ) ?? order.estimatedCostOfGoods;
    // The owner's price never sells the goods below what they cost (the F12 review): refused on the row, nothing written.
    if (priced && totalAmount < estimatedCostOfGoods) {
      return { ok: false, status: 409, body: { error: 'سعر الاسترجاع أقل من تكلفة البضاعة', errorAr: 'سعر الاسترجاع أقل من تكلفة البضاعة', code: 'PRICE_BELOW_COST' } };
    }

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
          // The cancelled order's offer was for ITS quantity; a priced offer is one of the owner's two options, not that offer.
          offerId: priced ? null : order.offerId,
          quantity: priced ? priced.pieces : quantity,
          freeQuantity: priced ? 0 : order.freeQuantity,
          // The subtotal of the lines written below, so the row and its own
          // lines can never disagree — the same column the orders PATCH and
          // `createReplacement` write from `money.subtotal`.
          sellingPrice: money.subtotal,
          discountAmount: totalDiscount,
          shippingCost: 0,
          totalAmount,
          currency: order.currency,
          priceIncludesDelivery: includesDelivery,
          productNameSnapshot: order.productNameSnapshot,
          productImageSnapshot: order.productImageSnapshot,
          moderatorId: order.moderatorId,
          // Who made the offer — the account that ENTERED this order (RV8). The ORIGINAL's creator is not copied.
          createdById: user.id,
          estimatedCostOfGoods,
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
        data: goods.map((l, i) => ({
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
      newData: { newOrderId: created.id, newOrderNumber: created.orderNumber, discount, by: user.name, ...(priced ? { winbackPrice: priced.price } : {}) },
    });

    return { ok: true, status: 200, body: { success: true, order: created } };
  }
}

/* ───────────────────────── «وزّع على الموظفات» — the bulk run (`winback-bulk.ts`, `winback-private-list.ts`) ───────────────────────── */

const agentIdsSchema = z.array(z.string().min(1).max(64)).min(1).max(50);
const bulkSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('bulk-preview'),
    productId: z.string().min(1).max(64).optional(),
    reason: z.string().min(1).max(64).optional(),
    period: z.enum(PERIODS).optional(),
    count: z.number().int().min(1).max(BULK_MAX),
    agentIds: agentIdsSchema,
  }),
  z.object({ action: z.literal('bulk-run'), orderIds: z.array(z.string().uuid()).min(1).max(BULK_MAX), agentIds: agentIdsSchema }),
  // «انعرض من قبل»: list orders let go untouched after three days, handed out again — no new order is made.
  z.object({ action: z.literal('rehand-preview'), count: z.number().int().min(1).max(BULK_MAX), agentIds: agentIdsSchema }),
  z.object({ action: z.literal('rehand-run'), orderIds: z.array(z.string().uuid()).min(1).max(BULK_MAX), agentIds: agentIdsSchema }),
]);

const BULK_ACTIONS = ['bulk-preview', 'bulk-run', 'rehand-preview', 'rehand-run'];
const isBulkBody = (b: unknown): b is Record<string, unknown> =>
  !!b && typeof b === 'object' && BULK_ACTIONS.includes(String((b as { action?: unknown }).action));

const bulkRefuse = (errorAr: string, code: string, status = 400) => NextResponse.json({ error: errorAr, errorAr, code }, { status });

type RowResult = { orderId: string; orderNumber: string; ok: boolean; agentId?: string; newOrderNumber?: string; code?: string; reasonAr?: string };

/**
 * TWO PRESSES. `bulk-preview` reads the pool under the filters and answers the plan — which orders, to whom, what is skipped and why —
 * and writes nothing. `bulk-run` takes the order ids the preview answered and makes them, one at a time, through `offerOne` at the
 * server's 3-piece price, then hands each to her agent's PRIVATE list (`handToList`) — outside her hand limit. Run twice with the same
 * ids, the second makes nothing: every order is already offered (its source has `replacedBy`; the unique link refuses a race). A price
 * in the body is never read: zod drops it. `rehand-*` hands out again what a list let go («انعرض من قبل») — the same order, no new one.
 *
 * Manager only: the offer's box AND «إسناد الطلبات» (`orders.assign`, the transfer door's key for handing an order to anybody). Not
 * `confirmation.reassign`: the confirmation agent's live template holds it (and the offer's box), and an agent must not hand out
 * two hundred orders.
 */
async function bulk(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
  await requirePermission('orders.assign');
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) return bulkRefuse(zodMessage(parsed.error), 'INVALID_BODY');
  const { companyId, storeId, user } = ctx;
  if (!storeId) return bulkRefuse('اختار متجر قبل التوزيع.', 'STORE_REQUIRED');
  const scope = { companyId, storeId };
  const input = parsed.data;
  const now = new Date();

  const agents = await bulkAgents(scope, input.agentIds);
  if (agents.length !== new Set(input.agentIds).size) {
    return bulkRefuse('في موظفة من اللي اخترتهن ما بتقدر تستلم طلبات بهالمتجر.', 'INVALID_AGENT');
  }
  // The agents in the order the manager picked them, so the even split starts where she started.
  const ordered = input.agentIds.filter((id, i, all) => all.indexOf(id) === i).map((id) => agents.find((a) => a.id === id)!);
  const perAgentOf = (counts: Record<string, number>) => ordered.map((a) => ({ id: a.id, name: a.name, listOpen: a.listOpen, count: counts[a.id] ?? 0 }));

  if (input.action === 'rehand-preview' || input.action === 'rehand-run') {
    const rows = await db.order.findMany({
      where: { ...offeredBeforeWhere(scope), ...(input.action === 'rehand-run' ? { id: { in: input.orderIds } } : {}) },
      orderBy: [{ winbackListAt: 'desc' }, { id: 'desc' }],
      take: input.action === 'rehand-run' ? input.orderIds.length : input.count,
      select: { id: true, orderNumber: true },
    });
    const counts: Record<string, number> = {};
    const plan = rows.map((r, i) => {
      const agentId = ordered[i % ordered.length].id;
      counts[agentId] = (counts[agentId] ?? 0) + 1;
      return { orderId: r.id, orderNumber: r.orderNumber, agentId };
    });
    if (input.action === 'rehand-preview') return NextResponse.json({ planned: plan, perAgent: perAgentOf(counts) });
    const results: RowResult[] = input.orderIds
      .filter((id) => !rows.some((r) => r.id === id))
      .map((id) => ({ orderId: id, orderNumber: '', ok: false, code: 'NOT_OFFERED_BEFORE', reasonAr: 'مش من اللي انعرضوا من قبل (أو انوزّع للتو)' }));
    for (const p of plan) {
      const ok = await handToList(db, { ...scope, orderId: p.orderId, agentId: p.agentId, byUserId: user.id, now, rehand: true });
      results.push(
        ok
          ? { orderId: p.orderId, orderNumber: p.orderNumber, ok, agentId: p.agentId }
          : { orderId: p.orderId, orderNumber: p.orderNumber, ok, code: 'TAKEN_MEANWHILE', reasonAr: 'انوزّع للتو من ضغطة تانية' }
      );
    }
    return finishRun(ctx, 'WINBACK_REHAND_RUN', input.orderIds.length, results, ordered);
  }

  const rule = await winbackRule(companyId);
  const prices = await readWinbackPrices(companyId);
  // The pool's «ready» view — the very filter the list shows — narrowed by the manager's choices. An order already offered (its
  // `replacedBy` is set — the 165 handed out by hand on 25/11 among them) is never in it.
  const clauses: Prisma.OrderWhereInput[] = [viewWhere('ready', rule, now)];
  if (input.action === 'bulk-preview') {
    if (input.reason) {
      if (!isReason(input.reason)) return bulkRefuse(`سبب الإلغاء غير معروف: ${input.reason}`, 'INVALID_REASON');
      clauses.push(reasonWhere(input.reason));
    }
    if (input.period) clauses.push(periodWhere(input.period, now, rule));
    if (input.productId) clauses.push({ OR: [{ items: { some: { productId: input.productId } } }, { items: { none: {} }, productId: input.productId }] });
  } else {
    clauses.push({ id: { in: input.orderIds } });
  }
  const read = await readCandidates({ ...baseWhere(scope, rule, now), AND: clauses }, input.action === 'bulk-preview' ? BULK_SCAN : input.orderIds.length);
  // What ONE piece of the new order costs — the floor the price is held above, read exactly as the creator costs it (`winbackUnitCost`):
  // the owner's fixed figure, else the cancelled order's own cost over its own pieces. Never the old quantity's cost copied.
  const figures = await fixedCostsOf(db, companyId, [...new Set(read.flatMap((c) => c.lines.map((l) => l.productId)))]);
  const candidates = read.map((c) => ({
    ...c,
    unitCost: winbackUnitCost(figures.get(c.lines[0]?.productId ?? ''), c.oldCost, c.lines.reduce((n, l) => n + l.quantity + l.freeQuantity, 0)).unit,
  }));
  const customerIds = candidates.map((c) => c.customerId);
  const [customers, liveCustomers] = await Promise.all([customerWinbackVerdicts(db, scope, customerIds), customersWithALiveOrder(scope, customerIds)]);
  const plan = planBulk({
    candidates,
    count: input.action === 'bulk-preview' ? input.count : input.orderIds.length,
    agents: ordered,
    customers,
    liveCustomers,
    prices,
  });
  const skipped = Object.entries(plan.skipped).map(([code, count]) => ({ code, count, reasonAr: SKIP_AR[code as SkipCode] ?? code }));

  if (input.action === 'bulk-preview') {
    const offeredBefore = await db.order.count({ where: offeredBeforeWhere(scope) });
    return NextResponse.json({ planned: plan.planned, perAgent: perAgentOf(plan.perAgent), skipped, scanned: candidates.length, offeredBefore });
  }

  // THE RUN — one order at a time, in the planned order. Each row answers for itself; a failure never stops the next.
  const results: RowResult[] = [];
  const found = new Set(candidates.map((c) => c.orderId));
  for (const id of input.orderIds) {
    if (!found.has(id)) results.push({ orderId: id, orderNumber: '', ok: false, code: 'NOT_IN_POOL', reasonAr: 'ما عاد بقايمة الجاهز (انعرض أو تغيّر)' });
  }
  for (const s of plan.skippedRows) results.push({ orderId: s.orderId, orderNumber: s.orderNumber, ok: false, code: s.code, reasonAr: SKIP_AR[s.code] });
  for (const p of plan.planned) {
    const customerId = candidates.find((c) => c.orderId === p.orderId)!.customerId;
    try {
      // Re-asked at the press: another manager's run may have just given this customer an order.
      if ((await customersWithALiveOrder(scope, [customerId])).has(customerId)) {
        results.push({ orderId: p.orderId, orderNumber: p.orderNumber, ok: false, code: 'CUSTOMER_HAS_LIVE_ORDER', reasonAr: SKIP_AR.CUSTOMER_HAS_LIVE_ORDER });
        continue;
      }
      const done = await offerOne(ctx, { orderId: p.orderId, discount: 0, note: `توزيع جماعي — سعر الاسترجاع ${p.price} لـ${p.pieces} قطع`, priced: { price: p.price, pieces: p.pieces } });
      if (!done.ok) {
        const b = done.body as { error?: string; errorAr?: string; code?: string };
        results.push({ orderId: p.orderId, orderNumber: p.orderNumber, ok: false, code: b.code ?? 'REFUSED', reasonAr: b.errorAr ?? b.error ?? 'انرفض' });
        continue;
      }
      const listed = await handToList(db, { ...scope, orderId: done.body.order.id, agentId: p.agentId, byUserId: user.id, now });
      results.push(
        listed
          ? { orderId: p.orderId, orderNumber: p.orderNumber, ok: true, agentId: p.agentId, newOrderNumber: done.body.order.orderNumber }
          : { orderId: p.orderId, orderNumber: p.orderNumber, ok: false, newOrderNumber: done.body.order.orderNumber, code: 'NOT_LISTED', reasonAr: 'انعمل الطلب بس ما انحط بقايمتها (حدا مسكه للتو)' }
      );
    } catch (e) {
      // The unique link (`replacesOrderId`) refused a second offer — another press got there first. Nothing about the customer is logged.
      const race = (e as { code?: string })?.code === 'P2002';
      results.push({ orderId: p.orderId, orderNumber: p.orderNumber, ok: false, code: race ? 'ALREADY_OFFERED' : 'FAILED', reasonAr: race ? 'انعرض عليه للتو من ضغطة تانية' : 'تعذّر إنشاء الطلب' });
    }
  }
  return finishRun(ctx, 'WINBACK_BULK_RUN', input.orderIds.length, results, ordered);
}

/** One audit line per press — counts, agents and orders' ids only, never a customer field — and the per-row answer. */
async function finishRun(ctx: Ctx, action: string, asked: number, results: RowResult[], agents: ReadonlyArray<{ id: string }>): Promise<Response> {
  const made = results.filter((r) => r.ok);
  await logAudit({
    companyId: ctx.companyId,
    userId: ctx.user.id,
    action,
    entity: 'Company',
    entityId: ctx.companyId,
    newData: {
      storeId: ctx.storeId,
      asked,
      done: made.length,
      failed: results.length - made.length,
      perAgent: Object.fromEntries(agents.map((a) => [a.id, made.filter((r) => r.agentId === a.id).length])),
    },
  });
  return NextResponse.json({ created: made.length, failed: results.length - made.length, results });
}
