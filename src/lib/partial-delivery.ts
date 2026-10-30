import type { Prisma } from '@prisma/client';
import { db } from './db';
import { roundMinor } from './money';
/**
 * The money this door shows is the MATCHER'S OWN RULE, called. `doorMoney`
 * is the one reconstruction of what the customer handed over, and
 * `SETTLEMENT_ORDER_SELECT` is the one select that feeds it — spread into
 * the query below so this file cannot drift from it by a column.
 */
import { doorMoney, SETTLEMENT_ORDER_SELECT, type SettlementLine } from './settlement';
import { consumeOrderStock } from './stock-consumption';
import { appendDeliveryAttempt } from './delivery-attempts';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * PARTIAL DELIVERY — the customer took some lines and refused others.
 *
 * The rule the whole thing hangs on: the delivery fee is charged IN FULL.
 * The courier travelled to that door whether one line was taken or all of
 * them, so prorating the fee across the delivered lines would quietly make
 * every partial delivery cheaper than it was and leave the difference
 * unexplained in the settlement.
 *
 * What is recorded:
 *   - per line, how many units were taken and how many came back;
 *   - the refused units, returned to the caller so they re-enter stock
 *     through the normal count-and-inspect, never automatically.
 *
 * AND NOT THE MONEY. This wrote `collectedAmount` — the delivered goods plus
 * the full fee — and that was the one figure here nobody at the door can
 * know. A follow-up agent records what the courier told her on the phone;
 * the money is what the courier's statement says arrived, and those are not
 * the same fact.
 *
 * It was worse than a guess. The statement sweep only promotes orders still
 * in flight, so an order settled here left the set the statement checks —
 * recording a delivery did not anticipate the reconciliation, it CANCELLED
 * it, and the typed figure was never once compared with the courier's own.
 *
 * So the amount is computed and RETURNED, for the screen to show as what we
 * expect to be paid, and written by the statement when it arrives. The
 * division is the honest one: whoever stood at the door knows what happened
 * — who took what — and the courier's statement knows what money came in.
 *
 * Settlement compares the statement against `expectedAmountFor`, which reads
 * the delivered lines rather than the original total, so a partial delivery
 * is still measured against what was actually handed over.
 *
 * THAT SENTENCE WAS ASPIRATIONAL UNTIL 2026-10-02, and it is worth saying so
 * where it was written. `expectedAmountFor` took the collected amount, OR
 * ELSE the order's whole total, and subtracted the delivery fee — and this
 * file leaves `collectedAmount` null on purpose, so that «or else» fell
 * through to the whole of a parcel the customer only partly took. (The
 * column is not named here on purpose: `every-money-writer-is-known.test.ts`
 * sweeps raw source, comments included.) Measured on one real
 * order: 3 units at 12 with a 2.5 fee and two taken, the courier owed 24 and
 * the matcher demanded 36. Every partial delivery was a false MISMATCHED and
 * the collection screen asked the operator to take twelve dinars off a rep
 * who had never held them. Two files, each right on its own.
 *
 * It now reads `OrderItem.deliveredQty` — the fact this file DOES write, in
 * the same transaction as the status — and subtracts the return fee the
 * returns desk recorded. The division is unchanged and still the honest one:
 * the door writes what happened, the statement writes the money.
 *
 * The `collectedAmount` this function RETURNS and the figure the matcher
 * rebuilds from those lines are the same arithmetic in two places, which is
 * how the first gap opened. They are pinned to each other now: section 7c of
 * `the-settlement-invariants.test.ts` runs one parcel through both doors at
 * 0, 1, 2 and 3 units taken and fails if they ever disagree.
 *
 * AND THEN THE SECOND COPY WENT. Two implementations pinned by a test still
 * drift the moment somebody edits one and reads the failure as a stale
 * fixture — which is how the add-on money came to be missing from both. So
 * this file no longer computes the figure at all: it calls `doorMoney` in
 * `settlement.ts`, the same function the matcher calls, and the agreement
 * is by construction rather than by assertion. Section 7c stays, because it
 * still proves that what this file WRITES is what that rule then READS.
 *
 * What the second pass added, measured on a full delivery and not a partial:
 * the thank-you-page upsell is money on the order with no `OrderItem` row,
 * so a figure built from the lines alone left it out — 36 where the customer
 * paid 43.5 and the courier owed 41. It is in the figure now, and it is in
 * it on exactly one condition: something was taken. An add-on has no line,
 * so nobody at the door can refuse one.
 */

