import { NextResponse } from 'next/server';
import { DEAD_CONFIRMATION, TRACKING_ACK_ACTION, trackingAlert } from '@/lib/parcel-tracking/alert';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ruleFor } from '@/lib/phone-rules';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { transitOf } from '@/lib/transit';
import { expectsBarcode } from '@/lib/parcel-tracking/priority';
import { expectedAmountFor, SETTLEMENT_ORDER_SELECT } from '@/lib/settlement';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { readLimit, readPage } from '@/lib/numeric-input';
import { searchWhere, trackingFilters } from '@/lib/parcel-tracking/filters';
import { readTrackingList } from '@/lib/parcel-tracking/list';
import { sightWhere, unseenKey, withoutMoney, type TrackingSight } from '@/lib/parcel-tracking/sight';

/**
 * GET /api/ops/tracking?q=&status=&task=&courier=&region=&age=&page=&limit=
 *
 * Search by order number, merchant reference, courier barcode, customer name
 * or phone. Days in transit and the late flag are computed here against the
 * region's own threshold — the screen never counts days itself. Collection
 * status is returned as its own field, never merged into delivery status.
 *
 * «متابعة الشحن — صفحات + فلاتر + بحث». The list is read in pages of 25 (100 at
 * most), worst first, and the seven chips, the «late» badge and the numbers
 * beside the dropdowns are counted over EVERY parcel the question matches — not
 * over the first two hundred, which is all the screen could hold. See
 * `lib/parcel-tracking/list.ts` for how, and `lib/parcel-tracking/filters.ts` for the words.
 *
 *   ?status=   nothing: what is moving plus what arrived and is still owed · a state · `every` (or the old `all`)
 *   ?task=     one of the seven chips          ?courier= ?region=   an id, or `none`
 *   ?age=      fresh|few|week|old, by the shipping date
 *
 * An unknown value is a 400 in Arabic, never a quiet «everything».
 *
 * TWO LEVELS OF SIGHT (see `lib/parcel-tracking/sight.ts`). Whoever holds `ops.track` sees the parcels on the road. The
 * delivered parcels, the «بانتظار التحصيل» chip and the courier's figures need «عرض التسويات» or «إدارة الصناديق
 * النقدية»; the return rows need «عرض المرتجعات». Without them those rows are never read — so the chips, the
 * dropdowns' numbers and the pages leave them out too — the figures are taken off every row, and a request for a state
 * or a chip that is only those rows is a 403. `access` tells the screen which level it holds, so it draws no option
 * and no button the door would refuse; it is not what refuses.
 */
const IN_FLIGHT = ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY', 'RETURN_REQUESTED'];

/**
 * Arrived, and the money is still with the courier.
 *
 * The same two statuses `canCollect` reads in `parcel-tracking/priority.ts`. A
 * partial delivery belongs here as much as a full one: the customer took
 * some of it and paid for what they took, and that cash is owed exactly
 * like any other.
 */
