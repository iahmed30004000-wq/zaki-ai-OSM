import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { POSTPONE_LEAD_DAYS } from '@/lib/confirmation-queue';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { readLimit, readPage } from '@/lib/numeric-input';
import { actionableOf, daysRemainingOf, postponedFilters } from '@/lib/postponed-filters';
import { postponedFacts, postponedScope, readPostponedPage } from '@/lib/postponed-list';

/**
 * GET /api/confirmation/postponed — orders waiting on a date, with that
 * date, days remaining, preferred time, reason and postpone count.
 * Only rows due within the lead days are actionable, and the server says
 * which: the UI does not compute the window.
 *
 * READ IN PAGES, 25 TO A PAGE, WITH WHAT THE READER CHOSE.
 *
 * «الطلبات المؤجلة — اعملو صفحات + فلاتر + بحث». This used to be the first three
 * hundred rows in date order, whole: past the three-hundredth the list simply
 * stopped, a supervisor looking for «who was postponed twice» scrolled and
 * counted by eye, and there was nothing to type into.
 *
 *   ?page= ?limit=            25 a page, 100 at most (`readPage`, `readLimit`)
 *   ?when=now|overdue|soon|week|later   the moment — by the days the column prints
 *   ?kind=postponed|followup  promised to the customer, or needs a call
 *   ?times=once|many          how often it has been postponed
 *   ?agent=<id>|none          whose hands — a supervisor's question; an agent's
 *                             list is her own and a value here is not obeyed
 *   ?q=                       order number, reference, waybill, name, phone
 *
 * An unknown value is a 400 in Arabic, never a quiet «everything». Every filter
 * is ANDed onto the scope — company, store and, for an agent, her own claim —
 * so none can widen what the person may see; and `facts` (the numbers beside
 * the options) are asked of that scope alone, not of the filtered list.
 */
