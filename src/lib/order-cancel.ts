import type { Prisma } from '@prisma/client';
import { db } from './db';
import { logAudit } from './audit';
import { emitAppEvent } from './apps/events';
import { releaseOrderLines } from './reservation';
import { resolveDeliveryFee } from './delivery-fees';
import { roundMinor } from './money';
import { SHIPPING_GONE } from './order-state';
import {
  ATTESTATION_AR,
  ATTESTATION_NEEDED_AR,
  WAYBILL_ATTESTATION_AR,
  WAYBILL_ATTESTATION_NEEDED_AR,
  cancelVerdict,
  leavesTheShipment,
  leavesTheTrolley,
  takenOffFrom,
  type CancelFacts,
} from './shipment-cancel';
import {
  IN_TRANSIT_NOW_AR,
  cancelAtCourier,
  notSureAr,
  refusedAr,
  type RemoteCancel,
} from './couriers/remote-cancel';
import type { CourierAdapter } from './couriers';

/**
 * THE ONE HELPER EVERY CANCEL DOOR GOES THROUGH.
 *
 * Six doors used to end an order, each with its own idea of what «ended»
 * means: the stand-down wrote REJECTED and dropped the reservation; the
 * confirmation's «cancel» wrote CANCELLED and dropped it; the shipping
 * screen's «CANCELLED» wrote one column and dropped nothing; the PATCH
 * counted the customer's cancellation and no other door did; the automatic
 * close after three silent calls asked a different question again. A parcel
 * on a trolley was cancelled by whichever door the person happened to knock
 * on, and the trolley never heard about it.
 *
 * Now there is one place that:
 *
 *   ASKS    `cancelVerdict` — until the press of «إغلاق الشحنة — سُلّمت للشركة»
 *           the order is still ours; after it, no. It fails CLOSED: it needs
 *           the trolley's status, and an order whose trolley cannot be read
 *           is refused.
 *   WANTS   a person's word before packed goods are counted back (`parcelInHand`).
 *   TELLS   the company, for a parcel it already has a barcode for — outside the
 *           transaction, and only a clear yes lets the order change.
 *   WRITES  ONE end state, conditionally (version, trolley, barcode, claim —
 *           so a press, a dispatch or a second cancel that lands first makes
 *           this write find nothing, and nothing is half done).
 *   TELLS   System 7, after the commit.
 *
 * It never decides who MAY cancel: that stays with the door and its permission.
 */

/** The doors that end an order, as the activity and the audit name them. */
export type ShipmentDoor =
  | 'STAND_DOWN'
  | 'CONFIRMATION'
  | 'SHIPPING_STATUS'
  | 'PATCH'
  | 'CONTACT_AUTO_CLOSE'
  | 'BATCH_SCREEN';

const ENDED = ['CANCELLED', 'REJECTED'] as const;

export interface EndOrderInput {
  orderId: string;
  companyId: string;
  storeId?: string | null;
  by: { id: string; name?: string | null; role: string };
  door: ShipmentDoor;
  /**
   * CANCEL ends the order. FOLLOW_UP gives it back to the confirmation desk
   * (the stand-down's «أعِده للمتابعة»): the customer is spoken to again, so
   * the order leaves the shipment exactly as a cancel does, and stays alive.
   */
  kind: 'CANCEL' | 'FOLLOW_UP';
  /** For CANCEL: the word it ends with. CANCELLED unless the door says REJECTED. */
  endAs?: 'CANCELLED' | 'REJECTED';
  /** The structured reason, written to `rejectionReason` when given. */
  reason?: string | null;
  /** The sentence beside it, written to `rejectionNote` when given. */
  rejectionNote?: string | null;
  /** The columns this door adds to the end state (follow-up dates, claim release…). */
  data?: Record<string, unknown>;
  /** The status log's note; the activity and the note default to it. */
  logNote?: string | null;
  /** The order's note body. Written only when given — the status log already carries the reason. */
  noteBody?: string | null;
  /** The version the caller loaded — a stale screen is refused. */
  expectedVersion?: number;
  /** «الطرد بين يديّ…» — required when the goods are packed. */
  parcelInHand?: boolean;
  /** An approved change request being carried out: marked applied in the same transaction. */
  viaRequest?: { id: string } | null;
  /**
   * Run the writes inside a transaction the caller already holds (the
   * contact-attempt door closes an order in the SAME transaction as the
   * attempt that closed it). Only for an order that never entered the
   * shipment: a company call must never happen inside somebody's transaction.
   */
  tx?: Prisma.TransactionClient;
  /** For tests only: a double instead of the stored courier account. */
  inject?: { adapter?: CourierAdapter; courierName?: string | null };
}

