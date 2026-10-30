import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { rateLimit } from '@/lib/rate-limit';
import { mayDecide } from '@/lib/change-request-routing';
import { handedToCourier } from '@/lib/order-seal';
import type { EditableOrderRow } from '@/lib/order-edit-facts';
import { previewStoredRequest } from '@/lib/change-request-review-facts';
import { DECIDER_PREVIEWS_PER_MINUTE, deciderPreviewRateKey } from '@/lib/change-request-review';

/**
 * WHAT A STORED `lines` REQUEST WOULD DO TO THE ORDER — TODAY, NOT WHEN IT WAS RAISED.
 *
 *   GET /api/control/change-requests/:id/preview
 *
 * The screen of the person deciding draws a «before ← after» table from this and shuts the approve button when it says
 * the request cannot be carried out. A read: nothing is written, locked, notified or logged. It judges the figures the
 * request STORED (it prices nothing again) against the order as it stands, with the questions the apply door asks, and
 * says what moved since the request was raised.
 *
 * WHO MAY ASK: whoever sees the request in the queue (`GET /api/control/change-requests`) — the whole desk, the agent
 * holding the order, the person who raised it — and whoever may decide it at this stage. Anyone else, an order of another
 * company or another store, and a request that does not exist get the SAME 404: a preview is a way to read an order.
 *
 * WHAT IT NEVER SHOWS: the order's cost or profit, and the shelf's whole balance (a product is «enough» or not).
 *
 * HOW OFTEN: the decider's screen asks once per card it checks, so it has a budget of its own (`control-preview:…`), apart from
 * the raising screen's: a page of cards must not spend what the same person needs to raise a request.
 */

const NOT_FOUND = 'طلب التعديل غير موجود';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();

    const request = await db.orderChangeRequest.findFirst({
      where: { id, companyId, order: { storeId } },
      select: {
        id: true,
        status: true,
        appliedAt: true,
        changes: true,
        requestedById: true,
        order: {
          select: {
            id: true,
            countryId: true,
            customerId: true,
            regionId: true,
            deliveryProviderId: true,
            confirmationStatus: true,
            claimedById: true,
            shippingStatus: true,
            shippedAt: true,
            labelPrintedAt: true,
            trackingNumber: true,
            courierSendStartedAt: true,
            settlementStatus: true,
            priceIncludesDelivery: true,
            totalAmount: true,
            shippingCost: true,
            deliveryFee: true,
            discountAmount: true,
            offerId: true,
            version: true,
            shippingBatch: { select: { status: true } },
          },
        },
      },
    });
    if (!request) return NextResponse.json({ error: NOT_FOUND, errorAr: NOT_FOUND }, { status: 404 });

    const order = request.order;
    const seesTheDesk = can(user, 'control.change_requests_view');
    const mine = request.requestedById === user.id;
    const holding = mayDecide(
      user,
      {
        confirmationStatus: order.confirmationStatus,
        claimedById: order.claimedById,
        handedToCourier: handedToCourier({
          shippingStatus: order.shippingStatus,
          shippedAt: order.shippedAt,
          batchStatus: order.shippingBatch?.status ?? null,
        }),
      },
      // The price key decides whether the person may APPROVE; looking at what the request does is for every decider.
      { money: false }
    ).allowed;
    if (!seesTheDesk && !mine && !holding) {
      return NextResponse.json({ error: NOT_FOUND, errorAr: NOT_FOUND }, { status: 404 });
    }

    const limit = rateLimit(deciderPreviewRateKey(companyId, user.id), DECIDER_PREVIEWS_PER_MINUTE, 60 * 1000);
    if (!limit.allowed) {
      const message = `طلبات كثيرة جداً. أعد المحاولة بعد ${limit.retryAfterSec} ثانية`;
      return NextResponse.json(
        { error: message, errorAr: message, code: 'RATE_LIMITED' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
      );
    }

    // A request that was decided against, withdrawn or carried out has nothing left to check.
    const open = request.status === 'PENDING' || (request.status === 'APPROVED' && !request.appliedAt);
    if (!open) {
      const message = 'هذا الطلب انبتّ فيه أو انطبّق — ما في شي ينفحص.';
      return NextResponse.json({ error: message, errorAr: message, code: 'NOT_OPEN' }, { status: 409 });
    }

    const result = await previewStoredRequest({
      requestId: request.id,
      changes: request.changes,
      order: order as unknown as EditableOrderRow,
      companyId,
      country,
    });
    if (!result.ok) {
      const message = result.reason === 'NOT_LINES' ? 'هذا الطلب ما فيه أسطر — ما في معاينة له.' : result.error;
      return NextResponse.json(
        { error: message, errorAr: message, code: result.reason === 'NOT_LINES' ? 'NOT_LINES' : 'LINES_UNREADABLE' },
        { status: result.reason === 'NOT_LINES' ? 400 : 422 }
      );
    }

    return NextResponse.json(result.preview, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
