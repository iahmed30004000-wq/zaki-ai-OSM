'use client';

import { useLayoutEffect, type RefObject } from 'react';

/**
 * THE INBOX ENDS AT THE BOTTOM OF THE WINDOW — the reply box is never below the fold.
 *
 * The column is first drawn as «the window minus the header» (`calc(100dvh - var(--sys-header-h))`). Measured on the running
 * screen (26/11) that is still too tall by what sits between the header and the inbox — the section's tab strip and the page's
 * padding (≈150 px at 1600×1000) — so the page scrolled and the reply box hid under the fold. This measures where the column
 * actually starts and what padding follows it, and gives it exactly the rest of the window; it follows a resize, and an
 * element above it changing height (a banner closed).
 */
export function useFitToWindow(ref: RefObject<HTMLElement | null>, minPx = 420) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const parent = el.parentElement;
      const after = parent ? parseFloat(getComputedStyle(parent).paddingBottom) || 0 : 0;
      el.style.height = `${Math.max(minPx, Math.floor(window.innerHeight - top - after))}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    const watch = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    if (watch && document.body) watch.observe(document.body);
    return () => {
      window.removeEventListener('resize', fit);
      watch?.disconnect();
    };
  }, [ref, minPx]);
}
