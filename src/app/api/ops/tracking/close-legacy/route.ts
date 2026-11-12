import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { LegacyStopped, closeLegacy, measureLegacy, readLegacy } from '@/lib/legacy-closeout';
import {
  ACK_AR,
  BAD_AGE_AR,
  DEFAULT_LEGACY_AGE,
  FORBIDDEN_LEGACY_AR,
  LEGACY_CLOSE_ACTION,
  LEGACY_MOST,
  readLegacyAge,
} from '@/lib/legacy-closeout-words';

/**
 * «أقفل القديمة بلا باركود» — `/api/ops/tracking/close-legacy`.
 *
 *   «كل الطلبات الي بانتظار التحصيل وما الها بار كود سويها تم تحصيلها بدون ما تأثر على المالية» (the owner, 12/11)
 *
 * GET  ?age=1|3|7|14|30   — MEASURES, and writes nothing: how many orders the press would close, who they belong to, what they
 *                           are worth, how many each age would close, and what is left and why. (`lib/legacy-closeout.ts`)
 * POST { age, fingerprint, count, acknowledged: true } — closes exactly the orders the GET showed, or nothing.
 *
 * The rules, the exception to «SETTLED means the money landed», and what is never written are in `lib/legacy-closeout.ts`.
 * The gates come first, before anything is read: the context, the tracking key, THIS door's own key (granted to nobody; the
 * owner's full access holds it), the body.
 */

const schema = z.object({
  age: z.number(),
  /** What the dialog showed: the press refuses if the orders are no longer these. */
  fingerprint: z.string().min(8).max(64),
  count: z.number().int().min(1).max(LEGACY_MOST),
  acknowledged: z.literal(true, { message: ACK_AR }),
});

// Both sentences in Arabic (the English-refusals ratchet only falls); the key is still in the message, so support can read it.
const forbidden = () =>
  NextResponse.json(
    { error: 'ناقصك مفتاح ops.close_legacy', errorAr: FORBIDDEN_LEGACY_AR, code: 'FORBIDDEN' },
    { status: 403 }
  );

const badAge = () => NextResponse.json({ error: BAD_AGE_AR, errorAr: BAD_AGE_AR, code: 'BAD_AGE' }, { status: 400 });

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.track');
    if (!can(user, 'ops.close_legacy')) return forbidden();

    const raw = new URL(req.url).searchParams.get('age');
    const age = raw === null ? DEFAULT_LEGACY_AGE : readLegacyAge(raw);
    if (age === null) return badAge();

    const read = await readLegacy(db, { companyId, storeId });
    return NextResponse.json(measureLegacy(read, age, new Date()).measure);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

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
    const age = readLegacyAge(parsed.data.age);
    if (age === null) return badAge();

    let measured;
    try {
      // One transaction: the claim, the log and the mark land together or not at all. A few thousand rows in a few queries.
      measured = await db.$transaction(
        (tx) =>
          closeLegacy(tx, {
            scope: { companyId, storeId },
            user: { id: user.id, role: user.role },
            age,
            fingerprint: parsed.data.fingerprint,
            count: parsed.data.count,
          }),
        { timeout: 60_000, maxWait: 10_000 }
      );
    } catch (e) {
      if (e instanceof LegacyStopped) return NextResponse.json({ ...e.body, errorAr: e.body.error }, { status: e.status });
      throw e;
    }

    const { measure, rows } = measured;
    // ONE line for the press (each order also carries its own mark and its own line on the settlement log).
    await logAudit({
      companyId,
      userId: user.id,
      action: LEGACY_CLOSE_ACTION,
      entity: 'Store',
      entityId: storeId,
      newData: {
        age,
        closed: rows.length,
        cutoff: measure.cutoff,
        couriers: measure.closeable.byCourier,
        value: measure.closeable.value,
        orders: measure.closeable.fingerprint,
        first: rows.slice(0, 20).map((r) => r.orderNumber),
      },
    });

    return NextResponse.json({
      closed: rows.length,
      message: `اتقفل ${rows.length} طلب كمحصَّل — بلا أي حركة مصاري`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
