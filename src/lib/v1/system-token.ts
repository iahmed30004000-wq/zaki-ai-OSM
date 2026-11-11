import crypto from 'crypto';
import { db } from '../db';
import { rateLimit } from '../rate-limit';
import { V1_CODE, V1Fault } from './door';

/**
 * WHO IS CALLING `/api/v1`, AND WHAT THEY MAY DO — the service-layer guard.
 *
 * This is the whole of the door's authorization and it lives HERE, not in a
 * route handler, for the reason the contract gives: «Every API route's
 * permission check goes in the service/authorization layer». Five routes
 * ask the same four questions — is this a key we issued, is it still alive,
 * was it granted THIS scope, and has it called too often — and four of them
 * asked four ways would be four places to get one of them wrong.
 *
 * ── THE COMPANY COMES FROM THE TOKEN. NEVER FROM THE REQUEST. ──
 *
 * There is no `companyId` in any body or query string at this door, and
 * there never may be. A caller cannot name a company, only prove which one
 * it holds a key to — which is what makes cross-company isolation a
 * property of the shape rather than of each handler remembering.
 *
 * ── AND THE TOKEN ITSELF IS NEVER STORED, LOGGED OR RETURNED ──
 *
 * `SystemToken.tokenHash` is the SHA-256. The plaintext exists for the one
 * response that creates it and nowhere else: not in a column, not in an
 * audit row, not in a console line. A stolen database dump is a list of
 * fingerprints.
 */

/** The scopes a token may be granted. Nothing outside this list is a scope. */
export const V1_SCOPES = [
  'products.read',
  'customers.lookup',
  'orders.create',
  'orders.read',
  'orders.note',
  // The media buyer's two (2026-10-26). Separate scopes, not a widening of
  // `orders.read` and `products.read`: the replies system holds those, and
  // it must not start reading every order's ad trail or the cost of goods
  // because a third system needed them.
  'orders.attribution.read',
  'products.costs.read',
] as const;

export type V1Scope = (typeof V1_SCOPES)[number];

export function isV1Scope(v: string): v is V1Scope {
  return (V1_SCOPES as readonly string[]).includes(v);
}

/** What the replies system (System 7) is given, and nothing else. */
export const REPLIES_SCOPES: V1Scope[] = [
  'products.read',
  'customers.lookup',
  'orders.create',
  'orders.read',
  'orders.note',
];

/**
 * What the media buyer is given, and nothing else — READ ONLY.
 *
 * It decides where ad money goes, so it needs which ad each order came from
 * and what happened to it (`orders.attribution.read`), and what a unit costs and
 * how long the shelf lasts (`products.read` + `products.costs.read`). It never
 * writes here: no order, no note, no lookup of a customer's number — the
 * owner's rule is that ads are edited THERE and orders live HERE.
 */
export const MEDIABUYER_SCOPES: V1Scope[] = ['products.read', 'products.costs.read', 'orders.attribution.read'];

/** The standalone landing system: reads the catalogue and places orders, and nothing about a customer or a cost. */
export const LANDING_SCOPES: V1Scope[] = ['products.read', 'orders.create'];

/**
 * The outside systems a key may be made for, each with its default scopes.
 *
 * The screen offers these by name, so a person making the media buyer's key
 * starts from its three scopes instead of unticking the replies system's
 * five — least privilege as the default, not as homework.
 */
export const V1_SYSTEMS = [
  { key: 'replies', ar: 'نظام الردود', scopes: REPLIES_SCOPES, rateLimitPerMin: 60 },
  // An hourly sync needs a handful of calls; thirty a minute is room for a
  // retry and none for a runaway loop.
  { key: 'mediabuyer', ar: 'الميديا باير', scopes: MEDIABUYER_SCOPES, rateLimitPerMin: 30 },
  // Every visitor choosing a city is a quote, so its traffic is the shop's own, not one system's.
  { key: 'landing', ar: 'نظام صفحات الهبوط', scopes: LANDING_SCOPES, rateLimitPerMin: 600 },
] as const;

/** The per-minute allowance a new key starts with, by system — 60 for anything not listed. */
export function defaultRateFor(system: string): number {
  return V1_SYSTEMS.find((s) => s.key === system)?.rateLimitPerMin ?? 60;
}

/** The Arabic name of each scope, for the screen that grants them. */
export const V1_SCOPE_AR: Record<V1Scope, string> = {
  'products.read': 'قراءة المنتجات والعروض',
  'customers.lookup': 'سؤال عن رقم زبون',
  'orders.create': 'إنشاء طلب',
  'orders.read': 'قراءة حالة طلب',
  'orders.note': 'إضافة ملاحظة على طلب',
  'orders.attribution.read': 'قراءة مصدر الطلبات وحالتها (بلا بيانات زبون)',
  'products.costs.read': 'قراءة تكلفة المنتج ومدة المخزون',
};

/** The default life of a token: «90 يوم» in the contract's own table. */
export const TOKEN_DAYS = 90;

/** How many characters of a token a screen may see, to tell two apart. */
const PREFIX_LEN = 10;

