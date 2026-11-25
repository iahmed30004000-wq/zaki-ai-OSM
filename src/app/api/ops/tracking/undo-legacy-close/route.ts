import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { UNDO_REASON_MAX, UNDO_REASON_MIN, settlementWord } from '@/lib/delivery-undo-words';
import { TakeBackStopped, measureTakeBack, readTakeBackFacts, takeBackLegacyClose } from '@/lib/legacy-take-back';
import {
  LEGACY_MARK_UNDONE,
  LEGACY_TAKE_BACK_ACTION,
  TAKE_BACK_ACK_AR,
  TAKE_BACK_FORBIDDEN_AR,
  TAKE_BACK_NOT_FOUND_AR,
  TAKE_BACK_SUCCESS_AR,
} from '@/lib/legacy-take-back-words';

/**
 * «تراجع عن إقفال القديمة» — `POST /api/ops/tracking/undo-legacy-close` (25/11).
 *
 * { action: 'measure', orderId }                                    — MEASURES, writes nothing and opens no transaction: whether the
 *                                                                     no-money close can be taken back, what it would write and leave — or
 *                                                                     why not. (`lib/legacy-take-back.ts`)
 * { action: 'undo', orderId, reason, fingerprint, acknowledged }    — takes the close back exactly as the measure showed, or nothing.
 *
 * The key is the close's own: `ops.close_legacy` — the owner's full access holds it, nobody else by default. It is checked FIRST (after the
 * tracking key), before the body is read and before a single order is. One order per press, a reason of five characters at least.
 *
 * Writes only through the transaction's own client: the order's settlement, the mark renamed, the settlement log line and the activity land
 * together or not at all; then one audit row. Never a wallet movement, an amount, the stock, a commission entry or an event.
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
    acknowledged: z.literal(true, { message: TAKE_BACK_ACK_AR }),
  }),
]);

// Both sentences in Arabic (the English-refusals ratchet only falls); the key is still in the message, so support can read it.
const forbidden = () =>
  NextResponse.json({ error: 'ناقصك مفتاح ops.close_legacy', errorAr: TAKE_BACK_FORBIDDEN_AR, code: 'FORBIDDEN' }, { status: 403 });

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.track');
    if (!can(user, 'ops.close_legacy')) return forbidden();

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const message = zodMessage(parsed.error);
      return NextResponse.json({ error: message, errorAr: message }, { status: 400 });
    }
    const scope = { companyId, storeId };
    const body = parsed.data;

    try {
      if (body.action === 'measure') {
        const facts = await readTakeBackFacts(db, scope, body.orderId);
        if (!facts) {
          return NextResponse.json({ error: TAKE_BACK_NOT_FOUND_AR, errorAr: TAKE_BACK_NOT_FOUND_AR, code: 'NOT_FOUND' }, { status: 404 });
        }
        return NextResponse.json(measureTakeBack(facts));
      }

      // One transaction: the claim, the mark, the log line and the activity land together or not at all.
      const done = await db.$transaction(
        (tx) =>
          takeBackLegacyClose(tx, {
            scope,
            user: { id: user.id, role: user.role },
            orderId: body.orderId,
            reason: body.reason,
            fingerprint: body.fingerprint,
          }),
        { timeout: 30_000, maxWait: 10_000 }
      );

      const { plan } = done;
      // ONE line for the press (the order also carries its own activity row and its settlement log line).
      await logAudit({
        companyId,
        userId: user.id,
        action: LEGACY_TAKE_BACK_ACTION,
        entity: 'Order',
        entityId: body.orderId,
        previousData: { settlementStatus: 'SETTLED' },
        newData: {
          settlementStatus: plan.to,
          reason: body.reason,
          marks: plan.markIds.length,
          renamedTo: LEGACY_MARK_UNDONE,
          orderNumber: done.orderNumber,
        },
      });

      return NextResponse.json({
        undone: true,
        orderNumber: done.orderNumber,
        from: 'SETTLED',
        to: plan.to,
        message: TAKE_BACK_SUCCESS_AR(done.orderNumber, settlementWord(plan.to)),
      });
    } catch (e) {
      if (e instanceof TakeBackStopped) return NextResponse.json({ ...e.body, errorAr: e.body.error }, { status: e.status });
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
