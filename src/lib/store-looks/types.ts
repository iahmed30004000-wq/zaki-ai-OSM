import type { HOME_DESIGN_IDS, LOOK_IDS } from './ids.generated';

/** One of the thirteen looks of the owner's other platform. */
export type LookId = (typeof LOOK_IDS)[number];
/** One of its eighteen home designs. */
export type HomeDesignId = (typeof HOME_DESIGN_IDS)[number];

/**
 * A LOOK'S TOKENS — their theme stylesheet, as data.
 *
 * Their per-theme CSS is `html[data-theme=<id>] { --theme-…: … }` and
 * nothing else: colours, three radii and the radius a button, a card and a
 * field take from them, and three shadows. These are those values,
 * resolved (a `var()` pointing at another token is followed), and they are
 * written onto OUR variable names — see `lookVars` and `lookToStoreTheme`.
 */
export interface LookTokens {
  id: LookId;
  mode: 'light' | 'dark';
  colors: {
    background: string;
    surface: string;
    raised: string;
    primary: string;
    primarySoft: string;
    secondary: string;
    text: string;
    muted: string;
    inverse: string;
    border: string;
    success: string;
    warning: string;
    danger: string;
  };
  /** The header bar's own paper. */
  navbar: string;
  radius: { sm: string; md: string; lg: string; button: string; card: string; field: string };
  shadow: { sm: string; md: string; lg: string };
}

/**
 * One block of a home design, as OUR block library spells it.
 *
 * No field here can hold a sentence: a plan names a block type and its
 * SHAPE (which products, in what order, how many, how big). The words come
 * from the seller, or from what the shop's own orders prove.
 */
export type DesignBlock =
  | { type: 'slider' }
  | {
      type: 'catalog';
      source: 'products';
      sort: 'shelf' | 'newest' | 'best' | 'priceAsc';
      limit: number;
      columns: number;
      cardSize: 'sm' | 'md' | 'lg';
      showCategories: boolean;
    }
  | { type: 'trust' }
  | { type: 'faq' }
  | { type: 'gallery' };

/** Why one of their widgets has no block here — see the generator's `plan_of`. */
export type LeftOut =
  | 'marquee'
  | 'banners'
  | 'ctaBanner'
  | 'whatsapp'
  | 'countdown'
  | 'copy'
  | 'brands'
  | 'newsletter'
  | 'budget'
  | 'categoryRow'
  | 'reviews';

export interface HomeDesignPlan {
  id: HomeDesignId;
  /** The look the design wears. */
  look: LookId;
  blocks: DesignBlock[];
  left: LeftOut[];
}
