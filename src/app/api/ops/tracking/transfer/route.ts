import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { orderRefFields } from '@/lib/order-ref';
import { planTransfer, requiresOpenBatch, TransferRefused, type TransferParty } from '@/lib/couriers/transfer';
import { handedToCourier } from '@/lib/order-seal';
import { moveBeforeHandover } from '@/lib/order-cancel';
import { createReplacement, type ReplacementSource } from '@/lib/replacement-order';
import { ACTIVITY_ROLE } from '@/lib/superseded';
import { zodMessage } from '@/lib/zod-message';

/**
 * POST /api/ops/tracking/transfer — move a parcel to another courier.
 *
 * The rules live in src/lib/couriers/transfer.ts. Away from a مندوب it is one
 * move; away from a company that has TAKEN the parcel it is taken back and
 * a REPLACEMENT order is raised, because the original is physically with that
 * company under their barcode and will appear in their statement.
 * Overwriting the provider would quietly detach the order from the shipment
 * that still holds it.
 *
 * AND BEFORE THE COMPANY TOOK IT, NOTHING IS REPLACED. Until «إغلاق الشحنة —
 * سُلّمت للشركة» the box is on our floor: the SAME order moves to the new
 * company's trolley, with its number, its lines and its reservation, and a
 * printed waybill goes only on the word of the person who destroyed it.
 */

