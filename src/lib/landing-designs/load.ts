import { DESIGN_IDS, DESIGN_LOADERS, type DesignId } from '@/components/landing/designs/generated/index';
import type { DesignSkin } from './skin';
import { paletteFor, paletteVars, lightnessOf } from '@/lib/landing-theme';

/**
 * READING A PAGE'S DESIGN, AND LOADING THE ONE IT NAMES.
 *
 * The page names its design as `design` in its own theme JSON — the
 * library's contract (`catalog.ts`: «A page stores the chosen id as `design`
 * in its theme»). No column, no migration: the id rides in the JSON the page
 * already has.
 *
 * An id this build does not carry reads as NO design, never as a fallback
 * look: a page drawn in somebody else's colours is worse than a page drawn in
 * its own. And no design is exactly today's page — the renderer takes the old
 * path untouched (see `the-designs-wear-our-blocks.test.tsx`).
 */

const KNOWN = new Set<string>(DESIGN_IDS);

/** Whether this build can draw the design `id`. */
export function isDesignId(id: unknown): id is DesignId {
  return typeof id === 'string' && KNOWN.has(id);
}

/** The design a page's stored theme names, or null. Accepts the raw JSON or a parsed object. */
export function designIdOf(theme: unknown): DesignId | null {
  let t = theme;
  if (typeof t === 'string') {
    try {
      t = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (!t || typeof t !== 'object') return null;
  const id = (t as { design?: unknown }).design;
  return isDesignId(id) ? id : null;
}

/** The design itself — its own chunk, loaded only for a page that wears it. */
export async function loadDesign(id: string | null | undefined): Promise<DesignSkin | null> {
  if (!isDesignId(id)) return null;
  try {
    return (await DESIGN_LOADERS[id]()).default;
  } catch {
    // A design that fails to load is a page in its own look, still selling.
    return null;
  }
}

/**
 * THE ONE FACE A DESIGN LOADS — through the host every page already uses.
 *
 * Their pages loaded four families (Tajawal, Cairo, Almarai and the design's
 * own); ours load at most two, which is what keeps the font cost inside its
 * budget (`public-first-load.test.ts`). So only the design's own face is
 * fetched, from fonts.googleapis.com like every other page font — no new host.
 */
export function designFontHref(skin: Pick<DesignSkin, 'font'>): string | null {
  const g = skin.font.google;
  if (!g || !/^[A-Za-z0-9+:;@,.]+$/.test(g)) return null;
  return `https://fonts.googleapis.com/css2?family=${g}&display=swap`;
}

/** Dark when the page's own paper is dark. */
export function designIsDark(skin: Pick<DesignSkin, 'vars'>): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(skin.vars.pageBg) && lightnessOf(skin.vars.pageBg) < 0.5;
}

/**
 * The custom properties the design root carries: theirs (`--primary`, the
 * page paper) and ours (`--store-*`), so the blocks of ours that sit inside a
 * design — offers, reviews, the form — take its accent and its paper.
 */
export function designRootVars(skin: DesignSkin): Record<string, string> {
  const accent = /^#[0-9a-fA-F]{6}$/.test(skin.vars.primary) ? skin.vars.primary : '#111827';
  const ours = paletteVars(paletteFor({ accent, mood: 'clean', corners: 'soft' }));
  const dark = designIsDark(skin);
  return {
    ...ours,
    '--store-page': skin.vars.pageBg,
    ...(dark
      ? {
          '--store-text': '#f5f5f7',
          '--store-muted': 'rgba(255,255,255,.72)',
          '--store-border': 'rgba(255,255,255,.16)',
          '--store-surface-2': 'rgba(255,255,255,.06)',
        }
      : {}),
    '--primary': skin.vars.primary,
    '--btn-brand-color': skin.vars.btn || skin.vars.primary,
    '--order-header-color': skin.vars.orderHeader,
    '--font-color': dark ? '#f5f5f7' : skin.vars.ink,
    '--font-family': `'${skin.font.family.replace(/'/g, '')}'`,
    '--zd-page-bg': skin.vars.pageBg,
  };
}
