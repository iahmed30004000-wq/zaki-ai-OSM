import type { SessionUser } from '@/types/auth';
import { logAudit } from './audit';
import { authorize } from './authorization';
import { db } from './db';
import { canEnterShipping, isValidShippingTransition } from './shipping-workflow';
import { editLockHeldByAnother, recordShippingMove, shippingAuditEntry, shippingMoveColumns } from './shipping-move';

/**
 * «خرج للتوصيل لكل الدفعة» — EVERY SHIPPED PARCEL OF A BATCH, MOVED TO «خرج للتوصيل» BY ONE PRESS.
 *
 * (2/11) «خرج للتوصيل» is written by a person, order by order, on the shipping card — `SHIPPED → OUT_FOR_DELIVERY`, the
 * order's own door — unless the courier is connected by API and the parcel has a barcode, when the poll writes it as the driver
 * scans. A courier worked by hand has no poll, so after the press of «إغلاق الشحنة — سُلّمت للشركة» a 160-parcel batch stood at
 * «مشحون» for as many presses as it had parcels. This is that press, once for the batch.
 *
 * IT IS THE ORDER'S OWN MOVE, REPEATED — NOT A SECOND WAY TO MOVE AN ORDER. For every parcel it asks what the order's door asks
 * (the person's scope over THAT order, an edit lock, a confirmed order, the transition table, a blocking change request, the
 * version it read) and writes what the order's door writes (`shippingMoveColumns`, the timeline line, the activity row and the
 * audit row — `shipping-move.ts` is the one place that writes them). It adds nothing: OUT_FOR_DELIVERY announces nothing to the
 * apps, takes nothing off a shelf, moves no money and calls no customer, and the order's door does none of that for it either.
 *
 * A PARCEL THAT CANNOT MOVE NEVER STOPS THE REST. Not «مشحون» any more → SKIPPED (counted, never an error: pressing twice, or the
 * poll got there first, is not a fault). Refused or changed under the press → FAILED, named, with the sentence the person can
 * act on. The rest still go. Each parcel is one transaction — its status and its rows land together or not at all.
 *
 * WHAT IS NEVER MOVED HERE: DELIVERED, RETURNED, CANCELLED. They move money or reverse it, and only the person at the door
 * knows which (`COURIER_CANNOT_ASSERT`); this door moves a parcel exactly one step, to the road.
 */

const FROM = 'SHIPPED' as const;
const TO = 'OUT_FOR_DELIVERY' as const;

/** Why one parcel did not move. A code for the machine, a sentence for the person. */
export type OutFailureCode =
  | 'OUT_OF_SCOPE'
  | 'ORDER_LOCKED'
  | 'CONFIRMATION_REQUIRED'
  | 'INVALID_TRANSITION'
  | 'CHANGE_REQUEST_PENDING'
  | 'VERSION_CONFLICT'
  | 'SAVE_FAILED';

export const OUT_FAILURE_AR: Record<OutFailureCode, string> = {
  OUT_OF_SCOPE: 'هذا الطلب ليس من طلباتك — لا تملك صلاحية تغيير حالة شحنه.',
  ORDER_LOCKED: 'موظف آخر يعدّل هذا الطلب الآن — جرّب بعد قليل.',
  CONFIRMATION_REQUIRED: 'الطلب غير مؤكَّد — أكِّده أولاً.',
  INVALID_TRANSITION: 'حالة شحنه لا تسمح بالانتقال إلى «خرج للتوصيل».',
  CHANGE_REQUEST_PENDING: 'عليه طلب تعديل قيد المراجعة — يُبتّ فيه أولاً.',
  VERSION_CONFLICT: 'عدّله شخص آخر قبلك — اضغط من جديد.',
  SAVE_FAILED: 'تعذّر حفظ الطلب — اضغط من جديد.',
};

export interface OutForDeliveryFailure {
  orderNumber: string;
  code: OutFailureCode;
  errorAr: string;
}

export interface OutForDeliveryResult {
  /** Parcels the batch holds, in any state. 0 = nothing to press on. */
  total: number;
  moved: number;
  skipped: number;
  failed: number;
  /** The numbers of the parcels that did not move, in the order the batch lists them. */
  failedOrders: string[];
  failures: OutForDeliveryFailure[];
}

/** What the gates and the move read of a parcel: the facts `authorize` and the order's door ask, and the version to guard on. */
const MEMBER_SELECT = {
  id: true, orderNumber: true, companyId: true, version: true,
  shippingStatus: true, confirmationStatus: true,
  assignedToId: true, claimedById: true, currentOwnerId: true, moderatorId: true,
  lockedById: true, lockExpiresAt: true,
  deliveryProviderId: true, trackingNumber: true,
} as const;

type Member = {
  id: string; orderNumber: string; companyId: string; version: number;
  shippingStatus: string; confirmationStatus: string;
  assignedToId: string | null; claimedById: string | null; currentOwnerId: string | null; moderatorId: string | null;
  lockedById: string | null; lockExpiresAt: Date | null;
  deliveryProviderId: string | null; trackingNumber: string | null;
};