export interface DeliveredLine {
  /** OrderItem id. */
  itemId: string;
  /** Units the customer took. Gift units count as units. */
  deliveredQty: number;
}

export interface PartialOutcome {
  status: 'DELIVERED' | 'PARTIALLY_DELIVERED' | 'RETURNED';
  /** What the customer paid: delivered goods + add-ons + the full fee. */
  collectedAmount: number;
  /** The order's own lines, delivered units only, before the fee. */
  deliveredValue: number;
  /**
   * The thank-you-page upsell, which has no `OrderItem` row and so cannot be
   * refused at the door. Separate from `deliveredValue` because it is money
   * nobody here counted units for — and reported, because leaving it out of
   * the sum silently is the defect this field exists to make visible.
   */
  addOnValue: number;
  deliveryFee: number;
  /** Units to put back on the shelf, once counted and inspected. */
  returnedUnits: { itemId: string; productId: string; productName: string; quantity: number }[];
  linesDelivered: number;
  linesReturned: number;
  /** Units the customer kept, and units the courier is carrying back. */
  deliveredUnits: number;
  refusedUnits: number;
  /**
   * The two settlements this delivery just created, and which of them is
   * still open — see `completionOf` at the foot of this file. A partial
   * delivery is reported as half-done from the moment it is recorded, rather
   * than discovered to be half-done later by whoever chases it.
   */
  completion: Completion;
}

/** What the door saw, in the words the note is prefixed with. */
const DOOR_OUTCOME_AR: Record<string, string> = {
  DELIVERED: 'تسليم كامل',
  PARTIALLY_DELIVERED: 'تسليم جزئي',
  RETURNED: 'رفض الاستلام',
};

export class PartialDeliveryRefused extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** States at which a parcel can still be settled at the door. */
const SETTLEABLE = ['OUT_FOR_DELIVERY', 'SHIPPED'];

/**
 * Works out what a partial delivery means, and writes it.
 *
 * Returns the refused units rather than restocking them: stock re-entry is
 * count-and-inspect, done when the parcel is physically back, not when the
 * courier says it is coming.
 */
