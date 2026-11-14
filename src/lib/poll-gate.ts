/**
 * A POLL THAT DOES NOT ASK ON TOP OF ITS OWN QUESTION (13/11, the site's slow-down).
 *
 * When the server is slow, every screen that polls makes it slower: a timer's tick, a return to the tab and a «retry» each
 * start a request whether or not the one before has answered, and the server finishes them all. This remembers what the last
 * call told us — is it still out, and was it slow — so the next AUTOMATIC call can wait for it. A call the person asked for with
 * a press never asks this: she asked.
 *
 * Plain numbers and one promise, no timers and no imports, so the screens and the two header polls can all carry it.
 */

/** A load slower than this makes the screen wait before it asks again by itself. */
const SLOW_MS = 2_000;
/** However slow the server was, a screen asks again after this long. */
const MAX_QUIET_MS = 60_000;
/** A load that never answers stops counting as «on its way» after this long. */
const GIVE_UP_MS = 90_000;

export function pollGate() {
  let since = 0;
  let took = 0;
  let done = 0;
  let latest = 0;

  return {
    /** Is an earlier call still out? */
    busy: (now: number): boolean => since !== 0 && now - since < GIVE_UP_MS,

    /** Was the last call slow, and is it too soon to ask again by ourselves? Four times as long as it took, a minute at most. */
    tooSoonAfterSlow: (now: number): boolean => took > SLOW_MS && now - done < Math.min(MAX_QUIET_MS, 4 * took),

    /**
     * Follow one call. A call that returns nothing (`() => { void load(); }`) is not followed, and the gate then says nothing:
     * the screen behaves exactly as it did. A promise is followed to its end, either end, and only the NEWEST call counts — an
     * older one that settles after a newer one began must not say «nothing is out».
     */
    follow(call: unknown, now: number): void {
      if (typeof (call as { then?: unknown } | null | undefined)?.then !== 'function') return;
      const mine = ++latest;
      since = now;
      const settle = () => {
        if (mine !== latest) return;
        done = Date.now();
        took = done - now;
        since = 0;
      };
      (call as Promise<unknown>).then(settle, (error) => {
        settle();
        // This only listens: a loader that rejects is exactly as unhandled as it was before.
        throw error;
      });
    },
  };
}