export type EndOutcome =
  | {
      ok: true;
      orderNumber: string;
      attested: boolean;
      /** True when the order was on a trolley, labelled or barcoded and has been taken off. */
      tookOff: boolean;
      /** True when the company confirmed the parcel's cancellation. */
      courierCancelled: boolean;
      /**
       * The audit row and the event for System 7 — to be run AFTER the commit.
       * Without `tx` the helper runs it itself, once; with `tx` (the caller's
       * transaction is still open, and may yet roll back) it does NOT, and the
       * caller runs it when the transaction has committed. An announcement that
       * goes out of a transaction that is then undone is a customer told about
       * a cancellation that never happened.
       */
      afterCommit: () => Promise<void>;
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
      /** With ATTESTATION_REQUIRED: the exact sentence the person must tick. */
      attestation?: string;
    };

const refuse = (status: number, code: string, error: string, extra: { attestation?: string } = {}): EndOutcome => ({
  ok: false,
  status,
  code,
  error,
  ...extra,
});

/** The trolley's status — null when there is no trolley. Required by `cancelVerdict`, so every door must ask. */
export async function batchStatusOf(
  client: Pick<Prisma.TransactionClient, 'shippingBatch'>,
  batchId: string | null | undefined
): Promise<string | null> {
  if (!batchId) return null;
  const batch = await client.shippingBatch.findFirst({ where: { id: batchId }, select: { status: true } });
  return batch?.status ?? null;
}

class OrderMovedOn extends Error {
  constructor() {
    super('ORDER_MOVED_ON');
  }
}

const MOVED_AR = 'تغيّر الطلب أثناء العمل عليه (أو سُلّمت دفعته للتو) — حدّث الصفحة وجرّب من جديد.';

/** What a conditional write must still find, or find nothing. */
function stillAsRead(o: {
  id: string;
  version: number;
  shippingBatchId: string | null;
  trackingNumber: string | null;
  courierSendStartedAt: Date | null;
}, companyId: string) {
  return {
    id: o.id,
    companyId,
    version: o.version,
    // The press stamps a member with shippedAt AND moves its status: either one means the parcel left.
    shippedAt: null,
    shippingStatus: { notIn: [...SHIPPING_GONE] },
    shippingBatchId: o.shippingBatchId,
    trackingNumber: o.trackingNumber,
    // A claim is compared as «still there», not by its timestamp: the database holds microseconds and a Date does not.
    courierSendStartedAt: o.courierSendStartedAt ? { not: null } : null,
    // The trolley must still be the one being filled. A press that won the race made it SHIPPED.
    ...(o.shippingBatchId ? { shippingBatch: { is: { status: 'READY' } } } : {}),
  };
}

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  version: true,
  confirmationStatus: true,
  shippingStatus: true,
  shippedAt: true,
  labelPrintedAt: true,
  shippingBatchId: true,
  deliveryProviderId: true,
  trackingNumber: true,
  courierSendStartedAt: true,
  regionId: true,
  deliveryFee: true,
  totalAmount: true,
  currency: true,
  customerId: true,
  shippingBatch: { select: { status: true, batchNumber: true } },
} as const;

/**
 * END THE ORDER, OR HAND IT BACK TO THE CONFIRMATION DESK — leaving the shipment cleanly either way.
 */
