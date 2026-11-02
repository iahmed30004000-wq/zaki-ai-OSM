import bashaVillages from '../../../reference/couriers/basha-villages.json';
import { foldArabic } from '../address';
import type { CourierPlaces } from './place-note';

/**
 * THE PLACES A COURIER'S OWN LIST NAMES — FOR THE BOX WHERE ITS CODE IS TYPED, AND FOR THE CODE NOBODY HAS TO TYPE.
 *
 * «رمزها عند الشركة» is a number from THEIR list, and the list has two kinds of number that look alike: the Region Id
 * (3003 for السويداء) and the id of the CITY inside it (445153 for the placeholder city that carries the governorate's
 * own name). Basha works at region level — «دمشق - دمشق - دمشق» is intended — and their API field is `cityId`, so the
 * number to send is the same-name placeholder CITY. Typing the Region Id is the easy mistake, and the shipment is
 * addressed to a place nobody meant.
 *
 * TWO JOBS, ONE RULE.
 *
 *   1. `defaultCourierCityId` — the city id a governorate is shipped to when nobody typed one. The owner, 2/11: the
 *      governorate's city code is adopted for every city, village and neighbourhood of it; nobody types fourteen
 *      numbers that are already in the sheet. The press, the warning before the press and the Excel file all ask this
 *      (through `couriers/city-id`), and a number typed on the fees screen still wins over it.
 *   2. `courierPlaces` — what the box shows: the name of the place a typed number is, a warning when it is a Region Id,
 *      and the same default as a hint. Its hint comes from the SAME rule, so the screen and the press cannot disagree.
 *
 * THE RULE (`buildDefaultCities`), inside the courier's region whose name equals the governorate's after the Arabic
 * spellings are folded together (exact equality — never «contains», never fuzzy):
 *
 *   1. the city whose name is the governorate's own name, when exactly one such city id exists — the placeholder city
 *      («السويداء» 445153; the town of «مدينة السويداء» 566117 is a different place);
 *   2. else the city named «مدينة <governorate>», when exactly one exists; when several exist, the one that has a
 *      village named like the city itself (the placeholder pattern: «مدينة دير الزور» 949546 holds one village of that
 *      name, while 949547 holds fifteen neighbourhoods);
 *   3. else the governorate's only city, when it has exactly one;
 *   4. else nothing. A governorate the list cannot answer stays refused at the press — it is never guessed, because a
 *      parcel addressed to the wrong governorate is found out about when the driver calls.
 *
 * The spelling is folded with `foldArabic` (`address.ts`), the system's one answer to «are these the same place»:
 * their sheet writes «ادلب» and ours «إدلب».
 *
 * SERVER ONLY: the list is 461 rows, and the browser is sent only the 150 cities and the regions (see `couriers/place-note`).
 */

export interface CourierVillage {
  villageId: number;
  villageName: string;
  cityId: number;
  cityName: string;
  regionId: number;
  regionName: string;
}

/** The city a governorate goes to when nobody typed one: its id, and its name in the courier's list. */
export interface CourierDefaultCity {
  cityId: number;
  cityName: string;
}

const LISTS: Record<string, CourierVillage[]> = {
  BASHA: bashaVillages as CourierVillage[],
};

interface ListedCity {
  name: string;
  villageNames: string[];
}

function only(hits: [number, ListedCity][]): CourierDefaultCity | null {
  return hits.length === 1 ? { cityId: hits[0][0], cityName: hits[0][1].name } : null;
}

/** The rule above, for ONE governorate of a list: its cities by id, and its name in folded spelling. */
function pickCity(region: string, cities: Map<number, ListedCity>): CourierDefaultCity | null {
  const named = (folded: string) => [...cities].filter(([, c]) => foldArabic(c.name) === folded);

  // 1. The placeholder city, named like the governorate.
  const same = only(named(region));
  if (same) return same;

  // 2. «مدينة <governorate>» — and, when there are several, the one built like a placeholder.
  const towns = named(foldArabic(`مدينة ${region}`));
  const town = only(towns);
  if (town) return town;
  if (towns.length > 1) {
    const placeholders = towns.filter(([, c]) => c.villageNames.some((v) => foldArabic(v) === foldArabic(c.name)));
    const placeholder = only(placeholders);
    if (placeholder) return placeholder;
  }

  // 3. A governorate with a single city has one answer.
  if (cities.size === 1) return only([...cities]);

  // 4. Nothing it can say without guessing.
  return null;
}

/**
 * The default city of every governorate a list names, keyed by the governorate's name in folded spelling.
 *
 * Built from the list itself and exported so the rule can be tried on a list that is not Basha's. A name that the list
 * files under two different Region Ids has no answer (null): which of the two is meant cannot be told from the name.
 */
export function buildDefaultCities(list: readonly CourierVillage[]): Map<string, CourierDefaultCity | null> {
  const regions = new Map<string, { regionIds: Set<number>; cities: Map<number, ListedCity> }>();
  for (const v of list) {
    const key = foldArabic(v.regionName);
    if (!key) continue;
    const region = regions.get(key) ?? { regionIds: new Set<number>(), cities: new Map<number, ListedCity>() };
    region.regionIds.add(v.regionId);
    const city = region.cities.get(v.cityId) ?? { name: v.cityName, villageNames: [] };
    city.villageNames.push(v.villageName);
    region.cities.set(v.cityId, city);
    regions.set(key, region);
  }

  const defaults = new Map<string, CourierDefaultCity | null>();
  for (const [key, region] of regions) defaults.set(key, region.regionIds.size === 1 ? pickCity(key, region.cities) : null);
  return defaults;
}

const BUILT = new Map<string, Map<string, CourierDefaultCity | null>>();

/** The defaults of the list we hold for a courier by its code (any case), built once; null when we hold none for it. */
function defaultsOf(code: string | null | undefined): Map<string, CourierDefaultCity | null> | null {
  const key = (code ?? '').trim().toUpperCase();
  const list = LISTS[key];
  if (!list) return null;
  let built = BUILT.get(key);
  if (!built) {
    built = buildDefaultCities(list);
    BUILT.set(key, built);
  }
  return built;
}

/**
 * THE CITY ID A GOVERNORATE IS SHIPPED TO WHEN NOBODY TYPED ONE — from the courier's own list, or null.
 *
 * Null for a courier we hold no list for, for a governorate its list does not name, and for one the rule cannot answer
 * without guessing. A number typed on the fees screen is NOT looked at here: that precedence lives in `couriers/city-id`.
 */
export function defaultCourierCityId(
  courierCode: string | null | undefined,
  regionName: string | null | undefined,
): CourierDefaultCity | null {
  const defaults = defaultsOf(courierCode);
  if (!defaults || !regionName) return null;
  return defaults.get(foldArabic(regionName)) ?? null;
}

/** The list for a courier by its code, or null when we hold none for it. */
export function courierPlaces(code: string | null | undefined): CourierPlaces | null {
  const defaults = defaultsOf(code);
  if (!defaults) return null;
  const list = LISTS[(code ?? '').trim().toUpperCase()];

  const cities: CourierPlaces['cities'] = {};
  const regionNames = new Map<number, string>();
  for (const v of list) {
    cities[String(v.cityId)] = `${v.cityName} — ${v.regionName}`;
    regionNames.set(v.regionId, v.regionName);
  }

  // The same answer the press gets: one rule, so the hint beside the box can never promise what the press will not do.
  const regions: CourierPlaces['regions'] = {};
  for (const [id, name] of regionNames) {
    regions[String(id)] = { name, cityId: defaults.get(foldArabic(name))?.cityId ?? null };
  }
  return { cities, regions };
}
