import { NextResponse } from 'next/server';
import { afterResponse } from '@/lib/notify';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { assertOrderAccess, assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { addBusinessMinutes } from '@/lib/business-calendar';
import { zodMessage } from '@/lib/zod-message';
import { CHANGEABLE_FIELDS, withFrom } from '@/lib/change-request-fields';
import { CHANGE_INTENTS, INTENT_AR, INTENT_ASK_AR, carryOut, missingFor, type ChangeIntent } from '@/lib/change-request-intent';
import { hasLeftWarehouse, type StateSource } from '@/lib/order-state';
import { createNotification } from '@/lib/notification';
import { deciderFor, mayDecide, SUPERVISOR_ROLES } from '@/lib/change-request-routing';
import { orderSeal, handedToCourier } from '@/lib/order-seal';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';

/**
 * Change requests on an order (contract PART 2 / invariant 7).
 *
 *   GET  /api/orders/:id/change-requests
 *   POST /api/orders/:id/change-requests
 *
 * A confirmed order is read-only for the agent: a change goes through a
 * request. A BLOCKING request stops OUR forward transitions only; courier
 * events are always recorded and mark the request as "changed during
 * review". The SLA escalates — it never auto-approves.
 */

/** Business minutes before a pending request escalates (never auto-approves). */
export const CHANGE_REQUEST_SLA_MINUTES = 120;


const createSchema = z.object({
  /**
   * WHICH OF THE THREE. Defaulted, because every request raised before this
   * existed was an edit and every caller that has not been taught the word
   * still means one.
   */
  intent: z.enum(CHANGE_INTENTS).default('EDIT'),
  // partialRecord, NOT record.
  //
  // In Zod 4 a record keyed by an enum is EXHAUSTIVE: it demands every key
  // in the enum. So this schema quietly required all ten changeable fields
  // on every request, and the only answer anybody could get was "اسم
  // العميل مطلوب" — no change request could be raised at all, from any
  // screen, since the upgrade.
  //
  // Optional now, and required only OF AN EDIT — `missingFor` says so, in
  // one place both this route and the dialog read, so a cancellation is
  // not refused for naming no field.
  changes: z
    .partialRecord(z.enum(CHANGEABLE_FIELDS), z.object({ to: z.union([z.string(), z.number()]).nullable() }))
    .optional(),
  /** The day a postponement is asking to wait until. */
  postponeUntil: z.string().datetime().optional(),
  reason: z.string().trim().min(5, 'اذكر سبب التعديل').max(500),
  blocking: z.boolean().default(true),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    const access = await assertOrderReadable(id, user, { companyId, storeId }, 'orders.view');
    if (!access.allowed) return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: 404 });

    const requests = await db.orderChangeRequest.findMany({
      where: { orderId: id, companyId },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ requests });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();

    // «طلب تعديل» on an order she holds — from «أكّدتها» or from its window —
    // through the work door (order-work-door.ts). Reading the list of requests
    // keeps the old door: no screen asks it.
    const access = await assertOrderAccess(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: 404 });
    const order = access.order;

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const intent = parsed.data.intent as ChangeIntent;
    const missing = missingFor(intent, {
      changes: parsed.data.changes ?? null,
      postponeUntil: parsed.data.postponeUntil ?? null,
    });
    if (missing) return NextResponse.json({ error: missing }, { status: 400 });

    /**
     * REFUSED AT THE DOOR, NOT AN HOUR LATER BY A SUPERVISOR.
     *
     * A postponement once the parcel is with the courier is the one ask
     * that can never be carried out — there is nothing left to hold back.
     * Letting it be raised would put it in somebody's queue for two hours
     * so they could say the same sentence this says now, while the agent
     * believed the customer's date was booked.
     */
    const refusal = carryOut(intent, {
      hasLeftWarehouse: hasLeftWarehouse(order as unknown as StateSource),
    });
    if (refusal.kind === 'REFUSED') {
      return NextResponse.json({ error: refusal.reason, code: 'INTENT_IMPOSSIBLE' }, { status: 409 });
    }

    const open = await db.orderChangeRequest.findFirst({
      where: { orderId: id, status: 'PENDING' },
      select: { id: true },
    });
    if (open) {
      return NextResponse.json(
        { error: 'يوجد طلب تعديل قيد المراجعة على هذا الطلب', code: 'CHANGE_REQUEST_PENDING' },
        { status: 409 }
      );
    }

    const cal = {
      workHoursStart: country.workHoursStart,
      workHoursEnd: country.workHoursEnd,
      weekendDays: country.weekendDays,
      timezone: country.timezone,
    };

    // What each field is changing FROM, read here rather than trusted from
    // the browser: the person deciding needs "3 instead of 2", and a "from"
    // the requester typed could say anything.
    const snapshot = await db.order.findFirst({
      where: { id, companyId },
      select: {
        quantity: true, productId: true, sellingPrice: true, discountAmount: true, customerNotes: true,
        // The governorate it ships to — what a «change the city» request
        // actually means, and the only one of the two the order can write.
        regionId: true,
        customer: { select: { fullName: true, phone: true, altPhone: true, address: true, city: true } },
      },
    });
    if (!snapshot) return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: 404 });

    const created = await db.orderChangeRequest.create({
      data: {
        companyId,
        orderId: id,
        requestedById: user.id,
        requestedRole: user.role,
        intent,
        changes: withFrom(snapshot, parsed.data.changes ?? {}) as object,
        postponeUntil: parsed.data.postponeUntil ? new Date(parsed.data.postponeUntil) : null,
        reason: parsed.data.reason,
        blocking: parsed.data.blocking,
        slaDueAt: addBusinessMinutes(new Date(), CHANGE_REQUEST_SLA_MINUTES, cal),
      },
    });

    /**
     * NOBODY WAITS FOR THEIR OWN PERMISSION.
     *
     * The rule this door exists for is real: a confirmed order is read-only
     * for the agent, and a change goes past a second pair of eyes. But the
     * second pair of eyes belonged to whoever may DECIDE — and when the
     * person raising the request is already that person, the queue was a
     * supervisor approving a note they had written thirty seconds earlier,
     * on a screen they had to go and open.
     *
     * So it decides itself, under two conditions, and only both together:
     *
     *   THE RAISER MAY DECIDE IT. `mayDecide` — the supervisor, or the agent
     *   actually holding the order before operations. An agent raising one
     *   on somebody else's order still waits, which is the whole rule.
     *
     *   THE PARCEL HAS NOT LEFT. Once the waybill is printed the change is
     *   not ours to make at all: it is a message to the courier, and the
     *   apply path refuses it until they have been told. Self-deciding there
     *   would only move the refusal one step later.
     *
     * It is recorded as a decision with a name and a reason, not as a row
     * that appeared already approved — «طُبِّق مباشرةً» is a fact about who
     * did what, and the audit and the reports read it like any other.
     */
    const batch = await db.shippingBatch.findFirst({
      where: { orders: { some: { id } }, companyId },
      select: { status: true, batchNumber: true },
    });
    const seal = orderSeal({
      shippingBatch: batch,
      shippingStatus: (order as { shippingStatus?: string }).shippingStatus,
      shippedAt: (order as { shippedAt?: Date | null }).shippedAt ?? null,
      labelPrintedAt: (order as { labelPrintedAt?: Date | null }).labelPrintedAt ?? null,
    });
    const mine = mayDecide(user, {
      confirmationStatus: order.confirmationStatus,
      claimedById: (order as { claimedById?: string | null }).claimedById ?? null,
      // The handover, not the printer: a labelled parcel still on our
      // floor is the warehouse's to answer. `batch` is already loaded
      // above for the seal.
      handedToCourier: handedToCourier({
        shippingStatus: (order as { shippingStatus?: string }).shippingStatus ?? '',
        shippedAt: (order as { shippedAt?: Date | null }).shippedAt ?? null,
        batchStatus: batch?.status ?? null,
      }),
    });
    const readyToApply = mine.allowed && !seal.sealed;

    if (readyToApply) {
      await db.orderChangeRequest.update({
        where: { id: created.id },
        data: {
          status: 'APPROVED',
          decidedById: user.id,
          decidedAt: new Date(),
          decisionNote: 'طُبِّق مباشرةً — رافعُه يملك البتَّ فيه، والطرد لم يُسلَّم لشركة الشحن بعد.',
        },
      });
    }

    // Tell whoever has to answer it.
    //
    // Without this the request sat on a screen until somebody happened to
    // open it. The agent presses «طلب تعديل» with a customer on the phone
    // and then has no idea whether anyone will ever look — so she calls a
    // supervisor anyway, and the whole mechanism becomes a slower way of
    // doing what she was already doing.
    //
    // It goes to the person the routing rule names: the agent holding the
    // order before confirmation, the supervisors after it. Never to the
    // requester — being told about your own request is noise.
    //
    // "Supervisors" is whoever may decide — control.change_requests, in
    // this store — not a list of role names. The list left out the delivery
    // manager, who decides these every day, and reached supervisors of
    // stores the order is not in.
    //
    // When the holder IS the requester (or has left, or lost this store),
    // the first call reaches nobody, and a request nobody hears about is
    // one nobody answers — she cannot approve her own. So it falls through
    // to the supervisors, who may always decide.
    //
    // The queue is closed to the holding agent (control.change_requests),
    // so her link is the list her order sits in.
    const decider = deciderFor({
      confirmationStatus: order.confirmationStatus,
      claimedById: (order as { claimedById?: string | null }).claimedById ?? null,
    });
    const notice = {
      companyId,
      storeId: order.storeId ?? storeId,
      actorId: user.id,
      type: 'SYSTEM_ALERT' as const,
      // The title says WHICH of the three, because «طلب تعديل» on a
      // cancellation reads as a field edit and gets answered like one.
      title: `طلب ${INTENT_AR[intent]} على ${order.orderNumber}`,
      message: `${user.name ?? 'موظف'}: ${parsed.data.reason}`,
      link: ['/control/change-requests', '/confirmation/mine', '/orders'],
    };
    afterResponse(async () => {
      // Nothing to announce when it was decided by the person who raised it.
      if (readyToApply) return;
      const told =
        decider.kind === 'HOLDING_AGENT'
          ? await createNotification({ ...notice, audience: { userIds: [decider.userId] } })
          : 0;
      if (!told) {
        // Everyone who may decide it — the same set mayDecide lets through,
        // the permission AND the supervising roles, so nobody who can answer
        // a request is left unaware of it.
        await createNotification({
          ...notice,
          audience: { permission: 'control.change_requests', roles: SUPERVISOR_ROLES },
        });
      }
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'CHANGE_REQUEST_RAISED',
      entity: 'Order',
      entityId: id,
      newData: { requestId: created.id, intent, changes: parsed.data.changes, reason: parsed.data.reason },
    });
    await db.orderNote.create({
      data: {
        companyId,
        orderId: id,
        authorId: user.id,
        kind: 'internal',
        body: `${INTENT_ASK_AR[intent]} — طلب: ${parsed.data.reason}`,
      },
    });

    return NextResponse.json(
      { request: created, orderStatus: order.confirmationStatus, readyToApply },
      { status: 201 }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
