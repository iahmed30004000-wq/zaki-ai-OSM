import { SHIPPING_GONE } from './order-state';

/**
 * WHEN AN ORDER STOPS BEING OURS TO CHANGE.
 *
 * A batch is open while the warehouse is still filling it: orders go in,
 * addresses get corrected, a line is added. Then somebody presses "استلمت
 * شركة الشحن" and the parcels physically leave the building. From that
 * moment the paper on the box, the address the driver has and the amount he
 * will collect are all fixed somewhere we do not control.
 *
 * So the batch closing is the seal, and it seals the orders inside it. This
 * is one line rather than a state per order on purpose: the warehouse hands
 * over a trolley, not twelve separate decisions, and a rule a person can
 * say out loud is a rule they will follow.
 *
 * A sealed order is not frozen — it is no longer editable IN PLACE. What
 * was a direct edit becomes a change request: somebody who can reach the
 * courier decides whether the change can still be made, and says what has
 * to happen if it cannot. Silence never approves it.
 *
 * WHAT IS SEALED is what the courier already acted on: who the parcel goes
 * to, where, what is in it, and what he collects. Notes, workflow status
 * and attribution are ours and stay editable — correcting a note does not
 * send a driver to the wrong street.
 */

/** Batch states in which the goods have left our hands. */
export const SEALED_BATCH_STATUSES = ['SHIPPED', 'CLOSED'] as const;

/**
 * HAS THE COURIER ACTUALLY TAKEN IT — «انضغط زر سلّمت الشركة».
 *
 * NOT the same question as `hasLeftWarehouse`, and the difference is a
 * whole stage. A printed waybill, or a parcel sitting on the out-tray
 * waiting for pickup, commits the GOODS — nobody may count those units as
 * available again. But the box is still on our floor and can still be
 * opened, and the label can still be printed again.
 *
 * So for «may the warehouse still say yes to a change?» the line is the
 * handover, not the print. The two were conflated once and the warehouse
 * lost its say the moment a label came off the printer, with the parcel
 * still three feet away.
 *
 * Whichever comes first: the order's own shipping state, or its batch
 * being handed over.
 */
export function handedToCourier(order: {
  shippingStatus: string;
  shippedAt?: Date | string | null;
  batchStatus?: string | null;
}): boolean {
  if (order.shippedAt) return true;
  if ((SHIPPING_GONE as readonly string[]).includes(order.shippingStatus)) return true;
  return SEALED_BATCH_STATUSES.includes(
    (order.batchStatus ?? '') as (typeof SEALED_BATCH_STATUSES)[number]
  );
}

/**
 * A PARCEL ON A TROLLEY THAT IS STILL BEING FILLED IS FROZEN — the owner's ruling 4/11.
 *
 * «مجرد ما الطلبات تترحل ع الباتش ما حد يقدر يلغي أي شي، ولا يترحل طلب الغاء او طلب تأجيل او تعديل، عشان اقدر اغلق الشحنة».
 *
 * Production case: ORD-2026-1584 sat on a READY trolley, a cancel was raised and approved by mistake, nobody carried it out,
 * and the press «إغلاق الشحنة — سُلّمت للشركة» refused the whole trolley for it (PENDING_CHANGES) with no way to take the
 * approval back. So from the moment an order is on a trolley and until the trolley is handed over, nobody raises, approves
 * or carries out a cancel, a postponement or an edit of it, and no direct door ends or edits it either.
 *
 * It overturns M6 (28/10, «الغاء و التأجيل لغاية ما اضغط اغلاق الشحنة») for everybody EXCEPT the warehouse's own tools on
 * the batch screen — «ألغِ / أعِده للمتابعة / أجّل الشحن» without a change request under `ops.ship`, the packing table's
 * pen (`ops.edit_in_batch`) and the transfer door. Those are the only way a parcel leaves a trolley, and they never block
 * the press: they take the parcel off, and the trolley closes without it.
 *
 * FAILS CLOSED, as `cancelVerdict` does with UNKNOWN_BATCH: an order that names a trolley whose status cannot be read (or
 * reads as anything but handed over) is treated as on an open trolley. After the handover (SHIPPED / CLOSED) this is false
 * and nothing changes: a cancel there is still a request that tells the courier.
 *
 * Pure and client-safe: the screens read it to decide what to offer, the doors read the same function to refuse.
 */
