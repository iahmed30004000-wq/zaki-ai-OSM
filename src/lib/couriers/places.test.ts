import { describe, expect, it } from 'vitest';
import { courierPlaces } from './places';
import { placeNote } from './place-note';

/**
 * «رمزها عند الشركة»: Basha works at REGION level («دمشق - دمشق - دمشق» is intended). Their API field is `cityId`, so the
 * number to type is the id of the same-name placeholder CITY, not the Region Id. The box names the place a typed number
 * is, and warns (never blocks) when it is a Region Id.
 */

// Region → the code to type, verified against their sheet (28/10).
const TABLE: Record<string, number> = {
  دمشق: 445053, السويداء: 445153, حلب: 705991, اللاذقية: 705992, طرطوس: 705993, الحسكة: 445152,
  الرقة: 445151, 'ريف دمشق': 445143, حمص: 570272, درعا: 570150, حماة: 445146, ادلب: 570148,
};

const places = courierPlaces('BASHA')!;

describe('courierPlaces', () => {
  it('knows Basha (any case) and nobody else', () => {
    expect(courierPlaces('basha')).not.toBeNull();
    expect(courierPlaces(' BASHA ')).not.toBeNull();
    expect(courierPlaces('NAQEL')).toBeNull();
    expect(courierPlaces(null)).toBeNull();
  });

  it('السويداء is 445153 as a city and 3003 as a region — and 566117 is the city of the town, not the governorate', () => {
    expect(places.cities['445153']).toBe('السويداء — السويداء');
    expect(places.cities['566117']).toBe('مدينة السويداء — السويداء');
    expect(places.regions['3003']).toEqual({ name: 'السويداء', cityId: 445153 });
  });

  it('every governorate in the owner’s table: its Region Id points at the code to type', () => {
    for (const [name, code] of Object.entries(TABLE)) {
      const region = Object.values(places.regions).find((r) => r.name === name);
      expect(region?.cityId, name).toBe(code);
      expect(places.cities[String(code)], name).toBe(`${name} — ${name}`);
    }
  });

  it('a governorate with no single same-name city has no code to suggest', () => {
    expect(places.regions['3004']).toEqual({ name: 'القنيطرة', cityId: null });
  });

  it('a Region Id is never also listed as a city (so the two readings cannot collide)', () => {
    for (const regionId of Object.keys(places.regions)) expect(places.cities[regionId]).toBeUndefined();
  });
});

describe('placeNote: what the box says about the typed number', () => {
  it('a known city id names its place', () => {
    expect(placeNote('445153', places)).toEqual({ kind: 'place', text: 'السويداء — السويداء' });
    expect(placeNote(' 445053 ', places)).toEqual({ kind: 'place', text: 'دمشق — دمشق' });
  });

  it('a known Region Id warns and says which code to type instead', () => {
    const note = placeNote('3003', places)!;
    expect(note.kind).toBe('region');
    expect(note.text).toContain('«السويداء»');
    expect(note.text).toContain('445153');
  });

  it('a Region Id with no same-name city warns without inventing a code', () => {
    const note = placeNote('3004', places)!;
    expect(note.kind).toBe('region');
    expect(note.text).toContain('«القنيطرة»');
    expect(note.text).toContain('من قائمتهم');
    expect(note.text).not.toMatch(/اكتب \d/);
  });

  it('NEGATIVE: an unknown number, an empty box, text and no list at all say nothing', () => {
    expect(placeNote('99999999', places)).toBeNull();
    expect(placeNote('', places)).toBeNull();
    expect(placeNote('12ab', places)).toBeNull();
    expect(placeNote('-5', places)).toBeNull();
    expect(placeNote('445153', null)).toBeNull();
  });
});