/** What the page's `select` reads — the fields this route itself uses; the rest ride along. */
type PostponedRow = {
  postponedUntil: Date | null;
  nextFollowUpAt: Date | null;
  customer: { id: string; fullName: string; phone: string; city: string; address: string } | null;
} & Record<string, unknown>;

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.work').catch(async () => requirePermission('confirmation.supervise'));

    const supervisor = can(user, 'confirmation.supervise');
    const mayReassign = can(user, 'confirmation.reassign');
    const now = new Date();
    const params = new URL(req.url).searchParams;

    const parsed = postponedFilters(params, { supervisor, now, leadDays: POSTPONE_LEAD_DAYS });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorAr: parsed.errorAr }, { status: 400 });

    const scope = postponedScope({ companyId, storeId, ownOnly: supervisor ? undefined : user.id });
    const [page, facts] = await Promise.all([
      readPostponedPage<PostponedRow>(db, {
        scope,
        clauses: parsed.clauses,
        page: readPage(params),
        limit: readLimit(params, 25, 100),
        select: {
          id: true, orderNumber: true, merchantRef: true, totalAmount: true, currency: true,
          postponedUntil: true, postponePreferredTime: true, postponeCount: true,
          nextFollowUpAt: true, followUpReason: true, claimedById: true,
          // What is in the order and where it goes — read in the same query as the page (no query per row), display only.
          deliveryAddress: true,
          region: { select: { name: true } },
          customerNotes: true,
          items: { select: { id: true, productName: true, quantity: true, freeQuantity: true } },
          addOns: { select: { id: true, productName: true, quantity: true } },
          customer: { select: { id: true, fullName: true, phone: true, city: true, address: true } },
          claimer: { select: { id: true, name: true } },
        },
      }),
      postponedFacts(db, { scope, supervisor, now, leadDays: POSTPONE_LEAD_DAYS }),
    ]);

    const orders = page.rows.map((o) => {
      const due = o.postponedUntil ?? o.nextFollowUpAt;
      const daysRemaining = daysRemainingOf(due, now);
      return {
        ...o,
        dueAt: due,
        daysRemaining,
        // Actionable only inside the lead window (overdue counts as actionable).
        actionable: actionableOf(daysRemaining, POSTPONE_LEAD_DAYS),
        // «إلى الطابور»: her own order always, a colleague's only with the box for it (`confirmation.reassign`, PR-7).
        mayHandBack: mayReassign || o.claimedById === user.id,
      };
    });

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut. Only the page that was sent.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'الطلبات المؤجّلة', rows: orders });

    return NextResponse.json({
      leadDays: POSTPONE_LEAD_DAYS,
      // How many match what was chosen — the pager's «من 312». It used to be the length of the
      // three-hundred-row page, which stopped being the number of postponed orders at 300.
      count: page.total,
      orders,
      pagination: { total: page.total, page: page.page, limit: page.limit, totalPages: page.totalPages },
      facts,
      applied: parsed.applied,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * POST /api/confirmation/postponed — hand a due one back to the pool.
 *
 * A postponed order KEEPS ITS CLAIM. That is right while the date is far off
 * — the agent who spoke to the customer is the one who should ring back — and
 * wrong the moment it comes due: if she is off that day, or has moved on, the
 * order sits in a list nobody else can reach. The pool requires
 * `claimedById: null`, so nothing else in the product could pick it up.
 *
 * WHY NOT THE RELEASE THAT ALREADY EXISTS. `DELETE /api/orders/[id]/claim`
 * releases a claim, and it is wrong here twice: only the holder may call it,
 * and it sets the order back to `NEW` — which ERASES that it was ever
 * postponed. The whole point is that whoever pulls it next sees «this person
 * asked us to call on Thursday», with the date and how many times they have
 * asked. An order that arrives looking new is an order the next agent opens
 * cold.
 *
 * So the state is untouched. Only the hands change.
 */
export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.work').catch(async () => requirePermission('confirmation.supervise'));

    const { orderId } = (await req.json().catch(() => ({}))) as { orderId?: string };
    if (!orderId) return NextResponse.json({ error: 'المعرّف مطلوب' }, { status: 400 });

    // Handing a COLLEAGUE'S order back is its own box (`confirmation.reassign`, PR-7); her own needs only the desk key.
    const mayReassign = can(user, 'confirmation.reassign');
    const now = new Date();
    const leadEnd = new Date(now.getTime() + POSTPONE_LEAD_DAYS * 24 * 60 * 60 * 1000);

    const order = await db.order.findFirst({
      where: { id: orderId, companyId, storeId },
      select: {
        id: true, orderNumber: true, confirmationStatus: true, claimedById: true,
        postponedUntil: true, nextFollowUpAt: true, version: true,
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });

    // Yours, or you may reassign. Handing somebody else's order to the pool is
    // a decision about their work.
    if (!mayReassign && order.claimedById !== user.id) {
      return NextResponse.json({ error: 'هذا الطلب ليس بين يديك' }, { status: 403 });
    }

    if (!['POSTPONED', 'FOLLOW_UP_REQUIRED'].includes(order.confirmationStatus)) {
      return NextResponse.json({ error: 'هذا الطلب ليس مؤجَّلاً' }, { status: 409 });
    }

    /**
     * ONLY WHEN IT IS DUE.
     *
     * A customer who asked to be called in three weeks has not been called
     * yet for a reason. Putting that order in front of the next free agent
     * today makes the one promise the postpone existed to keep into the one
     * thing we break — and the agent who pulls it can do nothing but postpone
     * it again.
     */
    const due = order.postponedUntil ?? order.nextFollowUpAt;
    if (!due || due.getTime() > leadEnd.getTime()) {
      return NextResponse.json(
        {
          error: `موعده لم يحن بعد — يعود إلى الطابور قبل موعده بـ${POSTPONE_LEAD_DAYS} يومين`,
          code: 'NOT_DUE',
        },
        { status: 409 }
      );
    }

    if (order.claimedById === null) {
      return NextResponse.json({ error: 'هذا الطلب في الطابور أصلاً', code: 'ALREADY_IN_QUEUE' }, { status: 409 });
    }

    const moved = await db.order.updateMany({
      where: { id: order.id, companyId, version: order.version },
      data: {
        // The hands change. The state does NOT: it is still postponed, still
        // due on the day the customer asked for, and `pullNext` looks for
        // exactly that and offers it first.
        claimedById: null,
        claimedAt: null,
        currentOwnerId: null,
        lockedById: null,
        lockedAt: null,
        version: { increment: 1 },
      },
    });
    if (moved.count !== 1) {
      return NextResponse.json(
        { error: 'تغيّر الطلب أثناء العمل عليه — حدّث الصفحة', code: 'VERSION_CONFLICT' },
        { status: 409 }
      );
    }

    await db.orderNote.create({
      data: {
        companyId,
        orderId: order.id,
        authorId: user.id,
        kind: 'follow_up',
        body: `أُعيد إلى الطابور قبل موعده (${due.toISOString().slice(0, 10)}) — ما زال مؤجَّلاً`,
      },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'POSTPONED_RETURNED_TO_QUEUE',
      entity: 'Order',
      entityId: order.id,
      previousData: { claimedById: order.claimedById },
      newData: { dueAt: due.toISOString(), by: user.name },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
