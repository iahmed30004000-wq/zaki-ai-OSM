import { NextResponse } from 'next/server';
import { z } from 'zod';
import { money as moneyInput } from '@/lib/numeric-input';
import { zodMessage } from '@/lib/zod-message';
import { SHIPPING_STATUS_AR } from '@/lib/shipping-workflow';
import { notify } from '@/lib/notify';
import { db } from '@/lib/db';
import { SEALED_BATCH_STATUSES } from '@/lib/order-seal';
import { requireContext } from '@/lib/geo-context';
import { consumeOrderStock } from '@/lib/stock-consumption';
import { emitAppEvent, type AppEvent } from '@/lib/apps/events';
import { queueConversions } from '@/lib/conversions/emit';
import { ORDER_ACCESS_STATUS, assertOrderAccess } from '@/lib/rbac';
import {
  isValidShippingTransition, canEnterShipping, STATUS_TIMESTAMP,
  DELIVERY_FAILURE_REASONS, RETURN_REASONS, SHIPPING_STATUSES, attemptForShippingStatus,
  type ShippingStatus,
} from '@/lib/shipping-workflow';
import { appendDeliveryAttempt } from '@/lib/delivery-attempts';
import { logAudit } from '@/lib/audit';
import { apiError } from '@/lib/api-error';
import { can, authorize } from '@/lib/authorization';
import { assertCancellable, assertReadyToShip, type StateSource } from '@/lib/order-state';
import { whyNotMovable } from '@/lib/batching-guard';
import { orderLinesForGuard } from '@/lib/reservation';
import { CONFIRMATION_STATUS_AR } from '@/lib/confirmation-workflow';

/**
 * POST /api/orders/[id]/shipping — controlled shipping workflow action.
 *
 * Body: {
 *   action: 'transition' | 'assign_provider' | 'assign_batch' | 'update_tracking'
 *   to?:                ShippingStatus (for transition)
 *   deliveryProviderId?: must belong to this company (server-verified)
 *   shippingBatchId?:    must belong to this company
 *   trackingNumber?:     string, updatable before SHIPPED only
 *   deliveryFee?:        number
 *   shippingNote?:       string
 *   deliveryFailureReason?: structured (required for FAILED_DELIVERY)
 *   returnReason?:       structured (required for RETURNED)
 *   expectedVersion?:    MANDATORY (Phase S rule)
 * }
 *
 * Server controls: companyId, assignedById, all timestamps, version increments.
 */
/**
 * The states in the words the screens use. A refusal that prints
 * `OUT_FOR_DELIVERY` at somebody is a refusal in a second language on top
 * of the first.
 */
/*
 * THE ONE VOCABULARY, NOT A FIFTH COPY OF IT.
 *
 * The name stays `CONFIRMATION_AR` because the sentences below read it.
 * What changed is where the words come from: this copy said «قيد
 * المعالجة», «بحاجة متابعة», «مؤجَّل» and «مؤكَّد» where the rest of the
 * product says «قيد التأكيد», «يحتاج متابعة», «مؤجل» and «مؤكد».
 */
const CONFIRMATION_AR: Record<string, string> = CONFIRMATION_STATUS_AR;

/* The words come from `SHIPPING_STATUS_AR`; this was a sixth copy, and
 * it called PACKING «قيد التجهيز» — which is the core state PREPARING. */
const SHIPPING_AR: Record<string, string> = SHIPPING_STATUS_AR;

/**
 * The strict reader every door that moves money uses, wrapped in an object
 * so the refusal can NAME the field — `zodMessage` reads the field out of
 * the issue's path, and a bare value has no path.
 *
 * The ceiling is deliberately loose. It is there to catch a typo with an
 * extra five digits on it, not to express a fee policy: this system runs
 * Syrian pounds and Iraqi dinars beside dollars, so any tight number would
 * refuse a legitimate fee in the weaker currency. (The orders door's
 * `shippingCost: amount(1000)` is the tight one, and that is a separate
 * question about that door, not a precedent to copy here.)
 */
