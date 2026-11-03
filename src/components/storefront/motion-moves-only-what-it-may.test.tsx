// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { EXTRAS_SLICES } from './extras-sheet';
import { Slider } from '@/components/landing/blocks/Slider';

// Unmount what each test drew: a tree left mounted is still scheduled work.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * «الحركة» — THE REVIEW OF #188, ITEMS 4 AND 5.
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

describe('a device that asks for less motion', () => {
  it('gets no press either, on every level', () => {
    const reduce = motion.slice(motion.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduce).toMatch(/\.sf-root\[data-motion\] \.lp-cta:active/);
    expect(reduce).toMatch(/transform: ?none ?!important/);
  });
});

describe('«بدون» stops the slider turning by itself', () => {
  const images = ['/a.jpg', '/b.jpg', '/c.jpg'];
  const shown = (c: HTMLElement) =>
    [...c.querySelectorAll('.lp-slider-slide')].findIndex((s) => s.getAttribute('aria-hidden') === 'false');

  it('a shop that set nothing: it turns, as it always did', () => {
    vi.useFakeTimers();
    const { container } = render(<div><Slider images={images} autoplay seconds={2} /></div>);
    act(() => { vi.advanceTimersByTime(2100); });
    expect(shown(container)).toBe(1);
  });

  it('under «بدون»: it stays where it is', () => {
    vi.useFakeTimers();
    const { container } = render(<div data-motion="none"><Slider images={images} autoplay seconds={2} /></div>);
    // Two turns of the clock: a slider that turned would be on its third picture.
    act(() => { vi.advanceTimersByTime(4100); });
    expect(shown(container)).toBe(0);
  });
});
