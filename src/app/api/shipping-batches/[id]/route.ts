import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { noteCustomersHandedOut } from '@/lib/pii-alert';

import { logAudit } from '@/lib/audit';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { redactCustomerForWarehouse } from '@/lib/operations';
import { BATCH_STATUSES, EMPTY_BATCH_AR, checkStep, pendingChangesMessage, type BatchStatus } from '@/lib/batch-steps';
import { emitAppEvent } from '@/lib/apps/events';

/** The batch was moved by someone else between the read and the write. */
class BatchMoved extends Error {}
/** The press found nothing to hand over: an empty trolley is not a handover. */
class EmptyBatch extends Error {}
/** A parcel changed between the list of members and the stamp — the whole press stops. */
class MembersMoved extends Error {}
/** Parcels with a cancel or a postponement still unanswered. */
class PendingChanges extends Error {
  constructor(readonly orderNumbers: string[]) {
    super('PENDING_CHANGES');
  }
}

/**
 * PATCH /api/shipping-batches/[id] — update status/notes/provider (company-scoped)
 * Body: { status?: 'READY'|'SHIPPED'|'CLOSED', notes?, deliveryProviderId? }
 *
 * Marking a batch SHIPPED also stamps shippedAt on all its orders that are
 * still in READY_FOR_PICKUP (server timestamps only).
 */
