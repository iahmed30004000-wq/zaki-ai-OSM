import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { SessionUser, UserRole, UserStatus, Permission, ROLE_PERMISSIONS, ROLE_LABELS } from '@/types/auth';
import { trustDays, type DeviceTrustClaims } from './trusted-device';
import { sessionDays } from './session-length';
import { AuthBackendDown, SessionEnded, isBackendDown } from './auth-errors';

/**
 * Resolved lazily on first use (request time), never at module load.
 * This keeps `next build` working without a JWT_SECRET, while production
 * runtime still refuses to sign/verify tokens without a real secret.
 */
let cachedJwtSecret: Uint8Array | null = null;
function getJwtSecret(): Uint8Array {
  if (!cachedJwtSecret) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
        throw new Error(
          'SECURITY: JWT_SECRET environment variable is required in production (min 32 chars). refusing to start with the insecure fallback.'
        );
      }
      // Development / build-time only placeholder. Never used in production runtime.
      cachedJwtSecret = new TextEncoder().encode('development_only_insecure_jwt_secret_key_0000');
    } else {
      cachedJwtSecret = new TextEncoder().encode(secret);
    }
  }
  return cachedJwtSecret;
}

const COOKIE_NAME = 'salesflow_session';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSessionToken(payload: {
  userId: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  companyId: string | null;
  tv: number;
  /**
   * The `user_sessions` row this cookie is (the owner's ruling 4/11: two devices per account). Optional only because
   * cookies issued before that ruling carry none and are still read by the old rule until they expire.
   */
  sid?: string;
  remember?: boolean;
}): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    // One number for the token, the cookie, the stale-row line and the trusted device: session-length.ts.
    .setExpirationTime(`${sessionDays(!!payload.remember)}d`)
    .sign(getJwtSecret());
}

/**
 * THE TRUSTED-DEVICE TOKEN, SIGNED HERE BECAUSE THE KEY LIVES HERE.
 *
 * The policy — who may be trusted, for how long, and what ends it — is in
 * `trusted-device.ts` and has no secret and no clock, so it can be tested.
 * This is only the signature, and it is next to `createSessionToken` on
 * purpose: one module holds `JWT_SECRET`, and the day a second one wants it
 * is the day it gets exported and read from somewhere nobody expects.
 *
 * `typ: 'device'` IS NOT DECORATION. Both tokens are signed with the same
 * key, so without it a device token is a structurally valid session token.
 * `getCurrentUser` would reject it today — it has no `tv`, and `undefined`
 * never equals a tokenVersion — but that is luck, not a rule.
 * `verifySessionToken` now refuses it by name, and so does the reverse.
 */
