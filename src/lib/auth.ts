import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { SessionUser, UserRole, UserStatus, Permission, ROLE_PERMISSIONS } from '@/types/auth';
import { TRUST_DAYS, type DeviceTrustClaims } from './trusted-device';

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
  remember?: boolean;
}): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(payload.remember ? '30d' : '7d')
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
    .setExpirationTime(`${TRUST_DAYS}d`)
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
} | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    // A trusted-device token is not a session, whatever else is true of it.
    if (payload.typ === 'device') return null;
    return payload as unknown as {
      userId: string;
      email: string;
      role: UserRole;
      status: UserStatus;
      companyId: string | null;
      tv: number;
    };
  } catch {
    return null;
  }
}

/**
 * Loads the session user. Returns the user regardless of status
 * so the UI can render the correct screen (pending / suspended / active).
 * Token version is verified server-side to support forced logout.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    if (!token) return null;

    const decoded = await verifySessionToken(token);
    if (!decoded) return null;

    const user = await db.user.findUnique({
      where: { id: decoded.userId },
      include: {
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
        roleRef: { select: { systemTheme: true } },
      },
    });

    if (!user) return null;

    // Forced logout: token issued before the last tokenVersion bump is invalid
    if (user.tokenVersion !== decoded.tv) return null;

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
  } catch (error: any) {
    if (error?.digest === 'DYNAMIC_SERVER_USAGE') {
      return null;
    }
    console.error('Error getting current user:', error);
    return null;
  }
}

/**
 * Server-side guard for API routes. Only ACTIVE users may use business APIs.
 * PENDING / SUSPENDED / DISABLED accounts are rejected here — never trust the client.
 */
export async function requireAuth(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Unauthorized');
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

/** Builds the HTTP-only session cookie settings */
export function sessionCookieOptions(remember: boolean) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * (remember ? 30 : 7),
  };
}

export { COOKIE_NAME };
