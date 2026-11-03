import { SHELL_CSS } from './generated/shell';
import { IMX_KIT_CSS } from './generated/imx-kit';
import type { DesignSkin } from '@/lib/landing-designs/skin';

/**
 * THE STYLESHEET A DESIGNED PAGE WEARS — theirs, then the seams.
 *
 * `SHELL_CSS` and `skin.css` are generated from their pages, rescoped under
 * `[data-design]`. What is written here by hand is only what joins them to
 * our page:
 *
 *   1. The type defaults their page inherited from Bootstrap's reboot, which
 *      their builder's CSS assumes (a cta banner's heading has no size of its
 *      own; a paragraph keeps a bottom margin). Bootstrap itself is NOT
 *      loaded — these are our own few rules with the values it gives, under
 *      `:where()` so every class rule of theirs still wins, as it did there.
 *   2. The seams around OUR parts inside their look: our form inside their
 *      order section, our footer inside their footer, a block of ours inside
 *      one of their sections, and `<details>` doing their accordion's job
 *      without a script.
 *
 * Nothing here reaches inside the order form: its fields, its offers and its
 * errors keep our stylesheet.
 */
const REBOOT = [
  '[data-design]{font-size:1rem;line-height:1.5;text-align:start}',
  ':where([data-design] .bpr-section) :is(h1,h2,h3,h4,h5,h6){font-weight:500;line-height:1.2}',
  ':where([data-design] .bpr-section) h1{font-size:calc(1.375rem + 1.5vw)}',
  ':where([data-design] .bpr-section) h2{font-size:calc(1.325rem + .9vw)}',
  ':where([data-design] .bpr-section) h3{font-size:calc(1.3rem + .6vw)}',
  ':where([data-design] .bpr-section) h4{font-size:calc(1.275rem + .3vw)}',
  ':where([data-design] .bpr-section) h5{font-size:1.25rem}',
  ':where([data-design] .bpr-section) h6{font-size:1rem}',
  '@media (min-width:1200px){:where([data-design] .bpr-section) h1{font-size:2.5rem}:where([data-design] .bpr-section) h2{font-size:2rem}:where([data-design] .bpr-section) h3{font-size:1.75rem}:where([data-design] .bpr-section) h4{font-size:1.5rem}}',
  '[data-design] .bpr-section .bpr-widget--text p{margin:0 0 1rem}',
  ':where([data-design] .bpr-section) strong{font-weight:bolder}',
  ':where([data-design] .bpr-section) img{vertical-align:middle}',
  '[data-design] .container{width:100%}',
].join('');

const SEAMS = [
  // Their reset, at their weight — `*` lost to every element rule on their page — and on THEIR parts only: on our
  // form, our offers and our reviews it would take away spacing of their own.
  ':where([data-design] .bpr-section, [data-design] .zd-navbar, [data-design] .zd-footer) *{margin:0;padding:0}',
  ':where([data-design] .bpr-section, [data-design] .zd-navbar) a{text-decoration:none}',
  ':where([data-design] .bpr-section) img{max-width:100%}',
  // Their face on everything, as `!important` as theirs was — the design's typeface is the design.
  '[data-design],[data-design] *{font-family:var(--font-family),system-ui,sans-serif!important}',
  '[data-design]{color:var(--font-color);background:var(--zd-page-bg);overflow-x:clip}',
  // The accordion, as <details>: no script, the same look.
  '[data-design] .zd-faq>summary{list-style:none}',
  '[data-design] .zd-faq>summary::-webkit-details-marker{display:none}',
  '[data-design] .zd-faq[open]>summary .zd-plus{transform:rotate(45deg)}',
  '[data-design] .zd-faq .zd-plus{display:inline-block;transition:transform .2s ease}',
  // A block of ours inside one of their sections: their section holds the width and the rhythm.
  '[data-design] .zd-generic .lp-section{max-width:none;margin:0;padding:0}',
  // Our form inside their order section: their backdrop shows through ours.
  '[data-design] .zd-order-section{--store-page:transparent}',
  '[data-design] .zd-order-section>.container{max-width:760px}',
  // Our footer block inside their footer band.
  '[data-design] .zd-footer .lp-footer{border:0;padding:0;color:inherit}',
  '[data-design] .zd-footer .lp-footer a,[data-design] .zd-footer .lp-footer h3{color:inherit}',
  '[data-design] .zd-footer .lp-footer-cols{border-color:rgba(255,255,255,.12)}',
  // The first screen's price: the struck figure beside the one charged.
  '[data-design] .zd-was{opacity:.55;font-size:.62em;margin-inline-end:.4em;font-weight:600}',
  '[data-design] .zd-offer-line{display:inline-block;margin-top:.25rem;color:inherit;text-decoration:underline;text-underline-offset:3px}',
  '[data-design] .zd-offer-line b{font-weight:800}',
  // A step number where their page drew an icon font it never loaded.
  '[data-design] .zd-step-n{font-weight:900}',
  // A photograph that is not there yet — in a preview only.
  '[data-design] .zd-frame{aspect-ratio:1/0.8;width:100%;display:flex;align-items:center;justify-content:center;border:2px dashed var(--store-accent-border);background:var(--store-accent-tint);color:var(--store-accent);font-size:12px;font-weight:700;border-radius:18px}',
].join('');

/**
 * Everything a page wearing `skin` needs drawn, in cascade order. An animated
 * design also wears the motion kit's stylesheet — the one all twenty-eight
 * share, so it is written once (`generated/imx-kit.ts`) and sent only to them.
 */
export function designCss(skin: Pick<DesignSkin, 'css' | 'animated'>): string {
  return REBOOT + SHELL_CSS + SEAMS + (skin.animated ? IMX_KIT_CSS : '') + skin.css;
}
