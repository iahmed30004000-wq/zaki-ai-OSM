'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IDLE_WARN_MS, ON_CALL_KEY, creditForCall, idleState, secondsLeft, type IdleState } from '@/lib/exposure';
import { signOut } from '@/lib/sign-out';
import { RiEyeOffLine, RiLockLine } from '@remixicon/react';

/**
 * A PHONE LEFT ON A COUNTER.
 *
 * The session cookie lasts seven days, thirty with "remember me". That is
 * right for the person: signing in every morning on a phone is how people
 * end up writing the password on the inside of a drawer. It is wrong for
 * the phone itself, which spends those seven days in a pocket, on a
 * counter, in a repair shop, and in one case in a taxi.
 *
 * So the cookie stays long and the SCREEN gets short. Twenty minutes with
 * nothing touched and this device is signed out for real — the server stamps
 * its session row ended, so the cookie somebody kept a copy of is dead too,
 * not merely hidden (and, since the owner's ruling 4/11, the account's other
 * device stays signed in).
 *
 * A minute of warning first, because signing somebody out silently in the
 * middle of a shift is how a safety measure gets switched off. THE OWNER'S
 * RULING 4/11 made that a promise: the warning is SEEN before any idle
 * sign-out. A page that runs out while hidden is not signed out while
 * hidden, nor on return; it shows the full minute's countdown first. And the
 * time on a call started from «اتصال» is not idle at all (exposure.ts).
 *
 * THE BLUR IS NOT A PROMISE. When the app goes to the background the
 * content is covered, which is aimed at one specific thing: the thumbnail
 * the phone keeps of the app in its task switcher, glanced at by whoever is
 * next to you. It is best effort — some systems take that picture before
 * the page is told it is hidden — and it stops no screenshot, no recording
 * and no camera. See the note in src/lib/exposure.ts.
 */

/** A timestamp, shared between this account's open tabs. Never anything else. */
const KEY = 'salesflow.lastActive';

/** How often the clock is consulted. Cheap, and never the thing that drifts. */
const TICK_MS = 5_000;

/** How rarely activity is written to storage — a scroll fires by the hundred. */
const WRITE_EVERY_MS = 10_000;

const WATCHED = ['pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart'] as const;

