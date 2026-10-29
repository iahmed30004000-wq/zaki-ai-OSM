import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THEIR COMPLETE VILLAGE LIST — reference/couriers/basha-villages.json.
 *
 * The owner's new sheet: the 409 villages we had, the 50 of السويداء that were missing (the reason ORD-2026-0508 could not
 * be sent), one in عمان and one in دير الزور — 461 in all. The file is the list the «رمزها عند الشركة» boxes are typed
 * from, so a missing row is a governorate nobody can ship to.
 */

interface Village { villageId: number; villageName: string; cityId: number; cityName: string; regionId: number; regionName: string }
const villages: Village[] = JSON.parse(readFileSync(join(process.cwd(), 'reference/couriers/basha-villages.json'), 'utf8'));

describe('basha-villages.json', () => {
  it('holds 461 villages, 50 of them in السويداء', () => {
    expect(villages).toHaveLength(461);
    expect(villages.filter((v) => v.regionName === 'السويداء')).toHaveLength(50);
    expect(villages.filter((v) => v.regionName === 'عمان')).toHaveLength(2);
    expect(villages.filter((v) => v.regionName === 'دير الزور')).toHaveLength(29);
  });

  it('keeps the shape it always had: the same six keys, in the same order', () => {
    for (const v of villages) {
      expect(Object.keys(v)).toEqual(['villageId', 'villageName', 'cityId', 'cityName', 'regionId', 'regionName']);
    }
  });

  it('every id is an integer (their sheet writes «731511.0»), and every village is unique', () => {
    for (const v of villages) {
      for (const k of ['villageId', 'cityId', 'regionId'] as const) {
        expect(Number.isInteger(v[k]), `${v.villageName}: ${k}`).toBe(true);
      }
    }
    expect(new Set(villages.map((v) => v.villageId)).size).toBe(villages.length);
  });

  it('names are trimmed and none is empty', () => {
    for (const v of villages) {
      for (const k of ['villageName', 'cityName', 'regionName'] as const) {
        expect(v[k], `${v.villageId}: ${k}`).toBe(v[k].trim());
        expect(v[k].length).toBeGreaterThan(0);
      }
    }
  });

  it('السويداء is a region of their list with its own same-name city to type (445153) — and a Region Id (3003) that is NOT it', () => {
    const sw = villages.filter((v) => v.regionName === 'السويداء');
    expect(new Set(sw.map((v) => v.regionId))).toEqual(new Set([3003]));
    expect(sw.some((v) => v.cityId === 445153 && v.cityName === 'السويداء')).toBe(true);
    expect(villages.some((v) => v.cityId === 3003)).toBe(false);
  });

  it('the owner’s table: each governorate’s same-name city is the code to type', () => {
    const table: Record<string, number> = {
      دمشق: 445053, السويداء: 445153, حلب: 705991, اللاذقية: 705992, طرطوس: 705993, الحسكة: 445152,
      الرقة: 445151, 'ريف دمشق': 445143, حمص: 570272, درعا: 570150, حماة: 445146, ادلب: 570148,
    };
    for (const [region, code] of Object.entries(table)) {
      const same = new Set(villages.filter((v) => v.regionName === region && v.cityName === region).map((v) => v.cityId));
      expect([...same], region).toEqual([code]);
    }
  });
});