const DELIVERY_FEE = z.object({ deliveryFee: moneyInput(1_000_000) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();

    // Order access first, then shipping authority evaluated against the order
    const access = await assertOrderAccess(id, user, { companyId, storeId }, 'orders.view');
    if (!access.allowed) {
      return NextResponse.json({ error: 'الطلب غير موجود أو ليس بين يديك' }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const order = access.order;

    // Permission: shipping authority (scope evaluated against the loaded order)
    const shippingAuth = authorize(user, 'orders.change_status', order);
    if (!shippingAuth.allowed) {
      return NextResponse.json({ error: 'لا تملك صلاحية تغيير حالة الشحن' }, { status: 403 });
    }

    // ── Editing-lock enforcement: an ACTIVE foreign lock blocks edits ──
    // (users with orders.unlock may bypass, same as the generic PATCH)
    const lockActive =
      order.lockedById &&
      order.lockExpiresAt &&
      new Date(order.lockExpiresAt).getTime() > Date.now();
    if (lockActive && order.lockedById !== user.id && !can(user, 'orders.unlock')) {
      const holder = await db.user.findUnique({ where: { id: order.lockedById! }, select: { name: true } });
      return NextResponse.json(
        {
          error: `${holder?.name ?? 'موظف آخر'} يعمل على هذا الطلب الآن — انتظر حتى يتركه`,
          errorAr: `هذا الطلب يتم تعديله حالياً بواسطة ${holder?.name ?? 'مستخدم آخر'}.`,
          code: 'ORDER_LOCKED',
          locked: true,
          lockedBy: holder?.name ?? null,
        },
        { status: 423 }
      );
    }

    const body = await req.json();
    const {
      action, to, deliveryProviderId, shippingBatchId,
      trackingNumber, shippingReference, deliveryFee, shippingNote,
      deliveryFailureReason, returnReason, expectedVersion,
    } = body as {
      action?: string; to?: string; deliveryProviderId?: string; shippingBatchId?: string;
      // `unknown`, not `number`: this is a parsed request body and the
      // annotation was a wish. Calling it `number` is what let
      // `Number(deliveryFee) || 0` read as a formality.
      trackingNumber?: string; shippingReference?: string; deliveryFee?: unknown; shippingNote?: string;
      deliveryFailureReason?: string; returnReason?: string; expectedVersion?: number;
    };

    if (!action) return NextResponse.json({ error: 'لم يُحدَّد الإجراء' }, { status: 400 });
    if (typeof expectedVersion !== 'number') {
      return NextResponse.json({ error: 'تعذّر الحفظ — أعد فتح الطلب وحاول ثانية', code: 'VERSION_REQUIRED' }, { status: 400 });
    }
    if (expectedVersion !== order.version) {
      return NextResponse.json(
        {
          error: 'عدّل هذا الطلبَ شخصٌ آخر قبلك — أعد تحميل الصفحة ثم احفظ',
          errorAr: 'تم تعديل هذا الطلب بواسطة مستخدم آخر. يرجى تحديث الصفحة قبل الحفظ.',
          code: 'VERSION_CONFLICT',
        },
        { status: 409 }
      );
    }

    const from = order.shippingStatus as ShippingStatus;
    const now = new Date();
    const updateData: Record<string, unknown> = {};
    let newShippingStatus: ShippingStatus | null = null;

    switch (action) {
      case 'transition': {
        if (!to) return NextResponse.json({ error: 'لم تُحدَّد الحالة المطلوبة' }, { status: 400 });
        // Whitelist validation — enforced even on the override path
        if (!(SHIPPING_STATUSES as readonly string[]).includes(to)) {
          return NextResponse.json({ error: `حالة شحن غير معروفة: ${to}` }, { status: 400 });
        }
        newShippingStatus = to as ShippingStatus;

        // ── Confirmation dependency (Section 4): fail closed ──
        if (newShippingStatus !== 'CANCELLED' && !canEnterShipping(order.confirmationStatus)) {
          return NextResponse.json(
            {
              error: `الشحن يحتاج طلباً مؤكَّداً — هذا «${CONFIRMATION_AR[order.confirmationStatus] ?? order.confirmationStatus}»`,
              errorAr: `الشحن يحتاج طلباً مؤكَّداً — هذا «${CONFIRMATION_AR[order.confirmationStatus] ?? order.confirmationStatus}». أكِّده أوّلاً ثمّ اشحنه.`,
              code: 'CONFIRMATION_REQUIRED',
            },
            { status: 409 }
          );
        }

        // ── No cancellation once the order has shipped (invariant 4) ──
        // Checked BEFORE the transition validator so the admin override path
        // cannot bypass it either.
        if (newShippingStatus === 'CANCELLED') {
          const cancellable = assertCancellable(order as StateSource);
          if (!cancellable.allowed) {
            return NextResponse.json(
              { error: cancellable.message, errorAr: cancellable.message, code: cancellable.code },
              { status: 409 }
            );
          }
        }

        // ── Controlled transitions (Section 3) ──
        if (!isValidShippingTransition(from, newShippingStatus)) {
          // SUPER_ADMIN override with reason
          const isOverride = can(user, 'orders.unlock') && shippingNote && shippingNote.trim().length >= 5;
          if (!isOverride) {
            return NextResponse.json(
              {
                error: `لا يمكن الانتقال من «${SHIPPING_AR[from] ?? from}» إلى «${SHIPPING_AR[newShippingStatus] ?? newShippingStatus}»`,
                errorAr: `لا يمكن الانتقال من «${SHIPPING_AR[from] ?? from}» إلى «${SHIPPING_AR[newShippingStatus] ?? newShippingStatus}». أعد تحميل الصفحة لترى حالته الآن.`,
                code: 'INVALID_TRANSITION',
              },
              { status: 409 }
            );
          }
        }

        // ── A blocking change request stops OUR forward transitions ──
        // (courier webhook events are recorded regardless and mark the
        // request as changed during review — contract invariant 7.)
        const FORWARD = ['PACKING', 'READY_FOR_SHIPPING', 'READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY'];
        if (FORWARD.includes(newShippingStatus)) {
          const pending = await db.orderChangeRequest.findFirst({
            where: { orderId: id, status: 'PENDING', blocking: true },
            select: { id: true, reason: true },
          });
          if (pending) {
            return NextResponse.json(
              {
                error: 'يوجد طلب تعديل قيد المراجعة على هذا الطلب',
                errorAr: 'يوجد طلب تعديل قيد المراجعة على هذا الطلب',
                code: 'CHANGE_REQUEST_PENDING',
                changeRequestId: pending.id,
              },
              { status: 409 }
            );
          }
        }

        // ── Reservation gate: one unreserved line blocks READY_TO_SHIP ──
        if (newShippingStatus === 'READY_FOR_SHIPPING' || newShippingStatus === 'READY_FOR_PICKUP') {
          const lines = await orderLinesForGuard(db, id);
          const ready = assertReadyToShip(order as StateSource, lines);
          if (!ready.allowed) {
            return NextResponse.json(
              { error: ready.message, errorAr: ready.message, code: ready.code },
              { status: 409 }
            );
          }
        }

        // Structured reasons
        if (newShippingStatus === 'FAILED_DELIVERY') {
          if (!deliveryFailureReason || !(DELIVERY_FAILURE_REASONS as readonly string[]).includes(deliveryFailureReason)) {
            return NextResponse.json({ error: 'اختر سبب تعذّر التوصيل من القائمة' }, { status: 400 });
          }
          if (deliveryFailureReason === 'OTHER' && (!shippingNote || shippingNote.trim().length < 5)) {
            return NextResponse.json({ error: 'سبب «أخرى» يحتاج ملاحظة — خمسة أحرف على الأقل' }, { status: 400 });
          }
          updateData.deliveryFailureReason = deliveryFailureReason;
        }
        if (newShippingStatus === 'RETURN_REQUESTED' || newShippingStatus === 'RETURNED') {
          if (!returnReason || !(RETURN_REASONS as readonly string[]).includes(returnReason)) {
            return NextResponse.json({ error: 'اختر سبب الإرجاع من القائمة' }, { status: 400 });
          }
          updateData.returnReason = returnReason;
        }

        updateData.shippingStatus = newShippingStatus;
        // Server-set timestamp (never client)
        const tsField = STATUS_TIMESTAMP[newShippingStatus];
        if (tsField) updateData[tsField] = now;
        // Legacy combined status sync for list compatibility
        if (newShippingStatus === 'SHIPPED') updateData.status = 'SHIPPED';
        if (newShippingStatus === 'DELIVERED') {
          updateData.status = 'DELIVERED';
          // Match the legacy PATCH behavior: delivery marks the COD collected
          updateData.settlementStatus = 'COLLECTED';
        }
        if (newShippingStatus === 'RETURNED') updateData.status = 'RETURNED';
        break;
      }

      case 'assign_provider': {
        if (!deliveryProviderId) return NextResponse.json({ error: 'اختر شركة الشحن' }, { status: 400 });
        // Tenant-validate the provider (Phase S rule)
        const provider = await db.deliveryProvider.findFirst({ where: { id: deliveryProviderId, companyId } });
        if (!provider) {
          return NextResponse.json({ error: 'شركة الشحن غير موجودة' }, { status: 404 });
        }
        updateData.deliveryProviderId = provider.id;
        updateData.deliveryAssignedAt = now;          // server timestamp
        updateData.deliveryAssignedById = user.id;    // server-derived actor
        break;
      }

      case 'assign_batch': {
        if (!shippingBatchId) return NextResponse.json({ error: 'اختر دفعة الشحن' }, { status: 400 });
        const batch = await db.shippingBatch.findFirst({ where: { id: shippingBatchId, companyId, storeId } });
        if (!batch) {
          return NextResponse.json({ error: 'دفعة الشحن غير موجودة' }, { status: 404 });
        }
        // A batch stops taking work the moment the courier takes it away.
        // Adding an order to a trolley that is already on a van is an order
        // the driver does not have, on a manifest that says he does.
        if (SEALED_BATCH_STATUSES.includes(batch.status as (typeof SEALED_BATCH_STATUSES)[number])) {
          return NextResponse.json(
            {
              error: `الدفعة ${batch.batchNumber} سلِّمت لشركة الشحن ولم تعد تستقبل طلبات. أنشئ دفعة جديدة.`,
              errorAr: `الدفعة ${batch.batchNumber} سلِّمت لشركة الشحن ولم تعد تستقبل طلبات. أنشئ دفعة جديدة.`,
              code: 'BATCH_CLOSED_FOR_INTAKE',
            },
            { status: 409 }
          );
        }
        /*
         * AND THE ORDER MUST STILL BE MOVABLE. A list that is a minute old
         * offered an order that another press had already put on a trolley
         * (or that had already left): moving it again put one parcel on two
         * manifests, or a van's parcel onto a trolley that was never loaded.
         * The version check below catches an edit in between; this catches
         * the order that was never ours to move.
         */
        const unmovable = whyNotMovable(order, batch.id);
        if (unmovable) {
          return NextResponse.json(
            { error: unmovable, errorAr: unmovable, code: 'ORDER_NOT_MOVABLE' },
            { status: 409 }
          );
        }
        updateData.shippingBatchId = batch.id;
        break;
      }

      case 'update_tracking': {
        // Tracking is modifiable BEFORE shipment only (Section 7)
        if (['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED'].includes(from)) {
          return NextResponse.json({ error: 'رقم التتبّع لا يُعدَّل بعد الشحن — البوليصة عند الشركة' }, { status: 409 });
        }
        if (trackingNumber !== undefined) {
          const tn = trackingNumber.trim();
          if (tn) {
            // Uniqueness within company scope
            const clash = await db.order.findFirst({ where: { companyId, trackingNumber: tn, id: { not: id } } });
            if (clash) return NextResponse.json({ error: 'رقم التتبّع مستعمل في طلب آخر' }, { status: 409 });
            updateData.trackingNumber = tn;
          } else {
            updateData.trackingNumber = null;
          }
        }
        if (shippingReference !== undefined) updateData.shippingReference = (shippingReference as string).trim() || null;
        if (deliveryFee !== undefined) {
          /*
           * A FEE THAT IS NOT A NUMBER IS REFUSED, NOT MADE FREE.
           *
           * This was `Number(deliveryFee) || 0`, and this column is not a
           * display: `settlement.ts:469` deducts it from what the courier
           * owes, `commission.ts:167` subtracts it before commission, and
           * `agent-custody.ts:141` carries it into the agent's custody
           * figure. A non-numeric fee stored **0** — free delivery — and
           * the courier statement then disagreed with the order by exactly
           * the fee, silently and in the courier's favour.
           *
           * DELETING THE FALLBACK IS NOT ENOUGH HERE, and that is measured
           * rather than assumed: `deliveryFee` is `Float?`, and Prisma
           * ACCEPTS `NaN` for a nullable Float — it lands as NULL, which
           * every reader above spells `?? 0`. So the bare write stores the
           * same wrong zero by a longer road. The only answer that tells
           * anybody anything is a 400.
           *
           * `null` stays writable and means «no fee recorded», which is
           * what the column's own nullability says and what 30 of 56 live
           * orders hold. `0` stays writable too: `priceIncludesDelivery`
           * makes a zero fee a real policy, not a missing number.
           */
          if (deliveryFee === null) {
            updateData.deliveryFee = null;
          } else {
            const fee = DELIVERY_FEE.safeParse({ deliveryFee });
            if (!fee.success) {
              return NextResponse.json({ error: zodMessage(fee.error) }, { status: 400 });
            }
            updateData.deliveryFee = fee.data.deliveryFee;
          }
        }
        break;
      }

      default:
        return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 });
    }

    if (shippingNote !== undefined && action !== 'transition') {
      updateData.shippingNote = shippingNote.trim() || null;
    } else if (action === 'transition' && shippingNote) {
      updateData.shippingNote = shippingNote.trim();
    }

    updateData.version = { increment: 1 };

    // Atomic versioned save.
    //
    // Delivery consumes stock in the SAME transaction as the status change.
    // It used to consume nothing at all: the reservation was released the
    // moment the order left the open set, the batch kept its full remainder,
    // and the unit went quietly back on sale. Doing it here means there is
    // no instant in which an order is delivered and its goods are still
    // available to somebody else.
    let consumption: { taken: number; short: number; alreadyDone: boolean } | null = null;

    const saved = await db.$transaction(async (tx) => {
      const res = await tx.order.updateMany({
        where: { id, companyId, version: expectedVersion },
        data: updateData,
      });
      if (res.count !== 1) return res;

      if (newShippingStatus === 'DELIVERED' || newShippingStatus === 'PARTIALLY_DELIVERED') {
        consumption = await consumeOrderStock(tx, {
          orderId: id,
          companyId,
          allowNegativeStock: country.allowNegativeStock,
          userId: user.id,
        });
      }

      // THE KNOCK THAT PRODUCED THIS STATUS, WRITTEN HERE AND NOT BY THE
      // BROWSER.
      //
      // The failure modal used to POST the attempt and then PATCH the
      // transition, as two requests: an append-only audit row could outlive
      // a transition that failed or that somebody abandoned, and the success
      // path simply never sent the first request at all — so the table held
      // failures only. Both are fixed by the row being written where the
      // status is, in one transaction, for the same reason the stock is.
      const knock = newShippingStatus
        ? attemptForShippingStatus(newShippingStatus, { failureReason: deliveryFailureReason })
        : null;
      if (knock) {
        await appendDeliveryAttempt(tx, {
          orderId: id,
          companyId,
          result: knock.result,
          failureReason: knock.failureReason,
          note: shippingNote ?? null,
          deliveryProviderId: order.deliveryProviderId,
          userId: user.id,
        });
      }
      return res;
    });

    if (saved.count !== 1) {
      return NextResponse.json(
        {
          error: 'عدّل هذا الطلبَ شخصٌ آخر قبلك — أعد تحميل الصفحة ثم احفظ',
          errorAr: 'تم تعديل هذا الطلب بواسطة مستخدم آخر. يرجى تحديث الصفحة قبل الحفظ.',
          code: 'VERSION_CONFLICT',
        },
        { status: 409 }
      );
    }

    // ── Tell the installed apps what changed ──
    // After the commit, and never able to undo it: an order that shipped has
    // shipped, whatever an integration thinks about it.
    const APP_EVENT_FOR: Record<string, AppEvent> = {
      SHIPPED: 'order.shipped',
      DELIVERED: 'order.delivered',
      RETURNED: 'order.returned',
      CANCELLED: 'order.cancelled',
    };
    if (newShippingStatus && newShippingStatus !== from && APP_EVENT_FOR[newShippingStatus]) {
      await emitAppEvent(companyId, APP_EVENT_FOR[newShippingStatus], {
        orderId: id,
        orderNumber: order.orderNumber,
        shippingStatus: newShippingStatus,
        previousStatus: from,
        total: Number(order.totalAmount),
        currency: order.currency,
        trackingNumber: order.trackingNumber ?? null,
      });
    }

    // Delivery is the only moment that is a sale. For a cash-on-delivery
    // shop this is the conversion worth buying, and the one the browser
    // pixel can never witness because it happened at somebody's door.
    if (newShippingStatus === 'DELIVERED' && newShippingStatus !== from) {
      await queueConversions(companyId, 'order.delivered', id);
    }

    // ── Logs: OrderStatusLog + OrderActivity + Audit (Section 21) ──
    if (newShippingStatus && newShippingStatus !== from) {
      await db.orderStatusLog.create({
        data: {
          companyId, orderId: id, statusType: 'SHIPPING',
          previousValue: from, newValue: newShippingStatus,
          changedById: user.id, changedByRole: user.role,
          note: shippingNote?.trim() || deliveryFailureReason || returnReason || null,
        },
      });
      await db.orderActivity.create({
        data: {
          companyId, orderId: id, userId: user.id,
          action: 'SHIPPING_STATUS_CHANGED', previousStatus: from, newStatus: newShippingStatus,
          metadata: JSON.stringify({
            by: user.name, role: user.role,
            provider: deliveryProviderId || order.deliveryProviderId || null,
            note: shippingNote || null,
          }),
        },
      });
    }
    if (action === 'assign_provider') {
      await db.orderActivity.create({
        data: {
          companyId, orderId: id, userId: user.id, action: 'SHIPPING_UPDATED',
          metadata: JSON.stringify({ by: user.name, providerAssigned: deliveryProviderId }),
        },
      });
    }
    await logAudit({
      companyId, userId: user.id,
      action: newShippingStatus ? 'SHIPPING_STATUS_CHANGED' : 'SHIPPING_INFO_UPDATED',
      entity: 'Order', entityId: id,
      previousData: { shippingStatus: from, trackingNumber: order.trackingNumber },
      newData: { shippingStatus: newShippingStatus, action, by: user.name },
    });

    // A failed delivery is the tracking desk's to chase: ops.track holders
    // of this store, sent to the screen that lists it. After commit; never
    // throws.
    if (newShippingStatus === 'FAILED_DELIVERY' && newShippingStatus !== from) {
      notify({
        companyId,
        storeId: order.storeId ?? storeId,
        audience: { permission: 'ops.track' },
        actorId: user.id,
        title: 'فشل التوصيل',
        message: `فشل توصيل الطلب #${order.orderNumber}.`,
        type: 'SYSTEM_ALERT',
        link: ['/ops/tracking', '/ops/returns', '/orders'],
      });
    }

    const fresh = await db.order.findUnique({
      where: { id },
      include: {
        deliveryProvider: { select: { id: true, name: true, code: true, phone: true } },
        shippingBatch: { select: { id: true, batchNumber: true } },
      },
    });
    return NextResponse.json({ success: true, order: fresh });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
