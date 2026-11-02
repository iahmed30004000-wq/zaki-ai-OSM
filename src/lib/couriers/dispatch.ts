import { db } from '../db';
import { adapterFor } from './index';
import { courierCityIdFor, storedCityIds } from './city-id';
import { courierBelongsToStore } from './scope';
import { isOutcomeUnknown } from './types';
import { logAudit } from '../audit';
import { formatPhoneNumber } from '../phone';

/**
 * HANDING THE ORDERS TO THE COURIER.
 *
 * The batch screen already groups orders and marks them ready for pickup —
 * but that all happened here, on our side. Nothing was ever sent to the
 * shipping company, so nothing came back: no barcode, and therefore no way
 * to track a parcel, print a courier-recognised waybill, or match their
 * statement line to our order.
 *
 * The barcode IS the reference. We send them our order number as the
 * merchant reference; they answer with their barcode, and from that moment
 * the two systems can find the same parcel from either side.
 *
 * Three rules shape this:
 *
 *   NEVER inside a database transaction. A call to somebody else's server
 *   can hang for thirty seconds, and holding row locks on twenty orders
 *   while it does is how a warehouse stops working.
 *
 *   NEVER twice for one order. A second create is a second parcel at the
 *   courier, billed and collected twice, and the customer opens the door to
 *   a duplicate. An order that already carries a tracking number is skipped,
 *   not retried — and the skip is decided by a CLAIM WRITTEN TO THE ROW
 *   before the call, not by the snapshot this function read when it began.
 *   Two operators pressing «dispatch» on one batch used to read the same
 *   null, both create a parcel, and the second barcode overwrite the first.
 *
 *   ONE order at a time, reported per order. Twenty orders where three fail
 *   is seventeen parcels that must still ship — an all-or-nothing dispatch
 *   would hold them hostage to a bad phone number on someone else's.
 */

export interface DispatchOutcome {
  orderId: string;
  orderNumber: string;
  ok: boolean;
  /** The courier's barcode — our tracking number from now on. */
  trackingNumber?: string;
  skipped?: 'ALREADY_SENT' | 'NOT_AUTOMATED' | 'NO_PROVIDER' | 'SEND_IN_FLIGHT' | 'NO_COURIER_CITY' | 'LEFT_THE_BATCH';
  /** With NO_COURIER_CITY: the governorate the courier has no id for yet. */
  regionName?: string | null;
  /**
   * True when the courier may have created the parcel and we never heard.
   * Whoever retries must ask the courier first — this is the one failure
   * that is not safe to press again.
   */
  outcomeUnknown?: boolean;
  error?: string;
}

/**
 * TAKE THE ORDER BEFORE TELLING THE COURIER ANYTHING.
 *
 * One statement: the row is claimed only if it is still unclaimed and still
 * has no barcode, and the database decides which of two callers wins. A read
 * followed by a write cannot do this — that is the very shape of the bug.
 *
 * Raw SQL, deliberately: `updateMany` returns a count and not the row, and
 * this needs the conditional update and its result in a single round trip.
 */
type Claim =
  /** Won — with the AMOUNT the order carried at the moment it was taken: that figure, and no earlier one, is what the courier is told. */
  | { won: true; totalAmount: number }
  | { won: false; reason: 'ALREADY_SENT' | 'SEND_IN_FLIGHT' | 'LEFT_THE_BATCH' };

