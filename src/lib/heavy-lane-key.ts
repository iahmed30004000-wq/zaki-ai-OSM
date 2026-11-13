/**
 * WHERE THE REPORTS LANE'S MARKER LIVES ON `globalThis` — a module of its own, with NO import.
 *
 * `heavy-lane.ts` creates the `AsyncLocalStorage` (so it imports `node:async_hooks`) and keeps it on `globalThis` under this key
 * (RV187: a production build evaluates a module once per bundle). `db.ts` has to ask «is this code running in a report?» on every
 * property it hands out — but `db.ts` is reached from the BROWSER bundle of a client screen (`ConfirmationMineScreen` →
 * `confirmation-queue.ts` → `db.ts`), and a browser chunk cannot take `node:async_hooks`: the production build of the first version
 * of the lane failed on it. So `db.ts` reads the marker from `globalThis` by this key and imports nothing from the lane.
 */
export const LANE_KEY = '__osmReportsLane' as const;
