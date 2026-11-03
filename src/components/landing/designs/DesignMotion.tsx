'use client';

import { useEffect } from 'react';

/**
 * A DESIGN'S MOTION, LOADED AFTER THE PAGE CAN ALREADY TAKE AN ORDER.
 *
 * The scripts are first-party — their own code, carried over verbatim by the
 * generator into `src/components/landing/designs/motion/` and shipped from this
 * repository like any other module. Never a seller's HTML: nothing here reads
 * the page's content, and the uploaded-HTML sanitizer is not involved.
 *
 * Three rules hold them:
 *
 *   · LAZY. Each is its own chunk, imported only by a page whose design uses
 *     it, after the browser is idle. The form is already drawn and working by
 *     then; a script that fails to arrive leaves a still page, not a broken one.
 *   · STILL FOR WHOEVER ASKED FOR STILL. `prefers-reduced-motion: reduce`
 *     loads nothing at all, and their stylesheets switch their own animations
 *     off under the same query.
 *   · NOT IN THE BUILDER. The builder re-renders on every key, and these
 *     scripts rewrite the elements they animate; only the published page and
 *     the design preview mount this.
 */
export function DesignMotion({ reveal, animated = false }: { reveal: boolean; animated?: boolean }) {
  useEffect(() => {
    if (!reveal && !animated) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      if (reveal) import('./motion/bpr-reveal').then((m) => m.start()).catch(() => {});
      if (animated) {
        // The effect layer first, then the kit — the order their page ran them in. Two chunks, both lazy.
        import('./motion/imx-fx')
          .then((m) => m.start())
          .catch(() => {})
          .then(() => import('./motion/mx-kit'))
          .then((m) => m.start())
          .catch(() => {});
      }
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(run);
    else window.setTimeout(run, 1);
  }, [reveal, animated]);
  return null;
}