export function onOpenTrolley(order: {
  shippingBatchId: string | null | undefined;
  batchStatus: string | null | undefined;
}): boolean {
  if (!order.shippingBatchId) return false;
  return !SEALED_BATCH_STATUSES.includes((order.batchStatus ?? '') as (typeof SEALED_BATCH_STATUSES)[number]);
}

/** The code every door answers with when `onOpenTrolley` refuses. */
export const ON_OPEN_TROLLEY = 'ON_OPEN_TROLLEY' as const;

/** The one sentence every door and every screen says for it. */
export const ON_TROLLEY_AR =
  'الطلب على دفعة شحن جاهزة — ما بيصير إلغاء ولا تأجيل ولا تعديل عليه. إذا لازم، المستودع بيطلّعه من الدفعة أوّل («أجّل الشحن» من شاشة الدفعات).';

/**
 * `handedToCourier`, ASKED OF THE DATABASE AND TURNED INSIDE OUT: the orders that are still on OUR side of the handover.
 *
 * A query that must FIND the orders the courier has not taken cannot call the function above — it has no row in hand —
 * so the same three facts are rendered as a `where`, here, beside the predicate and read from the same two constants
 * (`SHIPPING_GONE`, `SEALED_BATCH_STATUSES`). Two renderings of one rule is acceptable only when they are kept together
 * and held to each other: `an-order-is-ours-until-the-courier-has-it.test.ts` proves they agree over EVERY combination
 * of the three inputs, generated and not sampled.
 *
 * The three terms, one for one with the function:
 *   · `shippedAt` is empty (the press stamped a member with it);
 *   · the order's own shipping status is not one the courier already owns;
 *   · it is on no trolley, or on a trolley that has not been handed over. Written as «no trolley OR a trolley whose
 *     status is not sealed» and NOT as `NOT (trolley is sealed)`: negating a relation filter drops the orders with no
 *     trolley at all, because `NULL IN (…)` is not false in SQL, and an order that was never batched is the commonest
 *     one still ours.
 *
 * The line is the owner's of 28/10 (M6, «الغاء و التأجيل لغاية ما اضغط اغلاق الشحنة»), and it is asked here by the
 * confirm guard (`confirmed-twin.ts`): a confirmed twin that can still be cancelled or held is one a person can still
 * decide about. It is NOT the 28/09 waybill line (`leftWarehouseWhere`), which stays the line for stock, VOID and printing.
 *
 * Returned as one `AND` clause, never as bare keys, so a caller can put it beside its own `OR` without the two keys
 * landing on each other.
 */
export function notHandedToCourierWhere(): {
  AND: (
    | { shippedAt: null }
    | { shippingStatus: { notIn: string[] } }
    | { OR: ({ shippingBatchId: null } | { shippingBatch: { is: { status: { notIn: string[] } } } })[] }
  )[];
} {
  return {
    AND: [
      { shippedAt: null },
      { shippingStatus: { notIn: [...SHIPPING_GONE] } },
      {
        OR: [
          { shippingBatchId: null },
          { shippingBatch: { is: { status: { notIn: [...SEALED_BATCH_STATUSES] } } } },
        ],
      },
    ],
  };
}

/**
 * The fields the courier is already acting on.
 *
 * Deliberately NOT here: internalNotes, customerNotes, confirmationStatus,
 * shippingStatus, trackingCode, moderatorId, channelId, postponedUntil.
 * None of them changes what the driver does today.
 */
export const SEALED_FIELDS = [
  'customerName',
  'customerPhone',
  'customerAltPhone',
  'customerAddress',
  'regionId',
  'items',
  'sellingPrice',
  'quantity',
  'discountAmount',
  'shippingCost',
] as const;

