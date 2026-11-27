import { code128Bars, encodableCode128 } from './labels';

/**
 * WHAT EVERY WAYBILL DESIGN PRINTS WITH — one escape and one barcode.
 *
 * Moved out of `label-sheet.ts` unchanged (27/11) so the new designs (`waybill-designs.ts`) draw the very same bars
 * and escape the very same way, without the two files importing each other. `label-sheet.ts` re-exports all three.
 */

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