export async function endOrder(input: EndOrderInput): Promise<EndOutcome> {
  const o = await db.order.findFirst({
    where: { id: input.orderId, companyId: input.companyId, ...(input.storeId ? { storeId: input.storeId } : {}) },
    select: ORDER_SELECT,
  });
  if (!o) return refuse(404, 'NOT_FOUND', 'الطلب غير موجود');

  if (input.kind === 'CANCEL' && (ENDED as readonly string[]).includes(o.confirmationStatus)) {
    return refuse(409, 'ALREADY_ENDED', 'الطلب منتهي أصلاً — حدّث الصفحة.');
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== o.version) {
    return refuse(409, 'VERSION_CONFLICT', 'عدّل هذا الطلبَ شخصٌ آخر قبلك — أعد تحميل الصفحة ثم احفظ');
  }

  const facts: CancelFacts = {
    confirmationStatus: o.confirmationStatus,
    shippingStatus: o.shippingStatus,
    shippedAt: o.shippedAt,
    labelPrintedAt: o.labelPrintedAt,
    shippingBatchId: o.shippingBatchId,
    batchStatus: o.shippingBatch?.status ?? null,
  };
  const verdict = cancelVerdict(facts);
  if (!verdict.allowed) return refuse(409, verdict.code, verdict.message);
  if (verdict.needsAttestation && input.parcelInHand !== true) {
    return refuse(409, 'ATTESTATION_REQUIRED', ATTESTATION_NEEDED_AR, { attestation: ATTESTATION_AR });
  }

  const remote = await cancelAtCourier(
    {
      companyId: input.companyId,
      deliveryProviderId: o.deliveryProviderId,
      trackingNumber: o.trackingNumber,
      courierSendStartedAt: o.courierSendStartedAt,
    },
    input.inject
  );
  const refusal = remoteRefusal(remote);
  if (refusal) return refusal;

  const fromTrolley = !!(o.shippingBatchId || o.trackingNumber || o.labelPrintedAt);
  const target = input.kind === 'CANCEL' ? (input.endAs ?? 'CANCELLED') : String(input.data?.confirmationStatus ?? o.confirmationStatus);

  const base: Record<string, unknown> =
    input.kind === 'CANCEL'
      ? {
          confirmationStatus: target,
          status: target,
          ...(input.reason !== undefined ? { rejectionReason: input.reason } : {}),
          ...(input.rejectionNote !== undefined ? { rejectionNote: input.rejectionNote } : {}),
        }
      : {};
  const data = {
    ...base,
    ...(input.data ?? {}),
    ...leavesTheShipment({ fromTrolley }),
    version: { increment: 1 },
  };

  const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    input.tx ? fn(input.tx) : db.$transaction(fn);
  const wrote = await run(async (tx) => {
      const res = await tx.order.updateMany({ where: stillAsRead(o, input.companyId), data });
      if (res.count !== 1) throw new OrderMovedOn();

      // The contract's rule, in the same transaction as the decision: stock held
      // by an order that is not going anywhere is stock the next customer is
      // told we do not have. For packed goods the person's word was required above.
      await releaseOrderLines(tx, o.id);

      await tx.orderStatusLog.create({
        data: {
          companyId: input.companyId, orderId: o.id, statusType: 'CONFIRMATION',
          previousValue: o.confirmationStatus, newValue: target,
          changedById: input.by.id, changedByRole: input.by.role,
          note: input.logNote ?? input.reason ?? null,
        },
      });
      if (o.shippingStatus !== 'NOT_READY') {
        await tx.orderStatusLog.create({
          data: {
            companyId: input.companyId, orderId: o.id, statusType: 'SHIPPING',
            previousValue: o.shippingStatus, newValue: 'NOT_READY',
            changedById: input.by.id, changedByRole: input.by.role,
            note: input.logNote ?? input.reason ?? null,
          },
        });
      }
      await tx.orderActivity.create({
        data: {
          companyId: input.companyId, orderId: o.id, userId: input.by.id,
          action: 'STATUS_CHANGED', previousStatus: o.confirmationStatus, newStatus: target,
          metadata: JSON.stringify({ by: input.by.name ?? null, role: input.by.role, workflow: 'CONFIRMATION', door: input.door }),
        },
      });
      if (fromTrolley) {
        await tx.orderActivity.create({
          data: {
            companyId: input.companyId, orderId: o.id, userId: input.by.id,
            action: 'TAKEN_OFF_BATCH',
            metadata: JSON.stringify({
              ...takenOffFrom({
                shippingStatus: o.shippingStatus,
                labelPrintedAt: o.labelPrintedAt,
                trackingNumber: o.trackingNumber,
                deliveryProviderId: o.deliveryProviderId,
                batchNumber: o.shippingBatch?.batchNumber ?? null,
                courierName: remote.kind === 'CANCELLED' ? remote.courier : null,
              }),
              door: input.door,
              courierCancelled: remote.kind === 'CANCELLED',
            }),
          },
        });
      }
      if (verdict.needsAttestation) {
        await tx.orderActivity.create({
          data: {
            companyId: input.companyId, orderId: o.id, userId: input.by.id,
            action: 'PARCEL_ATTESTED_IN_HAND',
            metadata: JSON.stringify({ said: ATTESTATION_AR, by: input.by.name ?? null }),
          },
        });
      }
      // A note on the order only when the door wrote one: the status log already
      // carries the reason, and copying it here would say everything twice.
      if (input.noteBody) {
        await tx.orderNote.create({
          data: {
            companyId: input.companyId, orderId: o.id, authorId: input.by.id, kind: 'internal',
            body: input.noteBody,
          },
        });
      }
      if (input.kind === 'CANCEL') {
        // The same count the PATCH has always written, now at every door: the
        // recount (customer-counters) treats REJECTED and CANCELLED alike.
        await tx.customer.update({ where: { id: o.customerId }, data: { cancelledOrders: { increment: 1 } } });
      }
      if (input.viaRequest) {
        // ONCE: `appliedAt: null` makes a second, concurrent carry-out a no-op.
        await tx.orderChangeRequest.updateMany({
          where: { id: input.viaRequest.id, appliedAt: null },
          data: { appliedAt: new Date(), appliedById: input.by.id },
        });
      }
      return true;
    })
    .catch((e: unknown) => {
      if (e instanceof OrderMovedOn) return false;
      throw e;
    });
  if (!wrote) return movedOn(input, o, remote);

  let announced = false;
  const afterCommit = async (): Promise<void> => {
    if (announced) return;
    announced = true;
    if (verdict.needsAttestation) {
      await logAudit({
        companyId: input.companyId, userId: input.by.id, action: 'PARCEL_ATTESTED_IN_HAND',
        entity: 'Order', entityId: o.id,
        newData: { said: ATTESTATION_AR, door: input.door, by: input.by.name ?? null },
      });
    }

    // Tell the installed apps, after the commit and never able to undo it.
    // A rejection is not announced (it never was): only an order CANCELLED.
    if (input.kind === 'CANCEL' && target === 'CANCELLED') {
      if (o.shippingStatus !== 'NOT_READY') {
        // It had a shipping life: the shipping golden payload, never REJECTED in it.
        await emitAppEvent(input.companyId, 'order.cancelled', {
          orderId: o.id,
          orderNumber: o.orderNumber,
          shippingStatus: 'CANCELLED',
          previousStatus: o.shippingStatus,
          total: Number(o.totalAmount),
          currency: o.currency,
          trackingNumber: o.trackingNumber ?? null,
        });
      } else {
        await emitAppEvent(input.companyId, 'order.cancelled', {
          orderId: o.id,
          orderNumber: o.orderNumber,
          confirmationStatus: 'CANCELLED',
          previousStatus: o.confirmationStatus,
          total: Number(o.totalAmount),
          currency: o.currency,
        });
      }
    }
  };
  // Inside the caller's transaction nothing is announced yet: it may still roll back.
  if (!input.tx) await afterCommit();

  return {
    ok: true,
    orderNumber: o.orderNumber,
    attested: verdict.needsAttestation,
    tookOff: fromTrolley,
    courierCancelled: remote.kind === 'CANCELLED',
    afterCommit,
  };
}

