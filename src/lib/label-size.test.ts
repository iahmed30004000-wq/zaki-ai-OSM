import { describe, expect, it } from 'vitest';
import { LABEL_SIZES } from './labels';
import { dimsOf } from '@/components/labels/LabelSize';

/**
 * Which millimetres go to the printer.
 *
 * Three screens print waybills and two of them used to send 100×150 no
 * matter what paper was loaded, so the same order came out thermal-sized
 * from the orders screen and A4-sized from the labels screen. The
 * resolution below is now the single answer all three ask.
 */

// The resolution itself — the component's own function, no longer a copy
// of it: a mirror passes while the real one drifts, which is how a
// half-typed custom size reached the server without a test noticing.
// It runs without a DOM.

const custom = { width: 80, height: 120 };

describe('resolving the label size', () => {
  it('sends a thermal roll with no sheet — the page IS the label', () => {
    // A sheet on a thermal roll would print one waybill per A4-shaped page
    // and eat the whole roll.
    const dims = dimsOf({ key: '100x150', custom });
    expect(dims).toMatchObject({ width: 100, height: 150 });
    expect(dims.sheetWidth).toBeUndefined();
  });

  it('sends the sheet for an office size, so several share a page', () => {
    // Without it a run of thirty orders eats thirty A4 sheets for a
    // quarter of their area each.
    expect(dimsOf({ key: 'a6', custom })).toMatchObject({
      width: 105,
      height: 148,
      sheetWidth: 210,
      sheetHeight: 297,
    });
  });

  it('falls back to the typed millimetres for a custom size', () => {
    expect(dimsOf({ key: 'custom', custom })).toEqual(custom);
  });

  it('falls back to the typed millimetres for a size that no longer exists', () => {
    // A key remembered on somebody's machine from a size later removed
    // must not resolve to undefined and print nothing.
    expect(dimsOf({ key: 'a-size-we-deleted', custom })).toEqual(custom);
  });

  it('offers a thermal roll first, because that is what a label printer holds', () => {
    expect(LABEL_SIZES[0].sheet).toBeUndefined();
  });

  it('keeps every size inside what the server will accept', () => {
    // The batch endpoint refuses anything outside 40–300mm for the label
    // and 40–500mm for the sheet; a preset that cannot be printed is worse
    // than no preset.
    for (const s of LABEL_SIZES) {
      expect(s.width, s.key).toBeGreaterThanOrEqual(40);
      expect(s.width, s.key).toBeLessThanOrEqual(300);
      expect(s.height, s.key).toBeGreaterThanOrEqual(40);
      expect(s.height, s.key).toBeLessThanOrEqual(300);
      if (s.sheet) {
        expect(s.sheet.width, s.key).toBeLessThanOrEqual(500);
        expect(s.sheet.height, s.key).toBeLessThanOrEqual(500);
        // A label larger than its own sheet cannot be laid out.
        expect(s.width, s.key).toBeLessThanOrEqual(s.sheet.width);
        expect(s.height, s.key).toBeLessThanOrEqual(s.sheet.height);
      }
    }
  });

  it('has no two sizes sharing a key', () => {
    const keys = LABEL_SIZES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    // "custom" is the picker's own option and must not collide with one.
    expect(keys).not.toContain('custom');
  });
});
