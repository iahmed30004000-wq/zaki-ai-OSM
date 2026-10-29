/**
 * WHO READ HOW MANY CUSTOMERS, AND WHEN IT STOPS LOOKING LIKE WORK.
 *
 * The customer table is the one asset here that is worth money to somebody
 * else: names, phones and addresses of everyone who ever bought. It is
 * already guarded on the way out — a permission, a store scope, a hundred
 * rows a page, an export that is capped, dated, rate-limited and logged.
 * What was missing is the quiet path: an agent who may legitimately see
 * customers, paging through all of them a hundred at a time, leaves no
 * trace at all.
 *
 * ── WHY NOT A ROW PER READ ──
 *
 * The obvious answer is to write an audit row every time somebody opens
 * the list. That buries the trail it was meant to create: a search box
 * fires on every keystroke, and a day of ordinary calling would put tens
 * of thousands of «looked at customers» rows over the handful of entries
 * that say who changed what. A log nobody can read is not a log.
 *
 * So the count is kept in memory and only the CROSSING is written: one
 * audit row and one alert the moment a person passes the threshold in a
 * window, and nothing more until that window rolls over. Ordinary work
 * writes nothing. Harvesting writes exactly one legible line.
 *
 * ── WHAT THIS IS NOT ──
 *
 * It is not a rate limit: nobody is blocked. Someone may have a real
 * reason to read six hundred customers, and stopping them mid-task to
 * protect a table they are allowed to read would be the system getting in
 * the way of its own business. It raises a hand; a person decides.
 *
 * The counter lives in this process, like `rate-limit.ts` next to it, and
 * has the same limit: across several instances each keeps its own tally,
 * so the threshold is effectively per instance. That makes it a smoke
 * alarm, not a vault door — which is what the brief asks for.
 */

export interface AccessWindow {
  /**
   * PII records handed to this person since the window opened: the people
   * that could be told apart (`seen`) plus the rows that could not.
   */
  records: number;
  /**
   * WHO, when the rows say who. Reading the same hundred customers again is
   * not reading a hundred more people, and a screen that reloads after
   * every action (postpone a parcel, press back, type in the search box)
   * did exactly that to a plain counter: the third reload of one list
   * crossed the alarm without anybody new being seen.
   */
  seen?: Set<string>;
  /** When the tally resets. */
  resetAt: number;
  /** The crossing has already been announced for this window. */
  announced: boolean;
}

/**
 * FIVE FULL PAGES OF THE LARGEST LIST THE API WILL RETURN.
 *
 * The list endpoint caps at a hundred rows, so this is five unfiltered
 * loads inside a quarter of an hour. A day of calling does not reach it:
 * an agent works a queue of orders and opens the customers they are
 * calling. Reading five hundred people's contact details in fifteen
 * minutes is not calling anybody.
 */
export const BULK_VIEW_RECORDS = 500;
export const BULK_VIEW_WINDOW_MS = 15 * 60 * 1000;

const windows = new Map<string, AccessWindow>();

/**
 * The most identities one window remembers. Past it the person has long
 * since crossed the threshold; the cap only stops a runaway reader from
 * growing the set without bound.
 */
const MAX_REMEMBERED = 10_000;

// Same housekeeping as the rate limiter beside it: expired windows are
// dropped so a long-running process does not grow a key per person per day.
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows) if (w.resetAt < now) windows.delete(key);
}, 60_000).unref?.();

export interface AccessResult {
  /** Records read by this person in the current window, including these. */
  records: number;
  /**
   * True on the ONE call that takes them over the threshold. Never true
   * again until the window rolls over — an alert that repeats every
   * request is an alert people turn off.
   */
  crossed: boolean;
}

/**
 * Count PII records handed to somebody, and say whether this is the
 * moment it stopped looking like ordinary work.
 *
 * `records` is how many rows could NOT be told apart (they count every
 * time). `opts.ids` names the ones that could — a customer id or phone —
 * and each of those counts once per window however often it is read again.
 *
 * `now` and `store` are injectable so the behaviour can be tested without
 * a clock and without leaking state between tests.
 */
export function noteCustomerAccess(
  key: string,
  records: number,
  opts: {
    threshold?: number;
    windowMs?: number;
    now?: number;
    store?: Map<string, AccessWindow>;
    ids?: ReadonlyArray<string>;
  } = {}
): AccessResult {
  const threshold = opts.threshold ?? BULK_VIEW_RECORDS;
  const windowMs = opts.windowMs ?? BULK_VIEW_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const store = opts.store ?? windows;

  // A read that returned nothing is not a read of anybody, and a negative
  // count is a caller bug that must not be able to lower the tally.
  const add = Math.max(0, Math.floor(records));

  const current = store.get(key);
  const window: AccessWindow =
    !current || current.resetAt <= now
      ? { records: 0, resetAt: now + windowMs, announced: false }
      : current;

  if (opts.ids && opts.ids.length > 0) {
    const seen = (window.seen ??= new Set<string>());
    // What is new to this window — and nothing else — is what is added.
    // `records` is the anonymous tally plus the people, so the two parts
    // are kept apart: the people from the set, the rest from the counter.
    const anonymous = window.records - seen.size;
    for (const id of opts.ids) if (seen.size < MAX_REMEMBERED) seen.add(id);
    window.records = anonymous + seen.size;
  }
  window.records += add;
  const crossed = !window.announced && window.records >= threshold;
  if (crossed) window.announced = true;
  store.set(key, window);

  return { records: window.records, crossed };
}

/** Only for tests and for a process that wants a clean slate. */
export function forgetCustomerAccess(): void {
  windows.clear();
}