/**
 * GET /api/shipping-batches/[id] — one batch with the orders it holds.
 *
 * The keys of the batches screen, which is the only thing that reads it —
 * and it reads only the order numbers and barcodes, to check parcels
 * against. `orders.view` used to be enough, with its scope ignored, and the
 * answer carried every customer's name and phone. The phone now goes only
 * with the address-book key, as on the labels and returns screens.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, companyId, storeId } = await requireContext();
    const { id } = await params;
    if (!can(user, 'ops.ship') && !can(user, 'ops.track')) {
      return NextResponse.json({ error: 'دفعات الشحن ليست من صلاحيّاتك.', errorAr: 'دفعات الشحن ليست من صلاحيّاتك.' }, { status: 403 });
    }
    const maySeeContact = can(user, 'customers.view');

    const batch = await db.shippingBatch.findFirst({
      where: { id, companyId, ...(storeId ? { storeId } : {}) },
      include: {
        provider: { select: { id: true, name: true, code: true, kind: true } },
        creator: { select: { id: true, name: true } },
        orders: {
          select: {
            id: true, orderNumber: true, merchantRef: true, totalAmount: true,
            trackingNumber: true, shippingStatus: true,
            customer: { select: { fullName: true, phone: true, city: true } },
            region: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!batch) return NextResponse.json({ error: 'الدفعة غير موجودة' }, { status: 404 });

    // A batch is a list of parcels, and every parcel carries a person.
    await noteCustomersHandedOut({
      companyId, storeId, user, where: 'دفعة شحن', rows: batch.orders,
    });

    return NextResponse.json({
      batch: { ...batch, orders: batch.orders.map((o) => ({ ...o, customer: redactCustomerForWarehouse(o.customer, maySeeContact) })) },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    if (!can(user, 'orders.change_status')) {
      return NextResponse.json({ error: 'Forbidden', errorAr: 'هذا الإجراء ليس من صلاحيّاتك. راجع مدير النطام إن كان من عملك.' }, { status: 403 });
    }

    const batch = await db.shippingBatch.findFirst({ where: { id, companyId, storeId } });
    if (!batch) return NextResponse.json({ error: 'Batch not found', errorAr: 'الدفعة غير موجودة. أعد تحميل القائمة.' }, { status: 404 });

    const body = await req.json();
    const { status, notes, deliveryProviderId } = body as {
      status?: string; notes?: string; deliveryProviderId?: string;
    };

    const updateData: Record<string, unknown> = {};
    /*
     * ONE STEP, FORWARD, AS A CONDITION.
     *
     * The status is no longer written to whatever the row holds: it is
     * written only if the row STILL holds what this request read
     * (`status: batch.status` in the update below), inside one transaction
     * with the orders' stamp. Two presses at once, or a press on a stale
     * screen, find the condition false and stop — nobody gets a second
     * stamp and nobody reopens a closed trolley.
     */
    let step: BatchStatus | null = null;
    if (status !== undefined) {
      if (!(BATCH_STATUSES as readonly string[]).includes(status)) {
        return NextResponse.json({ error: 'حالة الدفعة غير معروفة', errorAr: 'حالة الدفعة غير معروفة', code: 'BATCH_STATUS_UNKNOWN' }, { status: 400 });
      }
      const verdict = checkStep(batch.status, status as BatchStatus);
      if (!verdict.ok) {
        // Asking for the state it is already in, together with a note or a
        // courier, is an ordinary save; alone it is a second press.
        const alone = notes === undefined && deliveryProviderId === undefined;
        if (verdict.code !== 'BATCH_STEP_DONE' || alone) {
          return NextResponse.json({ error: verdict.message, errorAr: verdict.message, code: verdict.code }, { status: 409 });
        }
      } else {
        step = status as BatchStatus;
        updateData.status = step;
        if (step === 'SHIPPED' && !batch.shippedAt) updateData.shippedAt = new Date();
      }
    }
    if (notes !== undefined) updateData.notes = notes?.trim() || null;
    if (deliveryProviderId !== undefined) {
      if (deliveryProviderId) {
        const provider = await db.deliveryProvider.findFirst({ where: { id: deliveryProviderId, companyId } });
        if (!provider) return NextResponse.json({ error: 'Provider not found in your company', errorAr: 'شركة الشحن هذه ليست من شركات شركتك.' }, { status: 404 });
        updateData.deliveryProviderId = provider.id;
      } else {
        updateData.deliveryProviderId = null;
      }
    }

    let updated;
    let members: { id: string; orderNumber: string; totalAmount: number; currency: string; trackingNumber: string | null }[] = [];
    try {
      updated = await db.$transaction(async (tx) => {
        const won = await tx.shippingBatch.updateMany({
          where: { id, companyId, storeId, status: batch.status },
          data: updateData,
        });
        if (won.count !== 1) throw new BatchMoved();

        if (step === 'SHIPPED') {
          /*
           * THE PRESS NAMES WHAT IT WOULD LEAVE BEHIND. A parcel with a
           * cancel or a postponement still waiting for an answer is being
           * handed to the courier against a decision that has not been
           * made. Inside the transaction, after the batch is won, so a
           * request raised a moment ago is seen and the whole press rolls
           * back.
           */
          const waiting = await tx.orderChangeRequest.findMany({
            where: {
              companyId,
              intent: { in: ['CANCEL', 'POSTPONE'] },
              OR: [{ status: 'PENDING' }, { status: 'APPROVED', appliedAt: null }],
              order: { shippingBatchId: id },
            },
            select: { order: { select: { orderNumber: true } } },
          });
          if (waiting.length > 0) {
            throw new PendingChanges([...new Set(waiting.map((w) => w.order.orderNumber))]);
          }

          /*
           * THE PRESS IS ONE TRANSACTION, AND IT ANSWERS FOR EVERY MEMBER.
           *
           * «إغلاق الشحنة — سُلّمت للشركة» is the line after which cancelling
           * stops being ours (M6), so it must be exactly what it says:
           *
           *   · the members are READ first and named — an empty trolley is not
           *     a handover and is refused, not stamped over nothing;
           *   · they are stamped in ONE conditional update whose count must
           *     equal the number read — a parcel cancelled or held a moment
           *     ago makes the count short and the whole press rolls back,
           *     instead of handing over a manifest nobody checked;
           *   · each gets its status-log row (the timeline said nothing about
           *     the handover) and, after the commit, `order.shipped`;
           *   · and it only goes forward (READY → SHIPPED) — the batch row
           *     above won its condition or none of this ran.
           */
          members = await tx.order.findMany({
            where: { shippingBatchId: id, companyId, storeId, shippingStatus: 'READY_FOR_PICKUP' },
            select: { id: true, orderNumber: true, totalAmount: true, currency: true, trackingNumber: true },
          });
          if (members.length === 0) throw new EmptyBatch();

          const stamped = await tx.order.updateMany({
            where: { id: { in: members.map((m) => m.id) }, shippingBatchId: id, companyId, storeId, shippingStatus: 'READY_FOR_PICKUP' },
            data: { shippingStatus: 'SHIPPED', shippedAt: new Date(), version: { increment: 1 } },
          });
          if (stamped.count !== members.length) throw new MembersMoved();

          await tx.orderStatusLog.createMany({
            data: members.map((m) => ({
              companyId, orderId: m.id, statusType: 'SHIPPING',
              previousValue: 'READY_FOR_PICKUP', newValue: 'SHIPPED',
              changedById: user.id, changedByRole: user.role,
              note: `سُلّمت الدفعة ${batch.batchNumber}`,
            })),
          });
        }
        return tx.shippingBatch.findUniqueOrThrow({ where: { id } });
      });
    } catch (e) {
      if (e instanceof BatchMoved) {
        return NextResponse.json(
          { error: 'الدفعة تغيّرت قبل ما يخلص طلبك — حدّث الصفحة', errorAr: 'الدفعة تغيّرت قبل ما يخلص طلبك — حدّث الصفحة', code: 'BATCH_MOVED' },
          { status: 409 }
        );
      }
      if (e instanceof EmptyBatch) {
        return NextResponse.json({ error: EMPTY_BATCH_AR, errorAr: EMPTY_BATCH_AR, code: 'EMPTY_BATCH' }, { status: 409 });
      }
      if (e instanceof MembersMoved) {
        const moved = 'تغيّر طرد من الدفعة أثناء الضغط (أُلغي أو أُجِّل) — ما انسلّم شي. حدّث الصفحة وجرّب من جديد.';
        return NextResponse.json({ error: moved, errorAr: moved, code: 'MEMBERS_MOVED' }, { status: 409 });
      }
      if (e instanceof PendingChanges) {
        const message = pendingChangesMessage(e.orderNumbers);
        return NextResponse.json(
          { error: message, errorAr: message, code: 'PENDING_CHANGES', orders: e.orderNumbers },
          { status: 409 }
        );
      }
      throw e;
    }

    // Tell the installed apps, after the commit and never able to undo it:
    // a parcel that left, left. One announcement per parcel the press stamped.
    for (const m of members) {
      await emitAppEvent(companyId, 'order.shipped', {
        orderId: m.id,
        orderNumber: m.orderNumber,
        shippingStatus: 'SHIPPED',
        previousStatus: 'READY_FOR_PICKUP',
        total: Number(m.totalAmount),
        currency: m.currency,
        trackingNumber: m.trackingNumber ?? null,
      });
    }

    await logAudit({
      companyId, userId: user.id, action: 'SHIPPING_BATCH_UPDATED',
      entity: 'ShippingBatch', entityId: id,
      previousData: { status: batch.status },
      newData: { status: step ?? batch.status, by: user.name },
    });

    return NextResponse.json({ success: true, batch: updated });
  } catch (error: any) {
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 400 });
  }
}
