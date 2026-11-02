import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/types/auth';
import { can } from './authorization';
import type { db } from './db';
import { STATUS_TIMESTAMP, type ShippingStatus } from './shipping-workflow';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * WHAT A MOVE OF THE SHIPPING STATUS WRITES, IN ONE PLACE.
 *
 * Two doors move an order's shipping status by a person's press: the order's own door
 * (`/api/orders/[id]/shipping`) and the batch's «خرج للتوصيل لكل الدفعة»
 * (`/api/shipping-batches/[id]/out-for-delivery`, 2/11 — a 160-parcel batch was 160 presses, one order at a time). They must
 * leave the same trace: the same columns on the order, the same line on the status timeline, the same activity row and the
 * same audit row. A second copy of these four would drift — the way the six vocabularies for the same twelve states did
 * (see `SHIPPING_STATUS_AR`) — so both doors call the functions below and neither writes them by hand.
 *
 * What is NOT here, on purpose: the gates (confirmed, the transition table, a blocking change request, the version), the stock a
 * delivery takes off the shelf, the apps' events and the delivery attempt. They belong to the door that needs them; the batch
 * door asks the same gates itself (`batch-out-for-delivery.ts`) and never reaches the stock — OUT_FOR_DELIVERY takes nothing off
 * a shelf and announces nothing.
 */

/**
 * THE COLUMNS A MOVE TO `to` WRITES — the status, the server's own timestamp for it (`STATUS_TIMESTAMP`, never a client's),
 * and the legacy combined `status` kept in step for the lists that still read it. A delivery also marks the COD collected.
 */
export function shippingMoveColumns(to: ShippingStatus, now: Date): Record<string, unknown> {
  const columns: Record<string, unknown> = { shippingStatus: to };
  // Server-set timestamp (never client)
  const tsField = STATUS_TIMESTAMP[to];
  if (tsField) columns[tsField] = now;
  // Legacy combined status sync for list compatibility
  if (to === 'SHIPPED') columns.status = 'SHIPPED';
  if (to === 'DELIVERED') {
    columns.status = 'DELIVERED';
    // Match the legacy PATCH behavior: delivery marks the COD collected
    columns.settlementStatus = 'COLLECTED';
  }
  if (to === 'RETURNED') columns.status = 'RETURNED';
  return columns;
}

/**
 * THE TWO ROWS A MOVE LEAVES ON THE ORDER'S OWN HISTORY: the line on the status timeline («الشحن: مشحون ← خرج للتوصيل») and
 * the activity row. Written after the order itself moved; `tx` is the transaction when the caller has one open, `db` when it
 * does not.
 *
 * `logNote` is the sentence under the timeline line; `typedNote` is what the person typed beside the press (the activity row
 * keeps it apart from the log's note, as the order's door always has).
 */
export async function recordShippingMove(
  tx: Tx,
  input: {
    companyId: string;
    orderId: string;
    from: string;
    to: string;
    user: { id: string; name: string; role: string };
    logNote: string | null;
    typedNote: string | null;
    /** The courier the move is made under: the one just assigned, or the one on the order. */
    provider: string | null;
  }
): Promise<void> {
  const { companyId, orderId, from, to, user } = input;
  await tx.orderStatusLog.create({
    data: {
      companyId, orderId, statusType: 'SHIPPING',
      previousValue: from, newValue: to,
      changedById: user.id, changedByRole: user.role,
      note: input.logNote,
    },
  });
  await tx.orderActivity.create({
    data: {
      companyId, orderId, userId: user.id,
      action: 'SHIPPING_STATUS_CHANGED', previousStatus: from, newStatus: to,
      metadata: JSON.stringify({
        by: user.name, role: user.role,
        provider: input.provider,
        note: input.typedNote,
      }),
    },
  });
}

/**
 * THE AUDIT ROW OF A SHIPPING ACTION, as the argument of `logAudit`. A status that changed is «تغيير حالة الشحن»; anything else
 * the door was asked to do (a tracking number, a courier, a batch) is «تعديل معلومات الشحن» — `to` is null then.
 */
export function shippingAuditEntry(input: {
  companyId: string;
  userId: string;
  orderId: string;
  from: string;
  to: string | null;
  trackingNumber: string | null;
  /** The door's own name for what it was asked to do (`transition`, `assign_batch`…). */
  action: string;
  by: string;
}) {
  return {
    companyId: input.companyId,
    userId: input.userId,
    action: input.to ? 'SHIPPING_STATUS_CHANGED' : 'SHIPPING_INFO_UPDATED',
    entity: 'Order',
    entityId: input.orderId,
    previousData: { shippingStatus: input.from, trackingNumber: input.trackingNumber },
    newData: { shippingStatus: input.to, action: input.action, by: input.by },
  };
}

/**
 * IS SOMEBODY ELSE EDITING THIS ORDER RIGHT NOW? An active lock held by another person blocks a status move unless the one
 * moving it may break locks (`orders.unlock`). Their own lock never blocks them, and an expired one blocks nobody.
 */
export function editLockHeldByAnother(
  order: { lockedById?: string | null; lockExpiresAt?: Date | string | null },
  user: SessionUser
): boolean {
  const lockActive = order.lockedById && order.lockExpiresAt && new Date(order.lockExpiresAt).getTime() > Date.now();
  return !!(lockActive && order.lockedById !== user.id && !can(user, 'orders.unlock'));
}
