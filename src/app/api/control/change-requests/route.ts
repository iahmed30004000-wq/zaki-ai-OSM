import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { BEFORE_OPERATIONS } from '@/lib/change-request-routing';
import { readLinesChange, touchesMoney } from '@/lib/change-request-fields';
import { apiErrorResponse } from '@/lib/api-error';
import { carryOut, type ChangeIntent } from '@/lib/change-request-intent';
import { handedToCourier } from '@/lib/order-seal';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { ruleFor } from '@/lib/phone-rules';

/**
 * GET /api/control/change-requests?status=PENDING
 * The supervisor / shipping review queue. Overdue rows are flagged by the
 * server: an expired SLA escalates, it never approves anything by itself.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();

    // A supervisor sees the whole desk. An agent sees the requests she is
    // the one who has to answer — the ones on orders still in her hands.
    // Sending her to a screen that refuses her, or showing her a queue she
    // cannot act on, are both ways of making the request sit unanswered.
    //
    // Seeing the WHOLE desk is its own key, `control.change_requests_view` (PR-7). It used to be the decision key OR four
    // role names, so the owner could untick «طلبات التعديل» from a manager and the manager went on seeing every request.
    // The migration gave the new key to the holders of the old one AND to the four names, so the same people see the whole
    // desk the day after — and from then on the owner can untick one of them.
    const supervises = can(user, 'control.change_requests_view');
    // AND THE REQUESTS SHE RAISED HERSELF.
    //
    // This filter was only «orders still in my hands», which is right for
    // the ones she has to ANSWER and leaves out every one she ASKED. A
    // moderator raising a request on a confirmed order does not hold that
    // order and never will — so her own request was invisible to her on the
    // one screen that lists them. She could not see the decision, and could
    // not take the request back.
    const mine = supervises
      ? {}
      : {
          OR: [
            { order: { claimedById: user.id, confirmationStatus: { in: BEFORE_OPERATIONS } } },
            { requestedById: user.id },
          ],
        };

    const status = new URL(req.url).searchParams.get('status') ?? 'PENDING';
    const now = new Date();

    // AWAITING_APPLY is not a stored status: it is an approved request whose
    // change has not been carried out yet — the queue's second list. Named
    // here so the screen asks for a state rather than assembling a filter.
    const statusWhere =
      status === 'all'
        ? {}
        : status === 'AWAITING_APPLY'
          ? { status: 'APPROVED', appliedAt: null }
          : { status };

    const rows = await db.orderChangeRequest.findMany({
      where: {
        companyId,
        ...statusWhere,
        ...mine,
        order: { storeId },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: 200,
      include: {
        order: {
          select: {
            id: true, orderNumber: true, merchantRef: true, confirmationStatus: true, shippingStatus: true,
            // The version the screen is about to write against. Without it
            // «طبّق» sent no `expectedVersion` and the order route refused
            // every press with «expectedVersion is required for order
            // updates» — this half of the queue had never applied anything.
            version: true,
            // Where the parcel is decides what carrying the request out even
            // means — a cancellation before the waybill is a cancellation,
            // and after it is a message to the courier and a return.
            shippedAt: true, labelPrintedAt: true,
            // The trolley's status: «the courier has taken it» is the press of
            // «إغلاق الشحنة — سُلّمت للشركة», not the printer.
            shippingBatch: { select: { status: true } },
            customer: { select: { fullName: true, phone: true } },
          },
        },
      },
    });

    const requesterIds = [...new Set(rows.map((r) => r.requestedById))];
    const requesters = requesterIds.length
      ? await db.user.findMany({ where: { id: { in: requesterIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(requesters.map((u) => [u.id, u.name]));

    // The products a request that edits lines names, by id, so the queue can say «كريم» and not an id nobody can read.
    const linesOf = new Map(rows.map((r) => [r.id, readLinesChange(r.changes)] as const));
    const lineProductIds = new Set<string>();
    for (const parsed of linesOf.values()) {
      if (!parsed.ok || !parsed.value) continue;
      for (const e of parsed.value.edits) {
        if (e.productId) {
          lineProductIds.add(e.productId.from);
          lineProductIds.add(e.productId.to);
        }
      }
    }
    const lineProducts = lineProductIds.size
      ? await db.product.findMany({ where: { id: { in: [...lineProductIds] }, companyId }, select: { id: true, name: true } })
      : [];
    const productName = new Map(lineProducts.map((p) => [p.id, p.name]));
    const lineNamesOf = (id: string): Record<string, string> => {
      const parsed = linesOf.get(id);
      if (!parsed || !parsed.ok || !parsed.value) return {};
      const out: Record<string, string> = {};
      for (const e of parsed.value.edits) {
        for (const pid of e.productId ? [e.productId.from, e.productId.to] : []) {
          const name = productName.get(pid);
          if (name) out[pid] = name;
        }
      }
      return out;
    };

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'طلبات التعديل', rows });

    return NextResponse.json({
      count: rows.length,
      // The country's calling code: the courier's number is typed local, and WhatsApp needs it in full.
      dialCode: ruleFor(country.code)?.dialCode ?? null,
      requests: rows.map((r) => ({
        ...r,
        requestedByName: nameOf.get(r.requestedById) ?? null,
        // The names behind the product ids of a lines request (empty for any other): the queue prints these, never the ids.
        lineNames: lineNamesOf(r.id),
        /**
         * WHAT PRESSING THE BUTTON WILL DO, decided here rather than in the
         * browser. The screen has to name the act on the button — «ألغِ
         * الطلب» and «أبلغ شركة الشحن» are not the same press — and the
         * rule that tells them apart is `handedToCourier` (the press of
         * «إغلاق الشحنة — سُلّمت للشركة»), which the screen would have to
         * re-derive from three columns and a trolley to guess at.
         */
        carryOut: carryOut((r.intent ?? 'EDIT') as ChangeIntent, {
          handedToCourier: handedToCourier({
            shippingStatus: r.order.shippingStatus,
            shippedAt: r.order.shippedAt,
            batchStatus: r.order.shippingBatch?.status ?? null,
          }),
        }),
        // Hers to withdraw, never hers to decide — the decide route refuses
        // self-approval, and a button that always 403s teaches people the
        // screen is lying to them.
        isMine: r.requestedById === user.id,
        // A request that moves a figure is APPROVED only by somebody who holds `orders.change_price` (PR-7). The screen
        // says so instead of offering a button the server would refuse; rejecting stays open.
        needsPriceKey: touchesMoney(r.changes) && !can(user, 'orders.change_price'),
        overdue: r.status === 'PENDING' && !!r.slaDueAt && new Date(r.slaDueAt) < now,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
