import { NextResponse } from 'next/server';
import { z } from 'zod';
import { count, money } from '@/lib/numeric-input';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { inStore } from '@/lib/store-filter';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authorization';
import { maySeeCost } from '@/lib/cost-visibility';
import { drawDownStock, onHandTotal, receiveStock } from '@/lib/receiving';
import { zodMessage } from '@/lib/zod-message';
import { resolveUnitCost } from '@/lib/unit-cost';
import { reservedElsewhere, reservedForProducts } from '@/lib/reservation';
import { MAX_WINDOW_DAYS, stockHealth, summariseStock, type StockFacts } from '@/lib/stock-health';
import { DAY_MS, deliveredPerProduct, ledgerDepthDays } from '@/lib/stock-ledger';
import { IntakePlaceRefused, intakePlace, intakeRefusalBody, storeIsPlaced } from '@/lib/warehouse-intake';
import { COUNT_MATCHES_AR, differenceWaitsAr, expectedInWarehouse, quickCountVerdict } from '@/lib/warehouse-count';
import { reachesWarehouse, warehousesOfStore, warehousesReachedBy } from '@/lib/warehouses';
import { unitsWithCourier } from '@/lib/warehouse-placement';
import { countRuns } from '@/lib/batch-grade';
import { placesOf, shownPlaces } from '@/lib/stock-places';
import type { SessionUser } from '@/types/auth';

