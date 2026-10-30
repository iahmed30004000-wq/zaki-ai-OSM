import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { assertOrderAccess } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { rateLimit } from '@/lib/rate-limit';
import { zodMessage } from '@/lib/zod-message';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { previewDraftSchema } from '@/lib/order-line-edit';
import { previewOrderEdit, type EditableOrderRow } from '@/lib/order-edit-facts';

/**
 * WHAT A MULTI-FIELD EDIT WOULD DO — ANSWERED BEFORE ANYBODY ASKS FOR IT.
 *
 *   POST /api/orders/:id/change-requests/preview
 *
 * The draft is in the body, so this is a POST; it is a READ. Nothing is written, locked, notified or logged: it
 * reads the order and the shelf, runs the lines engine, and answers with the order before and after (total, discount,
 * delivery fee, what the courier collects, gifts), what each product does to the shelf, the warnings and refusals,
 * and which door the change would go through.
 *
 * WHO MAY ASK: the people who may RAISE the request (`orders.request_change`) over an order they can work — the same
 * door and the same 404 for an order they cannot see as the raise door. A preview of an order you could not edit is a
 * way to read it.
 *
 * HOW OFTEN: the screen asks after every pause in typing, so it is rate-limited per person, per company.
 *
 * WHAT IT NEVER SHOWS: the shelf's whole balance. A product is `needed / missing / enough`; how many units the
 * warehouse holds is not the seller's to read off a preview.
 */

/** Previews a person may ask for in a minute — a pause in typing is about two a second at the very most. */
const PREVIEWS_PER_MINUTE = 90;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();

    const access = await assertOrderAccess(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) return NextResponse.json({ error: ORDER_NOT_FOUND, errorAr: ORDER_NOT_FOUND }, { status: 404 });

    if (!can(user, 'orders.request_change')) {
      return NextResponse.json(
        { error: 'ما عندك صلاحية رفع طلب تعديل.', errorAr: 'ما عندك صلاحية رفع طلب تعديل.', code: 'REQUEST_CHANGE_FORBIDDEN' },
        { status: 403 }
      );
    }

    const limit = rateLimit(`order-edit-preview:${companyId}:${user.id}`, PREVIEWS_PER_MINUTE, 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: `طلبات كثيرة جداً. أعد المحاولة بعد ${limit.retryAfterSec} ثانية`,
          errorAr: `طلبات كثيرة جداً. أعد المحاولة بعد ${limit.retryAfterSec} ثانية`,
          code: 'RATE_LIMITED',
        },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
      );
    }

    const parsed = previewDraftSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const message = zodMessage(parsed.error);
      return NextResponse.json({ error: message, errorAr: message, code: 'INVALID_DRAFT' }, { status: 400 });
    }

    const preview = await previewOrderEdit({
      order: access.order as EditableOrderRow,
      companyId,
      country,
      draft: parsed.data,
    });
    return NextResponse.json(preview);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
