import { roundMinor } from './money';
import { handedToCourier } from './order-seal';

/**
 * THE PACKING TABLE’S OWN PEN — `ops.edit_in_batch` (30/10).
 *
 * The owner: «بدي تعديل حصري لموظفة التجهيز تقدر تعدل قبل ما تغلق الباتش … وبعد ما تغلق ما تقدر تعدل شي».
 *
 * Once an order is confirmed, an edit is a request (`CHANGE_REQUEST_REQUIRED`). That is right for the world outside the
 * warehouse, and wrong for the person standing at the trolley with the box in her hand and the customer on the phone:
 * the box is still ours until «إغلاق الشحنة — سُلّمت للشركة». So this key opens ONE more way through that rule, and it
 * is narrow on every side:
 *
 *   · WHEN — the order is confirmed, sits in a batch that is still open (READY), and nothing says the parcel has left.
 *     The moment the batch is closed the window shuts by itself and the existing seal answers as it always did.
 *   · WHAT — the customer’s name, phone, second phone, address, the governorate, and the QUANTITY of the lines it
 *     already has. Never a price, a discount, a fee, or another product: those stay behind `orders.change_price`,
 *     `orders.change_fee` and the request. A quantity moves the total only through `computeCod`, at the piece price the
 *     line already had — the figure is rebuilt HERE on the server, so a browser cannot pass a price in through it.
 *   · WHO — whoever the owner ticked. No migration, no fallback and no role grants it on its own.
 *
 * Pure: the route reads the order, its batch and its lines and passes them in.
 */

/** What the key may change. `items` carries quantities only; the rest is rebuilt by `prepItems`. */
const EDITS: readonly string[] = ['customerName', 'customerPhone', 'customerAltPhone', 'customerAddress', 'regionId', 'items'];
/** Fields that ride along with any edit and change nothing by themselves. */
const RIDERS: readonly string[] = ['expectedVersion', 'reason'];

/**
 * Is this request made of nothing but what the key may change? One field outside the list (a price, a status, a
 * note…) and the request is not the packing table’s: it goes the ordinary way, with the ordinary answer.
 */
export function prepFieldsOnly(data: Record<string, unknown>): boolean {
  const sent = Object.entries(data).filter(([, v]) => v !== undefined).map(([k]) => k);
  return sent.some((k) => EDITS.includes(k)) && sent.every((k) => EDITS.includes(k) || RIDERS.includes(k));
}

export type PrepWindow =
  | { open: true }
  | { open: false; why: 'NOT_CONFIRMED' | 'NO_BATCH' | 'HANDED_OVER' };

/**
 * Is the order still in the hands of the person at the trolley?
 *
 * The batch row is the truth about «closed»: `SHIPPED` and `CLOSED` shut it (`handedToCourier` says the same thing
 * about the order’s own state). A batch we could not read is not assumed open.
 */
export function prepWindow(order: {
  confirmationStatus: string;
  shippingStatus: string;
  shippedAt?: Date | string | null;
  shippingBatchId?: string | null;
}, batch: { status: string } | null): PrepWindow {
  if (order.confirmationStatus !== 'CONFIRMED') return { open: false, why: 'NOT_CONFIRMED' };
  if (!order.shippingBatchId || !batch) return { open: false, why: 'NO_BATCH' };
  if (handedToCourier({ shippingStatus: order.shippingStatus, shippedAt: order.shippedAt ?? null, batchStatus: batch.status })) {
    return { open: false, why: 'HANDED_OVER' };
  }
  return batch.status === 'READY' ? { open: true } : { open: false, why: 'NO_BATCH' };
}

/** A line the order already has: the figure is its total BEFORE the order’s discount, as `totalsBeforeDiscount` states it. */
export interface PrepStoredLine {
  productId: string;
  quantity: number;
  beforeDiscount: number;
}

