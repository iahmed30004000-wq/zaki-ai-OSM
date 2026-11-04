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
