import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDefaultCities, courierPlaces, defaultCourierCityId, type CourierVillage } from './places';
import { placeNote, defaultCityOf, type CourierPlaces } from './place-note';
import { foldArabic } from '../address';
import { repoFile, stripComments } from '../guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the governorate's city code adopted by itself
 *
 * The owner, 2/11: «اعتمدو كود المدينة اللي هو المحافظة للمدن والقرى والأحياء… اظبط أرقام المدن الكود».
 *
 *  1. `defaultCourierCityId(courier, governorate)` answers the city id Basha is sent for each of our fourteen
 *     governorates — the ones in the owner's sheet, asserted one by one below, and each checked against the sheet itself.
 *  2. The rule is exact equality after the Arabic spellings are folded (إدلب = ادلب, ة = ه) — never «contains», never a
 *     guess: a name the sheet does not have, a typo, a courier we hold no list for, all answer null.
 *  3. The hint beside the «رمزها عند الشركة» box (`courierPlaces`) is the SAME answer, so it cannot promise what the
 *     press will not do.
 *  4. The resolver is server-only: the 461-row list never reaches the browser.
 *
 * Blockers: no money arithmetic, no order creation, no migration, no customer data.
 * ═══════════════════════════════════════════════════════════════════════
 */

interface Row { oms: string; sheetRegion: string; code: number; cityInSheet: string }

// THE ORACLE, from the owner's sheet (28/10, completed 2/11): our governorate → the city to send, and what the sheet calls them.
const ORACLE: Row[] = [
  { oms: 'دمشق', sheetRegion: 'دمشق', code: 445053, cityInSheet: 'دمشق' },
  { oms: 'ريف دمشق', sheetRegion: 'ريف دمشق', code: 445143, cityInSheet: 'ريف دمشق' },
  { oms: 'حلب', sheetRegion: 'حلب', code: 705991, cityInSheet: 'حلب' },
  { oms: 'حمص', sheetRegion: 'حمص', code: 570272, cityInSheet: 'حمص' },
  { oms: 'حماة', sheetRegion: 'حماة', code: 445146, cityInSheet: 'حماة' },
  { oms: 'اللاذقية', sheetRegion: 'اللاذقية', code: 705992, cityInSheet: 'اللاذقية' },
  { oms: 'طرطوس', sheetRegion: 'طرطوس', code: 705993, cityInSheet: 'طرطوس' },
  // Ours is written with the hamza, theirs without it.
  { oms: 'إدلب', sheetRegion: 'ادلب', code: 570148, cityInSheet: 'ادلب' },
  // No city is named like the governorate: «مدينة دير الزور» is two cities, and the placeholder is the one with a single village.
  { oms: 'دير الزور', sheetRegion: 'دير الزور', code: 949546, cityInSheet: 'مدينة دير الزور' },
  { oms: 'الحسكة', sheetRegion: 'الحسكة', code: 445152, cityInSheet: 'الحسكة' },
  { oms: 'الرقة', sheetRegion: 'الرقة', code: 445151, cityInSheet: 'الرقة' },
  { oms: 'درعا', sheetRegion: 'درعا', code: 570150, cityInSheet: 'درعا' },
  { oms: 'السويداء', sheetRegion: 'السويداء', code: 445153, cityInSheet: 'السويداء' },
  { oms: 'القنيطرة', sheetRegion: 'القنيطرة', code: 566122, cityInSheet: 'مدينة القنيطرة' },
];

const sheet: CourierVillage[] = JSON.parse(readFileSync(join(process.cwd(), 'reference/couriers/basha-villages.json'), 'utf8'));
const places = courierPlaces('BASHA')!;

