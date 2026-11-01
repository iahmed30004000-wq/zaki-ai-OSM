import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ContextError, requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { POSTPONE_LEAD_DAYS, awaitingConfirmationCount, waitingCount } from '@/lib/confirmation-queue';
import { postponedScope } from '@/lib/postponed-list';
import { whenWhere } from '@/lib/postponed-filters';
import { kindsFor, type WorkItem, type WorkKey } from '@/lib/my-work';
import { transitOf } from '@/lib/transit';

/**
 * GET /api/me/work — what is waiting for THIS person. Counts, never lists.
 *
 * This is `/api/confirmation/counter` widened. That route was the right
 * idea applied to one role — «how many orders are waiting to be pulled» —
 * and everybody else got a header identical whatever their job. The rule it
 * was written with is unchanged and carried here: the SERVER decides which
 * numbers a person gets, by permission, and a count never becomes a list.
 *
 * Polled in the background, so a missing store is «no work», not an error.
 * Answering 400 to a poll once sent the whole tab to the store picker,
 * mid-form, without a click.
 */

/** A hard ceiling on the work: past this the number is «كثير» either way. */
const CAP = 999;

export async function GET() {
  try {
    let context;
    try {
      context = await requireContext();
    } catch (e) {
      if (e instanceof ContextError) return NextResponse.json({ items: [] });
      throw e;
    }
    const { user, companyId, storeId } = context;
    const scope = { companyId, storeId };
    const kinds = kindsFor((p) => can(user, p));
    if (kinds.length === 0) return NextResponse.json({ items: [] });

    const wanted = new Set<WorkKey>(kinds.map((k) => k.key));
    const counts: Partial<Record<WorkKey, number>> = {};

    /**
     * Only what this person may see is counted. A query run for a number
     * nobody is shown is a query run for nothing, on every poll, for every
     * user in the company.
     */
    /**
     * ALL OF THEM AT ONCE (RV181). These were eleven counts one behind the other, each waiting for the one before it to
     * come back; none needs another's answer. The questions are the same and so are the numbers — only the waiting
     * changed: the poll now takes as long as its slowest count, not the sum of them.
     */
    const tasks: Promise<void>[] = [];
    const count = (key: WorkKey, pending: Promise<number>) => {
      tasks.push(pending.then((n) => { counts[key] = n; }));
    };

    // What SHE may take: an order held for a colleague is not waiting for her (order-reservation.ts), and a chip that counts it is a
    // number that promises a pull the button answers «لا توجد طلبات». A supervisor, who pulls nothing, reads the whole pool.
    if (wanted.has('CONFIRM_POOL')) count('CONFIRM_POOL', waitingCount(db, scope, new Date(), can(user, 'confirmation.pull') ? user.id : undefined));
    if (wanted.has('MY_UNCONFIRMED')) count('MY_UNCONFIRMED', awaitingConfirmationCount(db, scope, user.id));

    if (wanted.has('READY_TO_SHIP')) {
      count('READY_TO_SHIP', db.order.count({
        where: {
          ...scope,
          confirmationStatus: 'CONFIRMED',
          shippingStatus: 'NOT_READY',
          shippingBatchId: null,
          // A held parcel is not waiting for anybody until its day comes —
          // the same filter the shipment list itself uses.
          OR: [{ shipHoldUntil: null }, { shipHoldUntil: { lte: new Date() } }],
        },
      }));
    }

    if (wanted.has('RETURNS_WAITING')) {
      count('RETURNS_WAITING', db.order.count({
        where: {
          ...scope,
          shippingStatus: { in: ['RETURN_REQUESTED', 'RETURNED', 'FAILED_DELIVERY', 'PARTIALLY_DELIVERED'] },
          returnReceipt: null,
        },
      }));
    }

    if (wanted.has('CHANGE_REQUESTS')) {
      count('CHANGE_REQUESTS', db.orderChangeRequest.count({
        where: { companyId, status: 'PENDING', order: { storeId } },
      }));
    }

    /** The warehouse's list: the very orders `/api/ops/preparation` groups by product. */
    if (wanted.has('TO_PREPARE')) {
      count('TO_PREPARE', db.order.count({
        where: {
          ...scope,
          confirmationStatus: 'CONFIRMED',
          shippingStatus: { in: ['NOT_READY', 'PACKING'] },
          items: { some: {} },
        },
      }));
    }

    // What `/api/confirmation/issues` lists by default (status OPEN), in this store.
    if (wanted.has('ISSUES_OPEN')) {
      count('ISSUES_OPEN', db.orderIssue.count({ where: { companyId, status: 'OPEN', order: { storeId } } }));
    }

    /**
     * «القابل للعمل عليه» of the postponed list, to the digit: the same scope and the same
     * moment (`whenWhere('now')`). A supervisor counts everybody's; an agent only her own —
     * the list's own rule, so the card and the list cannot disagree.
     */
    if (wanted.has('POSTPONED_DUE')) {
      const supervisor = can(user, 'confirmation.supervise');
      count('POSTPONED_DUE', db.order.count({
        where: {
          ...postponedScope({ companyId, storeId, ownOnly: supervisor ? undefined : user.id }),
          AND: [whenWhere('now', new Date(), POSTPONE_LEAD_DAYS)],
        },
      }));
    }

    // Statements not yet approved: approval is what moves the courier's cash, so it is the open decision.
    if (wanted.has('STATEMENTS_OPEN')) {
      count('STATEMENTS_OPEN', db.courierStatement.count({ where: { companyId, storeId, approvedAt: null, status: { not: 'APPROVED' } } }));
    }

    /**
     * LATE IS PER REGION, AND THE THRESHOLD IS THE COURIER'S OWN.
     *
     * A parcel to a neighbouring town and one across the country are not
     * late at the same age, and `delivery_fees` already carries the days
     * for each (courier, region). Counting them against one number would
     * flag the far ones every week and teach people to ignore the chip.
     */
    if (wanted.has('LATE_SHIPMENTS')) {
      count('LATE_SHIPMENTS', (async () => {
        const fees = await db.deliveryFee.findMany({
          where: { companyId, isActive: true },
          select: { regionId: true, deliveryProviderId: true, lateThresholdDays: true },
        });
        const daysFor = new Map(fees.map((f) => [`${f.deliveryProviderId}:${f.regionId}`, f.lateThresholdDays]));

        const flying = await db.order.findMany({
          where: {
            ...scope,
            shippingStatus: { in: ['SHIPPED', 'OUT_FOR_DELIVERY'] },
            shippedAt: { not: null },
            // A parcel that arrived or came back has no clock: it cannot be late.
            deliveredAt: null,
            returnedAt: null,
          },
          select: { shippedAt: true, regionId: true, deliveryProviderId: true, shippingStatus: true, deliveredAt: true, returnedAt: true },
          take: 2000,
        });

        // No threshold on file is not «late»: it is «we never said». Guessing one would put a red number on a screen
        // nobody can act on. The count is the tracking screen's own rule — `transitOf` — not a second copy of it.
        const now = new Date();
        return flying.filter(
          (o) => transitOf(o, daysFor.get(`${o.deliveryProviderId}:${o.regionId}`) ?? 0, now).late
        ).length;
      })());
    }

    await Promise.all(tasks);

    const items: WorkItem[] = kinds.map((k) => ({
      key: k.key,
      ar: k.ar,
      count: Math.min(CAP, counts[k.key] ?? 0),
      href: k.href,
      icon: k.icon,
      tone: k.tone,
    }));

    return NextResponse.json({ items });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
