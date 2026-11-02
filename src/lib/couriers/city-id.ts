import { defaultCourierCityId } from './places';

/**
 * THE COURIER'S CITY ID FOR A PARCEL'S GOVERNORATE — ONE ANSWER FOR THE PRESS, THE WARNING BEFORE IT AND THE EXCEL FILE.
 *
 * Three places needed this number and each used to read the same table of typed codes (`DeliveryFee.courierCityId`):
 * the dispatch (what it sends the courier's API, and what it refuses a parcel for), the warning above the press
 * (`couriers/city-gaps`, which «repeats the dispatch's own conditions so the warning and the refusal cannot disagree»),
 * and the spreadsheet for the courier's portal. The table was empty — nobody had typed fourteen numbers that are
 * already in the courier's own sheet — so every parcel was refused.
 *
 * Now the answer is, in this order:
 *
 *   1. the number TYPED for that courier and governorate on the fees screen. It always wins, even when it looks wrong:
 *      the box already warns about a Region Id, and the person who typed it may know something we do not;
 *   2. else the courier's own list, by the governorate's name (`defaultCourierCityId`) — a courier we hold no list for
 *      has none, so for such a courier nothing changes;
 *   3. else nothing, and the press refuses the parcel by name as before (`NO_COURIER_CITY`).
 *
 * It is a fact about (courier, governorate), not about the adapter: the spreadsheet is for the day the API is not
 * connected, and asks the same question. No fee ROW needs to exist for the list's answer to be used.
 */

/** The ids typed for ONE courier, by region id, out of its `DeliveryFee` rows. A row with no id is not an id. */
export function storedCityIds(rows: readonly { regionId: string; courierCityId: number | null }[]): Map<string, number> {
  const stored = new Map<string, number>();
  for (const row of rows) {
    if (row.courierCityId !== null && row.courierCityId !== undefined) stored.set(row.regionId, row.courierCityId);
  }
  return stored;
}

/** The courier's city id for one governorate: what was typed, else what its list says, else null. */
export function courierCityIdFor(input: {
  /** The courier's own code (`DeliveryProvider.code`) — which list we hold for it. */
  providerCode: string | null | undefined;
  /** What was typed for this courier, by region id (`storedCityIds`). */
  stored: ReadonlyMap<string, number>;
  regionId: string | null | undefined;
  regionName: string | null | undefined;
}): number | null {
  if (input.regionId) {
    const typed = input.stored.get(input.regionId);
    if (typed !== undefined) return typed;
  }
  return defaultCourierCityId(input.providerCode, input.regionName)?.cityId ?? null;
}

/** The same answer for every governorate among these parcels, by region id — the shape the spreadsheet reads. */
export function cityIdsForRegions(input: {
  providerCode: string | null | undefined;
  stored: ReadonlyMap<string, number>;
  regions: Iterable<{ id: string | null | undefined; name: string | null | undefined }>;
}): Map<string, number> {
  const ids = new Map<string, number>();
  for (const region of input.regions) {
    if (!region.id || ids.has(region.id)) continue;
    const id = courierCityIdFor({ providerCode: input.providerCode, stored: input.stored, regionId: region.id, regionName: region.name });
    if (id !== null) ids.set(region.id, id);
  }
  return ids;
}
