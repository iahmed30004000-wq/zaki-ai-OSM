import { minifyCss } from '@/lib/css-minify';
import { badgeColour, type StoreTheme } from '@/lib/store-theme';

/**
 * THE RULES OF THE STORE-LOOKS PORT — written into a page only for the
 * shop that asked for them, and only the part it asked for.
 *
 * Not in `SHOP_SHEET`. That sheet is what every shop inlines, it is held
 * to a budget per page (`shop-budget.test.ts`), and a shop that never
 * opened the new controls must be drawn byte for byte as before
 * (`an-unchanged-shop-renders-as-before.test.tsx`). So each feature is its
 * own slice here, and `shopExtrasSheet` joins the slices this one shop's
 * theme names — '' for a shop that names none, and the shell then writes
 * no `<style>` at all.
 *
 * Every rule hangs off an attribute the shell sets only when the setting
 * is there (`data-look`, `data-radius`, `data-motion`, `data-logo`) or off
 * the ticker's own element, so a slice can never reach a shop that did not
 * ask for it even if it were inlined by mistake.
 */

/**
 * THEIR SHAPE, RESCOPED. Their themes.css gives a card, a button and a
 * field each their own radius, and every card a shadow; ours had one radius
 * for all three and a fixed shadow. `lookVars` writes their values; these
 * are the rules that read them, on OUR elements.
 */
const SHAPE_CSS = `
.sf-root:is([data-look],[data-radius]) :is(.sf-card, .lp-catalog-card) { border-radius: var(--store-radius); }
.sf-root:is([data-look],[data-radius]) .lp-cta { border-radius: var(--look-btn-r, var(--store-radius)); }
.sf-root:is([data-look],[data-radius]) :is(.sf-search input, .sf-search button) { border-radius: var(--look-field-r, var(--store-radius)); }
.sf-root[data-look] :is(.sf-card, .lp-catalog-card) { box-shadow: var(--look-shadow), 0 0 0 1px var(--store-border); }
.sf-root[data-look] :is(.sf-card, .lp-catalog-card):hover { box-shadow: var(--look-lift), 0 0 0 1px var(--store-border); }
`;

/**
 * THEIR MOTION, RESCOPED — storefront-motion.css, on our cards and buttons.
 *
 *   none   — nothing moves: no lift, no zoom, and the ticker stands still.
 *   subtle — a card lifts a little under the pointer; a button gives when pressed.
 *   full   — a higher lift with their shadow, the photo zooms, and each
 *            CONTENT section rises into view as it is scrolled to (by the
 *            browser's own scroll timeline — no script, and nothing hidden
 *            where it is not supported). Never the order form, nor anything
 *            fixed or sticky: a transform on an ancestor of a fixed bar pins
 *            that bar to the moving section instead of the screen, so a
 *            section holding a form, the floating order bar, the brand page's
 *            sticky bar or the filter sheet does not move at all.
 *
 * A device that asks for less motion gets none, whatever the seller chose.
 */
const MOTION_CSS = `
.sf-root[data-motion] { --mo-ease: cubic-bezier(.2, .7, .2, 1); }
.sf-root[data-motion='none'] :is(.sf-card, .lp-catalog-card, .sf-card-img, .lp-catalog-media img) { transition: none; transform: none; }
.sf-root[data-motion='none'] :is(.sf-card, .lp-catalog-card):hover, .sf-root[data-motion='none'] .sf-card:hover .sf-card-img { transform: none; }
.sf-root[data-motion='subtle'] :is(.sf-card, .lp-catalog-card) { transition: transform 260ms var(--mo-ease), box-shadow 260ms var(--mo-ease); }
.sf-root[data-motion='subtle'] :is(.sf-card, .lp-catalog-card):hover { transform: translate3d(0, -3px, 0); }
.sf-root:is([data-motion='subtle'], [data-motion='full']) .lp-cta:active { transform: scale(.97); }
.sf-root[data-motion='full'] :is(.sf-card, .lp-catalog-card) { transition: transform 260ms var(--mo-ease), box-shadow 260ms var(--mo-ease); }
.sf-root[data-motion='full'] :is(.sf-card, .lp-catalog-card):hover { transform: translate3d(0, -6px, 0); }
.sf-root[data-motion='full'] :is(.sf-card-img, .lp-catalog-media img) { transition: transform 600ms var(--mo-ease); }
.sf-root[data-motion='full'] :is(.sf-card:hover .sf-card-img, .lp-catalog-card:hover .lp-catalog-media img) { transform: scale(1.07); }
@supports (animation-timeline: view()) {
  .sf-root[data-motion='full'] main > :is(.lp-section, .sf-grid-wrap):not(:has(form, .lp-sticky-bar, .sf-bp-sticky, .sf-sheet)) { animation: sf-mo-rise linear both; animation-timeline: view(); animation-range: entry 0% entry 35%; }
}
@keyframes sf-mo-rise { from { opacity: 0; transform: translate3d(0, 26px, 0); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .sf-root[data-motion] *, .sf-root[data-motion] *::before, .sf-root[data-motion] *::after { animation: none !important; transition: none !important; }
  .sf-root[data-motion] :is(.sf-card, .lp-catalog-card):hover, .sf-root[data-motion] :is(.sf-card-img, .lp-catalog-media img) { transform: none !important; }
}
`;