export async function recordPartialDelivery(
  tx: Tx,
  input: {
    companyId: string;
    /** The caller's store: an order of another store of the company is not found. */
    storeId?: string | null;
    orderId: string;
    lines: DeliveredLine[];
    minorUnit: number;
    userId: string;
    note?: string | null;
  }
): Promise<PartialOutcome> {
  const order = await tx.order.findFirst({
    where: { id: input.orderId, companyId: input.companyId, ...(input.storeId ? { storeId: input.storeId } : {}) },
    select: {
      id: true, orderNumber: true, shippingStatus: true, deliveryFee: true, customerId: true,
      priceIncludesDelivery: true, deliveredAt: true, returnedAt: true, deliveryProviderId: true,
      // Read, never written here: the money half belongs to the courier's
      // statement, and this only needs to know whether it is already closed.
      settlementStatus: true,
      items: {
        select: {
          id: true, productId: true, productName: true,
          // Every column the money rule reads, from the select that DEFINES
          // what it reads — including `lineTotal`, whose absence cost a fils
          // a line, and `deliveredQty`, which this transaction overwrites.
          ...SETTLEMENT_ORDER_SELECT.items.select,
        },
      },
      // The upsell: money on this order with no line of its own. Leaving it
      // out of the door's figure understated every upsold parcel.
      addOns: SETTLEMENT_ORDER_SELECT.addOns,
    },
  });
  if (!order) throw new PartialDeliveryRefused('NOT_FOUND', 'الطلب غير موجود');

  /**
   * ALREADY RECORDED?
   *
   * This asked whether `collectedAmount` was set, which stopped being the
   * door's signal the moment the door stopped writing money. The door's own
   * marks are the dates it stamps, and one of the two is always set —
   * `deliveredAt` when anything was taken, `returnedAt` when nothing was.
   */
  // Truthy, not `!== null`: a caller that selected neither column hands over
  // `undefined`, and `undefined !== null` would refuse every delivery.
  if (order.deliveredAt || order.returnedAt) {
    throw new PartialDeliveryRefused('ALREADY_SETTLED', 'سُجِّل تسليم هذا الطلب مسبقاً');
  }
  if (!SETTLEABLE.includes(order.shippingStatus)) {
    throw new PartialDeliveryRefused(
      'NOT_AT_DOOR',
      'لا يمكن تسجيل التسليم قبل خروج الشحنة للتوصيل'
    );
  }
  if (order.items.length === 0) {
    throw new PartialDeliveryRefused('NO_LINES', 'الطلب بلا بنود');
  }

  const byId = new Map(order.items.map((i) => [i.id, i]));
  const given = new Map<string, number>();

  for (const line of input.lines) {
    const item = byId.get(line.itemId);
    if (!item) throw new PartialDeliveryRefused('UNKNOWN_LINE', 'بند لا ينتمي لهذا الطلب');

    const shipped = item.quantity + item.freeQuantity;
    if (!Number.isInteger(line.deliveredQty) || line.deliveredQty < 0 || line.deliveredQty > shipped) {
      throw new PartialDeliveryRefused(
        'QUANTITY_OUT_OF_RANGE',
        `الكمية المسلَّمة من ${item.productName} يجب أن تكون بين صفر و${shipped}`
      );
    }
    given.set(line.itemId, line.deliveredQty);
  }

  // A line not mentioned was not delivered.
  let linesDelivered = 0;
  let linesReturned = 0;
  const returnedUnits: PartialOutcome['returnedUnits'] = [];
  const updates: { id: string; deliveredQty: number; returnedQty: number }[] = [];
  /**
   * The lines AS THIS TRANSACTION IS ABOUT TO WRITE THEM.
   *
   * Built here rather than re-read after the updates, so the figure the
   * screen is handed is the figure that was stored — and so the money rule
   * sees exactly the rows the matcher will read later.
   */
  const settled: SettlementLine[] = [];

  for (const item of order.items) {
    const shipped = item.quantity + item.freeQuantity;
    const delivered = given.get(item.id) ?? 0;
    const returned = shipped - delivered;

    if (delivered > 0) linesDelivered++;
    if (returned > 0) {
      linesReturned++;
      returnedUnits.push({
        itemId: item.id,
        productId: item.productId,
        productName: item.productName,
        quantity: returned,
      });
    }

    settled.push({ ...item, deliveredQty: delivered });
    updates.push({ id: item.id, deliveredQty: delivered, returnedQty: returned });
  }

  /**
   * AND THE MONEY IS NOT COMPUTED HERE.
   *
   * `doorMoney` is the settlement matcher's own reconstruction, and it
   * carries every rule this file used to restate: the fee IN FULL whatever
   * was taken (the courier travelled), waived only when nothing at all was
   * taken, never added twice when it is already inside the line prices,
   * gift units counted as stock at zero price, the stored discount share
   * divided back out per unit, and the thank-you-page upsell — which has no
   * line and so cannot be refused at this door — collected with the rest.
   *
   * Two copies of that sum is how the upsell came to be missing from both.
   */
  const money = doorMoney(
    {
      items: settled,
      addOns: order.addOns,
      priceIncludesDelivery: order.priceIncludesDelivery,
      deliveryFee: order.deliveryFee,
    },
    input.minorUnit
  );
  const deliveredValue = money.goods;
  const addOnValue = money.addOns;
  const chargedFee = money.fee;
  const collectedAmount = money.collected;
  const nothingTaken = !money.anythingTaken;

  const status: PartialOutcome['status'] = nothingTaken
    ? 'RETURNED'
    : linesReturned === 0
      ? 'DELIVERED'
      : 'PARTIALLY_DELIVERED';

  for (const update of updates) {
    await tx.orderItem.update({
      where: { id: update.id },
      data: { deliveredQty: update.deliveredQty, returnedQty: update.returnedQty },
    });
  }

  await tx.order.update({
    where: { id: order.id },
    data: {
      shippingStatus: status,
      // NOT collectedAmount. See the note at the top of this file: the money
      // is the courier's statement's to write, and writing a typed figure
      // here also removed the order from the set that statement checks.
      deliveredAt: nothingTaken ? null : new Date(),
      returnedAt: nothingTaken ? new Date() : null,
      ...(nothingTaken ? { returnReason: input.note ?? 'رفض الاستلام بالكامل' } : {}),
      version: { increment: 1 },
    },
  });

  // THE KNOCK. This is the screen built for the person at the door, and it
  // was the one recording no attempt at all.
  //
  // Refusing everything is a FAILED attempt whose reason is the refusal —
  // not a «returned» attempt. The parcel coming back is what happens next,
  // at a warehouse; what happened at the door is that somebody would not
  // take it.
  /**
   * AND THE CUSTOMER'S OWN RECORD.
   *
   * `Customer.deliveredOrders` and `cancelledOrders` are what the customers
   * screen grades somebody on — «هل يستلم؟», the only question that matters
   * before shipping to them on cash-on-delivery. They were incremented by
   * exactly one path: the manual status change on `PATCH /api/orders/:id`.
   *
   * Measured: 111 counted against 115 actually delivered. Neither this door
   * nor the courier's statement touched them, so a customer who takes every
   * parcel at the door reads as somebody with no history at all — and the
   * grade built on that counter would be wrong for the commonest way an
   * order actually completes.
   *
   * Anything taken is a delivery for this purpose. A partial is a customer
   * who opened the door and paid; grading them beside somebody who refused
   * the lot would be the wrong sentence about the wrong person.
   */
  await tx.customer.update({
    where: { id: order.customerId },
    data: nothingTaken
      ? { cancelledOrders: { increment: 1 } }
      : { deliveredOrders: { increment: 1 }, totalPurchaseValue: { increment: collectedAmount } },
  });

  await appendDeliveryAttempt(tx, {
    orderId: order.id,
    companyId: input.companyId,
    result: nothingTaken ? 'FAILED' : status === 'PARTIALLY_DELIVERED' ? 'PARTIALLY_DELIVERED' : 'DELIVERED',
    failureReason: nothingTaken ? 'CUSTOMER_REFUSED' : null,
    note: input.note ?? null,
    deliveryProviderId: order.deliveryProviderId,
    userId: input.userId,
  });

  // THE GOODS LEAVE THE SHELF HERE.
  //
  // This is the door-side settlement, and until now it was the one delivery
  // path that never drew stock down. The manual transition
  // (`/api/orders/[id]/shipping`) consumes; this one wrote the order, the
  // lines and the money and left every batch untouched — so a parcel handed
  // over at the door stayed on the shelf for ever. Nothing caught it later
  // either: the statement sweep only promotes orders still in flight
  // (`SHIPPED`, `OUT_FOR_DELIVERY`, `READY_FOR_PICKUP`), and an order
  // settled here is past all three.
  //
  // The FULL ordered quantity is consumed, not the delivered quantity —
  // every unit left the warehouse, including the refused ones, which are in
  // the courier's van. They come back onto the shelf when the returns desk
  // counts them in, never before. That is the same arithmetic the manual
  // path uses, so the two agree.
  //
  // Nothing taken is the one case that consumes nothing: the parcel is
  // coming back whole, and it was never consumed to begin with.
  if (!nothingTaken) {
    await consumeOrderStock(tx, {
      orderId: order.id,
      companyId: input.companyId,
      userId: input.userId,
    });
  }

  /**
   * AND THE SENTENCE GOES WHERE SENTENCES GO.
   *
   * The note typed at the door was written into the delivery attempt and
   * into this activity's metadata, and into nothing a person reads. The
   * order's own note thread — the one every screen shows and the one the
   * confirmation team, the returns desk and the owner all open — never saw
   * it. So «العميل رفض القطعة الثانية لأنّ اللون غير المطلوب» was recorded
   * in three machine places and no human one.
   *
   * It is the follow-up agent speaking, so it is an internal note on the
   * order, in the same transaction as the outcome it explains: a note that
   * survives while the delivery it describes rolls back would be a note
   * about something that never happened.
   */
  if (input.note?.trim()) {
    await tx.orderNote.create({
      data: {
        companyId: input.companyId,
        orderId: order.id,
        authorId: input.userId,
        kind: 'internal',
        body: `${DOOR_OUTCOME_AR[status] ?? status}: ${input.note.trim()}`,
      },
    });
  }

  await tx.orderActivity.create({
    data: {
      companyId: input.companyId,
      orderId: order.id,
      userId: input.userId,
      action: 'PARTIAL_DELIVERY_RECORDED',
      newStatus: status,
      metadata: JSON.stringify({
        // What we EXPECT the courier to remit for this parcel. The figure
        // that lands on the order comes from their statement.
        expectedCollection: collectedAmount,
        deliveredValue,
        // Named, so an upsold parcel's figure can be read back apart from
        // the lines somebody actually counted at the door.
        addOnValue,
        deliveryFee: chargedFee,
        feeChargedInFull: !nothingTaken,
        linesDelivered,
        linesReturned,
        note: input.note ?? null,
      }),
    },
  });

  const deliveredUnits = updates.reduce((sum, u) => sum + u.deliveredQty, 0);
  const refusedUnits = updates.reduce((sum, u) => sum + u.returnedQty, 0);

  return {
    status,
    collectedAmount,
    deliveredValue,
    addOnValue,
    deliveryFee: chargedFee,
    returnedUnits,
    linesDelivered,
    linesReturned,
    deliveredUnits,
    refusedUnits,
    // No receipt can exist yet: the refused units are in the van, and the
    // returns desk counts them in later. Saying so here is what turns «سُلّم
    // جزئياً» from an end state into the first of two.
    completion: completionOf({
      deliveredUnits,
      refusedUnits,
      settlementStatus: order.settlementStatus,
      hasReturnReceipt: false,
    }),
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * THE ORDER IS SETTLED TWICE.
 *
 *   «بصير الطلب بيتمم مرتين — مرة بيتمم للمستلم ومرة للطلب الراجع. واذا
 *    اتمم واحد فهو اتمم جزءي، ما بنغلق غير كامل»
 *
 * A partial delivery splits one order into two obligations, settled by two
 * different people, on two different days, out of two different facts:
 *
 *   MONEY — what the customer kept. Settled when the courier's statement
 *           lands and the collection is recorded.
 *   GOODS — what the customer refused. Settled when the returns desk counts
 *           the units in and puts the sound ones back on a shelf.
 *
 * Neither half knew about the other, and nothing in the system did. The door
 * writes PARTIALLY_DELIVERED; `order-state.ts` maps that state to the CLOSED
 * zone; so an order with units still in a courier's van and money still in
 * his pocket read, everywhere, as finished. The returns desk's own branch in
 * `/api/ops/returns` is careful NOT to rewrite the status — correctly,
 * because stamping RETURNED would erase the delivery — but that left the
 * completion of the first half recorded nowhere at all.
 *
 * So completion is DERIVED, never stored. That is this repository's rule for
 * the zone and for the core state, and for the same reason: a fourth column
 * drifts from the facts it summarises, and then nobody can say which of them
 * is lying. The facts are the delivered units, the settlement status, and
 * whether a return receipt exists.
 * ───────────────────────────────────────────────────────────────────── */

/** The per-line facts both halves are read from. Any OrderItem row fits. */
export interface SettledLineFacts {
  itemId?: string;
  id?: string;
  productId?: string;
  productName?: string;
  quantity: number;
  freeQuantity: number;
  /** Units the customer kept. Null until the door settled the parcel. */
  deliveredQty?: number | null;
}

export interface SettledLine {
  itemId: string;
  productId: string;
  productName: string;
  /** Units that left the warehouse on this line — gift units included. */
  shipped: number;
  /** Units the customer kept, or null while the door has not spoken. */
  delivered: number | null;
  /** Units owed back to a shelf: shipped minus delivered. */
  expectedBack: number;
}

/**
 * WHICH PRODUCT, HOW MANY TAKEN, HOW MANY COMING BACK — per line.
 *
 *   «شو المنتج الي استلمو وكم قطعة وشو الي رجع»
 *
 * The door records this per line already. The returns desk could not read
 * it: its screen listed every line at the full shipped quantity, so a clerk
 * holding one refused unit was told to expect three, and the one figure that
 * was right — the total in the next column — contradicted the list beside it.
 */
export function settledLines(items: SettledLineFacts[]): SettledLine[] {
  return items.map((i) => {
    const shipped = i.quantity + i.freeQuantity;
    const delivered = i.deliveredQty ?? null;
    return {
      itemId: i.itemId ?? i.id ?? '',
      productId: i.productId ?? '',
      productName: i.productName ?? '',
      shipped,
      delivered,
      // A line the door never spoke about owes the whole parcel back: that
      // is the announced-return case, where nothing was handed over.
      expectedBack: Math.max(0, shipped - (delivered ?? 0)),
    };
  });
}

/**
 * How many units are actually coming back.
 *
 * The whole parcel, LESS whatever the customer kept at the door. Counting
 * the full ordered quantity made every partial return read as a shortage —
 * two units "missing" that the customer is holding and has paid for — and
 * put that shortfall on the courier's record for goods he delivered right.
 *
 * The returns route held its own copy of this sum. One rule, one place: the
 * route and the screen now read the same arithmetic, so the list of lines
 * and the total above it cannot disagree again.
 */
export function expectedBackTotal(items: SettledLineFacts[]): number {
  return settledLines(items).reduce((sum, l) => sum + l.expectedBack, 0);
}

/** Units kept and units refused, and whether the door spoke at all. */
export function doorUnits(items: SettledLineFacts[]): {
  delivered: number;
  refused: number;
  recorded: boolean;
} {
  const lines = settledLines(items);
  return {
    delivered: lines.reduce((sum, l) => sum + (l.delivered ?? 0), 0),
    refused: lines.reduce((sum, l) => sum + l.expectedBack, 0),
    // Null everywhere means no door settlement yet — an announced return,
    // not a customer who refused every unit.
    recorded: items.some((i) => i.deliveredQty != null),
  };
}

export type HalfKey = 'MONEY' | 'GOODS';

export interface DeliveryHalf {
  key: HalfKey;
  /** Arabic, Western digits — the screen prints this as it stands. */
  label: string;
  settled: boolean;
  /** Units this half is about. */
  units: number;
}

export interface Completion {
  /** Only the halves this order actually has. A full delivery has one. */
  halves: DeliveryHalf[];
  settledCount: number;
  /** «اتمم واحد فهو اتمم جزءي» — none of them, some, or all. */
  degree: 'NONE' | 'PARTIAL' | 'FULL';
  /** «ما بنغلق غير كامل» — the only thing allowed to close an order. */
  complete: boolean;
  awaiting: HalfKey[];
  label: string;
}

/**
 * Settlement states after which no money is outstanding.
 *
 * These are exactly the terminal states of `SETTLEMENT_TRANSITIONS` in
 * finance-workflow.ts: the money has arrived, gone back, or been written
 * off, and no further transition is offered from any of them.
 *
 * PARTIALLY_SETTLED is deliberately not one, and neither is
 * PENDING_COLLECTION — every live order in this database sits in that
 * second one. A partly-paid half is «اتمم جزءي», which is precisely the
 * state the owner's rule refuses to call closed.
 */
export const MONEY_RESOLVED = ['SETTLED', 'REFUNDED', 'CANCELLED'] as const;

const HALF_LABEL: Record<HalfKey, string> = {
  MONEY: 'تحصيل مال ما استلمه العميل',
  GOODS: 'استلام الراجع وعدّه في المستودع',
};

/**
 * Is this order finished — both halves of it?
 *
 * Pure, so the route that writes the receipt and the screen that shows the
 * row answer identically. It is fed units and the settlement status, and
 * NOT the shipping status: a courier feed can write the word
 * PARTIALLY_DELIVERED without ever recording a line, and then the units that
 * word implies do not exist and neither half can be checked.
 */
export function completionOf(order: {
  /** Units the customer kept. */
  deliveredUnits: number;
  /** Units refused at the door and owed back to a shelf. */
  refusedUnits: number;
  settlementStatus: string;
  /** Has the returns desk counted the refused units in? */
  hasReturnReceipt: boolean;
}): Completion {
  const halves: DeliveryHalf[] = [];

  // The MONEY half exists because UNITS were handed over, not because a
  // value was computed: a parcel of gift units is worth nothing, still owes
  // the delivery fee, and the courier is still holding that fee.
  if (order.deliveredUnits > 0) {
    halves.push({
      key: 'MONEY',
      label: HALF_LABEL.MONEY,
      settled: (MONEY_RESOLVED as readonly string[]).includes(order.settlementStatus),
      units: order.deliveredUnits,
    });
  }
  if (order.refusedUnits > 0) {
    halves.push({
      key: 'GOODS',
      label: HALF_LABEL.GOODS,
      settled: order.hasReturnReceipt,
      units: order.refusedUnits,
    });
  }

  const settledCount = halves.filter((h) => h.settled).length;
  const awaiting = halves.filter((h) => !h.settled).map((h) => h.key);
  const complete = halves.length > 0 && settledCount === halves.length;
  const degree: Completion['degree'] =
    halves.length === 0 || settledCount === 0 ? 'NONE' : complete ? 'FULL' : 'PARTIAL';

  const label =
    halves.length === 0
      ? 'لم يُسجَّل تسليم على الباب بعد'
      : complete
        ? halves.length === 2
          ? 'مكتمل — المستلَم والراجع كلاهما مُسوَّى'
          : 'مكتمل'
        : `تمّ ${settledCount} من ${halves.length} — بانتظار ${awaiting.map((k) => HALF_LABEL[k]).join(' و')}`;

  return { halves, settledCount, degree, complete, awaiting, label };
}

/**
 * Does this order need the extra question at all?
 *
 *   «إذا الأوردر فيه أكثر من كمية واستلم أو رفض قطعة»
 *
 * Two clauses, and ONE test covers both: a parcel with some units kept and
 * some refused necessarily held more than one unit. A separate «شُحن أكثر من
 * واحد» check was written here first and then deleted — a mutation that
 * broke it changed nothing, which is how it was found to be unreachable, and
 * an unreachable guard is a second rule that only looks like it is working.
 *
 * So the single-unit parcel is excluded by arithmetic rather than by a
 * clause: it was taken or it was not, one yes/no answers it, and there is no
 * second half to ask about. A parcel of three that came back whole is a
 * plain return and is excluded the same way. The question exists for the
 * case in between, and in this database that case is 48 of 171 orders — 41
 * lines of 3 units and 7 of 2.
 */
export function needsExtraAction(items: SettledLineFacts[]): boolean {
  const units = doorUnits(items);
  return units.recorded && units.delivered > 0 && units.refused > 0;
}

/**
 * THE EXTRA ACTION.
 *
 *   «إذا الأوردر فيه أكثر من كمية واستلم أو رفض قطعة، حط إجراء إضافي مثل:
 *    هل الطلب استلم؟ نعم / لا»
 *
 * An order of three units that came back as two-kept-one-refused cannot be
 * answered by the single yes/no the tracking screen offers. It needs a second
 * one, asked later, about the half that is still open — and the words have to
 * be the same in the screen that asks it and the route that records the
 * answer, which is why they live here and not in either.
 *
 * THE CALLER NAMES ITS HALF. This picked the first open half instead, and
 * that is wrong for every screen that owns one: the returns desk was handed
 * the money question, because MONEY happens to be pushed first. A desk asks
 * about the half it is standing at, and gets nothing back when that half is
 * already settled — which is also how it knows not to ask.
 */
export function extraAction(
  completion: Completion,
  half: HalfKey
): { key: HalfKey; question: string; yes: string; no: string } | null {
  if (!completion.awaiting.includes(half)) return null;
  return half === 'GOODS'
    ? {
        key: 'GOODS',
        question: 'هل رجعت القطع المرفوضة إلى المستودع؟',
        yes: 'نعم — عددتها واستلمتها',
        no: 'لا — لم تصل بعد',
      }
    : {
        key: 'MONEY',
        question: 'هل وصل مال ما استلمه العميل؟',
        yes: 'نعم — حُصِّل',
        no: 'لا — بانتظار كشف شركة الشحن',
      };
}