const AWAITING_COLLECTION = ['DELIVERED', 'PARTIALLY_DELIVERED'];

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('ops.track');
    const sight: TrackingSight = {
      money: can(user, 'settlement.view') || can(user, 'finance.cashbox'),
      returns: can(user, 'ops.returns_view'),
      // Acting on the courier's money is the collect door's own key.
      collect: can(user, 'finance.cashbox'),
    };

    const q = new URL(req.url).searchParams;
    const now = new Date();
    const parsed = trackingFilters(q);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorAr: parsed.errorAr }, { status: 400 });
    const { status, task, courier, region, age, product, q: term } = parsed.applied;
    // A state or a chip that is only the other level's rows: refused in the door's own sentence, not answered with nothing.
    const unseen = unseenKey({ status, task }, sight);
    if (unseen) throw new Error(`Forbidden: missing required permission ${unseen}`);
    const inSight = sightWhere(sight);

    /*
     * ── AND THE DEFAULT CARRIES WHAT IS WAITING TO BE COLLECTED ──
     *
     * The owner, 21/10: «التحصيل لازم اقدر اعمل تحصيل... افرض ما
     * عندي كشف، لازمني آلية للمطابقة واغلاق الطلب وتحصيله».
     *
     * That mechanism already exists: `POST /api/ops/tracking/collect`
     * settles an order by hand, «for both there is no statement to
     * import», and the «استلمت منه» button on this screen calls it.
     *
     * Nobody could find it. This screen's own task list declares the
     * condition COLLECT — «بانتظار التحصيل: سُلّمت ولم تُسوَّ» — and
     * builds its chip from the rows it was given. The default load
     * asked for IN_FLIGHT only, and a delivered order is not in
     * flight. So the chip's rows were never fetched, the chip never
     * drew, and the one door that collects without a statement sat
     * behind a filter nobody knew to change.
     *
     * «all» still means all. What changed is that the default is now
     * the screen's own job description: what is moving, PLUS what has
     * arrived and whose money is still out there.
     */
    // The state and the search are each their OWN clause, ANDed: a search typed from the default view used to replace the
    // default's `OR` with its own, and quietly looked at every state.
    const statusClause =
      status === 'every'
        ? null
        : status !== 'default'
          ? { shippingStatus: status }
          : {
              OR: [
                { shippingStatus: { in: IN_FLIGHT } },
                {
                  shippingStatus: { in: AWAITING_COLLECTION },
                  settlementStatus: { not: 'SETTLED' },
                },
              ],
            };

    // Every parcel the question matches is read lean and judged (the chips, the badge, the dropdowns' numbers, the
    // order); only the page's own parcels are read in full, below.
    const list = await readTrackingList(db, {
      where: {
        companyId,
        storeId,
        AND: [
          ...(statusClause ? [statusClause] : []),
          // The rows this person may read — nothing added for someone who may read them all.
          ...(inSight ? [inSight] : []),
          // THIS store's order for that product — the store is already in the WHERE, so another store's product id finds nothing.
          ...(product ? [{ productId: product }] : []),
          ...(term ? [searchWhere(term)] : []),
        ],
      },
      now,
      task,
      courier,
      region,
      age,
      page: readPage(q),
      limit: readLimit(q, 25, 100),
    });

    const found = list.ids.length
      ? await db.order.findMany({
          where: { id: { in: list.ids }, companyId, storeId },
          select: {
            id: true, orderNumber: true, merchantRef: true, trackingNumber: true,
            // The order may be dead while its parcel is still moving — see
            // src/lib/parcel-tracking/alert.ts for why that is the one thing this
            // screen was not saying.
            confirmationStatus: true, updatedAt: true,
            // Everything the settlement rule reads, in one spread — including
            // the delivered lines and the return receipt, which this screen does
            // not show and cannot compute `expectedCollection` without.
            ...SETTLEMENT_ORDER_SELECT,
            settlementStatus: true, shippedAt: true, outForDeliveryAt: true,
            // The journey's end — the clock stops at either, and the row is judged by the same rule the list was.
            deliveredAt: true, returnedAt: true,
            deliveryFailureReason: true, currency: true, regionId: true,
            deliveryProviderId: true,
            customer: { select: { fullName: true, phone: true, city: true } },
            region: { select: { id: true, name: true } },
            deliveryProvider: { select: { id: true, name: true, kind: true, apiEnabled: true, adapterCode: true } },
            _count: { select: { deliveryAttempts: true, notes: true } },
          },
    })
      : [];
    // The database answers a set; the page is a SEQUENCE — worst first — and it is the list's, not the database's.
    const byId = new Map(found.map((o) => [o.id, o]));
    const orders = list.ids.flatMap((id) => byId.get(id) ?? []);

    /**
     * THE TWO THINGS THAT MAKE CHASING A PARCEL POINTLESS OR WRONG.
     *
     * Three small reads over the orders already fetched, not a join per
     * row: when each was cancelled, when an approved change was last
     * written onto it, and when somebody last said they saw either.
     */
    const ids = orders.map((o) => o.id);
    const [cancelLogs, applied, acks] = ids.length
      ? await Promise.all([
          db.orderStatusLog.findMany({
            where: { orderId: { in: ids }, statusType: 'CONFIRMATION', newValue: { in: [...DEAD_CONFIRMATION] } },
            orderBy: { createdAt: 'desc' },
            select: { orderId: true, createdAt: true },
          }),
          db.orderChangeRequest.findMany({
            where: { orderId: { in: ids }, appliedAt: { not: null } },
            orderBy: { appliedAt: 'desc' },
            select: { orderId: true, appliedAt: true },
          }),
          db.orderActivity.findMany({
            where: { orderId: { in: ids }, action: TRACKING_ACK_ACTION },
            orderBy: { createdAt: 'desc' },
            select: { orderId: true, createdAt: true },
          }),
        ])
      : [[], [], []];

    // Ordered newest-first above, so the first seen per order is the latest.
    const newest = <T extends { orderId: string }>(rows: T[], pick: (r: T) => Date | null) => {
      const m = new Map<string, Date>();
      for (const r of rows) if (!m.has(r.orderId)) { const d = pick(r); if (d) m.set(r.orderId, d); }
      return m;
    };
    const cancelledAt = newest(cancelLogs, (r) => r.createdAt);
    const changedAt = newest(applied, (r) => r.appliedAt);
    const ackedAt = newest(acks, (r) => r.createdAt);

    // One lookup per (courier, region) pair for the late thresholds.
    const pairs = [...new Set(orders.filter((o) => o.deliveryProviderId && o.regionId).map((o) => `${o.deliveryProviderId}|${o.regionId}`))];
    const fees = await db.deliveryFee.findMany({
      where: {
        OR: pairs.map((p) => {
          const [deliveryProviderId, regionId] = p.split('|');
          return { deliveryProviderId, regionId };
        }),
      },
      select: { deliveryProviderId: true, regionId: true, lateThresholdDays: true },
    });
    const thresholdOf = new Map(fees.map((f) => [`${f.deliveryProviderId}|${f.regionId}`, f.lateThresholdDays]));

    const built = orders.map((order) => {
      // The lines, the add-ons and the return receipt are what the
      // EXPECTATION is built from, not something this screen prints — so they
      // feed the rule and stay off the wire. A row carrying every unit of
      // every parcel would also be a lot of somebody's order history in a
      // browser. `addOns` joined this list the day the rule started reading
      // it: three fields selected for the rule, none of them stripped, is how
      // a payload grows without anyone deciding it should.
      const { items: _items, returnReceipt: _returnReceipt, addOns: _addOns, ...o } = order;
      /**
       * NULL WHEN THIS LANE HAS NO FEE ROW — it used to be `?? 0`, and that
       * made two different facts the same number on the wire: «nobody has
       * priced this courier for this region» and «the threshold is zero».
       * The screen then printed a blank for both, so a deliberate zero read
       * as an absence — and «late» is how an operator decides to chase a
       * parcel.
       *
       * `transitOf` still receives `0` for the unpriced lane, and that
       * is not a fallback sneaking back in: it reads `0` as «no threshold»
       * and an unpriced lane has none either, so both are «never late».
       * What differs is only what the screen is allowed to SAY about it,
       * which is why the row carries the null and the rule does not.
       */
      const threshold = thresholdOf.get(`${o.deliveryProviderId}|${o.regionId}`) ?? null;
      // The company carries the two fields that decide whether it owes a barcode; the wire gets the answer, not the fields.
      const company = order.deliveryProvider;
      // The SAME function the list judged this parcel with — a page's rows and the chips above them cannot disagree.
      const transit = transitOf(o, threshold ?? 0);
      return {
        ...o,
        // The company, without the two fields that only decide whether it owes a barcode.
        deliveryProvider: company && { id: company.id, name: company.name, kind: company.kind },
        barcodeExpected: expectsBarcode(company),
        daysInTransit: transit.days,
        lateThresholdDays: threshold,
        late: transit.late,
        // Delivery, settlement and collection stay three separate facts.
        collectionStatus: o.settlementStatus,
        /**
         * WHAT THE COURIER OWES ON THIS ORDER, by the settlement matcher's
         * own rule — computed here, where that rule lives.
         *
         * The collect dialog used to work it out as `totalAmount −
         * deliveryFee`, which is right for a whole delivery and wrong for a
         * partial one: on a partial the courier owes what the customer
         * actually took, and the full value makes every partial look like a
         * shortfall. The person then reads a total that accuses a rep of
         * keeping money he never received, and the server — which applies
         * the rule correctly — records a different figure.
         *
         * Rounded by the COUNTRY's minor unit inside the rule — JOD has
         * three places — so the screen receives a figure it only prints.
         *
         * AND `null` FOR A ROW THE RULE CANNOT ANSWER, RATHER THAN NO SCREEN.
         *
         * `expectedAmountFor` throws on an order with no lines, on the sound
         * ground that a caller who did not select `items` would otherwise
         * get the old total-based answer by accident. This route DOES select
         * them — `SETTLEMENT_ORDER_SELECT` is spread above — so an empty
         * array here is not a programming mistake: it is an order the
         * database really has no lines for.
         *
         * They exist. `confirmation/winback/route.ts:269` creates a real
         * order and writes no `OrderItem` row at all; it is born `NOT_READY`
         * and stays there, because `assertReadyToShip`
         * (`order-state.ts:238`) refuses an order with no lines. Invisible
         * on the default «قيد الشحن» filter, and reached the moment the
         * operator picks «الكل» or «غير جاهز» — and then one such row threw
         * an English message matching no branch in `api-error.ts`, so the
         * answer was a 500 and the screen went blank, taking ~199 healthy
         * rows with it.
         *
         * `null`, not 0: zero is the settled answer the rule gives a
         * RETURNED parcel — «owes nothing» — and this row's collection is
         * unknown, not nil. The browser already types the field as
         * `number | null` and sums it with `?? 0`, so the bar is unmoved.
         *
         * The guard is HERE and not in the rule because the rule's throw is
         * still right for every caller that forgot the select. If it should
         * instead report «I cannot answer» itself, that is a change to
         * `settlement.ts`, which this change does not touch.
         *
         * Written as two branches rather than a ternary so the call stays
         * verbatim: `the-frontend-invariants.test.ts:654` pins this exact
         * line as proof the route sends the RULE's figure and never a
         * formula of its own, and that remains the whole point.
         */
        ...(order.items.length > 0
          ? { expectedCollection: expectedAmountFor(order, country.minorUnit) }
          : { expectedCollection: null }),
        /**
         * The one thing worth saying about this row, or null. A cancelled
         * order with no surviving status log still announces itself — its
         * own last write is the honest approximation.
         */
        alert: trackingAlert({
          inFlight: transit.inFlight,
          confirmationStatus: o.confirmationStatus,
          cancelledAt: cancelledAt.get(o.id) ?? o.updatedAt,
          changeAppliedAt: changedAt.get(o.id) ?? null,
          acknowledgedAt: ackedAt.get(o.id) ?? null,
        }),
      };
    });
    // The courier's figures leave with the permission: every row is built whole by the one rule above, then they are taken off.
    const rows = sight.money ? built : built.map((r) => withoutMoney(r));

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'شاشة التتبّع', rows });

    return NextResponse.json({
      // wa.me needs the number in full international form, and the rows
      // carry it in local form. The country is known here, not in the browser.
      dialCode: ruleFor(country.code)?.dialCode ?? null,
      // What is ON this page — a different fact from how many there are (`pagination.total`).
      count: rows.length,
      orders: rows,
      // Which level of the screen this person holds — what to draw, never what to allow.
      access: sight,
      // The three acts that have a box of their own (PR-8) — what to draw, never what to allow: each door asks its own key.
      acts: { deliver: can(user, 'ops.deliver'), transfer: can(user, 'ops.transfer'), writeOff: can(user, 'ops.write_off') },
      // Over everything the list holds, not the page: the badge says how many parcels are late, not how many of these 25.
      lateCount: list.facts.lateCount,
      pagination: { total: list.total, page: list.page, limit: list.limit, totalPages: list.totalPages },
      facts: list.facts,
      applied: parsed.applied,
      // The bound was reached: this is the first of a bigger list, and the screen says so rather than look whole.
      capped: list.capped,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
