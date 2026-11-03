import { LOOK_TOKENS } from './tokens.generated';
import type { LookId, LookTokens } from './types';

/**
 * WHAT A LOOK PAINTS — the half of `index.ts` the theme schema and the shop's
 * variables need, without the block library or the seller's names.
 */

const BY_ID: ReadonlyMap<string, LookTokens> = new Map(LOOK_TOKENS.map((l) => [l.id, l]));

export function isLookId(value: unknown): value is LookId {
  return typeof value === 'string' && BY_ID.has(value);
}

export function lookTokens(id: unknown): LookTokens | null {
  return isLookId(id) ? (BY_ID.get(id) ?? null) : null;
}

// ─────────────────────────────────────────────────────
// Corners — their scale
// ─────────────────────────────────────────────────────

/**
 * «الزوايا: افتراضي الثيم · حادة · ناعمة · دائرية» — the theme builder's
 * four choices. «افتراضي» is the field ABSENT: the look's own radii, or,
 * on a shop with no look, the two corners a landing theme always had.
 */
export const RADIUS_LEVELS = ['sharp', 'soft', 'round'] as const;
export type RadiusLevel = (typeof RADIUS_LEVELS)[number];

/**
 * Their three levels in our pixels. `sharp` and `soft` are the card radius a
 * landing theme already draws for its two corners (4px · 14px), so a shop
 * that picks the level its corners already were sees its cards unchanged;
 * `round` is their pill button and field over a rounder card.
 */
export const RADIUS_SCALE: Readonly<Record<RadiusLevel, { card: string; button: string; field: string }>> = Object.freeze({
  sharp: { card: '4px', button: '4px', field: '4px' },
  soft: { card: '14px', button: '10px', field: '10px' },
  round: { card: '20px', button: '999px', field: '999px' },
});

/** A landing page knows two corners: the nearest of them, for a look. */
export function cornersOf(look: LookTokens): 'soft' | 'sharp' {
  return parseInt(look.radius.card, 10) <= 4 ? 'sharp' : 'soft';
}

/** A shadow that is `none` cannot sit in a list of shadows; this one draws nothing and can. */
const shadow = (value: string) => (value === 'none' ? '0 0 0 0 transparent' : value);

/**
 * THE VARIABLES A LOOK AND A CORNER LEVEL WRITE — and nothing for a shop that set neither.
 *
 * Called by `storeThemeVars` after the derived palette, so `--store-radius`
 * here replaces the corners' own. The level beats the look: a seller who
 * picked «دائرية» over «أتيليه» asked for round corners on that look.
 */
export function lookVars(theme: { look?: string; radius?: RadiusLevel }): Record<string, string> {
  const out: Record<string, string> = {};
  const look = lookTokens(theme.look);
  if (look) {
    out['--store-radius'] = look.radius.card;
    out['--look-btn-r'] = look.radius.button;
    out['--look-field-r'] = look.radius.field;
    out['--look-shadow'] = shadow(look.shadow.sm);
    out['--look-lift'] = shadow(look.shadow.md);
  }
  const level = theme.radius && RADIUS_SCALE[theme.radius];
  if (level) {
    out['--store-radius'] = level.card;
    out['--look-btn-r'] = level.button;
    out['--look-field-r'] = level.field;
  }
  return out;
}

