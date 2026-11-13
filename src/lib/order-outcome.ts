import type { Prisma } from '@prisma/client';
import { closingStages } from './order-closing';
import { CONFIRMATION_REFUSED } from './order-state';
import { nothingCameBack, receiptNothingCameBackWhere } from './written-off';

/**
 * WHERE AN ORDER ENDED UP, IN THE OWNER'S WORDS.
 *
 * The core state answers «where is the work» and the closing stages answer
 * «what are we still waiting for». The owner reads his orders as one
 * sentence that says both, and ruled the vocabulary himself (21/10):
 *
 *   مطلوب تجهيزه                 = مؤكد وتم شحنه
 *   تم استلام المبلغ              = تم الاستلام + تم التحصيل = مغلق
 *   تم استلام الطلب الملغي / قيد التوصيل = مرتجع بدون رسوم = مغلق
 *   ملغي / مفقود / ملغي من الشركة = ملغي قبل الشحن
 *   مكرر                         = ملغي مكرر
 *   مؤجل                         = مؤجل
 *
 * «ملغي بعد الشحن» is a RETURN here — this system never cancels a parcel
 * that has left (invariant 4); it comes back, and it is finished when the
 * counting desk receives it.
 *
 * This is a READING of the stored fields, never stored itself, so it cannot
 * drift from them. «= مغلق» appears in a label only where `closingStages`
 * says closed — the test holds the two to each other — so the dashboard,
 * the list and the «مغلق» filter can never tell three different stories.
 */

