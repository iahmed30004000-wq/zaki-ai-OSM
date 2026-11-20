import { zonedParts, zonedTimeToInstant } from './business-calendar';

/**
 * A STOCK TRANSFER ON THE ROAD — the words and the clock (the warehouse plan, request W3c). Pure: no database, so the
 * work poll (`/api/me/work`) and the notice (`stock-transfer-alerts.ts`) read one rule.
 *
 * «More than a day» is the store's day: the same wall-clock time one local day earlier in the store's country timezone,
 * so a night the clocks move does not move the line.
 */

/** «صنف واحد / صنفين / ٣ أصناف / ١١ صنفاً» — the number of products, never of units. */
export function productsAr(n: number): string {
  if (n === 1) return 'صنف واحد';
  if (n === 2) return 'صنفين';
  if (n >= 3 && n <= 10) return `${n} أصناف`;
  return `${n} صنفاً`;
}

/** A warehouse named «مخزن الشمال» is not «مخزن مخزن الشمال». */
function placeAr(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return 'مخزن تاني';
  return n.startsWith('مخزن') ? n : `مخزن ${n}`;
}

/** The words of the notice. Takes a COUNT of lines — there is no quantity to leak because none is passed in. */
export function transferSentWords(fromName: string | null | undefined, lineCount: number): { title: string; message: string } {
  return {
    title: 'نقل بضاعة جايك',
    message: `وصلك نقل من ${placeAr(fromName)} فيه ${productsAr(lineCount)}. لما توصل البضاعة عدّها واضغط «استلمت».`,
  };
}

/** The same wall-clock moment one local day earlier, in the store's timezone — «more than a day» by the store's days. */
export function oneStoreDayBefore(now: Date, timeZone: string): Date {
  const p = zonedParts(now, timeZone);
  // Day 0 of a month is the last day of the one before (Date.UTC under zonedTimeToInstant rolls it over).
  return zonedTimeToInstant(timeZone, p.year, p.month, p.day - 1, p.hour, p.minute);
}

/**
 * The transfers of ONE store that need somebody: on the road since before `oneStoreDayBefore`, or received short with
 * the difference not yet approved. A cancelled or fully received transfer is never counted.
 */
export function stuckTransfersWhere(scope: { companyId: string; storeId: string }, now: Date, timeZone: string) {
  return {
    companyId: scope.companyId,
    storeId: scope.storeId,
    OR: [
      { status: 'SENT', sentAt: { lt: oneStoreDayBefore(now, timeZone) } },
      { status: 'RECEIVED_WITH_DIFFERENCE', differenceApprovedAt: null },
    ],
  };
}