export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.view');
    // What the goods COST is the cost key's (PR-10): the shelf and the verdict stay for the stock key.
    const showCost = maySeeCost(user);

    // This store's goods, and only this store's. Stock is the clearest case
    // of all: a count that includes another store's warehouse is not a
    // slightly wrong number, it is a number for a place you cannot ship from.
    const products = await db.product.findMany({
      where: inStore(companyId, storeId),
      include: {
        batches: {
          /*
           * OLDEST FIRST, BY THE DRAW-DOWN'S OWN ORDER (19/11, W2c). There was no order here, and `lastUnitCost` below is
           * «the last costed row of this list» — so it was whichever row Postgres happened to return last, which moves
           * when a row is updated, and after a split a twin (born later, carrying an older run's cost) could be it. With
           * the order said, «the last» is the newest by production date, as the receive door's own carry-forward reads it.
           */
          orderBy: [{ productionDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            batchNumber: true,
            quantityProduced: true,
            quantitySold: true,
            quantityRemaining: true,
            costPerUnit: true,
            // How long this product has had stock at all. The verdict «راكد»
            // needs it: goods received last week have not failed to sell,
            // they have not been offered, and charging them for it sends
            // somebody to clear a shelf that only just arrived.
            productionDate: true,
            // The warehouse plan (W2c): which run a row belongs to, and where it is. Read, never sent as they are.
            splitFromBatchId: true,
            warehouseId: true,
            inTransitTransferId: true,
          },
        },
      },
    });

    const movements = await db.inventoryMovement.findMany({
      where: inStore(companyId, storeId),
      include: {
        product: { select: { name: true, sku: true } },
        batch: { select: { batchNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    // ── WHAT EACH PRODUCT IS DOING, not merely how much of it there is ──
    //
    // The owner's ask: «تنظيم أكثر — AI + Score. ملاحظات: قارب على الانتهاء
    // يعني، ماشي بطيء… إلخ. يحتاج مخزون. تنبيهات». The verdict is computed
    // HERE as well as rendered on the screen, from the one function in
    // `stock-health`, because the alerts row is a count the server owes the
    // client — a screen that counts its own alerts from a filtered list
    // counts the page it is showing, not the store.
    const now = new Date();
    const since = new Date(now.getTime() - MAX_WINDOW_DAYS * DAY_MS);
    const [ledgerDays, delivered] = await Promise.all([
      ledgerDepthDays(companyId, storeId, now),
      deliveredPerProduct(companyId, storeId, since),
    ]);

    // RESERVED UNITS COME FROM `reservation.reservedForProducts` — ONE GROUPED
    // READ, BUILT FROM THE SAME FILTER AS THE PER-PRODUCT ONE.
    //
    // This asked `reservedElsewhere` of each product in turn on purpose: a
    // `groupBy` written HERE would have been a second copy of the "order
    // still open" predicate, in a route, beside the one in `reservation.ts`.
    // That predicate is five statuses long and it decides whether a unit may
    // be promised twice; the day somebody adds a sixth status to one copy,
    // this screen starts reporting stock that is already sold as available,
    // and it will look like working software. The price of the rule having
    // one home was 425 ms for 114 products (228 statements, at once, on the
    // main pool). The grouped read now lives in `reservation.ts` too and is
    // built from the very same `holdingWhere`, so the rule still has one home
    // and the screen asks twice instead of 228 times.
    const reserved = await reservedForProducts(db, { companyId, storeId, productIds: products.map((p) => p.id) });

    // WHERE THE UNITS ARE — only for a store placed in warehouses (W2c). A store that is not placed answers exactly as before.
    const places = (await storeIsPlaced(storeId))
      ? await storePlaces(user, companyId, storeId, products.map((p) => p.id))
      : null;

    const stockSummary = products.map((p) => {
      const produced = p.batches.reduce((sum, b) => sum + b.quantityProduced, 0);
      const sold = p.batches.reduce((sum, b) => sum + b.quantitySold, 0);
      const remaining = p.batches.reduce((sum, b) => sum + b.quantityRemaining, 0);
      // What the newest COSTED batch cost. The receiving screen needs it to
      // say what leaving the price blank will do — and, when there is none,
      // that a price has to be typed.
      const lastUnitCost =
        [...p.batches].reverse().find((b) => b.costPerUnit > 0)?.costPerUnit ?? null;

      const sales = delivered.get(p.id);
      const firstStocked = p.batches.reduce<Date | null>(
        (oldest, b) => (oldest === null || b.productionDate < oldest ? b.productionDate : oldest),
        null
      );
      const facts: StockFacts = {
        // `remaining` is the same sum `reservation.onHand` returns, taken
        // from the batches already in hand rather than asked for again.
        onHand: remaining,
        reserved: reserved.get(p.id) ?? 0,
        // Runs, not rows: a row split off when goods changed place is the same run (`batch-grade.countRuns`).
        batchCount: countRuns(p.batches),
        deliveredUnits: sales?.units ?? 0,
        deliveredLines: sales?.lines ?? 0,
        ledgerDays,
        daysSinceLastSale: sales ? Math.max(0, (now.getTime() - sales.lastAt.getTime()) / DAY_MS) : null,
        daysStocked: firstStocked ? Math.max(0, (now.getTime() - firstStocked.getTime()) / DAY_MS) : null,
      };

      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        status: p.status,
        sourceType: p.sourceType === 'PURCHASED' ? 'PURCHASED' : 'MANUFACTURED',
        produced,
        sold,
        remaining,
        /*
         * HELD FOR OPEN ORDERS, sent rather than left to be recovered.
         *
         * It was computed exactly here (from `reservedElsewhere`) and fed
         * into `stockHealth`, and then left out of this row — so the screen
         * printed «محجوز» as `remaining − health.available`. That identity
         * holds only while this row's `remaining` is the very expression
         * passed in as `facts.onHand`; with a store-wide `remaining` of 12
         * against an on-hand 8 and 5 reserved, the card printed 9.
         *
         * The screen's own header says «NOT ONE WORD OF THE VERDICT IS
         * DECIDED HERE». That was true of the verdict and not of the third
         * tile on every card.
         */
        reserved: reserved.get(p.id) ?? 0,
        batchesCount: countRuns(p.batches),
        // Omitted, not zeroed or nulled, for a caller without `costs.view`: a null says «never costed» and a zero «cost nothing».
        ...(showCost
          ? {
              lastUnitCost,
              /** Batches (runs) whose cost is zero — every unit out of them reads as pure profit. */
              zeroCostBatches: countRuns(
                p.batches,
                p.batches.filter((b) => b.costPerUnit === 0 && b.quantityRemaining > 0)
              ),
            }
          : {}),
        /** The verdict, its reason, its score and the bands behind it. */
        health: stockHealth(facts, MAX_WINDOW_DAYS),
        /**
         * Placed store only (W2c): the same units, by place — per warehouse, «بالطريق», with no place — and the units of
         * this store's orders that are out with the courier. Absent for a store that is not placed.
         */
        ...(places ? { places: shownPlaces(placesOf(p.batches, places.order), places.withCourier.get(p.id) ?? 0) } : {}),
      };
    });

    // Counted over the WHOLE store, before any search term narrows the list.
    // An alerts row that counts what is on screen tells you about your
    // filter, which is the one thing you already know.
    const summary = summariseStock(stockSummary.map((s) => s.health));

    return NextResponse.json({
      stockSummary,
      movements,
      /** How deep the delivery record is — every rate on the screen rests on it. */
      ledgerDays: Math.round(ledgerDays * 10) / 10,
      ...summary,
      /**
       * Placed store only (W2c): its warehouses, by name, for the filter and the chips — and, on each, whether THIS person
       * may receive goods into it (`reachesWarehouse`, the rule the receive door asks). Absent for a store not placed.
       */
      ...(places ? { warehouses: places.warehouses } : {}),
    });
  } catch (error: any) {
    if (error instanceof UncostedSurplus) {
      return NextResponse.json({ error: error.message, code: 'UNIT_COST_REQUIRED' }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}

/**
 * A PLACED STORE'S WAREHOUSES, AND THE UNITS OUT WITH THE COURIER (W2c) — three reads, whatever the number of products.
 *
 *   warehouses   the running warehouses of the store's country (`warehousesOfStore`, name order), then any other warehouse
 *                a batch of the store names (a stopped one cannot hold units — the stop door refuses — but a name is
 *                never left as a bare id). `mayReceive` = this person reaches it (`warehouses.reachesWarehouse`, the very
 *                rule the receive door asks) and it is running.
 *   withCourier  units of this store's orders that have left and still hold their reservation — the placement's own
 *                figure (`warehouse-placement.unitsWithCourier`), so the two screens cannot disagree.
 */
async function storePlaces(user: SessionUser, companyId: string, storeId: string, productIds: string[]) {
  const [own, withCourier, named] = await Promise.all([
    warehousesOfStore(companyId, storeId),
    unitsWithCourier(db, { companyId, storeId, productIds }),
    db.productionBatch.groupBy({
      by: ['warehouseId'],
      where: { ...inStore(companyId, storeId), warehouseId: { not: null } },
    }),
  ]);
  const ownIds = new Set(own.map((w) => w.id));
  const others = named.map((n) => n.warehouseId).filter((id): id is string => !!id && !ownIds.has(id));
  const stopped = others.length
    ? await db.warehouse.findMany({ where: { companyId, id: { in: others } }, orderBy: { name: 'asc' }, select: { id: true, name: true } })
    : [];
  const reached = new Set((await warehousesReachedBy(user, companyId, own.map((w) => ({ ...w, companyId })))).map((w) => w.id));
  const warehouses = [
    ...own.map((w) => ({ id: w.id, name: w.name, mayReceive: reached.has(w.id) })),
    ...stopped.map((w) => ({ id: w.id, name: w.name, mayReceive: false })),
  ];
  return { warehouses, order: warehouses.map((w) => w.id), withCourier };
}

/** The unit cost of this product's newest costed stock in this store, if any. */
async function previousUnitCost(companyId: string, storeId: string | null, productId: string) {
  const last = await db.productionBatch.findFirst({
    where: { ...inStore(companyId, storeId), productId, costPerUnit: { gt: 0 } },
    orderBy: { productionDate: 'desc' },
    select: { costPerUnit: true },
  });
  return last?.costPerUnit ?? null;
}

/** A recount that found units of something never costed. Carried out of the transaction. */
class UncostedSurplus extends Error {}

/**
 * POST /api/inventory — the two things a person may do to stock by hand.
 *
 * There used to be one endpoint that took a signed quantity and a movement
 * type of your choosing. It was a third door into stock beside production
 * and receiving, and the loosest of the three: it added units at a cost of
 * zero and labelled them whatever the caller said. Units at zero cost drag
 * the weighted average down, so every order costed afterwards reported a
 * profit that was never made.
 *
 * Two named actions replace it:
 *
 *   receive  — goods bought ready, at what they cost. Only for a product
 *              that is actually bought; a made one goes through a production
 *              run, where its costs are broken down.
 *
 *   recount  — what is AVAILABLE disagrees with the system. You enter what
 *              you COUNTED, not a difference, and the correction is derived.
 *              Typing a delta means doing the subtraction in your head at
 *              the exact moment you are already unsure of the number.
 *
 *              THE COUNT IS OF THE AVAILABLE, NOT OF «ON THE SHELF» (the
 *              owner, 8/11: «الجرد بدي اياه للمتاح وليس على الرف»). The shelf
 *              figure is what the batches hold, and the batches still hold
 *              the units of an order that has left in a courier's bag but
 *              not been delivered — nobody can count those on the shelf.
 *              What a person standing at the shelf counts is the free stock:
 *              the available, shelf minus what open orders hold
 *              (`reservedElsewhere`). The correction moves the shelf by the
 *              difference, so the available afterwards is what was counted.
 */
export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.adjust');

    const body = await req.json().catch(() => null);
    const parsed = z
      .discriminatedUnion('action', [
        z.object({
          action: z.literal('receive'),
          productId: z.string().min(10).max(64),
          quantity: count(1_000_000, 1),
          /**
           * NOT `.default(0)`. An empty field is not a price of zero, and
           * treating it as one is how 89 batches on this database came to
           * report every unit sold out of them as pure profit. What a blank
           * means is decided by `resolveUnitCost`, with the product's own
           * history in hand.
           */
          unitCost: money(1_000_000).optional(),
          /** Only ever read when the cost really is zero — a sample, a gift. */
          zeroCostReason: z.string().max(200).optional().nullable(),
          note: z.string().max(200).optional().nullable(),
          /**
           * The warehouse the goods landed in (the warehouse plan, W2a). Read only when the store is placed in warehouses,
           * where it is required (`warehouse-intake.intakePlace`). `.catch` because the old schema stripped any such
           * field: a body the old door accepted is never refused for it.
           */
          warehouseId: z.string().max(64).optional().nullable().catch(undefined),
        }),
        z.object({
          action: z.literal('recount'),
          productId: z.string().min(10).max(64),
          /** The AVAILABLE stock that was physically counted — what is free, not what open orders already hold. */
          countedQuantity: count(1_000_000),
          /** Why the count and the system disagree. Never optional. */
          reason: z.string().min(3).max(200),
          /**
           * The warehouse that was counted (the warehouse plan, W2b). Read only for a store placed in warehouses, where it
           * is required and the count is of what is PHYSICALLY there. `.catch`: a body the old door accepted is never refused for it.
           */
          warehouseId: z.string().max(64).optional().nullable().catch(undefined),
        }),
      ])
      .safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }
    const input = parsed.data;

    const product = await db.product.findFirst({
      // Found, or not found. A product of another store is not refused
      // here — it is simply not a product this caller can name.
      where: { id: input.productId, ...inStore(companyId, storeId) },
      select: { id: true, name: true, sourceType: true },
    });
    if (!product) {
      return NextResponse.json({ error: 'المنتج غير موجود في شركتك' }, { status: 404 });
    }

    if (input.action === 'receive') {
      // A made product priced as a purchase loses its cost breakdown, and
      // the production reports then describe a run that never happened.
      if (product.sourceType === 'MANUFACTURED') {
        return NextResponse.json(
          {
            error: `«${product.name}» منتج مصنّع — تُضاف كميته من تشغيلات الإنتاج ببنود كلفتها.`,
            code: 'WRONG_DOOR',
          },
          { status: 409 }
        );
      }

      // What this delivery cost, by the one rule all three doors now share.
      const priced = resolveUnitCost({
        given: input.unitCost,
        previous: await previousUnitCost(companyId, storeId, product.id),
        zeroCostReason: input.zeroCostReason,
      });
      if (!priced.ok) {
        return NextResponse.json({ error: priced.message, code: priced.code }, { status: 400 });
      }

      const result = await db.$transaction((tx) =>
        receiveStock(tx, {
          companyId,
          storeId,
          productId: product.id,
          quantity: input.quantity,
          unitCost: priced.unitCost,
          note: input.note?.trim() || null,
          createdById: user.id,
          warehouseId: input.warehouseId,
          mayUse: (w) => reachesWarehouse(user, companyId, w),
        })
      );

      await logAudit({
        companyId,
        userId: user.id,
        action: 'STOCK_RECEIVED',
        entity: 'Product',
        entityId: product.id,
        // The cost that was actually written, and where it came from —
        // a carried-forward price and a typed one are not the same fact.
        newData: {
          quantity: input.quantity,
          unitCost: priced.unitCost,
          costSource: priced.source,
          batch: result.batch.batchNumber,
        },
      });

      return NextResponse.json({
        success: true,
        balanceAfter: result.balanceAfter,
        batchNumber: result.batch.batchNumber,
      });
    }

    // ── recount ──

    /*
     * A STORE PLACED IN WAREHOUSES IS COUNTED BY WAREHOUSE (the warehouse plan, W2b — the owner's decision 4, 20/11).
     *
     * 19/11 (W2a) refused it here by name (`PLACED_STORE_COUNT_WAITS`) until the owner said what a count counts. He has:
     * what is PHYSICALLY in the warehouse — the parcels that left with the courier are not on the keeper's shelf, the
     * confirmed orders still waiting there are. So the count names its warehouse (required, checked by the receiving
     * door's own rule — `intakePlace`, under the product's stock lock), and is compared with
     * `warehouse-count.expectedInWarehouse`. And his second rule: a difference is approved by ANOTHER person. This count
     * has one hand, so it writes no difference at all — a match is recorded, a difference is recorded and refused (409)
     * with what to do next. The store total is never written from here for a placed store. A store that is not placed
     * counts exactly as before, below.
     */
    if (await storeIsPlaced(storeId)) {
      const found = await db.$transaction(async (tx) => {
        const warehouseId = await intakePlace(tx, {
          companyId,
          storeId,
          productId: product.id,
          warehouseId: input.warehouseId,
          mayUse: (w) => reachesWarehouse(user, companyId, w),
        });
        // A placement is never undone, so a placed store stays placed; this only satisfies the type.
        if (!warehouseId) throw new Error('placed store without a warehouse');
        const facts = await expectedInWarehouse(tx, { companyId, storeId, productId: product.id, warehouseId });
        const name = (await tx.warehouse.findFirst({ where: { id: warehouseId, companyId }, select: { name: true } }))?.name ?? '';
        return { warehouseId, name, facts };
      });
      const verdict = quickCountVerdict(input.countedQuantity, found.facts);
      await logAudit({
        companyId,
        userId: user.id,
        action: 'STOCK_RECOUNTED',
        entity: 'Product',
        entityId: product.id,
        previousData: { warehouseId: found.warehouseId, warehouseName: found.name, ...found.facts },
        newData: {
          counted: input.countedQuantity,
          basis: 'PHYSICAL',
          warehouseId: found.warehouseId,
          warehouseName: found.name,
          difference: verdict.difference,
          // Nothing is written by this count: a match needs nothing, a difference waits for a second person.
          written: false,
          reason: input.reason,
        },
      });
      if (verdict.matches) {
        return NextResponse.json({ success: true, difference: 0, warehouseId: found.warehouseId, message: COUNT_MATCHES_AR(found.name) });
      }
      const ar = differenceWaitsAr(found.name, input.countedQuantity, verdict.difference);
      return NextResponse.json(
        { error: ar, errorAr: ar, code: 'COUNT_DIFFERENCE_NEEDS_SECOND_HAND', difference: verdict.difference, warehouseId: found.warehouseId },
        { status: 409 }
      );
    }
    const onHand = await onHandTotal(db, companyId, product.id);
    // What open orders already hold: the very figure the balances screen prints as «محجوز», so the two cannot disagree.
    const reserved = await reservedElsewhere(db, companyId, product.id, undefined, storeId);
    const available = onHand - reserved;

    /*
     * A SHELF THAT HOLDS LESS THAN WHAT IS PROMISED CANNOT BE COUNTED BY ITS AVAILABLE.
     *
     * With `reserved` above `onHand` the available is negative, and `counted − available` would add units to the shelf to
     * cover the promises — stock that nobody found, entering at a cost. That is a reservation without goods, a fact about the
     * open orders, not a count. It is refused by name; goods really received go through «استلام».
     */
    if (available < 0) {
      return NextResponse.json(
        {
          error:
            `«${product.name}»: المحجوز لطلبات مفتوحة (${reserved}) أكبر مما على الرف (${onHand}). ` +
            'صحّح الطلبات المحجوزة أوّلاً، ثمّ اجرد المتاح.',
          code: 'RESERVED_EXCEEDS_SHELF',
        },
        { status: 409 }
      );
    }

    const difference = input.countedQuantity - available;

    if (difference === 0) {
      return NextResponse.json({
        success: true,
        difference: 0,
        balanceAfter: onHand,
        message: 'الجرد مطابق — لم يُسجَّل أي تعديل.',
      });
    }

    const movement = await db.$transaction(async (tx) => {
      if (difference > 0) {
        // Found more than the system knew. It enters at the cost of the
        // stock already there, not at zero: units at zero cost silently
        // lower the average and overstate the profit of everything sold
        // afterwards.
        //
        // AND WHEN THERE IS NO SUCH STOCK, this door stops rather than
        // falling back to zero, which is what `?? 0` used to do here. A
        // surplus of something we have never costed is not an adjustment,
        // it is a delivery nobody recorded — and it has a price.
        const existing = await tx.productionBatch.findFirst({
          where: { ...inStore(companyId, storeId), productId: product.id, quantityRemaining: { gt: 0 } },
          orderBy: { productionDate: 'desc' },
          select: { costPerUnit: true },
        });
        const carried = resolveUnitCost({ given: undefined, previous: existing?.costPerUnit ?? null });
        if (!carried.ok) {
          throw new UncostedSurplus(
            `«${product.name}» زاد ${difference} وحدةً ولا كلفةَ سابقةً تُبنى عليها. ` +
              'استلمها من باب «استلام بضاعة جاهزة» بكلفتها، ثمّ اجرد.'
          );
        }
        await receiveStock(tx, {
          companyId,
          storeId,
          productId: product.id,
          quantity: difference,
          unitCost: carried.unitCost,
          batchNumber: `ADJ-${Date.now().toString(36).toUpperCase()}`,
          note: input.reason.trim(),
          createdById: user.id,
        });
      } else {
        await drawDownStock(tx, {
          companyId,
          // The same shelf the surplus half writes to. Without it a stocktake
          // in one store took its shortfall out of another store's batches.
          storeId,
          productId: product.id,
          quantity: Math.abs(difference),
          allowNegative: false,
        });
      }

      return tx.inventoryMovement.create({
        data: {
          companyId,
          /*
           * THE SHELF THAT WAS COUNTED. Both halves of this transaction
           * already carry it — `receiveStock` for the surplus and
           * `drawDownStock` for the shortfall, the latter under a comment
           * saying why — and the ledger line that explains them did not, so
           * a stocktake moved this store's batches and then reported the
           * adjustment in no store at all.
           *
           * `requireContext()` throws `STORE_REQUIRED` rather than
           * returning a null store, and the product was looked up one query
           * earlier with this same `inStore(companyId, storeId)` — so «the
           * store the counter is standing in» and «the product's own store»
           * are one proven value, not two sources that could disagree.
           */
          storeId,
          productId: product.id,
          type: 'MANUAL_ADJUSTMENT',
          quantity: difference,
          balanceAfter: await onHandTotal(tx, companyId, product.id),
          reason: `جرد المتاح: عُدّ ${input.countedQuantity} والنظام ${available} (الرف ${onHand}، محجوز ${reserved}) — ${input.reason.trim()}`,
          createdById: user.id,
        },
      });
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'STOCK_RECOUNTED',
      entity: 'Product',
      entityId: product.id,
      previousData: { onHand, reserved, available },
      newData: { counted: input.countedQuantity, basis: 'AVAILABLE', difference, reason: input.reason },
    });

    return NextResponse.json({
      success: true,
      difference,
      balanceAfter: movement.balanceAfter,
    });
  } catch (error) {
    if (error instanceof IntakePlaceRefused) return NextResponse.json(intakeRefusalBody(error), { status: error.status });
    return apiErrorResponse(error);
  }
}