const schema = z.object({
  orderId: z.string().uuid(),
  toProviderId: z.string().uuid(),
  note: z.string().trim().max(300).optional(),
  /** «الطرد بين يديّ — أتلفتُ بوليصته القديمة…» — needed only when the old waybill is printed. */
  parcelInHand: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    // Moving a parcel to another courier is its own box (PR-8), given by the migration to every holder of `ops.track`.
    // The packing-table half below (a parcel the company never took) still asks `ops.ship` as well.
    await requirePermission('ops.transfer');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const order = await db.order.findFirst({
      where: { id: parsed.data.orderId, companyId, storeId },
      include: {
        deliveryProvider: { select: { id: true, name: true, kind: true } },
        replacedBy: { select: { id: true, orderNumber: true } },
        // Whether its trolley has gone: a parcel the company never took
        // cannot be taken back from them.
        shippingBatch: { select: { status: true } },
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });
    if (order.replacedBy) {
      return NextResponse.json(
        {
          error: `صدر لهذا الطلب بديل مسبقاً (${order.replacedBy.orderNumber})`,
          code: 'ALREADY_REPLACED',
        },
        { status: 409 }
      );
    }

    const to = await db.deliveryProvider.findFirst({
      where: { id: parsed.data.toProviderId, companyId, isActive: true },
      select: { id: true, name: true, kind: true },
    });
    if (!to) return NextResponse.json({ error: 'الجهة غير موجودة' }, { status: 404 });

    const from: TransferParty | null = order.deliveryProvider
      ? {
          id: order.deliveryProvider.id,
          name: order.deliveryProvider.name,
          kind: order.deliveryProvider.kind === 'AGENT' ? 'AGENT' : 'COMPANY',
        }
      : null;
    const target: TransferParty = { id: to.id, name: to.name, kind: to.kind === 'AGENT' ? 'AGENT' : 'COMPANY' };

    let plan;
    try {
      plan = planTransfer({
        from,
        to: target,
        shippingStatus: order.shippingStatus,
        // Has the company TAKEN it — the press of its trolley, or a parcel that left on its own.
        handedOver: handedToCourier({
          shippingStatus: order.shippingStatus,
          shippedAt: order.shippedAt,
          batchStatus: order.shippingBatch?.status ?? null,
        }),
      });
    } catch (e) {
      if (e instanceof TransferRefused) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
      }
      throw e;
    }

    // A company takes parcels by the trolley. Handing one to a company with
    // no batch open leaves it assigned to somebody who has not agreed to
    // carry anything today — invisible on every batch screen and nobody's
    // job. An agent is exempt: he takes it by hand, now.
    let openBatch: { id: string; batchNumber: string } | null = null;
    if (requiresOpenBatch(target)) {
      openBatch = await db.shippingBatch.findFirst({
        where: { companyId, storeId, deliveryProviderId: to.id, status: 'READY' },
        select: { id: true, batchNumber: true },
        orderBy: { createdAt: 'desc' },
      });
      if (!openBatch) {
        return NextResponse.json(
          {
            error: `لا توجد دفعة مفتوحة لـ${to.name}. افتح دفعة لها أولاً، ثم أعد التحويل.`,
            code: 'NO_OPEN_BATCH',
            providerId: to.id,
          },
          { status: 409 }
        );
      }
    }

    /**
     * THE COMPANY NEVER TOOK IT: THE SAME ORDER MOVES, NOTHING IS RAISED.
     *
     * No replacement, no new number, no second reservation — the helper
     * writes one conditional update (see `moveBeforeHandover`). The old
     * company is told to cancel a parcel it already has a barcode for, and a
     * printed waybill is torn up on a person's word.
     */
    if (plan.mode === 'REBATCH') {
      /*
       * THIS ONE TAKES A PARCEL OFF A TROLLEY AND CANCELS A WAYBILL AT THE COMPANY — the
       * packing table's work. The sister doors (`hold`, `stand-down`) ask `ops.ship` for the
       * same acts; `ops.track` alone (the tracking desk) does not reach it. The move AFTER
       * the handover keeps the permission it always had.
       */
      await requirePermission('ops.ship');
      const moved = await moveBeforeHandover({
        orderId: order.id,
        companyId,
        storeId,
        by: { id: user.id, name: user.name, role: user.role },
        fromProviderId: from!.id,
        fromName: from!.name,
        to: { id: to.id, name: to.name },
        toBatchId: openBatch?.id ?? null,
        minorUnit: country.minorUnit,
        note: parsed.data.note ?? null,
        parcelInHand: parsed.data.parcelInHand === true,
      });
      if (!moved.ok) {
        return NextResponse.json(
          { error: moved.error, code: moved.code, ...(moved.attestation ? { attestation: moved.attestation } : {}) },
          { status: moved.status }
        );
      }
      await logAudit({
        companyId, userId: user.id, action: 'COURIER_TRANSFERRED',
        entity: 'Order', entityId: order.id,
        previousData: { provider: from?.name, shippingStatus: order.shippingStatus },
        newData: { mode: plan.mode, to: to.name, replacement: null, note: parsed.data.note ?? null, courierCancelled: moved.courierCancelled },
      });
      return NextResponse.json({
        mode: plan.mode,
        orderNumber: order.orderNumber,
        replacement: null,
        message:
          `${order.orderNumber} انتقل من ${from?.name} إلى ${to.name} — نفس الطلب ونفس الرقم، بلا طلب بديل.` +
          `${moved.courierCancelled ? ` وألغينا الطرد عند ${from?.name}.` : ''}` +
          `${moved.waybillReset ? ' بوليصته القديمة بطلت، اطبع له بوليصة جديدة.' : ''}`,
      });
    }

    const runTransfer = (attempt: number) =>
      db.$transaction(async (tx) => {
      if (plan.mode === 'DIRECT') {
        // The مندوب is immediate: handing the parcel on IS getting it back.
        const updated = await tx.order.update({
          where: { id: order.id },
          data: {
            deliveryProviderId: to.id,
            shippingBatchId: openBatch?.id ?? null,
            shippingStatus: plan.nextStatus,
            trackingNumber: null, // the old courier's barcode is not ours to carry over
            shippedAt: null,
            version: { increment: 1 },
          },
        });
        await tx.orderActivity.create({
          data: {
            companyId, orderId: order.id, userId: user.id,
            action: 'COURIER_TRANSFERRED',
            newStatus: plan.nextStatus,
            metadata: JSON.stringify({ mode: plan.mode, from: from?.name, to: to.name, note: parsed.data.note ?? null }),
          },
        });
        return { mode: plan.mode, order: updated, replacement: null };
      }

      // REPLACE: close the company's leg, raise a fresh order for the new one.
      // The version is part of the condition: two presses on one parcel must
      // not raise two replacements and reserve its goods twice — the second
      // finds the version moved and stops (answered below as «تغيّر»).
      await tx.order.update({
        where: { id: order.id, version: order.version },
        data: {
          shippingStatus: plan.originalStatus,
          returnReason: plan.reason,
          version: { increment: 1 },
        },
      });

      /**
       * The number is taken BEFORE the insert and any clash retries the
       * whole transaction from outside: on Postgres a failed statement
       * aborts the transaction, so a retry within it cannot run.
       *
       * The building itself is shared with the reorder path — see
       * src/lib/replacement-order.ts. A second copy of it is where «the
       * lines are carried over» or «the goods come off the shelf now»
       * stops being true on one of the two.
       */
      const replacement = await createReplacement(tx, {
        companyId,
        createdById: user.id,
        order: order as unknown as ReplacementSource,
        orderPrefix: country.orderPrefix,
        attempt,
        minorUnit: country.minorUnit,
        allowNegativeStock: country.allowNegativeStock,
        // Straight onto the open trolley of the company it is going to —
        // there is nothing left to decide about it.
        shippingStatus: plan.nextStatus,
        deliveryProviderId: to.id,
        shippingBatchId: openBatch?.id ?? null,
        internalNotes: `بديل عن ${order.orderNumber}: ${plan.reason}`,
      });

      /*
       * WHICH SIDE OF THE PAIR EACH COPY IS WRITTEN ON. Both orders carry the
       * same word so neither reads without the other; the role is what lets
       * `isSuperseded` tell the order that was replaced from the one that
       * replaced it (src/lib/superseded.ts).
       */
      for (const [orderId, note, role] of [
        [order.id, `سُحب من ${from?.name} — صدر البديل ${replacement.orderNumber}`, ACTIVITY_ROLE.original],
        [replacement.id, `بديل عن ${order.orderNumber} — ليُسنَد إلى ${to.name}`, ACTIVITY_ROLE.replacement],
      ] as const) {
        await tx.orderActivity.create({
          data: {
            companyId, orderId, userId: user.id,
            action: 'COURIER_TRANSFERRED',
            metadata: JSON.stringify({ mode: plan.mode, role, from: from?.name, to: to.name, note }),
          },
        });
      }

      return { mode: plan.mode, order, replacement };
      });

    // A duplicate order number means someone else took it between reading the
    // highest and inserting; step the number on and run the whole thing again.
    let result: Awaited<ReturnType<typeof runTransfer>> | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        result = await runTransfer(attempt);
        break;
      } catch (e: any) {
        if (e?.code === 'P2002' && attempt < 4) continue;
        if (e?.code === 'P2025') {
          return NextResponse.json(
            { error: 'الطلب تغيّر قبل ما ينتقل — حدّث الصفحة وجرّب من جديد', code: 'VERSION_CONFLICT' },
            { status: 409 }
          );
        }
        throw e;
      }
    }
    if (!result) throw new Error('Failed to generate a unique order number');

    await logAudit({
      companyId, userId: user.id, action: 'COURIER_TRANSFERRED',
      entity: 'Order', entityId: order.id,
      previousData: { provider: from?.name, shippingStatus: order.shippingStatus },
      newData: {
        mode: plan.mode,
        to: to.name,
        replacement: result.replacement?.orderNumber ?? null,
        note: parsed.data.note ?? null,
      },
    });

    return NextResponse.json({
      mode: result.mode,
      orderNumber: order.orderNumber,
      replacement: result.replacement
        ? { id: result.replacement.id, orderNumber: result.replacement.orderNumber }
        : null,
      message:
        result.mode === 'DIRECT'
          ? `استُلمت الشحنة من ${from?.name} وأُسنِدت إلى ${to.name}`
          : `سُحبت الشحنة من ${from?.name} وصدر الطلب البديل ${result.replacement?.orderNumber} — يدخل تجهيز الشحنة`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