export interface PrepAskedLine {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export const PREP_GOODS_AR = 'من هنا بتعدّل الكمية بس — تبديل المنتج أو إضافته أو حذفه بيصير بطلب تعديل.';

/**
 * THE LINES THE EDIT LEAVES, WITH THEIR MONEY REBUILT.
 *
 * Every stored line must be answered by exactly one asked line of the same product: nothing swapped, added or removed.
 * (A product twice on the order is matched in the order it was sent, which is the order the screen was given.) A line
 * whose quantity did not move keeps its stored total untouched; one that did gets the piece price it already had times
 * the new quantity, rounded the way `computeCod` rounds. Whatever `unitPrice` the browser sent is ignored — the price
 * gate that follows compares the rebuilt figure with the stored one, so a request cannot smuggle a new price through here.
 */
export function prepItems(
  stored: readonly PrepStoredLine[],
  asked: readonly PrepAskedLine[],
  minorUnit: number
): { ok: true; items: PrepAskedLine[] } | { ok: false; error: string } {
  if (asked.length !== stored.length) return { ok: false, error: PREP_GOODS_AR };
  const free = [...stored];
  const items: PrepAskedLine[] = [];
  for (const line of asked) {
    const at = free.findIndex((l) => l.productId === line.productId);
    if (at < 0) return { ok: false, error: PREP_GOODS_AR };
    const [was] = free.splice(at, 1);
    const unitPrice =
      line.quantity === was.quantity || was.quantity <= 0
        ? was.beforeDiscount
        : roundMinor((was.beforeDiscount / was.quantity) * line.quantity, minorUnit);
    items.push({ productId: line.productId, quantity: line.quantity, unitPrice });
  }
  return { ok: true, items };
}

/** The quantities before and after, per product, for the order’s timeline and the audit — no customer data in it. */
export function prepQuantityChanges(
  stored: readonly Pick<PrepStoredLine, 'productId' | 'quantity'>[],
  next: readonly Pick<PrepAskedLine, 'productId' | 'quantity'>[]
): { productId: string; before: number; after: number }[] {
  const free = [...stored];
  const out: { productId: string; before: number; after: number }[] = [];
  for (const line of next) {
    const at = free.findIndex((l) => l.productId === line.productId);
    if (at < 0) continue;
    const [was] = free.splice(at, 1);
    if (was.quantity !== line.quantity) out.push({ productId: line.productId, before: was.quantity, after: line.quantity });
  }
  return out;
}

/** The short names of what a request touched, for the timeline (`FIELD_AR` in order-timeline.ts words them). */
export function prepTouched(data: Record<string, unknown>): string[] {
  return EDITS.filter((k) => data[k] !== undefined);
}

/**
 * The shelf could not hold the new quantity. If the company had ALREADY been told to cancel the parcel when that was found
 * (the race between the check and the write), the sentence says so: the edit is not saved, the parcel is cancelled there.
 */
export const prepShortAr = (names: string[], courierCancelled = false) => {
  const what = `المخزون لا يكفي للكمية الجديدة${names.length ? ` (${names.join('، ')})` : ''}`;
  return courierCancelled
    ? `أُلغي الطرد عند شركة الشحن ولم يُحفظ التعديل: ${what}. أعد إرسال الطرد للشركة.`
    : `${what} — لم يُحفظ شيء.`;
};

/** Thrown to stop the save (and roll the write back); the route turns it into a 409. */
export class PrepShortage extends Error {
  constructor(readonly names: string[], readonly courierCancelled = false) {
    super('PREP_SHORTAGE');
  }
}

const PREP_COMPLEX_AR = 'فيه خصم أو هدية أو إضافة على هذا الطلب: تعديل الكمية بيصير بطلب تعديل.';
export const PREP_REGION_FEE_AR = 'تغيير المحافظة يغيّر أجرة التوصيل — ارفع طلب تعديل.';
export const PREP_REGION_CLEAR_AR = 'المحافظة بتنختار من القائمة ولا بتنمسح — أجرة التوصيل مبنية عليها.';

/**
 * Is this an ORDINARY order, whose quantity can be changed in place? The reason it is not, in words, or null.
 *
 * A discount is a fixed amount that is not split again when a quantity moves; a gift unit (`freeQuantity`) is not derived
 * again from its offer; a line carrying a share of a discount was priced against it; an accepted add-on is reserved apart
 * from the lines; and a product on two lines cannot be told apart from the screen. The name, the phone and the address
 * carry none of this and are never refused by it.
 */
export function prepGoodsRefusal(order: {
  discount: number;
  lines: ReadonlyArray<{ productId: string; freeQuantity: number; discountShare: number }>;
  addOns: number;
}): string | null {
  if (order.discount > 0 || order.addOns > 0) return PREP_COMPLEX_AR;
  if (order.lines.some((l) => l.freeQuantity > 0 || l.discountShare > 0)) return PREP_COMPLEX_AR;
  if (new Set(order.lines.map((l) => l.productId)).size !== order.lines.length) return PREP_COMPLEX_AR;
  return null;
}

/** The fee the order was snapshotted with and the one the courier's table gives for the new governorate: the same, to the minor unit. */
export function prepFeeUnchanged(stored: number, wanted: number, minorUnit: number): boolean {
  return roundMinor(stored, minorUnit) === roundMinor(wanted, minorUnit);
}
