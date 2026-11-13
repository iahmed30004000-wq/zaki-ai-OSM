/**
 * THE POOL IS AT LEAST TWENTY CONNECTIONS (the owner's ruling 4/11).
 *
 * Production ran with `connection_limit=10`. «طلباتي», the queue and every
 * navigation's session check share that pool, and since #206 a request reads
 * the user row and the session row side by side. Ten agents coming back from
 * calls at once queued behind each other, and a query that waited past
 * `pool_timeout` failed with P2024 — the «stuck» screen the girls saw.
 *
 * The number lives inside `DATABASE_URL`, next to the database password, so
 * it is raised HERE rather than by editing that secret: whatever the URL
 * says, the client opens at least `MIN_POOL` connections. A URL that already
 * asks for more keeps its own number. Postgres allows 100 by default; the
 * web process and the worker each hold one pool, so two pools of twenty
 * leave plenty for migrations and a psql session.
 */
export const MIN_POOL = 20;

/**
 * THE REPORTS LANE: A SECOND, SMALL POOL FOR THE SLOW READS (the owner, 13/11: «لوحة الأداء بتضل تعلق والسايت بطيء بشكل عام»).
 *
 * One page of the performance board asks for four answers at once, and those four fan out into well over a hundred queries
 * (seven per delivery company, fourteen for the totals, fourteen for the people…), all started in the same instant. With one pool of
 * twenty they took every connection, so the girls' pulls, the follow-up list and every navigation's session check queued behind a
 * report. The reports now run on their OWN client of `HEAVY_POOL` connections (`lib/heavy-lane.ts` decides who is in the lane):
 * however many queries a report starts, at most six run at a time, and the twenty above are never touched by it.
 */
export const HEAVY_POOL = 6;

/** A report's query may wait a long while for one of its six connections; it must not fail while it waits (Prisma's own default is 10 s). */
export const HEAVY_POOL_TIMEOUT_SECONDS = 120;

/** The same URL for the reports client: its `connection_limit` is EXACTLY `HEAVY_POOL` and its `pool_timeout` is long. */
export function withHeavyPool(url: string | undefined): string | undefined {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return url;
  parsed.searchParams.set('connection_limit', String(HEAVY_POOL));
  parsed.searchParams.set('pool_timeout', String(HEAVY_POOL_TIMEOUT_SECONDS));
  return parsed.toString();
}

/** The URL the client should open: the same URL, its `connection_limit` raised to at least `MIN_POOL`. */
export function withPoolFloor(url: string | undefined): string | undefined {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL we can read: hand it to Prisma untouched, it says what is wrong.
    return url;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return url;
  const asked = Number(parsed.searchParams.get('connection_limit'));
  if (Number.isFinite(asked) && asked >= MIN_POOL) return url;
  parsed.searchParams.set('connection_limit', String(MIN_POOL));
  return parsed.toString();
}
