import { newSection, SECTION_LABEL, type LandingSection } from '../landing-sections';
import { HOME_DESIGN_IDS, LOOK_IDS } from './ids.generated';
import { LOOK_TOKENS } from './tokens.generated';
import { cornersOf } from './paint';
import { HOME_DESIGN_PLANS } from './designs.generated';
import type { StoreTheme } from '../store-theme';
import type { DesignBlock, HomeDesignId, HomeDesignPlan, LeftOut, LookId, LookTokens } from './types';

export { HOME_DESIGN_IDS, LOOK_IDS };
export { RADIUS_LEVELS, RADIUS_SCALE, cornersOf, isLookId, lookTokens, lookVars, type RadiusLevel } from './paint';
export type { DesignBlock, HomeDesignId, HomeDesignPlan, LeftOut, LookId, LookTokens };

/**
 * THE OWNER'S OTHER PLATFORM'S THEMES, AS LOOKS OF OUR SHOP.
 *
 * The owner, 3/11: «شوف هدول نفس الشي اسحبهم للمتجر» — the theme library,
 * the theme builder and the slider of his own platform, with OUR builder,
 * blocks, offers, upsell and cross-sell underneath. A look here is their
 * theme stylesheet (`themes.css`), read by the generator, and nothing else:
 *
 *   · installing one COPIES its colours into the shop's own named colours
 *     (`lookToStoreTheme`) — the same act as installing one of our eleven
 *     skins, so every colour stays editable afterwards in the ordinary
 *     pickers and nothing is read from a pointer at paint time;
 *   · what a colour cannot say — their radius scale and their shadows — is
 *     written at paint time from the recorded id (`lookVars`), and only for
 *     a shop that recorded one. A shop that never picked a look draws no
 *     variable, no attribute and no rule of any of this.
 *
 * Ours are untouched: the eleven skins, the four families and the fifteen
 * home templates are still installed exactly as before, beside these.
 */

/** The thirteen, in their library's order. */
export const STORE_LOOKS: readonly LookTokens[] = LOOK_TOKENS;

/**
 * WHAT TRYING A LOOK WRITES ON THE SHOP'S THEME — a proposal, never saved by itself.
 *
 * Their tokens onto our roles, one for one:
 *
 *     their background · raised · surface     →  page · card · third surface
 *     their text · muted · border             →  ink · quiet ink · rules
 *     their text · muted again                →  the price · the struck price
 *     their primary · soft · inverse          →  accent · its wash · the ink on it
 *     their secondary                         →  «لون التمييز» (highlight)
 *     their success · warning · danger        →  the three states
 *     their navbar                            →  the header's own paper
 *
 * The named colours are REPLACED as a set, like installing a skin: a price
 * colour left over from another look would be one shop wearing two. The
 * fonts, the header's switches, the checkout and every word are not
 * touched — a look is a look.
 */
export function lookToStoreTheme(look: LookTokens) {
  const c = look.colors;
  return {
    accent: c.primary,
    mood: look.mode === 'dark' ? ('bold' as const) : c.background === '#ffffff' ? ('clean' as const) : ('warm' as const),
    corners: cornersOf(look),
    look: look.id,
    colors: {
      background: c.background,
      surface1: c.raised,
      surface2: c.surface,
      textPrimary: c.text,
      textSecondary: c.muted,
      border: c.border,
      // A price is their ink and the struck one their quiet ink. Left to
      // the derived palette they were dark-on-dark under «غامق» and «قوية».
      price: c.text,
      priceCompare: c.muted,
      accentTint: c.primarySoft,
      accentContrast: c.inverse,
      success: c.success,
      warning: c.warning,
      danger: c.danger,
    },
    highlight: c.secondary,
    headerBackground: look.navbar,
  };
}

/**
 * The shop's theme with a look tried on — the one merge, for the screen's
 * «جرّبه» and for the design install alike. A corner level the seller had
 * set is dropped so the look's own corners show; everything that is not a
 * colour or a corner stays the shop's.
 */
export function applyLook<T extends StoreTheme>(theme: T, look: LookTokens): T {
  const p = lookToStoreTheme(look);
  return {
    ...theme,
    accent: p.accent,
    mood: p.mood,
    corners: p.corners,
    look: p.look,
    radius: undefined,
    colors: p.colors,
    highlight: p.highlight,
    header: { ...(theme.header ?? { height: 72, sticky: true, onFrontPage: true }), background: p.headerBackground },
  };
}

