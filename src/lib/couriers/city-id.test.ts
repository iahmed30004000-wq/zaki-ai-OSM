import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cityIdsForRegions, courierCityIdFor, storedCityIds } from './city-id';
import { courierPlaces, defaultCourierCityId } from './places';
import { repoFile, stripComments } from '../guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — a typed Region Id is never sent as a city id
 *
 * The coordinator, 2/11: «a typed number that is provably a Region Id must not be sent as a cityId». If somebody typed
 * 3003 for السويداء, the shipment would go out addressed to a number that is not a city.
 *
 *  1. The typed number wins UNLESS the courier's list holds it as a Region Id and does not hold it as a city: then it
 *     counts as not typed, and the list's city for the governorate answers (null — refused — when the list has none).
 *  2. A number the list does not know at all, a city of the list (also not the governorate's own), and every number of
 *     a courier we hold no list for still win as typed: only what the list itself proves is a Region Id is overridden.
 *  3. A number held as both a region and a city is a city (see the file with a list that does that).
 *  4. Dispatch, the warning and the Excel file reach the typed ids only through this function.
 *
 * Blockers: no money arithmetic, no order creation, no migration; the PUT still accepts the number (RV597).
 * ═══════════════════════════════════════════════════════════════════════
 *
 * THE ONE ANSWER TO «WHICH CITY ID DOES THIS COURIER GET FOR THIS GOVERNORATE» — what was typed (unless it is provably a
 * Region Id), else the courier's list, else nothing. The press, the warning before it and the Excel file all ask it
 * (their own tests run the three together); this is the function on its own, with no database.
 */

const NONE = new Map<string, number>();
const places = courierPlaces('BASHA')!;

describe('storedCityIds', () => {
  it('keeps the ids typed per governorate', () => {
    expect(storedCityIds([{ regionId: 'a', courierCityId: 11 }, { regionId: 'b', courierCityId: 22 }])).toEqual(
      new Map([['a', 11], ['b', 22]]),
    );
  });

  it('NEGATIVE: a row with no id is not an id — null is not a typed code', () => {
    expect(storedCityIds([{ regionId: 'a', courierCityId: null }, { regionId: 'b', courierCityId: 22 }])).toEqual(new Map([['b', 22]]));
    expect(storedCityIds([]).size).toBe(0);
  });
});

describe('courierCityIdFor', () => {
  const ask = (over: Partial<Parameters<typeof courierCityIdFor>[0]> = {}) =>
    courierCityIdFor({ providerCode: 'BASHA', stored: NONE, regionId: 'r-sweida', regionName: 'السويداء', ...over });
  const typed = (n: number) => new Map([['r-sweida', n]]);

  it('nothing typed: the courier’s own list answers, by the governorate’s name', () => {
    expect(ask()).toBe(445153);
    expect(ask({ regionName: 'إدلب' })).toBe(570148);
    expect(ask({ regionName: 'دير الزور' })).toBe(949546);
  });

  it('a typed city wins: the governorate’s own, another city of the list, and a number the list does not know at all', () => {
    expect(ask({ stored: typed(445153) })).toBe(445153);
    // «مدينة السويداء», a city of the list that is not the governorate's default: typed on purpose, it is sent.
    expect(ask({ stored: typed(566117) })).toBe(566117);
    expect(ask({ stored: typed(999001) })).toBe(999001);
    expect(ask({ stored: typed(999999999) })).toBe(999999999);
  });

  it('THE SAFETY RULE: a typed number the list proves is a Region Id is not sent — the list’s city answers (3003 → 445153)', () => {
    expect(ask({ stored: typed(3003) })).toBe(445153);
  });

  it('and it is any Region Id of the list, also another governorate’s — never sent as a city', () => {
    expect(ask({ stored: typed(3002) })).toBe(445153); // الحسكة's, typed for السويداء
    for (const [id, region] of Object.entries(places.regions)) {
      expect(ask({ regionName: region.name, stored: typed(Number(id)) }), `${region.name} (${id})`).toBe(
        defaultCourierCityId('BASHA', region.name)!.cityId,
      );
    }
  });

  it('and every city id of the list, typed, is a place: it is sent', () => {
    for (const id of Object.keys(places.cities)) expect(ask({ stored: typed(Number(id)) }), id).toBe(Number(id));
  });

  it('a Region Id with no city of the list to fall back on: not sent, and nothing else to send — null (refused)', () => {
    expect(ask({ regionName: 'بغداد', stored: typed(3003) })).toBeNull();
    // …while an unknown number for the same governorate is still sent.
    expect(ask({ regionName: 'بغداد', stored: typed(999001) })).toBe(999001);
  });

  it('NEGATIVE: for a courier we hold no list for, a number is only a number — 3003 is sent as typed', () => {
    expect(ask({ providerCode: 'HALA', stored: typed(3003) })).toBe(3003);
    expect(ask({ providerCode: null, stored: typed(3003) })).toBe(3003);
  });

  it('the courier is found by its code in any case, for the Region Id check too', () => {
    expect(ask({ providerCode: ' basha ', stored: typed(3003) })).toBe(445153);
  });

  it('a typed id belongs to its governorate: another governorate’s id is not this one’s', () => {
    expect(ask({ stored: new Map([['r-other', 999001]]) })).toBe(445153);
  });

  it('needs no fee row and no region id for the list to answer — the name is enough', () => {
    expect(ask({ regionId: null })).toBe(445153);
    expect(ask({ regionId: undefined })).toBe(445153);
  });

  it('NEGATIVE: a governorate the list does not name, with nothing typed, has no id', () => {
    expect(ask({ regionName: 'بغداد' })).toBeNull();
  });

  it('NEGATIVE: no name and no typed id — an order with no governorate — has no id', () => {
    expect(ask({ regionId: null, regionName: null })).toBeNull();
    expect(ask({ regionId: undefined, regionName: undefined })).toBeNull();
  });

  it('NEGATIVE: a courier we hold no list for has only what was typed', () => {
    expect(ask({ providerCode: 'HALA' })).toBeNull();
    expect(ask({ providerCode: null })).toBeNull();
    expect(ask({ providerCode: 'HALA', stored: typed(777001) })).toBe(777001);
  });
});

describe('cityIdsForRegions: the same answer for every governorate of a batch, by region id', () => {
  const regions = [
    { id: 'r-dam', name: 'دمشق' },
    { id: 'r-dam', name: 'دمشق' }, // two parcels to the same governorate
    { id: 'r-sweida', name: 'السويداء' },
    { id: 'r-baghdad', name: 'بغداد' },
    { id: null, name: null }, // an order with no governorate
    { id: undefined, name: 'دمشق' },
  ];

  it('lists each governorate once, with its typed id or its list’s — and leaves out what nothing answers', () => {
    const ids = cityIdsForRegions({ providerCode: 'BASHA', stored: new Map([['r-sweida', 999001]]), regions });
    expect(ids).toEqual(new Map([['r-dam', 445053], ['r-sweida', 999001]]));
  });

  it('a typed Region Id is not in the file: the list’s city is, and a Region Id with no city to fall back on leaves the cell empty', () => {
    const ids = cityIdsForRegions({ providerCode: 'BASHA', stored: new Map([['r-sweida', 3003], ['r-baghdad', 3003]]), regions });
    expect(ids).toEqual(new Map([['r-dam', 445053], ['r-sweida', 445153]]));
  });

  it('NEGATIVE: a courier with no list gets only the typed ones — a Region Id of Basha’s included', () => {
    const ids = cityIdsForRegions({ providerCode: 'HALA', stored: new Map([['r-baghdad', 777001], ['r-sweida', 3003]]), regions });
    expect(ids).toEqual(new Map([['r-baghdad', 777001], ['r-sweida', 3003]]));
  });
});

describe('no site reads a typed id around the helper', () => {
  /** Every production file that names the column. A new one is a new site that must ask `courierCityIdFor` too. */
  const KNOWN = [
    'scripts/import-courier-cities.ts', // the manual script that WRITES the ids, from the list
    'src/app/api/settings/delivery-fees/route.ts', // the fees screen's own door: lists and saves what was typed
    'src/app/api/shipping-batches/[id]/export/route.ts', // the Excel file
    'src/components/settings/CourierFees.tsx', // the box
    'src/lib/couriers/city-gaps.ts', // the warning before the press
    'src/lib/couriers/city-id.ts', // the helper
    'src/lib/couriers/dispatch.ts', // the press
  ];

  it('the production files that name DeliveryFee.courierCityId are exactly the known ones', () => {
    const root = process.cwd();
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && /\bcourierCityId\b/.test(stripComments(readFileSync(p, 'utf8')))) {
          found.push(relative(root, p).split('\\').join('/'));
        }
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'scripts'));
    expect(found.sort()).toEqual([...KNOWN].sort());
  });

  it('the press, the warning and the file each call the shared function — and none reads a typed id for itself', () => {
    for (const file of ['src/lib/couriers/dispatch.ts', 'src/lib/couriers/city-gaps.ts', 'src/app/api/shipping-batches/[id]/export/route.ts']) {
      const src = stripComments(repoFile(file));
      expect(src, `${file} لا يسأل الدالة المشتركة`).toMatch(/courierCityIdFor\(|cityIdsForRegions\(/);
      // The ids they read go to `storedCityIds` and from there into the helper — nothing picks one out of the map itself.
      expect(src, `${file} يقرأ رقماً مكتوباً بنفسه`).not.toMatch(/typedCityIds\.(?:get|values|entries)\(|typed\.get\([^)]*\)\??\.get\(/);
    }
  });
});
