/**
 * HOW LONG A BACKGROUND POLL MAY HOLD A CONNECTION.
 *
 * The header's work chips, the bell and the «who am I» re-read ask the
 * server on their own, every minute or on every return to the tab. They
 * were plain `fetch` calls with no limit at all, so on a server that
 * accepted the connection and then did not answer — right after a deploy,
 * while the build starves it — each one stayed open indefinitely. A browser
 * opens only a handful of connections to one site at a time; three stuck
 * polls are three of them, and the press on the menu queues behind them.
 * The screen does not move, and it looks like the system froze.
 *
 * They stay plain `fetch`, deliberately: `apiFetch` sends the tab to the
 * sign-in or the store picker on a 401/400, which is right for a press and
 * wrong for a request nobody made, that would throw away whatever is being
 * typed. What they gain is only the limit — the same fifteen seconds
 * `apiFetch` gives every other request.
 */
export const POLL_TIMEOUT_MS = 15_000;

/** A fresh signal per request; `undefined` where the browser has no `AbortSignal.timeout` (the poll then waits as it did). */
export function pollSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(POLL_TIMEOUT_MS)
    : undefined;
}