/** The five dots a card shows, in the order their library shows them. */
export function lookSwatches(look: LookTokens): string[] {
  const c = look.colors;
  return [c.background, c.surface, c.primary, c.secondary, c.text];
}

// ─────────────────────────────────────────────────────
// The eighteen home designs
// ─────────────────────────────────────────────────────

const DESIGN_BY_ID: ReadonlyMap<string, HomeDesignPlan> = new Map(HOME_DESIGN_PLANS.map((d) => [d.id, d]));

export const HOME_DESIGNS: readonly HomeDesignPlan[] = HOME_DESIGN_PLANS;

export function homeDesign(id: unknown): HomeDesignPlan | null {
  return typeof id === 'string' ? (DESIGN_BY_ID.get(id) ?? null) : null;
}

/**
 * A DESIGN'S PAGE, AS OUR BLOCKS — with no words of theirs and no number nobody measured.
 *
 * Every block comes from `newSection`, the one helper every template and
 * every builder uses, so a home started from a design is the same kind of
 * thing as one started anywhere else and the panels edit it the same way.
 * What is set on top is SHAPE only: which products, in what order, how
 * many, how large. Titles are left empty: a catalogue with a sort and no
 * title writes its own heading, and «الأكثر مبيعاً» only when this shop's
 * delivered orders prove it (`catalogHeading`).
 */
export function designSections(plan: HomeDesignPlan): LandingSection[] {
  return plan.blocks.map((b) => blockOf(b));
}

function blockOf(b: DesignBlock): LandingSection {
  const s = newSection(b.type);
  switch (b.type) {
    case 'catalog':
      return {
        ...(s as Extract<LandingSection, { type: 'catalog' }>),
        title: '',
        source: b.source,
        sort: b.sort,
        limit: b.limit,
        columns: Math.min(4, Math.max(2, b.columns)),
        cardSize: b.cardSize,
        showCategories: b.showCategories,
      };
    case 'gallery':
      // «صور المنتج» is a product page's line; a shop's home has no one product.
      return { ...(s as Extract<LandingSection, { type: 'gallery' }>), title: '' };
    default:
      return s;
  }
}

/** What each block of a design is, in the seller's words — for the card, never for a shopper. */
export function designSummary(plan: HomeDesignPlan): string[] {
  return plan.blocks.map((b) => (b.type === 'catalog' ? SORT_LABEL[b.sort] + (b.limit === 1 ? ' — منتج واحد كبير' : '') : SECTION_LABEL[b.type]));
}

export const SORT_LABEL: Readonly<Record<'shelf' | 'newest' | 'best' | 'priceAsc', string>> = Object.freeze({
  shelf: 'منتجات المتجر',
  newest: 'وصل حديثاً',
  best: 'الأكثر مبيعاً (من الطلبات المسلَّمة)',
  priceAsc: 'الأقل سعراً',
});

/** Why a part of their page did not come with it — said to the seller, plainly. */
export const LEFT_OUT_LABEL: Readonly<Record<LeftOut, string>> = Object.freeze({
  marquee: 'الشريط المتحرك (عباراته عباراتهم — شريط الإعلانات بالترويسة يحمل عباراتك)',
  banners: 'بانرات العروض (صورها ونصوصها وروابطها لهم)',
  ctaBanner: 'بانر الدعوة (جملته وزره لهم)',
  whatsapp: 'قسم واتساب (زر واتساب العائم موجود بكل متجر)',
  countdown: 'العدّاد التنازلي (تاريخه مخترع — عدّادنا يحتاج نهاية عرض حقيقية)',
  copy: 'العناوين والنصوص والصور (كلامهم وصورهم)',
  brands: 'الماركات (ما في سجل ماركات هنا)',
  newsletter: 'النشرة البريدية (ما في تسجيل إيميلات هنا)',
  budget: 'تسوّق حسب الميزانية (ما في قسم لهيك بعد)',
  categoryRow: 'صفوف الأقسام (أرقام أقسامهم ما بتعني شي بمتجرك)',
  reviews: 'آراء العملاء (بالرئيسية ما في منتج، فما بتطلع تقييمات طلبات مسلَّمة)',
});
