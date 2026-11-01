import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { drawDownStock, onHandTotal } from './receiving';
import { roundMinor } from './money';
import { fixedCostsOf } from './product-fixed-cost';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * WHERE A RESERVATION BECOMES A SALE.
 *
 * Confirming an order reserves units; delivering it was supposed to consume
 * them. It never did. The reservation was released the moment the order left
 * the open set, the batch kept its full remainder, and the unit quietly
 * returned to the sellable pool — so the same unit could be sold again, and
 * again. On this database: 115 delivered orders, 173 units handed to
 * customers, and every batch still reading 0 sold.
 *
 * Two rules hold everything together:
 *
 *   Units live in batches. A ledger line that does not move a batch moves
 *   nothing — it only makes the ledger disagree with the shelf.
 *
 *   Consuming twice is worse than not consuming. Couriers retry, webhooks
 *   redeliver, and a human presses the button again; so consumption is keyed
 *   to the order and asks the ledger before it touches anything.
 */

/** A movement of this type carrying this orderId means the order is settled. */
const SALE = 'SALE';
const RETURN = 'RETURN';

export interface ConsumptionResult {
  /** Units actually taken out of batches. */
  taken: number;
  /** Units the order needed that no batch could supply. */
  short: number;
  /** True when a previous call had already done the work. */
  alreadyDone: boolean;
  /**
   * What those units cost, from the batches they actually came out of — the LEDGER's figure. The ORDER's own cost of goods may be
   * written differently: a product with a fixed figure costs the order the figure × the units (see the end of `consumeOrderStock`).
   */
  cost: number;
  /** Its goods left before the store's opening count — see outsideTheCount. */
  outsideTheCount?: boolean;
  /** The lines whose shelf could not cover them, so the caller can say which. Absent when none was short. */
  shortLines?: { productId: string; productName: string; need: number; taken: number; short: number }[];
}

/** The review mark a delivery leaves on an order whose shelf could not cover it. */
export const STOCK_SHORT_ACTION = 'STOCK_SHORT_AT_DELIVERY';

/** The mark the legacy import (scripts/migration) writes on every order. */
export const LEGACY_IMPORT_SOURCE = 'Legacy import';

/**
 * GOODS THAT LEFT BEFORE THE OPENING COUNT WERE NEVER IN IT.
 *
 * The owner's count of the Syria shelf (2026-10-21) was taken after 143
 * imported orders had already gone out with the courier: «طلعت قبل الجرد».
 * Delivering one of them must not take its units out of that count a
 * second time, and when one comes BACK its units are new to the shelf —
 * so it is restored even though no SALE was ever written for it.
 *
 * The test is not «imported», because 39 imported orders were still
 * postponed with their goods on the shelf, and one of them confirmed later
 * is an ordinary order. It is «imported AND never reserved a unit»: every
 * order that leaves through this system reserves at confirmation (no
 * unreserved line reaches READY_TO_SHIP), and the orders imported after
 * the count are imported holding their reservation. So the only orders
 * this answers yes for are the ones that left before anything here held
 * their stock.
 */
export function outsideTheCount(order: {
  source?: string | null;
  items: { reservedQty?: number | null }[];
}): boolean {
  return order.source === LEGACY_IMPORT_SOURCE && order.items.every((i) => (i.reservedQty ?? 0) === 0);
}

/**
 * Has this order already moved stock in this direction?
 *
 * The check is the ledger itself rather than a flag on the order, because the
 * ledger is what the stock figures are reconciled against; a flag can drift
 * from it, and then nobody can tell which one is lying.
 */
async function alreadyMoved(tx: Tx, orderId: string, type: string): Promise<boolean> {
  const seen = await tx.inventoryMovement.findFirst({
    where: { referenceId: orderId, type },
    select: { id: true },
  });
  return seen !== null;
}

