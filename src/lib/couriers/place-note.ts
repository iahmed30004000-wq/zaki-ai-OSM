/**
 * WHAT THE «رمزها عند الشركة» BOX SAYS ABOUT THE NUMBER TYPED IN IT — client-safe, no data file.
 * The cities and regions come from `/api/settings/delivery-fees/places` (see `couriers/places`, server only).
 */

export interface CourierPlaces {
  /** cityId → «مدينة السويداء — السويداء» */
  cities: Record<string, string>;
  /** regionId → its name, and the id of its same-name placeholder city (the one to type), when there is exactly one. */
  regions: Record<string, { name: string; cityId: number | null }>;
}

/**
 * What the box says about the number typed in it: the place it names, a warning that it is a Region Id, or nothing.
 * A number that is both a known city and a known region is read as the city — the one the courier's API takes.
 */
export function placeNote(
  typed: string,
  places: CourierPlaces | null,
): { kind: 'place'; text: string } | { kind: 'region'; text: string } | null {
  const n = typed.trim();
  if (!places || !/^\d+$/.test(n)) return null;
  const city = places.cities[n];
  if (city) return { kind: 'place', text: city };
  const region = places.regions[n];
  if (region) {
    return {
      kind: 'region',
      text: region.cityId
        ? `هذا رقم المنطقة لـ«${region.name}» وليس رقم مدينتها — اكتب ${region.cityId}`
        : `هذا رقم المنطقة لـ«${region.name}» وليس رقم مدينتها — اكتب رقم مدينتها من قائمتهم`,
    };
  }
  return null;
}
