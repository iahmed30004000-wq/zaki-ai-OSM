import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { returnsFilters, viewScope } from '@/lib/returns-filters';
import { isReceiptRace, receiveReturn } from '@/lib/return-receipt';
import { RECEIVE_ALL_CHUNK, type ReceiveAllAnswer, type ReceiveAllSkip } from '@/lib/returns-receive-all';
import { INTAKE_REFUSAL_CODES, type IntakeRefusalCode } from '@/lib/warehouse-intake';
import { reachesWarehouse } from '@/lib/warehouses';

/**
 * POST /api/ops/returns/receive-all — «استلام الكل».
 *
 *   «بدي زر استلام الكل مع صلاحية للمالك» (11/11)
 *
 * Body: the list's own filters (`view` · `status` · `courier` · `age` · `q`, read by `returnsFilters`, the GET's reader),
 * `countedAndInspected: true` (the dialog's tick — the same literal the single door asks), and `cursor` (the last id the
 * previous answer reached). The SERVER derives the parcels from those filters with the same company, store and view
 * scope as the list; the screen never sends ids.
 *
 * Answer: `{ received, skipped: { reason: count }, nextCursor }` — at most `RECEIVE_ALL_CHUNK` parcels a request, walked
 * by id ascending past the cursor (see lib/returns-receive-all.ts for why not «what is left»). `nextCursor` null = the end.
 *
 * Each parcel is received by `receiveReturn` — the single door's own function — whole and sound, in its own
 * transaction. What it refuses is counted by reason and the walk goes on; a database error on one parcel is counted as
 * `FAILED` and the walk goes on; the database's «one receipt per order» on a double press reads as `ALREADY_RECEIVED`.
 *
 * The gates come first, before anything is read: the context, the returns key, THIS door's own key (granted to nobody;
 * the owner's full access holds it), the body, the view.
 *
 * ── ONE WAREHOUSE FOR THE WHOLE PRESS (the warehouse plan, W2b) ──
 *
 * A store placed in warehouses receives every parcel of the press into the ONE warehouse the body names (`warehouseId`);
 * no parcel falls back to the warehouse it left from (that is the single dialog's default, where a person holds the box).
 * The warehouse is checked by each receipt (`return-receipt.receiveReturn`): a refusal of it is a refusal of the PRESS —
 * the same for every parcel — so the walk stops at once and the door answers that sentence, with what was already
 * received said beside it. A store that is not placed: the field is not read, and the walk is the one it always was.
 */

const schema = z.object({
  view: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  courier: z.string().max(60).optional(),
  age: z.string().max(40).optional(),
  /** «بلا باركود»: the screen sends the filter it draws, so the door walks exactly the parcels the button was counted from. */
  barcode: z.string().max(20).optional(),
  q: z.string().max(200).optional(),
  countedAndInspected: z.literal(true, { message: 'يلزم إقرار العد والفحص قبل الاستلام' }),
  cursor: z.string().uuid().nullish(),
  /** W2b: the one warehouse every parcel of the press is received into — read only for a store placed in warehouses. */
  warehouseId: z.string().max(64).optional().nullable().catch(undefined),
});

const FORBIDDEN_AR = 'استلام كل المرتجعات دفعة واحدة مش من صلاحياتك — اطلبها من المالك إذا كانت من شغلك.';

const isPlaceRefusal = (code: string): code is IntakeRefusalCode => (INTAKE_REFUSAL_CODES as readonly string[]).includes(code);

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('ops.returns');
    if (!can(user, 'ops.returns_receive_all')) {
      return NextResponse.json(
        { error: 'Forbidden: missing required permission ops.returns_receive_all', errorAr: FORBIDDEN_AR, code: 'FORBIDDEN' },
        { status: 403 }
      );
    }

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const message = zodMessage(parsed.error);
      return NextResponse.json({ error: message, errorAr: message }, { status: 400 });
    }
    const body = parsed.data;

    // The list's own reader, over the list's own words — never a second copy of the rule.
    const params = new URLSearchParams();
    for (const k of ['view', 'status', 'courier', 'age', 'barcode', 'q'] as const) {
      const v = body[k];
      if (typeof v === 'string') params.set(k, v);
    }
    const filters = returnsFilters(params, { now: new Date(), maySeeContact: can(user, 'customers.view') });
    if (!filters.ok) return NextResponse.json({ error: filters.error, errorAr: filters.errorAr }, { status: 400 });
    if (filters.view !== 'pending') {
      const ar = 'استلام الكل بس لعرض «بانتظار الاستلام» — اللي انستلم ما بينستلم مرة تانية.';
      return NextResponse.json({ error: ar, errorAr: ar, code: 'NOT_PENDING_VIEW' }, { status: 400 });
    }

    // The scope at the TOP of the question, what was chosen ANDed onto it — exactly as the list asks — and the cursor last.
    const where = {
      ...viewScope('pending', { companyId, storeId }),
      AND: [...filters.clauses, ...(body.cursor ? [{ id: { gt: body.cursor } }] : [])],
    };
    const chunk = await db.order.findMany({ where, orderBy: { id: 'asc' }, take: RECEIVE_ALL_CHUNK, select: { id: true } });

    const answer: ReceiveAllAnswer = { received: 0, skipped: {}, nextCursor: null };
    const skip = (why: ReceiveAllSkip) => {
      answer.skipped[why] = (answer.skipped[why] ?? 0) + 1;
    };
    const note = user.name ? `استلام جماعي — ${user.name}` : 'استلام جماعي';

    let placeRefused: { status: number; body: Record<string, unknown> } | null = null;
    for (const { id } of chunk) {
      try {
        const r = await receiveReturn(
          { user, companyId, storeId, minorUnit: country.minorUnit, mayUse: (w) => reachesWarehouse(user, companyId, w) },
          { orderId: id, receivedQty: 'WHOLE', damagedQty: 0, chargeCourierFee: false, note, ...(body.warehouseId ? { warehouseId: body.warehouseId } : {}) },
          { bulk: true }
        );
        if (r.ok) answer.received += 1;
        else if (isPlaceRefusal(r.code)) {
          // W2b: the warehouse of the press was refused — the same for every parcel. Stop here, say it.
          placeRefused = { status: r.status, body: r.body };
          break;
        } else skip(r.code);
      } catch (e) {
        // Two presses, or two people, at the same moment: the database kept one receipt and refused the other.
        if (isReceiptRace(e)) skip('ALREADY_RECEIVED');
        else {
          console.error('[receive-all] one parcel failed', id, e);
          skip('FAILED');
        }
      }
    }
    answer.nextCursor = placeRefused ? null : chunk.length === RECEIVE_ALL_CHUNK ? chunk[chunk.length - 1].id : null;

    // ONE line for the request; each received parcel also carries its own `RETURN_RECEIVED` row (with `bulk: true`).
    await logAudit({
      companyId, userId: user.id, action: 'RETURNS_RECEIVED_ALL',
      entity: 'Store', entityId: storeId,
      newData: {
        filters: filters.applied,
        cursor: body.cursor ?? null,
        looked: chunk.length,
        received: answer.received,
        skipped: answer.skipped,
        nextCursor: answer.nextCursor,
        ...(placeRefused ? { warehouseRefused: placeRefused.body.code } : {}),
      },
    });

    if (placeRefused) return NextResponse.json({ ...placeRefused.body, ...answer }, { status: placeRefused.status });
    return NextResponse.json(answer);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
