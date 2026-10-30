/**
 * THE WARNING A TROLLEY SHOWS FOR PARCELS THE COURIER HAS NO CITY ID FOR (RV166).
 *
 * Pure, so the screen can read it without pulling the database layer in; the query that fills it is `couriers/city-gaps`.
 */
export interface CourierCityGap {
  /** Parcels the press would skip for this reason. */
  count: number;
  /** The governorates, names only. */
  regions: string[];
}

/** The line the batches screen shows above the press — it warns, it does not block. */
export function courierCityGapLine(gap: CourierCityGap): string {
  return (
    `تنبيه: ${gap.count} طلب (${gap.regions.join('، ')}) بلا رمز عند الشركة — بينتخطّوا وقت الترحيل وما بينرسلوا. ` +
    'أدخِل الرمز من شركات الشحن ← الأجور ← «رمزها عند الشركة»، أو انقل الطلب لشركة ثانية. باقي الطلبات بتنرسل عادي.'
  );
}