/**
 * THE WRITE LOST A RACE. If the company had already said yes, that is the one
 * outcome that must not be silent: its waybill is gone and ours is not.
 */
async function movedOn(
  input: { companyId: string; by: { id: string }; door: string },
  read: { id: string; courierSendStartedAt: Date | null },
  remote: RemoteCancel
): Promise<EndOutcome> {
  const orderId = read.id;
  if (remote.kind !== 'CANCELLED') {
    /*
     * THE ONE LOSS WORTH NAMING: a dispatcher claimed the order for the company
     * after we read it. Its parcel may be coming into existence right now, so the
     * answer is not «refresh» — it is «it is being sent; wait or ask them».
     */
    if (!read.courierSendStartedAt) {
      const now = await db.order
        .findFirst({ where: { id: orderId, companyId: input.companyId }, select: { courierSendStartedAt: true } })
        .catch(() => null);
      if (now?.courierSendStartedAt) return refuse(409, 'SEND_IN_FLIGHT', IN_TRANSIT_NOW_AR);
    }
    return refuse(409, 'ORDER_MOVED_ON', MOVED_AR);
  }
  await db.orderActivity
    .create({
      data: {
        companyId: input.companyId, orderId, userId: input.by.id,
        action: 'COURIER_CANCELLED_ORDER_MOVED',
        metadata: JSON.stringify({ barcode: remote.barcode, courier: remote.courier, door: input.door }),
      },
    })
    .catch(() => undefined);
  return refuse(
    409,
    'COURIER_CANCELLED_BUT_MOVED',
    `${remote.courier?.trim() || 'الشركة'} ألغت الطرد، لكن الطلب تغيّر قبل ما يُحفظ الإلغاء عندنا — افتح الطلب وراجعه.`
  );
}

