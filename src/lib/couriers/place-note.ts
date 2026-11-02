import { foldArabic } from '../address';

/**
 * WHAT THE «رمزها عند الشركة» BOX SAYS ABOUT THE NUMBER TYPED IN IT — client-safe, no data file.
 * The cities and regions come from `/api/settings/delivery-fees/places` (see `couriers/places`, server only).
 */

export interface CourierPlaces {
  /** cityId → «مدينة السويداء — السويداء» */
  cities: Record<string, string>;
  /**
   * regionId → its name, and the id of the city the press sends that governorate to when nobody typed one — the answer of
   * `defaultCourierCityId` (the same-name placeholder city, or «مدينة …»), null when the list cannot give one.
   */
  regions: Record<string, { name: string; cityId: number | null }>;
}

/**
 * THE CODE A GOVERNORATE HAS WITHOUT ANYONE TYPING IT, and the place it is — so the box can show it instead of a warning.
 *
 * The governorate is one of OURS («إدلب») and the payload's regions are THEIRS («ادلب»): they are matched by the folded
 * name, exactly as the server matched them when it decided each region's `cityId`. It adds no rule of its own — a region
 * the server could not answer (null) or filed twice stays unanswered here too.
 */
export function defaultCityOf(
  regionName: string,
  places: CourierPlaces | null,
): { cityId: number; label: string } | null {
  const want = foldArabic(regionName);
  if (!places || !want) return null;
  const hits = Object.values(places.regions).filter((r) => foldArabic(r.name) === want);
  const cityId = hits.length === 1 ? hits[0].cityId : null;
  if (cityId === null) return null;
  return { cityId, label: places.cities[String(cityId)] ?? String(cityId) };
}

/**
 * What the box says about the number typed in it: the place it names, a warning that it is a Region Id, or nothing.
 * A number that is both a known city and a known region is read as the city — the one the courier's API takes.
 *
 * A Region Id is not sent (`couriers/city-id`, `isRegionIdOnly` — the same reading as here): when the list gives that
 * governorate a city, the note says the system ignores the typed number and uses the city's; when it gives none, the
 * person is told which number is missing, and the parcel stays refused until one is typed.
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
        ? `هذا رقم المنطقة لـ«${region.name}» وليس رقم مدينتها — النظام بيتجاهله ويستعمل ${region.cityId}`
        : `هذا رقم المنطقة لـ«${region.name}» وليس رقم مدينتها — اكتب رقم مدينتها من قائمتهم`,
    };
  }
  return null;
}