async function claimForSend(orderId: string, batchId: string): Promise<Claim> {
  /*
   * THE CLAIM REPEATS WHAT MADE THE ORDER SENDABLE.
   *
   * The loop reads the batch's orders once, then claims them one at a time,
   * seconds apart. In between, a person may cancel one (it leaves the
   * trolley and its waybill goes), postpone it, or the press may hand the
   * whole batch over. A claim that checked only the barcode would then send
   * a dead order — a parcel at the company for an order nobody wants. So the
   * same statement requires: still on THIS trolley, still waiting for
   * pickup, still confirmed, and not yet shipped.
   */
  /*
   * AND THE CLAIM HANDS BACK THE AMOUNT IT TOOK (the independent review of the delivery-included door, 1/11).
   *
   * The batch's orders were read once, before the loop; this order may be claimed minutes later. A person who flips «شامل التوصيل»
   * on it in between (or any other door that re-prices an order still on the trolley) changes `totalAmount` in the row, and a send
   * that used the figure from the early read would tell the courier to collect a sum our own record no longer holds. Reading it in
   * the statement that takes the row closes that: the figure the courier is told is the one the row HAD at the moment of the claim.
   * The «شامل التوصيل» door refuses once `courier_send_started_at` is set (its write carries `courierSendStartedAt: null`); the
   * order PATCH — the packing pen, an approved change request — does not look at the claim yet (BACKLOG RV558), so a write that
   * read the order before this claim can still land just after it. That window is one request now, not the minutes between the
   * read of the batch and its send.
   */
  const won = await db.$queryRaw<{ id: string; totalAmount: number | string }[]>`
    UPDATE "orders"
       SET "courier_send_started_at" = now()
     WHERE "id" = ${orderId}
       AND "trackingNumber" IS NULL
       AND "courier_send_started_at" IS NULL
       AND "shippingBatchId" = ${batchId}
       AND "shippingStatus" = 'READY_FOR_PICKUP'
       AND "confirmationStatus" = 'CONFIRMED'
       AND "shippedAt" IS NULL
    RETURNING "id", "totalAmount"`;
  if (won.length > 0) return { won: true, totalAmount: Number(won[0].totalAmount ?? 0) };

  // Lost, and the reasons are different news: one parcel exists, one is
  // mid-flight and nobody yet knows, or the order is no longer this
  // trolley's to send.
  const [row] = await db.$queryRaw<{ tracking: string | null; claimed: Date | null; batch: string | null; shipping: string; confirmation: string; shipped: Date | null }[]>`
    SELECT "trackingNumber" AS tracking, "courier_send_started_at" AS claimed, "shippingBatchId" AS batch,
           "shippingStatus" AS shipping, "confirmationStatus" AS confirmation, "shippedAt" AS shipped
      FROM "orders" WHERE "id" = ${orderId}`;
  if (row?.tracking) return { won: false, reason: 'ALREADY_SENT' };
  const left =
    row?.batch !== undefined &&
    (row.batch !== batchId || row.shipping !== 'READY_FOR_PICKUP' || row.confirmation !== 'CONFIRMED' || !!row.shipped);
  return { won: false, reason: left ? 'LEFT_THE_BATCH' : 'SEND_IN_FLIGHT' };
}

/**
 * Give the order back, for a refusal whose outcome is KNOWN.
 *
 * A bad phone number is corrected and sent again; holding the claim would
 * make the correction unsendable. The `trackingNumber IS NULL` guard is not
 * ceremony: if a barcode arrived by another route meanwhile, the claim is
 * that parcel's record and releasing it would erase when it was sent.
 */