/**
 * Take an order's goods out of stock, oldest batch first.
 *
 * Runs inside the caller's transaction so the units leave stock in the same
 * commit that marks the order delivered — there is no window in which the
 * order is delivered and the goods are still for sale.
 *
 * ── A DELIVERY IS A FACT, AND THE SHELF FOLLOWS IT (P0-13, 30/10) ──
 *
 * This takes no `allowNegativeStock` and never refuses. The country's flag
 * answers «may we PROMISE what the shelf does not hold», and it is asked
 * where the promise is made — confirming an order and creating its shipment
 * (`reservation.ts`). By the time a parcel is DELIVERED the goods are in the
 * customer's hands: refusing to record it leaves a delivered order that the
 * system calls open, a courier statement that cannot be approved, and money
 * the customer already paid with no door to book it through.
 *
 * Until now the doors gave this one event three different rules — the
 * country's flag at the manual transition, the order edit and the write-off;
 * `false` at the door-side delivery; a hand-written `true` at the courier
 * statement and the parcel swap — so the SAME delivery was recorded or
 * refused by whichever door happened to see it first. The rule lives here,
 * once, and a door cannot hand it a different one.
 *
 * What a short shelf does: the units it holds leave it (never below zero),
 * the rest are reported in the result and written as ONE review line on the
 * order (`STOCK_SHORT_AT_DELIVERY`), and no money is written for them — a
 * shortfall priced at the last batch would invent cost for goods the books
 * never held. Making the books agree is the stocktake's job, with a reason.
 */
