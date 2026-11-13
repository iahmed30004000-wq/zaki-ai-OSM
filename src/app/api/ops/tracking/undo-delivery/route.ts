import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { SHIPPING_STATUS_AR } from '@/lib/shipping-workflow';
import { UndoStopped, measureUndo, readUndoFacts, undoDelivery } from '@/lib/delivery-undo';
import {
  DELIVERY_UNDO_ACTION,
  UNDO_ACK_AR,
  UNDO_FORBIDDEN_AR,
  UNDO_NOT_FOUND_AR,
  UNDO_REASON_MAX,
  UNDO_REASON_MIN,
  UNDO_SUCCESS_AR,
} from '@/lib/delivery-undo-words';

/**
 * «تراجع عن التسليم» — `POST /api/ops/tracking/undo-delivery`.
 *
 *   «هاد الطلب بالغلط حطيتو تم والشركة بتقول تم ارجاعها لازم يكون في زر تراجع مش محدود بمدة زمنية ويكون عليه صلاحية للمالك متاح» (the owner, 13/11)
 *
 * { action: 'measure', orderId }                                         — MEASURES, and writes nothing and opens no transaction: whether the
 *                                                                          delivery can be taken back, and in plain words what it would
 *                                                                          reverse and what it would leave — or why not. (`lib/delivery-undo.ts`)
 * { action: 'undo', orderId, reason, fingerprint, acknowledged }         — takes the delivery back exactly as the measure showed, or nothing.
 *
 * The key is `ops.undo_delivery`, which nobody holds by default — the owner's full access has it, and he ticks it for whoever he wants. It is
 * checked FIRST (after the tracking key), before the body is read and before a single order is. There is NO time window: the door refuses on
 * facts (money recorded, a statement, a counted return, a payable commission), never on how long ago the delivery was recorded.
 *
 * Writes only through the transaction's own client: the order, its lines, the customer's counters, the reversing commission entries, the two
 * timeline lines, the activity and the note land together or not at all. Never a wallet movement, an amount, the stock, or an event.
 */

const reason = z
  .string()
  .trim()
  .min(UNDO_REASON_MIN)
  .max(UNDO_REASON_MAX);

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('measure'), orderId: z.string().uuid() }),
  z.object({
    action: z.literal('undo'),
    orderId: z.string().uuid(),
    reason,
    /** What the dialog showed: the press refuses if the order is no longer this. */
    fingerprint: z.string().min(8).max(64),
    acknowledged: z.literal(true, { message: UNDO_ACK_AR }),
  }),
]);

// Both sentences in Arabic (the English-refusals ratchet only falls); the key is still in the message, so support can read it.
const forbidden = () =>
  NextResponse.json(
    { error: 'ناقصك مفتاح ops.undo_delivery', errorAr: UNDO_FORBIDDEN_AR, code: 'FORBIDDEN' },
    { status: 403 }
  );

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.track');
    if (!can(user, 'ops.undo_delivery')) return forbidden();

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const message = zodMessage(parsed.error);
      return NextResponse.json({ error: message, errorAr: message }, { status: 400 });
    }
    const scope = { companyId, storeId };
    const body = parsed.data;

    try {
      if (body.action === 'measure') {
        const facts = await readUndoFacts(db, scope, body.orderId);
        if (!facts) {
          return NextResponse.json({ error: UNDO_NOT_FOUND_AR, errorAr: UNDO_NOT_FOUND_AR, code: 'NOT_FOUND' }, { status: 404 });
        }
        return NextResponse.json(measureUndo(facts));
      }

      // One transaction: the claim, the lines, the counters, the reversing entries and the history land together or not at all.
      const done = await db.$transaction(
        (tx) =>
          undoDelivery(tx, {
            scope,
            user: { id: user.id, role: user.role },
            orderId: body.orderId,
            reason: body.reason,
            fingerprint: body.fingerprint,
          }),
        { timeout: 30_000, maxWait: 10_000 }
      );

      const { plan } = done;
      // ONE line for the press (the order also carries its own activity row, its timeline line and its note).
      await logAudit({
        companyId,
        userId: user.id,
        action: DELIVERY_UNDO_ACTION,
        entity: 'Order',
        entityId: body.orderId,
        previousData: { shippingStatus: plan.from, settlementStatus: plan.settlementFrom },
        newData: {
          shippingStatus: plan.to,
          settlementStatus: plan.settlement ? plan.settlement.to : plan.settlementFrom,
          path: plan.path,
          reason: body.reason,
          items: plan.items.length,
          customer: plan.customer ? { delivered: -1, value: -plan.customer.value } : null,
          commissionVoided: done.voided,
          orderNumber: done.orderNumber,
        },
      });

      const toWord = (SHIPPING_STATUS_AR as Record<string, string>)[plan.to] ?? plan.to;
      return NextResponse.json({
        undone: true,
        orderNumber: done.orderNumber,
        from: plan.from,
        to: plan.to,
        message: UNDO_SUCCESS_AR(done.orderNumber, toWord),
      });
    } catch (e) {
      if (e instanceof UndoStopped) return NextResponse.json({ ...e.body, errorAr: e.body.error }, { status: e.status });
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
