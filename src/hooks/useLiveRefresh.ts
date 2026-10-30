'use client';

import { useEffect, useRef } from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A SCREEN THAT IS LEFT OPEN STOPS BEING TRUE.
 *
 * The owner, 20/10: «الصفحات ما بتتحدث غير لما اعمل ريفرش».
 *
 * Measured: sixty-one screens, and **fifty-four of them fetched once on
 * mount and never again**. Three had a hand-written answer to it — the
 * dashboard, the orders list and the WhatsApp inbox — and those three
 * were three copies of the same twelve lines, which is the other half of
 * the problem.
 *
 * This is what a seller actually does: opens «الطلبات» in one tab, works
 * in another, comes back an hour later and decides from what is on the
 * screen. Nobody refreshes a page they never left. So an agent confirms
 * an order that a colleague already cancelled, and a supervisor reads a
 * figure from this morning as today's.
 *
 * ── WHAT IT LISTENS FOR, AND WHY BOTH ──
 *
 * `visibilitychange` catches coming back to the TAB. `focus` catches
 * coming back to the WINDOW — alt-tabbing to another application and
 * back fires focus and not visibility, and that is most of a working day
 * on a desktop. Either one on its own leaves half the cases stale. And
 * `online` catches the connection returning: a laptop that slept through
 * a dead wifi wakes showing whatever was true before it dropped.
 *
 * ── AND WHY IT IS THROTTLED ──
 *
 * The two events fire together when a tab is raised, and a person moving
 * between windows fires them repeatedly. Without a floor, returning to a
 * screen could ask the server three times in a second, on every screen
 * at once. `MIN_GAP_MS` is the smallest gap between two refreshes from
 * ANY of the triggers — not a debounce: the first one goes immediately,
 * because the whole point is that the screen is right the moment it is
 * looked at.
 *
 * ── AND WHY THE CALLBACK LIVES IN A REF ──
 *
 * Callers write `const load = useCallback(…, [filters])`, so the
 * identity changes whenever a filter does. Subscribing to the events
 * with that in the dependency list would tear the listeners down and
 * rebuild them on every keystroke in a search box. The ref is read at
 * call time, so the listeners are attached once and always call the
 * CURRENT loader.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The smallest gap between two refreshes, whichever trigger asked. */
const MIN_GAP_MS = 3_000;

interface Options {
  /**
   * Also refresh on a timer, in milliseconds. Off by default.
   *
   * A list other people are changing under you — a queue, an inbox —
   * wants one; a settings form does not, and a screen that polls for no
   * reason is a cost paid by every open tab in the company.
   *
   * ⚠️ The tick is SKIPPED while the tab is hidden. A background tab that
   * keeps asking is a phone's battery and a server's load for a screen
   * nobody is looking at — and the moment it is looked at, the
   * visibility handler refreshes it anyway.
   */
  everyMs?: number;
  /**
   * Set false to run nothing at all — for a screen whose data is a
   * snapshot by nature (a printed statement, a closed period). Written
   * as a prop rather than by leaving the hook out, so the decision is
   * visible where the screen is read.
   */
  enabled?: boolean;
  /**
   * Reload when this changes — the screen's own filter, period or tab.
   *
   * The loader itself is deliberately NOT a dependency (see the note on
   * the ref), so a screen that reloads when a filter moves needs a way
   * to say which filter. Without this it would keep its own
   * `useEffect(() => { void load(); }, [load])` beside the hook, and
   * both would fire on mount: two identical requests on every screen
   * that has a filter, which is most of them.
   */
  key?: string | number | boolean | null;
  /**
   * Set false when the SCREEN already owns its first load.
   *
   * Most screens have none of their own, so the hook doing it is what
   * makes adopting this remove a line rather than add one. But a screen
   * with a debounced search box loads itself — `ShipmentsNewScreen` and
   * `CustomersScreen` both wait 250ms after a keystroke — and the hook
   * firing as well means two requests on mount for the same rows.
   *
   * ⚠️ Measured, not theorised: it broke
   * `select-all-takes-what-is-shown.test.tsx`. The second answer landed
   * after the three rows had been ticked and replaced them, so «إنشاء
   * شحنة (3)» became «(0)» — a clerk's whole selection, gone, with
   * nothing on the screen to explain it.
   */
  initial?: boolean;
  /**
   * Called each time the person comes back — to the tab, to the window, or the connection returning — BEFORE the
   * refresh that return triggers, and even when the throttle swallows that refresh. For a screen that keeps state
   * about HOW it polls (the WhatsApp inbox slows down when nothing happens and must go back to its fast pace the moment
   * someone is looking again). It lives here so no screen listens for these events by hand.
   */
  onReturn?: () => void;
}

/**
 * Loads on mount, and again whenever the person comes back to the screen.
 *
 * Replaces the `useEffect(() => { void load(); }, [load])` that every
 * screen was writing, so adopting it removes a line rather than adding
 * one — and a screen cannot end up with the first half and not the
 * second.
 */
export function useLiveRefresh(load: () => void | Promise<unknown>, options: Options = {}): void {
  const { everyMs, enabled = true, key, initial = true, onReturn: onReturnOption } = options;
  const loadRef = useRef(load);
  const returnRef = useRef(onReturnOption);
  const lastAt = useRef(0);

  // Assigned in an effect and never during render: a ref written while
  // rendering is a side effect in a function React may call twice.
  useEffect(() => {
    loadRef.current = load;
    returnRef.current = onReturnOption;
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const run = (force = false) => {
      if (cancelled) return;
      const now = Date.now();
      if (!force && now - lastAt.current < MIN_GAP_MS) return;
      lastAt.current = now;
      void loadRef.current();
    };

    // The first load is forced: the throttle is about repeat triggers,
    // and a screen must never open empty because another screen asked a
    // second ago. Skipped entirely when the screen loads itself.
    if (initial) run(true);

    const onReturn = () => {
      if (document.hidden) return;
      returnRef.current?.();
      run();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    // And when the connection comes back. A laptop that slept through a
    // dead wifi wakes with a screen full of whatever was true before it
    // dropped, and the WhatsApp inbox was the only screen that knew.
    window.addEventListener('online', onReturn);

    const interval = everyMs
      ? setInterval(() => {
          if (!document.hidden) run(true);
        }, everyMs)
      : undefined;

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onReturn);
      if (interval) clearInterval(interval);
    };
    // `load` is deliberately absent — see the note on the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, everyMs, key, initial]);
}
