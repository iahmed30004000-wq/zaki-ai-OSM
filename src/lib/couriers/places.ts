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
 * THREE JOBS, ONE LIST.
 *
 *   1. `defaultCourierCityId` — the city id a governorate is shipped to when nobody typed one. The owner, 2/11: the
 *      governorate's city code is adopted for every city, village and neighbourhood of it; nobody types fourteen
 *      numbers that are already in the sheet. The press, the warning before the press and the Excel file all ask this
 *      (through `couriers/city-id`), and a number typed on the fees screen wins over it — with ONE exception, job 3.
 *   2. `courierPlaces` — what the box shows: the name of the place a typed number is, a warning when it is a Region Id,
 *      and the same default as a hint. Its hint comes from the SAME rule, so the screen and the press cannot disagree.
 *   3. `isRegionIdOnly` — whether a typed number is PROVABLY a Region Id: the list holds it as a region's number and
 *      does not hold it as any city's. Such a number is not a place a parcel can be addressed to, so `couriers/city-id`
 *      does not send it: the list's own city for the governorate is used instead (or the parcel is refused, when the
 *      list has none). A number the list does not know at all is not touched — only what the list itself proves is
 *      a Region Id is overridden. A number the list holds as both a region and a city is a city, the reading the box
 *      (`placeNote`) already gives it.
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
 * SERVER ONLY: the list is 461 rows, and the browser is sent only the 152 cities and the regions (see `couriers/place-note`).
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

const LISTS = {
  BASHA: bashaVillages as CourierVillage[],
} satisfies Record<string, CourierVillage[]>;

/** The name of a list we hold — today only Basha's. */
export type CourierListKey = keyof typeof LISTS;

/**
 * WHO A COURIER IS, AS FAR AS WHICH LIST WE HOLD FOR IT: its own code (`DeliveryProvider.code`) and the platform it ships
 * through (`DeliveryProvider.adapterCode`). Both, because the code alone is not enough — see `courierListKey`.
 */
export interface CourierIdentity {
  code?: string | null;
  adapterCode?: string | null;
}

/**
 * WHICH LIST BELONGS TO THIS COURIER — THE ONE PLACE THAT DECIDES IT; every other function here asks this.
 *
 * Basha's list belongs to the courier whose code is BASHA, OR whose platform is LogesTechs: the platform is read the way
 * `couriers/index` (`adapterFor`) reads it — the adapter code, else the courier's own code, in any case. The code alone
 * was not enough: on production the Basha row was named by the legacy import, its code is «LEG-1» and its adapter
 * LOGESTECHS, so a list looked up by code alone gave Basha nothing (measured 2/11). Basha is the only LogesTechs courier
 * this system knows, and the list is theirs (`reference/couriers/basha-villages.json`). A courier on another platform
 * with any other code — a manual one, «الو دليفيري» — gets no list, as before. A second LogesTechs company would read
 * Basha's Syrian list too, and would need its own (BACKLOG_P2).
 */
export function courierListKey(provider: CourierIdentity | null | undefined): CourierListKey | null {
  if (!provider) return null;
  if ((provider.code ?? '').trim().toUpperCase() === 'BASHA') return 'BASHA';
  const platform = (provider.adapterCode || provider.code || '').trim().toUpperCase();
  return platform === 'LOGESTECHS' ? 'BASHA' : null;
}

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

/**
 * The ids a list uses ONLY as a Region Id: a region's number that is not also the number of one of the list's cities.
 *
 * The same reading `placeNote` gives the box — «both a known city and a known region is read as the city» — so a number
 * the list holds as both is a city and is not in this set. Built from the list itself and exported so it can be tried on
 * a list that is not Basha's (Basha's own never reuses a number: 3003 is a region, 445153 is a city, and nothing is both).
 */
export function regionOnlyIds(list: readonly CourierVillage[]): Set<number> {
  const cities = new Set(list.map((v) => v.cityId));
  return new Set(list.map((v) => v.regionId).filter((id) => !cities.has(id)));
}

interface BuiltList {
  list: readonly CourierVillage[];
  /** The default city of each governorate, by its folded name. */
  defaults: Map<string, CourierDefaultCity | null>;
  /** The numbers the list uses only as a Region Id. */
  regionOnly: ReadonlySet<number>;
}

const BUILT = new Map<CourierListKey, BuiltList>();

/** What is derived from the list we hold for a courier (`courierListKey`), built once; null when we hold none for it. */
function builtOf(provider: CourierIdentity | null | undefined): BuiltList | null {
  const key = courierListKey(provider);
  if (!key) return null;
  const list = LISTS[key];
  let built = BUILT.get(key);
  if (!built) {
    built = { list, defaults: buildDefaultCities(list), regionOnly: regionOnlyIds(list) };
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
  provider: CourierIdentity | null | undefined,
  regionName: string | null | undefined,
): CourierDefaultCity | null {
  const built = builtOf(provider);
  if (!built || !regionName) return null;
  return built.defaults.get(foldArabic(regionName)) ?? null;
}

/**
 * IS THIS NUMBER, FOR THIS COURIER, PROVABLY A REGION ID — A NUMBER THE LIST HOLDS AS A REGION'S AND AS NO CITY'S?
 *
 * 3003 is السويداء's Region Id in Basha's list; a parcel addressed to it goes to no city at all. When somebody typed
 * it into «رمزها عند الشركة» (the box warns, and saving is not blocked), `couriers/city-id` asks this and does not send
 * it. False for a number the list does not know — an id it simply does not list may still be right — for a number it
 * holds as a city (also when it is a region's too), and for every number of a courier we hold no list for.
 */
export function isRegionIdOnly(provider: CourierIdentity | null | undefined, id: number): boolean {
  return builtOf(provider)?.regionOnly.has(id) ?? false;
}

/** The list for a courier (`courierListKey`), or null when we hold none for it. */
export function courierPlaces(provider: CourierIdentity | null | undefined): CourierPlaces | null {
  const built = builtOf(provider);
  if (!built) return null;
  const { defaults, list } = built;

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