export interface SealSource {
  shippingBatch?: { status: string; batchNumber: string } | null;
  /** The order's own shipping state — the parcel may have left alone. */
  shippingStatus?: string;
  shippedAt?: Date | string | null;
  /** The waybill is printed and on the box. */
  labelPrintedAt?: Date | string | null;
}

/** Shipping states in which the parcel is out of our hands — one list. */
const GONE: readonly string[] = SHIPPING_GONE;

export interface Seal {
  sealed: boolean;
  /** The batch that sealed it, for a message a human can act on. */
  batchNumber?: string;
  /** Which of the three facts closed it. */
  reason?: 'BATCH' | 'SHIPPED' | 'LABELLED';
}

/**
 * Is this order out of our hands?
 *
 * TWO ways in, and either is enough.
 *
 * The batch being handed over is the common one: the trolley left, so
 * everything on it left. But an order can ship on its own — marked shipped
 * by hand, dispatched individually, moved between couriers — while the
 * batch it belongs to is still open and taking work. Keying only on the
 * batch left exactly that order editable after the parcel was on a van,
 * which is the case that costs money: a driver at an address nobody told
 * him about, collecting an amount nobody agreed to.
 *
 * So the order's own shipping state seals it too. Whichever happens first.
 */
export function orderSeal(order: SealSource): Seal {
  const batch = order.shippingBatch;
  if (batch && SEALED_BATCH_STATUSES.includes(batch.status as (typeof SEALED_BATCH_STATUSES)[number])) {
    return { sealed: true, batchNumber: batch.batchNumber, reason: 'BATCH' };
  }
  // shippedAt is the fact; a status that moved on afterwards does not
  // un-ship a parcel that already left.
  if (order.shippedAt || GONE.includes(order.shippingStatus ?? '')) {
    return { sealed: true, batchNumber: batch?.batchNumber, reason: 'SHIPPED' };
  }
  // The waybill is the address. Once it is printed and stuck on the box,
  // changing the address in here changes nothing the driver will ever read
  // — it only makes our record disagree with the parcel. This is the
  // earliest of the three, and it is the one that matches what actually
  // fixes a delivery: paper on a carton.
  if (order.labelPrintedAt) {
    return { sealed: true, batchNumber: batch?.batchNumber, reason: 'LABELLED' };
  }
  return { sealed: false };
}

/**
 * Which of the requested changes the seal refuses.
 *
 * Returns the field names, so the refusal can name them rather than saying
 * "something in there is not allowed" and leaving somebody guessing.
 */
export function sealedFieldsIn(body: Record<string, unknown>): string[] {
  return SEALED_FIELDS.filter((f) => body[f] !== undefined);
}

/** Arabic names for the refusal message. */
const FIELD_NAMES: Record<string, string> = {
  customerName: 'اسم العميل',
  customerPhone: 'هاتف العميل',
  customerAltPhone: 'الهاتف البديل',
  customerAddress: 'العنوان',
  regionId: 'المحافظة',
  items: 'أصناف الطلب',
  sellingPrice: 'السعر',
  quantity: 'الكمية',
  discountAmount: 'الخصم',
  shippingCost: 'الشحن والتوصيل',
};

export function sealMessage(
  batchNumber: string | undefined,
  fields: string[],
  reason: Seal['reason'] = 'BATCH'
): string {
  const names = fields.map((f) => FIELD_NAMES[f] ?? f).join('، ');
  const where =
    reason === 'SHIPPED'
      ? 'الطلب شُحن وخرج من المستودع'
      : reason === 'LABELLED'
        ? 'بوليصة الطلب طُبعت ولُصقت على الطرد — العنوان الذي سيقرأه السائق لم يعد يتغيّر من هنا'
        : `الطلب سُلِّم لشركة الشحن ضمن دفعة مقفلة${batchNumber ? ` (${batchNumber})` : ''}`;
  return `${where}. لتعديل ${names} ارفع طلب تعديل ليُبَتّ فيه.`;
}
