import { SignJWT, jwtVerify } from 'jose';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «عاين كـ» — THE OWNER SEES THE SYSTEM AS ONE OF HIS PEOPLE, AND TOUCHES NOTHING.
 *
 * The owner, 4/11: «بدي زر معاينة … بس بدي تظهرلي شو عندها». He picks a real
 * person of his company and every screen, menu, tab, button and list is
 * computed AS HER — her keys, her scopes, her held orders, her desk — while
 * nothing can be written. Not a role with nobody's data: her, with hers.
 *
 * HOW IT IS HELD. One cookie, `zaki_preview`, httpOnly, a JWT signed with the
 * session key: `{ typ: 'preview', own: <owner id>, sub: <her id>, sid }`, two
 * hours. `sid` is a fingerprint of the owner's session cookie, so a new sign-in
 * or a sign-out kills it, and it is worthless in any other browser — it names
 * the owner, and it answers only beside HIS session.
 *
 * WHERE IT IS ANSWERED — TWO PLACES, AND ONLY TWO.
 *
 *   1. THE PROXY (src/proxy.ts), before any handler runs: while a preview that
 *      binds to this session is on, every request that is not GET/HEAD/OPTIONS
 *      is refused 403 «وضع المعاينة — قراءة بس», except the three doors in
 *      `PREVIEW_OPEN_DOORS` (leave the preview, sign out, pick a store — the
 *      last writes only a cookie). A GET that writes by design (the ad
 *      account's OAuth hand-off) is refused too. For a read it stamps the
 *      request with `PREVIEW_STAMP_HEADER` = HMAC(key, cookie).
 *   2. `getCurrentUser` (src/lib/auth.ts) answers HER only when the real
 *      session is an ACTIVE SUPER_ADMIN, the cookie verifies and binds, AND the
 *      proxy's stamp is on the request. No stamp — a request the proxy never
 *      saw — and it answers the owner, never her. So a write that somehow got
 *      past the gate runs, at worst, as the owner himself, with his own keys.
 *
 * IT CAN ONLY NARROW. The person previewed is never a SUPER_ADMIN, always of the
 * owner's company and ACTIVE, and the only account that can start one already
 * holds every key. A cookie in anybody else's browser is ignored: it names
 * another `own`, and no other session carries its `sid`.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const PREVIEW_COOKIE = 'zaki_preview';
export const PREVIEW_STAMP_HEADER = 'x-zaki-preview-read';
/** Two hours, then the owner is himself again. */
export const PREVIEW_TTL_SECONDS = 2 * 60 * 60;
export const PREVIEW_REFUSAL = 'وضع المعاينة — قراءة بس. ارجع لحسابك لتعدّل.';
export const PREVIEW_REFUSAL_CODE = 'PREVIEW_READ_ONLY';

/** The doors a preview may still knock on with a write: leave it, sign out, pick a store (a cookie only). */
export const PREVIEW_OPEN_DOORS: ReadonlyArray<string> = ['/api/preview', '/api/auth/logout', '/api/context'];

/**
 * GETs that write by design, refused in a preview like a POST. The OAuth hand-off records an audit row and then
 * stores a connected ad account — in the previewed person's name, if it ran.
 */
export const PREVIEW_CLOSED_READS: ReadonlyArray<string> = ['/api/settings/ad-accounts/oauth/'];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method.toUpperCase());
}

/** What the proxy does with one request while a preview binds to its session. */
export function previewVerdict(method: string, pathname: string): 'refuse' | 'stamp' | 'pass' {
  if (isReadMethod(method)) {
    return PREVIEW_CLOSED_READS.some((p) => pathname.startsWith(p)) ? 'refuse' : 'stamp';
  }
  return PREVIEW_OPEN_DOORS.some((p) => pathname === p) ? 'pass' : 'refuse';
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fingerprint of the owner's session cookie — the preview answers beside this session and no other. */
export async function sessionFingerprint(sessionToken: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(sessionToken))).slice(0, 32);
}

export async function signPreviewToken(
  input: { ownerId: string; targetId: string; sessionToken: string },
  secret: Uint8Array
): Promise<string> {
  return new SignJWT({ typ: 'preview', own: input.ownerId, sid: await sessionFingerprint(input.sessionToken) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.targetId)
    .setIssuedAt()
    .setExpirationTime(`${PREVIEW_TTL_SECONDS}s`)
    .sign(secret);
}

export interface PreviewClaims {
  ownerId: string;
  targetId: string;
  expiresAt: Date;
}

/** The claims, or null: unsigned, expired, not a preview, or not bound to THIS session. */
export async function verifyPreviewToken(
  token: string | undefined,
  sessionToken: string | undefined,
  secret: Uint8Array
): Promise<PreviewClaims | null> {
  if (!token || !sessionToken) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.typ !== 'preview') return null;
    if (typeof payload.own !== 'string' || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.sid !== (await sessionFingerprint(sessionToken))) return null;
    return { ownerId: payload.own, targetId: payload.sub, expiresAt: new Date(payload.exp * 1000) };
  } catch {
    return null;
  }
}

/** The proxy's mark on a preview READ. Nobody without the key can make one, so a client cannot put it on a write. */
export async function previewStamp(previewToken: string, secret: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`preview-read\n${previewToken}`)));
}

/** Same length, every byte compared — the stamp is not checked one leaked character at a time. */
export function sameStamp(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Read one cookie out of a raw Cookie header (the proxy has no cookie jar). */
export function cookieFrom(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const c = part.trim();
    if (c.startsWith(`${name}=`)) return c.slice(name.length + 1);
  }
  return undefined;
}