/**
 * «شريط الإعلانات». Two copies of the list side by side, the second hidden
 * from screen readers, so the band can scroll forever without a jump; one
 * list, wrapped and centred, when it is static, under «بدون حركة», or for a
 * device that asks for less motion. It stops under the pointer.
 */
const TICKER_CSS = `
.sf-ticker { background: var(--store-highlight, var(--store-accent)); color: var(--store-highlight-ink, var(--store-accent-text)); font-size: 13px; font-weight: 700; overflow: hidden; }
.sf-ticker-track { display: flex; width: max-content; }
.sf-ticker-list { display: flex; gap: 36px; margin: 0; padding: 8px 18px; list-style: none; white-space: nowrap; }
.sf-ticker a { color: inherit; text-decoration: none; }
.sf-ticker[data-mode='scroll'] .sf-ticker-track { animation: sf-ticker 32s linear infinite; }
[dir='ltr'] .sf-ticker[data-mode='scroll'] .sf-ticker-track { animation-name: sf-ticker-ltr; }
.sf-ticker:hover .sf-ticker-track { animation-play-state: paused; }
@keyframes sf-ticker { to { transform: translateX(50%); } }
@keyframes sf-ticker-ltr { to { transform: translateX(-50%); } }
.sf-ticker[data-mode='static'] .sf-ticker-track, .sf-root[data-motion='none'] .sf-ticker-track { width: auto; justify-content: center; animation: none; }
.sf-ticker[data-mode='static'] .sf-ticker-list[aria-hidden], .sf-root[data-motion='none'] .sf-ticker-list[aria-hidden] { display: none; }
.sf-ticker[data-mode='static'] .sf-ticker-list, .sf-root[data-motion='none'] .sf-ticker-list { flex-wrap: wrap; justify-content: center; white-space: normal; row-gap: 4px; }
@media (prefers-reduced-motion: reduce) {
  .sf-ticker-track { width: auto; justify-content: center; animation: none !important; }
  .sf-ticker-list[aria-hidden] { display: none; }
  .sf-ticker-list { flex-wrap: wrap; justify-content: center; white-space: normal; }
}
`;

/**
 * «شارة العرض» · «لون التمييز» — THE OFFER BADGES, IN THE COLOUR THE SHOP NAMED.
 *
 * `--store-offer-badge` was written and read by nothing, so both pickers
 * coloured nothing. The badges a shopper sees are «الأوفر» on an offer card
 * and «عرض خاص» on a catalogue card; they keep the accent unless the shop
 * named a badge colour, and then wear it with measured ink.
 */
const BADGE_CSS = `
.sf-root[data-badge] :is(.lp-offer-tag, .lp-catalog-tag) { background: var(--store-offer-badge); color: var(--store-offer-badge-ink); }
`;

/** «حجم الشعار». */
const LOGO_CSS = `
.sf-root[data-logo] .sf-logo { height: var(--store-logo-h); max-width: calc(var(--store-logo-h) * 4); }
`;

/** Each slice minified once, when the module loads. */
export const EXTRAS_SLICES = Object.freeze({
  shape: minifyCss(SHAPE_CSS),
  motion: minifyCss(MOTION_CSS),
  ticker: minifyCss(TICKER_CSS),
  logo: minifyCss(LOGO_CSS),
  badge: minifyCss(BADGE_CSS),
});

/** The slices this shop's theme asks for, joined — '' when it asks for none. */
export function shopExtrasSheet(theme: StoreTheme): string {
  const parts: string[] = [];
  if (theme.look || theme.radius) parts.push(EXTRAS_SLICES.shape);
  if (theme.motion) parts.push(EXTRAS_SLICES.motion);
  if (theme.ticker?.enabled) parts.push(EXTRAS_SLICES.ticker);
  if (theme.header?.logoHeight) parts.push(EXTRAS_SLICES.logo);
  if (badgeColour(theme)) parts.push(EXTRAS_SLICES.badge);
  return parts.join('');
}

/**
 * THE BAND'S LINES — the seller's, or the two facts every shop here keeps.
 *
 * Never a line of anybody else's: with none typed, it says what the header's
 * reassurance line already says, and «تغليف خفي» only where the seller
 * switched that promise on.
 */
export function tickerLines(theme: StoreTheme): string[] {
  const own = (theme.ticker?.items ?? []).map((s) => s.trim()).filter(Boolean);
  if (own.length) return own;
  return ['الدفع عند الاستلام', 'توصيل لكل المحافظات', ...(theme.discreetPacking ? ['تغليف خفي'] : [])];
}
