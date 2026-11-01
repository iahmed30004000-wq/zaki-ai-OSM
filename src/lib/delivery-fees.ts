import type { Prisma } from '@prisma/client';
import { db } from './db';
import { computeCod, roundMinor } from './money';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * DELIVERY FEES — one row per courier per country per region.
 *
 * The fee that lands on an order is a SNAPSHOT: changing the table later
 * never rewrites a live order, the same way a commission rule change never
 * touches a closed period. A manual override always carries a reason and is
 * written to the audit log by the caller.
 */

export interface ResolvedFee {
  fee: number;
  lateThresholdDays: number;
  returnFee: number;
  source: 'TABLE' | 'NONE';
}

/** The table fee for a courier in a region, or an explicit "no row" answer. */
export async function resolveDeliveryFee(
  tx: Tx,
  params: { deliveryProviderId: string; regionId: string | null; minorUnit: number }
): Promise<ResolvedFee> {
  if (!params.regionId) return { fee: 0, lateThresholdDays: 0, returnFee: 0, source: 'NONE' };

  const row = await tx.deliveryFee.findFirst({
    where: { deliveryProviderId: params.deliveryProviderId, regionId: params.regionId, isActive: true },
    select: { fee: true, lateThresholdDays: true, returnFee: true },
  });
  if (!row) return { fee: 0, lateThresholdDays: 0, returnFee: 0, source: 'NONE' };

  return {
    fee: roundMinor(Number(row.fee), params.minorUnit),
    lateThresholdDays: row.lateThresholdDays,
    returnFee: roundMinor(Number(row.returnFee), params.minorUnit),
    source: 'TABLE',
  };
}

export interface OrderLineLike {
  quantity: number;
  unitPrice: number | Prisma.Decimal;
  freeQuantity?: number;
  discountShare?: number | Prisma.Decimal;
  /** What the line was written at, after its discount. When present it settles a unit price that was rounded. */
  lineTotal?: number | Prisma.Decimal | null;
}

/**
 * WHAT ONE LINE CAME TO BEFORE THE ORDER'S DISCOUNT — the stored figure when the unit price is a rounded copy of it.
 *
 * «٣ بـ 25» is a unit price of 8.33333…, stored as 8.333: multiplied back, three of them are 24.999, and the courier
 * was told to collect a fil less than the customer was quoted (the order's own total, written when the order was
 * taken, says 25). `lineTotal + discountShare` is the value the line was written at, so it is used — but ONLY when it
 * lies within the rounding the unit price could have lost (half a minor unit per piece): a stored figure that is
 * far from `quantity × unitPrice` is a line that was edited or imported some other way, and that case keeps the
 * multiplication it always had. No new arithmetic: the value is handed to the same `computeCod`.
 */
function lineValue(l: OrderLineLike, minorUnit: number): { quantity: number; unitPrice: number } {
  const quantity = l.quantity;
  const unitPrice = Number(l.unitPrice);
  if (l.lineTotal == null || !(quantity > 0)) return { quantity, unitPrice };
  const stored = roundMinor(Number(l.lineTotal) + Number(l.discountShare ?? 0), minorUnit);
  const band = (quantity * 0.5) / 10 ** minorUnit;
  return Math.abs(stored - quantity * unitPrice) <= band + 1e-9 ? { quantity: 1, unitPrice: stored } : { quantity, unitPrice };
}

/**
 * COD for one order with the courier's fee applied — the same money
 * function every other screen uses, never a second formula.
 */
export function codForOrder(params: {
  lines: OrderLineLike[];
  /** The order's accepted add-ons (OrderAddOn). Omitting them drops their money from the COD. */
  addOns?: Array<{ quantity: number; price: number | { toString(): string } }>;
  deliveryFee: number;
  priceIncludesDelivery: boolean;
  minorUnit: number;
}) {
  const discount = params.lines.reduce((sum, l) => sum + Number(l.discountShare ?? 0), 0);
  return computeCod({
    lines: params.lines.map((l) => ({
      ...lineValue(l, params.minorUnit),
      freeQuantity: l.freeQuantity,
    })),
    discount,
    deliveryFee: params.deliveryFee,
    priceIncludesDelivery: params.priceIncludesDelivery,
    minorUnit: params.minorUnit,
    addOns: (params.addOns ?? []).map((a) => ({ quantity: a.quantity, unitPrice: Number(a.price) })),
  });
}

/**
 * Whether an order's price already contains delivery — ONE rule for every
 * door (direct, landing page, storefront, Telegram).
 *
 * It is the STORE's pricing policy for every order no offer speaks for (a
 * Telegram message, a sheet row, a price typed by hand). An offer that DOES
 * speak — «السعر شامل التوصيل» ticked or unticked — answers for its own
 * bundle, yes or no (`offersSayDeliveryIncluded` reads the offers of an
 * order). It used to be applied to direct orders only, so a store that
 * advertises delivery-inclusive prices had its landing-page and Telegram
 * orders collected as price + fee.
 *
 * (1/11, the owner: «بدي اترك مجال … أحدد إذا شامل ولا لأ بظبط».) It used to
 * be that an offer could only switch delivery ON, so an unticked box on an
 * offer was silently overridden the day the store's policy was turned on. A
 * NO that the owner wrote on an offer is now obeyed; silence — `undefined` or
 * `null` — still follows the store.
 */
export async function priceIncludesDeliveryFor(
  storeId: string,
  offersSay?: boolean | null
): Promise<boolean> {
  if (typeof offersSay === 'boolean') return offersSay;
  const store = await db.store.findFirst({ where: { id: storeId }, select: { priceIncludesDelivery: true } });
  return store?.priceIncludesDelivery === true;
}