/** A courier's non-yes, as the refusal the screen shows; null when the way is clear. */
function remoteRefusal(remote: RemoteCancel): EndOutcome | null {
  if (remote.kind === 'IN_FLIGHT') return refuse(409, 'SEND_IN_FLIGHT', IN_TRANSIT_NOW_AR);
  if (remote.kind === 'REFUSED') return refuse(409, 'COURIER_REFUSED', refusedAr(remote.courier, remote.said));
  if (remote.kind === 'UNKNOWN') return refuse(409, 'COURIER_UNSURE', notSureAr(remote.courier));
  return null;
}

export interface HoldFromTrolleyInput {
  orderId: string;
  companyId: string;
  storeId?: string | null;
  by: { id: string; name?: string | null; role: string };
  until: Date;
  reason: string | null;
  viaRequest?: { id: string } | null;
  inject?: { adapter?: CourierAdapter; courierName?: string | null };
}

export type HoldOutcome =
  | { ok: true; orderNumber: string; courierCancelled: boolean }
  | { ok: false; status: number; code: string; error: string };

/**
 * «أجّل الشحن» FOR A PARCEL ON A TROLLEY.
 *
 * The goods and the waybill STAY — the box is not opened, so no attestation
 * and no stock moves. What changes is that the parcel is no longer on the
 * trolley the press is about to hand over. A parcel the company already has
 * is cancelled THERE first (postponing an API parcel is cancelling it now and
 * sending it again later), and only a clear yes lets the order change.
 */
export async function holdFromTrolley(input: HoldFromTrolleyInput): Promise<HoldOutcome> {
  const o = await db.order.findFirst({
    where: { id: input.orderId, companyId: input.companyId, ...(input.storeId ? { storeId: input.storeId } : {}) },
    select: ORDER_SELECT,
  });
  if (!o) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'الطلب غير موجود' };

  const verdict = cancelVerdict({
    confirmationStatus: o.confirmationStatus,
    shippingStatus: o.shippingStatus,
    shippedAt: o.shippedAt,
    labelPrintedAt: o.labelPrintedAt,
    shippingBatchId: o.shippingBatchId,
    batchStatus: o.shippingBatch?.status ?? null,
  });
  if (!verdict.allowed) return { ok: false, status: 409, code: verdict.code, error: verdict.message };

  const remote = await cancelAtCourier(
    {
      companyId: input.companyId,
      deliveryProviderId: o.deliveryProviderId,
      trackingNumber: o.trackingNumber,
      courierSendStartedAt: o.courierSendStartedAt,
    },
    input.inject
  );
  const refusal = remoteRefusal(remote);
  if (refusal && !refusal.ok) return { ok: false, status: refusal.status, code: refusal.code, error: refusal.error };

  const data = {
    ...leavesTheTrolley(),
    // The company's waybill is gone with the cancel above; the next send makes a new one.
    // A number typed by hand for a courier nobody calls stays: it is on the label that stays.
    // The waybill on the box carries THEIR barcode, which is cancelled: it goes too (reprinted with the next send).
    ...(remote.kind === 'CANCELLED' ? { trackingNumber: null, courierSendStartedAt: null, labelPrintedAt: null } : {}),
    shipHoldUntil: input.until,
    shipHoldReason: input.reason,
    version: { increment: 1 },
  };

  const wrote = await db
    .$transaction(async (tx) => {
      const res = await tx.order.updateMany({ where: stillAsRead(o, input.companyId), data });
      if (res.count !== 1) throw new OrderMovedOn();
      await tx.orderActivity.create({
        data: {
          companyId: input.companyId, orderId: o.id, userId: input.by.id,
          action: 'TAKEN_OFF_BATCH',
          metadata: JSON.stringify({
            ...takenOffFrom({
              shippingStatus: o.shippingStatus,
              labelPrintedAt: o.labelPrintedAt,
              trackingNumber: o.trackingNumber,
              deliveryProviderId: o.deliveryProviderId,
              batchNumber: o.shippingBatch?.batchNumber ?? null,
              courierName: remote.kind === 'CANCELLED' ? remote.courier : null,
            }),
            door: 'HOLD',
            courierCancelled: remote.kind === 'CANCELLED',
            // The goods and the label stay with the order.
            stock: 'KEPT',
          }),
        },
      });
      if (input.viaRequest) {
        await tx.orderChangeRequest.updateMany({
          where: { id: input.viaRequest.id, appliedAt: null },
          data: { appliedAt: new Date(), appliedById: input.by.id },
        });
      }
      return true;
    })
    .catch((e: unknown) => {
      if (e instanceof OrderMovedOn) return false;
      throw e;
    });
  if (!wrote) {
    const lost = await movedOn({ ...input, door: 'HOLD' }, o, remote);
    return { ok: false, status: 409, code: lost.ok ? 'ORDER_MOVED_ON' : lost.code, error: lost.ok ? MOVED_AR : lost.error };
  }

  return { ok: true, orderNumber: o.orderNumber, courierCancelled: remote.kind === 'CANCELLED' };
}

