import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { restoreOrderStock, takeOffUnreturned } from '@/lib/stock-consumption';
import { logAudit } from '@/lib/audit';
import { resolveDeliveryFee } from '@/lib/delivery-fees';
import { roundMinor } from '@/lib/money';
import { reverseForOrder } from '@/lib/commission';
import { completionOf, doorUnits, expectedBackTotal, needsExtraAction, type Completion } from '@/lib/partial-delivery';
import { nothingCameBack, receiptNothingCameBackWhere } from '@/lib/written-off';
import { IntakePlaceRefused, intakeRefusalBody, returnPlace, type IntakeRefusalCode, type WarehouseRef } from '@/lib/warehouse-intake';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE RECEIPT OF A RETURN, WRITTEN IN ONE PLACE.
 *
 * The single door (`POST /api/ops/returns`) and «استلام الكل» (`POST /api/ops/returns/receive-all`) both call
 * `receiveReturn`. The checks, the transaction — the receipt row, the shelf (`restoreOrderStock`, `takeOffUnreturned`),
 * the reservation released, the order's state, the commission reversed (`reverseForOrder`), the order note — and the
 * `RETURN_RECEIVED` audit row are this function and nothing else. A second copy of any of it in the bulk door would be two
 * rules for the same parcel, and the day they disagree a pallet goes back on the shelf by a rule nobody reads.
 *
 * A refusal is RETURNED, not thrown, with the exact body and status the single door has always answered, so that door
 * hands it on unchanged. Anything thrown (a database error, the unique receipt of a race) is the caller's: the single door
 * passes it to `apiErrorResponse` as before; the bulk door counts it and goes on to the next parcel.
 *
 * ── THE BULK RECEIPT (`whole`) ──
 *
 * The button has not seen the parcel the way the clerk with the box open has, so it receives less than the dialog can:
 *   · the whole of what is expected back, sound — nothing damaged, nothing missing, no courier fee;
 *   · NEVER an order that already holds a receipt — not even the «nothing came back» receipt of a write-off, which the
 *     single door may COMPLETE when the parcel turns up: completing it is a statement about a parcel, and only a person
 *     holding that parcel makes it;
 *   · NEVER a partial delivery that asks «هل الطلب استلم؟» (`needsExtraAction`) — that question stays the dialog's;
 *   · NEVER an order with nothing expected back — a receipt of 0 would be a «nothing came back» receipt nobody wrote.
 * All four are decided on the order as read HERE, the same read the transaction acts on.
 *
 * ── WHERE IT IS RECEIVED (the warehouse plan, W2b) ──
 *
 * A store placed in warehouses receives every parcel INTO a warehouse: the one the desk named, or — the single door only —
 * the warehouse the order left from (`Order.sourceWarehouseId`) when the desk named none. «استلام الكل» never falls back:
 * the press names ONE warehouse for every parcel it walks. The warehouse is checked inside the transaction by the rule
 * every stock door of a placed store asks (`warehouse-intake.returnPlace`: the parcel's stock locks, then of the company
 * and the store's country, running, reached by the person); a refusal is returned like any other, nothing written.
 * Then: a consumed parcel's `RET-` batch lands there; a refused parcel's broken and missing units leave from the warehouse
 * it left, and its sound units are put in the receiving one (`stock-consumption.takeOffUnreturned`).
 * A store that is not placed — read off the order's own store, so its receipt asks nothing more — is received exactly as
 * before: the same reads, the same rows, the same calls.
 * ═══════════════════════════════════════════════════════════════════════
 */

export interface ReceiptContext {
  user: { id: string };
  companyId: string;
  storeId: string;
  minorUnit: number;
  /** Does the person reach this warehouse? The doors pass `warehouses.reachesWarehouse` for the session (W2b). */
  mayUse?: (warehouse: WarehouseRef) => Promise<boolean>;
}

export interface ReceiptInput {
  orderId: string;
  /** A count from the dialog — or `'WHOLE'`, the bulk door's: everything expected back, sound. */
  receivedQty: number | 'WHOLE';
  damagedQty: number;
  chargeCourierFee: boolean;
  note?: string;
  /** The warehouse that received the parcel — read only for a store placed in warehouses (W2b). */
  warehouseId?: string | null;
}

export type ReceiptRefusalCode =
  | 'NOT_FOUND'
  | 'ALREADY_RECEIVED'
  | 'DELIVERED_AND_SETTLED'
  | 'OVER_RECEIVED'
  | 'NEEDS_THE_QUESTION'
  | 'NOTHING_EXPECTED'
  // W2b: the receiving warehouse of a placed store was refused (`warehouse-intake`).
  | IntakeRefusalCode;

export type ReceiptResult =
  | {
      ok: true;
      receipt: Awaited<ReturnType<typeof db.returnReceipt.create>>;
      missingQty: number;
      courierFeeAmount: number;
      completion: Completion;
    }
  | { ok: false; code: ReceiptRefusalCode; status: number; body: Record<string, unknown> };

const ALREADY: ReceiptResult = {
  ok: false,
  code: 'ALREADY_RECEIVED',
  status: 409,
  body: { error: 'تم استلام هذا المرتجع مسبقاً', code: 'ALREADY_RECEIVED' },
};

/** The database's own «one receipt per order»: the second of two presses at the same moment. */
export const isReceiptRace = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export async function receiveReturn(
  ctx: ReceiptContext,
  input: ReceiptInput,
  opts: { bulk?: boolean } = {}
): Promise<ReceiptResult> {
  const { user, companyId, storeId } = ctx;
  const whole = input.receivedQty === 'WHOLE';

  const order = await db.order.findFirst({
    where: { id: input.orderId, companyId, storeId },
    select: {
      id: true, orderNumber: true, shippingStatus: true, settlementStatus: true,
      regionId: true, deliveryProviderId: true,
      // W2b: the warehouse it left from (the desk's default receiver) and whether its store is placed in warehouses.
      sourceWarehouseId: true,
      store: { select: { warehousePlacement: { select: { id: true } } } },
      returnReceipt: { select: { id: true, receivedQty: true, damagedQty: true, missingQty: true, courierFeeCharged: true } },
      items: { select: { id: true, productId: true, productName: true, quantity: true, freeQuantity: true, deliveredQty: true } },
      // The add-ons travel in the same box (27/11): expected back, locked, and released with the lines.
      addOns: { select: { id: true, productId: true, productName: true, quantity: true } },
    },
  });
  if (!order) return { ok: false, code: 'NOT_FOUND', status: 404, body: { error: 'الطلب غير موجود' } };

  const addOns = order.addOns ?? [];
  const expectedQty = expectedBackTotal(order.items, addOns);
  // The bulk door's whole count — known only now, from the order this very call read.
  const receivedQty = whole ? expectedQty : (input.receivedQty as number);

  /*
   * A RECEIPT THAT SAYS NOTHING CAME BACK IS NOT THE END OF THE PARCEL.
   *
   * A write-off, and a zero count at this desk, both leave a receipt of received 0, damaged 0 and everything
   * missing. If the parcel turns up after all, this call COMPLETES that same receipt — one receipt per order —
   * instead of being refused as «already received». A second zero count, or any receipt that already holds
   * units, is still refused. The bulk receipt never completes one (see the head of this file).
   */
  const completing = !whole && !!order.returnReceipt && nothingCameBack(order.returnReceipt) && receivedQty + input.damagedQty > 0;
  if (order.returnReceipt && !completing) return ALREADY;
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
    return {
      ok: false,
      code: 'DELIVERED_AND_SETTLED',
      status: 409,
      body: {
        error: 'هالطلب انسلّم وانسوّى حسابه — ما في مرتجع ليتسجّل عليه',
        errorAr: 'هالطلب انسلّم وانسوّى حسابه — ما في مرتجع ليتسجّل عليه',
        code: 'DELIVERED_AND_SETTLED',
      },
    };
  }

  if (whole && needsExtraAction(order.items)) {
    return { ok: false, code: 'NEEDS_THE_QUESTION', status: 409, body: { error: 'توصيل جزئي — بينستلم من نافذته', code: 'NEEDS_THE_QUESTION' } };
  }
  if (whole && expectedQty <= 0) {
    return { ok: false, code: 'NOTHING_EXPECTED', status: 409, body: { error: 'ما في شي راجع على هالطلب', code: 'NOTHING_EXPECTED' } };
  }

  if (receivedQty + input.damagedQty > expectedQty) {
    return {
      ok: false,
      code: 'OVER_RECEIVED',
      status: 400,
      body: { error: `الكمية المستلمة أكبر من المشحونة (${expectedQty})`, code: 'OVER_RECEIVED' },
    };
  }
  const missingQty = expectedQty - receivedQty - input.damagedQty;

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
  const units = doorUnits(order.items, addOns);
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
      minorUnit: ctx.minorUnit,
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
    courierFeeAmount = roundMinor(fee.returnFee, ctx.minorUnit);
  }

  /*
   * W2b: is the store placed, and which warehouse was asked? Read off the order above, so an unplaced store's receipt
   * makes no new statement. The single door falls back to the warehouse the order left from; the bulk door never does.
   */
  const placed = !!order.store?.warehousePlacement;
  const asked = (typeof input.warehouseId === 'string' && input.warehouseId.trim()) || (opts.bulk ? null : order.sourceWarehouseId ?? null);
  // Written inside the transaction, read after it (W2b).
  const at: { id: string | null; name: string | null; moved: number } = { id: null, name: null, moved: 0 };
  const refused: { place?: IntakePlaceRefused } = {};

  const receipt = await db.$transaction(async (tx) => {
    // W2b: the receiving warehouse, checked under the parcel's stock locks — null for a store that is not placed.
    const receiver = placed
      ? await returnPlace(tx, {
          companyId,
          storeId,
          productIds: [...order.items, ...addOns].map((i) => i.productId),
          warehouseId: asked,
          mayUse: ctx.mayUse,
        })
      : null;
    if (receiver) {
      at.id = receiver;
      at.name = (await tx.warehouse.findFirst({ where: { id: receiver, companyId }, select: { name: true } }))?.name ?? null;
    }
    const counted = {
      expectedQty,
      receivedQty,
      damagedQty: input.damagedQty,
      missingQty,
      inspectedById: user.id,
      // Only sound units go back on the shelf.
      stockRestored: receivedQty > 0,
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
      receivedQty,
      damagedQty: input.damagedQty,
      userId: user.id,
      ...(receiver ? { warehouseId: receiver } : {}),
    });

    // A parcel refused at the door never left the shelf's books, so its broken and missing units are taken off here — before
    // the reservation is released, or they become stock the next customer is sold (takeOffUnreturned, 5/11).
    const off = await takeOffUnreturned(tx, {
      orderId: order.id,
      companyId,
      receivedQty,
      damagedQty: input.damagedQty,
      missingQty,
      userId: user.id,
      ...(receiver ? { warehouseId: receiver } : {}),
    });
    at.moved = off?.moved ?? 0;

    await tx.orderItem.updateMany({ where: { orderId: order.id, reservedQty: { gt: 0 } }, data: { reservedQty: 0 } });
    // And the add-ons' holds (27/11): left behind, the unit was never sellable again. An order without one writes nothing more.
    if (addOns.length > 0) {
      await tx.orderAddOn.updateMany({ where: { orderId: order.id, reservedQty: { gt: 0 } }, data: { reservedQty: 0 } });
    }
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
      reason: `مرتجع مستلم: ${receivedQty} وصل، ${input.damagedQty} تالف`,
    });
    await tx.orderNote.create({
      data: {
        companyId,
        orderId: order.id,
        authorId: user.id,
        kind: 'return',
        body:
          (completing ? 'وصل الطرد بعد إغلاقه بلا استلام — ' : '') +
          `استلام مرتجع: وصل ${receivedQty}، تالف ${input.damagedQty}، ناقص ${missingQty}` +
          (input.chargeCourierFee ? ` — أجرة إرجاع ${courierFeeAmount}` : '') +
          (input.note ? ` — ${input.note}` : '') +
          // W2b: where it was received — only in a store placed in warehouses.
          (at.name ? ` — استُلم بمخزن ${at.name}` : '') +
          // The note thread is where a person finds out the order is not
          // finished. Without this line the receipt reads as the end of
          // the order, and for a partial delivery it is half of it.
          (completion.complete ? '' : ` — ${completion.label}`),
      },
    });
    return created;
  }).catch((e: unknown) => {
    // W2b: the receiving warehouse refused — the transaction rolled back, nothing written; answered below.
    if (e instanceof IntakePlaceRefused) {
      refused.place = e;
      return null;
    }
    throw e;
  });

  if (refused.place) {
    const e = refused.place;
    return { ok: false, code: e.code, status: e.status, body: intakeRefusalBody(e) };
  }
  if (!receipt) return ALREADY;

  await logAudit({
    companyId, userId: user.id, action: 'RETURN_RECEIVED',
    entity: 'Order', entityId: order.id,
    newData: {
      receiptId: receipt.id, expectedQty, received: receivedQty, damaged: input.damagedQty,
      missingQty, courierFeeAmount,
      // Whether this receipt finished the order or only half of it.
      completion: completion.degree, awaiting: completion.awaiting,
      // The parcel written off as lost turned up: this completed the receipt the write-off had closed.
      ...(completing ? { completesLossReceipt: true } : {}),
      // Received by «استلام الكل», not counted in the dialog.
      ...(opts.bulk ? { bulk: true } : {}),
      // W2b: the warehouse that received it, and the sound units of a refused parcel moved into it.
      ...(at.id ? { warehouseId: at.id, warehouseName: at.name, movedToWarehouse: at.moved } : {}),
    },
  });

  return { ok: true, receipt, missingQty, courierFeeAmount, completion };
}
