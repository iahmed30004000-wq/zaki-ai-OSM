import { describe, expect, it } from 'vitest';
import {
  DESIGNS,
  DESIGN_CATEGORIES,
  designById,
  designPreviewHref,
  filterDesigns,
  similarDesigns,
} from './catalog';

/**
 * THE SIXTY-FOUR, AS THE HARVEST COUNTED THEM.
 *
 * The numbers are the library page's own: «64 قالب · 28 متحرك», 37 light
 * and 27 dark, and the per-category counts the wizard's chips print. A
 * catalogue that drifted from them would put a different number on the
 * screen than the one the owner saw on his other site.
 */

describe('the catalogue', () => {
  it('holds 64 designs, 28 of them animated', () => {
    expect(DESIGNS).toHaveLength(64);
    expect(DESIGNS.filter((d) => d.animated)).toHaveLength(28);
  });

  it('marks exactly the «imx-» ids as animated', () => {
    for (const d of DESIGNS) expect(d.animated).toBe(d.id.startsWith('imx-'));
  });

  it('has no id twice', () => {
    expect(new Set(DESIGNS.map((d) => d.id)).size).toBe(DESIGNS.length);
  });

  it('puts at least one design in every category, with the harvest’s counts', () => {
    const count = (id: string) => DESIGNS.filter((d) => d.category === id).length;
    for (const c of DESIGN_CATEGORIES) expect(count(c.id)).toBeGreaterThan(0);
    expect(DESIGN_CATEGORIES).toHaveLength(12);
    expect(count('immersive')).toBe(28);
    expect(count('shopify')).toBe(10);
    expect(count('general')).toBe(5);
    expect(count('food')).toBe(1);
  });

  it('never names a category that is not in the set', () => {
    const known = new Set(DESIGN_CATEGORIES.map((c) => c.id));
    for (const d of DESIGNS) expect(known.has(d.category)).toBe(true);
  });

  it('splits 37 light and 27 dark', () => {
    expect(DESIGNS.filter((d) => d.mood === 'light')).toHaveLength(37);
    expect(DESIGNS.filter((d) => d.mood === 'dark')).toHaveLength(27);
  });

  it('gives every design a name, a line, four colours and a typeface', () => {
    for (const d of DESIGNS) {
      expect(d.name.trim()).not.toBe('');
      expect(d.description.trim()).not.toBe('');
      expect(d.swatches).toHaveLength(4);
      for (const s of d.swatches) expect(s).toMatch(/^#[0-9a-f]{6}$/i);
      expect(d.font.trim()).not.toBe('');
    }
  });
});

describe('looking a design up', () => {
  it('finds a known id', () => {
    expect(designById('cod-bold')?.name).toBe('عرض قوي');
  });

  it('answers nothing for an unknown, an empty or a missing id', () => {
    expect(designById('no-such')).toBeUndefined();
    expect(designById('')).toBeUndefined();
    expect(designById(null)).toBeUndefined();
  });

  it('links the full preview with the seller’s product, and without one', () => {
    expect(designPreviewHref('cod-bold', 'p1')).toBe('/lp/design-preview/cod-bold?product=p1');
    expect(designPreviewHref('cod-bold')).toBe('/lp/design-preview/cod-bold');
  });
});

describe('the filters', () => {
  it('keep only the chosen category', () => {
    const got = filterDesigns(DESIGNS, { category: 'beauty' });
    expect(got).toHaveLength(3);
    expect(got.every((d) => d.category === 'beauty')).toBe(true);
  });

  it('keep only the chosen mood', () => {
    expect(filterDesigns(DESIGNS, { mood: 'dark' })).toHaveLength(27);
  });

  it('search the name and the line', () => {
    expect(filterDesigns(DESIGNS, { query: 'روز غولد' }).map((d) => d.id)).toEqual(['rose-gold']);
  });

  it('combine, and an impossible combination answers empty rather than everything', () => {
    expect(filterDesigns(DESIGNS, { category: 'food', mood: 'dark' })).toHaveLength(0);
    expect(filterDesigns(DESIGNS, { query: 'لا يوجد هيك اسم' })).toHaveLength(0);
  });

  it('with nothing chosen, keep all 64', () => {
    expect(filterDesigns(DESIGNS, {})).toHaveLength(64);
  });
});

describe('«شوف كمان»', () => {
  it('never offers the design itself, and starts with its own category', () => {
    const got = similarDesigns('rose-gold');
    expect(got.map((d) => d.id)).not.toContain('rose-gold');
    expect(got[0].category).toBe('beauty');
  });

  it('answers nothing for an unknown id', () => {
    expect(similarDesigns('no-such')).toEqual([]);
  });
});
