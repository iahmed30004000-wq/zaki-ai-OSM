import { db } from '../db';
import { isAutoApplicable, type CourierEvent } from './types';
import { COURIER_SAID, courierSaidWord } from './courier-said';
import { isValidShippingTransition, SHIPPING_STATUS_AR, STATUS_TIMESTAMP } from '../shipping-workflow';

/**
 * ONE PLACE WHERE A COURIER'S WORD CHANGES AN ORDER.
 *
 * The polling job, which asks the courier's API every two minutes, is what
 * speaks for a courier. (A webhook used to speak for it too, and the two had
 * to agree; the owner cancelled the webhook on 2/11 — the `WEBHOOK` source
 * stays in the type because older activity rows and the timeline carry it.)
 * A second copy of these checks would still drift — and the thing that
 * drifts here is the rule that stops a courier feed from declaring money
 * collected.
 *
 * So whatever speaks for a courier calls this, and none of it writes
 * `shippingStatus` itself.
 *
 * The order of the guards matters:
 *   1. Can a machine assert this at all? DELIVERED, RETURNED,
 *      PARTIALLY_DELIVERED and CANCELLED move money or reverse it, and only
 *      the person at the door knows which. They wait for a human — and
 *      FAILED_DELIVERY waits with them (see NOTE_ONLY below). Their word is
 *      kept as a line on the order's timeline, never as a status.
 *   2. Is it news? The same status arriving twice is not a change, and a
 *      feed retried three times must not write three activity rows.
 *   3. Is the move legal? The transition machine decides, never the feed.
 *
 * AND A FEED NEVER BLOCKS, BUT IT TELLS. A blocking change request stops OUR
 * forward transitions; it does not stop a courier's. So when the parcel moves
 * while a request is under review, the request is flagged — otherwise the
 * person deciding it approves a change to an order that is no longer the
 * order she was shown. That is contract invariant 7, and the column it writes
 * (`changedDuringReview`) existed with nothing writing it.
 */

export type ApplyOutcome =
  | 'APPLIED'
  | 'NOT_AUTO_APPLICABLE'
  | 'NO_CHANGE'
  | 'INVALID_TRANSITION'
  | 'UNKNOWN_STATUS';

export interface ApplyTarget {
  id: string;
  companyId: string;
  shippingStatus: string;
  /*
   * The in-transit timestamps, when the caller read them. null = read and empty, so the move stamps it;
   * undefined = not read, so it is left alone. A parcel the poll moved to SHIPPED had no shippedAt — and the
   * «days in transit», the late threshold and the statement sweep all read that column.
   */
  shippedAt?: Date | null;
  outForDeliveryAt?: Date | null;
  failedAt?: Date | null;
}

const FEED_STAMPS = new Set(['shippedAt', 'outForDeliveryAt', 'failedAt']);

/**
 * A FEED NEVER WRITES «FAILED» EITHER.
 *
 * LogesTechs says «مؤجلة» (POSTPONED_DELIVERY) for a delivery put off — often because the customer asked for it. The
 * map turns that into FAILED_DELIVERY, and a failed delivery is not a harmless label here: it is a pending return on
 * the returns desk, it counts against the customer's risk (two in sixty days read HIGH and ask for prepayment), and
 * it is a dead end for the polling itself (FAILED can only go back out through SHIPPED). The courier's word is kept
 * as a note; the person at the door, who knows whether the attempt failed, writes the status.
 */
const NOTE_ONLY = new Set<string>(['FAILED_DELIVERY']);

