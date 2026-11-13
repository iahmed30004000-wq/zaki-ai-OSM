import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { LegacyStopped } from '@/lib/legacy-closeout';
import { closePicked, measurePicked, readPicked } from '@/lib/legacy-closeout-picked';
import { ACK_AR, FORBIDDEN_LEGACY_AR, PICKED_CLOSE_AUDIT, PICKED_MOST } from '@/lib/legacy-closeout-words';

/**
 * «أقفل المحدّد بلا حركة مال» — `POST /api/ops/tracking/close-legacy/picked`.
 *
 *   «اقدر اعمل هالحركة هاي لاي طلب حتى لو عليه باركود، بس بدي الزر هاد متاح للمالك فقط» (the owner, 13/11)
 *
 * { action: 'measure', orderIds }                                  — MEASURES, and writes nothing: how many of the ticked orders the
 *                                                                    press would close, whose they are, what they are worth, how many
 *                                                                    carry a barcode or arrived lately, and the ones it would leave,
 *                                                                    each with its reason. (`lib/legacy-closeout-picked.ts`)
 * { action: 'close', orderIds, fingerprint, count, acknowledged }  — closes exactly the orders the measure showed, or nothing.
 *
 * The same key as the old-ones press (`ops.close_legacy`, which nobody but the owner holds by default), checked FIRST — before the
 * body is read, before a single order is. The orders are the ones he ticked: any barcode, any age. The rules, and what is never
 * written, are in `lib/legacy-closeout-picked.ts` and `lib/legacy-closeout.ts`.
 */

const orderIds = z.array(z.string().uuid()).min(1).max(PICKED_MOST);

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('measure'), orderIds }),
  z.object({
    action: z.literal('close'),
    orderIds,
    /** What the dialog showed: the press refuses if the orders are no longer these. */
    fingerprint: z.string().min(8).max(64),
    count: z.number().int().min(1).max(PICKED_MOST),
    acknowledged: z.literal(true, { message: ACK_AR }),
  }),
]);

// Both sentences in Arabic (the English-refusals ratchet only falls); the key is still in the message, so support can read it.
const forbidden = () =>
  NextResponse.json(
    { error: 'ناقصك مفتاح ops.close_legacy', errorAr: FORBIDDEN_LEGACY_AR, code: 'FORBIDDEN' },
    { status: 403 }
  );

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
        const read = await readPicked(db, scope, body.orderIds);
        return NextResponse.json(measurePicked(read, new Date()).measure);
      }

      // One transaction: the claim, the log and the mark land together or not at all.
      const measured = await db.$transaction(
        (tx) =>
          closePicked(tx, {
            scope,
            user: { id: user.id, role: user.role },
            ids: body.orderIds,
            fingerprint: body.fingerprint,
            count: body.count,
          }),
        { timeout: 30_000, maxWait: 10_000 }
      );

      const { measure, rows } = measured;
      // ONE line for the press (each order also carries its own mark and its own line on the settlement log).
      await logAudit({
        companyId,
        userId: user.id,
        action: PICKED_CLOSE_AUDIT,
        entity: 'Store',
        entityId: storeId,
        newData: {
          closed: rows.length,
          couriers: measure.closeable.byCourier,
          value: measure.closeable.value,
          withBarcode: measure.closeable.withBarcode,
          recent: measure.closeable.recent,
          orders: measure.closeable.fingerprint,
          first: rows.slice(0, 20).map((r) => r.orderNumber),
        },
      });

      return NextResponse.json({
        closed: rows.length,
        message: `اتقفل ${rows.length} طلب كمحصَّل — بلا أي حركة مصاري`,
      });
    } catch (e) {
      if (e instanceof LegacyStopped) return NextResponse.json({ ...e.body, errorAr: e.body.error }, { status: e.status });
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
