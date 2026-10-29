import type { DispatchOutcome } from './courier-dispatch';

/**
 * WHY ONE ORDER OF A DISPATCH DID NOT GO, IN WORDS.
 *
 * Two screens send a batch to the courier — the batches screen and the
 * banner after «إنشاء شحنة» — and each needs the same sentence for the same
 * reason. Written once here, so «لا رمز لها عند الشركة» cannot read one way
 * on one screen and another on the other.
 */
export function dispatchReasonAr(o: Pick<DispatchOutcome, 'skipped' | 'regionName' | 'error'>): string {
  switch (o.skipped) {
    case 'ALREADY_SENT':
      return 'له باركود أصلاً';
    case 'NOT_AUTOMATED':
      return 'شركة يدوية — لا API';
    case 'NO_PROVIDER':
      return 'بلا شركة شحن';
    case 'SEND_IN_FLIGHT':
      return 'قيد الإرسال الآن من مكانٍ آخر';
    case 'NO_COURIER_CITY':
      // Which governorate, and where its id goes — it was an English error code.
      return `${o.regionName ?? 'المحافظة'}: لا رمز لها عند الشركة بعد — لم يُرسَل. أدخِل رمزها من شركات الشحن ← الأجور ← «رمزها عند الشركة»، أو انقل الطلب لشركة أخرى`;
    default:
      return o.error ?? '';
  }
}

/**
 * THE FAILED ORDERS OF A DISPATCH, ONE LINE PER REASON.
 *
 * Thirty-five orders refused for the same reason used to be thirty-five lines that filled the page. They are grouped
 * by the sentence itself (and by whether the outcome is unknown — «maybe it was sent» is different news), the larger
 * group first; a tie keeps the order the reasons first appeared in. Written once, here, for both screens.
 */
export interface DispatchReasonGroup {
  reason: string;
  count: number;
  orderNumbers: string[];
  /** The courier may have created the parcel and never said so — shown as the warning it is. */
  outcomeUnknown: boolean;
}

export function groupDispatchReasons(
  outcomes: Pick<DispatchOutcome, 'ok' | 'orderNumber' | 'skipped' | 'regionName' | 'error' | 'outcomeUnknown'>[],
): DispatchReasonGroup[] {
  const groups = new Map<string, DispatchReasonGroup>();
  for (const o of outcomes) {
    if (o.ok) continue;
    const reason = dispatchReasonAr(o);
    const unknown = o.outcomeUnknown === true;
    const key = `${unknown ? 'U' : 'K'}|${reason}`;
    const hit = groups.get(key);
    if (hit) {
      hit.count += 1;
      hit.orderNumbers.push(o.orderNumber);
    } else {
      groups.set(key, { reason, count: 1, orderNumbers: [o.orderNumber], outcomeUnknown: unknown });
    }
  }
  // Array.prototype.sort is stable: equal counts keep their first-seen order.
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