export async function applyCourierEvent(input: {
  order: ApplyTarget;
  event: CourierEvent;
  courierName: string;
  /** How we learned of it — kept on the activity row so the two are told apart. */
  source: 'POLL' | 'WEBHOOK';
  /**
   * COMPUTE, DO NOT WRITE. Every guard runs exactly as it does for real and the answer comes back — 'APPLIED' means
   * «this WOULD move the order» — but nothing is written: no status, no stamp, no activity row, no flag, no note.
   * The poll's trial switch (COURIER_POLL_DRY_RUN) is the only caller that sets it.
   */
  dryRun?: boolean;
}): Promise<ApplyOutcome> {
  const { order, event, courierName, source } = input;

  if (event.status === null) return 'UNKNOWN_STATUS';
  if (!isAutoApplicable(event) || NOTE_ONLY.has(event.status)) {
    if (!input.dryRun) await keepWhatTheCourierSaid(input);
    return 'NOT_AUTO_APPLICABLE';
  }
  if (event.status === order.shippingStatus) return 'NO_CHANGE';
  if (!isValidShippingTransition(order.shippingStatus, event.status)) return 'INVALID_TRANSITION';
  if (input.dryRun) return 'APPLIED';

  const field = STATUS_TIMESTAMP[event.status as keyof typeof STATUS_TIMESTAMP];
  const stamp =
    field && FEED_STAMPS.has(field) && (order as unknown as Record<string, unknown>)[field] === null ? { [field]: new Date() } : {};

  const moved = await db.$transaction(async (tx) => {
    /*
     * COMPARE-AND-SET ON THE STATUS THE DECISION WAS MADE FROM.
     *
     * The poll reads an order, then spends seconds to minutes asking the courier before it gets here. Updating by id
     * alone let a late answer overwrite what the door or a statement wrote in between — a parcel delivered at the door
     * walked back to «خرج للتوصيل» with its delivery time and its stock already taken. Now the write happens only if
     * the order is still in the status we read; otherwise nothing is written, no activity row and no flag, and the
     * next sweep asks again from the truth.
     */
    const changed = await tx.order.updateMany({
      where: { id: order.id, shippingStatus: order.shippingStatus },
      data: { shippingStatus: event.status!, version: { increment: 1 }, ...stamp },
    });
    if (changed.count === 0) return false;
    await tx.orderActivity.create({
      data: {
        companyId: order.companyId,
        orderId: order.id,
        userId: null, // the courier's feed, not a person
        action: 'COURIER_STATUS_SYNCED',
        newStatus: event.status!,
        metadata: JSON.stringify({
          courier: courierName,
          rawStatus: event.rawStatus,
          note: event.note,
          source,
        }),
      },
    });

    /*
     * EVERY pending request, not only the blocking ones.
     *
     * A non-blocking request is precisely the one that did NOT stop the
     * pipeline, so it is the one most likely to be overtaken by the parcel —
     * splitting the rule would flag the safer half and miss the other.
     *
     * `changedDuringReview: false` in the WHERE is not for idempotence
     * (updateMany is already idempotent) — it keeps `updatedAt` from being
     * bumped by every later event, because the change-request queue sorts and
     * ages by it and a courier feed must not reorder a human's worklist.
     */
    await tx.orderChangeRequest.updateMany({
      where: { orderId: order.id, status: 'PENDING', changedDuringReview: false },
      data: { changedDuringReview: true },
    });
    return true;
  });

  return moved ? 'APPLIED' : 'NO_CHANGE';
}

/**
 * KEEP THE COURIER'S WORD AS A LINE ON THE ORDER — AND NOTHING ELSE (RV144).
 *
 * One `orderActivity` row, no status, no amount, no timestamp. The same word twice in a row (a poll asks every two
 * minutes) is one line, not a column of them. A note that cannot be written never stops the sweep: the parcels behind
 * it still need their turn, and the word comes again in two minutes.
 */
async function keepWhatTheCourierSaid(input: {
  order: ApplyTarget;
  event: CourierEvent;
  courierName: string;
  source: 'POLL' | 'WEBHOOK';
}): Promise<void> {
  const { order, event, courierName, source } = input;
  if (event.status === null || event.status === order.shippingStatus) return;
  try {
    const last = await db.orderActivity.findFirst({
      where: { orderId: order.id, action: COURIER_SAID },
      orderBy: { createdAt: 'desc' },
      select: { newStatus: true, metadata: true },
    });
    if (last && last.newStatus === event.status && rawStatusOf(last.metadata) === event.rawStatus) return;
    await db.orderActivity.create({
      data: {
        companyId: order.companyId,
        orderId: order.id,
        userId: null, // the courier's feed, not a person
        action: COURIER_SAID,
        previousStatus: order.shippingStatus,
        newStatus: event.status,
        metadata: JSON.stringify({
          courier: courierName,
          rawStatus: event.rawStatus,
          courierSaid: courierSaidWord(event.note, SHIPPING_STATUS_AR[event.status]),
          via: source,
        }),
      },
    });
  } catch {
    /* see above: best effort */
  }
}

function rawStatusOf(metadata: string | null): string | null {
  try {
    const parsed = metadata ? JSON.parse(metadata) : null;
    return parsed && typeof parsed.rawStatus === 'string' ? parsed.rawStatus : null;
  } catch {
    return null;
  }
}