export async function consumeOrderStock(
  tx: Tx,
  input: { orderId: string; companyId: string; userId?: string | null }
): Promise<ConsumptionResult> {
  if (await alreadyMoved(tx, input.orderId, SALE)) {
    return { taken: 0, short: 0, alreadyDone: true, cost: 0 };
  }
  /*
   * AN ORDER DELIVERED ON A SHELF THAT HELD NOTHING WROTE NO SALE LINE — there was nothing to move — so the key above
   * cannot see it. Its review line is the proof it was already consumed; without this, a second press after new
   * stock arrived would take that stock for a delivery that had already been recorded.
   */
  const reviewed = await tx.orderActivity.findFirst({
    where: { orderId: input.orderId, companyId: input.companyId, action: STOCK_SHORT_ACTION },
    select: { id: true },
  });
  if (reviewed) return { taken: 0, short: 0, alreadyDone: true, cost: 0 };

  const order = await tx.order.findFirst({
    where: { id: input.orderId, companyId: input.companyId },
    select: {
      orderNumber: true,
      // WHICH SHELF THESE UNITS LEAVE. Availability and reservation are both
      // store-scoped; this draw-down was not, so an order could be promised
      // from its own store's shelf and served out of another's.
      storeId: true,
      source: true,
      items: {
        select: { productId: true, productName: true, quantity: true, freeQuantity: true, reservedQty: true },
      },
      // The add-ons the customer accepted after ordering leave in the same parcel — see the loop below.
      addOns: { select: { productId: true, productName: true, quantity: true } },
      // The currency's minor unit, read from the order rather than asked of
      // the caller: it is a property of the order, and four callers would
      // otherwise each have to find it and could each find a different one.
      store: { select: { country: { select: { minorUnit: true } } } },
    },
  });
  if (!order) return { taken: 0, short: 0, alreadyDone: false, cost: 0 };
  if (outsideTheCount(order)) return { taken: 0, short: 0, alreadyDone: false, cost: 0, outsideTheCount: true };
  const minorUnit = order.store?.country?.minorUnit ?? 2;

  let taken = 0;
  let short = 0;
  let cost = 0;
  const shortLines: NonNullable<ConsumptionResult['shortLines']> = [];

  /*
   * THE ADD-ONS LEAVE IN THE SAME PARCEL.
   *
   * «الأب سيل والكروس سيل … المخزون ح يتأثر». The offer accepted after the order and a recommended product are goods
   * the courier hands over with the rest; they were charged (`computeCod` carries them) and never drawn down, so the
   * shelf kept units that were sold. They are lines here, with no gift units — an add-on has none (`offers.ts`).
   */
  const lines = [
    ...order.items,
    ...(order.addOns ?? []).map((a) => ({ productId: a.productId, productName: a.productName, quantity: a.quantity, freeQuantity: 0 })),
  ];
  /*
   * THE FIXED FIGURES OF EVERY PRODUCT IN THE PARCEL, READ ONCE (the owner, 1/11: «ثابت لكل الطلبات وما يتغير تحت اي ظرف»).
   *
   * They decide only what the ORDER's cost of goods is written as, below. The shelf does not read them: the draw-down, the SALE
   * movements, the batches' costs and the value of the stock are the ledger's, and a figure never reaches them.
   */
  const figures = await fixedCostsOf(tx, input.companyId, [...new Set(lines.map((l) => l.productId))]);
  let orderCost = 0;
  for (const line of lines) {
    // The gift units are goods too. Leaving them in stock is how a shelf
    // ends up holding inventory that was given away.
    const need = line.quantity + line.freeQuantity;
    if (need <= 0) continue;

    const result = await drawDownStock(tx, {
      companyId: input.companyId,
      storeId: order.storeId,
      productId: line.productId,
      quantity: need,
      // The delivery happened. The draw takes what the shelf holds and reports the rest — see above.
      allowNegative: true,
    });
    taken += result.taken;
    short += result.short;
    cost += result.cost;
    /*
     * WHAT THIS LINE COSTS THE ORDER: the figure × the units that really left when the product has one — ZERO is a figure, so
     * `!== undefined` and never a truthiness test — otherwise what the batches it came out of say, as it always was. The same
     * units, two prices: the ledger keeps the batches', the order keeps the owner's.
     */
    const figure = figures.get(line.productId);
    orderCost += figure !== undefined ? figure * result.taken : result.cost;
    if (result.short > 0) {
      shortLines.push({ productId: line.productId, productName: line.productName, need, taken: result.taken, short: result.short });
    }

    if (result.taken > 0) {
      await tx.inventoryMovement.create({
        data: {
          companyId: input.companyId,
          /*
           * THE SAME SHELF THE UNITS LEFT, written onto the ledger line too.
           *
           * `drawDownStock` above is handed `order.storeId` and takes the
           * units out of THAT store's batches. This row says how the
           * balance got that way, and it was written with no store at all —
           * so `/api/inventory/movements` and the ledger block in
           * `/api/inventory`, which both filter the movement with the strict
           * `inStore(companyId, storeId)`, returned nothing in any store.
           * Twenty-six live SALE rows on this database, the whole sale half
           * of a ledger that existed and could not be read.
           *
           * There is no second candidate: this is the value the draw-down
           * used, so the line and the batches it emptied cannot disagree.
           * Null when the order has no store, which is the convention
           * `onHand` and `drawDownStock` already keep.
           */
          storeId: order.storeId,
          productId: line.productId,
          type: SALE,
          quantity: -result.taken,
          balanceAfter: await onHandTotal(tx, input.companyId, line.productId),
          referenceId: input.orderId,
          reason: `تسليم الطلب ${order.orderNumber}`,
          createdById: input.userId ?? null,
        },
      });
    }
  }

  // The reservation has served its purpose: the units are gone, not held.
  await tx.orderItem.updateMany({
    where: { orderId: input.orderId, reservedQty: { gt: 0 } },
    data: { reservedQty: 0 },
  });
  await tx.orderAddOn.updateMany({
    where: { orderId: input.orderId, reservedQty: { gt: 0 } },
    data: { reservedQty: 0 },
  });

  /*
   * WHAT IT ACTUALLY COST, WRITTEN DOWN AT THE ONE MOMENT IT IS KNOWN.
   *
   * `estimatedCostOfGoods` is stamped when the order is WRITTEN, from a
   * weighted average of what happens to be on the shelf then — and it is
   * zero whenever the product had no costed batch at that moment, which
   * is every product imported before its first production run. Every
   * margin in the product is built on that figure.
   *
   * Here the goods have left, and the batches they left say what they
   * cost. `product-cost.ts` already describes exactly this — «the
   * CONSUMED cost… the figure that belongs in a closed order's profit» —
   * and nothing was recording it.
   *
   * The name stays `estimatedCostOfGoods` because thirteen readers use
   * it and renaming a column is not what this is. After delivery it is
   * no longer an estimate.
   *
   * AND NEVER WHEN ANYTHING WAS SHORT (P0-13 review). Cost over the units that
   * left is a cost of PART of the parcel: 4 of 10 units at 5 is 20 written over
   * an estimate of 50 for the whole order, and the profit rises by 30 on goods
   * that were all handed over. A short order keeps its estimate — the guess
   * about the whole parcel is closer than a true figure about part of it.
   *
   * Only when something was actually drawn: an order served from an
   * empty shelf (negative stock allowed) took no money out of any batch,
   * and writing zero over the estimate would be replacing a guess with a
   * falsehood.
   *
   * ── AND A PRODUCT WITH A FIXED FIGURE IS NOT COSTED BY THE BATCHES AT ALL (the owner, 1/11) ──
   *
   * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… ثابت لكل الطلبات». The complaint was exactly this overwrite: the cost struck when the
   * order was raised and the cost struck here, from whichever batches happened to be oldest, were two different numbers for one
   * order. A line whose product has a figure is written as the figure × the units that left (`orderCost`); the lines without one
   * are written as the batches priced them. Every rule above stands as it was: only when something left and nothing was short, and
   * never twice. An order already delivered is not read again, so an old delivery keeps the cost it was written with.
   */
  if (taken > 0 && short === 0) {
    await tx.order.update({
      where: { id: input.orderId },
      // Rounded by the CURRENCY. Two decimals here was the same defect found
      // in four other files today, spelled differently — `Math.round(x * 100)
      // / 100` instead of `.toFixed(2)` — which is why the sweep that caught
      // those walked past this one. JOD has three.
      data: { estimatedCostOfGoods: roundMinor(orderCost, minorUnit) },
    });
  }

  /*
   * THE SHORTFALL IS SAID, ONCE, ON THE ORDER — in the transaction that
   * delivered it, so the line cannot outlive a delivery that rolled back.
   * Units and products only: no price, no wallet, no ledger line. The
   * reader of this is whoever reviews stock.
   */
  if (shortLines.length > 0) {
    await tx.orderActivity.create({
      data: {
        companyId: input.companyId,
        orderId: input.orderId,
        userId: input.userId ?? null,
        action: STOCK_SHORT_ACTION,
        metadata: JSON.stringify({ order: order.orderNumber, short, lines: shortLines }),
      },
    });
  }

  return { taken, short, alreadyDone: false, cost: roundMinor(cost, minorUnit), ...(shortLines.length ? { shortLines } : {}) };
}

