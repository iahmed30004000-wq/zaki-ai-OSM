import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { shipmentBlocks, type OrderBlock } from '@/lib/operations';
import { codForOrder, resolveDeliveryFee } from '@/lib/delivery-fees';
import { assertReadyToShip, type GuardResult, type StateSource } from '@/lib/order-state';
import { guardLines } from '@/lib/reservation';
import { cancelVerdict } from '@/lib/shipment-cancel';
import { batchStatusOf } from '@/lib/order-cancel';
import { zodMessage } from '@/lib/zod-message';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { BATCHABLE_SHIPPING, HELD_PACKED_PARCEL, WAITING_FOR_A_TROLLEY, shipmentListWhere, whyNotBatchable } from '@/lib/batching-guard';
import { SHIP_HOLD_RELEASED, holdEndsInBatch } from '@/lib/shipment-hold';

/**
 * Shipment creation.
 *
 *   GET  /api/ops/shipments?from&to&courier&region&product
 *        Candidate orders with their COD breakdown and blocking warnings.
 *   POST /api/ops/shipments
 *        { deliveryProviderId, orderIds, acknowledgedOrderIds[] }
 *
 * Soft warnings (duplicate in batch, previous shipment in transit, recent
 * return) must be acknowledged per order. Hard blocks (missing region or fee
 * row, stock shortage when negative stock is disallowed) create no shipment
 * row at all — those orders come back in an exceptions list.
 */

/**
 * What a person can do about a line the door will call «غير محجوز». Stock that arrived after the order was confirmed
 * is on the shelf but not earmarked: postponing gives the order's units back and releasing takes them again against
 * the shelf as it is now (`reserveOrderLines` in the hold door). Nothing here writes — it is only said in advance.
 */
const UNRESERVED_HINT = 'وحداته غير محجوزة (وصل المخزون بعد التأكيد، أو انتهى التأجيل): أجِّل الطلب ثم أرجِعه ليُعاد الحجز';

