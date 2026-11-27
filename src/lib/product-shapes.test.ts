import { describe, expect, it, vi } from 'vitest';
import { PRODUCT_SHAPES, SHAPE_INFO, isProductShape, readProductShapes, readShapeMap, unitWord, type ProductShape } from './product-shapes';

/** «شكل القطعة»: nine shapes, each with its drawing and its Arabic unit word for one, two and a few. */

const WORDS: Record<ProductShape, [string, string, string]> = {
  bottle: ['عبوة', 'عبوتين', 'عبوات'],
  jar: ['مرطبان', 'مرطبانين', 'مرطبانات'],
  dropper: ['قطّارة', 'قطّارتين', 'قطّارات'],
  tube: ['أنبوب', 'أنبوبين', 'أنابيب'],
  box: ['علبة', 'علبتين', 'علب'],
  clothing: ['قطعة', 'قطعتين', 'قطع'],
  shoe: ['زوج', 'زوجين', 'أزواج'],
  device: ['جهاز', 'جهازين', 'أجهزة'],
  generic: ['قطعة', 'قطعتين', 'قطع'],
};

describe('the nine shapes', () => {
  it('are the owner’s nine, each with a name and a drawing of its own', () => {
    expect([...PRODUCT_SHAPES]).toEqual(['bottle', 'jar', 'dropper', 'tube', 'box', 'clothing', 'shoe', 'device', 'generic']);
    expect(new Set(PRODUCT_SHAPES.map((s) => SHAPE_INFO[s].path)).size).toBe(9);
    for (const s of PRODUCT_SHAPES) {
      expect(SHAPE_INFO[s].ar, s).toMatch(/^[؀-ۿ ]+$/);
      // Path data only: nothing that could close the attribute it is written into.
      expect(SHAPE_INFO[s].path, s).toMatch(/^[MmLlHhVvCcSsAaZz0-9 .-]+$/);
    }
  });

  it.each(PRODUCT_SHAPES)('«%s»: singular, dual, plural — and singular again from eleven', (shape) => {
    const [one, two, few] = WORDS[shape];
    expect(unitWord(shape, 1)).toBe(one);
    expect(unitWord(shape, 2)).toBe(two);
    for (const n of [3, 7, 10, 103, 210]) expect(unitWord(shape, n), String(n)).toBe(few);
    for (const n of [0, 11, 12, 48, 99, 100, 101, 111]) expect(unitWord(shape, n), String(n)).toBe(one);
  });
});

describe('the stored choice', () => {
  it('keeps only products with a shape this system draws', () => {
    expect(readShapeMap({ p1: 'jar', p2: 'rocket', p3: 7, p4: 'shoe' })).toEqual({ p1: 'jar', p4: 'shoe' });
    for (const bad of [null, undefined, 'jar', ['jar'], 3]) expect(readShapeMap(bad)).toEqual({});
    expect(isProductShape('generic')).toBe(true);
    expect(isProductShape('constructor')).toBe(false);
  });

  it('is read from the company’s settings; none, a broken document or a failed read is «nobody chose»', async () => {
    const client = (findUnique: () => Promise<unknown>) => ({ company: { findUnique: vi.fn(findUnique) } }) as never;
    expect(await readProductShapes(client(async () => ({ settings: JSON.stringify({ productShapes: { p1: 'tube' } }) })), 'c1')).toEqual({ p1: 'tube' });
    expect(await readProductShapes(client(async () => ({ settings: null })), 'c1')).toEqual({});
    expect(await readProductShapes(client(async () => ({ settings: '{not json' })), 'c1')).toEqual({});
    expect(await readProductShapes(client(async () => { throw new Error('db down'); }), 'c1')).toEqual({});
  });
});