/**
 * LET GO OF THE COMPANY'S COPY OF THE PARCEL — before the order changes under it.
 *
 * A parcel sent by API exists twice. Anything that changes what the company
 * was told (who carries it, what is in the box, what he collects) while its
 * waybill is alive leaves THEM holding the old parcel. So the company is asked
 * to cancel first — outside any transaction, and only a clear yes lets the
 * caller clear the barcode and the claim in its own conditional write. A
 * manual company, or no barcode at all, needs nothing.
 */
export type ParcelReleased =
  | {
      ok: true;
      remote: RemoteCancel;
      courierCancelled: boolean;
      /** The columns to add to the caller's write so our copy agrees with theirs. */
      cleared: Record<string, unknown>;
    }
  | { ok: false; status: number; code: string; error: string };

export async function releaseCourierParcel(
  o: {
    companyId: string;
    deliveryProviderId: string | null;
    trackingNumber: string | null;
    courierSendStartedAt: Date | string | null;
  },
  inject?: { adapter?: CourierAdapter; courierName?: string | null }
): Promise<ParcelReleased> {
  const remote = await cancelAtCourier(
    {
      companyId: o.companyId,
      deliveryProviderId: o.deliveryProviderId,
      trackingNumber: o.trackingNumber,
      courierSendStartedAt: o.courierSendStartedAt,
    },
    inject
  );
  const refusal = remoteRefusal(remote);
  if (refusal && !refusal.ok) return { ok: false, status: refusal.status, code: refusal.code, error: refusal.error };
  return {
    ok: true,
    remote,
    courierCancelled: remote.kind === 'CANCELLED',
    cleared: remote.kind === 'CANCELLED' ? { trackingNumber: null, courierSendStartedAt: null } : {},
  };
}

class TargetTrolleyClosed extends Error {
  constructor() {
    super('TARGET_TROLLEY_CLOSED');
  }
}

export interface MoveBeforeHandoverInput {
  orderId: string;
  companyId: string;
  storeId?: string | null;
  by: { id: string; name?: string | null; role: string };
  /** The company or agent the parcel was assigned to when the person looked. A different one now means someone else moved it. */
  fromProviderId: string;
  fromName: string | null;
  to: { id: string; name: string };
  /** The new company's open trolley, or null for an agent (he takes it by hand). */
  toBatchId: string | null;
  /** The country's smallest unit — the fee is compared in it, so 3-place currencies do not lose a fils. */
  minorUnit: number;
  note: string | null;
  /** «الطرد بين يديّ — أتلفتُ بوليصته القديمة…» — required when the waybill is printed. */
  parcelInHand?: boolean;
  inject?: { adapter?: CourierAdapter; courierName?: string | null };
}

export type MoveOutcome =
  | { ok: true; orderNumber: string; courierCancelled: boolean; waybillReset: boolean }
  | { ok: false; status: number; code: string; error: string; attestation?: string };

export const HANDED_NOW_AR = 'الطرد انسلّم للشركة للتو — التحويل الآن بيصير بطلب بديل. حدّث الصفحة وجرّب من جديد.';
export const TARGET_CLOSED_AR = 'الدفعة الجديدة انغلقت — جرّب دفعة تانية.';

/** The new company charges another fee than the order carries: the customer's total would change, and a transfer never does that. */
export const feeDiffersAr = (now: string, was: string) =>
  `أجرة الشركة الجديدة غير أجرة الطلب (${now} بدل ${was}) — أجّل الطلب وضعه بدفعتها ليتحسب من جديد.`;
export const NO_FEE_FOR_REGION_AR = 'الشركة الجديدة ما إلها أجرة لهالمحافظة — أجّل الطلب وضعه بدفعتها بعد ما تنضاف الأجرة.';
export const MOVED_FROM_AR = 'الطرد تغيّر مكانه أثناء العمل عليه — حدّث الصفحة وجرّب من جديد.';