const createSchema = z.object({
  deliveryProviderId: z.string().uuid(),
  orderIds: z.array(z.string().uuid()).min(1).max(200),
  acknowledgedOrderIds: z.array(z.string().uuid()).default([]),
  notes: z.string().trim().max(300).optional(),
});

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('ops.ship');

    /**
     * THE ADDRESS IS THE ADDRESS BOOK'S, NOT THE PACKING KEY'S.
     *
     * «اظهر العنوان بالخانات» (the owner, 8/11): the table shows where each parcel goes. A street is a customer's
     * contact detail like the phone, and `ops.ship` is the packing key — the warehouse holds it without
     * `customers.view` (`ops/labels` says it the same way). So the address is put in the row only for whoever holds
     * the address-book key; for everyone else the key is not there at all, so the payload provably does not carry it.
     */
    const maySeeAddress = can(user, 'customers.view');

    const q = new URL(req.url).searchParams;
    const from = q.get('from') ? new Date(q.get('from')!) : null;
    const to = q.get('to') ? new Date(q.get('to')!) : null;
    // The courier is the TARGET of this shipment, used to price each row —
    // not a filter: orders waiting for a courier have none assigned yet.
    const providerId = q.get('courier');
    const regionId = q.get('region');
    /** 'only' lists what is on hold instead of what is ready. */
    const held = q.get('held');
    const productId = q.get('product');
    /**
     * THE SAME SEARCH THE ORDERS LIST USES, PLUS THE CITY.
     *
     * This screen had no search at all: a hundred confirmed orders and the
     * only way to the one the courier is asking about was the eye. And the
     * obvious way to give it one is to write a second `OR` here — after
     * which the two drift, somebody adds a field to the orders list, this
     * screen does not get it, and «لقيته بالطلبات وما لقيته بالشحنات»
     * becomes a bug report nobody can read.
     *
     * So it is the one builder, with the city switched on — this list is
     * about where parcels are going, so a place name is what a person
     * types into it.
     *
     * ⚠️ And «city» here is `Customer.city`, which is free text the order
     * was taken with — NOT the `Region` the المحافظة column shows and the
     * governorate filter uses. They usually agree and they are not the
     * same field, so a place read off the screen may match nothing. The
     * placeholder says «المدينة» for that reason.
     */
    const search = q.get('q')?.trim();

    const orders = await db.order.findMany({
      // The tab's question, written once (`shipmentListWhere`): the file of the ready orders asks the same one.
      where: shipmentListWhere({ companyId, storeId, held: held === 'only', regionId, productId, search, from, to }),
      orderBy: { createdAt: 'asc' },
      take: 300,
      select: {
        id: true, orderNumber: true, merchantRef: true, createdAt: true, currency: true,
        shipHoldUntil: true, shipHoldReason: true,
        priceIncludesDelivery: true, deliveryFee: true, regionId: true, deliveryProviderId: true,
        customerId: true, companyId: true, storeId: true, confirmationStatus: true, shippingStatus: true, shippedAt: true,
        // Read so the row can say whether standing the order down is
        // still possible. A printed waybill is already out of our hands.
        labelPrintedAt: true, shippingBatchId: true,
        // `deliveryAddress` and the customer's `address` are read only to be folded into the row's one `address` below.
        deliveryAddress: true,
        customer: { select: { id: true, fullName: true, phone: true, city: true, totalOrders: true, address: true } },
        region: { select: { id: true, name: true } },
        items: { select: { productName: true, quantity: true, freeQuantity: true, unitPrice: true, discountShare: true, lineTotal: true, reservedQty: true } },
        // `reservedQty` of the add-ons too: the door asks about them, so the row must (one select, no query per row).
        addOns: { select: { quantity: true, price: true, reservedQty: true } },
      },
    });

    // The trolleys these orders sit on, read once: `cancelVerdict` needs the status of each.
    const batchStatuses = new Map<string, string | null>();
    for (const batchId of new Set(orders.map((o) => o.shippingBatchId).filter((v): v is string => !!v))) {
      batchStatuses.set(batchId, await batchStatusOf(db, batchId));
    }

    const rows = [];
    for (const order of orders) {
      const provider = providerId ?? order.deliveryProviderId;
      const fee = provider
        ? await resolveDeliveryFee(db, { deliveryProviderId: provider, regionId: order.regionId, minorUnit: country.minorUnit })
        : { fee: 0, lateThresholdDays: 0, returnFee: 0, source: 'NONE' as const };

      const money = codForOrder({
        lines: order.items,
        addOns: order.addOns,
        deliveryFee: fee.fee,
        priceIncludesDelivery: order.priceIncludesDelivery,
        minorUnit: country.minorUnit,
      });

      const found: OrderBlock[] = await shipmentBlocks(
        db,
        { id: order.id, companyId: order.companyId, storeId: order.storeId, customerId: order.customerId, regionId: order.regionId, deliveryProviderId: provider },
        { allowNegativeStock: country.allowNegativeStock, batchOrderIds: orders.map((o) => o.id) }
      );

      /**
       * THE ROW ASKS THE DOOR'S OWN QUESTION.
       *
       * «جاهز» was printed beside an order whose line nobody had reserved (the stock came in after the order was
       * confirmed), and the press answered «لا يوجد طلب صالح» with the real reason buried in the body. The door
       * (POST below) refuses through `assertReadyToShip`; the row asks that same function, over the same lines and
       * add-ons, so the two cannot disagree and the words are the door's words.
       *
       * Not asked of the «مؤجَّلة» list: a held order has had its units given back on purpose, and «أرجِعه» takes
       * them again. A hard stop, because the door has no acknowledgement for it.
       */
      const lines = guardLines(order.items, order.addOns);
      const ready: GuardResult = held === 'only' ? { allowed: true } : assertReadyToShip(order as StateSource, lines);
      // A new array: what `shipmentBlocks` handed back is not ours to add to.
      const blocks: OrderBlock[] = ready.allowed
        ? found
        : [
            ...found,
            {
              code: 'UNRESERVED_LINES',
              message: ready.message ?? 'غير جاهز للشحن',
              hard: true,
              ...(lines.length > 0 ? { hint: UNRESERVED_HINT } : {}),
            },
          ];

      // The customer as the row has always carried it: the street read for the row's `address` is not part of it, or
      // it would reach the people who may not have it by this door (`customer.address`).
      const { address: customerAddress, ...customer } = order.customer;

      rows.push({
        id: order.id,
        orderNumber: order.orderNumber,
        merchantRef: order.merchantRef,
        createdAt: order.createdAt,
        customer,
        previousOrders: Math.max(0, (order.customer.totalOrders ?? 1) - 1),
        region: order.region,
        /*
         * WHERE THE PARCEL GOES — by the rule dispatch applies (`couriers/dispatch.ts`, «NO ADDRESS TO DELIVER TO»): the
         * parcel's own address first, then the customer's; a blank or spaces-only one counts as none. `null` is «this
         * order has none», and dispatch refuses such an order (`NO_ADDRESS`), so the screen says so in red.
         * ABSENT, not null, without the address-book key: a missing key and an empty address are different news.
         */
        ...(maySeeAddress ? { address: order.deliveryAddress?.trim() || customerAddress?.trim() || null } : {}),
        items: order.items.map((i) => ({ productName: i.productName, quantity: i.quantity, freeQuantity: i.freeQuantity })),
        cod: { ...money, currency: order.currency, feeSource: fee.source },
        blocks,
        // Select-all skips anything blocked; soft blocks need an acknowledgement.
        selectable: blocks.length === 0,
        hardBlocked: blocks.some((b) => b.hard),
        /**
         * CAN THIS ORDER STILL BE STOOD DOWN?
         *
         * A control that always fails teaches people the screen is lying, so
         * the row says in advance what the door will answer. It asks
         * `cancelVerdict`, the same function the door itself uses, so the row
         * and the refusal can never disagree.
         *
         * Until «إغلاق الشحنة — سُلّمت للشركة» the answer is YES even for a
         * parcel with a printed waybill (M6): the door then asks for the
         * person's word that the box was opened. Only a parcel the courier
         * has taken is blocked here.
         */
        standDownBlocked: (() => {
          const verdict = cancelVerdict({
            confirmationStatus: order.confirmationStatus,
            shippingStatus: order.shippingStatus,
            shippedAt: order.shippedAt,
            labelPrintedAt: order.labelPrintedAt,
            shippingBatchId: order.shippingBatchId,
            batchStatus: batchStatuses.get(order.shippingBatchId ?? '') ?? null,
          });
          return verdict.allowed ? null : { code: verdict.code, message: verdict.message };
        })(),
      });
    }

    /**
     * HOW MANY ARE BEING HELD, ALWAYS — even while looking at the ready
     * ones. «أجّلتُه ولم أجده» is what happens when a held order leaves
     * this list and nothing on the screen says it went anywhere. A number
     * on the tab is the whole difference between «held» and «gone».
     */
    const heldCount = await db.order.count({
      where: {
        companyId,
        storeId,
        confirmationStatus: 'CONFIRMED',
        OR: [{ shippingStatus: { in: [...WAITING_FOR_A_TROLLEY] } }, HELD_PACKED_PARCEL],
        shipHoldUntil: { not: null },
      },
    });

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'قائمة الشحنات', rows });

    return NextResponse.json({
      count: rows.length,
      heldCount,
      allowNegativeStock: country.allowNegativeStock,
      orders: rows,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** The order changed between the read and the write — see the update in POST. */
class OrderMovedOn extends Error {
  constructor(readonly orderNumber: string) {
    super('ORDER_MOVED_ON');
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('ops.ship');

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { deliveryProviderId, orderIds, acknowledgedOrderIds, notes } = parsed.data;

    const provider = await db.deliveryProvider.findFirst({ where: { id: deliveryProviderId, companyId } });
    if (!provider) return NextResponse.json({ error: 'شركة الشحن غير موجودة' }, { status: 404 });

    const orders = await db.order.findMany({
      where: { id: { in: orderIds }, companyId, storeId },
      select: {
        id: true, orderNumber: true, companyId: true, storeId: true, customerId: true, regionId: true,
        confirmationStatus: true, shippingStatus: true, shippedAt: true, priceIncludesDelivery: true,
        deliveryProviderId: true, version: true, shippingBatchId: true, labelPrintedAt: true, shipHoldUntil: true,
        // What a hold the batch ends said, for the record of it (RV880).
        shipHoldReason: true,
        items: { select: { quantity: true, freeQuantity: true, reservedQty: true, unitPrice: true, discountShare: true, lineTotal: true } },
        // The upsell the customer accepted. Without it, the snapshot below
        // rebuilt the total from the lines alone and the add-on was never
        // collected. Its `reservedQty` is what the readiness check below asks of it.
        addOns: { select: { quantity: true, price: true, reservedQty: true } },
      },
    });

    const exceptions: { orderId: string; orderNumber: string; reasons: string[] }[] = [];
    const shippable: typeof orders = [];

    for (const order of orders) {
      const reasons: string[] = [];

      // The list may be a minute old. Asked of the row as it is now.
      const moved = whyNotBatchable(order);
      if (moved) reasons.push(moved);

      // The lines AND the add-ons: an add-on nobody reserved holds the parcel back like a line that is short.
      const ready = assertReadyToShip(order as StateSource, guardLines(order.items, order.addOns));
      if (!ready.allowed) reasons.push(ready.message ?? 'غير جاهز للشحن');

      const blocks = await shipmentBlocks(
        db,
        { id: order.id, companyId: order.companyId, storeId: order.storeId, customerId: order.customerId, regionId: order.regionId, deliveryProviderId },
        { allowNegativeStock: country.allowNegativeStock, batchOrderIds: orderIds }
      );
      for (const block of blocks) {
        // Soft blocks pass only with an explicit acknowledgement for THIS order.
        if (block.hard || !acknowledgedOrderIds.includes(order.id)) reasons.push(block.message);
      }

      if (reasons.length > 0) exceptions.push({ orderId: order.id, orderNumber: order.orderNumber, reasons });
      else shippable.push(order);
    }

    if (shippable.length === 0) {
      return NextResponse.json(
        { error: 'لا يوجد طلب صالح للشحن ضمن الاختيار', code: 'ALL_BLOCKED', exceptions },
        { status: 409 }
      );
    }

    // The orders whose postponement this batch cut short (RV880): recorded in the audit once the batch exists.
    const holdsLifted: { id: string; shipHoldUntil: Date | null; shipHoldReason: string | null }[] = [];
    const now = new Date();

    const batch = await db.$transaction(async (tx) => {
      // ONE OPEN TROLLEY PER COURIER.
      //
      // A courier collects once: everything going to them today rides on
      // the same batch until somebody presses «سلّمت للشركة». Opening a
      // second batch while the first is still being filled splits one
      // pickup into two lists, and the warehouse then has to remember
      // which of them the driver actually took.
      const open = await tx.shippingBatch.findFirst({
        where: { companyId, storeId, deliveryProviderId, status: 'READY' },
        orderBy: { createdAt: 'desc' },
      });

      const count = await tx.shippingBatch.count({ where: { companyId } });
      const created =
        open ??
        (await tx.shippingBatch.create({
        data: {
          companyId,
          storeId,
          batchNumber: `BATCH-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`,
          deliveryProviderId,
          createdById: user.id,
          notes: notes ?? null,
          status: 'READY',
        },
        }));

      for (const order of shippable) {
        const fee = await resolveDeliveryFee(tx, {
          deliveryProviderId,
          regionId: order.regionId,
          minorUnit: country.minorUnit,
        });
        const money = codForOrder({
          lines: order.items,
          addOns: order.addOns,
          deliveryFee: fee.fee,
          priceIncludesDelivery: order.priceIncludesDelivery,
          minorUnit: country.minorUnit,
        });
        // ON A TROLLEY, NOT POSTPONED (RV880): the hold ends in this very write — see `holdEndsInBatch`.
        const hold = holdEndsInBatch(order, now);

        /*
         * THE WRITE REPEATS THE QUESTION. Between the read above and this
         * line another press may have put the order on a trolley, or the
         * order may have been edited (its version moved). The filter makes
         * the database refuse that order rather than move it: Prisma then
         * throws "record not found", which stops the whole batch and is
         * answered below with the order's number.
         */
        await tx.order
          .update({
            where: {
              id: order.id,
              version: order.version,
              shippingBatchId: null,
              // A packed parcel that «أجّل الشحن» took off a trolley is batchable again: only with its hold date.
              shippingStatus: { in: [...BATCHABLE_SHIPPING, ...(order.shipHoldUntil ? ['READY_FOR_PICKUP'] : [])] },
            },
            data: {
              shippingBatchId: created.id,
              deliveryProviderId,
              deliveryAssignedAt: new Date(),
              deliveryAssignedById: user.id,
              // Fee and COD are snapshots taken now; a later table change never
              // rewrites this order.
              deliveryFee: fee.fee,
              totalAmount: money.cod,
              shippingStatus: 'READY_FOR_PICKUP',
              settlementStatus: 'PENDING_COLLECTION',
              ...(hold.clears ? { shipHoldUntil: null, shipHoldReason: null } : {}),
              version: { increment: 1 },
            },
          })
          .catch((e: unknown) => {
            if ((e as { code?: string })?.code === 'P2025') throw new OrderMovedOn(order.orderNumber);
            throw e;
          });
        await tx.orderStatusLog.create({
          data: {
            companyId, orderId: order.id, statusType: 'SHIPPING',
            previousValue: order.shippingStatus, newValue: 'READY_FOR_PICKUP',
            changedById: user.id, changedByRole: user.role,
            note: `batch ${created.batchNumber}`,
          },
        });
        if (hold.lifted) {
          // In the order's timeline as «أرجِعه» writes a lifted hold — the same action, and its goods untouched by this door.
          await tx.orderActivity.create({
            data: {
              companyId,
              orderId: order.id,
              userId: user.id,
              action: SHIP_HOLD_RELEASED,
              metadata: JSON.stringify({
                until: null,
                reason: null,
                stock: 'KEPT',
                intoBatch: created.batchNumber,
                heldUntil: order.shipHoldUntil,
                heldReason: order.shipHoldReason ?? null,
              }),
            },
          });
          holdsLifted.push({ id: order.id, shipHoldUntil: order.shipHoldUntil, shipHoldReason: order.shipHoldReason ?? null });
        }
      }
      return created;
    });

    await logAudit({
      companyId, userId: user.id, action: 'SHIPMENT_BATCH_CREATED',
      entity: 'ShippingBatch', entityId: batch.id,
      newData: { batchNumber: batch.batchNumber, orders: shippable.length, exceptions: exceptions.length },
    });
    // Each postponement the batch cut short, in the audit as «أرجِعه» writes one (RV880).
    for (const lifted of holdsLifted) {
      await logAudit({
        companyId, userId: user.id, action: SHIP_HOLD_RELEASED,
        entity: 'Order', entityId: lifted.id,
        previousData: { shipHoldUntil: lifted.shipHoldUntil, reason: lifted.shipHoldReason },
        newData: { shipHoldUntil: null, reason: null, intoBatch: batch.batchNumber },
      });
    }

    // Whether this courier is sent to by API: the banner then offers «رحّل»
    // before «اطبع», so the waybill carries the courier's barcode beside our QR.
    return NextResponse.json({ batch, shipped: shippable.length, exceptions, courierApi: provider.apiEnabled === true }, { status: 201 });
  } catch (error) {
    if (error instanceof OrderMovedOn) {
      return NextResponse.json(
        {
          error: `الطلب ${error.orderNumber} تغيّر قبل ما تنعمل الدفعة — ما انحفظ شي. حدّث القائمة وجرّب من جديد.`,
          code: 'ORDER_MOVED_ON',
        },
        { status: 409 }
      );
    }
    return apiErrorResponse(error);
  }
}