/**
 * A NEW TOKEN — 32 bytes of CSPRNG, written once and never recoverable.
 *
 * `zk1_` in front is a version marker and a courtesy: a key that says what
 * it is can be recognised in a paste, and a future format can be told from
 * this one without guessing at its length.
 *
 * base64url and not hex: the same 256 bits in 43 characters instead of 64,
 * and no character that needs escaping in a header or a `.env` file.
 */
export function mintToken(): { token: string; tokenHash: string; prefix: string } {
  const token = 'zk1_' + crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token), prefix: token.slice(0, PREFIX_LEN) };
}

/** The SHA-256 of a token, hex — the only form that is ever stored. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The bearer token in a request, or null.
 *
 * Case-insensitive on the scheme, because `bearer` and `Bearer` are both
 * correct per RFC 6750 and a client that sends the lower-case form is not
 * wrong. Nothing else is accepted: no `?token=` in the query string, ever —
 * query strings are logged by every proxy on the way, which is how a key
 * ends up in somebody's access log.
 */
export function bearerOf(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** What the routes are handed once the key is accepted. */
export interface SystemCaller {
  tokenId: string;
  companyId: string;
  /** Which outside system this key belongs to — `replies` for System 7. */
  system: string;
  scopes: V1Scope[];
}

/** Stored scopes come back as a JSON string; a broken one grants nothing. */
export function parseScopes(raw: string): V1Scope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is V1Scope => typeof s === 'string' && isV1Scope(s));
  } catch {
    /*
     * FAIL CLOSED. A token whose scope column will not parse is a token
     * that may do nothing, not a token that may do everything — the same
     * direction `emitAppEvent` takes a broken `events` list, and the only
     * direction that is safe when the thing being read IS the permission.
     */
    return [];
  }
}

/**
 * How often `lastUsedAt` may be written: once a minute, per token.
 *
 * «آخر استخدام» on the screen is worth a column. It is not worth an UPDATE
 * on every call of a door rated at sixty a minute — that is sixty writes a
 * minute to say what one write a minute says just as well.
 */
const TOUCH_WINDOW_MS = 60_000;

/**
 * THE GUARD. Returns the caller, or throws the refusal the contract names.
 *
 * Order matters and is not arbitrary:
 *
 *   1. no header            → 401 TOKEN_MISSING
 *   2. unknown / revoked / expired → 401 TOKEN_INVALID, all three the same
 *   3. scope not granted    → 403 SCOPE_MISSING
 *   4. over the allowance   → 429 RATE_LIMITED
 *
 * REVOKED AND EXPIRED ANSWER EXACTLY AS AN UNKNOWN KEY DOES. Telling a
 * caller «this token existed and was stopped» tells somebody holding a
 * stolen key that they have the right string and the wrong moment, which is
 * the one fact a 401 should not hand out. The screen says which; the door
 * does not.
 *
 * THE RATE LIMIT IS CHECKED LAST, after the key is known, because the
 * allowance is the TOKEN'S (`rateLimitPerMin`) and an unauthenticated
 * caller must not be able to spend another token's budget by guessing.
 */
export async function requireSystemToken(req: Request, scope: V1Scope): Promise<SystemCaller> {
  const presented = bearerOf(req);
  if (!presented) {
    throw new V1Fault(401, V1_CODE.TOKEN_MISSING, 'Authorization: Bearer <token> is required');
  }

  const row = await db.systemToken.findUnique({
    where: { tokenHash: hashToken(presented) },
    select: {
      id: true,
      companyId: true,
      system: true,
      scopes: true,
      rateLimitPerMin: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });

  const now = new Date();
  const dead =
    !row ||
    row.revokedAt !== null ||
    (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime());
  if (dead) {
    throw new V1Fault(401, V1_CODE.TOKEN_INVALID, 'The token is not valid');
  }

  const scopes = parseScopes(row.scopes);
  if (!scopes.includes(scope)) {
    // The scope that was MISSING is named: the caller is a program, and
    // «which permission» is the one thing it can act on. It is the name of
    // a capability, not a secret.
    throw new V1Fault(403, V1_CODE.SCOPE_MISSING, `The token lacks the scope ${scope}`, {
      required: scope,
    });
  }

  const limit = Math.max(1, row.rateLimitPerMin);
  const bucket = rateLimit(`v1:${row.id}`, limit, 60_000);
  if (!bucket.allowed) {
    throw new V1Fault(
      429,
      V1_CODE.RATE_LIMITED,
      `More than ${limit} requests in a minute`,
      { limit_per_minute: limit },
      { 'Retry-After': String(bucket.retryAfterSec) }
    );
  }

  // After every check, and never able to refuse the call: a key that works
  // must not stop working because the column recording its use did.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > TOUCH_WINDOW_MS) {
    await db.systemToken
      .update({ where: { id: row.id }, data: { lastUsedAt: now } })
      .catch(() => undefined);
  }

  return { tokenId: row.id, companyId: row.companyId, system: row.system, scopes };
}