/**
 * A PARCEL THAT THE COMPANY NEVER TOOK MOVES TO ANOTHER COMPANY AS THE SAME ORDER.
 *
 * (The owner, 28/10: «قبل التسليم: نفس الطلب».) Until «إغلاق الشحنة — سُلّمت
 * للشركة» the box is on our floor, so «transfer» is not a recall and not a
 * replacement: the order keeps its id, its number, its lines and the units
 * reserved under its name — nothing is raised and nothing counted back. What
 * changes is who carries it and which trolley it is on.
 *
 *   ASKS    `cancelVerdict` — the same gate as every cancel door: a pressed
 *           trolley is the company's now, and an unreadable one is refused.
 *   KEEPS   the customer's total: the NEW company's fee for the order's region must
 *           equal the fee the order carries (in the currency's smallest unit), or the
 *           move is refused — before any call to the old company. A transfer never
 *           re-prices; «أجّل ثم ضعه بدفعة» is the door that does (`resolveDeliveryFee`).
 *   WANTS   a person's word when the waybill is printed: it names the old
 *           company and its barcode, so it is destroyed, not carried over.
 *   TELLS   the old company, for a barcode it already holds (outside any
 *           transaction; only a clear yes lets the order change).
 *   WRITES  ONE conditional update (version, trolley, barcode, claim — a press
 *           or a dispatch that lands first makes it find nothing), after a lock
 *           on the NEW trolley so a press of it cannot miss this parcel.
 */