async function releaseClaim(orderId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE "orders"
       SET "courier_send_started_at" = NULL
     WHERE "id" = ${orderId} AND "trackingNumber" IS NULL`;
}

export interface DispatchSummary {
  sent: number;
  skipped: number;
  failed: number;
  outcomes: DispatchOutcome[];
}

/**
 * HOW MANY PIECES THE DRIVER CARRIES: every line, gifts included, and every add-on the customer took after ordering.
 *
 * It read the order's head (`quantity + freeQuantity`), which describes ONE line — the largest — so a basket of
 * three products announced the pieces of one of them, and an add-on was never counted at all. An order with no lines
 * (one that predates them) still has its head to go on.
 */
export function piecesInParcel(order: {
  quantity?: number | null;
  freeQuantity?: number | null;
  items?: { quantity: number; freeQuantity: number }[] | null;
  addOns?: { quantity: number }[] | null;
}): number {
  const lines = order.items ?? [];
  const added = (order.addOns ?? []).reduce((n, a) => n + a.quantity, 0);
  const counted = lines.length > 0
    ? lines.reduce((n, l) => n + l.quantity + l.freeQuantity, 0) + added
    : (order.quantity ?? 1) + (order.freeQuantity ?? 0) + added;
  return Math.max(1, counted);
}

/**
 * WHAT IS STILL TO SEND, so a big batch can go in small pieces.
 *
 * A hundred and sixty orders are minutes of the courier's time, one order at a time, and no single request waits that long: the
 * screen gave up after fifteen seconds with «انتهت مهلة الطلب» while the server went on. So the screen asks here first, then
 * sends a few at a time (`dispatchBatch` with `orderIds`) and shows how far it has got. Ids and numbers only — no name, no
 * phone: this is the `ops.ship` door, and the batch read that carries those is `ops.batches`.
 *
 * Asked of the same batch the send is asked of: this store's, still being filled, with a courier that is the store's own.
 */
export interface DispatchPlan {
  /** No barcode yet, in the order the send takes them. */
  pending: { id: string; orderNumber: string }[];
  /** Already carry the courier's barcode: nothing to send, and said so in the answer. */
  sent: { id: string; orderNumber: string }[];
}

export async function dispatchPlan(input: { batchId: string; companyId: string; storeId: string }): Promise<DispatchPlan> {
  const batch = await db.shippingBatch.findFirst({
    where: { id: input.batchId, companyId: input.companyId, storeId: input.storeId },
    select: { id: true, status: true, provider: { select: { companyId: true, storeId: true } } },
  });
  if (!batch) throw new Error('BATCH_NOT_FOUND');
  if (batch.provider && !courierBelongsToStore(batch.provider, input.companyId, input.storeId)) throw new Error('COURIER_NOT_IN_STORE');
  if (batch.status !== 'READY') throw new Error('BATCH_NOT_READY');

  const orders = await db.order.findMany({
    where: { shippingBatchId: batch.id, companyId: input.companyId },
    select: { id: true, orderNumber: true, trackingNumber: true },
    orderBy: { orderNumber: 'asc' },
  });
  return {
    pending: orders.filter((o) => !o.trackingNumber).map(({ id, orderNumber }) => ({ id, orderNumber })),
    sent: orders.filter((o) => !!o.trackingNumber).map(({ id, orderNumber }) => ({ id, orderNumber })),
  };
}

/**
 * Send a batch's orders to their courier and record what came back.
 *
 * `orderIds` narrows it to a retry of the ones that failed — or to one piece of a big batch (`dispatchPlan`); omitted, the
 * whole batch is attempted and the ones already sent are skipped.
 */
export async function dispatchBatch(input: {
  batchId: string;
  companyId: string;
  storeId: string;
  userId: string;
  orderIds?: string[];
}): Promise<DispatchSummary> {
  const batch = await db.shippingBatch.findFirst({
    where: { id: input.batchId, companyId: input.companyId, storeId: input.storeId },
    select: {
      id: true,
      batchNumber: true,
      status: true,
      provider: {
        select: { id: true, name: true, code: true, adapterCode: true, apiEnabled: true, apiConfig: true, apiCredentials: true, companyId: true, storeId: true },
      },
    },
  });
  if (!batch) throw new Error('BATCH_NOT_FOUND');

  /**
   * The courier must be this store's, or one shared by all of them.
   *
   * Each store holds its own account with the same courier, so using
   * another store's row creates the parcel under another store's login —
   * and the collection, the statement and the money come back against that
   * account. The screens only offer the right ones; this is the check that
   * holds when the endpoint is called directly.
   */
  if (batch.provider && !courierBelongsToStore(batch.provider, input.companyId, input.storeId)) {
    throw new Error('COURIER_NOT_IN_STORE');
  }

  /**
   * ONLY A TROLLEY STILL BEING FILLED IS SENT.
   *
   * The batch status was never read here, so a batch already handed to the
   * courier (or closed) could be dispatched again from a stale screen or a
   * direct call: parcels created at the company after the driver had left
   * with the others, for orders whose seal says they are no longer ours to
   * change. Sending is part of filling the trolley; once it is handed over
   * a missing barcode is typed in by hand, as for a manual courier.
   */
  if (batch.status !== 'READY') throw new Error('BATCH_NOT_READY');

  const adapter = adapterFor(batch.provider);

  const orders = await db.order.findMany({
    where: {
      shippingBatchId: batch.id,
      companyId: input.companyId,
      ...(input.orderIds?.length ? { id: { in: input.orderIds } } : {}),
    },
    select: {
      id: true, orderNumber: true, merchantRef: true, trackingNumber: true,
      // (No `totalAmount`: the amount to collect is the one the claim takes — `claimForSend`.)
      currency: true, quantity: true, freeQuantity: true,
      customerNotes: true, deliveryProviderId: true,
      // The parcel's own address, when the visitor typed one that differs from the customer row's.
      deliveryAddress: true,
      // The pieces in the box are the LINES and the customer's additions — not the head line the row summarises.
      items: { select: { quantity: true, freeQuantity: true } },
      addOns: { select: { quantity: true } },
      customer: { select: { fullName: true, rawPhone: true, phone: true, altPhone: true, address: true } },
      regionId: true,
      region: { select: { name: true } },
      store: { select: { country: { select: { code: true } } } },
    },
    orderBy: { orderNumber: 'asc' },
  });

  // One read for the whole batch rather than one per parcel: the ids TYPED for this courier. What its own list says for
  // a governorate nobody typed is looked up per parcel, from memory (`courierCityIdFor`) — it needs no fee row.
  const typedCityIds = storedCityIds(
    await db.deliveryFee.findMany({
      where: { deliveryProviderId: batch.provider?.id, courierCityId: { not: null } },
      select: { regionId: true, courierCityId: true },
    })
  );

  const outcomes: DispatchOutcome[] = [];

  for (const order of orders) {
    // Already has a barcode in the snapshot: cheap, and it spares the
    // database a write for the ordinary case. It is NOT the guard — the
    // claim below is, because this snapshot was read before the loop.
    if (order.trackingNumber) {
      outcomes.push({ orderId: order.id, orderNumber: order.orderNumber, ok: false, skipped: 'ALREADY_SENT' });
      continue;
    }
    if (!order.deliveryProviderId) {
      outcomes.push({ orderId: order.id, orderNumber: order.orderNumber, ok: false, skipped: 'NO_PROVIDER' });
      continue;
    }
    // A manual courier has no API to send to; the parcel goes by hand and
    // the tracking number is typed in when they give one.
    if (!adapter.automated) {
      outcomes.push({ orderId: order.id, orderNumber: order.orderNumber, ok: false, skipped: 'NOT_AUTOMATED' });
      continue;
    }
    /*
     * A GOVERNORATE THE COURIER HAS NO ID FOR IS REFUSED HERE — before the
     * claim and before any call. It used to be claimed, searched for by name
     * over the network, failed with an English error code, and released. Now
     * it says which governorate and where its id is typed, and the rest of
     * the batch goes on.
     *
     * «NO ID» MEANS NONE TYPED AND NONE IN THE COURIER'S OWN LIST. The code
     * must be typed per governorate in the settings, and nobody ever typed
     * the fourteen, so every parcel was refused (the owner, 2/11: «ترحيل
     * الطلبات مش زابط»). A typed id still wins; otherwise Basha's own sheet
     * gives the governorate its city (`couriers/city-id`) — and a governorate
     * the sheet cannot answer, or an order with no governorate, stays refused.
     */
    const cityId = courierCityIdFor({
      providerCode: batch.provider?.code,
      stored: typedCityIds,
      regionId: order.regionId,
      regionName: order.region?.name,
    });
    if (adapter.needsCourierCityId && cityId === null) {
      outcomes.push({
        orderId: order.id, orderNumber: order.orderNumber, ok: false,
        skipped: 'NO_COURIER_CITY', regionName: order.region?.name ?? null,
      });
      continue;
    }

    /*
     * From here on a parcel may come into existence, so the row is taken
     * first. Everything above is a decision we can make from our own data;
     * this is the last moment before somebody else's system is involved.
     */
    const claim = await claimForSend(order.id, batch.id);
    if (!claim.won) {
      outcomes.push({ orderId: order.id, orderNumber: order.orderNumber, ok: false, skipped: claim.reason });
      continue;
    }

    try {
      const result = await adapter.createShipment({
        // The courier's own id for this region: the one typed on the fee row,
        // else the one in their own list (see above). Without it the adapter
        // has to search their API by name on every single shipment — a round
        // trip that needs their password, and a name match that quietly takes
        // the first of several hits. A parcel addressed to the wrong
        // governorate is not a thing you find out about until the driver
        // calls.
        cityId: cityId ?? undefined,
        orderId: order.id,
        // Our order number, so their statement line can be matched back.
        merchantRef: order.merchantRef || order.orderNumber,
        // The amount the claim took, not the one from the early read of the batch: see `claimForSend`.
        codAmount: claim.totalAmount,
        currencyCode: order.currency,
        customer: {
          fullName: order.customer?.fullName ?? '',
          // The phone AS TYPED: couriers dial it, and a normalized form can
          // lose the leading zero their system expects.
          phone: order.customer?.rawPhone || order.customer?.phone || '',
          // The second number has no as-typed copy: the storefront stores it
          // canonical, its trunk zero stripped («0988777666» → «988777666»).
          // Written back in the store country's dialling form, as a driver
          // dials it; a number already typed with its zero comes out unchanged.
          altPhone: order.customer?.altPhone
            ? formatPhoneNumber(order.customer.altPhone, order.store?.country?.code)
            : null,
          // This parcel's address before the customer's: a returning customer who typed a new street gets it there.
          address: order.deliveryAddress ?? order.customer?.address ?? '',
          regionName: order.region?.name ?? null,
        },
        pieces: piecesInParcel(order),
        note: order.customerNotes ?? null,
      });

      /*
       * CONDITIONAL, even holding the claim. A barcode may have been typed
       * in by hand while the courier was answering, and overwriting it
       * would leave a real parcel with no record of its number — the exact
       * loss this whole section exists to prevent. Better to report two
       * parcels than to hide one.
       */
      const recorded = await db.order.updateMany({
        where: { id: order.id, trackingNumber: null },
        data: {
          trackingNumber: result.trackingNumber,
          version: { increment: 1 },
        },
      });
      if (recorded.count === 0) {
        outcomes.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          ok: false,
          error: `أُنشئ طردٌ ثانٍ عند الشركة برقم ${result.trackingNumber} — الطلب كان قد حمل رقماً قبله. راجع الشركة لإلغاء أحدهما.`,
        });
        continue;
      }

      await db.orderActivity.create({
        data: {
          companyId: input.companyId,
          orderId: order.id,
          userId: input.userId,
          action: 'SHIPMENT_SENT_TO_COURIER',
          metadata: JSON.stringify({
            batch: batch.batchNumber,
            adapter: adapter.code,
            merchantRef: order.merchantRef || order.orderNumber,
            barcode: result.trackingNumber,
          }),
        },
      });

      outcomes.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        ok: true,
        trackingNumber: result.trackingNumber,
      });
    } catch (e) {
      /*
       * A REFUSAL RETURNS THE ORDER; A SILENCE KEEPS IT.
       *
       * «Unknown city» and «invalid phone» are answers: nothing was made,
       * the operator fixes the field and sends again, so the claim goes
       * back. A timeout is not an answer — the parcel may exist — and
       * releasing it there would hand the next click a second waybill.
       */
      const unknown = isOutcomeUnknown(e);
      if (!unknown) await releaseClaim(order.id);

      // The courier's own words, kept: "city unknown" and "invalid phone"
      // are different problems, and a generic failure teaches nothing.
      const said = e instanceof Error ? e.message.slice(0, 300) : 'تعذر الإرسال';
      outcomes.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        ok: false,
        outcomeUnknown: unknown || undefined,
        error: unknown ? `${said} — قد يكون الطردُ أُنشئ. اسأل الشركة قبل إعادة الإرسال.` : said,
      });
    }
  }

  const summary: DispatchSummary = {
    sent: outcomes.filter((o) => o.ok).length,
    skipped: outcomes.filter((o) => o.skipped).length,
    failed: outcomes.filter((o) => !o.ok && !o.skipped).length,
    outcomes,
  };

  await logAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'SHIPMENT_BATCH_DISPATCHED',
    entity: 'ShippingBatch',
    entityId: batch.id,
    newData: {
      batchNumber: batch.batchNumber,
      adapter: adapter.code,
      sent: summary.sent,
      skipped: summary.skipped,
      failed: summary.failed,
    },
  });

  return summary;
}
