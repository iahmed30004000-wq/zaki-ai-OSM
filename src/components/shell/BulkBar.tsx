'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BulkDoneMoment } from '@/components/ui/BulkDoneMoment';

/**
 * WHEN SOMETHING IS SELECTED, THE BOTTOM OF THE PHONE BELONGS TO IT.
 *
 * The orders list has had a bulk bar for a long time, and on a phone it has
 * been unreachable the whole time: it renders above the list, so you scroll
 * down, tap five rows, and the thing that acts on them is four screens up.
 * People scroll back, lose the scroll position, and stop selecting.
 *
 * So while a selection is live the bottom navigation stands down and the
 * bar takes its place — the same strip of screen the thumb is already on.
 * Navigating away mid-selection is not what anybody is trying to do.
 *
 * On a desk nothing moves: there is no bottom navigation to yield, and the
 * bar stays where it has always been, above the rows it acts on.
 *
 * WHAT THIS IS NOT.
 *
 * It is not a bulk bar. It does not decide what a bar contains, how it is
 * laid out, or what its buttons look like — the orders screen still owns
 * all of that, exactly as before. This is the SHELL agreeing to get out of
 * the way, and it is deliberately the whole of the mechanism.
 */

const Ctx = createContext<{ active: boolean; claim: (on: boolean) => void }>({
  active: false,
  claim: () => undefined,
});

/** Lives in the Shell, around everything. */
export function BulkProvider({ children }: { children: React.ReactNode }) {
  /**
   * A count, not a boolean. Two screens could mount bars in one session,
   * and a boolean lets the second one's unmount switch the navigation back
   * on underneath the first one's live selection.
   */
  const [claims, setClaims] = useState(0);
  const value = useMemo(
    () => ({
      active: claims > 0,
      claim: (on: boolean) => setClaims((n) => Math.max(0, n + (on ? 1 : -1))),
    }),
    [claims]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read by the bottom navigation, which hides itself while this is true. */
export function useBulkActive(): boolean {
  return useContext(Ctx).active;
}

/**
 * Wraps a screen's own bulk bar.
 *
 * `show` is the screen's existing condition — nothing here decides when a
 * selection exists. When it is false this renders no bar at all — only the
 * finished-batch moment's empty live region (see below) — so a screen with
 * no selection costs one boolean and one empty node.
 */
export function BulkBar({
  show,
  children,
  /**
   * The batch that just finished, if one did.
   *
   * The bar owns the moment because the bar is the one thing that is
   * already on screen for every batch action, on every screen that has
   * one — a second component per screen would be the same picture with
   * three different lapses. `serial` is the batch's identity, not a
   * boolean: a boolean cannot tell a second batch from a re-render, and
   * would either swallow the second finishing or replay the first.
   */
  done,
}: {
  show: boolean;
  children: React.ReactNode;
  done?: { serial: number; count: number } | null;
}) {
  const { claim } = useContext(Ctx);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    claim(true);
    return () => claim(false);
    // `claim` is stable in what matters: it only ever adjusts a counter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  /**
   * The page has to reserve room for this, and the room is not a constant:
   * the bar wraps to two or three rows on a narrow phone depending on how
   * many actions the person may perform. A fixed guess leaves the last
   * order row underneath it — which is the row somebody just selected.
   */
  useEffect(() => {
    const el = bar.current;
    if (!show || !el || typeof ResizeObserver === 'undefined') return;
    const write = () =>
      document.documentElement.style.setProperty('--bulk-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    write();
    const watch = new ResizeObserver(write);
    watch.observe(el);
    return () => {
      watch.disconnect();
      document.documentElement.style.removeProperty('--bulk-h');
    };
  }, [show]);

  /*
   * The moment is rendered even when the bar is gone — that is exactly the
   * state a finished batch leaves behind (the selection cleared, so `show`
   * is false). Early-returning first would have swallowed every completion.
   *
   * ── AND IT STAYS AT ONE PLACE IN THE TREE, WHATEVER `show` IS ──
   *
   * This used to return the moment ALONE when `show` was false and the
   * moment as the first child of a fragment beside the bar when it was
   * true. That happened to keep the moment's memory, but only because React
   * unwraps an unkeyed top-level fragment and so matched the two shapes by
   * position — an implementation detail one wrapper or one `key` away from
   * remounting the moment on every flip of the selection, with a fresh
   * memory of which batch it had already played (finish thirty, tick one
   * row, and the same thirty play again). One shape now, the moment always
   * the first child and the bar second only when there is a selection, so
   * the moment's memory lives exactly as long as the screen does by
   * construction; the test «a selection flip after a batch does not replay
   * the batch» holds it.
   *
   * With no batch to report the moment draws only its empty, zero-high live
   * region, so a screen with no selection still costs one boolean and one
   * empty node.
   */
  return (
    <>
      <BulkDoneMoment serial={done?.serial ?? null} count={done?.count ?? null} />
      {show && (
      /*
       * ONE PLAIN BOX AROUND THE BAR, FOR THE PARENT'S SPACING.
       * Screens stack their blocks with a vertical gap on every child, and a
       * margin on a FIXED box is an offset: the bar stood 12-24px above the
       * bottom edge of the phone, with the list showing through underneath.
       * The margin now lands on this empty wrapper (it collapses into its
       * neighbour's), and the bar inside sits on the edge. On a desk the bar
       * is static, so the gap above the rows is the one it always had.
       */
      <div>
      <div
      ref={bar}
      className={
        // Phone: the bottom strip, above the home indicator, over the page.
        'fixed inset-x-0 bottom-0 z-30 border-t border-[var(--sys-primary-soft)] ' +
        'bg-[var(--sys-card)] px-4 py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] ' +
        // Desk: exactly where it has always been.
        'md:static md:z-auto md:rounded-lg md:border md:bg-[var(--sys-primary-soft)] md:pb-2.5'
      }
      role="toolbar"
      aria-label="إجراءات على المحدَّد"
    >
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
      </div>
      )}
    </>
  );
}