export async function moveBeforeHandover(input: MoveBeforeHandoverInput): Promise<MoveOutcome> {
  const o = await db.order.findFirst({
    where: { id: input.orderId, companyId: input.companyId, ...(input.storeId ? { storeId: input.storeId } : {}) },
    select: ORDER_SELECT,
  });
  if (!o) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'الطلب غير موجود' };
  if (o.deliveryProviderId !== input.fromProviderId) return { ok: false, status: 409, code: 'ORDER_MOVED_ON', error: MOVED_FROM_AR };

  const verdict = cancelVerdict({
    confirmationStatus: o.confirmationStatus,
    shippingStatus: o.shippingStatus,
    shippedAt: o.shippedAt,
    labelPrintedAt: o.labelPrintedAt,
    shippingBatchId: o.shippingBatchId,
    batchStatus: o.shippingBatch?.status ?? null,
  });
  if (!verdict.allowed) {
    return {
      ok: false,
      status: 409,
      code: verdict.code === 'UNKNOWN_BATCH' ? 'UNKNOWN_BATCH' : 'HANDED_OVER',
      error: verdict.code === 'UNKNOWN_BATCH' ? verdict.message : HANDED_NOW_AR,
    };
  }

  const waybill = !!o.labelPrintedAt;
  if (waybill && input.parcelInHand !== true) {
    return {
      ok: false,
      status: 409,
      code: 'ATTESTATION_REQUIRED',
      error: WAYBILL_ATTESTATION_NEEDED_AR,
      attestation: WAYBILL_ATTESTATION_AR,
    };
  }

  /*
   * THE CUSTOMER'S TOTAL DOES NOT CHANGE (the owner: «اي قرار بعد الان اتخذو دون الرجوع الي»).
   *
   * The fee on the order is a snapshot of the OLD company's table, and the COD was
   * priced with it. Moving the order to a company that charges another fee would
   * leave a total that no table explains; re-pricing it here would change what the
   * customer pays on a transfer nobody asked to re-price. So an equal fee passes and
   * anything else is refused — and it is asked FIRST, before the old company is told
   * to cancel a parcel for a move that will not happen.
   */
  const newFee = await resolveDeliveryFee(db, {
    deliveryProviderId: input.to.id,
    regionId: o.regionId ?? null,
    minorUnit: input.minorUnit,
  });
  if (newFee.source === 'NONE') {
    return { ok: false, status: 409, code: 'NO_FEE_ROW', error: NO_FEE_FOR_REGION_AR };
  }
  const was = roundMinor(Number(o.deliveryFee ?? 0), input.minorUnit);
  if (newFee.fee !== was) {
    return {
      ok: false,
      status: 409,
      code: 'FEE_DIFFERS',
      error: feeDiffersAr(newFee.fee.toFixed(input.minorUnit), was.toFixed(input.minorUnit)),
    };
  }

  /*
   * THE NEW TROLLEY IS READ BEFORE THE OLD COMPANY IS TOLD ANYTHING. Cancelling a
   * parcel at the old company and only then finding the new trolley already pressed
   * leaves the company with nothing and the order with a dead barcode. The write
   * below still takes the trolley's lock (the read can be overtaken); this makes the
   * ordinary case — a trolley that closed a minute ago — fail before it costs anything.
   */
  if (input.toBatchId) {
    const target = await db.shippingBatch.findFirst({
      where: { id: input.toBatchId, companyId: input.companyId, deliveryProviderId: input.to.id },
      select: { status: true },
    });
    if (!target || target.status !== 'READY') {
      return { ok: false, status: 409, code: 'TARGET_BATCH_CLOSED', error: TARGET_CLOSED_AR };
    }
  }

  const released = await releaseCourierParcel(
    {
      companyId: input.companyId,
      deliveryProviderId: o.deliveryProviderId,
      trackingNumber: o.trackingNumber,
      courierSendStartedAt: o.courierSendStartedAt,
    },
    input.inject
  );
  if (!released.ok) return released;
  const remote = released.remote;

  const data = {
    deliveryProviderId: input.to.id,
    shippingBatchId: input.toBatchId,
    deliveryAssignedAt: new Date(),
    deliveryAssignedById: input.by.id,
    // The old company's barcode and claim are not ours to carry to the new one.
    trackingNumber: null,
    courierSendStartedAt: null,
    // The waybill on the box names the old company: it is stale, printed again for the new one.
    labelPrintedAt: null,
    version: { increment: 1 },
  };

  const wrote = await db
    .$transaction(async (tx) => {
      if (input.toBatchId) {
        // Take the new trolley's row lock first (the press takes it first too), and only while it is still being filled.
        const open = await tx.shippingBatch.updateMany({
          where: { id: input.toBatchId, companyId: input.companyId, deliveryProviderId: input.to.id, status: 'READY' },
          data: { status: 'READY' },
        });
        if (open.count !== 1) throw new TargetTrolleyClosed();
      }
      const res = await tx.order.updateMany({ where: stillAsRead(o, input.companyId), data });
      if (res.count !== 1) throw new OrderMovedOn();

      await tx.orderActivity.create({
        data: {
          companyId: input.companyId, orderId: o.id, userId: input.by.id,
          action: 'COURIER_TRANSFERRED',
          newStatus: o.shippingStatus,
          // mode REBATCH, never REPLACE: nothing was replaced, so `isSuperseded` must not read this.
          metadata: JSON.stringify({
            mode: 'REBATCH',
            from: input.fromName,
            to: input.to.name,
            note: input.note,
            ...takenOffFrom({
              shippingStatus: o.shippingStatus,
              labelPrintedAt: o.labelPrintedAt,
              trackingNumber: o.trackingNumber,
              deliveryProviderId: o.deliveryProviderId,
              batchNumber: o.shippingBatch?.batchNumber ?? null,
              courierName: input.fromName,
            }),
            courierCancelled: remote.kind === 'CANCELLED',
            // The same order, the same units: nothing is counted back and nothing is reserved twice.
            stock: 'KEPT',
          }),
        },
      });
      if (waybill) {
        await tx.orderActivity.create({
          data: {
            companyId: input.companyId, orderId: o.id, userId: input.by.id,
            action: 'PARCEL_ATTESTED_IN_HAND',
            metadata: JSON.stringify({ said: WAYBILL_ATTESTATION_AR, by: input.by.name ?? null, kind: 'WAYBILL' }),
          },
        });
      }
      return true as const;
    })
    .catch((e: unknown) => {
      if (e instanceof OrderMovedOn || e instanceof TargetTrolleyClosed) return e;
      throw e;
    });

  if (wrote !== true) {
    // The company may already have said yes to the cancel: never silent about that.
    const lost = await movedOn({ ...input, door: 'TRANSFER' }, o, remote);
    if (wrote instanceof TargetTrolleyClosed && remote.kind !== 'CANCELLED') {
      return { ok: false, status: 409, code: 'TARGET_BATCH_CLOSED', error: TARGET_CLOSED_AR };
    }
    return lost.ok ? { ok: false, status: 409, code: 'ORDER_MOVED_ON', error: MOVED_AR } : lost;
  }

  if (waybill) {
    await logAudit({
      companyId: input.companyId, userId: input.by.id, action: 'PARCEL_ATTESTED_IN_HAND',
      entity: 'Order', entityId: o.id,
      newData: { said: WAYBILL_ATTESTATION_AR, door: 'TRANSFER', by: input.by.name ?? null },
    });
  }

  return { ok: true, orderNumber: o.orderNumber, courierCancelled: remote.kind === 'CANCELLED', waybillReset: waybill };
}
