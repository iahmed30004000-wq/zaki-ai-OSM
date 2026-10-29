/**
 * Simple in-memory sliding-window rate limiter.
 * For single-instance deployments (Next.js standalone). Swap with Redis for clusters.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Periodic cleanup to avoid memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 60_000).unref?.();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  return { allowed: true, remaining: limit - bucket.count, retryAfterSec: 0 };
}

/**
 * GIVE BACK THE SLOT A REQUEST TOOK, because the request did not do its work.
 *
 * A guard that counts the ATTEMPT punishes the visitor for our failure: the
 * order door takes its one-per-phone slot before it writes, so when the write
 * threw (a 500) the customer's second press was told «تم استلام طلبك» for an
 * order that does not exist. Releasing the slot when nothing was saved makes
 * the second press a real second try. After a saved order it is NEVER called —
 * that is the case the slot is for.
 *
 * Takes ONE count off the bucket (and drops the bucket when that was the only
 * one), so a bucket that other requests also counted in keeps their counts.
 */
export function releaseRateLimit(key: string): void {
  const bucket = buckets.get(key);
  if (!bucket) return;
  if (bucket.count > 1) bucket.count -= 1;
  else buckets.delete(key);
}

/**
 * THE ANSWER FOR «I DO NOT KNOW WHO THIS IS».
 *
 * Also the value every caller shares when no trusted proxy is configured.
 * `lp-view` and the limiters below test for it by name, so it is one
 * constant and not a string repeated.
 */
export const UNKNOWN_IP = 'local';

/**
 * How many times looser a PER-ADDRESS bucket is when the address is
 * unknown. See `rateLimitByIp`.
 */
export const UNKNOWN_IP_FACTOR = 5;

/**
 * A bucket per address, for the doors a STAFF MEMBER walks through to sign in.
 *
 * Without `TRUST_PROXY=true` every caller is `UNKNOWN_IP`, so a bucket of
 * twenty per five minutes is not «twenty per visitor» but «twenty for the
 * whole company»: a stranger who sends twenty requests shuts every
 * employee out of the sign-in for five minutes, and nothing about it is
 * hard. The limit exists to stop ONE address grinding; when we cannot tell
 * addresses apart it cannot do that job, and doing a different job (a
 * switch any stranger can pull) is worse than doing none.
 *
 * So an unknown address gets a ceiling `UNKNOWN_IP_FACTOR` times higher —
 * still a flood limit, no longer a switch. The per-ACCOUNT buckets beside
 * it (`login:user:…`, `2fa:verify:user:…`, `passkey:user:…`) are untouched
 * and are what actually limits guessing.
 *
 * Only the sign-in doors use it. The public order doors keep the strict
 * shared bucket on purpose: raising it would let a stranger place orders
 * faster, and that is a different trade (see the PR).
 */
export function rateLimitByIp(
  scope: string,
  ip: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const effective = ip === UNKNOWN_IP ? limit * UNKNOWN_IP_FACTOR : limit;
  return rateLimit(`${scope}:${ip}`, effective, windowMs);
}

/** `1.2.3.4` — four numbers up to 255, nothing else. */
function cleanIpv4(raw: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts.join('.') : null;
}

/**
 * An IPv6 address is keyed by its /64.
 *
 * Whoever holds an IPv6 connection holds at least a /64, which is 2^64
 * addresses: a bucket per full address is a bucket the holder can change
 * on every request. The first four groups are the part that is theirs.
 */
function cleanIpv6(raw: string): string | null {
  const addr = raw.toLowerCase().split('%')[0];
  if (!/^[0-9a-f:.]+$/.test(addr) || !addr.includes(':')) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return cleanIpv4(mapped[1]);
  if (addr.includes('.')) return null;
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** One entry of a forwarded chain, with the port some proxies append taken off. */
function cleanIp(raw: string): string | null {
  let s = raw.trim();
  const bracketed = /^\[([0-9a-fA-F:.%]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  return cleanIpv4(s) ?? cleanIpv6(s);
}

/**
 * HOW MANY PROXIES OF OURS SIT IN FRONT OF THE APP. One (Coolify's) unless
 * `TRUST_PROXY_HOPS` says otherwise — two when something like Cloudflare
 * stands in front of that. Anything that is not a whole number from 1 to 8
 * is read as 1.
 */
function trustedHops(): number {
  const n = Number(process.env.TRUST_PROXY_HOPS);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 1;
}

/**
 * THE ADDRESS OF WHOEVER IS CALLING, OR `UNKNOWN_IP` WHEN WE CANNOT SAY.
 *
 * Forwarded headers are believed ONLY where the deployment says a trusted
 * reverse proxy sits in front (`TRUST_PROXY=true`). Without it they are
 * client-spoofable and are ignored: Next.js route handlers do not expose
 * the socket address, so every client then shares `UNKNOWN_IP` — a
 * deliberate SAFE default for a node on the internet, since a limit cannot
 * be bypassed by a header that is never read.
 *
 * WHICH ENTRY, once the header is believed — the one our own proxy wrote,
 * counted from the RIGHT. `X-Forwarded-For` is a list each proxy APPENDS
 * to, so the left end is whatever the client chose to send and the right
 * end is what the nearest proxy saw. This used to read the FIRST entry,
 * which meant that turning `TRUST_PROXY` on handed every caller a free
 * bypass: `X-Forwarded-For: 9.9.9.9` and a new bucket for each request.
 *
 * Fail to the shared bucket, never to a guess: a chain shorter than the
 * proxies we expect, or an entry that is not an address, is `UNKNOWN_IP`.
 * `X-Real-IP` is deliberately not read: a proxy that sets it also sets the
 * list, and when the list is missing the request did not come through the
 * proxy at all.
 */
export function getClientIp(req: Request): string {
  if (process.env.TRUST_PROXY !== 'true') return UNKNOWN_IP;
  const fwd = req.headers.get('x-forwarded-for');
  if (!fwd) return UNKNOWN_IP;
  const chain = fwd.split(',');
  const hops = trustedHops();
  if (chain.length < hops) return UNKNOWN_IP;
  return cleanIp(chain[chain.length - hops]) ?? UNKNOWN_IP;
}
