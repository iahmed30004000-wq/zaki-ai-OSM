import { NextResponse } from 'next/server';
import { notify } from '@/lib/notify';
import { closingStages } from '@/lib/order-closing';
import { z } from 'zod';
import { count, money as amount } from '@/lib/numeric-input';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { computeCod, totalsBeforeDiscount } from '@/lib/money';
import { hasEverShipped, hasLeftWarehouse, assertCancellable, deriveCoreState, getZone, type StateSource } from '@/lib/order-state';
import { releaseOrderLines } from '@/lib/reservation';
import { consumeOrderStock } from '@/lib/stock-consumption';
import { ORDER_ACCESS_STATUS, assertOrderAccess, assertOrderReadable, applyQueueFilter } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { logAudit } from '@/lib/audit';
import { normalizePhoneNumber } from '@/lib/phone';
import { ordersWhere } from '@/lib/order-filters';
import { isValidPhoneFor, phoneErrorFor, phoneKeys, ruleFor } from '@/lib/phone-rules';
import { CONFIRMATION_STATUSES } from '@/lib/confirmation-workflow';
import { SHIPPING_STATUSES } from '@/lib/shipping-workflow';
import { apiError } from '@/lib/api-error';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { authorize, can, getPermissionScope } from '@/lib/authorization';
import { maySeeOrderCost, projectOrder } from '@/lib/order-projection';
import { MAX_REASON, MIN_REASON, reasonRefusal } from '@/lib/order-edit-reason';
import { CHANGEABLE_FIELDS, CHANGE_FIELD_AR } from '@/lib/change-request-fields';
import { TERMINAL_CONFIRMATION_STATUSES } from '@/lib/confirmation-workflow';
import { CONTACT_FIRST_MESSAGE, needsContactFirst } from '@/lib/confirmation-queue';

import { orderSeal, sealedFieldsIn, sealMessage, handedToCourier } from '@/lib/order-seal';
import { courierActionAr, courierActionFor, courierMessage, sealedAmong } from '@/lib/courier-change';
import { expandApproved, mayApply, strayFields } from '@/lib/change-request-apply';
import { zodMessage } from '@/lib/zod-message';
import { ORDER_NOT_FOUND, ORDER_VERSION_MISSING } from '@/lib/order-refusals';

/** Legacy combined status whitelist (mirrors the UI status config) */
const ALLOWED_COMBINED_STATUSES = [
  'NEW', 'CONTACTING', 'NO_ANSWER', 'POSTPONED', 'CONFIRMED', 'REJECTED', 'CANCELLED',
  'READY_FOR_SHIPPING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_DELIVERY',
  'RETURN_REQUESTED', 'RETURNED',
] as const;

/** Terminal combined statuses that notify company managers */
const TERMINAL_STATUSES = ['CONFIRMED', 'REJECTED', 'CANCELLED'] as const;

const parseableDate = z
  .string()
  .refine((v) => !isNaN(new Date(v).getTime()), { message: 'Invalid date' });

const patchSchema = z.object({
  status: z.enum(ALLOWED_COMBINED_STATUSES).optional(),
  moderatorId: z.string().max(64).optional().nullable(),
  internalNotes: z.string().trim().max(500).optional().nullable(),
  customerNotes: z.string().trim().max(500).optional().nullable(),
  // Customer fields are validated when present (trimmed strings)
  customerName: z.string().trim().min(2).max(80).optional(),
  customerPhone: z.string().trim().min(7).max(20).optional(),
  // The second number the customer answers on. Empty clears it.
  customerAltPhone: z.string().trim().max(20).nullable().optional(),
  customerAddress: z.string().trim().max(300).optional(),
  // The order's lines, replaced as a set: what is sent IS the order now, so
  // removing a product is simply leaving it out.
  items: z
    .array(
      z.object({
        productId: z.string().min(10).max(64),
        quantity: count(999, 1),
        unitPrice: amount(100000),
      })
    )
    .min(1)
    .max(20)
    .optional(),
  // Where this order came through. Correcting it is an ordinary edit: the
  // numbers are counted per channel and an order filed under the wrong one
  // is a wrong number, not a wrong label.
  channelId: z.string().uuid().nullable().optional(),
  // The governorate the order ships to. The delivery-fee table is keyed on
  // it, so it is editable here rather than only at intake.
  regionId: z.string().uuid().optional().nullable(),
  postponedUntil: parseableDate.nullable().optional(),
  trackingCode: z.string().trim().max(100).optional().nullable(),
  confirmationStatus: z.enum(CONFIRMATION_STATUSES).optional(),
  shippingStatus: z.enum(SHIPPING_STATUSES).optional(),
  /**
   * ORDER LINE EDITING — THE SAME READER THE CREATE DOOR USES.
   *
   * The comment here used to say «mirrors POST caps», and it did not. These
   * five fields were `z.coerce.number()`, which is `Number(value)`, and
   * `POST /api/orders` reads the SAME COLUMNS through `count()`/`money()`
   * from `numeric-input`. So `'0x10'` was sixteen units or sixteen dinars
   * on this door and a 400 on the create door — one column, two doors, two
   * notations, which is the shape `82ecac3` closed for `commissionRate`.
   * Measured: `Number('0x10')` is 16, `'0b11'` is 3, `'0o17'` is 15, and
   * `''` and `null` and `[]` are all 0.
   *
   * `.finite()` is gone from all four, and NOT because it was wrong: it
   * cannot fire. `money()`/`count()` are `z.preprocess(read, z.number()…)`
   * and zod 4's `z.number()` already refuses `Infinity` and `NaN` —
   * measured, and asserted by name in `a-column-has-one-rule.test.ts`. It
   * is also not expressible: `z.preprocess` returns a pipe with no
   * `.finite()` on it, so keeping it would not compile. A check that cannot
   * fire reads as policy while doing nothing, and ten of those have been
   * caught in this audit.
   *
   * THE BOUNDS, each with its reason rather than its inheritance:
   *
   *   · `sellingPrice` — `amount(100000)`, identical to the create door.
   *   · `quantity` — `count(999, 1)`, identical to the create door. It was
   *     `max(10000)` here, a ceiling ten times the create door's and
   *     declared nowhere else; no order could be CREATED above 999, so the
   *     only way past it was this door. Measured against the database
   *     before narrowing it: the largest quantity on any of the 56 orders
   *     is 3, so no stored row becomes unsavable.
   *   · `discountAmount` — `amount(100000)`. The create door does not
   *     accept this field at all, so there is no cap to match; 100000 is
   *     `sellingPrice`'s, and a discount is subtracted from a price, so the
   *     largest price the system accepts is the largest discount that can
   *     mean anything.
   *   · `shippingCost` — `amount(1_000_000)`, and this one DISAGREES with
   *     the create door's `amount(1000)` on purpose. 1000 cannot hold a
   *     shipping fee in Syrian pounds, where a fee is tens of thousands,
   *     and this is the door an operator corrects a real fee on after the
   *     courier tells them what it was — a cap that refuses the truth is
   *     worse here than a cap that permits a typo. 1_000_000 is not
   *     invented either: `PATCH /api/orders/[id]/shipping` declares
   *     `deliveryFee: money(1_000_000)` for the same economic quantity —
   *     a shipping fee a person types — so this borrows the one bound in
   *     the repository that was chosen for this currency. The create door's
   *     1000 is, in my reading, wrong for the same reason, and it is not
   *     mine to change; it is named in the report as the remaining
   *     disagreement.
   */
  sellingPrice: amount(100000).optional(),
  quantity: count(999, 1).optional(),
  discountAmount: amount(100000).optional(),
  shippingCost: amount(1_000_000).optional(),
  productId: z.string().min(10).max(64).optional(),
  expectedVersion: z.number().optional(),
  // Why this edit was made. Required — and only required — of an edit made
  // on company-wide authority that moves money, the customer's identity,
  // the destination or the state; see src/lib/order-edit-reason.ts. It is
  // written to the audit entry and the order's timeline, never to the order.
  reason: z.string().trim().max(MAX_REASON).optional(),
  // An approved change request, carried out. When present it is the ONLY
  // field besides expectedVersion: the values come from the approved
  // request on the server, never from this body.
  changeRequestId: z.string().uuid().optional(),
  /**
   * Set only after somebody has actually told the courier. It is not a
   * permission — it is a statement of fact, recorded on the order with the
   * name of whoever made it.
   */
  courierNotified: z.boolean().optional(),
});

/**
 * Builds the same WHERE clause used by the orders list API (/api/orders)
 * so prev/next navigation matches the exact list context (filters + tenant + RBAC).
 */
