import { priceIncludesDeliveryFor } from '@/lib/delivery-fees';
import { NextResponse } from 'next/server';
import { notify } from '@/lib/notify';
import { z } from 'zod';
import { count, money as amount, readLimit, readPage } from '@/lib/numeric-input';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { findOrCreateCustomer } from '@/lib/customer-identity';
import { CORE_STATES, deriveCoreState, getZone, whereForState, type CoreState, type StateSource } from '@/lib/order-state';
import { OUTCOME_CLOSED, OUTCOME_LABEL_AR, orderOutcome } from '@/lib/order-outcome';
import { orderRefFields } from '@/lib/order-ref';
import { computeCod } from '@/lib/money';
import { productCosts } from '@/lib/product-cost';
import { normalizePhoneNumber } from '@/lib/phone';
import { isValidPhoneFor, phoneErrorFor, ruleFor } from '@/lib/phone-rules';
import { activeBlock } from '@/lib/blacklist';
import { logAudit } from '@/lib/audit';
import { applyQueueFilter } from '@/lib/rbac';
import { ordersWhere } from '@/lib/order-filters';
import { apiError } from '@/lib/api-error';
import { requirePermission, getPermissionScope, can } from '@/lib/authorization';
import { entryOwnership, ownedCounts, recordEntryClaim, ENTRY_CAP_FULL_MESSAGE } from '@/lib/confirmation-queue';
import { zodMessage } from '@/lib/zod-message';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { giftUnits } from '@/lib/offer-gift';
import { projectOrder } from '@/lib/order-projection';
import { heldFor } from '@/lib/order-reservation';
import { flagRecentTwins } from '@/lib/recent-twin-order';
import { responsibleModerator, MODERATOR_FORBIDDEN_AR } from '@/lib/responsible-moderator';

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, countryId, country } = await requireContext();

    // Explicit canonical gate — orders.view scope decides order visibility
    if (!getPermissionScope(user, 'orders.view')) {
      return NextResponse.json({ error: 'Forbidden: missing required permission orders.view', errorAr: 'لا تملك صلاحية عرض الطلبات.' }, { status: 403 });
    }
    const { searchParams } = new URL(req.url);

    /*
     * `limit` already had the NaN guard; `page` never did, and the arrows
     * are what sends it. `parseInt('abc', 10)` is `NaN`, so `skip` below was
     * `NaN`, and Prisma refuses `NaN` in the client — which `api-error.ts`
     * turns into a 500 «حدث خطأ داخلي» because a Prisma message carries the
     * server's own file paths and may not be shown. One bad character in a
     * query string took the orders list down.
     *
     * Twenty-five reads well; a batch being printed or exported needs all of
     * it. The ceiling is what one screen can render without stalling, and the
     * response says the real total either way, so the count never lies.
     */
    const page = readPage(searchParams);
    const limit = readLimit(searchParams, 25, 500);

    /*
     * THE FILTERS ARE BUILT IN ONE PLACE — see src/lib/order-filters.ts.
     *
     * This route, the CSV export and the ‹previous›/‹next› arrows all ask
     * the same question of the same table, and each used to answer it in
     * its own words. They had already drifted three ways.
     */
    // Created between two dates, inclusive of the whole closing day. The
    // export applies its own ninety-day rule, so the range is the caller's.
    const from = searchParams.get('from')?.trim();
    const to = searchParams.get('to')?.trim();
    const createdAt: { gte?: Date; lte?: Date } = {};
    if (from) createdAt.gte = new Date(`${from}T00:00:00.000Z`);
    if (to) createdAt.lte = new Date(`${to}T23:59:59.999Z`);

    const built = ordersWhere(searchParams, { createdAt });
    if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });
    const whereClause: any = { companyId, storeId, ...built.where };

    // ─── Role-based visibility + workflow queues (backend-enforced) ───
    // applyQueueFilter enforces per-role visibility envelopes; never trust the
    // requested queue blindly — the server decides which queues a role may use.
    /*
     * EXCEPT THE ONE QUEUE THAT WIDENS.
     *
     * `available` is the unclaimed pool, the only queue that ADDS orders the
     * person's own envelope leaves out. The arrows door already refuses it
     * (orders/[id]/route.ts); this door honoured it, so an agent who typed
     * `?queue=available&limit=500` got the whole pool with names, phones and
     * addresses — the list the confirmation queue gives her only as a count.
     * It is the supervisor's, or someone who sees every order anyway.
     */
    const queue = searchParams.get('queue');
    const mayAskPool = can(user, 'confirmation.supervise') || getPermissionScope(user, 'orders.view')?.scope === 'ALL_COMPANY';
    const visibleWhere = applyQueueFilter(user, whereClause, queue === 'available' && !mayAskPool ? null : queue);

    const [total, orders] = await Promise.all([
      db.order.count({ where: visibleWhere }),
      db.order.findMany({
        where: visibleWhere,
        include: {
          customer: {
            select: {
              id: true, fullName: true, phone: true, rawPhone: true, city: true, address: true,
              // Repeat customer: the list shows a counter that opens the history.
              totalOrders: true, deliveredOrders: true, cancelledOrders: true,
            },
          },
          product: {
            select: { id: true, name: true, sku: true, image: true },
          },
          offer: {
            select: { id: true, name: true, quantity: true, sellingPrice: true },
          },
          moderator: {
            select: { id: true, name: true, email: true },
          },
          // Who is carrying it, and where it is going — both are read on the
          // list, so neither needs opening the order to see.
          region: { select: { id: true, name: true } },
          deliveryProvider: { select: { id: true, name: true, kind: true } },
          // Whom a returning customer's order is held for (order-reservation.ts) — read here, shown only while the hold stands.
          assignee: { select: { id: true, name: true, status: true } },
          // Has anybody ever claimed it? A hold belongs to an order that has just arrived and nobody else (order-reservation.ts).
          _count: { select: { claimHistory: true } },
          // whether the counting desk received it, and with a fee or not —
          // the half of «where it ended up» the order's own columns lack
          returnReceipt: { select: { courierFeeCharged: true, receivedQty: true, damagedQty: true, missingQty: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'قائمة الطلبات', rows: orders });

    return NextResponse.json({
      // The ONE state the whole app shows, derived from the stored fields —
      // the legacy `status` column is kept for compatibility but never drives
      // a screen, because it drifts from confirmation/shipping status.
      // Cost, profit and the customer's private counters only to their own keys — see order-projection.ts.
      orders: orders.map(({ assignee, _count, ...o }) => projectOrder({
        ...o,
        reservedFor: heldFor({ ...o, assignee, everClaimed: _count.claimHistory > 0 }, new Date()),
        state: deriveCoreState(o as unknown as StateSource),
        zone: getZone(deriveCoreState(o as unknown as StateSource)),
        // in the owner's words, read from the same fields (order-outcome.ts)
        outcome: OUTCOME_LABEL_AR[orderOutcome(o)],
        outcomeClosed: OUTCOME_CLOSED[orderOutcome(o)],
        previousOrders: Math.max(0, (o.customer.totalOrders ?? 1) - 1),
      }, user)),
      // The store's own currency. The list used to print a hard-coded $ on
      // every row, which read as dollars on a Jordanian store.
      currency: { code: country.currencyCode, minorUnit: country.minorUnit },
      /*
       * AND THE COUNTRY'S CALLING CODE, FOR THE SAME REASON.
       *
       * The rows carry a local number (`079…`), and `wa.me` takes nothing
       * but full international digits — so a WhatsApp link built in the
       * browser from a local number opens a chat with a number that does
       * not exist. The country is known HERE, from the request context,
       * and nowhere in the browser. The tracking screen already receives
       * it this way; the orders list had no contact buttons at all.
       */
      dialCode: ruleFor(country.code)?.dialCode ?? null,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, countryId, country } = await requireContext();
    await requirePermission('orders.create');

    const body = await req.json();

    /**
     * ── ONE ORDER IS NOT THREE HUNDRED ──
     *
     * `ImportOrdersDialog` has no bulk endpoint of its own: it reads the
     * file in the browser and posts the rows HERE, one call each. Which
     * means `orders.create` — «may type an order» — was also «may feed a
     * spreadsheet through», and the owner's rule is that a confirmation
     * agent does the first and not the second.
     *
     * So the dialog says what it is, and this door asks for the matching
     * permission. The flag is the client's claim about itself, and that is
     * enough: it can only ever ADD a requirement. A caller who lies by
     * omission is left exactly where they were before this existed, still
     * holding `orders.create` and still posting one row per call — which
     * is the honest shape of the limit, and is recorded as known in
     * BACKLOG_P2.md rather than pretended away.
     */
    if (body?.viaImport === true && !can(user, 'orders.import')) {
      return NextResponse.json(
        {
          error: 'لا تملك صلاحية استيراد الطلبات — الإدخال اليدوي متاح.',
          code: 'IMPORT_NOT_ALLOWED',
        },
        { status: 403 }
      );
    }

    // Server-side Zod validation — never trust client input
    const orderSchema = z.object({
      customerName: z.string().trim().min(2).max(80),
      customerPhone: z.string().trim().min(7).max(20),
      customerAltPhone: z.string().trim().max(20).optional().nullable(),
      customerAddress: z.string().trim().max(200).optional().nullable(),
      customerCity: z.string().trim().max(60).optional().nullable(),
      // Region of THIS country; it drives the delivery fee and the late threshold.
      regionId: z.string().uuid().optional().nullable(),
      // One order, one or more products. The single-product fields below are
      // the shorthand for a single line and every existing caller — landing
      // pages, Telegram, AI intake — keeps using them unchanged.
      items: z
        .array(
          z.object({
            productId: z.string().min(10).max(64),
            offerId: z.string().min(10).max(64).optional().nullable(),
            quantity: count(999, 1),
            unitPrice: amount(100000),
          })
        )
        .min(1)
        .max(20)
        .optional(),
      productId: z.string().min(10).max(64).optional(),
      offerId: z.string().min(10).max(64).optional().nullable(),
      quantity: count(999, 1).optional(),
      sellingPrice: amount(100000).optional(),
      shippingCost: amount(1000).optional(),
      source: z.string().trim().max(60).optional(),
      // The channel this came through. Its name is written into `source` too,
      // so the order keeps saying where it came from even if the channel is
      // later renamed or retired.
      channelId: z.string().uuid().optional().nullable(),
      moderatorId: z.string().max(64).optional().nullable(),
      customerNotes: z.string().trim().max(500).optional().nullable(),
      internalNotes: z.string().trim().max(500).optional().nullable(),
    });
    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }
    const v = parsed.data;

    const {
      customerName,
      customerPhone,
      customerAltPhone,
      customerAddress,
      customerCity,
      regionId,
      productId,
      offerId,
      quantity,
      sellingPrice,
      shippingCost,
      source,
      channelId,
      moderatorId,
      customerNotes,
      internalNotes,
    } = v;

    /*
     * WHO IS RESPONSIBLE FOR THIS ORDER — decided by a KEY, and BEFORE anything is written.
     *
     * Naming somebody other than yourself needs `orders.assign` (RV150: with the moderator goes the commission), and an
     * order typed by somebody who does not hand orders out is theirs. The rule is `responsibleModerator`; this is its only
     * use on this door. The owner's rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
     */
    const responsible = responsibleModerator({
      requestedId: moderatorId,
      creatorId: user.id,
      mayAssign: can(user, 'orders.assign'),
    });
    if (!responsible.ok) {
      return NextResponse.json({ error: MODERATOR_FORBIDDEN_AR, code: responsible.code }, { status: 403 });
    }

    // The channel, if one was named: it must be ours, and its name becomes
    // the order's written source.
    let channel: { id: string; name: string } | null = null;
    if (channelId) {
      channel = await db.orderChannel.findFirst({
        where: { id: channelId, companyId, isActive: true },
        select: { id: true, name: true },
      });
      if (!channel) {
        return NextResponse.json({ error: 'القناة غير موجودة أو موقوفة' }, { status: 400 });
      }
    }

    // The order's lines, however they were sent: an explicit array, or the
    // single-product shorthand. Everything below works on this one list, so
    // a one-line order and a five-line one take exactly the same path.
    const requestedLines =
      v.items && v.items.length
        ? v.items
        : productId
          ? [{ productId, offerId: offerId ?? null, quantity: quantity ?? 1, unitPrice: sellingPrice ?? 0 }]
          : [];

    if (!customerName || !customerPhone || requestedLines.length === 0) {
      return NextResponse.json(
        { error: 'اسم العميل ورقم الهاتف ومنتج واحد على الأقل مطلوبة' },
        { status: 400 }
      );
    }

    // The same phone rule the public landing page applies. Without it the
    // CRM accepted any 7 characters, which is where most "رقم خاطئ" issues
    // were born: nothing refused the number until someone tried to call it.
    if (!isValidPhoneFor(country.code, customerPhone)) {
      return NextResponse.json(
        { error: phoneErrorFor(country.code), code: 'INVALID_PHONE', field: 'customerPhone' },
        { status: 400 }
      );
    }
    if (customerAltPhone && !isValidPhoneFor(country.code, customerAltPhone)) {
      return NextResponse.json(
        { error: phoneErrorFor(country.code), code: 'INVALID_PHONE', field: 'customerAltPhone' },
        { status: 400 }
      );
    }

    // 1. Duplicate check / Customer creation (reuse on a P2002 race)
    const normalizedPhone = normalizePhoneNumber(customerPhone, country.code);

    // ─── Blacklist, company-wide ───
    // Staff get the real reason: they are the ones who decide whether to
    // release it, and a silent refusal here would just look like a bug.
    const block = await activeBlock(db, companyId, customerPhone);
    if (block) {
      return NextResponse.json(
        {
          error: `هذا الرقم محظور: ${block.reason}`,
          code: 'CUSTOMER_BLOCKED',
          blockId: block.id,
        },
        { status: 409 }
      );
    }
    // The same identity rule every other door uses — see customer-identity.
    const customer = await findOrCreateCustomer(db, {
      companyId,
      storeId,
      phone: normalizedPhone,
      rawPhone: customerPhone.trim(),
      fullName: customerName.trim(),
      altPhone: customerAltPhone?.trim() || null,
      address: customerAddress?.trim() || '',
      city: customerCity?.trim() || '',
    });

    // 2. Every product the order names, in one query — tenant-validated, so
    // an order can never reference another company's product.
    const productIds = [...new Set(requestedLines.map((l) => l.productId))];
    const productRows = await db.product.findMany({
      where: { id: { in: productIds }, companyId },
      include: {
        batches: { where: { companyId }, orderBy: { productionDate: 'desc' }, take: 1 },
      },
    });
    if (productRows.length !== productIds.length) {
      return NextResponse.json({ error: 'أحد المنتجات غير موجود في شركتك' }, { status: 404 });
    }
    const productById = new Map(productRows.map((p) => [p.id, p]));
    // The first line names the order: its product is the one the list shows
    // and the one per-product reporting groups by.
    const product = productById.get(requestedLines[0].productId)!;

    // The region must belong to the selected country — a Syrian governorate
    // on a Jordanian store would have no fee row and could never ship.
    let resolvedRegionId: string | null = null;
    if (regionId) {
      const region = await db.region.findFirst({ where: { id: regionId, countryId }, select: { id: true } });
      if (!region) {
        return NextResponse.json({ error: 'المحافظة لا تتبع بلد المتجر الحالي' }, { status: 400 });
      }
      resolvedRegionId = region.id;
    }

    const qty = quantity || 1;
    // Legacy semantics: a line's unitPrice is the TOTAL for that line's
    // quantity, which is how every existing caller sends it.
    const shipCost = shippingCost || 0;

    // Whether the price already contains delivery is the STORE's pricing
    // policy; an offer may override it upward for its own bundle. Reading it
    // from the offer alone meant a direct order — the commonest kind — was
    // always priced as price + fee, even on a store that advertises
    // delivery-inclusive prices, and the courier statement then disagreed
    // with the order by exactly the fee.
    /*
     * ── THE OFFER THE LINE CARRIED, NOT THE ONE AT THE TOP ──
     *
     * The owner, 21/10, as two separate complaints: «الهدية ما بتنحسب من
     * المخزون» and «لما احط بالعرض شامل سعر التوصيل، عند انشاء الشحنة
     * بضيف توصيل». They were one bug.
     *
     * `offerId` here is the TOP-LEVEL field of the single-product
     * shorthand. The order dialog does not send it: it sends an offer on
     * every LINE (`CreateOrderModal.tsx:168-173`), which the schema above
     * accepts and nothing then read. So `offer` was null on every order a
     * moderator typed, and with it went:
     *
     *   • the free units      → nothing reserved them, nothing deducted
     *                           them, the shelf counted goods that had
     *                           left the building;
     *   • «شامل سعر التوصيل»  → the order was written `false`, and the
     *                           shipment then added the fee to a price
     *                           that already contained it;
     *   • the order's own `offerId` column, left empty on every such order.
     *
     * ⚠️ It passed its tests because `multi-line.test.ts:203` posts a
     * top-level `offerId` BESIDE `items[]` — a shape the real form never
     * sends. The fixture agreed with the code and neither agreed with the
     * screen.
     *
     * Every line's offer is loaded in one query, scoped to the company so
     * an id from another tenant resolves to nothing rather than to
     * somebody else's bundle.
     */
    const lineOfferIds = [
      ...new Set(
        [offerId, ...requestedLines.map((l) => l.offerId)].filter((id): id is string => !!id)
      ),
    ];
    const offersById = new Map(
      lineOfferIds.length
        ? (
            await db.offer.findMany({
              where: { id: { in: lineOfferIds }, companyId },
              // `quantity` too: the gift is per BUNDLE, and a bundle is as many units as the offer says.
              select: { id: true, quantity: true, discount: true, deliveryIncluded: true, freeQuantity: true },
            })
          ).map((o) => [o.id, o])
        : []
    );
    /** The top-level offer still wins for the single-product shorthand. */
    const offer = offerId ? (offersById.get(offerId) ?? null) : null;
    /*
     * ANY line carrying a delivery-inclusive offer makes the whole order
     * one — the same rule the storefront door already applies
     * (`public-order.ts:480`), and the only rule that can be stated about
     * a single parcel: a customer pays one delivery fee or none.
     */
    const anyLineIncludesDelivery = requestedLines.some(
      (l) => l.offerId && offersById.get(l.offerId)?.deliveryIncluded === true
    );
    const priceIncludesDelivery = await priceIncludesDeliveryFor(
      storeId,
      offer?.deliveryIncluded === true || anyLineIncludesDelivery ? true : offer?.deliveryIncluded
    );
    /**
     * THE FREE UNITS THIS LINE CARRIES — ONE GIFT PER BUNDLE, AS THE OFFER SAYS.
     *
     * This read «per unit of the line»: `freeQuantity × line.quantity`. But a line that carries an offer has the
     * offer's own quantity (the order dialog sets `quantity: offer.quantity` when the offer is picked), so «3 + 1»
     * came out as 3 + **3**: six units reserved, deducted and costed for a bundle whose name says four. The
     * storefront door counts bundles (`offer.freeQuantity × count`), which is why a landing-page order for the same
     * offer carried 3 + 1 and the same offer typed by a moderator carried 3 + 3. `giftUnits` is the one rule.
     */
    const giftOf = (line: { offerId?: string | null; quantity: number }) =>
      giftUnits(line.offerId ? offersById.get(line.offerId) : null, line.quantity);

    // ONE COD function, used by every screen and service (contract PART 5).
    // It takes the whole order at once, so a discount spread over several
    // lines is allocated in one place rather than guessed per line.
    /*
     * THE NINTH VACUOUS GUARD, DELETED RATHER THAN SWAPPED.
     *
     * This read `(line.unitPrice || 0) / line.quantity`. By here
     * `line.unitPrice` is ALWAYS a finite number: an explicit `items[]`
     * line is `unitPrice: amount(100000)` at the schema above — `money()`
     * from `numeric-input`, so `min(0).max(100000)` and nothing non-numeric
     * survives it — and the single-product shorthand is built from
     * `sellingPrice ?? 0`, where `sellingPrice` is the same `amount(100000)`
     * and the `??` has already absorbed «not sent». So the only falsy value
     * `||` could ever meet is a legitimate `0`, which it replaced with `0`.
     *
     * That is the shape this audit has now caught nine times: a fallback
     * that reads as live policy and cannot run. Swapping it for `??` would
     * have kept the appearance and added nothing.
     *
     * `line.quantity > 0` stays, and is not the same kind of thing: it is
     * `count(999, 1)` so it cannot be 0 today either, but it guards a
     * DIVISION, and a division that cannot divide by zero is worth saying
     * out loud. What it returns in that branch is now the unit price
     * itself, with no fallback dressing.
     */
    const codLines = requestedLines.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.quantity > 0 ? line.unitPrice / line.quantity : line.unitPrice,
    }));
    const money = computeCod({
      lines: codLines,
      discount: offer?.discount ?? 0,
      deliveryFee: shipCost,
      priceIncludesDelivery,
      minorUnit: country.minorUnit,
    });
    const totalAmount = money.cod;

    // The legacy single-product columns describe the order as a whole: how
    // many units it holds, and what the goods on it are worth. Commission and
    // reporting read totalAmount, so those stay right for a multi-line order.
    const qtyTotal = requestedLines.reduce((sum, l) => sum + l.quantity, 0);
    const price = money.subtotal;

    // Cost of goods across every line, at the WEIGHTED AVERAGE of the stock
    // actually on hand. It used to read `batches[0]` — whichever batch the
    // query returned first, which is an accident rather than a policy, and
    // it moved every order's reported profit by the gap between two
    // arbitrary runs.
    const costByProduct = await productCosts(
      db,
      companyId,
      [...new Set(requestedLines.map((l) => l.productId))]
    );
    /*
     * ⚠️ THE GIFT COSTS WHAT IT COSTS.
     *
     * A free unit is free to the CUSTOMER, never to the shop: it is a unit
     * off the shelf like any other. Costing only `l.quantity` made the
     * profit on every bundle look better than it was, by exactly the cost
     * of the units given away.
     */
    const estimatedCostOfGoods = Number(
      requestedLines
        .reduce(
          (sum, l) =>
            sum + (costByProduct.get(l.productId)?.average || 0) * (l.quantity + giftOf(l)),
          0
        )
        .toFixed(2)
    );

    /*
     * ── WHOSE ORDER IS THIS THE MOMENT IT IS TYPED ──
     *
     * An agent taking an order over the phone used to have to let go of it
     * and pull it back out of the queue — and could draw somebody else's
     * instead, while a colleague drew hers and rang a customer who had
     * already ordered. `entryOwnership` is the rule, and it is asked by
     * permission and not by role name.
     *
     * The held count is read ONLY when the rule needs it: for anybody who
     * does not keep their own entries, this costs no query at all.
     */
    const keepsIt = can(user, 'confirmation.work') && !can(user, 'confirmation.supervise');
    const entry = entryOwnership({
      userId: user.id,
      holds: (perm) => can(user, perm as Parameters<typeof can>[1]),
      heldTotal: keepsIt ? (await ownedCounts(db, { companyId, storeId }, user.id)).total : 0,
      now: new Date(),
    });

    // Moderator assignment — Phase S: moderator must belong to THIS company
    const assignedModeratorId = responsible.moderatorId;
    // Yourself needs no lookup — the session is this company's by construction. Only somebody else is checked.
    if (assignedModeratorId && assignedModeratorId !== user.id) {
      const mod = await db.user.findFirst({ where: { id: assignedModeratorId, companyId } });
      if (!mod) {
        return NextResponse.json({ error: 'الموديريتور غير موجود في شركتك' }, { status: 404 });
      }
    }

    // NO COMMISSION IS COMPUTED HERE ANY MORE.
    //
    // This used to write `price × user.commissionRate` into the order the
    // moment it was created — a number that knew nothing about the
    // commission RULES, their dates or their store, and that was fixed
    // before anybody knew whether the order would ever be delivered. It
    // then fed the profit line, so the dashboard and the commission screen
    // reported two different commissions for the same month.
    //
    // Commission is the LEDGER's, and the ledger accrues on DELIVERY
    // (`accrueForOrder`, which refuses a non-delivered order outright). The
    // moderator is still resolved here, because who owns the order is this
    // route's business; what they earn is not.

    // 3. Create Order (with product snapshot for historical accuracy).
    // Workflow defaults (Step 4): NEW + unowned → lands in the claimable
    // Confirmation Queue for eligible employees immediately.
    // Everything (order + customer counters + activity + status log) is one
    // atomic transaction; the sequential order number retries on a P2002 race.
    const now = new Date();
    const order = await db.$transaction(async (tx) => {
      let created: any = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const refs = await orderRefFields(tx, companyId, country.orderPrefix, attempt, now);

          created = await tx.order.create({
            data: {
              companyId,
              countryId,
              storeId,
              ...refs,
              regionId: resolvedRegionId,
              priceIncludesDelivery,
              customerId: customer.id,
              productId: product.id,
              /*
               * The order's own offer: the shorthand's, or the first one
               * a line carried. It was always null for an order typed in
               * the dialog, so «which bundle did this sell» could not be
               * answered about the orders a moderator takes — the
               * commonest kind.
               */
              offerId: offerId || requestedLines.find((l) => l.offerId)?.offerId || null,
              quantity: qtyTotal,
              sellingPrice: price,
              shippingCost: shipCost,
              totalAmount,
              currency: country.currencyCode,
              moderatorId: assignedModeratorId,
              // Who TYPED it — whatever their role. `moderatorId` only ever
              // recorded a MODERATOR, so an agent's own entry had no creator.
              createdById: user.id,
              estimatedCostOfGoods,
              productNameSnapshot: product.name,
              productImageSnapshot: product.image || null,
              status: 'NEW',
              confirmationStatus: 'NEW',
              shippingStatus: 'NOT_READY',
              settlementStatus: 'NOT_APPLICABLE',
              // Ownership: hers at once when she works a queue, otherwise
              // created-but-unclaimed and in the AVAILABLE queue as before.
              assignedToId: null,
              claimedById: entry.claimedById,
              claimedAt: entry.claimedAt,
              currentOwnerId: entry.currentOwnerId,
              signatureStatus: 'UNSIGNED',
              version: 1,
              channelId: channel?.id ?? null,
              source: channel?.name || source || 'Manual',
              customerNotes: customerNotes?.trim() || null,
              internalNotes: internalNotes?.trim() || null,
            },
          });
          break;
        } catch (e: any) {
          // Duplicate order number race → retry with the next number
          if (e?.code === 'P2002' && attempt < 4) continue;
          throw e;
        }
      }
      if (!created) throw new Error('Failed to generate a unique order number');

      // 3b. The order's lines. Reservation and the discount share live per
      // line, and the shares come from the COD function's allocation so the
      // parts always add back up to the whole.
      await tx.orderItem.createMany({
        data: requestedLines.map((line, i) => ({
          companyId,
          orderId: created.id,
          productId: line.productId,
          productName: productById.get(line.productId)?.name ?? '',
          quantity: line.quantity,
          /*
           * THE FREE UNITS, WRITTEN WHERE EVERYTHING ELSE ALREADY LOOKS
           * FOR THEM.
           *
           * Nothing downstream was broken: the reservation
           * (`reservation.ts:188`), the deduction at delivery
           * (`stock-consumption.ts:100`), the return
           * (`stock-consumption.ts:332`), the partial delivery and the
           * ready-to-ship guard all read `quantity + freeQuantity`
           * already. The column was simply never filled by this door, so
           * a gift promised on the screen left the building unrecorded.
           *
           * One gift per BUNDLE, like the storefront door
           * (`public-order.ts:152`, `offer.freeQuantity × count`): «3 + 1»
           * is four units on the line, whichever door wrote it. This comment
           * used to say «per unit of the line … three on a line of three»,
           * which is what made a typed «3 + 1» three plus three.
           */
          freeQuantity: giftOf(line),
          // The same reading as `codLines` above, and for the same reason:
          // `unitPrice` is zod-validated money by the time it is here, so a
          // `|| 0` could only ever have replaced a real zero with zero.
          unitPrice: line.quantity > 0 ? line.unitPrice / line.quantity : line.unitPrice,
          discountShare: money.discountShares[i] ?? 0,
          lineTotal: money.lineTotals[i] ?? 0,
          addedById: user.id,
          addedStage: 'INTAKE',
        })),
      });

      // 4. Update Customer Stats
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          totalOrders: { increment: 1 },
          lastOrderDate: now,
          firstOrderDate: customer.firstOrderDate || now,
        },
      });

      // 5. Activity Timeline entry
      await tx.orderActivity.create({
        data: {
          companyId,
          orderId: created.id,
          userId: user.id,
          action: 'ORDER_CREATED',
          newStatus: 'NEW',
          metadata: JSON.stringify({
            source: created.source,
            createdBy: user.name,
          }),
        },
      });

      /*
       * 5b. THE CLAIM, RECORDED LIKE EVERY OTHER CLAIM.
       *
       * Inside the same transaction as the order, so an order can never
       * exist as hers with no row saying how she got it. `MANUAL_ENTRY`
       * tells it apart from a pull: the auto-release, the caps and the
       * transfer screen all read this history, and «she typed it» is a
       * different fact from «she drew it from the queue».
       */
      await recordEntryClaim(tx, { companyId, orderId: created.id, ownership: entry });

      // 6. Status log (confirmation workflow entry point)
      await tx.orderStatusLog.create({
        data: {
          companyId,
          orderId: created.id,
          statusType: 'CONFIRMATION',
          previousValue: null,
          newValue: 'NEW',
          changedById: user.id,
          changedByRole: user.role,
          note: 'Order created — entered confirmation queue',
        },
      });

      return created;
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'ORDER_CREATED',
      entity: 'Order',
      entityId: order.id,
      newData: order,
    });

    // Same customer, same product, minutes apart: a flag on the history for the person who calls — never a refusal.
    await flagRecentTwins(db, {
      companyId,
      orderId: order.id,
      customerId: customer.id,
      productIds,
      at: order.createdAt,
      userId: user.id,
    });

    // Tell the people who see new orders through to confirmation — the
    // confirmation supervisors of THIS store, not the whole company, and
    // not the person who just typed it. After commit; createNotification
    // never throws.
    notify({
      companyId,
      storeId,
      audience: { permission: 'confirmation.supervise' },
      actorId: user.id,
      title: 'طلب جديد',
      message: `تم إنشاء طلب جديد #${order.orderNumber} بواسطة ${user.name}.`,
      type: 'ORDER_NEW',
      link: ['/confirmation/queue', '/orders'],
    });

    /*
     * AND SHE IS TOLD WHEN THE CAP TOOK IT.
     *
     * Only when it was HER entry that the ceiling pushed into the queue.
     * Handing her a 121st order silently would make the cap a suggestion;
     * saying nothing at all would leave her looking for an order that is
     * not in «طلباتي».
     */
    return NextResponse.json({
      success: true,
      // The created row, as this person may read it: no cost of goods to a
      // reader without «عرض المالية» (order-projection.ts).
      order: projectOrder(order, user),
      ...(entry.capFull ? { notice: ENTRY_CAP_FULL_MESSAGE } : {}),
    });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