export async function createDeviceToken(claims: {
  typ: 'device';
  sub: string;
  enr: number;
}): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${trustDays()}d`)
    .sign(getJwtSecret());
}

export async function verifyDeviceToken(token: string | undefined): Promise<DeviceTrustClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    // A session token presented as a device token is refused for the same
    // reason, from the other side.
    if (payload.typ !== 'device' || typeof payload.sub !== 'string' || typeof payload.enr !== 'number') {
      return null;
    }
    return { typ: 'device', sub: payload.sub, enr: payload.enr };
  } catch {
    // Expired, re-signed, or signed with a key this server does not hold.
    return null;
  }
}

export async function verifySessionToken(token: string): Promise<{
  userId: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  companyId: string | null;
  tv: number;
  sid?: string;
} | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    // A trusted-device token is not a session, whatever else is true of it — and nor is a preview token
    // (preview-mode.ts), which is signed with the same key.
    if (payload.typ === 'device' || payload.typ === 'preview') return null;
    return payload as unknown as {
      userId: string;
      email: string;
      role: UserRole;
      status: UserStatus;
      companyId: string | null;
      tv: number;
      sid?: string;
    };
  } catch {
    return null;
  }
}

/** The user row with what a session reads beside it. */
const SESSION_USER_INCLUDE = {
  company: {
    select: { id: true, name: true },
  },
  /*
   * THE LOOK THIS PERSON'S ROLE OPENS ON.
   *
   * Read here, with the user, because the layout asks for it on
   * every single page render and a second query per page for one
   * nullable string is a round trip nobody needs. It is consulted
   * ONLY when the person has not chosen a theme of their own — see
   * `openingTheme`.
   */
  // `name` for the preview banner alone («عم تعاين كـ لينا (موظفة تأكيد)»), which names a custom role by its own name.
  roleRef: { select: { systemTheme: true, name: true } },
} as const;

function loadSessionRow(id: string) {
  return db.user.findUnique({ where: { id }, include: SESSION_USER_INCLUDE });
}

type SessionUserRow = NonNullable<Awaited<ReturnType<typeof loadSessionRow>>>;

/** One user row → the SessionUser every door reads, with the engine's grants attached. */
async function sessionUserOf(user: SessionUserRow): Promise<SessionUser> {
  const role = user.role as UserRole;
  // Permission Engine: effective grants from DB (role + overrides), legacy
  // fallback for users without roleId. Permissions are re-read per request,
  // so changes apply immediately (no stale session permissions).
  const { computeEffectiveGrants } = await import('./permissions-core');
  const { attachGrants } = await import('./authorization');
  const effective = await computeEffectiveGrants({ id: user.id, role: user.role, roleId: user.roleId });

  const sessionUser: SessionUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role,
    status: user.status as UserStatus,
    avatar: user.avatar,
    companyId: user.companyId,
    companyName: user.company?.name,
    commissionRate: user.commissionRate,
    systemTheme: user.systemTheme,
    /** Whether the one-time tour already ran for this person. */
    tourDoneAt: user.tourDoneAt ? user.tourDoneAt.toISOString() : null,
    /** The base their role opens on. Their own choice above wins over it. */
    roleTheme: user.roleRef?.systemTheme ?? null,
    permissions: Object.keys(effective.grants),
    legacyPermissions: !user.roleId,
  };
  // Grants live in a WeakMap keyed on this per-request object — never serialized.
  attachGrants(sessionUser, effective);
  return sessionUser;
}

/**
 * THE SESSION USER OF A PERSON WHO PROVED THEMSELVES WITHOUT A COOKIE — the call helper's paired phone
 * (src/lib/call-helper/door.ts), whose bearer token names the person. The same row and the same grants a cookie would
 * give, so every door asked afterwards (`assertOrderAccess`, `can`) answers exactly as it would for her browser.
 * Null when the person no longer exists. Status is NOT checked here: the caller refuses anyone not ACTIVE.
 */
export async function sessionUserFor(userId: string): Promise<SessionUser | null> {
  const row = await loadSessionRow(userId);
  return row ? sessionUserOf(row) : null;
}

/**
 * WHO THIS OWNER MAY PREVIEW (preview-mode.ts) — one rule, read by the start door and again by every request after
 * it: an ACTIVE person of his company (his own, or the platform's first — the rule `tenantOf` uses) who is not an
 * owner and not himself. Anything else is «not found».
 */
export async function previewableTarget(owner: SessionUser, targetId: string): Promise<SessionUserRow | null> {
  if (owner.role !== 'SUPER_ADMIN' || owner.status !== 'ACTIVE') return null;
  const companyId = owner.companyId ?? (await db.company.findFirst({ select: { id: true } }))?.id ?? null;
  if (!companyId) return null;
  const row = await loadSessionRow(targetId);
  if (!row || row.id === owner.id) return null;
  if (row.role === 'SUPER_ADMIN' || row.status !== 'ACTIVE' || row.companyId !== companyId) return null;
  return row;
}

/**
 * THE PREVIEW, IF THIS REQUEST IS ONE: the person being looked at, built exactly as her own session would be, with
 * `preview` naming who is really looking. Null when anything does not hold — and then the caller answers the owner
 * himself, never her. 'ended' when the preview is still on but she may no longer be previewed (suspended, made an
 * owner, moved company): the owner, told so by the banner, because the proxy still refuses his writes until he leaves.
 */
async function previewedUser(owner: SessionUser, sessionToken: string, previewToken: string): Promise<SessionUser | 'ended' | null> {
  // Who may preview at all — an ACTIVE SUPER_ADMIN — is asked once, in `previewableTarget` below.
  const { verifyPreviewToken } = await import('./preview-mode');
  const claims = await verifyPreviewToken(previewToken, sessionToken, getJwtSecret());
  if (!claims || claims.ownerId !== owner.id) return null;
  // The proxy's mark: it saw this request, and it was a read. Without it, the owner.
  if (!(await inPreviewRead())) return null;
  const row = await previewableTarget(owner, claims.targetId);
  if (!row) return 'ended';
  const seen = await sessionUserOf(row);
  seen.preview = {
    ownerId: owner.id,
    ownerName: owner.name,
    roleName: row.roleRef?.name ?? ROLE_LABELS[row.role as UserRole]?.ar ?? row.role,
    expiresAt: claims.expiresAt.toISOString(),
  };
  return seen;
}

/** How often a live session's `lastSeenAt` is written — a request every few seconds must not be a write each. */
export const SEEN_EVERY_MS = 5 * 60 * 1000;

/** Why there is nobody: no/invalid cookie or ended everywhere ('NONE'), or THIS device was the oldest of three. */
export type SessionVerdict = { user: SessionUser } | { user: null; reason: 'NONE' | 'REPLACED' };

const NOBODY: SessionVerdict = { user: null, reason: 'NONE' };

/**
 * WHO IS SIGNED IN ON THIS REQUEST, AND IF NOBODY, WHY.
 *
 * Returns the user regardless of status so the UI can render the correct screen (pending / suspended / active).
 *
 * TWO LOCKS, BOTH MUST HOLD (the owner's ruling 4/11 — two devices per account):
 *   · `tv` — the account's «sign out everywhere» lever. A force-logout, a suspension, a password or 2FA reset bumps
 *     `tokenVersion`, and every cookie of the account dies at once, whatever its session row says.
 *   · `sid` — this device's own row in `user_sessions`. A sign-in on a third device stamps the oldest row REPLACED; a
 *     sign-out stamps only its own. Before the ruling every sign-in bumped `tv`, so opening the system on the phone for
 *     the call helper signed the laptop out.
 *
 * A COOKIE WITH NO `sid` was issued before the ruling. It is accepted by the `tv` rule alone until it expires, so the
 * deploy signs nobody out; there is no row to check because none was ever written for it.
 *
 * A DATABASE THAT DOES NOT ANSWER IS NOT «NOBODY». It throws `AuthBackendDown` (auth-errors.ts), which the API maps to
 * 503 and the page guard lets fall to the error screen — never to /login. Everything else that goes wrong (a forged or
 * expired cookie, a call outside a request) is still «nobody», as before.
 *
 * WHILE THE OWNER PREVIEWS SOMEBODY (preview-mode.ts) this answers HER — on a read the proxy stamped, and on nothing
 * else. `{ preview: 'ignore' }` answers the person who is really signed in whatever the cookie says: signing out and the
 * preview door itself act as the owner.
 */
export async function getSessionVerdict(opts?: { preview?: 'ignore' }): Promise<SessionVerdict> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    if (!token) return NOBODY;

    const decoded = await verifySessionToken(token);
    if (!decoded) return NOBODY;

    // Side by side: the session row costs no extra round trip on the path every request walks.
    const [user, session] = await Promise.all([
      loadSessionRow(decoded.userId),
      decoded.sid
        ? db.userSession.findUnique({
            where: { id: decoded.sid },
            select: { userId: true, revokedAt: true, revokeReason: true, lastSeenAt: true },
          })
        : null,
    ]);

    if (!user) return NOBODY;

    // Forced logout: token issued before the last tokenVersion bump is invalid — every device, sid or not.
    if (user.tokenVersion !== decoded.tv) return NOBODY;

    if (decoded.sid) {
      // A row that is gone, or that is somebody else's, is a cookie this server did not issue to this person.
      if (!session || session.userId !== user.id) return NOBODY;
      if (session.revokedAt) return { user: null, reason: session.revokeReason === 'REPLACED' ? 'REPLACED' : 'NONE' };
      if (Date.now() - new Date(session.lastSeenAt).getTime() >= SEEN_EVERY_MS) {
        // FIRE AND FORGET. «When was this device last used» is worth a write every five minutes, never a wait: the
        // request does not stand on it, and a failed write is the next request's to retry. `Promise.resolve().then`
        // so that not even a synchronous throw can reach the request.
        const sid = decoded.sid;
        void Promise.resolve()
          .then(() => db.userSession.updateMany({ where: { id: sid, revokedAt: null }, data: { lastSeenAt: new Date() } }))
          .catch(() => undefined);
      }
    }

    const sessionUser = await sessionUserOf(user);
    if (opts?.preview === 'ignore') return { user: sessionUser };

    const { PREVIEW_COOKIE } = await import('./preview-mode');
    const previewToken = cookieStore.get(PREVIEW_COOKIE)?.value;
    if (!previewToken) return { user: sessionUser };
    const seen = await previewedUser(sessionUser, token, previewToken);
    if (seen === 'ended') {
      sessionUser.previewEnded = true;
      return { user: sessionUser };
    }
    return { user: seen ?? sessionUser };
  } catch (error: any) {
    if (error?.digest === 'DYNAMIC_SERVER_USAGE') {
      return NOBODY;
    }
    if (isBackendDown(error)) {
      console.error('Session check: the database did not answer:', error?.code ?? error?.name);
      throw error instanceof AuthBackendDown ? error : new AuthBackendDown(error);
    }
    console.error('Error getting current user:', error);
    return NOBODY;
  }
}

/**
 * Loads the session user, or null when nobody is signed in on this cookie (both locks: `getSessionVerdict`).
 * THROWS `AuthBackendDown` when the database cannot answer — the one thing that is not «nobody».
 */
export async function getCurrentUser(opts?: { preview?: 'ignore' }): Promise<SessionUser | null> {
  return (await getSessionVerdict(opts)).user;
}

/**
 * THE ROW THIS COOKIE NAMES, AS THE SIGN-OUT DOOR NEEDS IT: its `sid` and whose it is — or null for no cookie, a cookie
 * this server did not sign, and a cookie from before the ruling 4/11 that carries no `sid`.
 */
export async function currentSessionClaims(): Promise<{ sid: string; userId: string } | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  const decoded = await verifySessionToken(token);
  return decoded?.sid ? { sid: decoded.sid, userId: decoded.userId } : null;
}

/**
 * IS THIS REQUEST A PREVIEW READ? True only when the proxy stamped it (preview-mode.ts). The stamp is an HMAC of the
 * preview cookie under the session key, so nobody without the key can claim it, and the proxy puts it on reads only.
 * The places that write in the reader's name on a GET (the audit trail, the «many customers read» alarm) ask this and
 * stay silent. Outside a request — a job, a script, a test — it is false.
 */
export async function inPreviewRead(): Promise<boolean> {
  try {
    const { headers } = await import('next/headers');
    const { PREVIEW_COOKIE, PREVIEW_STAMP_HEADER, previewStamp, sameStamp } = await import('./preview-mode');
    const stamp = (await headers()).get(PREVIEW_STAMP_HEADER);
    if (!stamp) return false;
    const token = (await cookies()).get(PREVIEW_COOKIE)?.value;
    if (!token) return false;
    return sameStamp(stamp, await previewStamp(token, getJwtSecret()));
  } catch {
    return false;
  }
}

/**
 * WHO IS REALLY LOOKING, ON A STAMPED REQUEST — the owner and the person he previews — or null. The audit trail asks it
 * so a row this request would write in HER name is written under HIS, with a note (audit.ts).
 */
export async function previewOfThisRequest(): Promise<{ ownerId: string; targetId: string } | null> {
  if (!(await inPreviewRead())) return null;
  const jar = await cookies();
  const { PREVIEW_COOKIE, verifyPreviewToken } = await import('./preview-mode');
  const claims = await verifyPreviewToken(jar.get(PREVIEW_COOKIE)?.value, jar.get(COOKIE_NAME)?.value, getJwtSecret());
  return claims ? { ownerId: claims.ownerId, targetId: claims.targetId } : null;
}

/** Signs the preview cookie for the owner's CURRENT session (the preview door, src/app/api/preview). */
export async function issuePreviewToken(ownerId: string, targetId: string): Promise<string | null> {
  const sessionToken = (await cookies()).get(COOKIE_NAME)?.value;
  if (!sessionToken) return null;
  const { signPreviewToken } = await import('./preview-mode');
  return signPreviewToken({ ownerId, targetId, sessionToken }, getJwtSecret());
}

/** The preview this browser holds for this owner's session, as his own door reads it — or null. */
export async function currentPreviewClaims(ownerId: string) {
  const jar = await cookies();
  const { PREVIEW_COOKIE, verifyPreviewToken } = await import('./preview-mode');
  const claims = await verifyPreviewToken(jar.get(PREVIEW_COOKIE)?.value, jar.get(COOKIE_NAME)?.value, getJwtSecret());
  return claims && claims.ownerId === ownerId ? claims : null;
}

/**
 * Server-side guard for API routes. Only ACTIVE users may use business APIs.
 * PENDING / SUSPENDED / DISABLED accounts are rejected here — never trust the client.
 */
export async function requireAuth(): Promise<SessionUser> {
  const verdict = await getSessionVerdict();
  const user = verdict.user;
  if (!user) {
    // Still the word 'Unauthorized' (api-error.ts maps it to 401); the code says when it was a newer device.
    throw new SessionEnded(verdict.reason === 'REPLACED' ? 'SESSION_REPLACED' : undefined);
  }
  if (user.status !== 'ACTIVE') {
    throw new Error(`ACCOUNT_${user.status}`);
  }
  return user;
}

export async function requireCompanyTenant(): Promise<{ user: SessionUser; companyId: string }> {
  return tenantOf(await requireAuth());
}

/**
 * THE COMPANY OF A USER WHO WAS ALREADY RESOLVED — NO SECOND READ OF THE SESSION (RV183).
 *
 * `requireCompanyTenant` is `requireAuth` + this. A door that has just asked `requirePermission` already holds the
 * user (it returns it), and asking `requireCompanyTenant` on top of that re-reads the user, the role and the grants —
 * seven to ten queries — to learn a company id that was in hand. The doors that are polled every few seconds use this
 * instead. The rule is the same one, line for line: a platform admin falls back to the first company, anybody else
 * must belong to one. Nothing here reads who is signed in; that stays `requireAuth`'s and `requirePermission`'s.
 */
export async function tenantOf(user: SessionUser): Promise<{ user: SessionUser; companyId: string }> {
  if (user.role === 'SUPER_ADMIN') {
    const firstCompany = await db.company.findFirst();
    if (!firstCompany) throw new Error('No company configured in platform');
    return { user, companyId: user.companyId || firstCompany.id };
  }
  if (!user.companyId) {
    throw new Error('User has no assigned company tenant');
  }
  return { user, companyId: user.companyId };
}

/**
 * SINGLE-COMPANY CRM: resolve the one active company server-side.
 * Used when an actor without a company context (platform SUPER_ADMIN) creates
 * records that require a companyId — never trust a client-supplied value.
 * Fails explicitly if the single-company invariant cannot be resolved.
 */
export async function resolveSingleCompanyId(): Promise<string> {
  const companies = await db.company.findMany({ select: { id: true }, take: 2 });
  if (companies.length === 0) {
    throw new Error('No company configured in platform');
  }
  if (companies.length > 1) {
    throw new Error('Multiple companies exist but no explicit company context was provided');
  }
  return companies[0].id;
}

/**
 * Permission checks live in './authorization' (single source of truth).
 * Re-exported here so existing imports keep compiling — do not re-implement.
 */
import { requirePermission as _requirePermission } from './authorization';
export const requirePermission: (permission: Permission) => Promise<SessionUser> = _requirePermission;
// `hasPermission` was a second exported name for `can()`, imported by
// nobody. Two names for the permission check is the question «which of
// these is the real one?» asked of the most sensitive function here.
// Call `can()` from './authorization'.

/** Builds the HTTP-only session cookie settings. The days come from session-length.ts — the same number the token carries. */
export function sessionCookieOptions(remember: boolean) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * sessionDays(remember),
  };
}

/** The preview cookie's settings (preview-mode.ts): httpOnly, this site only, gone in two hours whatever happens. */
export function previewCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

export { COOKIE_NAME };