async function buildNavigationWhere(order: { createdAt: Date; companyId: string }, searchParams: URLSearchParams) {
  const { user, companyId, storeId } = await requireContext();
  const where: any = { companyId, storeId };

  /**
   * ── THE ARROWS WALK THE LIST, AND THE LIST IS NOT THE READ ENVELOPE ──
   *
   * Two things were wrong here, and they compounded.
   *
   * The first is the role NAME list that used to stand where this comment
   * is: MODERATOR · CONFIRMATION_AGENT · FOLLOW_UP_AGENT. A guard that is
   * a list is incomplete the day it is written — a custom role with the
   * same scope under another name fell through it and walked every order
   * in the store. The scope engine already answers this question, so ask
   * it instead of asking what the role is called.
   *
   * The second is worse. It used `orderVisibilityWhere`, which is the READ
   * envelope — and the read envelope deliberately carries the unclaimed
   * queue, because an agent must be able to OPEN the order she is about to
   * pull. So an agent opened one order and arrowed through the whole pool,
   * with customer names and phones: exactly the queue C2 had just taken
   * out of her list, handed back by a button beside it.
   *
   * `orderListWhere` + `applyQueueFilter` is what the list itself uses.
   * The arrows now mirror what is on screen behind the dialog, which is
   * what «navigation matches the list context» said all along.
   */
  /*
   * THE SAME BUILDER THE LIST USES — this is what «matches the exact list
   * context» above finally means.
   *
   * It used to be a third, smaller copy that filtered on the LEGACY
   * `status` column, knew nothing of the governorate, the courier, the
   * source, the dates or «late», and therefore walked a different set of
   * orders from the one on screen behind the dialog.
   */
  const from = searchParams.get('from')?.trim();
  const to = searchParams.get('to')?.trim();
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (from) createdAt.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) createdAt.lte = new Date(`${to}T23:59:59.999Z`);

  const built = ordersWhere(searchParams, { createdAt });
  // A filter this route cannot parse is not worth refusing the order over:
  // the dialog still opens, and the arrows simply span the unfiltered list.
  if (built.ok) Object.assign(where, built.where);

  /*
   * And the envelope goes on LAST, exactly as `GET /api/orders` does it
   * (`applyQueueFilter(user, whereClause, queue)`): the filters build the
   * where, and the role's envelope is ANDed over the top of it. Merged by
   * the same function, in the same order, so the two cannot drift apart
   * again — which is how the arrows came to span a different set from the
   * list in the first place.
   */
  /*
   * ONE QUEUE IS NOT PASSED THROUGH, AND IT IS THE ONE THAT WIDENS.
   *
   * The others — `my_orders`, `assigned_to_me`, `processing` — narrow, so
   * honouring them keeps the arrows inside what is on screen. `available`
   * is the claimable pool, and it is the only value that ADDS orders the
   * role's own envelope excludes. Letting it through would hand back by
   * query string exactly what this function was rewritten to close: one
   * order opened with `?queue=available` on the URL and the arrows walk
   * the whole queue again.
   *
   * No screen asks for it on this route. A hand-written request can, and
   * that is the point.
   */
  const queue = searchParams.get('queue');
  return applyQueueFilter(user, where, queue === 'available' ? null : queue);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    const { searchParams } = new URL(req.url);

    // ── Phase S: role-scoped access (same envelope as the list API) ──
    // Self-scoped roles may only read orders assigned/claimed/created by them
    // or claimable queue items — never another employee's private orders.
    // And the order she holds, through the work door (order-work-door.ts).
    const access = await assertOrderReadable(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }

    const order = await db.order.findUnique({
      where: { id },
      include: {
        customer: true,
        product: true,
        offer: true,
        region: { select: { id: true, name: true } },
        // The real order lines. The legacy productId column holds only the
        // first one, so anything reading the order as a whole — partial
        // delivery, preparation, returns — needs these.
        items: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, productId: true, productName: true,
            quantity: true, freeQuantity: true, unitPrice: true,
            discountShare: true, lineTotal: true, reservedQty: true,
            deliveredQty: true, returnedQty: true,
          },
        },
        deliveryProvider: { select: { id: true, name: true, code: true } },
        landingPage: { select: { id: true, name: true, slug: true } },
        addOns: { orderBy: { createdAt: 'asc' } },
        moderator: { select: { id: true, name: true, email: true, phone: true } },
        // What this order actually cost in commission, from the LEDGER.
        // `Order.moderatorCommission` is the retired column: it was written
        // at creation from a per-user rate that knew nothing about the
        // commission rules, so the detail screen showed a figure the
        // commission screen disagreed with. Reversals are included — they
        // are negative entries, so a returned order nets to zero here.
        commissions: { select: { id: true, userId: true, role: true, amount: true, status: true } },
        claimer: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        lockHolder: { select: { id: true, name: true } },
        signer: { select: { id: true, name: true } },
        claimHistory: {
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { id: true, name: true } } },
        },
        callLogs: {
          include: { moderator: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
        },
        activities: {
          orderBy: { createdAt: 'desc' },
        },
        // Counts, not rows: the journey cards show how many attempts a stage
        // took, and the attempts themselves are in the merged event log.
        _count: { select: { contactAttempts: true, deliveryAttempts: true } },
        telegramMessages: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, chatId: true, threadId: true, threadName: true, messageId: true, createdAt: true },
        },
      },
    });

    if (!order || order.companyId !== companyId) {
      return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: 404 });
    }

    // Prev/next ids following the list order (createdAt DESC), scoped to the
    // same company + current list filters so navigation mirrors the list view.
    // "next" = newer (comes first in a DESC list), "previous" = older.
    let previousOrderId: string | null = null;
    let nextOrderId: string | null = null;
    /*
     * AND THE ARROWS THEMSELVES ARE A PERMISSION.
     *
     * Without `orders.navigate` no neighbour id leaves this route, so the
     * buttons have nothing to render and no hand-written request can walk
     * the list either — the ids were the whole mechanism.
     */
    if (can(user, 'orders.navigate')) {
      try {
      const ctxWhere = await buildNavigationWhere(order, searchParams);
      const tieBreaker = { id: 'desc' as const };
      const [newer, older] = await Promise.all([
        // Nearest newer order (created after this one) → "next" in DESC list
        db.order.findFirst({
          where: {
            AND: [
              ctxWhere,
              {
                OR: [
                  { createdAt: { gt: order.createdAt } },
                  { createdAt: order.createdAt, id: { lt: id } },
                ],
              },
            ],
          },
          orderBy: [{ createdAt: 'asc' }, tieBreaker],
          select: { id: true },
        }),
        // Nearest older order (created before this one) → "previous" in DESC list
        db.order.findFirst({
          where: {
            AND: [
              ctxWhere,
              {
                OR: [
                  { createdAt: { lt: order.createdAt } },
                  { createdAt: order.createdAt, id: { gt: id } },
                ],
              },
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          select: { id: true },
        }),
      ]);
      nextOrderId = newer?.id ?? null;
      previousOrderId = older?.id ?? null;
      } catch {
        // Navigation is best-effort; never fail the order fetch because of it
      }
    }

    // The SAME derived state every other screen shows. The stored `status`
    // column is legacy and drifts: an order can read CONFIRMED there while it
    // is already READY_TO_SHIP. One truth, computed in one place.
    const state = deriveCoreState(order as unknown as StateSource);

    /**
     * WHAT THE BUSINESS IS STILL WAITING FOR — beside the zone, not instead.
     *
     * «الكاش لحال والمرتجع لحال», and a partly delivered order runs both.
     * The zone already says nobody in operations is working on a delivered
     * parcel; it does not say whether its money arrived. Measured here: 3190
     * concluded parcels and none settled.
     *
     * The receipt is the authority for the goods half — a status saying
     * «تم إرجاعها» is the courier's word for a parcel that may still be on
     * his van, and closing an order on it would count goods back onto a
     * shelf that never received them.
     */
    const returnReceived =
      (await db.returnReceipt.count({ where: { orderId: order.id, companyId } })) > 0;
    const closing = closingStages({
      shippingStatus: order.shippingStatus,
      settlementStatus: order.settlementStatus,
      returnReceived,
      confirmationStatus: order.confirmationStatus,
    });

    // What the customer actually pays at the door, from the ONE cod function
    // (contract invariant: never computed in a screen). With a price that
    // includes delivery the fee is already inside the line prices, so the
    // detail screen can state that instead of listing a fee above a total
    // that does not contain it.
    const cod = computeCod({
      lines: (order.items ?? []).map((line) => ({
        quantity: line.quantity,
        unitPrice: Number(line.unitPrice),
      })),
      deliveryFee: Number(order.deliveryFee ?? order.shippingCost ?? 0),
      discount: Number(order.discountAmount ?? 0),
      priceIncludesDelivery: order.priceIncludesDelivery === true,
      minorUnit: country.minorUnit,
    });

    /*
     * WHAT EACH LINE COST BEFORE THE DISCOUNT, SAID BY THE SERVER.
     *
     * The lines editor sends each price box back as `items[].unitPrice`, and
     * the PATCH below reads that as the line BEFORE the order's discount and
     * spreads the discount again. The box opened on `lineTotal`, which is
     * after it, so a save with nothing touched took the discount twice. The
     * figure goes out beside the stored columns, so the card puts a number
     * in the box instead of adding two of them — see `totalsBeforeDiscount`
     * for why it is not always `lineTotal + discountShare`.
     */
    const beforeDiscount = totalsBeforeDiscount(
      order.items ?? [],
      Number(order.discountAmount ?? 0),
      country.minorUnit
    );
    const items = (order.items ?? []).map((line, i) => ({ ...line, beforeDiscount: beforeDiscount[i] }));

    // Decimal never leaves as a Decimal: the browser would receive a string
    // and `money()` would render it as NaN.
    const commission = Number(
      order.commissions.reduce((sum, e) => sum + Number(e.amount), 0).toFixed(country.minorUnit)
    );

    /*
     * One order, one person's contact details — and the same tally the
     * lists feed. Counted here too, or the hole is the obvious one: open
     * five hundred orders one at a time and no list endpoint sees any of
     * it. The same argument the customer profile already makes.
     */
    await noteCustomersHandedOut({
      companyId, storeId, user, where: 'تفاصيل الطلب', rows: [order],
    });

    return NextResponse.json({
      // Cost, profit and other people's commission only to those whose screens show money — see order-projection.ts.
      order: projectOrder(
        { ...order, items, state, zone: getZone(state), commission: maySeeOrderCost(user) ? commission : undefined, closing },
        user,
      ),
      // The store's own currency, so the detail screen shows the same money
      // the list does instead of a hard-coded dollar sign.
      currency: { code: country.currencyCode, minorUnit: country.minorUnit },
      /*
       * The country's calling code. The window shows the customer's number
       * in its local form, and `wa.me` takes full international digits
       * only — a link built in the browser from `079…` opens a chat with a
       * number that does not exist. The country is known here, not there.
       */
      dialCode: ruleFor(country.code)?.dialCode ?? null,
      cod: { ...cod, includesDelivery: order.priceIncludesDelivery === true },
      previousOrderId,
      nextOrderId,
    });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();

    // Server-side Zod validation — never trust client input
    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }
    // ── An approved change request, carried out ──
    //
    // The browser names the request and nothing else; the edit is rebuilt
    // here from what was approved. Anything else in the body is refused,
    // because this authority passes the seal and must not carry a second
    // change through with it.
    let data: z.infer<typeof patchSchema> = parsed.data;
    let viaRequest: { id: string; orderId: string; reason: string; decisionNote: string | null; requestedById: string } | null = null;
    /** Somebody has told the courier, and is saying so. */
    const courierTold = parsed.data.courierNotified === true;
    if (parsed.data.changeRequestId) {
      const stray = strayFields(parsed.data as Record<string, unknown>);
      if (stray.length > 0) {
        return NextResponse.json(
          { error: 'تطبيق طلب التعديل لا يقبل حقولاً أخرى معه', code: 'STRAY_FIELDS', fields: stray },
          { status: 400 }
        );
      }
      const request = await db.orderChangeRequest.findFirst({
        where: { id: parsed.data.changeRequestId, companyId },
        select: { id: true, orderId: true, status: true, appliedAt: true, changes: true, reason: true, decisionNote: true, requestedById: true },
      });
      if (!request) return NextResponse.json({ error: 'طلب التعديل غير موجود' }, { status: 404 });
      const expanded = expandApproved(request);
      if (!expanded.ok) {
        return NextResponse.json({ error: expanded.error, code: expanded.code }, { status: expanded.status });
      }
      const rebuilt = patchSchema.safeParse({ ...expanded.fields, expectedVersion: parsed.data.expectedVersion });
      if (!rebuilt.success) {
        // What was approved no longer passes the order's own rules — a phone
        // that was valid then and is not now, say. Refuse rather than bend.
        return NextResponse.json({ error: zodMessage(rebuilt.error), code: 'APPROVED_VALUE_INVALID' }, { status: 422 });
      }
      data = rebuilt.data;
      viaRequest = request;
    }

    const {
      status, moderatorId, internalNotes, customerNotes, postponedUntil, trackingCode,
      confirmationStatus, shippingStatus, expectedVersion,
      customerName, customerPhone, customerAltPhone, customerAddress, regionId,
      sellingPrice, quantity, discountAmount, shippingCost, productId, items, channelId,
      reason: editReason,
    } = data;

    // ── Authorization chain: visibility/assignment (RBAC engine) → canonical
    // orders.edit permission with scope evaluation (ASSIGNED scope enforces
    // own-assignment, so no separate any/own check is needed) ──
    // The work door: the order she holds opens without «عرض الطلبات».
    const access = await assertOrderAccess(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found or not assigned to you', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const existing = access.order;

    if (viaRequest) {
      const verdict = mayApply(user, viaRequest, {
        id: existing.id,
        confirmationStatus: existing.confirmationStatus,
        claimedById: existing.claimedById ?? null,
        // The handover, not the printer: a labelled parcel still on our
        // floor is the warehouse's to carry out. The batch is read below
        // for the seal; this asks the order's own state, and the seal
        // check that follows covers the batch.
        handedToCourier: handedToCourier({
          shippingStatus: existing.shippingStatus,
          shippedAt: (existing as { shippedAt?: Date | null }).shippedAt ?? null,
        }),
      });
      if (!verdict.ok) {
        return NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status });
      }
    }

    // The approved request IS the authority here — decided by somebody who
    // could reach the courier, for this order and these fields. Without one,
    // the ordinary orders.edit scope applies exactly as before.
    const editAuth = viaRequest ? { allowed: true as const } : authorize(user, 'orders.edit', existing);
    if (!editAuth.allowed) {
      // Secure policy: out-of-scope/other-tenant orders are reported as missing
      if (editAuth.reason === 'NO_TENANT' || editAuth.reason === 'OUT_OF_SCOPE') {
        return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: 404 });
      }
      return NextResponse.json(
        { error: 'Forbidden: missing required permission orders.edit', errorAr: 'لا تملك صلاحية تعديل الطلبات.' }, { status: 403 }
      );
    }

    // ── Editing-lock enforcement: an ACTIVE foreign lock blocks edits ──
    const lockActive =
      existing.lockedById &&
      existing.lockExpiresAt &&
      new Date(existing.lockExpiresAt).getTime() > Date.now();
    if (lockActive && existing.lockedById !== user.id) {
      const holder = await db.user.findUnique({ where: { id: existing.lockedById! }, select: { name: true } });
      return NextResponse.json(
        {
          error: `This order is currently being edited by ${holder?.name ?? 'another user'}.`,
          errorAr: `هذا الطلب يتم تعديله حالياً بواسطة ${holder?.name ?? 'مستخدم آخر'}.`,
          code: 'ORDER_LOCKED',
        },
        { status: 423 }
      );
    }

    // ── Separation of duties: status-category permissions ──
    const changingCombined = status && status !== existing.status;
    const changingConfirmation = confirmationStatus !== undefined && confirmationStatus !== existing.confirmationStatus;
    const changingShipping = shippingStatus !== undefined && shippingStatus !== existing.shippingStatus;
    /*
     * ═══════════════════════════════════════════════════════════════════
     * THE CONFIRMATION STATUS HAS ONE DOOR, AND THIS IS NOT IT.
     *
     * `/api/orders/[id]/confirmation` is where a confirmation status
     * moves: it holds the transition table, the «call the customer
     * first» rule (C1), the terminal lock on CONFIRMED / REJECTED /
     * CANCELLED, and the override that needs `orders.unlock` with a
     * written reason.
     *
     * THIS route accepted `status` and `confirmationStatus` too, and
     * checked only `orders.confirm` — no table, no contact-first, no
     * terminal lock. `CONFIRMATION_AGENT` and `MODERATOR` both hold
     * `orders.confirm`, so whoever held a confirmed order could move it
     * back to NEW or cancel it outright through here, and none of the
     * three rules next door applied. Two doors to one decision, and one
     * of them with none of the rules.
     *
     * No screen sends either field through this route — checked across
     * `src/components`: every status change already goes through the
     * confirmation door. So this closes a path nothing used and the
     * rules stop depending on which door somebody knocks on.
     *
     * The ONE exception is the override that already exists next door:
     * `orders.unlock` («تجاوز أقفال التحرير») with a reason in writing,
     * which is recorded the same way.
     * ═══════════════════════════════════════════════════════════════════
     */
    if (changingCombined || changingConfirmation) {
      if (!can(user, 'orders.unlock')) {
        return NextResponse.json(
          {
            // No English twin: the `code` is what a caller reads, and
            // `arabic-refusals.test.ts` holds a falling cap on English
            // sentences in this API. A sentence nobody shows and nothing
            // parses is the kind that keeps that number up.
            errorAr:
              'حالة التأكيد بتتغيّر من باب التأكيد نفسه — فيه قاعدة الاتصال أوّلاً وجدول الانتقالات وقفل الحالات النهائيّة.',
            code: 'USE_CONFIRMATION_DOOR',
          },
          { status: 409 }
        );
      }
      // With the override, still only with a reason in writing — the same
      // floor the confirmation door's own override stands on.
      if (!editReason || editReason.trim().length < MIN_REASON) {
        return NextResponse.json(
          {
            errorAr: 'تجاوز باب التأكيد بيحتاج سبباً مكتوباً.',
            code: 'REASON_REQUIRED',
          },
          { status: 400 }
        );
      }
    }
    if (changingCombined || changingConfirmation) {
      const confirmAuth = authorize(user, 'orders.confirm', existing);
      if (!confirmAuth.allowed) {
        return NextResponse.json(
          { error: 'Forbidden: you are not allowed to change order confirmation status', errorAr: 'لا تملك صلاحية تغيير حالة التأكيد.' }, { status: 403 }
        );
      }
    }
    if (changingShipping) {
      const shippingAuth = authorize(user, 'orders.change_status', existing);
      if (!shippingAuth.allowed) {
        return NextResponse.json(
          { error: 'Forbidden: you are not allowed to change shipping status', errorAr: 'لا تملك صلاحية تغيير حالة الشحن.' }, { status: 403 }
        );
      }
    }

    // ── Optimistic concurrency: expectedVersion is MANDATORY (Phase S) ──
    // Omitting it used to fall back to the just-read version, silently disabling
    // lost-update protection. All API clients must send the version they loaded.
    if (typeof expectedVersion !== 'number') {
      return NextResponse.json(
        {
          error: 'expectedVersion is required for order updates.', errorAr: ORDER_VERSION_MISSING,
          code: 'VERSION_REQUIRED',
        },
        { status: 400 }
      );
    }
    if (expectedVersion !== existing.version) {
      return NextResponse.json(
        {
          error: 'This order was updated by another user. Please refresh before saving.',
          errorAr: 'تم تعديل هذا الطلب بواسطة مستخدم آخر. يرجى تحديث الصفحة قبل الحفظ.',
          code: 'VERSION_CONFLICT',
          currentVersion: existing.version,
        },
        { status: 409 }
      );
    }

    const previousStatus = existing.status;
    const updateData: any = {};

    if (status && status !== previousStatus) {
      updateData.status = status;

      if (status === 'CONFIRMED') {
        updateData.confirmedAt = new Date();
        updateData.confirmationStatus = 'CONFIRMED';
      }

      if (status === 'SHIPPED') {
        updateData.shippedAt = new Date();
        updateData.shippingStatus = 'SHIPPED';
        updateData.settlementStatus = 'PENDING_COLLECTION';
      }

      if (status === 'DELIVERED') {
        updateData.deliveredAt = new Date();
        updateData.shippingStatus = 'DELIVERED';
        updateData.settlementStatus = 'COLLECTED';
      }

      if (status === 'REJECTED' || status === 'CANCELLED') {
        // The same guard the confirmation route applies. This legacy path
        // wrote CANCELLED without it, so a parcel already handed to a
        // courier could be cancelled here — and its units counted as back
        // on the shelf while they sat in a van.
        const cancellable = assertCancellable(existing as StateSource);
        if (!cancellable.allowed) {
          return NextResponse.json(
            { error: cancellable.message, errorAr: cancellable.message, code: cancellable.code },
            { status: 409 }
          );
        }
        updateData.confirmationStatus = 'CANCELLED';
      }
    }

    // Explicit separate-status updates (Phase D completes the workflow, fields exist now)
    // FIX: an explicit differing shippingStatus must actually be written — the
    // previous `!changingShipping` guard made every real change dead code.
    /*
     * THE SEPARATE FIELDS ASK THE SAME QUESTION AS THE COMBINED ONE.
     *
     * `status: 'CANCELLED'` above asks `assertCancellable`. Sending the same
     * ending as `confirmationStatus: 'CANCELLED' | 'REJECTED'` or as
     * `shippingStatus: 'CANCELLED'` walked past it: the order read as
     * cancelled while its parcel was labelled or on the courier's van.
     */
    const endsTheOrder =
      (shippingStatus !== undefined && shippingStatus !== existing.shippingStatus && shippingStatus === 'CANCELLED') ||
      (confirmationStatus !== undefined &&
        confirmationStatus !== existing.confirmationStatus &&
        (confirmationStatus === 'CANCELLED' || confirmationStatus === 'REJECTED'));
    if (endsTheOrder && !changingCombined) {
      const cancellable = assertCancellable(existing as StateSource);
      if (!cancellable.allowed) {
        return NextResponse.json(
          { error: cancellable.message, errorAr: cancellable.message, code: cancellable.code },
          { status: 409 }
        );
      }
    }
    if (shippingStatus !== undefined && !changingCombined) {
      updateData.shippingStatus = shippingStatus;
    }
    if (confirmationStatus !== undefined && !changingCombined) {
      updateData.confirmationStatus = confirmationStatus;
      if (confirmationStatus === 'CONFIRMED') updateData.confirmedAt = existing.confirmedAt || new Date();
    }

    // ── Derived-status enforcement: side-effects of a combined status touch
    // shipping/settlement categories — require the shipping authority even if
    // the caller only changed the legacy combined status. ──
    const derivedShippingWrite =
      (updateData.shippingStatus !== undefined || updateData.settlementStatus !== undefined) &&
      changingCombined;
    if (derivedShippingWrite) {
      const shippingAuth = authorize(user, 'orders.change_status', existing);
      if (!shippingAuth.allowed) {
        return NextResponse.json(
          { error: 'Forbidden: orders.change_status required', errorAr: 'لا تملك صلاحية تغيير حالة الطلب.' }, { status: 403 }
        );
      }
    }

    if (moderatorId !== undefined) {
      // Tenant-validate the moderator (same rule as POST /orders) — a client
      // can never attach a moderator from another company, even with a valid
      // user id. null/unset clears the assignment (existing behavior kept).
      if (moderatorId) {
        const mod = await db.user.findFirst({ where: { id: moderatorId, companyId }, select: { id: true } });
        if (!mod) {
          return NextResponse.json({ error: 'الموديريتور غير موجود في هذه الشركة' }, { status: 404 });
        }
      }
      updateData.moderatorId = moderatorId || null;
    }
    if (internalNotes !== undefined) {
      updateData.internalNotes = internalNotes;
    }
    if (customerNotes !== undefined) {
      updateData.customerNotes = customerNotes;
    }
    if (postponedUntil !== undefined) {
      updateData.postponedUntil = postponedUntil ? new Date(postponedUntil) : null;
    }
    if (channelId !== undefined) {
      // The channel is the order's attribution — which campaign, page or
      // person the sale is credited to, and what every source report reads.
      // A confirmation agent editing the order she is working on must not be
      // able to move that credit; it is a different authority from fixing an
      // address or a quantity.
      if (!can(user, 'orders.assign')) {
        return NextResponse.json(
          {
            error: 'لا تملك صلاحية تغيير جهة الطلب',
            errorAr: 'لا تملك صلاحية تغيير جهة الطلب',
            code: 'CHANNEL_FORBIDDEN',
          },
          { status: 403 }
        );
      }
      if (channelId === null) {
        updateData.channelId = null;
      } else {
        const channel = await db.orderChannel.findFirst({
          where: { id: channelId, companyId },
          select: { id: true, name: true },
        });
        if (!channel) {
          return NextResponse.json({ error: 'القناة غير موجودة' }, { status: 404 });
        }
        updateData.channelId = channel.id;
        updateData.source = channel.name;
      }
    }
    /*
     * THE TRACKING NUMBER HAS ONE DOOR, AND IT IS NOT THIS ONE.
     *
     * This field wrote `trackingNumber` on `orders.edit` alone: no shipping
     * key, no «before it ships» rule, no check that another parcel does not
     * already carry the number. The shipping door (`POST …/shipping`,
     * update_tracking) has all three, and no screen sends the field here.
     */
    if (trackingCode !== undefined) {
      return NextResponse.json(
        {
          error: 'رقم التتبّع بيتغيّر من شاشة الشحن.',
          errorAr: 'رقم التتبّع بيتغيّر من شاشة الشحن.',
          code: 'TRACKING_VIA_SHIPPING',
        },
        { status: 400 }
      );
    }

    // Shipping and delivery cost belong to the shipping authority, not to
    // whoever may edit the order. The agent on the phone fixes a wrong
    // address; she does not decide what the parcel costs to send.
    if (shippingCost !== undefined && !can(user, 'orders.change_status')) {
      return NextResponse.json(
        {
          error: 'لا تملك صلاحية تعديل الشحن والتوصيل',
          errorAr: 'لا تملك صلاحية تعديل الشحن والتوصيل',
          code: 'SHIPPING_FORBIDDEN',
        },
        { status: 403 }
      );
    }

    // ── The seal: a batch that has been handed over ──
    //
    // Once "استلمت شركة الشحن" is pressed the parcels have left the
    // building, and the address the driver holds, the goods in the box and
    // the amount he collects are all fixed somewhere we do not control.
    // What was a direct edit becomes a change request: somebody who can
    // still reach the courier decides, and says what has to happen if the
    // change is no longer possible. Silence never approves it.
    /**
     * AN APPROVED REQUEST NO LONGER WALKS PAST THE SEAL IN SILENCE.
     *
     * It used to: `viaRequest ? [] : …`, on the reasoning that a human had
     * decided and a human deciding would have rung the courier. Nothing
     * checked that they had. So the ordinary case was a supervisor approving
     * a new address, somebody pressing «طبّق», our record saying one street
     * and the box on the van saying another — and the seal's own comment
     * explaining exactly why that is worthless: «the waybill IS the address».
     *
     * The approval is still what lets the change through. What it no longer
     * does is let it through BEFORE the courier is told. The block below
     * composes the message and refuses; the same request, sent back with
     * `courierNotified`, applies and records who told them.
     */
    const sealedAsked = viaRequest && courierTold ? [] : sealedFieldsIn(data as Record<string, unknown>);
    if (sealedAsked.length > 0) {
      const batch = await db.shippingBatch.findFirst({
        where: { orders: { some: { id } }, companyId },
        select: { status: true, batchNumber: true },
      });
      // The order's own state counts too: a parcel can leave on its own
      // while the batch it came from is still open and taking work.
      const seal = orderSeal({
        shippingBatch: batch,
        shippingStatus: existing.shippingStatus,
        shippedAt: (existing as { shippedAt?: Date | null }).shippedAt ?? null,
        labelPrintedAt: (existing as { labelPrintedAt?: Date | null }).labelPrintedAt ?? null,
      });
      if (seal.sealed) {
        /**
         * A REQUEST GETS THE MESSAGE. A DIRECT EDIT GETS THE OLD REFUSAL.
         *
         * Somebody editing a sealed order by hand has not been through any
         * decision, and the answer to them is unchanged: raise a request.
         * Somebody applying an APPROVED one has, and what is missing is not
         * authority but a phone call — so they get the sentence to send and
         * a door that opens once they have sent it.
         */
        if (viaRequest) {
          const action = courierActionFor(sealedAsked);
          const provider = existing.deliveryProviderId
            ? await db.deliveryProvider.findFirst({
                where: { id: existing.deliveryProviderId, companyId },
                select: { name: true, phone: true },
              })
            : null;
          return NextResponse.json(
            {
              error: courierActionAr(action),
              errorAr: courierActionAr(action),
              code: 'COURIER_ACTION_REQUIRED',
              action,
              fields: sealedAmong(sealedAsked),
              courier: provider ? { name: provider.name, phone: provider.phone } : null,
              message: courierMessage({
                action: action === 'NONE' ? 'CONTACT_CHANGE' : action,
                orderNumber: existing.orderNumber,
                trackingNumber: (existing as { trackingNumber?: string | null }).trackingNumber ?? null,
                storeName: null,
                changes: Object.fromEntries(
                  sealedAmong(sealedAsked).map((f) => [f, String((data as Record<string, unknown>)[f] ?? '')])
                ),
              }),
              batchNumber: seal.batchNumber,
            },
            { status: 409 }
          );
        }
        return NextResponse.json(
          {
            error: sealMessage(seal.batchNumber, sealedAsked, seal.reason),
            errorAr: sealMessage(seal.batchNumber, sealedAsked, seal.reason),
            code: 'ORDER_SEALED',
            fields: sealedAsked,
            batchNumber: seal.batchNumber,
          },
          { status: 409 }
        );
      }
    }

    /*
     * AND IT COMES AFTER THE SEAL ON PURPOSE.
     *
     * A sealed order already answers «ارفع طلب تعديل» with the batch
     * number and the courier's sentence in it — a better answer than this
     * one, and the screens read its code. This is the gap the seal never
     * covered: CONFIRMED, label not printed, nothing sealed, and edited in
     * place.
     */
    /*
     * ═══════════════════════════════════════════════════════════════════
     * ONCE IT IS CONFIRMED, AN EDIT IS A REQUEST.
     *
     * The owner's rule, in his words: «لما يتأكد الطلب، الموظف ما بيقدر
     * يعدله ولا يغير حالته — التعديل يصير طلب تعديل، والقرار إلي».
     *
     * The whole pipeline for that already existed — `OrderChangeRequest`,
     * the routing, «طلبات التعديل», the apply path — and it was reached
     * from exactly two places: the agent's own queue, and the
     * «تعديل · إلغاء · تأجيل» card. Meanwhile «تعديل» on the customer
     * card and on the lines card in the order window saved straight
     * through this route, in every state, and only a SEALED order was
     * refused. So a confirmed order whose label had not been printed was
     * edited in place, by anybody holding `orders.edit`, with no request
     * and nobody deciding.
     *
     * Confirmation is the line (`BEFORE_OPERATIONS`): before it the order
     * is still the agent's and a direct edit is right; after it the order
     * belongs to operations and the answer is a request.
     *
     * An APPROVED request coming back to be applied carries
     * `changeRequestId`, so `viaRequest` is how the pipeline gets
     * through — this refuses the door, not the decision.
     * ═══════════════════════════════════════════════════════════════════
     */
    /*
     * ═══════════════════════════════════════════════════════════════════
     * AND BEFORE CONFIRMATION, THE AGENT HOLDING IT HAS TO HAVE TRIED.
     *
     * «تأكيد الطلب» and «تأجيل» and «ألغِ» were locked until the order
     * carried a contact attempt (C1) — and «افتح وعدّل» was not. So an
     * agent who had rung nobody could open the order, change the quantity,
     * the price or the address, and save. The rule existed and the widest
     * door in it was open.
     *
     * It binds exactly the person the queue handed the order to, which is
     * what `needsContactFirst` has always said: a supervisor correcting a
     * record is not being asked to ring a customer first.
     *
     * «رقم خطأ» unlocks it, like the others — it IS an attempt, and it is
     * the finding that most often makes an edit the right next move.
     * ═══════════════════════════════════════════════════════════════════
     */
    if (!viaRequest && existing.claimedById === user.id) {
      /*
       * `items` COUNTS HERE TOO — the same word the terminal check below adds,
       * for the same reason: the lines are the product, the quantity and the
       * price, said for more than one line. The seal and the reason rule
       * already count them. Without it a PATCH carrying only `items` replaced
       * the lines before the holder had tried to reach the customer; the
       * crash in the lines write hid that, and mending the crash alone would
       * have opened it.
       */
      const asked = [...CHANGEABLE_FIELDS, 'items' as const].filter(
        (f) => (data as Record<string, unknown>)[f] !== undefined
      );
      if (asked.length > 0) {
        const attempts = await db.orderContactAttempt.count({ where: { orderId: id } });
        if (needsContactFirst({ action: 'edit', isHolder: true, hasAttempt: attempts > 0 })) {
          return NextResponse.json(
            { errorAr: CONTACT_FIRST_MESSAGE, code: 'CONTACT_FIRST', fields: asked },
            { status: 409 }
          );
        }
      }
    }

    if (
      !viaRequest &&
      /*
       * THE THREE TERMINAL STATUSES BY NAME, not «anything not in
       * BEFORE_OPERATIONS». The complement of a list is a list nobody
       * maintains: a sixth status added to the workflow tomorrow would
       * fall on the REFUSING side of it by accident, and an order being
       * contacted would start answering «raise a change request».
       * `TERMINAL_CONFIRMATION_STATUSES` is the same set the confirmation
       * door locks, so the two read alike.
       */
      (TERMINAL_CONFIRMATION_STATUSES as string[]).includes(existing.confirmationStatus)
    ) {
      /*
       * `items` TOO — the order's lines are the same product, quantity and
       * price as the single fields, said for more than one line. The list
       * above held only the single fields, so a confirmed order's lines could
       * be replaced directly whenever nothing on them was reserved yet. The
       * lines card already turns a confirmed order's save into a request;
       * this is the server saying the same.
       */
      const asked = [...CHANGEABLE_FIELDS, 'items' as const].filter(
        (f) => (data as Record<string, unknown>)[f] !== undefined
      );
      if (asked.length > 0) {
        return NextResponse.json(
          {
            errorAr: 'الطلب مؤكَّد — التعديل بيصير بطلب تعديل.',
            code: 'CHANGE_REQUEST_REQUIRED',
            fields: asked,
            fieldsAr: asked.map((f) => (f === 'items' ? 'أسطر الطلب' : CHANGE_FIELD_AR[f])),
          },
          { status: 409 }
        );
      }
    }

    // ── An edit made on company-wide authority says why ──
    // The change-request door already writes its reason into the audit. This
    // is the other door — the owner on an order of his own, the super admin
    // on anybody's — and it recorded who and what, never why. The rule and
    // its field list live in src/lib/order-edit-reason.ts; the edit screen
    // asks the same question, so this is the floor, not the prompt.
    //
    // It comes AFTER the seal on purpose: an edit the seal will refuse
    // outright must not first make somebody type out a justification for it.
    const submittedFields = Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    const refusal = reasonRefusal(
      {
        companyWideAuthority: getPermissionScope(user, 'orders.edit')?.scope === 'ALL_COMPANY',
        viaChangeRequest: !!viaRequest,
        changedFields: submittedFields,
      },
      editReason
    );
    if (refusal) {
      return NextResponse.json({ error: refusal, errorAr: refusal, code: 'REASON_REQUIRED' }, { status: 400 });
    }

    // ── Order line editing (price / quantity / discount / shipping / product) ──
    // totalAmount mirrors the create formula: sellingPrice * quantity + shippingCost − discount
    const editingLine =
      sellingPrice !== undefined ||
      quantity !== undefined ||
      discountAmount !== undefined ||
      shippingCost !== undefined ||
      productId !== undefined ||
      items !== undefined;

    // The lines this edit leaves the order with. An explicit array replaces
    // them; otherwise the existing lines carry on, adjusted by whatever
    // single-line fields were sent.
    let nextLines: { productId: string; quantity: number; unitPrice: number }[] = [];
    let lineProducts = new Map<string, { id: string; name: string }>();
    let lineMoney: ReturnType<typeof computeCod> | null = null;

    if (editingLine) {
      if (items) {
        // Replacing the set deletes the rows it drops, and those rows carry
        // the reservation and what was actually delivered or returned. Once
        // stock has been held against a line, or the parcel has left, the
        // line is a record of something that happened — not a draft.
        const committed = await db.orderItem.findFirst({
          where: {
            orderId: id,
            OR: [{ reservedQty: { gt: 0 } }, { deliveredQty: { gt: 0 } }, { returnedQty: { gt: 0 } }],
          },
          select: { id: true },
        });
        if (committed || hasEverShipped(existing as StateSource)) {
          return NextResponse.json(
            {
              error: 'لا يمكن تعديل بنود طلب حُجزت بضاعته أو خرج للشحن — عدّل الكميات من شاشة المرتجعات',
              code: 'LINES_COMMITTED',
            },
            { status: 409 }
          );
        }

        const ids = [...new Set(items.map((l) => l.productId))];
        const rows = await db.product.findMany({
          where: { id: { in: ids }, companyId },
          select: { id: true, name: true },
        });
        if (rows.length !== ids.length) {
          return NextResponse.json({ error: 'أحد المنتجات غير موجود في هذه الشركة' }, { status: 404 });
        }
        lineProducts = new Map(rows.map((r) => [r.id, r]));
        nextLines = items.map((l) => ({ ...l }));
      } else {
        /*
         * THE SINGLE-LINE SHORTHAND: price is the TOTAL for the quantity,
         * the same meaning intake gives it.
         *
         * AND THAT IS WHY A QUANTITY CHANGE HAS TO BE SCALED.
         *
         * This read `unitPrice: sellingPrice ?? existing.sellingPrice` and
         * handed the OLD line total to a line whose quantity had changed.
         * `computeCod` is given `unitPrice / quantity` just below, so the
         * division by the NEW quantity cancelled the multiplication back
         * out and the amount due never moved: a quantity raised from three
         * to five kept the total at thirty-six, which is five pieces at
         * 7.200 each instead of three at 12.000 — a discount nobody
         * approved, applied by the act of asking for more.
         *
         * MEASURED on ORD-2026-0044 as it stands: quantity 3, sellingPrice
         * 36.000, so the piece is 12.000. Raising it to 5 must read 60.000.
         *
         * So the piece price is recovered from the quantity it was SET for
         * — the old one — and multiplied by the new. `freeQuantity` is not
         * in this arithmetic and must not be: measured on the same rows,
         * `quantity` is what is PAID for (3 x 12.000 = 36.000) and the free
         * piece rides on top.
         *
         * WHEN A PRICE IS SENT TOO, it is taken as given and not scaled.
         * It is the new line total for the new quantity — that is exactly
         * what the screen says beside the field, «هذا سعر السطر كاملاً
         * للكمية الحالية، لا سعر القطعة» — so scaling it as well would
         * apply the quantity twice.
         */
        const nextQuantity = quantity ?? existing.quantity;
        // The quantity the stored total was priced for. Zero cannot be a
        // divisor, and an order with no quantity has no piece price to
        // recover, so its total carries over untouched.
        const pricedFor = Number(existing.quantity) || 0;
        const storedTotal = Number(existing.sellingPrice ?? 0);
        const lineTotal =
          sellingPrice ??
          (pricedFor > 0 ? (storedTotal / pricedFor) * nextQuantity : storedTotal);
        nextLines = [
          {
            productId: productId ?? existing.productId,
            quantity: nextQuantity,
            unitPrice: lineTotal,
          },
        ];
      }

      const nextDiscount = discountAmount ?? Number(existing.discountAmount ?? 0);
      const nextShipping = shippingCost ?? Number(existing.shippingCost ?? 0);

      // ONE COD function — never a second formula. The one that used to live
      // here read `sellingPrice * quantity`, multiplying a price that is
      // already the line's total by the quantity again, and added the
      // delivery fee even on a store whose prices include it.
      // The add-ons the customer accepted stay part of what is collected.
      // Editing a line rebuilt the total from the lines alone, which quietly
      // dropped them — the same loss shipment creation had.
      const acceptedAddOns = await db.orderAddOn.findMany({
        where: { orderId: id, companyId },
        select: { quantity: true, price: true },
      });
      const money = computeCod({
        lines: nextLines.map((l) => ({
          quantity: l.quantity,
          unitPrice: l.quantity > 0 ? l.unitPrice / l.quantity : l.unitPrice,
        })),
        discount: nextDiscount,
        deliveryFee: nextShipping,
        priceIncludesDelivery: existing.priceIncludesDelivery === true,
        minorUnit: country.minorUnit,
        addOns: acceptedAddOns.map((a) => ({ quantity: a.quantity, unitPrice: Number(a.price) })),
      });

      if (nextDiscount > money.subtotal) {
        return NextResponse.json({ error: 'الخصم لا يمكن أن يتجاوز إجمالي قيمة الطلب' }, { status: 400 });
      }

      updateData.sellingPrice = money.subtotal;
      updateData.quantity = nextLines.reduce((sum, l) => sum + l.quantity, 0);
      updateData.discountAmount = money.discount;
      updateData.shippingCost = nextShipping;
      updateData.totalAmount = money.cod;
      // The order is named after its first line, as it is at intake.
      updateData.productId = nextLines[0].productId;
      if (items) {
        updateData.productNameSnapshot = lineProducts.get(nextLines[0].productId)?.name ?? existing.productNameSnapshot;
      }
      lineMoney = money;
    }
    if (productId !== undefined && productId !== existing.productId) {
      const product = await db.product.findFirst({ where: { id: productId, companyId }, select: { id: true, name: true } });
      if (!product) {
        return NextResponse.json({ error: 'المنتج غير موجود في هذه الشركة' }, { status: 404 });
      }
      updateData.productId = productId;
      updateData.productNameSnapshot = product.name;
    }

    // Region edit — must belong to THIS order's country, so a Jordanian
    // order can never be pointed at a Syrian governorate.
    let regionName: string | undefined;
    if (regionId !== undefined) {
      if (regionId === null) {
        updateData.regionId = null;
      } else {
        const region = await db.region.findFirst({
          where: { id: regionId, countryId: existing.countryId, isActive: true },
          select: { id: true, name: true },
        });
        if (!region) {
          return NextResponse.json(
            { error: 'المحافظة غير موجودة في بلد هذا الطلب', code: 'REGION_NOT_IN_COUNTRY' },
            { status: 400 }
          );
        }
        updateData.regionId = region.id;
        regionName = region.name;
      }
    }

    // Customer information edit (name / phone / address) — applied to the linked Customer row
    const editingCustomer =
      customerName !== undefined || customerPhone !== undefined || customerAddress !== undefined ||
      customerAltPhone !== undefined || regionName !== undefined;
    // A corrected phone has to actually be a phone for this country —
    // otherwise "fixing" a wrong number just writes a different wrong one.
    if (customerPhone !== undefined && !isValidPhoneFor(country.code, customerPhone)) {
      return NextResponse.json(
        { error: phoneErrorFor(country.code), code: 'INVALID_PHONE', field: 'customerPhone' },
        { status: 400 }
      );
    }
    // The second number is optional, but a number that is there must be real.
    if (customerAltPhone && !isValidPhoneFor(country.code, customerAltPhone)) {
      return NextResponse.json(
        { error: phoneErrorFor(country.code), code: 'INVALID_PHONE', field: 'customerAltPhone' },
        { status: 400 }
      );
    }

    if (editingCustomer && customerPhone !== undefined) {
      const normalized = normalizePhoneNumber(customerPhone, country.code);
      const dupe = await db.customer.findFirst({
        where: { companyId, phone: { in: phoneKeys(normalized) }, id: { not: existing.customerId } },
        select: { id: true, fullName: true },
      });
      if (dupe) {
        return NextResponse.json(
          { error: `رقم الهاتف مستخدم بالفعل للعميل: ${dupe.fullName}`, code: 'DUPLICATE_PHONE' },
          { status: 409 }
        );
      }
    }

    // Atomic versioned save — the gate: version must match or the write fails.
    // (Never trust client ownership fields: only operational fields are taken from the body.)
    // The write + side effects (stock deduction, customer counters) + logs are
    // one transaction so a lost race can never half-apply them.
    const previousSettlementStatus = existing.settlementStatus;
    await db.$transaction(async (tx) => {
      const saved = await tx.order.updateMany({
        where: { id, version: expectedVersion },
        data: { ...updateData, version: { increment: 1 } },
      });
      if (saved.count !== 1) {
        throw new Error('VERSION_CONFLICT: This order was updated by another user. Please refresh before saving.');
      }

      // The lines themselves, only when an explicit set was sent. Replacing
      // them wholesale is what the screen does — a product removed from the
      // list is removed from the order — and it happens in this transaction
      // so the order's totals and its lines can never disagree.
      if (items && lineMoney) {
        /*
         * ── THE GIFT SURVIVES THE EDIT ──
         *
         * The owner, 21/10: «الهدية ما بتنحسب من المخزون». One half of
         * that was this rewrite.
         *
         * Replacing the lines wholesale is right — a product removed from
         * the screen is removed from the order — but the new rows were
         * built without `freeQuantity`, so the column was silently reset
         * to zero. An order that came from a landing page **with** a
         * gift, correctly recorded by `public-order.ts:152`, lost it the
         * first time anybody touched its lines. That is during
         * CONFIRMATION, which is to say: on its way to almost every
         * order that carried one.
         *
         * What it held is carried over by product. This door binds no
         * offer (its item schema has no `offerId`), so deriving the gift
         * afresh would be inventing one; keeping what the order already
         * had is the honest answer, and a line for a product that was not
         * on the order before starts at none.
         *
         * READ HERE, NOT OFF `existing`. That is the row `assertOrderAccess`
         * loaded — the order's own columns and no relations — so
         * `existing.items` was undefined, `.map` threw inside this
         * transaction, and every lines save since 21/10 rolled back as
         * «حدث خطأ داخلي», at every scope. The confirmation door met the same
         * row in its FAKE_ORDER branch and says so beside its customer read.
         * Inside the transaction and before the delete, so what is carried is
         * what the rows held at the moment they are replaced.
         *
         * ONE PRODUCT, ONE GIFT — HOWEVER MANY LINES CARRY IT. A Map built
         * straight from the rows let the LAST stored row of a product decide,
         * in whatever order the database returned them, and handed that
         * figure to every new line of the product: كريم 3+1 beside كريم 1+0
         * came back 0+0 or 1+1, and a second كريم added beside 3+1 got a gift
         * of its own. The cart keeps (product, offer) as a line's identity,
         * both doors accept a product twice, and «أضف منتجاً آخر» can pick one
         * already on the order — and the reservation, the picking list, the
         * waybill and the draw at delivery all read quantity + freeQuantity.
         * So the product's gifts are SUMMED, and the sum goes once, to its
         * first line in the set that was sent; its other lines start at none.
         */
        const storedLines = await tx.orderItem.findMany({
          where: { orderId: id },
          select: { productId: true, freeQuantity: true },
        });
        const giftByProduct = new Map<string, number>();
        for (const it of storedLines) {
          giftByProduct.set(it.productId, (giftByProduct.get(it.productId) ?? 0) + it.freeQuantity);
        }
        const gifts = nextLines.map((line) => {
          const gift = giftByProduct.get(line.productId) ?? 0;
          giftByProduct.delete(line.productId);
          return gift;
        });
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.orderItem.createMany({
          data: nextLines.map((line, i) => ({
            companyId,
            orderId: id,
            productId: line.productId,
            productName: lineProducts.get(line.productId)?.name ?? '',
            quantity: line.quantity,
            freeQuantity: gifts[i],
            unitPrice: line.quantity > 0 ? line.unitPrice / line.quantity : line.unitPrice,
            discountShare: lineMoney!.discountShares[i] ?? 0,
            lineTotal: lineMoney!.lineTotals[i] ?? 0,
            addedById: user.id,
            addedStage: 'EDIT',
          })),
        });
      }

      // Customer information edit — same transaction as the order write
      if (editingCustomer) {
        const custData: any = {};
        if (customerName !== undefined) custData.fullName = customerName;
        if (customerAddress !== undefined) custData.address = customerAddress;
        // Keep the written city in step with the chosen governorate.
        if (regionName !== undefined) custData.city = regionName;
        if (customerPhone !== undefined) {
          custData.phone = normalizePhoneNumber(customerPhone, country.code);
          custData.rawPhone = customerPhone;
        }
        if (customerAltPhone !== undefined) {
          custData.altPhone = customerAltPhone?.trim() || null;
        }
        if (Object.keys(custData).length > 0) {
          await tx.customer.update({ where: { id: existing.customerId }, data: custData });
        }
      }

      // Side effects (run on tx so they commit atomically with the write)
      if (status === 'CONFIRMED' && status !== previousStatus) {
        await tx.customer.update({
          where: { id: existing.customerId },
          data: { confirmedOrders: { increment: 1 } },
        });
      }

      if (status === 'DELIVERED' && status !== previousStatus) {
        // 1. Update customer delivered stats
        await tx.customer.update({
          where: { id: existing.customerId },
          data: {
            deliveredOrders: { increment: 1 },
            totalPurchaseValue: { increment: existing.totalAmount },
          },
        });

        /*
         * 2. THE GOODS LEAVE THE SHELF — AND THIS DOOR NO LONGER DOES THE
         *    ARITHMETIC ITSELF.
         *
         * What stood here was a hand-rolled deduction: find the OLDEST batch
         * with stock left, take `Math.min(existing.quantity,
         * activeBatch.quantityRemaining)` out of it, write one SALE line,
         * done. Five things were wrong with it, and the first is the one
         * that matters.
         *
         *   ONE BATCH. A ten-unit order against batches of 3 and 8 took 3
         *   and stopped. Seven units were handed to the customer and stayed
         *   on the books — no error raised, no second batch consulted, on
         *   hand reading 8 when it was 1. `drawDownStock` walks EVERY batch
         *   oldest-first and reports the shortfall it could not cover.
         *
         *   NO IDEMPOTENCY. The only thing stopping a second deduction was
         *   `status !== previousStatus` — and the legacy `status` column is
         *   NOT what the other delivery doors write. Measured on this
         *   database: 26 orders are DELIVERED or PARTIALLY_DELIVERED with
         *   their SALE already in the ledger, and all 26 still read
         *   `status: 'SHIPPED'`, because `partial-delivery.ts`, the
         *   statement sweep in `/api/finance/statements/[id]` and
         *   `/api/ops/tracking/write-off` each set `shippingStatus` and
         *   leave `status` alone. One PATCH of `status: 'DELIVERED'` on any
         *   of them passed the gate and took 52 units off the shelf a
         *   second time. `consumeOrderStock` asks the ledger —
         *   `alreadyMoved` — and returns `alreadyDone` touching nothing.
         *
         *   ONE PRODUCT. `existing.productId` is the legacy denormalised
         *   column; a two-line order deducted its first product and ignored
         *   the rest. `consumeOrderStock` loops `order.items`.
         *
         *   NO GIFTS. `existing.quantity` excludes `freeQuantity`, so a 3+1
         *   offer deducted 3 and left the gift on the shelf. Three such
         *   orders are on this database. The helper asks for
         *   `quantity + freeQuantity`, which is what `reservation.ts` HELD,
         *   so the hold and the draw finally agree.
         *
         *   A BALANCE THAT IS NOT THE BALANCE. `balanceAfter` was
         *   `activeBatch.quantityRemaining - deductQty` — ONE batch's
         *   remainder. With batches of 3 and 8 and an order for 2 it wrote
         *   1 while the product held 9. `onHandTotal` sums the batches.
         *
         * AND WHAT THE OLD BLOCK WROTE IS NOT LOST: `quantitySold` is
         * incremented by `drawDownStock` on every batch it draws from, the
         * SALE line still carries `storeId`, `referenceId` and
         * `createdById`, and the customer counters above are this door's own
         * and untouched. One field IS dropped — `batchId` on the movement —
         * because a draw across two batches has no single batch and naming
         * one would be a false record; every SALE row on this database
         * already carries none.
         *
         * The claim that the missing `companyId`/`storeId` on that query let
         * units come off another tenant's shelf was OVERSTATED, and is not
         * why this block is gone: `productId` is a unique uuid (0 duplicates
         * of 12), every product belongs to one store (1 distinct), and
         * batch-vs-product store and company diverge on 0 of 5 batches. The
         * query was tenant-scoped in effect, BY THE PRODUCT. It is now
         * scoped by declaration too, because the helper passes both.
         */
        await consumeOrderStock(tx, {
          orderId: id,
          companyId,
          // The country's own rule, read from the same context the rest of
          // this handler uses — and the same argument
          // `/api/orders/[id]/shipping` passes, so the two doors cannot
          // disagree about whether a short shelf may deliver.
          allowNegativeStock: country.allowNegativeStock,
          userId: user.id,
        });
      }

      if ((status === 'REJECTED' || status === 'CANCELLED') && status !== previousStatus) {
        await tx.customer.update({
          where: { id: existing.customerId },
          data: { cancelledOrders: { increment: 1 } },
        });
        // Stock is never held by a dead order. The reservation is dropped in
        // THIS transaction, so a failure cannot leave the units reserved
        // against an order that no longer exists in any queue.
        await releaseOrderLines(tx, id);
      }

      // Status logs — one per changed category (mirrors the confirmation route)
      const newConfirmationStatus: string | undefined = updateData.confirmationStatus;
      const newShippingStatus: string | undefined = updateData.shippingStatus;
      const newSettlementStatus: string | undefined = updateData.settlementStatus;

      if (newConfirmationStatus !== undefined && newConfirmationStatus !== existing.confirmationStatus) {
        await tx.orderStatusLog.create({
          data: {
            companyId, orderId: id, statusType: 'CONFIRMATION',
            previousValue: existing.confirmationStatus, newValue: newConfirmationStatus,
            changedById: user.id, changedByRole: user.role,
            note: changingCombined ? `Combined status → ${status}` : null,
          },
        });
      }
      if (newShippingStatus !== undefined && newShippingStatus !== existing.shippingStatus) {
        await tx.orderStatusLog.create({
          data: {
            companyId, orderId: id, statusType: 'SHIPPING',
            previousValue: existing.shippingStatus, newValue: newShippingStatus,
            changedById: user.id, changedByRole: user.role,
            note: changingCombined ? `Combined status → ${status}` : null,
          },
        });
      }
      if (newSettlementStatus !== undefined && newSettlementStatus !== previousSettlementStatus) {
        await tx.orderStatusLog.create({
          data: {
            companyId, orderId: id, statusType: 'SETTLEMENT',
            previousValue: previousSettlementStatus, newValue: newSettlementStatus,
            changedById: user.id, changedByRole: user.role,
            note: changingCombined ? `Combined status → ${status}` : null,
          },
        });
      }

      // Record activity timeline
      if (status && status !== previousStatus) {
        await tx.orderActivity.create({
          data: {
            companyId,
            orderId: id,
            userId: user.id,
            action: 'STATUS_CHANGED',
            previousStatus,
            newStatus: status,
            metadata: JSON.stringify({
              updatedBy: user.name,
              role: user.role,
              trackingCode: trackingCode || null,
              ...(editReason ? { reason: editReason } : {}),
            }),
          },
        });
      }

      // Record activity for data edits (price/qty/discount/shipping/customer info)
      if (editingLine || editingCustomer) {
        const changedFields = [
          ...(sellingPrice !== undefined ? ['sellingPrice'] : []),
          ...(quantity !== undefined ? ['quantity'] : []),
          ...(discountAmount !== undefined ? ['discountAmount'] : []),
          ...(shippingCost !== undefined ? ['shippingCost'] : []),
          ...(productId !== undefined ? ['productId'] : []),
          ...(customerName !== undefined ? ['customerName'] : []),
          ...(customerPhone !== undefined ? ['customerPhone'] : []),
          ...(customerAltPhone !== undefined ? ['customerAltPhone'] : []),
          ...(customerAddress !== undefined ? ['customerAddress'] : []),
        ];
        await tx.orderActivity.create({
          data: {
            companyId,
            orderId: id,
            userId: user.id,
            action: 'ORDER_UPDATED',
            metadata: JSON.stringify({
              updatedBy: user.name,
              role: user.role,
              fields: changedFields,
              // The timeline is what the next person reads on the order
              // itself; the audit log is where nobody looks until it matters.
              ...(editReason ? { reason: editReason } : {}),
            }),
          },
        });
      }
    });

    const updatedOrder = await db.order.findUnique({ where: { id } });

    await logAudit({
      companyId,
      userId: user.id,
      action: viaRequest ? 'ORDER_UPDATED_BY_CHANGE_REQUEST' : 'ORDER_UPDATED',
      entity: 'Order',
      entityId: id,
      previousData: existing,
      newData: viaRequest
        ? {
            ...updatedOrder,
            // Who carried it out is the audit's own userId; WHY is the
            // request's reason and the decision on it. An edit that passed
            // the seal must say what allowed it.
            changeRequest: { id: viaRequest.id, reason: viaRequest.reason, decision: viaRequest.decisionNote },
          }
        // The other door into somebody else's order. The reason is demanded
        // above for exactly these edits, so it is here whenever it applies.
        : editReason
          ? { ...updatedOrder, editReason }
          : updatedOrder,
    });

    if (viaRequest) {
      // Once. `appliedAt: null` in the filter makes a second, concurrent apply
      // a no-op here — and the values are absolute ("to 3", not "+1"), so the
      // order itself ends the same either way.
      const stamped = await db.orderChangeRequest.updateMany({
        where: { id: viaRequest.id, appliedAt: null },
        data: { appliedAt: new Date(), appliedById: user.id },
      });

      /**
       * AND WHO TOLD THE COURIER, IF ANYBODY HAD TO.
       *
       * `courierNotified` is the only reason a sealed order accepted this
       * write, so it is recorded as a statement with a name on it rather
       * than as a flag. Somebody reading the order in a week has to be able
       * to see that the parcel on the van and the record here were
       * reconciled by a person, and which person.
       */
      if (stamped.count === 1 && courierTold) {
        await db.orderNote.create({
          data: {
            companyId,
            orderId: id,
            authorId: user.id,
            kind: 'internal',
            body: `أُبلغت شركة الشحن بالتعديل قبل تطبيقه — ${viaRequest.reason}`,
          },
        });
      }

      // AND THE PERSON WHO ASKED HEARS THAT IT IS DONE.
      //
      // «اعتُمد» and «كُتب على الطلب» are two different days for her: an
      // approval waits in «بانتظار التطبيق» until somebody carries it out,
      // and until then the order still says what it said. Telling her only
      // about the approval means she believes the customer's address changed
      // at the moment it did not.
      //
      // Inside the `stamped` guard, so a second concurrent apply — which
      // changes nothing — does not send a second message either.
      if (stamped.count === 1 && viaRequest.requestedById !== user.id) {
        notify({
          companyId,
          storeId: existing.storeId ?? storeId,
          audience: { userIds: [viaRequest.requestedById] },
          actorId: user.id,
          title: `طُبِّق تعديلك على ${existing.orderNumber}`,
          message: `${user.name ?? 'المشرف'} كتبه على الطلب: ${viaRequest.reason}`,
          type: 'SYSTEM_ALERT',
          link: `/orders?highlight=${existing.id}`,
        });
      }
    }

    // A confirmation outcome goes to this store's confirmation supervisors
    // and to the moderator who entered the order — their commission rides
    // on it. Not to whoever just pressed the button. After commit; never
    // throws.
    if (status && status !== previousStatus && (TERMINAL_STATUSES as readonly string[]).includes(status)) {
      notify({
        companyId,
        storeId: existing.storeId ?? storeId,
        // The moderator the order belonged to AND the one it belongs to now:
        // one edit can move the order and decide it, and the commission
        // follows the new owner while the old one saw it until a moment ago.
        audience: {
          permission: 'confirmation.supervise',
          userIds: [existing.moderatorId, updatedOrder?.moderatorId],
        },
        actorId: user.id,
        title: status === 'CONFIRMED' ? 'تأكيد طلب' : status === 'REJECTED' ? 'رفض طلب' : 'إلغاء طلب',
        message: `الطلب #${existing.orderNumber} أصبح بالحالة ${status} بواسطة ${user.name}.`,
        type: 'SYSTEM_ALERT',
        link: `/orders?highlight=${existing.id}`,
      });
    }

    return NextResponse.json({ success: true, order: updatedOrder });
  } catch (error: any) {
    // Re-raise version conflicts in their legacy response shape
    if (error?.message?.startsWith('VERSION_CONFLICT')) {
      return NextResponse.json(
        {
          error: 'This order was updated by another user. Please refresh before saving.',
          errorAr: 'تم تعديل هذا الطلب بواسطة مستخدم آخر. يرجى تحديث الصفحة قبل الحفظ.',
          code: 'VERSION_CONFLICT',
        },
        { status: 409 }
      );
    }
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