describe('defaultCourierCityId: the fourteen governorates, one by one, from the real list', () => {
  it('has the whole table (a table that lost a row would pass quietly)', () => {
    expect(ORACLE).toHaveLength(14);
    expect(new Set(ORACLE.map((r) => r.code)).size).toBe(14);
  });

  it.each(ORACLE)('$oms → $code', ({ oms, code, cityInSheet }) => {
    expect(defaultCourierCityId('BASHA', oms)).toEqual({ cityId: code, cityName: cityInSheet });
  });

  it.each(ORACLE)('$oms: the number is a city of exactly that governorate in their sheet (the table is not a typo)', (row) => {
    const hits = sheet.filter((v) => v.cityId === row.code);
    expect(hits.length, `${row.oms}: لا قرية في الشيت بهذا الرمز`).toBeGreaterThan(0);
    expect(new Set(hits.map((v) => v.cityName)), row.oms).toEqual(new Set([row.cityInSheet]));
    expect(new Set(hits.map((v) => v.regionName)), row.oms).toEqual(new Set([row.sheetRegion]));
  });

  it('THE TRAP: السويداء is 445153, not 566117 — both are cities of the same region in the sheet', () => {
    const sweida = sheet.filter((v) => v.regionName === 'السويداء');
    expect(new Set(sweida.map((v) => v.cityId)).has(566117)).toBe(true);
    expect(sweida.find((v) => v.cityId === 566117)?.cityName).toBe('مدينة السويداء');
    expect(new Set(sweida.map((v) => v.cityId)).has(445153)).toBe(true);
    expect(defaultCourierCityId('BASHA', 'السويداء')?.cityId).toBe(445153);
    expect(defaultCourierCityId('BASHA', 'السويداء')?.cityId).not.toBe(566117);
    // And never the Region Id.
    expect(defaultCourierCityId('BASHA', 'السويداء')?.cityId).not.toBe(3003);
  });

  it('دير الزور: two cities are called «مدينة دير الزور» — the one built as a placeholder wins, not the one of the neighbourhoods', () => {
    const named = sheet.filter((v) => v.regionName === 'دير الزور' && v.cityName === 'مدينة دير الزور');
    expect(new Set(named.map((v) => v.cityId))).toEqual(new Set([949546, 949547]));
    expect(named.filter((v) => v.cityId === 949546)).toHaveLength(1);
    expect(named.filter((v) => v.cityId === 949547).length).toBeGreaterThan(1);
    expect(defaultCourierCityId('BASHA', 'دير الزور')?.cityId).toBe(949546);
  });

  it('every governorate of their list answers — none is left without a code to send', () => {
    for (const [id, region] of Object.entries(places.regions)) expect(region.cityId, `${region.name} (${id})`).not.toBeNull();
  });

  it('a Region Id is never the answer', () => {
    const regionIds = new Set(sheet.map((v) => v.regionId));
    for (const row of ORACLE) expect(regionIds.has(defaultCourierCityId('BASHA', row.oms)!.cityId), row.oms).toBe(false);
  });
});

describe('the spelling is folded, the match is exact', () => {
  it('إدلب, ادلب and أدلب are one governorate; so are ة and ه at the end', () => {
    for (const written of ['إدلب', 'ادلب', 'أدلب']) expect(defaultCourierCityId('BASHA', written)?.cityId, written).toBe(570148);
    expect(defaultCourierCityId('BASHA', 'اللاذقيه')?.cityId).toBe(705992);
    expect(defaultCourierCityId('BASHA', 'حماه')?.cityId).toBe(445146);
    expect(defaultCourierCityId('BASHA', 'القنيطره')?.cityId).toBe(566122);
  });

  it('diacritics, the stretched letter and stray spaces change nothing', () => {
    expect(defaultCourierCityId('BASHA', 'دِمَشق')?.cityId).toBe(445053);
    expect(defaultCourierCityId('BASHA', 'دمـشق')?.cityId).toBe(445053);
    expect(defaultCourierCityId('BASHA', '  ريف   دمشق ')?.cityId).toBe(445143);
  });

  it('«دمشق» and «ريف دمشق» are two governorates: neither is found by containing the other', () => {
    expect(defaultCourierCityId('BASHA', 'دمشق')?.cityId).toBe(445053);
    expect(defaultCourierCityId('BASHA', 'ريف دمشق')?.cityId).toBe(445143);
    expect(defaultCourierCityId('BASHA', 'حلب')?.cityId).toBe(705991);
    expect(defaultCourierCityId('BASHA', 'ريف حلب')?.cityId).toBe(683199);
  });

  it('NEGATIVE: a name the sheet does not have, a typo, a word inside a name, or nothing at all answers null', () => {
    for (const name of ['بغداد', 'دمشقق', 'شق', 'دمشق الجديدة', 'محافظة دمشق', '', '   ']) {
      expect(defaultCourierCityId('BASHA', name), JSON.stringify(name)).toBeNull();
    }
    expect(defaultCourierCityId('BASHA', null)).toBeNull();
    expect(defaultCourierCityId('BASHA', undefined)).toBeNull();
  });

  it('NEGATIVE: a courier we hold no list for answers null — whatever the governorate', () => {
    expect(defaultCourierCityId('NAQEL', 'دمشق')).toBeNull();
    expect(defaultCourierCityId('', 'دمشق')).toBeNull();
    expect(defaultCourierCityId(null, 'دمشق')).toBeNull();
    expect(defaultCourierCityId(undefined, 'دمشق')).toBeNull();
  });

  it('the courier is found by its code in any case', () => {
    expect(defaultCourierCityId('basha', 'دمشق')?.cityId).toBe(445053);
    expect(defaultCourierCityId(' BASHA ', 'دمشق')?.cityId).toBe(445053);
  });
});