/**
 * WHAT THE DAMAGED UNITS COST, CARRIED BY THE ONES THAT SURVIVED.
 *
 * «إذا في توالف (تالف) لازم تنقص من المخزون بس داخلة ضمن التكلفة تبع
 * المخزون للمنتج» — the owner's ruling, and it is not the obvious one.
 *
 * The obvious treatment writes the damaged units off: the shelf loses four
 * units and the business books their cost as a loss. That is what a
 * factory's accounts do. This shop is not asking for that. It is saying the
 * money is already spent on this product and must stay ON it — so the units
 * still on the shelf are what it has to be earned back from. Twelve
 * survivors of a run of sixteen each carry a sixteenth of the run, not a
 * twelfth, and a price set from that cost is the one that actually recovers
 * the money.
 *
 * So nothing is written off and nothing is invented: the SAME total money
 * goes back into stock over FEWER units, and the unit cost rises by exactly
 * the ratio between them.
 *
 * AND WHEN NOTHING CAME BACK SOUND, NOTHING CAN CARRY IT. A parcel whose
 * every unit is damaged leaves no survivor to absorb anything, and inventing
 * a unit to hold the cost would be inventing stock. That case returns zero
 * and says so, rather than quietly pushing the cost onto another batch.
 *
 * Pure, so the arithmetic can be read and tested without a database.
 */
export interface AbsorbedDamage {
  /** Units that go back on the shelf — the sound ones, never the damaged. */
  quantity: number;
  /** The money those units carry, including the damaged ones' share. */
  totalCost: number;
  /** What one surviving unit now costs. */
  costPerUnit: number;
  /** The money moved off the damaged units and onto the survivors. */
  absorbed: number;
}

