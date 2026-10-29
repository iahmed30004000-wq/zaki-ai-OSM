import bashaVillages from '../../reference/couriers/basha-villages.json';
import type { CourierPlaces } from './courier-place-note';

/**
 * THE PLACES A COURIER'S OWN LIST NAMES, FOR THE BOX WHERE ITS CODE IS TYPED.
 *
 * «رمزها عند الشركة» is a number from THEIR list, and the list has two kinds of number that look alike: the Region Id
 * (3003 for السويداء) and the id of the CITY inside it (445153 for the placeholder city that carries the governorate's
 * own name). Basha works at region level — «دمشق - دمشق - دمشق» is intended — and their API field is `cityId`, so the
 * number to type is the same-name placeholder CITY. Typing the Region Id is the easy mistake, and the shipment is
 * addressed to a place nobody meant.
 *
 * So the box shows the name of the place a typed number is, and warns — never blocks — when it is a Region Id.
 *
 * SERVER ONLY: the list is 461 rows, and the browser is sent only the 150 cities and the regions (see `courier-place-note`).
 */

interface Village {
  villageId: number;
  cityId: number;
  cityName: string;
  regionId: number;
  regionName: string;
}

const LISTS: Record<string, Village[]> = {
  BASHA: bashaVillages as Village[],
};

/** The list for a courier by its code, or null when we hold none for it. */
export function courierPlaces(code: string | null | undefined): CourierPlaces | null {
  const list = LISTS[(code ?? '').trim().toUpperCase()];
  if (!list) return null;

  const cities: CourierPlaces['cities'] = {};
  const regionNames = new Map<number, string>();
  for (const v of list) {
    cities[String(v.cityId)] = `${v.cityName} — ${v.regionName}`;
    regionNames.set(v.regionId, v.regionName);
  }

  const regions: CourierPlaces['regions'] = {};
  for (const [id, name] of regionNames) {
    const same = new Set(list.filter((v) => v.regionId === id && v.cityName === name).map((v) => v.cityId));
    regions[String(id)] = { name, cityId: same.size === 1 ? [...same][0] : null };
  }
  return { cities, regions };
}