/**
 * THE RULE ITSELF, on lists that are not Basha's — so each step is tried alone, and so are the ways it must say nothing.
 */
describe('the rule, step by step', () => {
  let n = 0;
  const v = (regionId: number, regionName: string, cityId: number, cityName: string, villageName = cityName): CourierVillage => ({
    villageId: ++n, villageName, cityId, cityName, regionId, regionName,
  });
  const answer = (list: CourierVillage[], region: string) => buildDefaultCities(list).get(foldArabic(region)) ?? null;

  it('1 · the city named like the governorate wins over «مدينة …»', () => {
    const list = [v(1, 'سين', 10, 'مدينة سين', 'حي أ'), v(1, 'سين', 11, 'سين')];
    expect(answer(list, 'سين')).toEqual({ cityId: 11, cityName: 'سين' });
  });

  it('1 · two cities named like the governorate are not one answer — with nothing else to go on, null', () => {
    const list = [v(1, 'سين', 10, 'سين'), v(1, 'سين', 11, 'سين')];
    expect(answer(list, 'سين')).toBeNull();
  });

  it('2 · a single «مدينة …» is the answer', () => {
    const list = [v(1, 'سين', 10, 'مدينة سين', 'حي أ'), v(1, 'سين', 11, 'منطقة سين', 'حي ب')];
    expect(answer(list, 'سين')).toEqual({ cityId: 10, cityName: 'مدينة سين' });
  });

  it('2 · several «مدينة …»: the one with a village named like itself is the placeholder', () => {
    const list = [
      v(1, 'سين', 10, 'مدينة سين', 'حي أ'), v(1, 'سين', 10, 'مدينة سين', 'حي ب'),
      v(1, 'سين', 11, 'مدينة سين', 'مدينة سين'),
    ];
    expect(answer(list, 'سين')).toEqual({ cityId: 11, cityName: 'مدينة سين' });
  });

  it('2 · several «مدينة …» and no placeholder among them: null, not the first', () => {
    const list = [v(1, 'سين', 10, 'مدينة سين', 'حي أ'), v(1, 'سين', 11, 'مدينة سين', 'حي ب')];
    expect(answer(list, 'سين')).toBeNull();
  });

  it('2 · several «مدينة …» and two placeholders: null, not the first', () => {
    const list = [v(1, 'سين', 10, 'مدينة سين', 'مدينة سين'), v(1, 'سين', 11, 'مدينة سين', 'مدينة سين')];
    expect(answer(list, 'سين')).toBeNull();
  });

  it('3 · a governorate with one city, however it is called, has that city', () => {
    const list = [v(1, 'سين', 10, 'وسط البلد', 'حي أ'), v(1, 'سين', 10, 'وسط البلد', 'حي ب')];
    expect(answer(list, 'سين')).toEqual({ cityId: 10, cityName: 'وسط البلد' });
  });

  it('4 · several cities and none of them it: null', () => {
    const list = [v(1, 'سين', 10, 'وسط البلد'), v(1, 'سين', 11, 'الضاحية')];
    expect(answer(list, 'سين')).toBeNull();
  });

  it('EXACT, never «contains»: a list that only has «ريف سين» says nothing about «سين»', () => {
    const list = [v(1, 'ريف سين', 10, 'ريف سين'), v(2, 'سين الجديدة', 11, 'سين الجديدة')];
    expect(answer(list, 'سين')).toBeNull();
    expect(answer(list, 'ريف سين')).toEqual({ cityId: 10, cityName: 'ريف سين' });
  });

  it('a name filed under two different Region Ids has no answer: which one is meant cannot be told', () => {
    const list = [v(1, 'سين', 10, 'سين'), v(2, 'سين', 11, 'سين')];
    expect(answer(list, 'سين')).toBeNull();
  });

  it('spelling is folded on both sides: their «ادلب» is our «إدلب», and a village of the placeholder is folded too', () => {
    const list = [v(1, 'ادلب', 10, 'مدينة ادلب', 'مدينة إدلب'), v(1, 'ادلب', 11, 'مدينة ادلب', 'حي')];
    expect(answer(list, 'إدلب')).toEqual({ cityId: 10, cityName: 'مدينة ادلب' });
  });

  it('an empty list names nothing', () => {
    expect(buildDefaultCities([]).size).toBe(0);
  });
});

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

  it('every governorate in the owner’s table: its Region Id points at the code to send', () => {
    for (const { sheetRegion, code, cityInSheet } of ORACLE) {
      const region = Object.values(places.regions).find((r) => r.name === sheetRegion);
      expect(region?.cityId, sheetRegion).toBe(code);
      expect(places.cities[String(code)], sheetRegion).toBe(`${cityInSheet} — ${sheetRegion}`);
    }
  });

  it('a governorate with no same-name city takes «مدينة …» — القنيطرة and دير الزور, which used to be left blank', () => {
    expect(places.regions['3004']).toEqual({ name: 'القنيطرة', cityId: 566122 });
    expect(places.regions['3736']).toEqual({ name: 'دير الزور', cityId: 949546 });
  });

  it('THE SAME ANSWER AS THE PRESS: for every governorate of the list, the hint is what defaultCourierCityId says', () => {
    for (const [id, region] of Object.entries(places.regions)) {
      expect(region.cityId, `${region.name} (${id})`).toBe(defaultCourierCityId('BASHA', region.name)?.cityId ?? null);
    }
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

  it('القنيطرة’s Region Id now names its code too (it had none to offer)', () => {
    const note = placeNote('3004', places)!;
    expect(note.kind).toBe('region');
    expect(note.text).toContain('«القنيطرة»');
    expect(note.text).toContain('566122');
  });

  it('a Region Id whose governorate the list cannot answer warns without inventing a code', () => {
    // Basha's real list answers every governorate now, so the branch is tried on a list that does not.
    const unanswered: CourierPlaces = { cities: {}, regions: { '7': { name: 'القنيطرة', cityId: null } } };
    const note = placeNote('7', unanswered)!;
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

describe('defaultCityOf: what the browser is told about a governorate nobody typed a code for', () => {
  it('finds the default from the payload alone, by the folded name — إدلب against their «ادلب»', () => {
    expect(defaultCityOf('إدلب', places)).toEqual({ cityId: 570148, label: 'ادلب — ادلب' });
    expect(defaultCityOf('السويداء', places)).toEqual({ cityId: 445153, label: 'السويداء — السويداء' });
    expect(defaultCityOf('دير الزور', places)).toEqual({ cityId: 949546, label: 'مدينة دير الزور — دير الزور' });
  });

  it('is the press’s answer for every one of the fourteen', () => {
    for (const { oms, code } of ORACLE) expect(defaultCityOf(oms, places)?.cityId, oms).toBe(code);
  });

  it('NEGATIVE: no list, an unknown governorate or an empty name say nothing', () => {
    expect(defaultCityOf('دمشق', null)).toBeNull();
    expect(defaultCityOf('بغداد', places)).toBeNull();
    expect(defaultCityOf('', places)).toBeNull();
  });

  it('NEGATIVE: a governorate the list cannot answer, or files twice, says nothing', () => {
    const unanswered: CourierPlaces = { cities: {}, regions: { '7': { name: 'سين', cityId: null } } };
    expect(defaultCityOf('سين', unanswered)).toBeNull();
    const twice: CourierPlaces = {
      cities: { '10': 'سين — سين', '11': 'سين — سين' },
      regions: { '1': { name: 'سين', cityId: 10 }, '2': { name: 'سين', cityId: 11 } },
    };
    expect(defaultCityOf('سين', twice)).toBeNull();
  });
});

describe('the list stays on the server', () => {
  it('the files the browser loads do not import the resolver or the 461 rows', () => {
    for (const file of ['src/lib/couriers/place-note.ts', 'src/components/settings/CourierFees.tsx']) {
      const src = stripComments(repoFile(file));
      expect(src, `${file} يستورد القائمة الكاملة`).not.toMatch(/couriers\/places['"]|['"]\.\/places['"]|basha-villages|reference\/couriers/);
    }
  });

  it('and the resolver itself is the one place that reads the JSON', () => {
    expect(stripComments(repoFile('src/lib/couriers/places.ts'))).toContain('reference/couriers/basha-villages.json');
  });
});