/**
 * `minorUnit` DEFAULTS TO TWO, AND THAT DEFAULT IS FOR A CALLER WITHOUT A
 * CURRENCY — NOT A GUESS ABOUT THE MONEY.
 *
 * `costPerUnit` here is WRITTEN, onto a production batch, so two decimals was
 * the same defect found in five other files today: JOD has three, and a fils
 * was dropped from the cost every returned parcel put back on the shelf.
 */
export function absorbDamaged(input: {
  sound: number;
  damaged: number;
  costPerUnit: number;
  minorUnit?: number;
}): AbsorbedDamage {
  const sound = Math.max(0, Math.trunc(input.sound));
  const damaged = Math.max(0, Math.trunc(input.damaged));
  const cost = Number.isFinite(input.costPerUnit) && input.costPerUnit > 0 ? input.costPerUnit : 0;
  const unit = input.minorUnit ?? 2;
  if (sound <= 0) return { quantity: 0, totalCost: 0, costPerUnit: 0, absorbed: 0 };
  const totalCost = roundMinor(cost * (sound + damaged), unit);
  return {
    quantity: sound,
    totalCost,
    costPerUnit: roundMinor(totalCost / sound, unit),
    absorbed: roundMinor(cost * damaged, unit),
  };
}

/**
 * Put returned goods back on the shelf.
 *
 * The returns screen already wrote a RETURN line to the ledger — and stopped
 * there, so the ledger said the goods were back while no batch had gained a
 * single unit and the shipment screen still reported a shortage. Units go
 * into a batch of their own, at the cost they left at, so a return cannot
 * quietly rewrite the cost of goods on stock that never moved.
 */
