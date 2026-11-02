import { describe, expect, it } from 'vitest';
import { cityIdsForRegions, courierCityIdFor, storedCityIds } from './city-id';

/**
 * THE ONE ANSWER TO «WHICH CITY ID DOES THIS COURIER GET FOR THIS GOVERNORATE» — what was typed, else the courier's list,
 * else nothing. The press, the warning before it and the Excel file all ask it (their own tests run the three together);
 * this is the function on its own, with no database.
 */

const NONE = new Map<string, number>();

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

  it('nothing typed: the courier’s own list answers, by the governorate’s name', () => {
    expect(ask()).toBe(445153);
    expect(ask({ regionName: 'إدلب' })).toBe(570148);
    expect(ask({ regionName: 'دير الزور' })).toBe(949546);
  });

  it('a typed id wins — even when it is a Region Id, which the box warns about and does not block', () => {
    expect(ask({ stored: new Map([['r-sweida', 999001]]) })).toBe(999001);
    expect(ask({ stored: new Map([['r-sweida', 3003]]) })).toBe(3003);
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
    expect(ask({ providerCode: 'HALA', stored: new Map([['r-sweida', 777001]]) })).toBe(777001);
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

  it('NEGATIVE: a courier with no list gets only the typed ones', () => {
    const ids = cityIdsForRegions({ providerCode: 'HALA', stored: new Map([['r-baghdad', 777001]]), regions });
    expect(ids).toEqual(new Map([['r-baghdad', 777001]]));
  });
});
