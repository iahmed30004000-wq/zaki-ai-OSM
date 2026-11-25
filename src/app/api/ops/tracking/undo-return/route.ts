import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { SHIPPING_STATUS_AR } from '@/lib/shipping-workflow';
import { RETURNED, ReturnUndoStopped, measureReturnUndo, readReturnUndoFacts, undoReturn } from '@/lib/return-undo';
import {
  RETURN_UNDO_ACK_AR,
  RETURN_UNDO_ACTION,
  RETURN_UNDO_FORBIDDEN_AR,
  RETURN_UNDO_NOT_FOUND_AR,
  RETURN_UNDO_SUCCESS_AR,
  UNDO_REASON_MAX,
  UNDO_REASON_MIN,
} from '@/lib/return-undo-words';

/**
 * «تراجع عن المرتجع» — `POST /api/ops/tracking/undo-return` (25/11). The mirror of `undo-delivery`.
 *
 * { action: 'measure', orderId }                                    — MEASURES, writes nothing and opens no transaction: whether the return
 *                                                                     «رجعت» recorded can be taken back, and in plain words what it would put
 *                                                                     back and what it would leave — or why not. (`lib/return-undo.ts`)
 * { action: 'undo', orderId, reason, fingerprint, acknowledged }    — takes the return back exactly as the measure showed, or nothing.
 *
 * The key is the owner's `ops.undo_delivery` — the same box as «تراجع عن التسليم», checked FIRST (after the tracking key), before the body
 * is read and before a single order is. There is NO time window: the door refuses on facts, never on how long ago the return was recorded.
 *
 * Writes only through the transaction's own client: the order, its lines, the customer's one counter, the timeline line, the activity and
 * the note land together or not at all. Never a wallet movement, an amount, the stock, a commission or an event.
 */

const reason = z.string().trim().min(UNDO_REASON_MIN).max(UNDO_REASON_MAX);

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('measure'), orderId: z.string().uuid() }),
  z.object({
    action: z.literal('undo'),
    orderId: z.string().uuid(),
    reason,
    /** What the dialog showed: the press refuses if the order is no longer this. */
    fingerprint: z.string().min(8).max(64),
    acknowledged: z.literal(true, { message: RETURN_UNDO_ACK_AR }),
  }),
]);

// Both sentences in Arabic (the English-refusals ratchet only falls); the key is still in the message, so support can read it.
const forbidden = () =>
  NextResponse.json({ error: 'ناقصك مفتاح ops.undo_delivery', errorAr: RETURN_UNDO_FORBIDDEN_AR, code: 'FORBIDDEN' }, { status: 403 });

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
        const facts = await readReturnUndoFacts(db, scope, body.orderId);
        if (!facts) {
          return NextResponse.json({ error: RETURN_UNDO_NOT_FOUND_AR, errorAr: RETURN_UNDO_NOT_FOUND_AR, code: 'NOT_FOUND' }, { status: 404 });
        }
        return NextResponse.json(measureReturnUndo(facts));
      }

      // One transaction: the claim, the lines, the counter and the history land together or not at all.
      const done = await db.$transaction(
        (tx) =>
          undoReturn(tx, {
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
        action: RETURN_UNDO_ACTION,
        entity: 'Order',
        entityId: body.orderId,
        previousData: { shippingStatus: RETURNED, settlementStatus: plan.settlementFrom },
        newData: {
          shippingStatus: plan.to,
          settlementStatus: plan.settlementFrom,
          reason: body.reason,
          items: plan.items.length,
          customer: { refused: -1 },
          orderNumber: done.orderNumber,
        },
      });

      const toWord = (SHIPPING_STATUS_AR as Record<string, string>)[plan.to] ?? plan.to;
      return NextResponse.json({
        undone: true,
        orderNumber: done.orderNumber,
        from: RETURNED,
        to: plan.to,
        message: RETURN_UNDO_SUCCESS_AR(done.orderNumber, toWord),
      });
    } catch (e) {
      if (e instanceof ReturnUndoStopped) return NextResponse.json({ ...e.body, errorAr: e.body.error }, { status: e.status });
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
