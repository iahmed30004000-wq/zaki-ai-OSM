/**
 * HOW LONG A SHIPMENT HAS BEEN OUT, AND HOW TO SAY SO.
 *
 * Pure, and deliberately in a file of its own: the tracking screen runs in
 * the browser and needs the same words the server uses. Living beside the
 * delivery-fee code meant importing the database client to count days,
 * which would have shipped Prisma to every operator's browser.
 */

/**
 * "N days" in Arabic, agreeing with the number.
 *
 * Arabic does not pluralise by adding a letter: one day, two days, three to
 * ten days and eleven-plus days are four different words. "متأخرة 15 أيام"
 * is what a template produces and what no Arabic speaker writes, and on a
 * screen agents read all day it reads as a system that does not speak
 * their language.
 */
export function arabicDays(n: number): string {
  if (n === 1) return 'يوماً واحداً';
  if (n === 2) return 'يومين';
  if (n >= 3 && n <= 10) return `${n} أيام`;
  return `${n} يوماً`;
}

/**
 * The late label, said once for the whole system.
 *
 * FROM THE SHIPPING DATE, always. An order that sat unconfirmed for a week
 * and shipped yesterday is one day late for the courier, not eight — and
 * measuring from creation blamed the courier for the confirmation queue.
 */
export function lateLabel(daysSinceShipping: number): string {
  return `متأخرة ${arabicDays(daysSinceShipping)} من تاريخ الشحن`;
}

/**
 * WHICH STATES ARE A PARCEL STILL ON ITS WAY.
 *
 * The follow-up screen's own list of «في الطريق»: out with the courier, waiting for him, or coming back. A parcel that
 * arrived (DELIVERED, PARTIALLY_DELIVERED), came back (RETURNED) or never left (NOT_READY, PACKING…) is not on the
 * road, so no clock runs for it and nothing is «late» about it.
 */
export const IN_FLIGHT_STATUSES: readonly string[] = [
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'READY_FOR_PICKUP',
  'FAILED_DELIVERY',
  'RETURN_REQUESTED',
];

/** What says whether the journey is over. */
export interface JourneyFacts {
  shippingStatus: string;
  deliveredAt?: Date | string | null;
  returnedAt?: Date | string | null;
}

const asTime = (v: Date | string | null | undefined): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * ON ITS WAY — by the state AND by the dates.
 *
 * A delivery or a return date ends the journey whatever the state says, and a state outside the road's states means
 * it is not on it whatever the dates say. Both, because the sheet import left states with no dates.
 */
export function isInFlight(o: JourneyFacts): boolean {
  return IN_FLIGHT_STATUSES.includes(o.shippingStatus) && asTime(o.deliveredAt) === null && asTime(o.returnedAt) === null;
}

/**
 * Days a shipment has been in transit, and whether that passes the region's threshold.
 *
 * THE CLOCK STOPS WHEN THE JOURNEY ENDS. `endedAt` is the delivery or the return date: days are counted up to it, and
 * never below zero (a date before the shipping date is a typo, not a negative journey). A parcel whose journey ended is
 * never late — it arrived; how long it took is a fact, not a fault to chase.
 */
export function transitStatus(
  shippedAt: Date | string | null,
  lateThresholdDays: number,
  now = new Date(),
  endedAt: Date | string | null = null
) {
  if (!shippedAt) return { days: null as number | null, late: false };
  const ended = asTime(endedAt);
  const until = ended === null ? now.getTime() : Math.min(now.getTime(), ended);
  const days = Math.max(0, Math.floor((until - new Date(shippedAt).getTime()) / (24 * 60 * 60 * 1000)));
  return { days, late: ended === null && lateThresholdDays > 0 && days > lateThresholdDays };
}

/**
 * THE ONE ANSWER TO «HOW LONG, AND IS IT LATE» FOR ANY ORDER — the list, the page and the day's card all ask this.
 *
 *   on its way                         → days since it shipped, late when past the lane's threshold
 *   ended with a delivery/return date  → days up to that date, never late
 *   ended with no date (the import)    → no days at all: counting to today would invent a journey, never late
 */
export function transitOf(
  o: JourneyFacts & { shippedAt: Date | string | null },
  lateThresholdDays: number,
  now = new Date()
): { days: number | null; late: boolean; inFlight: boolean } {
  const inFlight = isInFlight(o);
  // Both dates can exist (a partial delivery that sends some back): the journey ended at the first of them.
  const ends = [asTime(o.deliveredAt), asTime(o.returnedAt)].filter((t): t is number => t !== null);
  const endedAt = ends.length ? new Date(Math.min(...ends)) : null;
  if (!inFlight && endedAt === null) return { days: null, late: false, inFlight };
  const t = transitStatus(o.shippedAt, lateThresholdDays, now, endedAt);
  return { days: t.days, late: inFlight && t.late, inFlight };
}
