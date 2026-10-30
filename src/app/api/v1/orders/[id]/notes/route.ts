import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSystemToken } from '@/lib/v1/system-token';
import { V1_CODE, V1Fault, requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import {
  claimIdempotency,
  idempotencyKeyOf,
  releaseIdempotency,
  rememberIdempotency,
  requestFingerprint,
} from '@/lib/v1/idempotency';
import { NOTE_KINDS } from '@/lib/order-notes';

/**
 * POST /api/v1/orders/{id}/notes — «الزبون طلب التوصيل بعد الساعة 5».
 *
 * A note is how a conversation reaches the person who will ring the
 * customer. Without this the replies system has nowhere to put what it
 * learned, and the agent calls to ask a question that was already answered.
 *
 * ── THE SAME NOTE STORE, AND THE SAME FOUR KINDS ──
 *
 * `OrderNote`, with `NOTE_KINDS` imported from `src/lib/order-notes.ts`
 * rather than re-listed here: `the-notes-invariants.test.ts` holds that
 * vocabulary exhaustively, and a fifth kind spelled only in this file would
 * render as nothing on all four screens that read notes.
 *
 * FROM THE LIBRARY AND NOT FROM THE OTHER ROUTE, although the other route
 * exports the same constant. A `route.ts` importing a `route.ts` puts a
 * module in Turbopack's graph with no path to a page root, and Turbopack
 * 16.3.4 does not merely warn: it panics — «internal error: entered
 * unreachable code: there must be a path to a root» — and the build dies
 * with no usable message. Measured, not suspected.
 *
 * Notes are IMMUTABLE for every role including the owner — there is no
 * PATCH and no DELETE here either, and a correction is a new note.
 *
 * ── AND AN ACTIVITY ROW BESIDE IT, SAYING WHO PUT IT THERE ──
 *
 * «ملاحظة بـ OrderActivity بمصدر «الردود»». `OrderNote.authorId` is null,
 * because no employee wrote this and naming one would be a false trail; so
 * the activity row is what carries the provenance, and the timeline reads
 * «من نظام الردود» instead of an unexplained note from nobody.
 */

const noteSchema = z.object({
  kind: z.enum(NOTE_KINDS).default('internal'),
  note: z.string().trim().min(2).max(2000),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdOf(req);
  let claimed: { companyId: string; key: string } | null = null;
  try {
    const caller = await requireSystemToken(req, 'orders.note');
    const { id } = await params;

    const raw = await req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body is not JSON');
    }
    const parsed = noteSchema.safeParse(body);
    if (!parsed.success) {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body does not fit the schema', {
        fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))],
      });
    }

    /*
     * THE ORDER IS PROVED TO BE THIS COMPANY'S BEFORE THE KEY IS CLAIMED.
     *
     * A note on somebody else's order is a 404, and burning an idempotency
     * key on it would mean the caller could not reuse that key once it
     * corrected the id.
     */
    const order = await db.order.findFirst({
      where: { id, companyId: caller.companyId },
      select: { id: true },
    });
    if (!order) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such order');

    const key = idempotencyKeyOf(req);
    // The path as it arrived — see the note in `POST /api/v1/orders`.
    const fingerprint = requestFingerprint('POST', new URL(req.url).pathname, raw);
    const replay = await claimIdempotency(caller.companyId, key, fingerprint);
    if (replay) return v1Ok(requestId, replay.body as Record<string, unknown>, replay.status);
    claimed = { companyId: caller.companyId, key };

    await db.$transaction(async (tx) => {
      await tx.orderNote.create({
        data: {
          companyId: caller.companyId,
          orderId: order.id,
          body: parsed.data.note,
          kind: parsed.data.kind,
          // No employee wrote this. See the header.
          authorId: null,
        },
      });
      await tx.orderActivity.create({
        data: {
          companyId: caller.companyId,
          orderId: order.id,
          userId: null,
          action: 'NOTE_ADDED',
          metadata: JSON.stringify({ via: 'api/v1', system: caller.system, kind: parsed.data.kind }),
        },
      });
    });

    const answer = { ok: true };
    await rememberIdempotency(caller.companyId, key, 201, answer);
    claimed = null;
    return v1Ok(requestId, answer, 201);
  } catch (error) {
    if (claimed) await releaseIdempotency(claimed.companyId, claimed.key);
    return v1ErrorResponse(requestId, error);
  }
}