export const OUTCOMES = [
  'SHIPPED',
  'DELIVERED_CLOSED',
  'DELIVERED_AWAITING_CASH',
  'PARTIAL_CLOSED',
  'PARTIAL_OPEN',
  'RETURNED_NO_FEE_CLOSED',
  'RETURNED_FEE_CLOSED',
  'RETURN_AWAITING',
  'LOST_AFTER_SHIPPING_CLOSED',
  'CANCELLED_BEFORE_SHIPPING',
  'CANCELLED_DUPLICATE',
  'POSTPONED',
  'BEING_WORKED',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABEL_AR: Record<Outcome, string> = {
  SHIPPED: 'مؤكد وتم شحنه',
  DELIVERED_CLOSED: 'تم الاستلام + تم التحصيل = مغلق',
  DELIVERED_AWAITING_CASH: 'تم التسليم — بانتظار التحصيل',
  PARTIAL_CLOSED: 'تسليم جزئي = مغلق',
  PARTIAL_OPEN: 'تسليم جزئي — بانتظار المال أو المرتجع',
  RETURNED_NO_FEE_CLOSED: 'مرتجع بدون رسوم = مغلق',
  RETURNED_FEE_CLOSED: 'مرتجع برسوم = مغلق',
  RETURN_AWAITING: 'مرتجع — بانتظار الاستلام',
  LOST_AFTER_SHIPPING_CLOSED: 'مفقود بعد الشحن — خسارة = مغلق',
  CANCELLED_BEFORE_SHIPPING: 'ملغي قبل الشحن',
  CANCELLED_DUPLICATE: 'ملغي مكرر',
  POSTPONED: 'مؤجل',
  BEING_WORKED: 'قيد العمل',
};

/** Finished: nothing owed, nothing coming back. Held to closingStages by the test. */
export const OUTCOME_CLOSED: Record<Outcome, boolean> = {
  SHIPPED: false,
  DELIVERED_CLOSED: true,
  DELIVERED_AWAITING_CASH: false,
  PARTIAL_CLOSED: true,
  PARTIAL_OPEN: false,
  RETURNED_NO_FEE_CLOSED: true,
  RETURNED_FEE_CLOSED: true,
  RETURN_AWAITING: false,
  LOST_AFTER_SHIPPING_CLOSED: true,
  CANCELLED_BEFORE_SHIPPING: true,
  CANCELLED_DUPLICATE: true,
  POSTPONED: false,
  BEING_WORKED: false,
};

export interface OutcomeSource {
  confirmationStatus: string;
  shippingStatus: string;
  settlementStatus: string;
  rejectionReason?: string | null;
  /** The counting desk's receipt, when there is one. */
  returnReceipt?: { courierFeeCharged: boolean; receivedQty?: number; damagedQty?: number; missingQty?: number } | null;
}

const IN_TRANSIT = ['READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY'];
const COMING_BACK = ['FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED'];

export function orderOutcome(o: OutcomeSource): Outcome {
  const closed = closingStages({
    shippingStatus: o.shippingStatus,
    settlementStatus: o.settlementStatus,
    returnReceived: Boolean(o.returnReceipt),
    confirmationStatus: o.confirmationStatus,
  }).closed;

  const refused = (CONFIRMATION_REFUSED as readonly string[]).includes(o.confirmationStatus);
  if (o.shippingStatus === 'CANCELLED' || (refused && o.shippingStatus === 'NOT_READY')) {
    return o.rejectionReason === 'DUPLICATE_ORDER' ? 'CANCELLED_DUPLICATE' : 'CANCELLED_BEFORE_SHIPPING';
  }
  if (o.shippingStatus === 'DELIVERED') return closed ? 'DELIVERED_CLOSED' : 'DELIVERED_AWAITING_CASH';
  if (o.shippingStatus === 'PARTIALLY_DELIVERED') return closed ? 'PARTIAL_CLOSED' : 'PARTIAL_OPEN';
  if (COMING_BACK.includes(o.shippingStatus)) {
    if (!o.returnReceipt) return 'RETURN_AWAITING';
    const r = o.returnReceipt;
    // No unit came back and nobody was charged (a write-off, or a zero count at the desk): a loss, and closed.
    if (!r.courierFeeCharged && r.receivedQty !== undefined && r.damagedQty !== undefined && r.missingQty !== undefined
      && nothingCameBack({ receivedQty: r.receivedQty, damagedQty: r.damagedQty, missingQty: r.missingQty })) {
      return 'LOST_AFTER_SHIPPING_CLOSED';
    }
    return r.courierFeeCharged ? 'RETURNED_FEE_CLOSED' : 'RETURNED_NO_FEE_CLOSED';
  }
  if (IN_TRANSIT.includes(o.shippingStatus)) return 'SHIPPED';
  if (o.confirmationStatus === 'POSTPONED') return 'POSTPONED';
  return 'BEING_WORKED';
}

/*
 * NOT FILTERED BY `notSuperseded`, ON PURPOSE.
 *
 * This reads where each order PHYSICALLY stands: a replaced order is still a
 * parcel coming back, and hiding it here would show «everything closed»
 * while a box is in a van. The word that says «replaced by another order» is
 * a new outcome with its own label and its own place in the closing test —
 * the swap work adds it (`src/lib/superseded.ts` is the definition to use),
 * not a silent filter on a count.
 */
type Db = {
  order: {
    groupBy: (args: any) => Promise<any[]>;
    count: (args: { where: Prisma.OrderWhereInput }) => Promise<number>;
  };
};

/**
 * How many orders sit in each outcome, over the WHOLE history of the scope.
 *
 * Not the dashboard's 90-day window: «how did my orders end» is asked of
 * all of them. One GROUP BY over the four columns the reading uses, and —
 * only when some group's answer depends on the receipt — three more GROUP BYs
 * over the SAME four columns, each with one of the three receipt questions
 * («nothing came back» / «no fee» / «fee»), read once for the whole scope
 * instead of once per group (13/11: one read plus three counts for every
 * group, groups in sequence, on every dashboard opening — four statements
 * now). Every row is counted once, so the outcomes add up to `total`.
 */
export async function countOutcomes(
  db: Db,
  scope: { companyId: string; storeId?: string | null }
): Promise<{ total: number; outcomes: { key: Outcome; label: string; count: number; closed: boolean }[] }> {
  const base: Prisma.OrderWhereInput = { companyId: scope.companyId, ...(scope.storeId ? { storeId: scope.storeId } : {}) };
  const by = ['confirmationStatus', 'shippingStatus', 'settlementStatus', 'rejectionReason'];
  const groups = await db.order.groupBy({ by, where: base, _count: { _all: true } });

  const dependsOnReceipt = (g: { shippingStatus: string }) => COMING_BACK.includes(g.shippingStatus) || g.shippingStatus === 'PARTIALLY_DELIVERED';
  // Three questions about the receipt, each row in exactly one: nothing came back and no fee (a loss), no fee, a fee. Asked of the
  // whole scope at once and looked up by the four columns below; skipped when no group needs them.
  const grouped = (receipt: Prisma.ReturnReceiptWhereInput) =>
    db.order.groupBy({ by, where: { ...base, returnReceipt: { is: receipt } }, _count: { _all: true } });
  const [lostGroups, noFeeGroups, feeGroups] = groups.some(dependsOnReceipt)
    ? await Promise.all([
        grouped({ courierFeeCharged: false, ...receiptNothingCameBackWhere() }),
        grouped({ courierFeeCharged: false }),
        grouped({ courierFeeCharged: true }),
      ])
    : [[], [], []];
  // The four columns are the key — null stays null, so a group with no rejection reason finds its own count.
  const keyOf = (g: Record<string, unknown>) => JSON.stringify(by.map((c) => g[c] ?? null));
  const tally = (rows: any[]) => new Map<string, number>(rows.map((r) => [keyOf(r), r._count._all as number]));
  const lostOf = tally(lostGroups);
  const noFeeOf = tally(noFeeGroups);
  const feeOf = tally(feeGroups);

  const counts = new Map<Outcome, number>();
  const add = (k: Outcome, n: number) => counts.set(k, (counts.get(k) ?? 0) + n);
  let total = 0;

  for (const g of groups) {
    const n: number = g._count._all;
    total += n;
    const src = {
      confirmationStatus: g.confirmationStatus,
      shippingStatus: g.shippingStatus,
      settlementStatus: g.settlementStatus,
      rejectionReason: g.rejectionReason,
    };
    if (dependsOnReceipt(g)) {
      const k = keyOf(src);
      const lostCount = lostOf.get(k) ?? 0;
      const noFeeAll = noFeeOf.get(k) ?? 0;
      const fee = feeOf.get(k) ?? 0;
      const noFee = noFeeAll - lostCount;
      const none = n - noFeeAll - fee;
      if (none) add(orderOutcome({ ...src, returnReceipt: null }), none);
      if (lostCount) add(orderOutcome({ ...src, returnReceipt: { courierFeeCharged: false, receivedQty: 0, damagedQty: 0, missingQty: 1 } }), lostCount);
      if (noFee) add(orderOutcome({ ...src, returnReceipt: { courierFeeCharged: false } }), noFee);
      if (fee) add(orderOutcome({ ...src, returnReceipt: { courierFeeCharged: true } }), fee);
    } else {
      add(orderOutcome(src), n);
    }
  }

  return {
    total,
    outcomes: OUTCOMES.filter((k) => counts.has(k)).map((k) => ({
      key: k,
      label: OUTCOME_LABEL_AR[k],
      count: counts.get(k) ?? 0,
      closed: OUTCOME_CLOSED[k],
    })),
  };
}
