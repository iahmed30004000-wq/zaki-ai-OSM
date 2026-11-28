import { code128Bars, encodableCode128 } from './labels';

/**
 * WHAT EVERY WAYBILL DESIGN PRINTS WITH — one escape, one barcode, and the floors under the courier's type.
 *
 * Moved out of `label-sheet.ts` unchanged (27/11) so the new designs (`waybill-designs.ts`) draw the very same bars,
 * escape the very same way and hold the very same floors, without the two files importing each other. `label-sheet.ts`
 * re-exports all of them.
 */

/** The floor the type never goes under where the paper can hold it (≥ 50 mm tall, ≥ 60 wide). */
export const FLOOR_PT = { body: 9, name: 13, phones: 12, codAmount: 14 } as const;

/**
 * The scale the label printed at BEFORE 2/11, for this paper: four steps by
 * size. Kept only as a floor: no paper prints smaller type than it did then.
 * Every size in PT is at least the pre-2/11 one, so a scale at least this
 * one is type at least that big.
 */
export function legacyScale(size: { width: number; height: number }): number {
  const { width: w, height: h } = size;
  if (w < 70 || h < 70) return 0.78;
  if (w < 95 || h < 110) return 0.9;
  if (w <= 110 && h <= 160) return 1;
  return 1.3;
}

export function esc(value: string): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}

/** Ten modules of white each side — the Code 128 quiet zone. */
export const QUIET_MODULES = 10;

/**
 * A Code 128 barcode as ONE svg path, its quiet zones drawn into the symbol.
 *
 * One path for the whole symbol: the old one-rect-per-bar version put about
 * ten thousand elements into a run of two hundred labels. `crispEdges` keeps
 * bars from being anti-aliased into grey, which a scanner reads as width.
 */
export function barcodeSvg(value: string, heightMm: number): string {
  const bars = code128Bars(value);
  const total = bars.reduce((a, b) => a + b, 0) + QUIET_MODULES * 2;
  let x = QUIET_MODULES;
  let dark = true;
  let d = '';
  for (const w of bars) {
    if (dark) d += `M${x} 0h${w}v10h-${w}z`;
    x += w;
    dark = !dark;
  }
  return (
    `<svg viewBox="0 0 ${total} 10" preserveAspectRatio="none" width="100%" height="${heightMm}mm" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${esc(encodableCode128(value))}">` +
    `<path d="${d}" fill="#000"/></svg>`
  );
}