export function IdleGuard() {
  const [phase, setPhase] = useState<IdleState>('active');
  const [left, setLeft] = useState(0);
  const [covered, setCovered] = useState(false);

  // Seeded in the effect, not here: reading the clock during render is a
  // value that changes on a re-render nobody asked for.
  const lastActive = useRef(0);
  const lastWrite = useRef(0);
  const leaving = useRef(false);
  /** When the page went to the background; 0 while it is on screen. */
  const hiddenSince = useRef(0);
  /** The end of the minute's warning a return was given (ruling 4/11); 0 when none is running. */
  const graceUntil = useRef(0);

  /** Somebody is here. */
  const touch = useCallback(() => {
    const now = Date.now();
    lastActive.current = now;
    graceUntil.current = 0;
    if (now - lastWrite.current > WRITE_EVERY_MS) {
      lastWrite.current = now;
      try {
        localStorage.setItem(KEY, String(now));
      } catch {
        /* blocked storage costs the other tabs their share of this, nothing more */
      }
    }
    // React bails out when the value is unchanged, so a scroll does not
    // re-render the whole shell sixty times a second.
    setPhase((p) => (p === 'active' ? p : 'active'));
  }, []);

  useEffect(() => {
    // Arriving here IS somebody acting: they opened or reloaded the app.
    // A timestamp another tab wrote is adopted only when it is NEWER —
    // never older, or opening the app after a week away would read last
    // week as "twenty minutes idle" and bounce the person straight back to
    // the login screen they just came from.
    lastActive.current = Date.now();
    try {
      const stored = Number(localStorage.getItem(KEY));
      if (Number.isFinite(stored) && stored > lastActive.current) lastActive.current = stored;
    } catch {
      /* blocked storage costs the other tabs their share of this, nothing more */
    }

    for (const event of WATCHED) {
      window.addEventListener(event, touch, { passive: true });
    }

    const fromOtherTab = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      const at = Number(e.newValue);
      // Working in the other tab IS working. Only ever moves forward:
      // a stale write must not resurrect a session that has run out.
      if (Number.isFinite(at) && at > lastActive.current) {
        lastActive.current = at;
        graceUntil.current = 0;
        setPhase((p) => (p === 'active' ? p : 'active'));
      }
    };
    window.addEventListener('storage', fromOtherTab);

    /**
     * BACK ON SCREEN — the owner's ruling 4/11.
     *
     * Returning to the tab is still NOT, by itself, activity: somebody picking
     * up a phone that has been face-down for an hour reaches exactly this
     * moment. What changed is what happens next.
     *
     *   · A call started from «اتصال» counts: from its mark until now, up to
     *     an hour (`creditForCall`). The mark is spent either way.
     *   · If the session has run out (or is in its last minute), she is NOT
     *     signed out on the spot. The minute's countdown is drawn, in full,
     *     and any touch cancels it. Before, the warning was drawn while the
     *     page was hidden — to nobody — and the sign-out came within five
     *     seconds of her coming back from a call.
     */
    const cameBack = (now: number) => {
      const away = hiddenSince.current;
      hiddenSince.current = 0;
      let mark = NaN;
      try {
        mark = Number(localStorage.getItem(ON_CALL_KEY));
        localStorage.removeItem(ON_CALL_KEY);
      } catch {
        /* blocked storage: no call is counted, exactly as before the ruling */
      }
      const credited = creditForCall(lastActive.current, mark, away, now);
      if (credited > lastActive.current) {
        lastActive.current = credited;
        try {
          // The other tabs are told too, the same way a touch tells them.
          localStorage.setItem(KEY, String(credited));
        } catch {
          /* blocked storage costs the other tabs their share of this, nothing more */
        }
      }
      if (idleState(lastActive.current, now) !== 'active' && !leaving.current) {
        graceUntil.current = now + IDLE_WARN_MS;
        setLeft(Math.ceil(IDLE_WARN_MS / 1000));
        setPhase('warning');
      }
    };

    const onVisibility = () => {
      const hidden = document.hidden;
      setCovered(hidden);
      if (hidden) {
        if (!hiddenSince.current) hiddenSince.current = Date.now();
      } else if (hiddenSince.current) {
        cameBack(Date.now());
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    /**
     * THREE TRIGGERS, ONE ANSWER: `document.hidden`.
     *
     * Reported twice: «I am away from the site, I come back, and the scroll
     * does not work until I click inside the screen». The curtain's own test
     * proves it lifts on `visibilitychange` — and that event IS NOT ALWAYS
     * FIRED on the way back. Restoring a minimised window, or returning from
     * another application, can leave the document visible with no event at
     * all, and the curtain stayed up over a page that was on screen.
     *
     * So `focus` and `pageshow` ask the same question rather than answering a
     * different one. A first version let `focus` only ever LIFT the curtain,
     * and a mutation run showed that branch could not be reached: a hidden
     * document does not receive window focus. One handler is the smaller and
     * truer shape.
     */
    window.addEventListener('focus', onVisibility);
    window.addEventListener('pageshow', onVisibility);

    const id = setInterval(() => {
      const now = Date.now();
      // NOBODY CAN SEE A HIDDEN PAGE, so nobody can see its warning: it is never signed out while hidden (ruling
      // 4/11). The reckoning happens on return, with the minute's countdown on screen.
      if (document.hidden) {
        if (!hiddenSince.current) hiddenSince.current = now;
        return;
      }
      // Back without any of the three events (see above): the same return, found by the clock.
      if (hiddenSince.current) cameBack(now);
      if (graceUntil.current) {
        if (now < graceUntil.current) {
          setLeft(Math.ceil((graceUntil.current - now) / 1000));
          setPhase('warning');
          return;
        }
        // The minute was on screen and nobody answered it.
        setLeft(0);
        setPhase('expired');
        if (!leaving.current) {
          leaving.current = true;
          void signOut('idle');
        }
        return;
      }
      const state = idleState(lastActive.current, now);
      setLeft(secondsLeft(lastActive.current, now));
      setPhase(state);
      if (state === 'expired' && !leaving.current) {
        leaving.current = true;
        void signOut('idle');
      }
    }, TICK_MS);

    return () => {
      for (const event of WATCHED) window.removeEventListener(event, touch);
      window.removeEventListener('storage', fromOtherTab);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
      window.removeEventListener('pageshow', onVisibility);
      clearInterval(id);
    };
  }, [touch]);

  return (
    <>
      {covered && (
        <div
          data-testid="backgrounded"
          /**
           * `pointer-events-none`: A CURTAIN, NOT A LOCK.
           *
           * Without it this box swallowed the wheel, so for as long as it was
           * up — including any moment it outlived its reason — the page could
           * not be scrolled, and a click was what made it go away. It hides
           * the content from a task-switcher thumbnail; it was never meant to
           * stop the person holding the phone.
           */
          className="pointer-events-none fixed inset-0 z-[65] flex items-center justify-center bg-[var(--sys-surface)]/90 backdrop-blur-2xl"
        >
          <RiEyeOffLine className="h-6 w-6 text-[var(--sys-muted)]" />
        </div>
      )}

      {phase !== 'active' && (
        <div
          role="alertdialog"
          aria-live="assertive"
          data-testid="idle-warning"
          className="fixed inset-x-0 bottom-0 z-[70] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          <div className="mx-auto flex max-w-md items-center gap-3 rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-card)] p-3 shadow-overlay">
            <RiLockLine className="h-5 w-5 shrink-0 text-[var(--sys-warning)]" />
            <p className="flex-1 text-sm text-[var(--sys-foreground)]">
              {phase === 'expired' ? (
                'انتهت الجلسة — جارٍ تسجيل الخروج…'
              ) : (
                <>
                  ستُغلق الجلسة بعد <span className="tabular-nums font-semibold">{left}</span> ثانية لعدم الاستخدام.
                </>
              )}
            </p>
            {phase === 'warning' && (
              <button
                type="button"
                onClick={touch}
                className="h-11 md:h-10 shrink-0 rounded-lg bg-[var(--sys-primary)] px-4 text-sm font-medium text-[var(--sys-primary-foreground)]"
              >
                أنا هنا
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
