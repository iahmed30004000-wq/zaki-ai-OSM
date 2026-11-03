// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { EXTRAS_SLICES } from './extras-sheet';

// Unmount what each test drew: a tree left mounted is still scheduled work.
afterEach(cleanup);

/**
 * «الحركة» — THE REVIEW OF #188, ITEM 4.
 *
 * «قوية» moved every direct child of the page's main, the order form and the
 * fixed bars included — and a transform on an ancestor of a fixed bar pins
 * that bar to the moving section instead of the screen. «بدون» left the
 * slider turning, and a device asking for less motion still got the press.
 */
const motion = EXTRAS_SLICES.motion;

/** The selector of the scroll reveal, as the sheet ships it. */
function revealSelector(): string {
  const m = motion.match(/@supports \(animation-timeline: ?view\(\)\) ?\{(.*?)\{/);
  expect(m, 'the reveal rule is gone').not.toBeNull();
  return m![1].trim();
}

describe('«قوية» moves content sections only', () => {
  it('never every child of main', () => {
    expect(motion).not.toMatch(/main ?> ?\*/);
  });

  it.each([
    ['a content section', '<section class="lp-section"><p>x</p></section>', true],
    ['the catalogue grid', '<div class="sf-grid-wrap"><div class="sf-grid"></div></div>', true],
    ['a section holding the order form', '<section class="lp-section"><form id="zaki-order-form"></form></section>', false],
    ['a section holding the floating order bar', '<section class="lp-section"><div class="lp-sticky-bar"></div></section>', false],
    ['the floating order bar itself', '<div class="lp-sticky-bar"></div>', false],
    ['the brand page’s sticky bar', '<section class="lp-section"><div class="sf-bp-sticky"></div></section>', false],
    ['the filter sheet', '<div class="sf-grid-wrap"><div class="sf-sheet"></div></div>', false],
    ['anything else', '<div class="lp-announce"></div>', false],
  ])('%s → %s', (_what, html, moves) => {
    document.body.innerHTML = `<div class="sf-root" data-motion="full"><main>${html}</main></div>`;
    const el = document.querySelector('main > *')!;
    expect(el.matches(revealSelector())).toBe(moves);
  });
});