export async function moveBatchOutForDelivery(input: {
  user: SessionUser;
  companyId: string;
  storeId: string;
  batch: { id: string; batchNumber: string };
}): Promise<OutForDeliveryResult> {
  const { user, companyId, storeId, batch } = input;

  const members: Member[] = await db.order.findMany({
    where: { shippingBatchId: batch.id, companyId, storeId },
    orderBy: { createdAt: 'asc' },
    select: MEMBER_SELECT,
  });

  const candidates = members.filter((m) => m.shippingStatus === FROM);
  const result: OutForDeliveryResult = {
    total: members.length,
    moved: 0,
    skipped: members.length - candidates.length,
    failed: 0,
    failedOrders: [],
    failures: [],
  };
  if (candidates.length === 0) return result;

  const fail = (m: Member, code: OutFailureCode) => {
    result.failed++;
    result.failedOrders.push(m.orderNumber);
    result.failures.push({ orderNumber: m.orderNumber, code, errorAr: OUT_FAILURE_AR[code] });
  };

  /*
   * A BLOCKING CHANGE REQUEST STOPS OUR FORWARD TRANSITIONS (contract invariant 7) — the order's door asks it with
   * `findFirst({ orderId, status: 'PENDING', blocking: true })` for every forward move, OUT_FOR_DELIVERY among them. Asked here
   * once for the whole batch, with the same predicate; `the-batch-door-moves-what-the-order-door-moves.test.ts` holds the two
   * texts together.
   */
  const blocking = await db.orderChangeRequest.findMany({
    where: { orderId: { in: candidates.map((m) => m.id) }, status: 'PENDING', blocking: true },
    select: { orderId: true },
  });
  const blocked = new Set<string>(blocking.map((b: { orderId: string }) => b.orderId));

  const now = new Date();
  const by = { id: user.id, name: user.name, role: user.role };

  for (const m of candidates) {
    // The gates, in the order the order's door asks them: whose it is → who is editing it → confirmed → the table → the request.
    const refused: OutFailureCode | null = !authorize(user, 'orders.change_status', m).allowed
      ? 'OUT_OF_SCOPE'
      : editLockHeldByAnother(m, user)
        ? 'ORDER_LOCKED'
        : !canEnterShipping(m.confirmationStatus)
          ? 'CONFIRMATION_REQUIRED'
          : !isValidShippingTransition(m.shippingStatus, TO)
            ? 'INVALID_TRANSITION'
            : blocked.has(m.id)
              ? 'CHANGE_REQUEST_PENDING'
              : null;
    if (refused) {
      fail(m, refused);
      continue;
    }

    try {
      const written = await db.$transaction(async (tx) => {
        // The version the parcel was read at is the guard (as the order's door guards on `expectedVersion`); the status and the
        // trolley are asked again in the same statement, so a parcel that left in between is not written over.
        const res = await tx.order.updateMany({
          where: { id: m.id, companyId, storeId, shippingBatchId: batch.id, shippingStatus: FROM, version: m.version },
          data: { ...shippingMoveColumns(TO, now), version: { increment: 1 } },
        });
        if (res.count !== 1) return false;
        await recordShippingMove(tx, {
          companyId, orderId: m.id, from: FROM, to: TO, user: by,
          logNote: `خرجت الدفعة ${batch.batchNumber} للتوصيل`,
          typedNote: null,
          provider: m.deliveryProviderId || null,
        });
        return true;
      });

      if (!written) {
        // Somebody wrote the parcel between the read and the press. If it is no longer «مشحون» it is not ours to move any more
        // (the poll got there first, or the door did): counted like any other parcel that is not waiting. If it still is, it was
        // edited — and the person is told to press again.
        const current = await db.order.findFirst({ where: { id: m.id, companyId, storeId }, select: { shippingStatus: true } });
        if (current && current.shippingStatus !== FROM) result.skipped++;
        else fail(m, 'VERSION_CONFLICT');
        continue;
      }
    } catch (error) {
      console.error('out-for-delivery: a parcel did not save', m.orderNumber, error);
      fail(m, 'SAVE_FAILED');
      continue;
    }

    await logAudit(shippingAuditEntry({
      companyId, userId: user.id, orderId: m.id,
      from: FROM, to: TO, trackingNumber: m.trackingNumber,
      action: 'transition', by: user.name,
    }));
    result.moved++;
  }

  if (result.moved > 0) {
    await logAudit({
      companyId, userId: user.id, action: 'SHIPPING_BATCH_OUT_FOR_DELIVERY',
      entity: 'ShippingBatch', entityId: batch.id,
      previousData: { status: FROM, parcels: candidates.length },
      newData: { status: TO, moved: result.moved, skipped: result.skipped, failed: result.failed, by: user.name },
    });
  }

  return result;
}