export async function restoreOrderStock(
  tx: Tx,
  input: {
    orderId: string;
    companyId: string;
    /** Units confirmed sound after counting — never the shipped quantity. */
    receivedQty: number;
    /** Units that came back broken. They do not return to stock; their cost does. */
    damagedQty?: number;
    userId?: string | null;
  }
): Promise<{ restored: number; alreadyDone: boolean; neverConsumed?: boolean; absorbed?: number }> {
  if (input.receivedQty <= 0) return { restored: 0, alreadyDone: false };
  if (await alreadyMoved(tx, input.orderId, RETURN)) {
    return { restored: 0, alreadyDone: true };
  }

  // NOTHING COMES BACK THAT NEVER LEFT.
  //
  // Consumption happens at DELIVERY, not at dispatch — so an order refused
  // at the door, or cancelled in transit, never took its units out of any
  // batch. Putting them "back" then does not restore stock, it INVENTS it:
  // a brand-new batch of units the shelf already holds, and the figure
  // climbs by the whole parcel every time one comes back undelivered.
  //
  // The ledger is the authority, not the order's status, for the same
  // reason `alreadyMoved` is: a status can be rewritten by a later path,
  // and then nobody can tell which of the two is lying.
  //
  // The one exception is an order whose goods left before the opening count
  // (outsideTheCount): it never wrote a SALE because the count never held
  // its units, so what comes back IS new to the shelf.
  if (!(await alreadyMoved(tx, input.orderId, SALE))) {
    const before = await tx.order.findFirst({
      where: { id: input.orderId, companyId: input.companyId },
      select: { source: true, items: { select: { reservedQty: true } } },
    });
    if (!before || !outsideTheCount(before)) {
      return { restored: 0, alreadyDone: false, neverConsumed: true };
    }
  }

  const order = await tx.order.findFirst({
    where: { id: input.orderId, companyId: input.companyId },
    select: {
      orderNumber: true,
      /*
       * WHICH SHELF THEY COME BACK TO.
       *
       * The returned batch was created with no `storeId` at all, so the units
       * landed in the company-wide pile — invisible to the store-scoped
       * `onHand` the store's own availability reads. The goods were restored
       * and were never sellable again by the store that lost them.
       */
      storeId: true,
      items: { select: { productId: true, quantity: true, freeQuantity: true } },
      // Counted back in after the lines: they left in the same parcel (`consumeOrderStock`).
      addOns: { select: { productId: true, quantity: true } },
      // Read from the order for the same reason `consumeOrderStock` reads it:
      // the currency is the order's, and asking each caller to find it is how
      // two of them find different answers.
      store: { select: { country: { select: { minorUnit: true } } } },
    },
  });
  if (!order) return { restored: 0, alreadyDone: false };
  const restoreUnit = order.store?.country?.minorUnit ?? 2;

  let remaining = input.receivedQty;
  let restored = 0;
  let absorbedTotal = 0;
  // The damaged units belong to whichever line they were counted from, and
  // the counting does not say which. They are shared out in the same
  // proportion as the sound ones: exact on a single-line order, and the only
  // defensible split on any other.
  let damagedLeft = Math.max(0, Math.trunc(input.damagedQty ?? 0));
  const soundTotal = input.receivedQty;

  const returnLines = [...order.items, ...(order.addOns ?? []).map((a) => ({ productId: a.productId, quantity: a.quantity, freeQuantity: 0 }))];
  for (const line of returnLines) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, line.quantity + line.freeQuantity);
    if (take <= 0) continue;
    remaining -= take;

    // What did this unit cost when it left? Its own batches are the honest
    // answer, and a return at an invented cost silently moves the profit.
    const lastCost = await tx.productionBatch.findFirst({
      // The store's own last cost. Another store's batch is another shelf's
      // money, and a return priced off it moves this store's profit.
      where: {
        companyId: input.companyId,
        productId: line.productId,
        ...(order.storeId ? { storeId: order.storeId } : {}),
      },
      orderBy: { productionDate: 'desc' },
      select: { costPerUnit: true },
    });
    const costPerUnit = lastCost?.costPerUnit ?? 0;

    // This line's share of the damage, with the last line to take units
    // absorbing whatever the rounding left, so no unit's cost is dropped.
    const share = soundTotal > 0 ? Math.round(damagedLeft * (take / soundTotal)) : 0;
    const damagedHere = remaining <= 0 ? damagedLeft : Math.min(damagedLeft, share);
    damagedLeft -= damagedHere;
    const carried = absorbDamaged({ sound: take, damaged: damagedHere, costPerUnit, minorUnit: restoreUnit });
    absorbedTotal += carried.absorbed;

    const batch = await tx.productionBatch.create({
      data: {
        companyId: input.companyId,
        // Back onto the shelf it left, not into the company-wide pile.
        storeId: order.storeId,
        productId: line.productId,
        batchNumber: `RET-${order.orderNumber}-${line.productId.slice(0, 6)}`,
        quantityProduced: take,
        quantityRemaining: take,
        quantitySold: 0,
        manufacturingCost: 0,
        totalProductionCost: carried.totalCost,
        costPerUnit: carried.costPerUnit,
        productionDate: new Date(),
        notes:
          damagedHere > 0
            ? `مرتجع الطلب ${order.orderNumber} — بعد العد والفحص. ${damagedHere} تالفة لا تعود للرفّ وكلفتُها محمولةٌ على ${take} السليمة`
            : `مرتجع الطلب ${order.orderNumber} — بعد العد والفحص`,
        status: 'COMPLETED',
      },
    });

    await tx.inventoryMovement.create({
      data: {
        companyId: input.companyId,
        /*
         * ONTO THE SHELF THE BATCH ABOVE WENT, not into the company-wide
         * pile. The batch at hand was created with `storeId: order.storeId`
         * under «back onto the shelf it left» and this line — the ledger's
         * own record of the same event — carried no store, so the restock
         * was invisible in the store's movement log while the units it
         * describes were visible on the store's shelf. Four live RETURN
         * rows. Half-fixed is not fixed.
         */
        storeId: order.storeId,
        productId: line.productId,
        batchId: batch.id,
        type: RETURN,
        quantity: take,
        balanceAfter: await onHandTotal(tx, input.companyId, line.productId),
        referenceId: input.orderId,
        reason: `مرتجع ${order.orderNumber} — بعد العد والفحص`,
        createdById: input.userId ?? null,
      },
    });

    restored += take;
  }

  return { restored, alreadyDone: false, absorbed: roundMinor(absorbedTotal, restoreUnit) };
}
